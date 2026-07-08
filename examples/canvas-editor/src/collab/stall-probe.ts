/**
 * `?script=stall-probe` measurement harness (NOT part of the shipped demo — a transport experiment).
 *
 * Measures the BOOTSTRAP-STALL hypothesis: when a joiner bootstraps a large document over the single
 * shared WebSocket, the sender's ephemeral (cursor) frames queue behind the multi-MB snapshot frame on
 * that same socket, freezing remote-cursor motion for the transfer duration.
 *
 * It reuses the REAL machinery under test — `createWebSocketChannel` (transport-ws.ts), `wireCollab`
 * (boot.ts's bootstrap state machine), `attachDurable`, and the REAL ephemeral store (the same
 * `createEphemeralStore` + `channel.post({kind:"ephemeral"})` write path presence.ts drives). It does NOT
 * boot the canvas app (no rendering, no HUD, no local seed board). The one divergence from the demo is that
 * it seeds the FULL `?count=` board into the document (boot.ts clamps the demo seed to 400) so a real
 * multi-MB snapshot crosses the wire. Because the board IS projected into the runtime (attachDurable is
 * required for the store to mint identity + apply remotes), the joiner pays a whole-board projection at
 * bootstrap — timed separately via `maxSyncMs` so the socket-transfer cost and the projection cost of the
 * observed stall stay distinguishable.
 *
 * ROLES (two separate browser instances against the same relay room):
 *  - sender: first peer. Seeds the large board, answers the joiner's hello with `doc.exportSnapshot()`,
 *    and drives its own cursor in a circle at ~60Hz. The joiner samples THIS cursor.
 *  - joiner: joins ~3s later, bootstraps from the sender's snapshot, drives its own cursor, and samples
 *    the sender's remote cursor every rAF.
 * Both roles drive AND sample, so each side's stall is captured (sender observes the joiner's cursor
 * freeze while the joiner broadcasts its own base back after bootstrap).
 *
 * Emits one `STALL_JSON:<json>` console line at the end (scraped over CDP) and stashes it on
 * `window.__STALL_RESULT`.
 */

import { createWorld, type Entity } from "@vibecook/strata-ecs";
import { attachDurable, createDurableStore } from "@vibecook/strata-ecs/durable";
import {
  attachEphemeral,
  createEphemeralStore,
  LoroEphemeralSnapshot,
} from "@vibecook/strata-ecs/ephemeral";
import { EphemeralStore as LoroEphemeralStore, LoroDoc } from "loro-crdt";
import { seedBoard } from "../app/seed";
import { CursorPos, PresenceInfo } from "../ecs/schema";
import { remotePresence } from "../ecs/queries";
import { presenceIdentity } from "./presence";
import { wireCollab, type CollabWiring } from "./boot";
import { createWebSocketChannel, resolveRelayUrl } from "./transport-ws";

// Match presence.ts's cadence exactly — the stall we measure is the app's real cadence, not a tuned one.
const PRESENCE_THROTTLE_MS = 33; // ~30Hz outbound (design §15.5)
const PRESENCE_TTL_MS = 5000;
const CURSOR_PERIOD_MS = 4000; // one revolution — position monotonically encodes progress
const CURSOR_RADIUS = 500; // world units; large enough that a 33ms step is distinct in f32

interface Sample {
  t: number; // ms since probe start
  x: number;
  y: number;
}

const params = new URLSearchParams(location.search);
const role = params.get("role") === "joiner" ? "joiner" : "sender";
const count = Math.max(1, Number(params.get("count") ?? 100_000) || 100_000);
const wsOrigin = params.get("ws") ?? ""; // "" → ws://localhost:8787
const room = params.get("room") ?? "stall";
const durMs = Number(params.get("dur") ?? (role === "joiner" ? 15_000 : 20_000)) || 15_000;

const statusEl = document.getElementById("status");
const setStatus = (m: string): void => {
  if (statusEl) statusEl.textContent = m;
};
const log: string[] = [];
const t0 = performance.now();
const nowRel = (): number => performance.now() - t0;

// A dedicated world for this probe (NOT the app's canvas world — no rendering, no local seed board).
const probeWorld = createWorld({ name: `stall-probe-${role}` });

// --- the durable doc, with export/import instrumented (wrap the instance methods — wireCollab calls them
//     as `doc.exportSnapshot()` / `doc.applyRemote()`, so instance overrides take effect) --------------
const doc = createDurableStore(new LoroDoc());
let lastExportMs = 0;
let lastExportBytes = 0;
let exportCount = 0;
let senderExportAtMs = 0; // when the sender answered a hello (its snapshot send = the join moment)
let maxImportMs = 0;
let maxImportBytes = 0;

const origExport = doc.exportSnapshot.bind(doc);
doc.exportSnapshot = (): Uint8Array => {
  const s = performance.now();
  const bytes = origExport();
  lastExportMs = performance.now() - s;
  lastExportBytes = bytes.byteLength;
  exportCount++;
  senderExportAtMs = nowRel();
  return bytes;
};
const origApply = doc.applyRemote.bind(doc);
doc.applyRemote = (bytes: Uint8Array): void => {
  const s = performance.now();
  origApply(bytes);
  const ms = performance.now() - s;
  // The snapshot import is by far the largest applyRemote — track the max (that IS the bootstrap import).
  if (ms > maxImportMs) {
    maxImportMs = ms;
    maxImportBytes = bytes.byteLength;
  }
};

// The store needs an attached runtime to mint identity (`tx.spawn`) and to project inbound applies — the
// same `attachDurable` the app's boot does. The board IS projected into probeWorld as a side effect (the
// joiner pays a 100k-entity projection at bootstrap); we time `probeWorld.sync()` below to surface that cost
// separately from the socket-transfer cost. remotePresence is an archetype-scoped query, so reading the
// cursor never scans the board.
attachDurable(probeWorld, doc);

const peerId = crypto.randomUUID();

// --- the shared transport channel (the REAL WS relay client under test) ------------------------------
const url = resolveRelayUrl(wsOrigin, room);
const channel = createWebSocketChannel({ room, self: peerId, url });

let helloAtMs = 0;
let bootstrappedAtMs = 0;
let bootstrapped = false;
let firstRemoteAtMs = 0;
// Record the socket-open moment: wireCollab posts `hello` from this same onOpen edge, so this ≈ hello-sent.
channel.lifecycle?.onOpen(() => {
  if (helloAtMs === 0) helloAtMs = nowRel();
});

// --- the ephemeral (presence) store: the SAME write path presence.ts uses, on the SAME channel --------
const source = new LoroEphemeralSnapshot(new LoroEphemeralStore(PRESENCE_TTL_MS));
const eph = createEphemeralStore(source, {
  peerId,
  send: (bytes) => channel.post({ kind: "ephemeral", from: peerId, bytes }),
  throttleMs: PRESENCE_THROTTLE_MS,
  ttlMs: PRESENCE_TTL_MS,
});
attachEphemeral(probeWorld, eph);
const { name, color } = presenceIdentity(peerId);
const me: Entity = eph.spawn({
  components: [
    [CursorPos, { x: CURSOR_RADIUS, y: 0 }],
    [PresenceInfo, { name, color }],
  ],
});

// --- bootstrap wiring: sender seeds the FULL board; joiner is a pure joiner (snapshot bootstrap) -------
const wiring: CollabWiring = wireCollab({
  peerId,
  channel,
  doc,
  helloTimeoutMs: 800,
  seedFirst: () => {
    if (role === "sender") doc.transaction((tx) => seedBoard(tx, count));
  },
  onStatus: (m) => {
    log.push(`${nowRel().toFixed(0)}ms ${m}`);
    setStatus(`${role}: ${m}`);
  },
  onBootstrapped: () => {
    bootstrapped = true;
    bootstrappedAtMs = nowRel();
    log.push(`${bootstrappedAtMs.toFixed(0)}ms BOOTSTRAPPED`);
  },
  onEphemeral: (bytes) => source.apply(bytes),
});
void wiring;

// --- the drive + sample loop --------------------------------------------------------------------------
const samples: Sample[] = [];
const OMEGA = (2 * Math.PI) / CURSOR_PERIOD_MS;

const readRemote = (): { x: number; y: number } | undefined => {
  let pos: { x: number; y: number } | undefined;
  probeWorld.query(remotePresence).each((b) => {
    for (const r of b) {
      const e = b.entity(r);
      const c = probeWorld.get(e, CursorPos);
      if (c) pos = { x: c.x, y: c.y };
    }
  });
  return pos;
};

let finished = false;
let maxSyncMs = 0;
let maxSyncAtMs = 0;
const frame = (): void => {
  if (finished) return;
  const t = nowRel();

  // DRIVE my own cursor — the real presence write path (identical to presence.ts's reportCursor).
  const angle = t * OMEGA;
  eph.edit(me).set(CursorPos, { x: CURSOR_RADIUS * Math.cos(angle), y: CURSOR_RADIUS * Math.sin(angle) });

  // SAMPLE the remote cursor — project inbound ephemeral (and any pending durable board) first, then read
  // it. Time the sync: the joiner's bootstrap projection of the whole board lands in one sync() and blocks
  // this rAF, so the max sync() is the projection component of the observed stall (distinct from transfer).
  const sy = performance.now();
  probeWorld.sync();
  const syncMs = performance.now() - sy;
  if (syncMs > maxSyncMs) {
    maxSyncMs = syncMs;
    maxSyncAtMs = t;
  }
  const remote = readRemote();
  if (remote) {
    if (firstRemoteAtMs === 0) firstRemoteAtMs = t;
    samples.push({ t, x: remote.x, y: remote.y });
  }

  if (t >= durMs) {
    finish();
    return;
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

// --- metrics ------------------------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function finish(): void {
  finished = true;

  // Reduce the per-rAF samples to the times at which the remote cursor's position actually CHANGED.
  // Because the driver's position is monotonic in time, "unchanged between consecutive samples" means
  // "no update arrived" — a stall. The intervals between changes are the remote cursor's inter-update gaps.
  const updateTimes: number[] = [];
  let px = NaN;
  let py = NaN;
  for (const s of samples) {
    if (s.x !== px || s.y !== py) {
      updateTimes.push(s.t);
      px = s.x;
      py = s.y;
    }
  }
  const intervals: { start: number; end: number; dur: number }[] = [];
  for (let i = 1; i < updateTimes.length; i++) {
    intervals.push({ start: updateTimes[i - 1], end: updateTimes[i], dur: updateTimes[i] - updateTimes[i - 1] });
  }

  // The "join event" is when the big snapshot crosses this peer's socket in either direction:
  //  - joiner: its own bootstrap (importing the sender's snapshot).
  //  - sender: when it exported/sent the answer snapshot (its cursor frames queue behind that frame).
  const joinAt = role === "joiner" ? bootstrappedAtMs : senderExportAtMs;

  // Steady state: intervals that START well after the join settled (join + 2s) — clean, no transfer.
  const steadyStart = (joinAt || 0) + 2000;
  const steady = intervals.filter((iv) => iv.start >= steadyStart).map((iv) => iv.dur).sort((a, b) => a - b);

  // Max gap overall, and the max gap in the bootstrap window (the hypothesis's stall).
  let maxGap = { start: 0, end: 0, dur: 0 };
  for (const iv of intervals) if (iv.dur > maxGap.dur) maxGap = iv;
  const winLo = (joinAt || 0) - 500;
  const winHi = (joinAt || 0) + 6000;
  let maxGapBoot = { start: 0, end: 0, dur: 0 };
  for (const iv of intervals) {
    if (iv.start >= winLo && iv.start <= winHi && iv.dur > maxGapBoot.dur) maxGapBoot = iv;
  }
  const topGaps = [...intervals].sort((a, b) => b.dur - a.dur).slice(0, 5);

  const snapshotBytes = origExport().byteLength; // authoritative board size (unwrapped call)

  const result = {
    role,
    room,
    count,
    peerId,
    durMs,
    // transfer / bootstrap decomposition
    snapshotBytes,
    exportCount,
    lastExportMs: round(lastExportMs),
    lastExportBytes,
    maxImportMs: round(maxImportMs),
    maxImportBytes,
    maxSyncMs: round(maxSyncMs),
    maxSyncAtMs: round(maxSyncAtMs),
    helloAtMs: round(helloAtMs),
    bootstrappedAtMs: round(bootstrappedAtMs),
    bootstrapMs: round(bootstrappedAtMs && helloAtMs ? bootstrappedAtMs - helloAtMs : 0),
    senderExportAtMs: round(senderExportAtMs),
    joinAtMs: round(joinAt),
    firstRemoteAtMs: round(firstRemoteAtMs),
    // remote-cursor observation
    sampleCount: samples.length,
    updateCount: updateTimes.length,
    steadyMedianMs: round(percentile(steady, 50)),
    steadyP95Ms: round(percentile(steady, 95)),
    steadyCount: steady.length,
    maxGapMs: round(maxGap.dur),
    maxGapAtMs: round(maxGap.end),
    maxGapDuringBootstrapMs: round(maxGapBoot.dur),
    maxGapDuringBootstrapAtMs: round(maxGapBoot.end),
    topGaps: topGaps.map((g) => ({ durMs: round(g.dur), atMs: round(g.end) })),
    bootstrapped,
    statusLog: log,
  };

  (window as unknown as { __STALL_RESULT: unknown }).__STALL_RESULT = result;
  setStatus(`${role}: DONE — maxGap ${result.maxGapDuringBootstrapMs}ms · steady p50 ${result.steadyMedianMs}ms · snap ${(snapshotBytes / 1e6).toFixed(2)}MB`);
  // eslint-disable-next-line no-console
  console.log("STALL_JSON:" + JSON.stringify(result));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

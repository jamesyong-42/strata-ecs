/**
 * `?script=swarm-probe` (swarm.html) — the N-peer SWARM convergence harness (NOT part of the shipped demo).
 *
 * A sibling of stall-probe.ts: it reuses the identical REAL machinery — `createWebSocketChannel`
 * (transport-ws.ts), `wireCollab` (boot.ts's bootstrap state machine), `attachDurable`, the real durable
 * `doc.transaction` write path, and the real ephemeral (presence) store — but instead of measuring a
 * cursor stall it drives DOCUMENT CHURN across N peers and, at quiesce, emits a canonical digest of the
 * converged document so an orchestrator can prove (or break) N-peer convergence.
 *
 * WHAT EACH PEER DOES (one role param, `sender` seeds; every peer is otherwise identical):
 *  - sender: the first peer — seeds a `?count=` board straight into the DOCUMENT (the same
 *    `doc.transaction(tx => seedBoard(tx, count))` boot.ts's first-peer path uses), then joins the churn.
 *  - joiner: bootstraps from a peer's snapshot, then joins the churn.
 *  - CHURN (both, once bootstrapped): every ~`editEveryMs` (jittered per peer) run ONE random op through
 *    `doc.transaction` — spawn a small peer-marked entity, edit the Position of one of ITS OWN prior
 *    spawns, or destroy one of its own. A peer only ever mutates entities IT spawned (never the seed board,
 *    never another peer's entity), so there are NO app-level same-cell races — the framework handles those,
 *    but keeping them out makes the convergence oracle a pure equality check. Plus a continuous ~30Hz cursor
 *    (the real presence write path) so presence coverage is observable.
 *  - QUIESCE: at `stopEditMs` all peers stop editing but KEEP syncing + driving presence; at `oracleMs`
 *    each peer reads its converged DOCUMENT (`doc.snapshot.entities()` + `readEntity`), builds a canonical
 *    per-entity digest, and emits `SWARM_JSON:<json>` (scraped over CDP; also on `window.__SWARM_RESULT`).
 *
 * The orchestrator (scratchpad/swarm.mjs) staggers the joins so no two peers cold-join simultaneously
 * (avoids the leaderless split-seed), gives every peer a WALL-clock-aligned stopEditMs/oracleMs (each is
 * `GLOBAL - startDelay`, so all peers stop/emit at the same wall instant), and PASS-checks that every
 * peer's digest is identical, its entity count == seed + Σ net spawns, and it saw N-1 remote peers.
 *
 * BOOTSTRAP AMPLIFICATION (an OBSERVED N>2 behavior, not fixed here): every already-bootstrapped peer
 * answers a joiner's hello, so a joiner that joins when K peers are up receives K snapshot copies and uses
 * only the first (boot.ts's cheap-responder tradeoff). The probe instruments the channel to COUNT the
 * snapshot answers it receives + their bytes, so the (N-1)-copy amplification is quantified per joiner.
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
import { CursorPos, Label, Position, PresenceInfo } from "../ecs/schema";
import { remotePresence } from "../ecs/queries";
import { presenceIdentity } from "./presence";
import { wireCollab, type CollabWiring } from "./boot";
import type { Channel, Envelope } from "./transport";
import { createWebSocketChannel, resolveRelayUrl } from "./transport-ws";

const PRESENCE_THROTTLE_MS = 33; // ~30Hz outbound — presence.ts's real cadence (design §15.5)
const PRESENCE_TTL_MS = 5000;
const CURSOR_PERIOD_MS = 4000;
const CURSOR_RADIUS = 500;

const params = new URLSearchParams(location.search);
const role = params.get("role") === "sender" ? "sender" : "joiner";
const peerId = params.get("peerId") ?? crypto.randomUUID();
const count = Math.max(1, Number(params.get("count") ?? 1000) || 1000);
const wsOrigin = params.get("ws") ?? ""; // "" → ws://localhost:8787
const room = params.get("room") ?? "swarm";
const helloMs = Number(params.get("helloMs") ?? 3000) || 3000;
// Churn cadence: one op every editEveryMs ± editJitterMs (per-peer jitter decorrelates the peers).
const editEveryMs = Number(params.get("editEveryMs") ?? 400) || 400;
const editJitterMs = Number(params.get("editJitterMs") ?? 200) || 200;
// WALL-aligned by the orchestrator: each peer is handed (GLOBAL - startDelay), so page-relative
// stopEditMs/oracleMs land at the same wall instant across peers regardless of when each loaded.
const stopEditMs = Number(params.get("stopEditMs") ?? 60_000) || 60_000;
const oracleMs = Number(params.get("oracleMs") ?? 70_000) || 70_000;

const statusEl = document.getElementById("status");
const setStatus = (m: string): void => {
  if (statusEl) statusEl.textContent = `${role} ${peerId}: ${m}`;
};
const log: string[] = [];
const t0 = performance.now();
const nowRel = (): number => performance.now() - t0;

// Count uncaught errors the run produces (CDP also scrapes exceptions; this is a self-reported tally).
let windowErrors = 0;
window.addEventListener("error", (e) => {
  windowErrors++;
  log.push(`${nowRel().toFixed(0)}ms window.error: ${e.message}`);
});

// A dedicated world for this probe (no rendering, no canvas app).
const probeWorld = createWorld({ name: `swarm-probe-${peerId}` });
const doc = createDurableStore(new LoroDoc());
attachDurable(probeWorld, doc);

// --- the real WS channel, WRAPPED so we can count inbound/outbound snapshots (bootstrap amplification) ---
// The wrapper forwards the entire Channel surface verbatim; it only observes envelopes as they pass. The
// WS client already drops our own echo + anything addressed to another peer, so an inbound `snapshot` with
// `to === peerId` is a hello-answer to US and `to === undefined` is a base broadcast we absorb.
const realChannel = createWebSocketChannel({ room, self: peerId, url: resolveRelayUrl(wsOrigin, room) });

let helloAtMs = 0;
let firstAnswerAtMs = 0;
let snapshotAnswersReceived = 0; // addressed hello-answers (to === me) — the amplification (K when K peers up)
let snapshotAnswerBytes = 0;
let snapshotBroadcastsReceived = 0; // un-addressed base broadcasts (to === undefined) we absorb
let snapshotBroadcastBytes = 0;
let snapshotAnswersSent = 0; // hello-answers WE sent (we are bootstrapped, someone else joined)
let snapshotBroadcastsSent = 0; // our own base broadcast (post-bootstrap / resume)

const channel: Channel = {
  post: (env: Envelope): void => {
    if (env.kind === "snapshot") {
      if (env.to !== undefined) snapshotAnswersSent++;
      else snapshotBroadcastsSent++;
    }
    realChannel.post(env);
  },
  onMessage: (fn: (env: Envelope) => void): void => {
    realChannel.onMessage((env) => {
      if (env.kind === "snapshot") {
        const n = env.bytes?.byteLength ?? 0;
        if (env.to === peerId) {
          snapshotAnswersReceived++;
          snapshotAnswerBytes += n;
          if (firstAnswerAtMs === 0) firstAnswerAtMs = nowRel();
        } else if (env.to === undefined) {
          snapshotBroadcastsReceived++;
          snapshotBroadcastBytes += n;
        }
      }
      fn(env);
    });
  },
  close: () => realChannel.close(),
  lifecycle: realChannel.lifecycle,
};
// hello rides the socket-open edge (wireCollab posts it from the same edge) — record ≈ hello-sent.
channel.lifecycle?.onOpen(() => {
  if (helloAtMs === 0) helloAtMs = nowRel();
});

// --- the ephemeral (presence) store: the SAME write path presence.ts uses, on the SAME channel ----------
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

// --- bootstrap wiring: sender seeds the board; joiners bootstrap from a snapshot -----------------------
let bootstrapped = false;
let bootstrappedAtMs = 0;
let seededSelf = false; // set true iff WE took the first-peer seed path (a joiner here ⇒ a FORK)
const wiring: CollabWiring = wireCollab({
  peerId,
  channel,
  doc,
  helloTimeoutMs: helloMs,
  seedFirst: () => {
    seededSelf = true;
    doc.transaction((tx) => seedBoard(tx, count));
    doc.clearHistory();
  },
  onStatus: (m) => {
    log.push(`${nowRel().toFixed(0)}ms ${m}`);
    setStatus(m);
  },
  onBootstrapped: () => {
    bootstrapped = true;
    bootstrappedAtMs = nowRel();
    log.push(`${bootstrappedAtMs.toFixed(0)}ms BOOTSTRAPPED`);
  },
  onEphemeral: (bytes) => source.apply(bytes),
});
void wiring;

// --- the churn: a peer only ever mutates entities IT spawned (no app-level same-cell races) ------------
const mySpawns: Entity[] = []; // LIVE own-spawned handles (deleted ones are spliced out)
let seq = 0; // per-peer spawn counter — marks each entity's Label as `swarm:<name>:<seq>`
let spawns = 0;
let edits = 0;
let deletes = 0;
const short = peerId.length > 8 ? peerId.slice(0, 8) : peerId;

// A tiny per-peer PRNG so op choice / target picks are reproducible given the tick sequence.
let rngState = 0;
for (const ch of peerId) rngState = (rngState * 31 + ch.charCodeAt(0)) | 0;
const rand = (): number => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const spread = 6000;
const worldCoord = (): number => (rand() - 0.5) * 2 * spread;

function doOneOp(): void {
  // Weighted: spawn 0.5 / edit 0.3 / delete 0.2 (net-positive growth so deletes exercise despawn but the
  // board still grows). Force a spawn when we have nothing of our own to edit/delete yet.
  const roll = mySpawns.length === 0 ? 0 : rand();
  if (roll < 0.5) {
    const e = doc.transaction((tx) =>
      tx.spawn({
        components: [
          [Position, { x: worldCoord(), y: worldCoord() }],
          [Label, { text: `swarm:${short}:${seq}` }],
        ],
      }),
    );
    seq++;
    spawns++;
    mySpawns.push(e);
  } else if (roll < 0.8) {
    // EDIT: Position is pre-existing on a prior-tick spawn (already projected), so this is the synchronous
    // value-write path — the exact §13.2 agreement point the framework converges per-cell.
    const e = mySpawns[Math.floor(rand() * mySpawns.length)];
    doc.transaction((tx) => tx.edit(e).set(Position, { x: worldCoord(), y: worldCoord() }));
    edits++;
  } else {
    const i = Math.floor(rand() * mySpawns.length);
    const e = mySpawns[i];
    doc.transaction((tx) => tx.destroy(e));
    mySpawns.splice(i, 1);
    deletes++;
  }
}

// --- presence coverage: distinct remote peers seen (by their deterministic handle) --------------------
const everRemotePeers = new Set<string>();
const readRemotePeers = (): Set<string> => {
  const here = new Set<string>();
  probeWorld.query(remotePresence).each((b) => {
    for (const r of b) {
      const info = probeWorld.get(b.entity(r), PresenceInfo);
      if (info && info.name) here.add(info.name);
    }
  });
  for (const n of here) everRemotePeers.add(n);
  return here;
};

// --- the frame loop: sync + drive cursor every frame; churn on its own jittered schedule --------------
let finished = false;
let nextEditAt = 0;
let editingStarted = false;
const OMEGA = (2 * Math.PI) / CURSOR_PERIOD_MS;

const frame = (): void => {
  if (finished) return;
  const t = nowRel();

  // Project inbound (durable board + increments + ephemeral) into the runtime.
  probeWorld.sync();

  // Drive our own cursor (real presence write path — identical to presence.ts's reportCursor).
  const angle = t * OMEGA;
  eph.edit(me).set(CursorPos, { x: CURSOR_RADIUS * Math.cos(angle), y: CURSOR_RADIUS * Math.sin(angle) });
  readRemotePeers();

  // Churn — only once bootstrapped (a joiner must not edit before it holds the base) and before stopEditMs.
  if (bootstrapped && t < stopEditMs) {
    if (!editingStarted) {
      editingStarted = true;
      nextEditAt = t; // first op right away
    }
    while (t >= nextEditAt) {
      doOneOp();
      nextEditAt += editEveryMs + rand() * editJitterMs;
    }
  }

  if (t >= oracleMs) {
    finish();
    return;
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

// --- the ORACLE: canonical digest of the converged DOCUMENT --------------------------------------------
// Deterministic stringify: recursively sort object keys so a component value's key order can't perturb the
// digest across peers. Arrays keep order (component values have none; relation target arrays are sorted at
// the record level below).
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

// FNV-1a 32-bit → 8-hex. Cheap, order-sensitive, plenty for an equality digest.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const hex = (n: number): string => n.toString(16).padStart(8, "0");

interface EntityDigest {
  k: string;
  h: string;
}

function digestDocument(): { digest: string; entityCount: number; perEntity: EntityDigest[] } {
  const snap = doc.snapshot;
  // entities() yields branded EntityKeys (assignable to string); sort lexicographically for a stable walk.
  const keys = [...snap.entities()].sort();
  const perEntity: EntityDigest[] = [];
  let acc = 0x811c9dc5;
  for (const key of keys) {
    const rec = snap.readEntity(key);
    if (rec === undefined) continue; // entities() gates on hasEntity, so this should never fire
    // Canonical per-entity string: sorted component names, sorted tags, sorted relation names with sorted
    // target arrays. Every peer stores the identical converged cells, so this string is byte-identical.
    const comps = Object.keys(rec.components)
      .sort()
      .map((c) => `${c}=${stable(rec.components[c])}`)
      .join(",");
    const tags = [...rec.tags].sort().join(",");
    const rels = Object.keys(rec.relations)
      .sort()
      .map((r) => {
        const tgt = rec.relations[r];
        const arr = Array.isArray(tgt) ? [...tgt].map(String).sort() : [String(tgt)];
        return `${r}=[${arr.join(",")}]`;
      })
      .join(",");
    const recStr = `${key}|c{${comps}}|t{${tags}}|r{${rels}}`;
    const h = fnv1a(recStr);
    perEntity.push({ k: key, h: hex(h) });
    // Fold each entity's (key,hash) into the document accumulator — order-fixed by the sorted key walk.
    acc ^= fnv1a(`${key}:${hex(h)}`);
    acc = Math.imul(acc, 0x01000193);
  }
  return { digest: hex(acc >>> 0), entityCount: perEntity.length, perEntity };
}

function finish(): void {
  finished = true;
  probeWorld.sync(); // final drain

  const { digest, entityCount, perEntity } = digestDocument();
  const currentRemote = readRemotePeers();
  const myKeyPrefix = `${peerId}-`;
  const myLiveEntities = perEntity.filter((e) => e.k.startsWith(myKeyPrefix)).length;

  const result = {
    role,
    peerId,
    name,
    room,
    seededSelf, // a joiner with seededSelf===true FORKED (split-seed) — an invalidating anomaly
    forkedSeed: role === "joiner" && seededSelf,
    // convergence oracle
    digest,
    entityCount,
    myLiveEntities,
    // op tally
    spawns,
    edits,
    deletes,
    netSpawns: spawns - deletes,
    seedCount: role === "sender" ? count : 0,
    // bootstrap amplification
    helloAtMs: round(helloAtMs),
    bootstrappedAtMs: round(bootstrappedAtMs),
    bootstrapMs: round(bootstrappedAtMs && helloAtMs ? bootstrappedAtMs - helloAtMs : 0),
    firstAnswerAtMs: round(firstAnswerAtMs),
    snapshotAnswersReceived,
    snapshotAnswerBytes,
    redundantAnswers: Math.max(0, snapshotAnswersReceived - 1),
    redundantAnswerBytes:
      snapshotAnswersReceived > 1
        ? Math.round((snapshotAnswerBytes * (snapshotAnswersReceived - 1)) / snapshotAnswersReceived)
        : 0,
    snapshotBroadcastsReceived,
    snapshotBroadcastBytes,
    snapshotAnswersSent,
    snapshotBroadcastsSent,
    // presence coverage
    remotePeersEver: everRemotePeers.size,
    remotePeersAtOracle: currentRemote.size,
    remotePeerNames: [...everRemotePeers].sort(),
    // hygiene
    windowErrors,
    bootstrapped,
    // per-entity digests (for divergence diagnosis; sorted by key)
    perEntity,
    statusLog: log,
  };

  (window as unknown as { __SWARM_RESULT: unknown }).__SWARM_RESULT = result;
  setStatus(
    `DONE — n=${entityCount} digest=${digest} spawns=${spawns} edits=${edits} dels=${deletes} ` +
      `answers=${snapshotAnswersReceived} peersSeen=${everRemotePeers.size}`,
  );
  // eslint-disable-next-line no-console
  console.log("SWARM_JSON:" + JSON.stringify(result));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

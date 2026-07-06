/**
 * `?script=collab-smoke` — the collab ACCEPTANCE self-test, in ONE page, headless-friendly. D2 hardened
 * it from a crash-smoke into a precise convergence suite driven through the REAL app write-surface.
 *
 * PEER A **is the app's own world** (`worldRef.ts`). The collab write ops (collab/ops.ts —
 * `commitCreate`/`commitDelete`/`commitDuplicate`/`commitDrag`) are hardwired to that singleton `world`
 * plus `activeCollab()`, so the only way to exercise the genuine app path — not a hand-rolled
 * `doc.transaction` — is to make peer A the app world: attach a durable store to it, install it as the
 * active collab session, drive the real ops, and assert peer B (a plain second world over the loopback)
 * converges PRECISELY (shape counts, component values, keys resolving). Everything is torn down at the
 * end, so the app returns to local-only mode with its seeded board intact behind the PASS note.
 *
 * The story, end to end (each asserts convergence, not just no-throw):
 *   1. bootstrap    — A seeds, B joins via snapshot and converges to A's board.
 *   2. create       — A `commitCreate`s a runtime draft into a durable twin → B converges (geometry).
 *   3. duplicate    — A `commitDuplicate`s the twin → B converges (the +16,+16 clone).
 *   4. delete       — A `commitDelete`s a seed → B converges (entity gone, arrows would cascade).
 *   5. edit vs drag — A recolors the twin's Fill while B drags its Position (component-granular: both
 *                     land); A's concurrent Position is drag-protected off; B's commit wins committer-wins.
 *   6. delete-drag  — A drags a shape while B deletes it; A's gesture-end `commitDrag` skips the dead
 *                     entity cleanly (the §17 write-side rule — no crash, no strand, no resurrection).
 *   7. late-join    — a third peer C joins mid-history, converges to the CURRENT document, and its first
 *                     increment is accepted by A and B WITHOUT quarantine (the bidirectional-base exchange).
 *   8. presence     — B's ephemeral cursor projects on A as `Not(Local)`; position + `SelectionRef` flow
 *                     across; `eph.leave()` despawns it (D1).
 *
 * The WHOLE suite runs under BOTH loopback modes — `"sync"` (inline, deterministic) and `"async"`
 * (microtask-deferred, realistic BroadcastChannel timing) — and main.ts asserts identical final
 * convergence. NO conflict-handling code appears here: the app writes through `doc.transaction` and reads
 * the runtime; the framework did the converging.
 */

import { createWorld, type Entity } from "@vibecook/strata-ecs";
import {
  attachDurable,
  createDurableStore,
  type Attachment,
  type Mutator,
} from "@vibecook/strata-ecs/durable";
import { attachEphemeral, createEphemeralStore, LoroEphemeralSnapshot } from "@vibecook/strata-ecs/ephemeral";
import { EphemeralStore as LoroEphemeralStore, LoroDoc } from "loro-crdt";
import { cam } from "../app/camera";
import { world as appWorld } from "../app/worldRef";
import {
  CursorPos,
  Fill,
  Kind,
  Position,
  PresenceInfo,
  SelectionRef,
  Size,
  Velocity,
  ZIndex,
} from "../ecs/schema";
import { remotePresence } from "../ecs/queries";
import { commitCreate, commitDelete, commitDrag, commitDuplicate } from "./ops";
import { setActiveCollab } from "./mode";
import { presenceIdentity } from "./presence";
import { Loopback, type LoopbackMode } from "./loopback";
import { wireCollab } from "./boot";
import type { Channel } from "./transport";
import { createWebSocketChannel, resolveRelayUrl, type WebSocketChannel } from "./transport-ws";

interface Check {
  ok: boolean;
  label: string;
}

/** The compact result main.ts folds into the HUD note + the both-modes-match assertion. */
export interface SmokeResult {
  passed: number;
  total: number;
  firstFail?: string;
  /** Every failing check's label, in order — the HUD shows the first; verification dumps them all. */
  failed: string[];
}

const eq2 = (v: { x: number; y: number } | undefined, x: number, y: number): boolean =>
  v !== undefined && v.x === x && v.y === y;
const sizeEq = (v: { w: number; h: number } | undefined, w: number, h: number): boolean =>
  v !== undefined && v.w === w && v.h === h;
const fillEq = (
  v: { r: number; g: number; b: number; a: number } | undefined,
  r: number,
  g: number,
  b: number,
  a: number,
): boolean => v !== undefined && v.r === r && v.g === g && v.b === b && v.a === a;

/** Spawn one rect into a transaction — the smoke board's unit (a known, non-random shape). */
function spawnRect(tx: Mutator, x: number, y: number, z: number): Entity {
  return tx.spawn({
    components: [
      [Position, { x, y }],
      [Size, { w: 80, h: 60 }],
      [Fill, { r: 90, g: 160, b: 255, a: 255 }],
      [ZIndex, { z }],
      [Kind, { shape: "rect" }],
      [Velocity, {}],
    ],
  });
}

/**
 * Which transport the suite runs over:
 *  - `loopback` — the in-memory shim, one `mode`; deterministic, no server (the default; D2's two modes).
 *  - `ws` — a live WebSocket relay at `origin` (`""` → ws://localhost:8787): both in-page worlds open
 *    their OWN socket to it and converge over real frames. Adds the relay-drop → re-bootstrap scenario.
 */
export type SmokeTransport =
  { kind: "loopback"; mode: LoopbackMode } | { kind: "ws"; origin: string };

// WS timing caps — localhost relay round-trips are sub-millisecond, so these are generous safety nets,
// not tuned latencies. A step that blows its cap leaves its `check` false, which reports the failure.
const WS_STEP_TIMEOUT_MS = 5000; // one cross-peer convergence step
const WS_RECONNECT_TIMEOUT_MS = 9000; // drop → backoff reconnect → re-bootstrap → converge
const WS_QUIET_MS = 150; // "settle" for the rare NEGATIVE (drag-protection) assertion — no positive edge to await
const WS_HELLO_TIMEOUT_MS = 250; // A's first-peer seed + a reconnect sole-peer resume (vs. the 800ms app default)
const WS_CONNECT_TIMEOUT_MS = 5000; // give up (report "relay unreachable") if A's socket never opens

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the acceptance suite over one transport. Async because delivery is over microtasks (loopback
 * `"async"`) or real sockets (`ws`) — the `barrier` helper is the cross-peer boundary: loopback drains
 * deterministically then projects; ws POLLS (projecting each round) until the step's convergence predicate
 * holds or a timeout elapses. Returns the tally for the HUD note.
 */
export async function runCollabSmoke(
  transport: SmokeTransport = { kind: "loopback", mode: "sync" },
): Promise<SmokeResult> {
  const checks: Check[] = [];
  const check = (label: string, ok: boolean): void => {
    checks.push({ label, ok });
  };

  const isWS = transport.kind === "ws";
  const loop = transport.kind === "loopback" ? new Loopback(transport.mode) : null;
  // A FRESH room per ws run — the relay persists rooms across runs, so distinct runs must not collide.
  const wsRoom = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const wsChannels: WebSocketChannel[] = [];
  const mkChannel = (peerId: string): Channel => {
    if (transport.kind === "loopback") return loop!.channel(peerId);
    const ch = createWebSocketChannel({
      room: wsRoom,
      self: peerId,
      url: resolveRelayUrl(transport.origin, wsRoom),
    });
    wsChannels.push(ch);
    return ch;
  };
  const helloTimeoutMs = isWS ? WS_HELLO_TIMEOUT_MS : undefined;
  const statusLog: string[] = [];

  // Cross-peer barrier. Loopback: drain, then project. WS: poll (project each round) until `pred` holds or
  // the cap elapses. `pred` captures the step's STRONGEST convergence condition — once it holds, the
  // step's sibling checks (all about the same delivered increment) hold too.
  const barrier = async (
    project: () => void,
    pred: () => boolean,
    timeoutMs = WS_STEP_TIMEOUT_MS,
  ): Promise<void> => {
    if (loop !== null) {
      await loop.settle();
      project();
      return;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      project();
      if (pred()) return;
      if (Date.now() >= deadline) return; // give up; the check reads the un-converged state and fails
      await delay(10);
    }
  };
  // "Settle" for a NEGATIVE assertion (drag protection): there is no positive edge to await, so loopback
  // drains and ws waits a short quiet window (localhost delivery is sub-ms — this reliably confirms the
  // increment arrived and was handled) before we assert the value was correctly HELD (not applied).
  const settleQuiet = async (project: () => void): Promise<void> => {
    if (loop !== null) await loop.settle();
    else await delay(WS_QUIET_MS);
    project();
  };

  // --- peer A = THE APP WORLD: attach a durable store, install the collab session, drive the real ops --
  const worldA = appWorld;
  const docA = createDurableStore(new LoroDoc());
  const attA: Attachment = attachDurable(worldA, docA);
  setActiveCollab({ room: "smoke", peerId: "A", doc: docA });

  const seeded: Entity[] = [];
  const channelA = mkChannel("A");
  const wireA = wireCollab({
    peerId: "A",
    channel: channelA,
    doc: docA,
    helloTimeoutMs,
    onStatus: (m) => statusLog.push(`A:${m}`),
    seedFirst: () => {
      docA.transaction((tx) => {
        seeded.push(
          spawnRect(tx, 100, 100, 1),
          spawnRect(tx, 300, 100, 2),
          spawnRect(tx, 500, 100, 3),
        );
      });
    },
  });
  wireA.seedNow(); // take the first-peer seed path now (no wait) — A holds the board, ready to answer hellos
  worldA.sync(); // project the seed into A's runtime
  const keys = seeded.map((e) => docA.keyOf(e));
  check("A seeded 3 shapes with keys", keys.every((k) => k !== undefined) && keys.length === 3);

  // WS: A must have JOINED the relay room (socket open) before B hellos, else B hears no answer and forks
  // its own seed. Bounded so a down relay reports "unreachable" instead of hanging. Loopback is inline.
  if (isWS) {
    const connected = await Promise.race([
      (channelA as WebSocketChannel).ready().then(() => true),
      delay(WS_CONNECT_TIMEOUT_MS).then(() => false),
    ]);
    check("A's socket connected to the relay", connected);
    if (!connected) {
      // Relay down — bail out cleanly instead of grinding through every step's timeout.
      wireA.dispose();
      attA.detach();
      setActiveCollab(null);
      const fails = checks.filter((c) => !c.ok).map((c) => c.label);
      return {
        passed: checks.length - fails.length,
        total: checks.length,
        firstFail: fails[0],
        failed: fails,
      };
    }
  }

  // --- peer B: join → bootstrap from A's snapshot ---------------------------------------------------
  const worldB = createWorld({ name: "collab-smoke-b" });
  const docB = createDurableStore(new LoroDoc());
  const attB: Attachment = attachDurable(worldB, docB);
  const wireB = wireCollab({
    peerId: "B",
    channel: mkChannel("B"),
    doc: docB,
    seedFirst: () => {},
    helloTimeoutMs,
    onStatus: (m) => statusLog.push(`B:${m}`),
  });
  // Creating B posts `hello`; A answers with a snapshot. Loopback-sync completes inline; loopback-async and
  // ws need the handshake (hello → snapshot → B's bidirectional base broadcast) to drain / round-trip first.
  await barrier(
    () => worldB.sync(),
    () =>
      wireB.isBootstrapped() && keys.every((k) => k !== undefined && docB.resolve(k) !== undefined),
  );
  check("B bootstrapped from A's snapshot", wireB.isBootstrapped());
  check(
    "B converged to A's 3 seeded shapes",
    keys.every((k) => k !== undefined && docB.resolve(k) !== undefined),
  );

  // --- create: A promotes a runtime draft into a durable twin (ops.ts commitCreate) → B converges ---
  // The draw tool spawns a runtime-only draft (a peer must never see a half-drawn shape), then promotes
  // it at pointer-up. Drive that exact path: a `world.spawn` draft, then the real commitCreate.
  const draft = worldA.spawn({
    components: [
      [Position, { x: 700, y: 100 }],
      [Size, { w: 80, h: 60 }],
      [Fill, { r: 88, g: 166, b: 255, a: 210 }],
      [ZIndex, { z: 4 }],
      [Kind, { shape: "rect" }],
      [Velocity, {}],
    ],
  });
  const twinA = commitCreate(draft);
  worldA.sync(); // A projects its own create (local echo, no round-trip)
  check("commitCreate returned a durable twin", twinA !== undefined);
  check("commitCreate destroyed the runtime draft", !worldA.isAlive(draft));
  const twinKey = twinA !== undefined ? docA.keyOf(twinA) : undefined;
  check("A's created twin has a durable key", twinKey !== undefined);
  await barrier(
    () => worldB.sync(),
    () => twinKey !== undefined && docB.resolve(twinKey) !== undefined,
  ); // B drains the create
  const twinB = twinKey !== undefined ? docB.resolve(twinKey) : undefined;
  check("B converged on A's created shape", twinB !== undefined);
  check(
    "B's twin matches A's Position",
    twinB !== undefined && eq2(worldB.get(twinB, Position), 700, 100),
  );
  check(
    "B's twin matches A's Size",
    twinB !== undefined && sizeEq(worldB.get(twinB, Size), 80, 60),
  );
  check(
    "B's twin matches A's Fill",
    twinB !== undefined && fillEq(worldB.get(twinB, Fill), 88, 166, 255, 210),
  );

  // --- duplicate: A clones the twin (+16,+16) through ops.ts commitDuplicate → B converges -----------
  const clones = twinA !== undefined ? commitDuplicate([twinA]) : [];
  worldA.sync();
  check("commitDuplicate returned one clone", clones.length === 1);
  const cloneKey = clones[0] !== undefined ? docA.keyOf(clones[0]) : undefined;
  check("A's clone has a durable key", cloneKey !== undefined);
  await barrier(
    () => worldB.sync(),
    () => cloneKey !== undefined && docB.resolve(cloneKey) !== undefined,
  );
  const cloneB = cloneKey !== undefined ? docB.resolve(cloneKey) : undefined;
  check("B converged on A's duplicate", cloneB !== undefined);
  check(
    "B's clone is offset +16,+16 from the twin",
    cloneB !== undefined && eq2(worldB.get(cloneB, Position), 716, 116),
  );

  // --- delete: A destroys a seed through ops.ts commitDelete → B converges (entity gone) -------------
  const delKey = keys[2];
  if (seeded[2] !== undefined) commitDelete([seeded[2]]);
  worldA.sync();
  check("A destroyed the seed locally", seeded[2] === undefined || !worldA.isAlive(seeded[2]));
  await barrier(
    () => worldB.sync(),
    () => delKey !== undefined && docB.resolve(delKey) === undefined,
  );
  check(
    "B converged on A's delete (seed gone)",
    delKey !== undefined && docB.resolve(delKey) === undefined,
  );

  // --- edit vs. drag on ONE shape: component-granular convergence + drag protection + committer-wins --
  // B starts dragging the twin (runtime Position diverges from baseline; NO commit — a real drag mid-flight).
  if (twinB !== undefined) worldB.edit(twinB).set(Position, { x: 250, y: 250 });
  // A recolors the twin's Fill (a DIFFERENT cell). Fill has no dedicated app verb, so A commits it through
  // doc.transaction directly — the component-granular convergence is the framework's regardless of author.
  if (twinA !== undefined)
    docA.transaction((tx) => tx.edit(twinA).set(Fill, { r: 255, g: 0, b: 0, a: 255 }));
  worldA.sync();
  await barrier(
    () => worldB.sync(),
    () => twinB !== undefined && worldB.get(twinB, Fill)?.r === 255,
  );
  check(
    "B applied A's Fill during the drag (different cell)",
    twinB !== undefined && worldB.get(twinB, Fill)?.r === 255,
  );
  check(
    "B's drag held its Position through the Fill edit",
    twinB !== undefined && eq2(worldB.get(twinB, Position), 250, 250),
  );

  // A drags the SAME cell B is dragging, via the REAL commitDrag (runtime write + gesture-end commit) →
  // B's drag protection DROPS A's Position (committer-wins pending until B releases).
  if (twinA !== undefined) {
    worldA.edit(twinA).set(Position, { x: 900, y: 900 });
    commitDrag([twinA], 0, 0);
  }
  worldA.sync();
  await settleQuiet(() => worldB.sync()); // NEGATIVE: confirm A's Position increment arrived, then assert it was HELD
  check(
    "B's drag protection dropped A's concurrent Position",
    twinB !== undefined && eq2(worldB.get(twinB, Position), 250, 250),
  );

  // B commits its drag → its Position wins committer-wins (later than A's); both converge; Fill stays red.
  if (twinB !== undefined)
    docB.transaction((tx) => tx.edit(twinB).set(Position, { x: 260, y: 260 }));
  worldB.sync(); // B's own echo (agrees, no strand)
  await barrier(
    () => worldA.sync(),
    () => twinA !== undefined && eq2(worldA.get(twinA, Position), 260, 260),
  ); // A drains B's committed Position
  check(
    "A converged on B's committed drag (committer-wins)",
    twinA !== undefined && eq2(worldA.get(twinA, Position), 260, 260),
  );
  check(
    "Fill converged red on A too (component-granular)",
    twinA !== undefined && worldA.get(twinA, Fill)?.r === 255,
  );
  check("Fill converged red on B too", twinB !== undefined && worldB.get(twinB, Fill)?.r === 255);

  // --- delete-under-drag: A drags a shape B deletes; A's commitDrag skips it cleanly (§17 write-side) --
  const victim = seeded[1];
  const victimKey = keys[1];
  if (victim !== undefined) worldA.edit(victim).set(Position, { x: 111, y: 222 }); // A drags it (runtime only)
  const victimOnB = victimKey !== undefined ? docB.resolve(victimKey) : undefined;
  if (victimOnB !== undefined) docB.transaction((tx) => tx.destroy(victimOnB)); // B deletes it
  await barrier(
    () => worldA.sync(),
    () => victim === undefined || !worldA.isAlive(victim),
  ); // A drains B's delete → victim despawns mid-drag
  check(
    "A's dragged shape was deleted out from under the drag",
    victim === undefined || !worldA.isAlive(victim),
  );
  // The §17 write-side rule: commitDrag's keyOf/isAlive/has(Position) guards make committing the dead drag
  // a clean no-op — this must NOT throw and must NOT resurrect the shape.
  let dragThrew = false;
  try {
    if (victim !== undefined) commitDrag([victim], 0, 0);
  } catch {
    dragThrew = true;
  }
  worldA.sync();
  check("commitDrag on the deleted shape was a clean no-op (no throw)", !dragThrew);
  await settleQuiet(() => worldB.sync()); // B already deleted it locally; confirm the dead drag sent nothing to resurrect it
  check(
    "B still sees the shape gone (the dead drag committed nothing)",
    victimKey !== undefined && docB.resolve(victimKey) === undefined,
  );

  // --- late-join: a third peer joins mid-history, then its first increment lands WITHOUT quarantine ----
  // C bootstraps from the CURRENT document (not the seed) and — the D0 discovery — broadcasts its own base
  // on joining, so A and B accept C's first increment (which references C's construction commit they lack).
  const worldC = createWorld({ name: "collab-smoke-c" });
  const docC = createDurableStore(new LoroDoc());
  const attC: Attachment = attachDurable(worldC, docC);
  const wireC = wireCollab({
    peerId: "C",
    channel: mkChannel("C"),
    doc: docC,
    seedFirst: () => {},
    helloTimeoutMs,
    onStatus: (m) => statusLog.push(`C:${m}`),
  });
  await barrier(
    () => worldC.sync(),
    () => wireC.isBootstrapped(),
  );
  check("C bootstrapped from an existing peer mid-history", wireC.isBootstrapped());
  worldC.sync();
  const twinOnC = twinKey !== undefined ? docC.resolve(twinKey) : undefined;
  check(
    "C converged on the recolored twin (mid-history snapshot)",
    twinOnC !== undefined && worldC.get(twinOnC, Fill)?.r === 255,
  );
  check(
    "C converged on the twin's committed position",
    twinOnC !== undefined && eq2(worldC.get(twinOnC, Position), 260, 260),
  );
  check(
    "C sees the duplicate clone",
    cloneKey !== undefined && docC.resolve(cloneKey) !== undefined,
  );
  check(
    "C sees the deleted shapes as gone",
    delKey !== undefined &&
      victimKey !== undefined &&
      docC.resolve(delKey) === undefined &&
      docC.resolve(victimKey) === undefined,
  );
  // C's FIRST increment → the existing peers must NOT quarantine it (the bidirectional base was exchanged).
  const cShape = docC.transaction((tx) => spawnRect(tx, -300, -300, 9));
  worldC.sync();
  const cKey = docC.keyOf(cShape);
  await barrier(
    () => {
      worldA.sync();
      worldB.sync();
    },
    () =>
      cKey !== undefined && docA.resolve(cKey) !== undefined && docB.resolve(cKey) !== undefined,
  );
  check(
    "A accepted C's first increment without quarantine",
    cKey !== undefined && docA.resolve(cKey) !== undefined,
  );
  check(
    "B accepted C's first increment without quarantine",
    cKey !== undefined && docB.resolve(cKey) !== undefined,
  );
  check(
    "no peer quarantined an out-of-order import",
    !statusLog.some((m) => m.includes("quarantined")),
  );

  // --- presence: B's ephemeral cursor projects on A (Not(Local)); leave() despawns it ---------------
  // Presence rides its own in-memory wiring (not the loopback): it is TTL-self-healing, so delivery timing
  // does not change its final convergence — it runs identically in both modes, and the test pumps the
  // store's throttle path by hand (encodeChanged → apply → sync) to stay synchronous/deterministic.
  const loroA = new LoroEphemeralStore(5000);
  const loroB = new LoroEphemeralStore(5000);
  const ephSrcA = new LoroEphemeralSnapshot(loroA);
  const ephSrcB = new LoroEphemeralSnapshot(loroB);
  const ephA = createEphemeralStore(ephSrcA, {
    peerId: "A",
    send: (b) => ephSrcB.apply(b),
    throttleMs: 8,
    ttlMs: 5000,
  });
  const ephB = createEphemeralStore(ephSrcB, {
    peerId: "B",
    send: (b) => ephSrcA.apply(b),
    throttleMs: 8,
    ttlMs: 5000,
  });
  const attEphA = attachEphemeral(worldA, ephA);
  const attEphB = attachEphemeral(worldB, ephB);

  const remoteCountOnA = (): number => {
    let n = 0;
    worldA.query(remotePresence).each((b) => {
      n += b.count;
    });
    return n;
  };
  const remoteOnA = (): Entity | undefined => {
    let e: Entity | undefined;
    worldA.query(remotePresence).each((b) => {
      for (const r of b) e = b.entity(r);
    });
    return e;
  };
  const flushBtoA = (): void => {
    const changed = ephSrcB.encodeChanged();
    if (changed !== null) ephSrcA.apply(changed);
    for (const del of ephSrcB.encodeDeletes()) ephSrcA.apply(del);
    worldA.sync();
  };
  // Two distinct-value sends of ONE key must land ≥1ms apart for Loro's wall-clock LWW to order them
  // (M0 finding 2) — the app's 33ms throttle guarantees it; the test yields the clock forward to force it.
  // An awaited delay (not a busy-wait) advances the clock cooperatively, so it also works under a headless
  // browser's virtual-time budget, where a synchronous spin would freeze the (frozen-mid-task) clock.
  const nudgeClock = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

  ephA.spawn({
    components: [
      [CursorPos, { x: 0, y: 0 }],
      [PresenceInfo, { name: "ada", color: "hsl(200 70% 60%)" }],
    ],
  });
  const bCursor = ephB.spawn({
    components: [
      [CursorPos, { x: 120, y: 80 }],
      [PresenceInfo, { name: "bo", color: "hsl(20 70% 60%)" }],
    ],
  });
  worldA.sync(); // project A's own (Local) — it must NOT count as a remote peer
  check("A's own presence is excluded by Not(Local)", remoteCountOnA() === 0);
  flushBtoA();
  check("B's presence projected onto A as a remote peer", remoteCountOnA() === 1);
  const bOnA = remoteOnA();
  check(
    "A sees B's cursor position",
    bOnA !== undefined && eq2(worldA.get(bOnA, CursorPos), 120, 80),
  );

  await nudgeClock();
  ephB.edit(bCursor).set(CursorPos, { x: 240, y: 200 });
  flushBtoA();
  check(
    "A sees B's cursor move through the loopback",
    bOnA !== undefined && eq2(worldA.get(bOnA, CursorPos), 240, 200),
  );

  // SelectionRef facet APPEARS (membership-as-signal): B selects one of A's seeded shapes.
  await nudgeClock();
  if (keys[0] !== undefined) ephB.addComponent(bCursor, SelectionRef, { targetKey: keys[0] });
  flushBtoA();
  check(
    "B's SelectionRef facet appeared on A",
    bOnA !== undefined && worldA.get(bOnA, SelectionRef)?.targetKey === keys[0],
  );

  // SelectionRef facet DISAPPEARS (B deselects).
  await nudgeClock();
  ephB.removeComponent(bCursor, SelectionRef);
  flushBtoA();
  check(
    "B's SelectionRef facet removed on A",
    bOnA !== undefined && worldA.get(bOnA, SelectionRef) === undefined,
  );

  // leave() — B departs: its tombstone despawns B on A now, not on TTL.
  await nudgeClock();
  ephB.leave();
  worldA.sync();
  check("A despawned B's presence after leave()", remoteCountOnA() === 0);

  attEphA.detach();
  attEphB.detach();
  loroA.destroy();
  loroB.destroy();

  // --- reconnect (ws only): drop EVERY socket mid-session; each peer re-bootstraps; convergence holds --
  // The relay is dumb + stateless, so a client-side drop that forces every peer to re-join is exactly a
  // relay restart from the clients' view (a real relay-process restart is exercised in headless verify).
  // The edit below is made WHILE DISCONNECTED, so its increment is DROPPED by the closed socket — it can
  // reach the peers ONLY via the reconnect snapshot (the 006 re-bootstrap policy), never as a live increment.
  if (isWS) {
    for (const ch of wsChannels) ch.dropForTest();
    const reEntity = docA.transaction((tx) => spawnRect(tx, -900, -900, 12));
    worldA.sync();
    const reKey = docA.keyOf(reEntity);
    await barrier(
      () => {
        worldB.sync();
        worldC.sync();
      },
      () =>
        reKey !== undefined &&
        docB.resolve(reKey) !== undefined &&
        docC.resolve(reKey) !== undefined,
      WS_RECONNECT_TIMEOUT_MS,
    );
    check(
      "B re-bootstrapped after a relay drop and converged",
      reKey !== undefined && docB.resolve(reKey) !== undefined,
    );
    check(
      "C re-bootstrapped after a relay drop and converged",
      reKey !== undefined && docC.resolve(reKey) !== undefined,
    );
    check(
      "all peers report bootstrapped again after reconnect",
      wireA.isBootstrapped() && wireB.isBootstrapped() && wireC.isBootstrapped(),
    );
    check(
      "no peer quarantined an import through the reconnect",
      !statusLog.some((m) => m.includes("quarantined")),
    );
  }

  // --- teardown: return the app world to local-only mode, board intact behind the note --------------
  wireA.dispose();
  wireB.dispose();
  wireC.dispose();
  attA.detach(); // despawn A's durable projections — the app world is back to just its local seed board
  attB.detach();
  attC.detach();
  setActiveCollab(null); // the live app is local-only again (the smoke never persisted a collab session)

  const fails = checks.filter((c) => !c.ok).map((c) => c.label);
  return {
    passed: checks.length - fails.length,
    total: checks.length,
    firstFail: fails[0],
    failed: fails,
  };
}

/**
 * Make two REMOTE cursors visible in the running app for the headless PASS screenshot. Attaches a real
 * ephemeral store to the app's world — so the app projects presence through the SAME
 * `[CursorPos, PresenceInfo, Not(Local)]` path a real second tab would — and drives two throwaway peers'
 * cursors into it. The app's own frame-loop `world.sync()` projects them and the overlay draws the labeled
 * cursors next frame; they persist (60s TTL) for the screenshot. Renders NOTHING in the durable document —
 * purely the presence-rendering demo, independent of the correctness self-test (which has torn its own
 * bindings down by the time this runs).
 */
export function injectDemoCursors(): void {
  const viewerSrc = new LoroEphemeralSnapshot(new LoroEphemeralStore(60_000));
  const viewer = createEphemeralStore(viewerSrc, {
    peerId: "viewer",
    send: () => {},
    ttlMs: 60_000,
  });
  attachEphemeral(appWorld, viewer); // the app world now projects remote presence (real path)

  const pushCursor = (peerId: string, wx: number, wy: number): void => {
    const peerWorld = createWorld({ name: `demo-peer-${peerId}` });
    const src = new LoroEphemeralSnapshot(new LoroEphemeralStore(60_000));
    const eph = createEphemeralStore(src, { peerId, send: () => {}, ttlMs: 60_000 });
    attachEphemeral(peerWorld, eph);
    const { name, color } = presenceIdentity(peerId);
    eph.spawn({
      components: [
        [CursorPos, { x: wx, y: wy }],
        [PresenceInfo, { name, color }],
      ],
    });
    const bytes = src.encodeChanged();
    if (bytes !== null) viewerSrc.apply(bytes); // the app's next world.sync() projects it → overlay draws it
  };

  // Place two cursors near the view center (world coords) so they land on-screen after the smoke's
  // zoom-to-fit framing of the local board.
  pushCursor("demo-ada", cam.x - 90 / cam.zoom, cam.y - 30 / cam.zoom);
  pushCursor("demo-bo", cam.x + 130 / cam.zoom, cam.y + 70 / cam.zoom);
}

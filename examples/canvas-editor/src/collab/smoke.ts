/**
 * `?script=collab-smoke` — the D0 acceptance self-test, in ONE page, headless-friendly.
 *
 * Two independent worlds (A and B), each with its own attached durable store, wired over the in-memory
 * {@link Loopback} (the BroadcastChannel surface, synchronous — so the test is deterministic and drives
 * each world's `sync()` by hand). It runs the collab boot's REAL {@link wireCollab} bootstrap, then
 * exercises the D0 story end to end:
 *
 *   1. bootstrap  — A seeds, B joins via snapshot and converges to A's board.
 *   2. create     — A creates a shape → B converges.
 *   3. drag+edit  — B drags A's shape (runtime writes, no commit) while A edits the SAME shape's Fill
 *                   (a different cell → applies) AND its Position (the SAME cell → dropped by drag
 *                   protection); B then commits the drag → both converge, committer-wins on Position.
 *   4. delete     — A deletes a shape → B converges (the entity is gone on B).
 *   5. presence   — B spawns an ephemeral cursor; it projects on A as `Not(Local)`, its position + a
 *                   `SelectionRef` facet flow across, and `eph.leave()` despawns it on A (D1).
 *
 * NO conflict-handling code appears here — the app writes through `doc.transaction` and reads the
 * runtime; the framework did the converging. PASS/FAIL is reported to the HUD note (the established
 * headless-screenshot pattern — see main.ts `?script=persist`).
 */

import { createWorld, type Entity } from "strata-ecs";
import { attachDurable, createDurableStore, type Mutator } from "strata-ecs/durable";
import { attachEphemeral, createEphemeralStore, LoroEphemeralSnapshot } from "strata-ecs/ephemeral";
import { EphemeralStore as LoroEphemeralStore, LoroDoc } from "loro-crdt";
import { cam } from "../app/camera";
import { world as appWorld } from "../app/worldRef";
import { CursorPos, Fill, Kind, Position, PresenceInfo, SelectionRef, Size, Velocity, ZIndex } from "../ecs/schema";
import { remotePresence } from "../ecs/queries";
import { presenceIdentity } from "./presence";
import { Loopback } from "./loopback";
import { wireCollab } from "./boot";

interface Check {
  ok: boolean;
  label: string;
}

const eq2 = (v: { x: number; y: number } | undefined, x: number, y: number): boolean =>
  v !== undefined && v.x === x && v.y === y;

/** Spawn one rect into a transaction — the smoke board's unit (a known, non-random shape). */
function spawnRect(tx: Mutator, x: number, y: number, z: number): Entity {
  return tx.spawn({
    components: [[Position, { x, y }], [Size, { w: 80, h: 60 }], [Fill, { r: 90, g: 160, b: 255, a: 255 }], [ZIndex, { z }], [Kind, { shape: "rect" }], [Velocity, {}]],
  });
}

/**
 * Run the self-test. Synchronous (the loopback delivers inline and we sync() by hand). Returns a compact
 * `collab-smoke: PASS n/n …` / `FAIL …` line for the HUD note.
 */
export function runCollabSmoke(): string {
  const checks: Check[] = [];
  const check = (label: string, ok: boolean): void => {
    checks.push({ label, ok });
  };

  const loop = new Loopback();
  const statusLog: string[] = [];

  // --- peer A: create, attach, wire, seed (the first peer) ------------------------------------------
  const worldA = createWorld({ name: "collab-smoke-a" });
  const docA = createDurableStore(new LoroDoc());
  attachDurable(worldA, docA);
  const seeded: Entity[] = [];
  const wireA = wireCollab({
    peerId: "A",
    channel: loop.channel("A"),
    doc: docA,
    onStatus: (m) => statusLog.push(`A:${m}`),
    seedFirst: () => {
      docA.transaction((tx) => {
        seeded.push(spawnRect(tx, 100, 100, 1), spawnRect(tx, 300, 100, 2), spawnRect(tx, 500, 100, 3));
      });
    },
  });
  wireA.seedNow(); // take the first-peer seed path now (no 800ms wait)
  worldA.sync(); // project the seed into A's runtime
  const keys = seeded.map((e) => docA.keyOf(e));
  check("A seeded 3 shapes with keys", keys.every((k) => k !== undefined) && keys.length === 3);

  // --- peer B: join → bootstrap from A's snapshot ---------------------------------------------------
  const worldB = createWorld({ name: "collab-smoke-b" });
  const docB = createDurableStore(new LoroDoc());
  attachDurable(worldB, docB);
  const wireB = wireCollab({ peerId: "B", channel: loop.channel("B"), doc: docB, seedFirst: () => {}, onStatus: (m) => statusLog.push(`B:${m}`) });
  // Creating B posted `hello`; A answered with a snapshot synchronously → B is already bootstrapped.
  check("B bootstrapped from A's snapshot", wireB.isBootstrapped());
  worldB.sync(); // project the snapshot into B's runtime
  check(
    "B converged to A's 3 seeded shapes",
    keys.every((k) => k !== undefined && docB.resolve(k) !== undefined),
  );

  // --- create: A makes a new shape → B converges ----------------------------------------------------
  const sA = docA.transaction((tx) => spawnRect(tx, 700, 100, 4));
  worldA.sync(); // A projects its own create; the outbound increment already reached B
  const keyS = docA.keyOf(sA);
  worldB.sync(); // B drains the create increment
  const sB = keyS !== undefined ? docB.resolve(keyS) : undefined;
  check("B received A's created shape", sB !== undefined);

  // --- drag + concurrent edit (drag protection + component-granular convergence) --------------------
  // B starts dragging S: runtime Position diverges from baseline, NO commit yet (a real drag mid-flight).
  if (sB !== undefined) worldB.edit(sB).set(Position, { x: 150, y: 150 });

  // A edits S's FILL (a different cell) → B applies it; the drag (Position) is untouched.
  docA.transaction((tx) => tx.edit(sA).set(Fill, { r: 255, g: 0, b: 0, a: 255 }));
  worldA.sync();
  worldB.sync();
  check("B applied A's Fill edit during the drag (different cell)", sB !== undefined && worldB.get(sB, Fill)?.r === 255);
  check("B's drag held its Position through the Fill edit", sB !== undefined && eq2(worldB.get(sB, Position), 150, 150));

  // A edits S's POSITION (the SAME cell B is dragging) → B's drag protection DROPS it (committer-wins pending).
  docA.transaction((tx) => tx.edit(sA).set(Position, { x: 999, y: 999 }));
  worldA.sync();
  worldB.sync();
  check("B's drag protection dropped A's concurrent Position (held off)", sB !== undefined && eq2(worldB.get(sB, Position), 150, 150));

  // B commits the drag → its Position wins committer-wins (later than A's), both converge.
  if (sB !== undefined) docB.transaction((tx) => tx.edit(sB).set(Position, { x: 200, y: 200 }));
  worldB.sync(); // B's own echo (agrees, no strand)
  worldA.sync(); // A drains B's committed Position
  check("A converged to B's committed drag position (committer-wins)", eq2(worldA.get(sA, Position), 200, 200));
  check("B settled at its committed drag position", sB !== undefined && eq2(worldB.get(sB, Position), 200, 200));
  check("Fill converged red on A too (component-granular)", worldA.get(sA, Fill)?.r === 255);

  // --- delete: A deletes a seeded shape → B converges (entity gone) ----------------------------------
  const delKey = keys[0];
  docA.transaction((tx) => tx.destroy(seeded[0]));
  worldA.sync();
  worldB.sync();
  check("B converged on A's delete (shape gone)", delKey !== undefined && docB.resolve(delKey) === undefined);

  // --- presence: B's ephemeral cursor projects on A (Not(Local)); leave() despawns it ---------------
  // A second inbound source per world (the ephemeral binding beside the durable one) — they share no
  // keyspace, so worldX.sync() drains both. The ephemeral outbound is timer-driven in the app; the test
  // pumps the throttle path by hand (encodeChanged → apply → sync) so it stays synchronous/deterministic.
  const loroA = new LoroEphemeralStore(5000);
  const loroB = new LoroEphemeralStore(5000);
  const ephSrcA = new LoroEphemeralSnapshot(loroA);
  const ephSrcB = new LoroEphemeralSnapshot(loroB);
  const ephA = createEphemeralStore(ephSrcA, { peerId: "A", send: (b) => ephSrcB.apply(b), throttleMs: 8, ttlMs: 5000 });
  const ephB = createEphemeralStore(ephSrcB, { peerId: "B", send: (b) => ephSrcA.apply(b), throttleMs: 8, ttlMs: 5000 });
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
  // The throttle path: coalesced changes + any despawn tombstones, then A drains.
  const flushBtoA = (): void => {
    const changed = ephSrcB.encodeChanged();
    if (changed !== null) ephSrcA.apply(changed);
    for (const del of ephSrcB.encodeDeletes()) ephSrcA.apply(del);
    worldA.sync();
  };
  // Two distinct-value sends of ONE key must land ≥1ms apart for Loro's wall-clock LWW to order them
  // (M0 finding 2) — the app's 33ms throttle guarantees it; the synchronous test spins to force it.
  const spin2ms = (): void => {
    const t0 = performance.now();
    while (performance.now() - t0 < 2) {
      /* burn a wall-clock ms so the next same-key send carries a distinct timestamp */
    }
  };

  // Both peers spawn a presence entity; only B's should project onto A (A's own carries Local).
  ephA.spawn({ components: [[CursorPos, { x: 0, y: 0 }], [PresenceInfo, { name: "ada", color: "hsl(200 70% 60%)" }]] });
  const bCursor = ephB.spawn({ components: [[CursorPos, { x: 120, y: 80 }], [PresenceInfo, { name: "bo", color: "hsl(20 70% 60%)" }]] });
  worldA.sync(); // project A's own (Local) — it must NOT count as a remote peer
  check("A's own presence is excluded by Not(Local)", remoteCountOnA() === 0);
  flushBtoA();
  check("B's presence projected onto A as a remote peer", remoteCountOnA() === 1);
  const bOnA = remoteOnA();
  check("A sees B's cursor position", bOnA !== undefined && eq2(worldA.get(bOnA, CursorPos), 120, 80));

  spin2ms();
  ephB.edit(bCursor).set(CursorPos, { x: 240, y: 200 });
  flushBtoA();
  check("A sees B's cursor move through the loopback", bOnA !== undefined && eq2(worldA.get(bOnA, CursorPos), 240, 200));

  // SelectionRef facet APPEARS (membership-as-signal): B selects one of A's seeded shapes.
  spin2ms();
  if (keys[0] !== undefined) ephB.addComponent(bCursor, SelectionRef, { targetKey: keys[0] });
  flushBtoA();
  check("B's SelectionRef facet appeared on A", bOnA !== undefined && worldA.get(bOnA, SelectionRef)?.targetKey === keys[0]);

  // SelectionRef facet DISAPPEARS (B deselects).
  spin2ms();
  ephB.removeComponent(bCursor, SelectionRef);
  flushBtoA();
  check("B's SelectionRef facet removed on A", bOnA !== undefined && worldA.get(bOnA, SelectionRef) === undefined);

  // leave() — B departs: its tombstone (shipped via send → ephSrcA) despawns B on A now, not on TTL.
  spin2ms();
  ephB.leave();
  worldA.sync();
  check("A despawned B's presence after leave()", remoteCountOnA() === 0);

  attEphA.detach();
  attEphB.detach();
  loroA.destroy();
  loroB.destroy();

  // --- teardown + tally -----------------------------------------------------------------------------
  wireA.dispose();
  wireB.dispose();
  const passed = checks.filter((c) => c.ok).length;
  const firstFail = checks.find((c) => !c.ok);
  if (passed === checks.length) {
    return `collab-smoke: PASS ${passed}/${checks.length} — bootstrap · create · drag-vs-remote-edit · delete · presence all converged`;
  }
  const dbg = `A.rt=${JSON.stringify(worldA.get(sA, Position))} A.doc=${JSON.stringify(docA.getComponent(sA, Position))} B.rt=${sB ? JSON.stringify(worldB.get(sB, Position)) : "?"} B.doc=${sB ? JSON.stringify(docB.getComponent(sB, Position)) : "?"} status=${JSON.stringify(statusLog)}`;
  return `collab-smoke: FAIL ${passed}/${checks.length} — first failure: ${firstFail?.label} [${dbg}]`;
}

/**
 * Make two REMOTE cursors visible in the running app for the headless PASS screenshot (the D2 two-cursor
 * frame's foundation). Attaches a real ephemeral store to the app's world — so the app projects presence
 * through the SAME `[CursorPos, PresenceInfo, Not(Local)]` path a real second tab would — and drives two
 * throwaway peers' cursors into it. The app's own frame-loop `world.sync()` projects them and the overlay
 * draws the labeled cursors next frame; they persist (60s TTL) for the screenshot. Renders NOTHING in the
 * durable document — this is purely the presence-rendering demo, independent of the correctness self-test.
 */
export function injectDemoCursors(): void {
  const viewerSrc = new LoroEphemeralSnapshot(new LoroEphemeralStore(60_000));
  const viewer = createEphemeralStore(viewerSrc, { peerId: "viewer", send: () => {}, ttlMs: 60_000 });
  attachEphemeral(appWorld, viewer); // the app world now projects remote presence (real path)

  const pushCursor = (peerId: string, wx: number, wy: number): void => {
    const peerWorld = createWorld({ name: `demo-peer-${peerId}` });
    const src = new LoroEphemeralSnapshot(new LoroEphemeralStore(60_000));
    const eph = createEphemeralStore(src, { peerId, send: () => {}, ttlMs: 60_000 });
    attachEphemeral(peerWorld, eph);
    const { name, color } = presenceIdentity(peerId);
    eph.spawn({ components: [[CursorPos, { x: wx, y: wy }], [PresenceInfo, { name, color }]] });
    const bytes = src.encodeChanged();
    if (bytes !== null) viewerSrc.apply(bytes); // the app's next world.sync() projects it → overlay draws it
  };

  // Place two cursors near the view center (world coords) so they land on-screen after the smoke's
  // zoom-to-fit framing of the local board.
  pushCursor("demo-ada", cam.x - 90 / cam.zoom, cam.y - 30 / cam.zoom);
  pushCursor("demo-bo", cam.x + 130 / cam.zoom, cam.y + 70 / cam.zoom);
}

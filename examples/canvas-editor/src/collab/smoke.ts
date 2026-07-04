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
 *
 * NO conflict-handling code appears here — the app writes through `doc.transaction` and reads the
 * runtime; the framework did the converging. PASS/FAIL is reported to the HUD note (the established
 * headless-screenshot pattern — see main.ts `?script=persist`).
 */

import { createWorld, type Entity } from "strata-ecs";
import { attachDurable, createDurableStore, type Mutator } from "strata-ecs/durable";
import { LoroDoc } from "loro-crdt";
import { Fill, Kind, Position, Size, Velocity, ZIndex } from "../ecs/schema";
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

  // --- teardown + tally -----------------------------------------------------------------------------
  wireA.dispose();
  wireB.dispose();
  const passed = checks.filter((c) => c.ok).length;
  const firstFail = checks.find((c) => !c.ok);
  if (passed === checks.length) {
    return `collab-smoke: PASS ${passed}/${checks.length} — bootstrap · create · drag-vs-remote-edit · delete all converged`;
  }
  const dbg = `A.rt=${JSON.stringify(worldA.get(sA, Position))} A.doc=${JSON.stringify(docA.getComponent(sA, Position))} B.rt=${sB ? JSON.stringify(worldB.get(sB, Position)) : "?"} B.doc=${sB ? JSON.stringify(docB.getComponent(sB, Position)) : "?"} status=${JSON.stringify(statusLog)}`;
  return `collab-smoke: FAIL ${passed}/${checks.length} — first failure: ${firstFail?.label} [${dbg}]`;
}

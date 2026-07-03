/**
 * Shared harness for the M4 reconcile convergence property (design.md §13.3–§13.5; docs/plan-part3.md).
 *
 * NOT a test suite (no `.stress.ts`/`.test.ts` suffix, so the runners never collect it) — a helper both
 * `reconcile.test.ts` (a small ci run) and `reconcile.stress.ts` (a wide soak) import. It drives TWO
 * attached worlds through a seeded, interleaved stream of durable ops — `doc.transaction` value commits,
 * `world.edit` runtime drags that ALWAYS end in a commit, periodic full-snapshot exchanges, a `sync()`
 * every op — then quiesces (commit every in-flight drag, exchange + drain both ways to a fixed point)
 * and asserts the whole-system invariant the matrix exists to guarantee: on BOTH peers every cell has
 * `cellEquals(runtime, baseline)`, both docs converged, and `runtime == doc` for every cell.
 *
 * Convergence-robustness choices: the periodic exchange ships FULL SNAPSHOTS (idempotent, no causal gap —
 * so no `PendingImportError` can flake a randomized run), and drag values are integers/`u8`s (exact in
 * f32/u8 columns, so `cellEquals` is never fooled by an f32 round-trip). The wire-increment path is
 * exercised exhaustively by the focused tests instead.
 */

import { LoroDoc } from "loro-crdt";
import { createWorld, defineComponent } from "../../core";
import type { Component, EntityKey, World } from "../../core";
import { cellEquals } from "../../substrate";
import type { ComponentValue } from "../../substrate";
import { createDurableStore, type DurableStore } from "../durable-store";
import { attachDurable, type Attachment } from "../binding";
import { mulberry32, randInt } from "../../core/__stress__/harness";

/** Two components: a DRAGGED one (the conflict path) and a never-dragged one (component independence, §13.4). */
export const HPos = defineComponent("HReconPos", { x: "f32", y: "f32" });
export const HFill = defineComponent("HReconFill", { r: "u8", g: "u8", b: "u8" });

interface Peer {
  store: DurableStore;
  world: World;
  att: Attachment;
  /** entity index → the latest UNCOMMITTED drag value on this peer (a promise to commit, §13.5). */
  drag: Map<number, { x: number; y: number }>;
}

function makePeer(peerId: number): Peer {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  const store = createDurableStore(doc);
  const world = createWorld();
  const att = attachDurable(world, store);
  return { store, world, att, drag: new Map() };
}

const posVal = (rng: () => number): { x: number; y: number } => ({ x: randInt(rng, 1000), y: randInt(rng, 1000) });
const fillVal = (rng: () => number) => ({ r: randInt(rng, 256), g: randInt(rng, 256), b: randInt(rng, 256) });

function readRuntime(peer: Peer, key: EntityKey, comp: Component): ComponentValue | undefined {
  const h = peer.store.resolve(key);
  return h === undefined ? undefined : (peer.world.get(h, comp) as ComponentValue | undefined);
}

/** Apply one random op to `peer` on one of the shared `keys` (no `sync()` here — the caller syncs every op). */
function stepPeer(peer: Peer, keys: EntityKey[], rng: () => number): void {
  const idx = randInt(rng, keys.length);
  const h = peer.store.resolve(keys[idx])!;
  switch (randInt(rng, 4)) {
    case 0: {
      // Start/continue a runtime-only DRAG on HPos (divergence from baseline — remote HPos values drop).
      const v = posVal(rng);
      peer.world.edit(h).set(HPos, v);
      peer.drag.set(idx, v);
      break;
    }
    case 1: {
      // END a drag with a commit if one is in flight (the sanctioned ending, §13.5) — else a fresh commit.
      const inFlight = peer.drag.get(idx);
      const v = inFlight ?? posVal(rng);
      peer.store.transaction((tx) => tx.edit(h).set(HPos, v));
      peer.drag.delete(idx);
      break;
    }
    case 2:
      // A value commit to the NEVER-dragged component — always an agreement path (component independence).
      peer.store.transaction((tx) => tx.edit(h).set(HFill, fillVal(rng)));
      break;
    case 3:
      // A direct HPos commit (may pre-empt a drag on this cell — committer-wins as the later op).
      peer.store.transaction((tx) => tx.edit(h).set(HPos, posVal(rng)));
      peer.drag.delete(idx);
      break;
  }
}

/** Commit every still-in-flight drag so no cell is left diverged at quiescence (the §13.5 promise kept). */
function commitAllDrags(peer: Peer, keys: EntityKey[]): void {
  for (const [idx, v] of peer.drag) {
    const h = peer.store.resolve(keys[idx])!;
    peer.store.transaction((tx) => tx.edit(h).set(HPos, v));
  }
  peer.drag.clear();
}

/**
 * Run one seeded interleaving and assert the whole-system convergence invariant. Throws a descriptive
 * `Error` on any mismatch (so a plain `it(() => runConvergenceProperty(...))` fails with the detail).
 */
export function runConvergenceProperty(opts: { seed: number; ops: number; entities: number }): void {
  const { seed, ops, entities } = opts;
  const rng = mulberry32(seed);
  const a = makePeer(1);
  const b = makePeer(2);

  // Shared base: A creates the entities (HPos + HFill), B bootstraps from A's snapshot, both settle.
  const keys: EntityKey[] = [];
  for (let i = 0; i < entities; i++) {
    const h = a.store.transaction((tx) => tx.spawn({ components: [[HPos, posVal(rng)], [HFill, fillVal(rng)]] }));
    a.world.sync();
    keys.push(a.store.keyOf(h)!);
  }
  b.store.applyRemote(a.store.snapshot.export());
  a.store.applyRemote(b.store.snapshot.export());
  a.world.sync();
  b.world.sync();

  // Idempotent full-snapshot exchange both ways (no causal gap → no PendingImportError under fuzzing).
  const exchange = (): void => {
    b.store.applyRemote(a.store.snapshot.export());
    a.store.applyRemote(b.store.snapshot.export());
  };

  const k = 3; // exchange every k ops
  for (let step = 0; step < ops; step++) {
    stepPeer(a, keys, rng);
    stepPeer(b, keys, rng);
    a.world.sync(); // sync every op — a mid-drag remote drops + holds, a settled cell agrees
    b.world.sync();
    if (step % k === 0) exchange();
  }

  // Quiesce: end every in-flight drag with a commit, then exchange + drain to a fixed point.
  commitAllDrags(a, keys);
  commitAllDrags(b, keys);
  a.world.sync();
  b.world.sync();
  for (let i = 0; i < 6; i++) {
    exchange();
    a.world.sync();
    b.world.sync();
  }

  // Assert the whole-system invariant on every cell of both peers.
  for (const key of keys) {
    for (const comp of [HPos, HFill] as const) {
      const ra = readRuntime(a, key, comp);
      const rb = readRuntime(b, key, comp);
      const docA = a.store.snapshot.getComponent(key, comp);
      const docB = b.store.snapshot.getComponent(key, comp);
      const fail = (why: string): never => {
        throw new Error(
          `convergence[seed=${seed}] ${comp.name}@${key} ${why}: ` +
            `rtA=${JSON.stringify(ra)} rtB=${JSON.stringify(rb)} docA=${JSON.stringify(docA)} docB=${JSON.stringify(docB)}`,
        );
      };
      if (!cellEquals(ra, a.att.baseline.getComponent(key, comp))) fail("runtimeA != baselineA (a diverged cell)");
      if (!cellEquals(rb, b.att.baseline.getComponent(key, comp))) fail("runtimeB != baselineB (a diverged cell)");
      if (!cellEquals(docA as ComponentValue, docB as ComponentValue)) fail("docA != docB (docs did not converge)");
      if (!cellEquals(ra, docA as ComponentValue)) fail("runtimeA != docA");
      if (!cellEquals(rb, docB as ComponentValue)) fail("runtimeB != docB");
    }
  }

  a.att.detach();
  b.att.detach();
}

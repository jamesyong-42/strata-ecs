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
import { createWorld, defineComponent, defineRelation } from "../../core";
import type { Component, Entity, EntityKey, OrderPlace, World } from "../../core";
import { cellEquals } from "../../substrate";
import type { ComponentValue } from "../../substrate";
import { createDurableStore, type DurableStore } from "../durable-store";
import { attachDurable, type Attachment } from "../binding";
import { mulberry32, randInt } from "../../core/__stress__/harness";

/** Two components: a DRAGGED one (the conflict path) and a never-dragged one (component independence, §13.4). */
export const HPos = defineComponent("HReconPos", { x: "f32", y: "f32" });
export const HFill = defineComponent("HReconFill", { r: "u8", g: "u8", b: "u8" });
/** Ordered arity-one relation (plan-ordered-relations M4 fuzz): entities stack under two shared
 *  parents; ops reparent/place/move/remove concurrently. The oracle asserts INVARIANTS — identical
 *  effective order across peers + edge authority — never exact order (loro owns concurrent-move
 *  outcomes; the M0 probe pins those). */
export const HStack = defineRelation("HReconStack", { arity: "one", ordered: true });

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

/** A random OrderPlace: first/last or an anchor drawn from the shared key pool (which may be a
 *  non-sibling or dead — the documented degrade-to-last race, exercised on purpose). */
function randPlace(peer: Peer, keys: EntityKey[], rng: () => number): OrderPlace {
  switch (randInt(rng, 4)) {
    case 0:
      return "first";
    case 1:
      return "last";
    default: {
      const anchor = peer.store.resolve(keys[randInt(rng, keys.length)]);
      if (anchor === undefined) return "last";
      return randInt(rng, 2) === 0 ? { before: anchor } : { after: anchor };
    }
  }
}

/** Apply one random op to `peer` on one of the shared `keys` (no `sync()` here — the caller syncs every op). */
function stepPeer(peer: Peer, keys: EntityKey[], parents: EntityKey[], rng: () => number): void {
  const idx = randInt(rng, keys.length);
  const key = keys[idx];
  const h = peer.store.resolve(key);
  // The entity may be DESTROYED on this peer (a remote/own destroy landed) — skip; a partial-cell
  // resurrection can revive it later, at which point resolve() binds again (the M4R structural-echo path).
  if (h === undefined) {
    peer.drag.delete(idx);
    return;
  }
  const hasHPos = peer.att.baseline.getComponent(key, HPos) !== undefined;
  const hasHFill = peer.att.baseline.getComponent(key, HFill) !== undefined;
  switch (randInt(rng, 10)) {
    case 0: {
      // Start/continue a runtime-only DRAG on HPos (divergence from baseline — remote HPos values drop).
      if (!hasHPos) return; // HPos was removed by a destroy/partial-resurrection — nothing to drag
      const v = posVal(rng);
      peer.world.edit(h).set(HPos, v);
      peer.drag.set(idx, v);
      break;
    }
    case 1: {
      // END a drag with a commit if one is in flight (the sanctioned ending, §13.5) — else a fresh commit.
      if (!hasHPos) return void peer.drag.delete(idx);
      const inFlight = peer.drag.get(idx);
      const v = inFlight ?? posVal(rng);
      peer.store.transaction((tx) => tx.edit(h).set(HPos, v));
      peer.drag.delete(idx);
      break;
    }
    case 2:
      // A value commit to HFill (agreement path when present — component independence, §13.4).
      if (!hasHFill) return;
      peer.store.transaction((tx) => tx.edit(h).set(HFill, fillVal(rng)));
      break;
    case 3:
      // A direct HPos commit (may pre-empt a drag on this cell — committer-wins as the later op).
      if (!hasHPos) return;
      peer.store.transaction((tx) => tx.edit(h).set(HPos, posVal(rng)));
      peer.drag.delete(idx);
      break;
    case 4:
      // STRUCTURAL add: re-introduce HFill when absent (concurrent add-vs-add → LWW winner, fix 1).
      if (hasHFill) return;
      peer.store.transaction((tx) => tx.addComponent(h, HFill, fillVal(rng)));
      break;
    case 5:
      // STRUCTURAL remove of HFill (keeps HPos so the entity stays alive; own remove-echo re-read, fix 2a).
      if (!hasHFill) return;
      peer.store.transaction((tx) => tx.removeComponent(h, HFill));
      break;
    case 6:
      // STRUCTURAL despawn (whole entity; own/remote despawn survival re-read, fix 2b + the remote extension).
      peer.store.transaction((tx) => tx.destroy(h));
      peer.drag.delete(idx);
      break;
    case 7: {
      // ORDERED placed set / reparent (plan-ordered-relations M4): stack this entity under a random
      // parent at a random place. Concurrent same-child reparents + racing anchors on purpose.
      const parent = peer.store.resolve(parents[randInt(rng, parents.length)]);
      if (parent === undefined || parent === h) return;
      const place = randPlace(peer, keys, rng);
      peer.store.transaction((tx) => tx.setRelation(h, HStack, parent, place));
      break;
    }
    case 8: {
      // ORDERED move-in-place (no-edge is a legal no-op — the race rule).
      const place = randPlace(peer, keys, rng);
      peer.store.transaction((tx) => tx.moveRelation(h, HStack, place));
      break;
    }
    case 9:
      // ORDERED edge remove (splices the sequence entry with the edge).
      peer.store.transaction((tx) => tx.removeRelation(h, HStack));
      break;
  }
}

/** Commit every still-in-flight drag so no cell is left diverged at quiescence (the §13.5 promise kept). */
function commitAllDrags(peer: Peer, keys: EntityKey[]): void {
  for (const [idx, v] of peer.drag) {
    const key = keys[idx];
    const h = peer.store.resolve(key);
    // Skip a drag whose cell no longer exists (the entity/component was removed structurally) — the cell is
    // gone on both sides, so there is nothing left to reconverge; committing would throw (absent component).
    if (h !== undefined && peer.att.baseline.getComponent(key, HPos) !== undefined) {
      peer.store.transaction((tx) => tx.edit(h).set(HPos, v));
    }
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

  // Shared base: A creates the entities (HPos + HFill) plus TWO stack parents (never destroyed —
  // ordered ops target them; children churn freely), B bootstraps from A's snapshot, both settle.
  const keys: EntityKey[] = [];
  for (let i = 0; i < entities; i++) {
    const h = a.store.transaction((tx) => tx.spawn({ components: [[HPos, posVal(rng)], [HFill, fillVal(rng)]] }));
    a.world.sync();
    keys.push(a.store.keyOf(h)!);
  }
  const parents: EntityKey[] = [];
  for (let i = 0; i < 2; i++) {
    const h = a.store.transaction((tx) => tx.spawn({ components: [[HPos, posVal(rng)]] }));
    a.world.sync();
    parents.push(a.store.keyOf(h)!);
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
    stepPeer(a, keys, parents, rng);
    stepPeer(b, keys, parents, rng);
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

  // ORDER INVARIANTS (plan-ordered-relations §4.4.8 — the fuzz asserts invariants, never exact
  // order): for each stack parent, (1) both peers read the IDENTICAL effective child order;
  // (2) EDGE AUTHORITY — every entry is a child per the converged DOC, and every doc-child
  // appears exactly once (permutation, no loss, no duplicate); (3) both docs agree.
  for (const pk of parents) {
    const orderOf = (peer: Peer): EntityKey[] | undefined => {
      const ph = peer.store.resolve(pk);
      if (ph === undefined) return undefined;
      return peer.world.getReverse(ph, HStack).map((c: Entity) => peer.store.keyOf(c)!);
    };
    const oa = orderOf(a);
    const ob = orderOf(b);
    const docChildrenOf = (peer: Peer): EntityKey[] =>
      keys.filter((ck) => peer.store.snapshot.getRelationOne(ck, HStack) === pk);
    const da = docChildrenOf(a).sort();
    const db = docChildrenOf(b).sort();
    const fail = (why: string): never => {
      throw new Error(
        `order-convergence[seed=${seed}] parent=${pk} ${why}: A=${JSON.stringify(oa)} B=${JSON.stringify(ob)} docA=${JSON.stringify(da)} docB=${JSON.stringify(db)}`,
      );
    };
    if (JSON.stringify(da) !== JSON.stringify(db)) fail("doc membership diverged");
    if (JSON.stringify(oa) !== JSON.stringify(ob)) fail("effective order diverged");
    if (oa !== undefined && JSON.stringify([...oa].sort()) !== JSON.stringify(da)) {
      fail("runtime order is not a permutation of the doc's children (edge authority broken)");
    }
  }

  a.att.detach();
  b.att.detach();
}

/**
 * Ordered relations through the Loro adapter — M3 (plan-ordered-relations §4).
 *
 * End-to-end coverage of the durable order protocol: the `relO:` MovableList encoding, the
 * fourth translation bucket (pure reorders arrive as payload-free order facts), the D7 projection
 * against the CONVERGED doc (the M2 wiring rule), the liveness carve-out (emptied lists are not
 * existence), the despawn-time prune, native-move convergence across two real stores, tx
 * placement/move sealing, undo, and hostile input.
 *
 * Two-store scenarios exchange REAL bytes — outbound increments captured via `subscribeOutbound`
 * (the transport seam), remote import via `store.applyRemote`, drain via `world.sync()`. World
 * assertions read `getReverse` (sibling order IS the contract) and observeQuery wakes (the ICE
 * repaint path).
 */

import { describe, expect, it } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import {
  Related,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
} from "../core";
import type { Entity, EntityKey, World } from "../core";
import { createDurableStore } from "./durable-store";
import { attachDurable } from "./binding";

const MPos = defineComponent("M3Pos", { x: "f32" });
const MStack = defineRelation("M3Stack", { arity: "one", ordered: true });
const relQ = defineQuery([Related(MStack)]);

interface Rig {
  world: World;
  store: ReturnType<typeof createDurableStore>;
  outbound: Uint8Array[];
}

function rig(peerId: number): Rig {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  const store = createDurableStore(doc);
  const world = createWorld();
  attachDurable(world, store);
  const outbound: Uint8Array[] = [];
  store.subscribeOutbound((bytes) => outbound.push(bytes));
  return { world, store, outbound };
}

/** Ship every queued outbound increment from → to, then drain to's world. */
function ship(from: Rig, to: Rig): void {
  for (const bytes of from.outbound.splice(0)) to.store.applyRemote(bytes);
  to.world.sync();
}

/** A parent + n children through ONE tx (children x = 0..n-1); drains the local echo. */
function seedFamily(r: Rig, n: number): { parent: Entity; kids: Entity[] } {
  let parent!: Entity;
  const kids: Entity[] = [];
  r.store.transaction((tx) => {
    parent = tx.spawn({ components: [[MPos, { x: -1 }]] });
    for (let i = 0; i < n; i++) {
      const c = tx.spawn({ components: [[MPos, { x: i }]] });
      tx.setRelation(c, MStack, parent);
      kids.push(c);
    }
  });
  r.world.sync();
  return { parent, kids };
}

/** BIDIRECTIONAL bootstrap (006 C7 item 5 — normative for any transport): the joiner imports the
 *  seeder's snapshot, AND the seeder absorbs the joiner's base — else the joiner's first increment
 *  references its own construction (docId) commit the seeder lacks → PendingImportError. */
function bootstrap(from: Rig, to: Rig): void {
  from.outbound.splice(0); // the snapshot carries everything queued so far
  to.store.applyRemote(from.store.exportSnapshot());
  to.world.sync();
  to.outbound.splice(0);
  from.store.applyRemote(to.store.exportSnapshot());
  from.world.sync();
}

/** The same entity on another rig, via the cross-store key. */
function twin(of: Entity, from: Rig, on: Rig): Entity {
  const key = from.store.keyOf(of);
  expect(key).toBeDefined();
  const h = on.store.resolve(key as EntityKey);
  expect(h).toBeDefined();
  return h as Entity;
}

/** Sibling order of `parent` as x-values (readable assertions). */
function orderX(world: World, parent: Entity): number[] {
  return world.getReverse(parent, MStack).map((e) => world.readField(e, MPos, "x") as number);
}

describe("M3 — tx placement seals to the doc and round-trips", () => {
  it("tx.setRelation with place + tx.moveRelation land converged order on a fresh joiner", () => {
    const a = rig(101);
    const { parent, kids } = seedFamily(a, 4); // [0,1,2,3]
    a.store.transaction((tx) => {
      tx.moveRelation(kids[3]!, MStack, "first"); // [3,0,1,2]
      tx.setRelation(kids[0]!, MStack, parent, { after: kids[2]! }); // [3,1,2,0]
    });
    a.world.sync();
    expect(orderX(a.world, parent)).toEqual([3, 1, 2, 0]);

    const b = rig(102);
    bootstrap(a, b);
    expect(orderX(b.world, twin(parent, a, b))).toEqual([3, 1, 2, 0]);
  });

  it("a REMOTE pure reorder arrives as an order fact, applies, and wakes an observeQuery naming the relation", () => {
    const a = rig(103);
    const b = rig(104);
    const { parent, kids } = seedFamily(a, 3); // [0,1,2]
    bootstrap(a, b);
    const bParent = twin(parent, a, b);
    expect(orderX(b.world, bParent)).toEqual([0, 1, 2]);

    let fires = 0;
    b.world.reactive.observeQuery(relQ, () => {
      fires++;
    });
    b.world.reactive.notify();
    const base = fires;

    a.store.transaction((tx) => tx.moveRelation(kids[2]!, MStack, "first")); // PURE reorder — no cell facts
    ship(a, b);
    b.world.reactive.notify();

    expect(orderX(b.world, bParent)).toEqual([2, 0, 1]);
    expect(fires).toBeGreaterThan(base); // the ICE repaint path (rev-m2 finding 1), end-to-end
  });

  it("concurrent moves on two peers converge identically with no duplicate and no loss (native move)", () => {
    const a = rig(105);
    const b = rig(106);
    const { parent, kids } = seedFamily(a, 3);
    bootstrap(a, b);
    const bParent = twin(parent, a, b);
    const bKid0 = twin(kids[0]!, a, b);
    const bKid1 = twin(kids[1]!, a, b);

    a.store.transaction((tx) => tx.moveRelation(kids[0]!, MStack, "last"));
    b.store.transaction((tx) => tx.moveRelation(bKid0, MStack, { after: bKid1 }));
    // Cross-ship the two concurrent increments.
    const aBytes = a.outbound.splice(0);
    const bBytes = b.outbound.splice(0);
    for (const x of aBytes) b.store.applyRemote(x);
    for (const x of bBytes) a.store.applyRemote(x);
    a.world.sync();
    b.world.sync();

    const aOrder = orderX(a.world, parent);
    const bOrder = orderX(b.world, bParent);
    expect(aOrder).toEqual(bOrder); // converged (the exact winner is loro's — M0-pinned semantics)
    expect([...aOrder].sort()).toEqual([0, 1, 2]); // native move: never duplicated, never lost
  });
});

describe("M3 — liveness carve-out and prune", () => {
  it("a despawned parent (emptied relO: list kept) reads ABSENT on every predicate, incl. a fresh joiner", () => {
    const a = rig(107);
    const { parent, kids } = seedFamily(a, 2);
    const parentKey = a.store.keyOf(parent) as EntityKey;
    a.store.transaction((tx) => {
      for (const c of kids) tx.destroy(c);
      tx.destroy(parent);
    });
    a.world.sync();
    expect(a.store.snapshot.hasEntity(parentKey)).toBe(false);
    expect(a.store.snapshot.readEntity(parentKey)).toBeUndefined();
    expect([...a.store.snapshot.entities()]).not.toContain(parentKey);

    const freshDoc = new LoroDoc();
    freshDoc.setPeerId(108);
    const fresh = createDurableStore(freshDoc);
    fresh.applyRemote(a.store.exportSnapshot());
    expect(fresh.snapshot.hasEntity(parentKey)).toBe(false); // the resurrection hole is closed
  });

  it("despawning a child prunes its entry from the parent's relO: list in the SAME commit", () => {
    const a = rig(109);
    const { parent, kids } = seedFamily(a, 3);
    const parentKey = a.store.keyOf(parent) as EntityKey;
    const deadKey = a.store.keyOf(kids[1]!) as EntityKey;
    a.store.transaction((tx) => tx.destroy(kids[1]!));
    a.world.sync();
    const raw = a.store.snapshot.readOrder(parentKey, MStack);
    expect(raw).toBeDefined();
    expect(raw).not.toContain(deadKey); // pruned at despawn, not merely filtered at read
    expect(orderX(a.world, parent)).toEqual([0, 2]);
  });
});

describe("M3 — undo through the store", () => {
  it("undo of a pure move restores the previous order; redo re-applies it", () => {
    const a = rig(110);
    const { parent, kids } = seedFamily(a, 3); // [0,1,2]
    a.store.transaction((tx) => tx.moveRelation(kids[2]!, MStack, "first")); // [2,0,1]
    a.world.sync();
    expect(orderX(a.world, parent)).toEqual([2, 0, 1]);
    expect(a.store.undo()).toBe(true);
    a.world.sync();
    expect(orderX(a.world, parent)).toEqual([0, 1, 2]);
    expect(a.store.redo()).toBe(true);
    a.world.sync();
    expect(orderX(a.world, parent)).toEqual([2, 0, 1]);
  });

  it("undo of a reparent tx reverts edge AND both sequences atomically", () => {
    const a = rig(111);
    const { parent: p1, kids } = seedFamily(a, 2); // p1: [0,1]
    let p2!: Entity;
    a.store.transaction((tx) => {
      p2 = tx.spawn({ components: [[MPos, { x: -2 }]] });
    });
    a.world.sync();
    a.store.transaction((tx) => tx.setRelation(kids[0]!, MStack, p2, "first")); // reparent 0 → p2
    a.world.sync();
    expect(orderX(a.world, p1)).toEqual([1]);
    expect(orderX(a.world, p2)).toEqual([0]);
    expect(a.store.undo()).toBe(true);
    a.world.sync();
    expect(orderX(a.world, p1)).toEqual([0, 1]); // back where it was, IN PLACE
    expect(orderX(a.world, p2)).toEqual([]);
  });
});

describe("M3 — hostile input and boundary math", () => {
  it("a hostile plain value at a relO: key: readOrder undefined, D7 completion order, no throw anywhere", () => {
    const a = rig(112);
    const { parent } = seedFamily(a, 3);
    const parentKey = a.store.keyOf(parent) as EntityKey;
    const hostile = new LoroDoc();
    hostile.setPeerId(999);
    hostile.import(a.store.exportSnapshot());
    (hostile.getMap("entities").get(parentKey) as LoroMap).set("relO:M3Stack", "junk");
    hostile.commit();
    a.store.applyRemote(hostile.export({ mode: "update" }));
    a.world.sync();
    expect(a.store.snapshot.readOrder(parentKey, MStack)).toBeUndefined(); // poisoned → no sequence
    const got = orderX(a.world, parent);
    expect(got.length).toBe(3); // membership untouched
    expect([...got].sort((x, y) => x - y)).toEqual([0, 1, 2]); // deterministic completion order
  });

  it("a dead parent with a POPULATED list (despawn raced a concurrent move) is inert on a fresh joiner", () => {
    const a = rig(115);
    const b = rig(116);
    const { parent, kids } = seedFamily(a, 2);
    bootstrap(a, b);
    const bKid0 = twin(kids[0]!, a, b);
    // Concurrent: A despawns the parent (clears the list); B moves kid0 (M0: the MOVED entry
    // survives the merge) → converged doc holds a NON-EMPTY list on a dead parent.
    a.store.transaction((tx) => tx.destroy(parent));
    b.store.transaction((tx) => tx.moveRelation(bKid0, MStack, "first"));
    for (const x of a.outbound.splice(0)) b.store.applyRemote(x);
    for (const x of b.outbound.splice(0)) a.store.applyRemote(x);
    a.world.sync();
    b.world.sync();

    // Fresh joiner: translateConverged emits an order fact for a NEVER-PROJECTED parent — must be
    // inert (no phantom identity, no throw; the regression magnet if applyOrder ever mints).
    const cDoc = new LoroDoc();
    cDoc.setPeerId(117);
    const cStore = createDurableStore(cDoc);
    const cWorld = createWorld();
    attachDurable(cWorld, cStore);
    cStore.applyRemote(a.store.exportSnapshot());
    cWorld.sync();
    const parentKey = a.store.keyOf(parent);
    expect(parentKey).toBeUndefined(); // A already tore it down — recover the key from the doc side
    const deadKeys = [...a.store.snapshot.entities()];
    expect(cStore.snapshot.hasEntity(a.store.keyOf(kids[0]!) as EntityKey)).toBe(true);
    expect(deadKeys.length).toBe(2); // both kids alive, parent absent, everywhere
    expect([...cStore.snapshot.entities()].sort()).toEqual(deadKeys.sort());
  });

  it("undoing a mutation whose commit pruned stale junk RE-ASSERTS the junk — and D7 keeps filtering it", () => {
    const a = rig(118);
    const { parent, kids } = seedFamily(a, 3); // [0,1,2]
    const parentKey = a.store.keyOf(parent) as EntityKey;
    // Hostile junk lands in the raw list.
    const hostile = new LoroDoc();
    hostile.setPeerId(998);
    hostile.import(a.store.exportSnapshot());
    const hList = (hostile.getMap("entities").get(parentKey) as LoroMap).get("relO:M3Stack");
    (hList as import("loro-crdt").LoroMovableList).insert(0, "zz-junk");
    hostile.commit();
    a.store.applyRemote(hostile.export({ mode: "update" }));
    a.world.sync();
    expect(a.store.snapshot.readOrder(parentKey, MStack)).toContain("zz-junk");

    // A local move PRUNES the junk in the same commit…
    a.store.transaction((tx) => tx.moveRelation(kids[0]!, MStack, "last"));
    a.world.sync();
    expect(a.store.snapshot.readOrder(parentKey, MStack)).not.toContain("zz-junk");
    // …and undoing the move re-asserts it (same undo step). Harmless: D7 filters on read.
    expect(a.store.undo()).toBe(true);
    a.world.sync();
    expect(a.store.snapshot.readOrder(parentKey, MStack)).toContain("zz-junk"); // raw: back
    expect(orderX(a.world, parent)).toEqual([0, 1, 2]); // runtime: move undone, junk invisible
  });

  it("a hostile ROOT MovableList translates to zero events without throwing", () => {
    const a = rig(119);
    const { parent } = seedFamily(a, 2);
    const before = orderX(a.world, parent);
    const hostile = new LoroDoc();
    hostile.setPeerId(997);
    hostile.import(a.store.exportSnapshot());
    hostile.getMovableList("free-floating-junk").insert(0, "x");
    hostile.commit();
    expect(() => a.store.applyRemote(hostile.export({ mode: "update" }))).not.toThrow();
    a.world.sync();
    expect(orderX(a.world, parent)).toEqual(before); // nothing moved, nothing projected
  });

  it("multi-commit remote import with list ops splits batches correctly (the counter-span fix)", () => {
    const a = rig(113);
    const b = rig(114);
    const { parent, kids } = seedFamily(a, 3);
    bootstrap(a, b);
    // Three commits: list-heavy, map-only, mixed — the old ops.length span under-counted the first
    // commit's frontier and mis-batched everything after it (corrupt diffs / lost facts).
    a.store.transaction((tx) => {
      tx.moveRelation(kids[0]!, MStack, "last");
      tx.moveRelation(kids[2]!, MStack, "first");
    });
    a.store.transaction((tx) => tx.edit(kids[1]!).set(MPos, { x: 42 }));
    a.store.transaction((tx) => {
      tx.setRelation(kids[1]!, MStack, parent, "first");
      tx.edit(kids[0]!).set(MPos, { x: 7 });
    });
    a.world.sync(); // drain A's own echoes — relation structure rides projection, not the recorder
    ship(a, b);
    const bParent = twin(parent, a, b);
    expect(orderX(b.world, bParent)).toEqual(orderX(a.world, parent)); // identical converged order
    expect(b.world.readField(twin(kids[1]!, a, b), MPos, "x")).toBe(42); // the map-only commit survived
    expect(b.world.readField(twin(kids[0]!, a, b), MPos, "x")).toBe(7); // and the mixed one
  });
});

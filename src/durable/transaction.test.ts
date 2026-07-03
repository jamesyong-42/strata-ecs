/**
 * The transaction — Part III **M3** (docs/plan-part3.md; design.md §11.2, §12, §13.2; 006 A1/C4).
 *
 * Drives a real `World` + attached `DurableStore` (the binding's sync/notify flow, template:
 * binding.test.ts). Coverage:
 *   - preconditions: `doc.transaction` on an unattached store throws; nested transaction throws;
 *   - the §12.3 visibility table row by row — `tx.spawn` handle usable-but-not-queryable until
 *     `sync()`; `edit().set` on a pre-existing component runtime-readable IMMEDIATELY and same-tick
 *     visible to a later system; addComponent/removeComponent/despawn visible after `sync()`;
 *   - the fold (§12.2): spawn + addComponent + edit().set same-tx → doc holds the folded value, ONE
 *     component-set per cell in the sealed echo, no double-write, runtime never hits a missing column;
 *   - the agreement point (§13.2): a value write to a pre-existing component agrees across runtime,
 *     doc, and baseline immediately (the 0.1-f32 canonical regression), and the own-echo is a no-op;
 *   - rollback (§12.3): a throw after spawns + addComponent commits NOTHING and leaves the handles
 *     dead + keys burned; a precondition violation rolls back identically and names the offending op;
 *   - durability gates (§11.2): addComponent / setRelation naming a runtime-only handle throw;
 *   - the full loop: two attached stores exchanging bytes converge (spawn + relation + edit), and
 *     committer-wins on a concurrent same-component edit (observeQuery lights up);
 *   - 006 C4: an in-system value commit to an undeclared component DEV-throws once armed; declaring
 *     `access.write` passes.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineSystem,
  defineTag,
  phase,
} from "../core";
import type { Entity, EntityKey } from "../core";
import { cellEquals } from "../substrate";
import type { ChangeBatch, ChangeEvent } from "../substrate";
import { createDurableStore } from "./durable-store";
import { attachDurable } from "./binding";

const TXPos = defineComponent("TXPos", { x: "f32", y: "f32" });
const TXFill = defineComponent("TXFill", { r: "u8", g: "u8", b: "u8" });
const TXSize = defineComponent("TXSize", { w: "f32", h: "f32" });
const TXSel = defineTag("TXSel");
const TXChild = defineRelation("TXChild", { arity: "one" });
const TXLink = defineRelation("TXLink", { arity: "many" });
const TXClock = defineResource("TXClock", { t: "u32" });

const suffixOf = (k: EntityKey): number => Number(String(k).split("-")[1]);

function makeStore(peerId: number): ReturnType<typeof createDurableStore> {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

function matches(w: ReturnType<typeof createWorld>, q: ReturnType<typeof defineQuery>): Entity[] {
  const out: Entity[] = [];
  w.query(q).each((b) => {
    for (const r of b) out.push(b.entity(r));
  });
  return out;
}

/**
 * An attached store with one PRE-EXISTING durable entity holding `TXPos = v`. Seeded through the
 * transaction API and synced, so it is a genuine baseline-present entity AND the store's key counter
 * stays consistent (a later `tx.spawn` never re-mints its key). Returns its handle + minted key.
 */
function attachedWithPos(v: { x: number; y: number }) {
  const store = makeStore(1);
  const w = createWorld();
  const att = attachDurable(w, store);
  const h = store.transaction((tx) => tx.spawn({ components: [[TXPos, v]] }));
  w.sync(); // projection places it + advances the baseline → it is now "pre-existing"
  const key = store.keyOf(h)!;
  return { store, w, att, h, key };
}

const compSetsFor = (batch: ChangeBatch, comp: unknown): Extract<ChangeEvent, { kind: "component-set" }>[] =>
  batch.events.filter((e): e is Extract<ChangeEvent, { kind: "component-set" }> => e.kind === "component-set" && e.comp === comp);

// ---------------------------------------------------------------------------------------------------
describe("preconditions (§12.4)", () => {
  it("doc.transaction on an unattached store throws", () => {
    const store = makeStore(1);
    expect(() => store.transaction((tx) => tx.spawn())).toThrow(/attached/);
  });

  it("a nested doc.transaction throws (one open transaction per store)", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    expect(() =>
      store.transaction(() => {
        store.transaction((tx) => tx.spawn());
      }),
    ).toThrow(/nested/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the §12.3 visibility table", () => {
  it("tx.spawn: handle usable immediately, not queryable/readable until after sync()", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);

    const h = store.transaction((tx) => tx.spawn({ components: [[TXPos, { x: 1, y: 2 }]], tags: [TXSel] }));

    // Usable as a value the instant it returns (identity minted at record time, §12.2).
    expect(w.isAlive(h)).toBe(true);
    expect(store.keyOf(h)).toBeDefined();
    // But NOT placed: not queryable, not runtime-readable, until projection.
    expect(matches(w, defineQuery([TXPos])).length).toBe(0);
    expect(w.get(h, TXPos)).toBeUndefined();

    w.sync(); // projection places it

    expect(matches(w, defineQuery([TXPos]))).toEqual([h]);
    expect(w.read(h, TXPos)).toEqual({ x: 1, y: 2 });
    expect(w.hasTag(h, TXSel)).toBe(true);
  });

  it("tx.edit().set on a pre-existing component is runtime-readable IMMEDIATELY (no sync)", () => {
    const { store, w, h } = attachedWithPos({ x: 1, y: 1 });
    store.transaction((tx) => tx.edit(h).set(TXPos, { x: 9, y: 8 }));
    expect(w.read(h, TXPos)).toEqual({ x: 9, y: 8 }); // synchronous value write (§13.2)
  });

  it("tx.addComponent becomes queryable only after sync()", () => {
    const { store, w, h } = attachedWithPos({ x: 1, y: 1 });
    store.transaction((tx) => tx.addComponent(h, TXFill, { r: 1, g: 2, b: 3 }));
    expect(w.get(h, TXFill)).toBeUndefined(); // structure rides projection
    expect(matches(w, defineQuery([TXFill])).length).toBe(0);
    w.sync();
    expect(w.read(h, TXFill)).toEqual({ r: 1, g: 2, b: 3 });
    expect(matches(w, defineQuery([TXFill]))).toEqual([h]);
  });

  it("tx.removeComponent changes membership only after sync()", () => {
    const { store, w, h } = attachedWithPos({ x: 1, y: 1 });
    store.transaction((tx) => tx.removeComponent(h, TXPos));
    expect(w.has(h, TXPos)).toBe(true); // still present pre-sync
    w.sync();
    expect(w.has(h, TXPos)).toBe(false);
    expect(w.isAlive(h)).toBe(true); // component gone, entity remains
  });

  it("tx.destroy removes the entity only after sync()", () => {
    const { store, w, h, key } = attachedWithPos({ x: 1, y: 1 });
    store.transaction((tx) => tx.destroy(h));
    expect(w.isAlive(h)).toBe(true); // structure rides projection
    w.sync();
    expect(w.isAlive(h)).toBe(false);
    expect(store.resolve(key)).toBeUndefined();
  });

  it("an in-tick tx.edit().set is visible to a LATER system in the same phase (CommitOnSettle shape)", () => {
    const { store, w, h } = attachedWithPos({ x: 5, y: 5 });

    const Committer = defineSystem(defineQuery([TXPos]), (batch) => {
      for (const r of batch) store.transaction((tx) => tx.edit(batch.entity(r)).set(TXPos, { x: 99, y: 99 }));
    });
    let readerSaw = -1;
    const Reader = defineSystem(defineQuery([TXPos]), (batch) => {
      const P = batch.col(TXPos);
      for (const r of batch) readerSaw = (P.x as Float32Array)[r];
    });

    w.tick([phase("p", [Committer, Reader])]); // Committer before Reader in one phase
    expect(readerSaw).toBe(99); // the synchronous commit is same-phase visible
    expect(w.read(h, TXPos)).toEqual({ x: 99, y: 99 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the value fold (§12.2)", () => {
  it("spawn + addComponent + edit().set same-tx: doc holds the folded value, ONE set per cell, no double-write", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);

    const echoes: ChangeBatch[] = [];
    store.snapshot.subscribe((b) => {
      if (b.origin === "local") echoes.push(b);
    });

    const h = store.transaction((tx) => {
      const e = tx.spawn({ components: [[TXSize, { w: 400, h: 300 }]] }); // TXSize introduced by spawn
      tx.addComponent(e, TXPos, { x: 0, y: 0 }); // TXPos introduced by add
      tx.edit(e).set(TXPos, { x: 7, y: 8 }); // folds into the AddComponent payload
      tx.edit(e).set(TXSize, { w: 10, h: 20 }); // folds into the spawn payload
      return e; // completing without throwing proves the runtime never hit a missing TXPos/TXSize column
    });

    // Exactly one sealed commit; exactly one component-set per cell (the fold, not add+write).
    expect(echoes).toHaveLength(1);
    const posSets = compSetsFor(echoes[0], TXPos);
    const sizeSets = compSetsFor(echoes[0], TXSize);
    expect(posSets).toHaveLength(1);
    expect(sizeSets).toHaveLength(1);
    expect(posSets[0].value).toEqual({ x: 7, y: 8 });
    expect(sizeSets[0].value).toEqual({ w: 10, h: 20 });

    // Converged document holds the folded values; runtime reads them after projection.
    expect(store.getComponent(h, TXPos)).toEqual({ x: 7, y: 8 });
    expect(store.getComponent(h, TXSize)).toEqual({ w: 10, h: 20 });
    w.sync();
    expect(w.read(h, TXPos)).toEqual({ x: 7, y: 8 });
    expect(w.read(h, TXSize)).toEqual({ w: 10, h: 20 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the agreement point (§13.2)", () => {
  it("edit().set on pre-existing agrees across runtime + doc + baseline immediately (0.1 f32); own-echo is a no-op", () => {
    const { store, w, att, h, key } = attachedWithPos({ x: 1, y: 1 });

    store.transaction((tx) => tx.edit(h).set(TXPos, { x: 0.1, y: 2 }));

    // Immediate three-way agreement, canonical 0.1-f32 on every side (no sync yet).
    expect(w.read(h, TXPos).x).toBe(Math.fround(0.1));
    expect(cellEquals(w.read(h, TXPos), store.getComponent(h, TXPos))).toBe(true);
    expect(cellEquals(w.read(h, TXPos), att.baseline.getComponent(key, TXPos))).toBe(true);

    // The own-echo at the next sync finds runtime == baseline → no observable change.
    const before = w.read(h, TXPos);
    w.sync();
    expect(w.read(h, TXPos)).toEqual(before);
    expect(cellEquals(w.read(h, TXPos), att.baseline.getComponent(key, TXPos))).toBe(true);
  });

  it("a resource setResource lands on runtime + doc + baseline synchronously", () => {
    const store = makeStore(1);
    const w = createWorld();
    const att = attachDurable(w, store);
    store.transaction((tx) => tx.setResource(TXClock, { t: 42 }));
    expect(w.getResource(TXClock)).toEqual({ t: 42 });
    expect(att.baseline.getResource(TXClock)).toEqual({ t: 42 });
    expect(store.snapshot.getResource(TXClock)).toEqual({ t: 42 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("rollback — atomic authoring + burn (§12.3)", () => {
  it("fn throwing after spawn×2 + addComponent commits nothing; both handles dead; bijection clean; keys burned", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);

    let h1: Entity | undefined;
    let h2: Entity | undefined;
    let k1: EntityKey | undefined;
    let k2: EntityKey | undefined;
    expect(() =>
      store.transaction((tx) => {
        h1 = tx.spawn({ components: [[TXPos, { x: 1, y: 1 }]] });
        k1 = store.keyOf(h1);
        h2 = tx.spawn({ components: [[TXSize, { w: 2, h: 2 }]] });
        k2 = store.keyOf(h2);
        tx.addComponent(h1, TXFill, { r: 1, g: 2, b: 3 });
        throw new Error("boom");
      }),
    ).toThrow(/boom/);

    // Nothing committed — no projection materializes even after a sync.
    w.sync();
    expect(matches(w, defineQuery([TXPos])).length).toBe(0);
    expect(matches(w, defineQuery([TXSize])).length).toBe(0);

    // Both leaked handles are DEAD (generation bumped), bijection unbound.
    expect(w.isAlive(h1!)).toBe(false);
    expect(w.isAlive(h2!)).toBe(false);
    expect(store.keyOf(h1!)).toBeUndefined();
    expect(store.resolve(k1!)).toBeUndefined();
    expect(store.resolve(k2!)).toBeUndefined();

    // Keys are burned: the next successful mint uses a STRICTLY HIGHER suffix, never k1/k2.
    const h3 = store.transaction((tx) => tx.spawn());
    const k3 = store.keyOf(h3)!;
    expect(suffixOf(k3)).toBeGreaterThan(suffixOf(k2!));
  });

  it("a precondition violation (edit on absent) rolls back identically and names the offending op", () => {
    const { store, w, h } = attachedWithPos({ x: 1, y: 1 });
    let leaked: Entity | undefined;
    expect(() =>
      store.transaction((tx) => {
        leaked = tx.spawn();
        tx.edit(h).set(TXFill, { r: 1, g: 2, b: 3 }); // TXFill absent on h → throws at this call
      }),
    ).toThrow(/TXFill/);

    expect(w.isAlive(leaked!)).toBe(false); // the leaked spawn was burned too
    w.sync();
    expect(matches(w, defineQuery([TXFill])).length).toBe(0);
    expect(store.getComponent(h, TXFill)).toBeUndefined();
    expect(w.read(h, TXPos)).toEqual({ x: 1, y: 1 }); // untouched
  });
});

// ---------------------------------------------------------------------------------------------------
describe("durability gates (§11.2)", () => {
  it("tx.addComponent on a runtime-only (world.spawn) handle throws", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    const runtimeOnly = w.spawn({ components: [[TXPos, { x: 0, y: 0 }]] });
    expect(() => store.transaction((tx) => tx.addComponent(runtimeOnly, TXFill, { r: 1, g: 2, b: 3 }))).toThrow(
      /not in this store/,
    );
  });

  it("tx.setRelation with one endpoint runtime-only throws (both endpoints must be in this store)", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    const runtimeOnly = w.spawn({ components: [[TXPos, { x: 0, y: 0 }]] });
    const durable = store.transaction((tx) => tx.spawn());
    expect(() => store.transaction((tx) => tx.setRelation(durable, TXChild, runtimeOnly))).toThrow(/not in this store/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the full loop — two attached stores", () => {
  it("A transacts (spawn frame + setRelation + edit existing); both worlds converge after byte exchange", () => {
    const a = makeStore(1);
    const b = makeStore(2);

    const wA = createWorld();
    const attA = attachDurable(wA, a);
    // Shared base: the child, created through the transaction API (so A's key counter stays consistent).
    const childA = a.transaction((tx) => tx.spawn({ components: [[TXPos, { x: 1, y: 1 }]] }));
    wA.sync();
    const childKey = a.keyOf(childA)!;

    const wB = createWorld();
    const attB = attachDurable(wB, b);
    b.applyRemote(a.snapshot.export()); // B bootstraps from A's causal base (§14.2 / 006 A5.2)
    wB.sync();
    a.subscribeOutbound((bytes) => b.applyRemote(bytes)); // live transport A → B

    const frameA = a.transaction((tx) => {
      const frame = tx.spawn({ components: [[TXSize, { w: 400, h: 300 }]] });
      tx.setRelation(childA, TXChild, frame); // relation from the existing child to the new frame
      tx.addRelation(childA, TXLink, frame); // arity "many" too
      tx.edit(childA).set(TXPos, { x: 5, y: 6 }); // value on a pre-existing component
      return frame;
    });

    // A: the value applied immediately; its own structure projects at the next sync.
    expect(wA.read(childA, TXPos)).toEqual({ x: 5, y: 6 });
    wA.sync();
    expect(wA.getRelation(childA, TXChild)).toBe(frameA);
    expect(cellEquals(wA.read(childA, TXPos), attA.baseline.getComponent(childKey, TXPos))).toBe(true);

    // B: the whole transaction arrived as bytes; draining it shows everything.
    wB.sync();
    const frameKey = a.keyOf(frameA)!;
    const childB = b.resolve(childKey)!;
    const frameB = b.resolve(frameKey)!;
    expect(wB.read(childB, TXPos)).toEqual({ x: 5, y: 6 });
    expect(wB.read(frameB, TXSize)).toEqual({ w: 400, h: 300 });
    expect(wB.getRelation(childB, TXChild)).toBe(frameB);
    expect(wB.getRelations(childB, TXLink)).toEqual([frameB]);
    expect(cellEquals(wB.read(childB, TXPos), attB.baseline.getComponent(childKey, TXPos))).toBe(true);
  });

  it("committer-wins: concurrent edits to the same component converge to ONE whole value; observeQuery lights up", () => {
    const a = makeStore(1);
    const b = makeStore(2);

    const wA = createWorld();
    const attA = attachDurable(wA, a);
    const childA = a.transaction((tx) => tx.spawn({ components: [[TXPos, { x: 0, y: 0 }]] }));
    wA.sync();
    const childKey = a.keyOf(childA)!;

    const wB = createWorld();
    const attB = attachDurable(wB, b);
    // Exchange base snapshots BOTH ways (§14.2 / 006 A5.2): each peer needs the other's causal history
    // (incl. its docId op) before streaming increments, or a same-peer-chained edit arrives dep-missing.
    b.applyRemote(a.snapshot.export());
    a.applyRemote(b.snapshot.export());
    wB.sync();
    wA.sync();

    // Buffer both directions so the two commits are genuinely concurrent (neither has seen the other).
    const toB: Uint8Array[] = [];
    const toA: Uint8Array[] = [];
    a.subscribeOutbound((x) => toB.push(x));
    b.subscribeOutbound((x) => toA.push(x));

    let bFires = 0;
    wB.reactive.observeQuery(defineQuery([TXPos]), [TXPos], () => {
      bFires++;
    });

    const childB = b.resolve(childKey)!;
    // Concurrent edits: neither peer has seen the other (the bytes are buffered).
    a.transaction((tx) => tx.edit(childA).set(TXPos, { x: 1, y: 1 }));
    b.transaction((tx) => tx.edit(childB).set(TXPos, { x: 2, y: 2 }));

    // Frame N: each peer settles its OWN echo first (a no-op — its value already applied at commit).
    wA.sync();
    wB.sync();
    // Frame N+1: the concurrent remote arrives and is drained as converged truth.
    // (M2 NOTE for M4: draining a stale own-echo AFTER a winning remote in the SAME sync would clobber
    //  the converged value — M2 applies own values unconditionally. The reconcile matrix must apply the
    //  DOC's converged value, not the commit-time echo. Here the two-frame cadence sidesteps it.)
    for (const x of toB) b.applyRemote(x);
    for (const x of toA) a.applyRemote(x);
    wA.sync();
    wB.sync();

    // Both sides converge to ONE whole committed value (per-component committer-wins).
    const va = wA.read(childA, TXPos);
    const vb = wB.read(childB, TXPos);
    expect(va).toEqual(vb);
    expect([JSON.stringify({ x: 1, y: 1 }), JSON.stringify({ x: 2, y: 2 })]).toContain(JSON.stringify(va));
    expect(cellEquals(wA.read(childA, TXPos), attA.baseline.getComponent(childKey, TXPos))).toBe(true);
    expect(cellEquals(wB.read(childB, TXPos), attB.baseline.getComponent(childKey, TXPos))).toBe(true);

    // Reactivity lit up on B with zero wiring (005 §5.3).
    wB.reactive.notify();
    expect(bFires).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("006 C4 — in-system value commit rides 001 enforcement", () => {
  it("an undeclared in-system value commit DEV-throws once enforcement is armed; declaring access.write passes", () => {
    const { store, w, h } = attachedWithPos({ x: 1, y: 1 });
    w.reactive.observeQuery(defineQuery([TXPos]), [TXPos], () => {}); // first observer arms 001 (001 §2.4)

    // No access.write → the synchronous writeComponent hits the 001 chokepoint (006 C4).
    const Undeclared = defineSystem(
      defineQuery([TXPos]),
      (batch) => {
        for (const r of batch) store.transaction((tx) => tx.edit(batch.entity(r)).set(TXPos, { x: 2, y: 2 }));
      },
      { name: "Undeclared" },
    );
    expect(() => w.tick([phase("p", [Undeclared])])).toThrow(/access\.write/);
    expect(w.read(h, TXPos)).toEqual({ x: 1, y: 1 }); // the failed commit changed nothing

    // Declaring the write makes it a legal same-phase value write.
    const Declared = defineSystem(
      defineQuery([TXPos]),
      (batch) => {
        for (const r of batch) store.transaction((tx) => tx.edit(batch.entity(r)).set(TXPos, { x: 3, y: 3 }));
      },
      { name: "Declared", access: { write: [TXPos] } },
    );
    expect(() => w.tick([phase("p", [Declared])])).not.toThrow();
    expect(w.read(h, TXPos)).toEqual({ x: 3, y: 3 });
  });
});

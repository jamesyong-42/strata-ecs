/**
 * The durable binding — Part III **M2** (docs/plan-part3.md; design.md §12.4, §13.1–§13.3).
 *
 * Two-store scenarios build documents via DIRECT snapshot writes inside `commit()` scopes — the
 * transaction layer is M3, so a "local commit" here is `store.snapshot.commit(() => …)`, exactly what
 * M3's executor will drive. Coverage:
 *   - attach: a full document projects (queries see it, relations wired), the FOUNDING AGREEMENT holds
 *     (`cellEquals(runtime, baseline)` every cell, incl. a 0.1-valued f32 — the canonicalization
 *     ship-blocker's regression); an observeQuery armed before attach fires once at the next notify
 *     (006 C3); attach mid-iteration throws; double attach throws;
 *   - drain/convergence: a remote commit converges A → bytes → B.applyRemote → B.sync() (runtime +
 *     baseline advanced, observeQuery lights up with zero wiring — the 005 §5.3 guarantee); a
 *     multi-commit buffer applies in order; a remote resource-set / -remove reconciles;
 *   - own-echo: a local commit on an ATTACHED store drains at the next sync (own structure applies
 *     unconditionally, §13.3) — the subscription enqueues, never applies (§12.4);
 *   - inbound reject: a hand-forged malformed value moves neither side, one DEV warn, the rest applies;
 *   - detach: projected entities despawned, sync never drains again, re-attach mints FRESH handles,
 *     store reads undefined between attachments, an entity watch fires undefined once;
 *   - eid-ban: a durable component carrying an eid field DEV-throws at first projection;
 *   - PendingImportError still propagates through the attached store (quarantine unaffected).
 */

import { describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import {
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineTag,
  entityKey,
} from "../core";
import type { Entity } from "../core";
import { cellEquals } from "../substrate";
import { createDurableStore } from "./durable-store";
import { PendingImportError } from "./loro-snapshot";
import { attachDurable } from "./binding";

const BPos = defineComponent("BINDPos", { x: "f32", y: "f32" });
const BFill = defineComponent("BINDFill", { r: "u8", g: "u8", b: "u8" });
const BSel = defineTag("BINDSel");
const BChild = defineRelation("BINDChild", { arity: "one" });
const BLink = defineRelation("BINDLink", { arity: "many" });
const BClock = defineResource("BINDClock", { t: "u32" });
const BEid = defineComponent("BINDEid", { ref: "eid" }); // a runtime-legal component that is durable-illegal

const K = (s: string) => entityKey(s);

/** A fresh peer-scoped store (peer id → key prefix + LWW ordering). */
function makeStore(peerId: number): ReturnType<typeof createDurableStore> {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/** Entities a query matches, iterated outside a tick (`world.query`, §16). */
function matches(w: ReturnType<typeof createWorld>, q: ReturnType<typeof defineQuery>): Entity[] {
  const out: Entity[] = [];
  w.query(q).each((b) => {
    for (const r of b) out.push(b.entity(r));
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------
describe("attach — two-phase projection seeding the baseline (§13.1)", () => {
  it("projects a full document and holds the founding agreement (cellEquals every cell, incl. 0.1 f32)", () => {
    const store = makeStore(1);
    store.snapshot.commit(() => {
      store.snapshot.spawn(K("1-0"));
      store.snapshot.setComponent(K("1-0"), BPos, { x: 0.1, y: 2 }); // 0.1 f32 — the canonicalization regression
      store.snapshot.addTag(K("1-0"), BSel);
      store.snapshot.spawn(K("1-1"));
      store.snapshot.setComponent(K("1-1"), BFill, { r: 255, g: 0, b: 0 });
      store.snapshot.setRelation(K("1-0"), BChild, K("1-1")); // arity "one"
      store.snapshot.addRelation(K("1-0"), BLink, K("1-1")); // arity "many"
      store.snapshot.setResource(BClock, { t: 42 }); // a pre-existing resource — seeded by attach (fix 5)
    });

    const w = createWorld();
    const att = attachDurable(w, store);

    // Runtime sees them.
    const posSeen = matches(w, defineQuery([BPos]));
    expect(posSeen.length).toBe(1);
    const h0 = store.resolve(K("1-0"))!;
    const h1 = store.resolve(K("1-1"))!;
    expect(posSeen[0]).toBe(h0);
    expect(w.hasTag(h0, BSel)).toBe(true);
    expect(matches(w, defineQuery([BFill])).length).toBe(1);
    // Relations wired (both arities), resolving to the projected target handle.
    expect(w.getRelation(h0, BChild)).toBe(h1);
    expect(w.getRelations(h0, BLink)).toEqual([h1]);

    // THE FOUNDING AGREEMENT: cellEquals(runtime-read, baseline-read) for every component cell.
    expect(cellEquals(w.read(h0, BPos), att.baseline.getComponent(K("1-0"), BPos))).toBe(true);
    expect(cellEquals(w.read(h1, BFill), att.baseline.getComponent(K("1-1"), BFill))).toBe(true);
    // The 0.1 f32 specifically round-trips identically on both sides (no fround-mismatch strand).
    expect(w.read(h0, BPos).x).toBe(Math.fround(0.1));
    expect(att.baseline.getComponent(K("1-0"), BPos)!.x).toBe(Math.fround(0.1));
    // Existence / tag / relation cells agree.
    expect(att.baseline.hasEntity(K("1-1"))).toBe(true);
    expect(att.baseline.hasTag(K("1-0"), BSel)).toBe(true);
    expect(att.baseline.getRelationOne(K("1-0"), BChild)).toBe(K("1-1"));
    expect(att.baseline.getRelationMany(K("1-0"), BLink)).toEqual([K("1-1")]);
    // The pre-existing RESOURCE is seeded into runtime AND baseline (the founding agreement for resources,
    // fix 5) — without the seed pass it would be invisible until its next write.
    expect(w.getResource(BClock)).toEqual({ t: 42 });
    expect(att.baseline.getResource(BClock)).toEqual({ t: 42 });
    expect(cellEquals(w.getResource(BClock), att.baseline.getResource(BClock))).toBe(true);
  });

  it("an observeQuery armed BEFORE attach fires once at the next notify (006 C3 first-paint)", () => {
    const store = makeStore(1);
    store.snapshot.commit(() => store.snapshot.setComponent(K("1-0"), BPos, { x: 1, y: 1 }));

    const w = createWorld();
    let fires = 0;
    w.reactive.observeQuery(defineQuery([BPos]), () => {
      fires++;
    });
    attachDurable(w, store);
    expect(fires).toBe(0); // poll-at-boundary: no immediate fire
    w.reactive.notify();
    expect(fires).toBe(1); // attach's projection stamped through the primitives — one coalesced fire
  });

  it("attach mid query-iteration throws (rides the sync() iteration guard, 006 §A4)", () => {
    const store = makeStore(1);
    store.snapshot.commit(() => store.snapshot.spawn(K("1-0")));

    const w = createWorld();
    const e = w.spawn();
    w.addComponent(e, BPos, { x: 0, y: 0 }); // a matching row so the walk body runs
    let threw = false;
    w.query(defineQuery([BPos])).each(() => {
      try {
        attachDurable(w, store);
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);
  });

  it("double attach throws (one store ↔ at most one attachment)", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    expect(() => attachDurable(w, store)).toThrow(/already attached/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("drain — convergence smoke (§13.3, 005 §5.3)", () => {
  it("a remote commit converges: A → bytes → B.applyRemote → B.sync() lands runtime + baseline; observeQuery fires", () => {
    const a = makeStore(1);
    const b = makeStore(2);

    const wB = createWorld();
    let bFires = 0;
    wB.reactive.observeQuery(defineQuery([BPos]), () => {
      bFires++;
    });
    const attB = attachDurable(wB, b);

    b.applyRemote(a.snapshot.export()); // bootstrap B with A's causal base (§14.2 / 006 A5.2)
    a.subscribeOutbound((bytes) => b.applyRemote(bytes));

    a.snapshot.commit(() => {
      a.snapshot.spawn(K("1-0"));
      a.snapshot.setComponent(K("1-0"), BPos, { x: 5, y: 6 });
    });

    expect(matches(wB, defineQuery([BPos])).length).toBe(0); // enqueued, not yet drained (§12.4)
    wB.sync();

    const seen = matches(wB, defineQuery([BPos]));
    expect(seen.length).toBe(1);
    const hB = b.resolve(K("1-0"))!;
    expect(wB.read(hB, BPos)).toEqual({ x: 5, y: 6 });
    expect(cellEquals(wB.read(hB, BPos), attB.baseline.getComponent(K("1-0"), BPos))).toBe(true);

    // Reactivity lit up with zero wiring (005 §5.3) — observed at the frame's single notify.
    expect(bFires).toBe(0);
    wB.reactive.notify();
    expect(bFires).toBe(1);
  });

  it("a multi-commit buffer applies in commit order", () => {
    const a = makeStore(1);
    const b = makeStore(2);
    const wB = createWorld();
    const attB = attachDurable(wB, b);

    b.applyRemote(a.snapshot.export());
    const buffered: Uint8Array[] = [];
    a.subscribeOutbound((bytes) => buffered.push(bytes));

    a.snapshot.commit(() => a.snapshot.spawn(K("1-0")));
    a.snapshot.commit(() => a.snapshot.setComponent(K("1-0"), BPos, { x: 1, y: 1 }));
    a.snapshot.commit(() => a.snapshot.setComponent(K("1-0"), BPos, { x: 9, y: 9 }));
    expect(buffered).toHaveLength(3);

    for (const bytes of buffered) b.applyRemote(bytes); // deliver in order
    wB.sync();

    const hB = b.resolve(K("1-0"))!;
    expect(wB.read(hB, BPos)).toEqual({ x: 9, y: 9 }); // last commit wins
    expect(cellEquals(wB.read(hB, BPos), attB.baseline.getComponent(K("1-0"), BPos))).toBe(true);
  });

  it("a remote resource-set drains to runtime + baseline; resource-remove clears both", () => {
    const a = makeStore(1);
    const b = makeStore(2);
    const wB = createWorld();
    const attB = attachDurable(wB, b);

    b.applyRemote(a.snapshot.export());
    a.subscribeOutbound((bytes) => b.applyRemote(bytes));

    a.snapshot.commit(() => a.snapshot.setResource(BClock, { t: 42 }));
    wB.sync();
    expect(wB.getResource(BClock)).toEqual({ t: 42 });
    expect(attB.baseline.getResource(BClock)).toEqual({ t: 42 });

    a.snapshot.commit(() => a.snapshot.removeResource(BClock));
    wB.sync();
    expect(wB.getResource(BClock)).toBeUndefined();
    expect(attB.baseline.getResource(BClock)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("drain — own-echo (§13.3)", () => {
  it("a local commit on an attached store drains at the next sync: runtime gains the structure, baseline advances", () => {
    const store = makeStore(1);
    const w = createWorld();
    const att = attachDurable(w, store);

    store.snapshot.commit(() => {
      store.snapshot.spawn(K("1-0"));
      store.snapshot.setComponent(K("1-0"), BPos, { x: 2, y: 3 });
    });

    // The subscription ENQUEUES the local echo; nothing applied until sync (§12.4 invariant).
    expect(matches(w, defineQuery([BPos])).length).toBe(0);
    w.sync();

    const seen = matches(w, defineQuery([BPos]));
    expect(seen.length).toBe(1);
    const h = store.resolve(K("1-0"))!;
    expect(w.read(h, BPos)).toEqual({ x: 2, y: 3 });
    expect(cellEquals(w.read(h, BPos), att.baseline.getComponent(K("1-0"), BPos))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("drain — inbound reject (005 §2.3)", () => {
  it("a malformed inbound component value moves neither side; one DEV warn; the rest of the batch applies", () => {
    // Forge a remote doc directly (bypassing the adapter's setComponent) so a malformed value survives.
    const forge = new LoroDoc();
    forge.setPeerId(9);
    const em = forge.getMap("entities");
    const e0 = em.setContainer("9-0", new LoroMap());
    e0.set("exists", true);
    e0.set("comp:BINDPos", { x: "not-a-number", y: 2 }); // x must be a number → tryCanon rejects
    const e1 = em.setContainer("9-1", new LoroMap());
    e1.set("exists", true);
    e1.set("comp:BINDFill", { r: 1, g: 2, b: 3 }); // valid — must still apply
    forge.commit({ message: "strata:0" }); // tagged so the adapter doesn't warn about an untagged writer
    const bytes = forge.export({ mode: "snapshot" });

    const recv = makeStore(20);
    const w = createWorld();
    const att = attachDurable(w, recv);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    recv.applyRemote(bytes);
    w.sync();

    // The malformed BPos cell moved NEITHER runtime NOR baseline.
    expect(matches(w, defineQuery([BPos])).length).toBe(0);
    expect(att.baseline.getComponent(K("9-0"), BPos)).toBeUndefined();
    // The rest of the batch applied.
    expect(matches(w, defineQuery([BFill])).length).toBe(1);
    expect(att.baseline.getComponent(K("9-1"), BFill)).toEqual({ r: 1, g: 2, b: 3 });
    // Exactly one reject diagnostic.
    const rejects = warnSpy.mock.calls.filter((c) => String(c[0]).includes("rejected"));
    expect(rejects).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("detach — the four-step teardown (005 §5.6)", () => {
  it("despawns projected entities, stops draining, and re-attach mints fresh handles", () => {
    const store = makeStore(1);
    store.snapshot.commit(() => store.snapshot.setComponent(K("1-0"), BPos, { x: 1, y: 1 }));
    const w = createWorld();
    const att = attachDurable(w, store);

    const oldHandle = store.resolve(K("1-0"))!;
    expect(w.isAlive(oldHandle)).toBe(true);
    expect(matches(w, defineQuery([BPos])).length).toBe(1);

    att.detach();

    // Projected entities despawned; store reads undefined between attachments (§14.3).
    expect(w.isAlive(oldHandle)).toBe(false);
    expect(matches(w, defineQuery([BPos])).length).toBe(0);
    expect(store.resolve(K("1-0"))).toBeUndefined();
    expect(store.keyOf(oldHandle)).toBeUndefined();

    // sync() never drains the binding again: a post-detach local commit projects nothing.
    store.snapshot.commit(() => store.snapshot.spawn(K("1-1")));
    w.sync();
    expect(store.resolve(K("1-1"))).toBeUndefined();

    // Re-attach: fresh projection with FRESH handles (the old handle stays dead).
    const att2 = attachDurable(w, store);
    const newHandle = store.resolve(K("1-0"))!;
    expect(newHandle).not.toBe(oldHandle);
    expect(w.isAlive(newHandle)).toBe(true);
    expect(matches(w, defineQuery([BPos])).length).toBe(1);
    att2.detach();
  });

  it("detach fires an armed entity watch undefined once (routes through destroy, 006 C3)", () => {
    const store = makeStore(1);
    store.snapshot.commit(() => store.snapshot.setComponent(K("1-0"), BPos, { x: 1, y: 1 }));
    const w = createWorld();
    const att = attachDurable(w, store);
    const h = store.resolve(K("1-0"))!;

    const seen: (Record<string, unknown> | undefined)[] = [];
    w.reactive.observeValue(h, BPos, (v) => {
      seen.push(v);
    });

    att.detach();
    w.reactive.notify();
    expect(seen).toEqual([undefined]); // the eager death hook fires undefined once and self-removes
  });
});

// ---------------------------------------------------------------------------------------------------
describe("eid-field ban (005 §7)", () => {
  it("a durable component carrying an eid field DEV-throws at first projection, naming the component", () => {
    // Forge a doc carrying BINDEid (eid field) directly — the ban is the binding's job, not the adapter's.
    const doc = new LoroDoc();
    doc.setPeerId(1);
    const ent = doc.getMap("entities").setContainer("1-0", new LoroMap());
    ent.set("exists", true);
    ent.set(`comp:${BEid.name}`, { ref: 0 }); // BEid registers BINDEid so attach resolves + bans it

    doc.commit({ message: "strata:0" });
    const store = createDurableStore(doc);

    const w = createWorld();
    expect(() => attachDurable(w, store)).toThrow(/durable component "BINDEid" declares an eid field/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("quarantine is unaffected by the binding (006 §A4)", () => {
  it("PendingImportError still propagates through an attached store", () => {
    const store = makeStore(20);
    const w = createWorld();
    attachDurable(w, store);

    // A sender whose LATER commit depends on an earlier one the receiver lacks → pending import.
    const sender = makeStore(10);
    sender.snapshot.commit(() => sender.snapshot.setComponent(K("10-0"), BPos, { x: 1, y: 1 }));
    const vvAfter1 = sender.snapshot.version();
    sender.snapshot.commit(() => sender.snapshot.setComponent(K("10-0"), BPos, { x: 2, y: 2 }));
    const laterHalf = sender.snapshot.exportUpdatesSince(vvAfter1);

    expect(() => store.applyRemote(laterHalf)).toThrow(PendingImportError);
  });
});

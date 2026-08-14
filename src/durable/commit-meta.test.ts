/**
 * Petition 9 — per-commit user metadata: `transaction(fn, { meta })`.
 *
 * The contract under test: a meta-carrying commit seals ONE Loro commit whose message multiplexes
 * the payload after the anti-coalescing tag (`strata:<n>;<json>` — the FIRST `;` is the one
 * separator); the local echo and the remote batch surface the SAME canonical (JSON-round-tripped)
 * record as `batch.meta`; meta-less commits stay byte-identical to today; undo/redo self-commits
 * carry none (v1 policy); the serialized cap is enforced in code AT ENTRY (throw 1KB / DEV-warn
 * 256B, before `fn` runs); hostile suffixes soft-reject to absent-meta (never a throw out of
 * applyRemote); a coalesced bootstrap batch carries none by design; and a session restart seeds
 * the commit-seq correctly past suffixed messages.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { createWorld, defineComponent } from "../core";
import { normalizeBatch } from "../substrate";
import type { ChangeBatch } from "../substrate";
import { createDurableStore } from "./durable-store";
import { attachDurable } from "./binding";

const CMPos = defineComponent("CMPos", { x: "f32", y: "f32" });
const CMTint = defineComponent("CMTint", { r: "u8" });

afterEach(() => vi.restoreAllMocks());

function makeStore(peerId: number): ReturnType<typeof createDurableStore> {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/** A + B attached; B holds its OWN entity (non-pristine → per-change translate, never bootstrap-coalesced). */
function pair() {
  const a = makeStore(1);
  const wA = createWorld();
  attachDurable(wA, a);
  const b = makeStore(2);
  const wB = createWorld();
  attachDurable(wB, b);
  b.transaction((tx) => tx.spawn({ components: [[CMTint, { r: 9 }]] })); // B's own divergent history
  wB.sync();
  b.snapshot.applyRemote(a.snapshot.export()); // B absorbs A's causal base
  wB.sync();
  return { a, wA, b, wB };
}

/** Every commit message in `bytes`, in import order — read through a bare LoroDoc (the wire truth). */
function messagesOf(bytes: Uint8Array): string[] {
  const probe = new LoroDoc();
  probe.import(bytes);
  const out: string[] = [];
  for (const [, changes] of probe.getAllChanges()) {
    for (const ch of changes) if (ch.message !== undefined && ch.message !== null) out.push(String(ch.message));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
describe("round-trip — one shape both directions", () => {
  it("local echo and remote batch carry the same canonical meta; the wire message is strata:<n>;<json>", () => {
    const { a, wA, b } = pair();
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));

    const meta = { plugin: "layout", label: "arrange" };
    const h = a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 2 }]] }), { meta });
    wA.sync();
    expect(h).toBeDefined();

    // Local echo: the seal's own canonicalized record, threaded.
    expect(local).toHaveLength(1);
    expect(local[0].meta).toEqual(meta);

    // Wire format: tag, ONE separator, exact JSON payload.
    const bytes = a.snapshot.export();
    const suffixed = messagesOf(bytes).filter((m) => m.includes(";"));
    expect(suffixed).toHaveLength(1);
    expect(suffixed[0]).toMatch(/^strata:\d+;\{"plugin":"layout","label":"arrange"\}$/);

    // Remote batch: parsed from the message, equal to the sender's record.
    const batches = b.snapshot.applyRemote(bytes); // full snapshot; B is non-pristine → per-change translate
    const withMeta = batches.filter((batch) => batch.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0].meta).toEqual(meta);
    expect(withMeta[0].events.length).toBeGreaterThan(0);
  });

  it("a meta-less commit stays byte-identical (bare strata:<n>) and surfaces no meta anywhere", () => {
    const { a, wA, b } = pair();
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 0, y: 0 }]] }));
    wA.sync();
    expect(local[0].meta).toBeUndefined();
    const msgs = messagesOf(a.snapshot.export());
    expect(msgs.every((m) => /^strata:\d+$/.test(m))).toBe(true);
    const batches = b.snapshot.applyRemote(a.snapshot.export());
    expect(batches.every((batch) => batch.meta === undefined)).toBe(true);
  });

  it("canonicalization: JSON-unrepresentable values drop identically on both sides", () => {
    const { a, wA, b } = pair();
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 3, y: 3 }]] }), {
      meta: { id: "k7", gone: undefined } as unknown as Record<string, unknown>,
    });
    wA.sync();
    expect(local[0].meta).toEqual({ id: "k7" }); // dropped at ENTRY, not just on the wire
    expect(Object.prototype.hasOwnProperty.call(local[0].meta!, "gone")).toBe(false);
    const withMeta = b.snapshot.applyRemote(a.snapshot.export()).filter((batch) => batch.meta !== undefined);
    expect(withMeta[0].meta).toEqual({ id: "k7" });
  });

  it("a bootstrap-coalesced batch carries no meta (many commits, no single record — documented)", () => {
    const a = makeStore(1);
    const wA = createWorld();
    attachDurable(wA, a);
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] }), { meta: { p: "x" } });
    wA.sync();
    const fresh = makeStore(3); // pristine receiver → bootstrap fast path
    const batches = fresh.snapshot.applyRemote(a.snapshot.export());
    for (const batch of batches) expect(batch.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("undo/redo self-commits (v1 policy: history's inverse carries no meta)", () => {
  it("undoing a meta commit ships a meta-less self-commit, locally and to peers", () => {
    const { a, wA, b } = pair();
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 5, y: 5 }]] }), { meta: { p: "z" } });
    wA.sync();
    b.snapshot.applyRemote(a.snapshot.export()); // peer absorbs the meta commit first

    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    expect(a.undo()).toBe(true);
    expect(local).toHaveLength(1);
    expect(local[0].meta).toBeUndefined();

    const undoBatches = b.snapshot.applyRemote(a.snapshot.export());
    expect(undoBatches.every((batch) => batch.meta === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the entry cap — enforced in code, before fn runs", () => {
  function attached() {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    return { store, w };
  }

  it("over 1KB serialized throws at entry and never runs the body", () => {
    const { store } = attached();
    let ran = false;
    expect(() =>
      store.transaction(
        () => {
          ran = true;
        },
        { meta: { blob: "x".repeat(1100) } },
      ),
    ).toThrow(/1024B cap/);
    expect(ran).toBe(false);
  });

  it("over 256B DEV-warns but commits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, w } = attached();
    store.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] }), {
      meta: { blob: "y".repeat(300) },
    });
    w.sync();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("advisory budget"))).toBe(true);
  });

  it("non-record meta (array / scalar) and circular records throw at entry", () => {
    const { store } = attached();
    const noop = (): void => {};
    expect(() => store.transaction(noop, { meta: [1, 2] as unknown as Record<string, unknown> })).toThrow(/plain JSON/);
    expect(() => store.transaction(noop, { meta: "hi" as unknown as Record<string, unknown> })).toThrow(/plain JSON/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => store.transaction(noop, { meta: circular })).toThrow();
  });

  it("a toJSON() that rewrites the record to a non-record is refused at entry (review finding 1)", () => {
    const { store } = attached();
    const noop = (): void => {};
    const cases: unknown[] = [
      new Date(0), // serializes to a string
      { toJSON: () => [1, 2, 3] },
      { toJSON: () => null },
      { toJSON: () => 42 },
      { toJSON: () => undefined }, // stringify yields undefined outright
    ];
    for (const meta of cases) {
      expect(() => store.transaction(noop, { meta: meta as Record<string, unknown> })).toThrow(/plain JSON/);
    }
    // A toJSON that stays a record is legal — the canonical (round-tripped) form is what surfaces.
    const local: ChangeBatch[] = [];
    store.snapshot.subscribe((batch) => local.push(batch));
    store.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] }), {
      meta: { toJSON: () => ({ rec: true }) } as unknown as Record<string, unknown>,
    });
    expect(local[0].meta).toEqual({ rec: true });
  });

  it('an own "__proto__" key at any depth is refused at entry (wire finding 2)', () => {
    const { store } = attached();
    const noop = (): void => {};
    const top = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() => store.transaction(noop, { meta: top })).toThrow(/__proto__/);
    const nested = JSON.parse('{"cfg":{"__proto__":{"polluted":true}}}') as Record<string, unknown>;
    expect(() => store.transaction(noop, { meta: nested })).toThrow(/__proto__/);
  });

  it("the cap measures UTF-8 bytes, not code units (multibyte accounting)", () => {
    const { store } = attached();
    const noop = (): void => {};
    // 300 four-byte emoji ≈ 1200B serialized — over the 1024B cap despite only ~600 UTF-16 units.
    expect(() => store.transaction(noop, { meta: { s: "🦜".repeat(300) } })).toThrow(/cap/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the paths production actually ships (review test-shaping gaps)", () => {
  it("meta rides the update-INCREMENT wire (subscribeOutbound), not only full snapshots", () => {
    const { a, wA, b } = pair();
    const remote: ChangeBatch[] = [];
    a.subscribeOutbound((bytes) => remote.push(...b.snapshot.applyRemote(bytes)));
    a.transaction(
      (tx) => tx.spawn({ components: [[CMPos, { x: 6, y: 6 }]] }),
      { meta: { inc: true, ids: [1, 2], cfg: { nested: { deep: "ok" } } } }, // nested values are legal
    );
    wA.sync();
    const withMeta = remote.filter((x) => x.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0].meta).toEqual({ inc: true, ids: [1, 2], cfg: { nested: { deep: "ok" } } });
  });

  it("{ undoable: false, meta } compose: meta surfaces, the commit stays off the undo stack", () => {
    const { a, wA, b } = pair();
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 7, y: 7 }]] }), {
      undoable: false,
      meta: { janitor: "migration-3" },
    });
    wA.sync();
    expect(local[0].meta).toEqual({ janitor: "migration-3" });
    expect(a.canUndo()).toBe(false); // non-undoable held
    const withMeta = b.snapshot.applyRemote(a.snapshot.export()).filter((x) => x.meta !== undefined);
    expect(withMeta[0].meta).toEqual({ janitor: "migration-3" });
  });

  it("a value-only meta transaction (edit on a pre-existing cell, no spawn) carries meta both sides", () => {
    const { a, wA, b } = pair();
    const h = a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] }));
    wA.sync();
    b.snapshot.applyRemote(a.snapshot.export());
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    a.transaction((tx) => tx.edit(h).set(CMPos, { x: 2, y: 2 }), { meta: { op: "nudge" } });
    wA.sync();
    expect(local[0].meta).toEqual({ op: "nudge" });
    const withMeta = b.snapshot.applyRemote(a.snapshot.export()).filter((x) => x.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0].meta).toEqual({ op: "nudge" });
  });

  it("an EMPTY meta transaction commits nothing and leaks nothing onto the next commit", () => {
    const { a, wA } = pair();
    const local: ChangeBatch[] = [];
    a.snapshot.subscribe((batch) => local.push(batch));
    a.transaction(() => {}, { meta: { ghost: true } }); // stages nothing
    expect(local).toHaveLength(0);
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] })); // meta-less follow-up
    wA.sync();
    expect(local).toHaveLength(1);
    expect(local[0].meta).toBeUndefined(); // no lingering ghost meta
    const suffixed = messagesOf(a.snapshot.export()).filter((m) => m.includes(";"));
    expect(suffixed).toHaveLength(0); // the ghost never reached the wire either
  });
});

// ---------------------------------------------------------------------------------------------------
describe("hostile inbound — soft rejects only, facts still land", () => {
  it("malformed / non-record suffixes read as absent meta; a valid foreign suffix parses; nothing throws", () => {
    // A raw doc (foreign writer minting its own strata-tagged messages) with five distinct commits.
    const raw = new LoroDoc();
    raw.setPeerId(99);
    const cells = raw.getMap("entities").setContainer("h1", new LoroMap());
    cells.set("exists", true);
    raw.commit({ message: "strata:0;not-json" });
    cells.set("comp:CMPos", { x: 1, y: 1 });
    raw.commit({ message: "strata:1;[1,2]" });
    cells.set("comp:CMPos", { x: 2, y: 2 });
    raw.commit({ message: "strata:2;null" });
    cells.set("comp:CMPos", { x: 3, y: 3 });
    raw.commit({ message: "strata:3;123" });
    cells.set("comp:CMPos", { x: 4, y: 4 });
    raw.commit({ message: 'strata:4;{"ok":true,"n":1}' });
    const bytes = raw.export({ mode: "snapshot" });

    const { b } = pair(); // non-pristine receiver → per-change translate
    const batches = b.snapshot.applyRemote(bytes);
    expect(batches.length).toBeGreaterThanOrEqual(5);
    const metas = batches.map((batch) => batch.meta).filter((m) => m !== undefined);
    expect(metas).toEqual([{ ok: true, n: 1 }]); // exactly the one well-formed record
    // The facts themselves landed despite the hostile suffixes.
    expect(batches.some((batch) => batch.events.some((e) => e.kind === "spawn"))).toBe(true);
  });

  it("degenerate tags and oversize suffixes read as absent (strict separator arm + parse bound)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); // foreign-writer DEV warns expected
    const raw = new LoroDoc();
    raw.setPeerId(98);
    const cells = raw.getMap("entities").setContainer("d1", new LoroMap());
    cells.set("exists", true);
    raw.commit({ message: 'strata:;{"degenerate":true}' }); // empty integer part — foreign
    cells.set("comp:CMPos", { x: 1, y: 1 });
    raw.commit({ message: 'strata: 7 ;{"ws":true}' }); // whitespace integer part — foreign
    cells.set("comp:CMPos", { x: 2, y: 2 });
    raw.commit({ message: 'strata:1e3;{"exp":true}' }); // non-digit integer part — foreign
    cells.set("comp:CMPos", { x: 3, y: 3 });
    raw.commit({ message: "strata:9;" + JSON.stringify({ blob: "x".repeat(5000) }) }); // > parse bound
    cells.set("comp:CMPos", { x: 5, y: 5 });
    raw.commit({ message: 'strata:10;{"__proto__":{"polluted":true},"ok":1}' }); // hostile key → whole meta absent
    const { b } = pair();
    const batches = b.snapshot.applyRemote(raw.export({ mode: "snapshot" }));
    expect(batches.every((batch) => batch.meta === undefined)).toBe(true);
    expect(batches.some((batch) => batch.events.some((e) => e.kind === "spawn"))).toBe(true); // facts landed
  });

  it("a payload containing the separator parses whole (split at the FIRST ';' only)", () => {
    const { a, wA, b } = pair();
    const meta = { label: "a;b;c", note: 'quote";semi' };
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 8, y: 8 }]] }), { meta });
    wA.sync();
    const withMeta = b.snapshot.applyRemote(a.snapshot.export()).filter((batch) => batch.meta !== undefined);
    expect(withMeta).toHaveLength(1);
    expect(withMeta[0].meta).toEqual(meta);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("conformance seam — meta is fact-transparent (the frozen-ladder addition changes no facts)", () => {
  it("a meta commit yields the same normalized facts as an identical meta-less commit", () => {
    const { a, wA, b } = pair();
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 4, y: 4 }]] }), { meta: { p: "n" } });
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 4, y: 4 }]] })); // twin, no meta
    wA.sync();
    const batches = b.snapshot.applyRemote(a.snapshot.export());
    const withMeta = batches.find((x) => x.meta !== undefined);
    const without = batches.find(
      (x) => x.meta === undefined && x.events.some((e) => e.kind === "spawn"),
    );
    expect(withMeta).toBeDefined();
    expect(without).toBeDefined();
    // Same facts modulo the entity key (each spawn minted its own): strip keys, compare shapes.
    const shape = (batch: ChangeBatch): unknown =>
      normalizeBatch(batch.events).map((e) => {
        const r = { ...e } as Record<string, unknown>;
        delete r.key;
        return r;
      });
    expect(shape(withMeta!)).toEqual(shape(without!));
  });
});

// ---------------------------------------------------------------------------------------------------
describe("commit-seq seeding survives suffixed history (the one parser, restart path)", () => {
  it("a session restart over meta-carrying history mints past its own max, never re-coalescing", () => {
    const a = makeStore(7);
    const wA = createWorld();
    attachDurable(wA, a);
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 1, y: 1 }]] }), { meta: { p: "1" } });
    a.transaction((tx) => tx.spawn({ components: [[CMPos, { x: 2, y: 2 }]] }), { meta: { p: "2" } });
    wA.sync();
    const bytes = a.snapshot.export();
    const seqsBefore = messagesOf(bytes)
      .map((m) => Number(/^strata:(\d+)/.exec(m)?.[1]))
      .filter((n) => Number.isInteger(n));
    const maxBefore = Math.max(...seqsBefore);

    // Restart: same peer id, history re-imported, a NEW store seeds its counter from the messages.
    const doc2 = new LoroDoc();
    doc2.setPeerId(7);
    doc2.import(bytes);
    const restarted = createDurableStore(doc2);
    const w2 = createWorld();
    attachDurable(w2, restarted);
    restarted.transaction((tx) => tx.spawn({ components: [[CMTint, { r: 1 }]] }));
    w2.sync();
    const seqsAfter = messagesOf(restarted.snapshot.export())
      .map((m) => Number(/^strata:(\d+)/.exec(m)?.[1]))
      .filter((n) => Number.isInteger(n));
    expect(Math.max(...seqsAfter)).toBeGreaterThan(maxBefore); // seeded PAST the suffixed max
    expect(seqsAfter.filter((n) => n === maxBefore)).toHaveLength(1); // no re-mint of an existing seq
  });
});

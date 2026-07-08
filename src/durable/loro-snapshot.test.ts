/**
 * `LoroSnapshot` adapter-specific properties (Part III M0, plan-part3.md "Acceptance").
 *
 * The MutableSnapshot-generic laws (P1/P2/P5/P7-state) are the conformance suite's job
 * (src/substrate/__conformance__, run against this adapter unchanged). This file covers the
 * CRDT-specific behavior the generic suite cannot reach:
 *   - the 005 §3.4 convergence pair on two real docs exchanging bytes (whole-value LWW; per-tag both-survive);
 *   - batch-per-commit boundaries (multi-commit buffer → ordered remote batches; local commit → one batch);
 *   - commit-as-scope (no seal without commit; one history entry; nested commit throws);
 *   - undo is LOCAL-ops-only (asserted via converged state on both peers);
 *   - export → applyRemote round-trip;
 *   - unknown-name skip (no event + one-shot DEV warn);
 *   - the collision-proof rel-edge key encoding under hostile relation names / target keys;
 *   - the awkward-value battery THROUGH the adapter (incl. NaN — loro stores it, unlike JSON export).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroMap, LoroText } from "loro-crdt";
import { entityKey, field } from "../core/field";
import { defineComponent, defineRelation, defineResource, defineTag } from "../core/schema";
import { BaselineSnapshot, type ChangeBatch, type ChangeEvent, normalizeBatch } from "../substrate";
import {
  SCHEMA as CFM_SCHEMA,
  applyToStore,
  diffStores,
  genOps,
  keyPool,
  mulberry32,
} from "../substrate/__conformance__/harness";
import { LoroSnapshot, PendingImportError } from "./loro-snapshot";

// Distinctive "LS…" schema names (this file is its own module graph, so no clash with the conformance
// schema). A relation name carrying '/' exercises the arity-prefix discrimination directly.
const Pos = defineComponent("LSPos", { x: "f32", y: "f32" });
const Tile = defineComponent("LSTile", { u: "u8", i: "i16" });
const Misc = defineComponent("LSMisc", { v: "f32" });
const Sel = defineTag("LSSel");
const Lock = defineTag("LSLock");
const Parent = defineRelation("LSpar", { arity: "one" });
const Kids = defineRelation("LSkid", { arity: "many" });
const SlashOne = defineRelation("LSkid/x", { arity: "one" }); // name with '/' — must not alias an LSkid edge
const Cam = defineResource("LSCam", { zoom: "f32", mode: field("u8", { default: 1 }) });

/** A LoroSnapshot over a fresh doc with an explicit peer id (peer ordering drives LWW winners). */
function peer(peerId: number): { snap: LoroSnapshot; doc: LoroDoc } {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return { snap: new LoroSnapshot(doc), doc };
}

/** Full two-way byte exchange until convergence (export = full snapshot; import is idempotent). */
function sync(a: { snap: LoroSnapshot }, b: { snap: LoroSnapshot }): void {
  a.snap.applyRemote(b.snap.export());
  b.snap.applyRemote(a.snap.export());
}

const K = (s: string) => entityKey(s);

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------------
describe("convergence — assignment unit = conflict unit (005 §3.4)", () => {
  it("concurrent different-FIELD writes to one component → exactly ONE committer's whole value on both", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 0, y: 0 }));
    sync(a, b); // both share the base

    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 5, y: 0 })); // A writes x
    b.snap.commit(() => b.snap.setComponent(K("e1"), Pos, { x: 0, y: 9 })); // B writes y (whole object each)
    sync(a, b);

    const av = a.snap.getComponent(K("e1"), Pos)!;
    const bv = b.snap.getComponent(K("e1"), Pos)!;
    expect(av).toEqual(bv); // converged
    // ONE whole value won — never a field merge {x:5,y:9}.
    const isAWin = av.x === 5 && av.y === 0;
    const isBWin = av.x === 0 && av.y === 9;
    expect(isAWin || isBWin).toBe(true);
    expect(av).not.toEqual({ x: 5, y: 9 });
  });

  it("concurrent different-TAG adds → BOTH tags present (per-entry registers)", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.spawn(K("e1")));
    sync(a, b);

    a.snap.commit(() => a.snap.addTag(K("e1"), Sel));
    b.snap.commit(() => b.snap.addTag(K("e1"), Lock));
    sync(a, b);

    for (const p of [a, b]) {
      expect(p.snap.hasTag(K("e1"), Sel)).toBe(true);
      expect(p.snap.hasTag(K("e1"), Lock)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("batch boundaries — one ChangeBatch per commit (005 §1.3)", () => {
  it("a buffer carrying 3 remote commits → 3 batches, order preserved, all origin 'remote'", () => {
    const sender = peer(10);
    sender.snap.commit(() => sender.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 })); // commit 0
    sender.snap.commit(() => sender.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 })); // commit 1
    sender.snap.commit(() => sender.snap.addTag(K("e1"), Sel)); // commit 2

    // Per-commit boundaries are reconstructed only into a NON-EMPTY doc (something to interleave
    // with); a fresh doc coalesces via the bootstrap fast path — pinned separately (task #75).
    const receiver = peer(20);
    receiver.snap.commit(() => receiver.snap.spawn(K("r0")));
    const batches = receiver.snap.applyRemote(sender.snap.export());

    expect(batches).toHaveLength(3);
    expect(batches.every((bt) => bt.origin === "remote")).toBe(true);
    // Order preserved: c0 sets x=1, c1 sets x=2, c2 adds the tag.
    expect(batches[0].events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 1, y: 1 } }),
    );
    expect(batches[1].events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 2, y: 2 } }),
    );
    expect(batches[2].events).toContainEqual(
      expect.objectContaining({ kind: "tag-add", tag: Sel }),
    );
    // Converged state on the receiver.
    expect(receiver.snap.getComponent(K("e1"), Pos)).toEqual({ x: 2, y: 2 });
    expect(receiver.snap.hasTag(K("e1"), Sel)).toBe(true);
  });

  it("a local commit → exactly one batch, origin 'local'", () => {
    const p = peer(1);
    const seen: ChangeBatch[] = [];
    p.snap.subscribe((bt) => seen.push(bt));
    p.snap.commit(() => {
      p.snap.spawn(K("e1"));
      p.snap.setComponent(K("e1"), Pos, { x: 1, y: 2 });
      p.snap.addTag(K("e1"), Sel);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("local");
    // Well-formed order: the spawn precedes its component/tag facts.
    expect(seen[0].events[0]).toMatchObject({ kind: "spawn", key: "e1" });
    expect(seen[0].events.map((e) => e.kind)).toEqual(["spawn", "component-set", "tag-add"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("commit as scope (005 §1.3)", () => {
  it("no LOCAL batch is emitted until the commit seals — the seal is what fires it", () => {
    const a = peer(1);
    const seen: ChangeBatch[] = [];
    a.snap.subscribe((bt) => seen.push(bt));
    a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 }); // staged inside no commit scope
    expect(seen).toHaveLength(0); // subscribe fires only on a sealed commit
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 }));
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("local");
  });

  it("one commit is ONE history entry — a multi-write commit surfaces as a single remote batch", () => {
    const sender = peer(10);
    sender.snap.commit(() => {
      sender.snap.spawn(K("e1"));
      sender.snap.setComponent(K("e1"), Pos, { x: 1, y: 2 });
      sender.snap.setComponent(K("e2"), Tile, { u: 300, i: 5 });
    });
    const batches = peer(20).snap.applyRemote(sender.snap.export());
    expect(batches).toHaveLength(1);
  });

  it("nested commit throws", () => {
    const p = peer(1);
    expect(() => p.snap.commit(() => p.snap.commit(() => {}))).toThrow(/nested commit/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("undo is LOCAL-ops-only (005 §1.3)", () => {
  it("A.undo() reverts only A's own op, never B's — converged on both peers", () => {
    const a = peer(1);
    const b = peer(2);

    // e1 is created and shared FIRST, so neither peer's undoable op is the container creation.
    a.snap.commit(() => a.snap.spawn(K("e1")));
    sync(a, b);
    b.snap.commit(() => b.snap.setComponent(K("e1"), Tile, { u: 3, i: 4 })); // B's op (different component)
    sync(a, b);
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 7, y: 7 })); // A's op — A's last undoable step
    sync(a, b);

    a.snap.undo(); // reverts ONLY A's Pos write (one commit = one undo step); B's Tile write survives
    sync(a, b);

    for (const p of [a, b]) {
      expect(p.snap.getComponent(K("e1"), Pos)).toBeUndefined(); // A's op undone everywhere
      expect(p.snap.getComponent(K("e1"), Tile)).toEqual({ u: 3, i: 4 }); // B's op untouched
    }

    a.snap.redo(); // redo brings A's op back
    sync(a, b);
    for (const p of [a, b]) {
      expect(p.snap.getComponent(K("e1"), Pos)).toEqual({ x: 7, y: 7 });
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("export → applyRemote round-trip", () => {
  it("a fresh doc reproduces the full converged state", () => {
    const a = peer(1);
    a.snap.commit(() => {
      a.snap.spawn(K("e1"));
      a.snap.setComponent(K("e1"), Pos, { x: 0.1, y: 0.2 });
      a.snap.addTag(K("e1"), Sel);
      a.snap.spawn(K("e2"));
      a.snap.setRelation(K("e2"), Parent, K("e1"));
      a.snap.addRelation(K("e2"), Kids, K("e1"));
      a.snap.setResource(Cam, { zoom: 1.5, mode: 2 });
    });

    const b = peer(2);
    b.snap.applyRemote(a.snap.export());

    expect(b.snap.readEntity(K("e1"))).toEqual(a.snap.readEntity(K("e1")));
    expect(b.snap.readEntity(K("e2"))).toEqual(a.snap.readEntity(K("e2")));
    expect(b.snap.getRelationOne(K("e2"), Parent)).toBe(K("e1"));
    expect(b.snap.getRelationMany(K("e2"), Kids)).toEqual([K("e1")]);
    expect(b.snap.getResource(Cam)).toEqual(a.snap.getResource(Cam));
  });
});

// ---------------------------------------------------------------------------------------------------
describe("unknown-name handling (005 §1.4 / plan-part3 locked)", () => {
  it("an unresolved durable name surfaces NO event and DEV-warns exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A raw doc writes a known AND an unknown component name in one commit (schema is process-global,
    // so we forge the version-skew by writing a name that was never `defineComponent`'d).
    const raw = new LoroDoc();
    raw.setPeerId(99);
    const child = raw.getMap("entities").setContainer("e1", new LoroMap());
    child.set("exists", true);
    child.set("comp:LSPos", { x: 1, y: 2 }); // known
    child.set("comp:LSNope", { z: 3 }); // NOT registered
    raw.commit({ message: "0" });
    const rawBytes = raw.export({ mode: "snapshot" });

    const recv = peer(20);
    const [batch] = recv.snap.applyRemote(rawBytes);

    // The known facts surface; nothing carries the unknown name.
    expect(batch.events).toContainEqual(expect.objectContaining({ kind: "spawn", key: "e1" }));
    expect(batch.events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos }),
    );
    expect(batch.events.some((e) => JSON.stringify(e).includes("LSNope"))).toBe(false);

    // A second import re-surfaces nothing new, and the DEV warn is one-shot per name.
    recv.snap.applyRemote(rawBytes);
    const nopeWarns = warn.mock.calls.filter((c) => String(c[0]).includes("LSNope"));
    expect(nopeWarns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("rel-edge key encoding is collision-proof (task: hostile keys)", () => {
  const HOSTILE = [K("a/b"), K('x":"y'), K("]["), K("rel1:LSpar"), K("relN:oops")];

  it("hostile target keys round-trip through both arities without cross-talk", () => {
    const p = peer(1);
    p.snap.commit(() => {
      p.snap.setRelation(K("src"), Parent, HOSTILE[0]);
      for (const t of HOSTILE) p.snap.addRelation(K("src"), Kids, t);
    });
    expect(p.snap.getRelationOne(K("src"), Parent)).toBe(HOSTILE[0]);
    expect([...p.snap.getRelationMany(K("src"), Kids)].sort()).toEqual([...HOSTILE].sort());
  });

  it("the '/'-named arity-one relation cannot alias an LSkid many-edge (the naive rel:name/target collision)", () => {
    // Naive `rel:${name}/${target}` would make SlashOne("LSkid/x")=y collide with Kids("LSkid") edge to "x".
    // The rel1:/relN:+JSON encoding keeps them independent registers.
    const p = peer(1);
    p.snap.commit(() => {
      p.snap.addRelation(K("src"), Kids, K("x")); // relN edge to "x"
      p.snap.setRelation(K("src"), SlashOne, K("y")); // rel1 slot named "LSkid/x"
    });
    expect(p.snap.getRelationMany(K("src"), Kids)).toEqual([K("x")]); // exactly one edge, no phantom "y"
    expect(p.snap.getRelationOne(K("src"), SlashOne)).toBe(K("y"));
    expect(p.snap.getRelationMany(K("src"), Kids)).not.toContain(K("y"));
  });

  it("hostile keys converge across two peers, and a targeted despawn severs only the right incoming edges", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => {
      for (const t of HOSTILE) a.snap.addRelation(K("src"), Kids, t);
      a.snap.setRelation(K("src"), Parent, HOSTILE[2]);
    });
    sync(a, b);
    expect([...b.snap.getRelationMany(K("src"), Kids)].sort()).toEqual([...HOSTILE].sort());

    // Despawn one hostile target → its incoming edges (the Parent one + its Kids edge) vanish, others stay.
    a.snap.commit(() => a.snap.despawn(HOSTILE[2]));
    sync(a, b);
    for (const p of [a, b]) {
      expect(p.snap.getRelationOne(K("src"), Parent)).toBeUndefined(); // pointed at HOSTILE[2]
      const kids = p.snap.getRelationMany(K("src"), Kids);
      expect(kids).not.toContain(HOSTILE[2]);
      expect(kids.sort()).toEqual(HOSTILE.filter((h) => h !== HOSTILE[2]).sort());
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("awkward-value battery through the adapter", () => {
  it("f32 fround, integer wrap, and NaN/±Inf survive a write and a round-trip (loro stores them)", () => {
    const a = peer(1);
    a.snap.commit(() => {
      a.snap.setComponent(K("e1"), Pos, { x: 0.1, y: 0.2 }); // f32 fround
      a.snap.setComponent(K("e1"), Tile, { u: 300, i: 70000 }); // u8 wrap 300→44; i16 wrap
      a.snap.setComponent(K("e1"), Misc, { v: NaN }); // NaN — loro stores it (unlike JSON export)
      a.snap.setComponent(K("e2"), Misc, { v: Infinity });
    });

    const pos = a.snap.getComponent(K("e1"), Pos)!;
    expect(pos.x).toBe(Math.fround(0.1));
    expect(pos.x).not.toBe(0.1);
    const tile = a.snap.getComponent(K("e1"), Tile)!;
    expect(tile.u).toBe(44); // 300 & 0xFF
    expect(Number.isNaN(a.snap.getComponent(K("e1"), Misc)!.v)).toBe(true);
    expect(a.snap.getComponent(K("e2"), Misc)!.v).toBe(Infinity);

    // Round-trip: the peer reads the SAME canonical values (NaN included).
    const b = peer(2);
    b.snap.applyRemote(a.snap.export());
    expect(b.snap.getComponent(K("e1"), Pos)).toEqual(pos);
    expect(b.snap.getComponent(K("e1"), Tile)).toEqual(tile);
    expect(Number.isNaN(b.snap.getComponent(K("e1"), Misc)!.v)).toBe(true);
    expect(b.snap.getComponent(K("e2"), Misc)!.v).toBe(Infinity);
  });
});

/** A fresh raw LoroDoc (peer 99) exposed for writing hostile/foreign layouts by hand. `commit` seals it. */
function rawDoc(peerId = 99): LoroDoc {
  const d = new LoroDoc();
  d.setPeerId(peerId);
  return d;
}

// ---------------------------------------------------------------------------------------------------
describe("input hardening — a hostile peer cannot wedge the adapter (review fix 1)", () => {
  it("malformed relN: keys are skipped totally — reads stay total, despawn completes, valid facts survive", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = rawDoc();
    const e1 = raw.getMap("entities").setContainer("e1", new LoroMap());
    e1.set("exists", true);
    e1.set('relN:["LSkid","t1"]', true); // WELL-FORMED Kids edge to "t1"
    e1.set("relN:junk", true); // JSON.parse THROWS
    e1.set("relN:123", true); // parses to a NUMBER — must be shape-rejected
    const e2 = raw.getMap("entities").setContainer("e2", new LoroMap());
    e2.set("exists", true);
    raw.commit({ message: "strata:0" });

    const recv = peer(20);
    const batches = recv.snap.applyRemote(raw.export({ mode: "snapshot" }));

    // The well-formed edge surfaced; the junk keys produced no event.
    const facts = batches.flatMap((b) => b.events);
    expect(facts).toContainEqual(expect.objectContaining({ kind: "relation-add", rel: Kids, target: K("t1") }));
    expect(facts.some((e) => JSON.stringify(e).includes("junk") || JSON.stringify(e).includes("123"))).toBe(false);

    // Reads stay TOTAL despite the junk keys.
    expect(recv.snap.getRelationMany(K("e1"), Kids)).toEqual([K("t1")]);
    expect(recv.snap.readEntity(K("e1"))).toBeDefined();

    // Despawn of ANOTHER entity completes (removeIncoming scans e1's junk keys without throwing).
    expect(() => recv.snap.commit(() => recv.snap.despawn(K("e2")))).not.toThrow();
    expect(recv.snap.hasEntity(K("e2"))).toBe(false);
    // And despawn of the junk-bearing entity itself completes.
    expect(() => recv.snap.commit(() => recv.snap.despawn(K("e1")))).not.toThrow();
    expect(recv.snap.hasEntity(K("e1"))).toBe(false);
  });

  it("non-LoroMap values in the entities map read absent, don't brick despawn, and HEAL on local spawn", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = rawDoc();
    raw.getMap("entities").set("g1", 42); // plain value poison
    const txt = raw.getMap("entities").setContainer("g2", new LoroText()); // wrong container kind
    txt.insert(0, "hi");
    const good = raw.getMap("entities").setContainer("e1", new LoroMap());
    good.set("exists", true);
    good.set("comp:LSPos", { x: 1, y: 2 });
    raw.commit({ message: "strata:0" });

    const recv = peer(20);
    expect(() => recv.snap.applyRemote(raw.export({ mode: "snapshot" }))).not.toThrow();

    // Poisoned keys read absent; only the well-formed entity is live.
    expect(recv.snap.hasEntity(K("g1"))).toBe(false);
    expect(recv.snap.hasEntity(K("g2"))).toBe(false);
    expect(recv.snap.getComponent(K("g1"), Pos)).toBeUndefined();
    expect([...recv.snap.entities()]).toEqual([K("e1")]);

    // Despawn (whose removeIncoming scans every entity-map value incl. the poison) does not throw.
    expect(() => recv.snap.commit(() => recv.snap.despawn(K("e1")))).not.toThrow();

    // HEAL: a local spawn on the poisoned key overwrites it via setContainer.
    recv.snap.commit(() => {
      recv.snap.spawn(K("g1"));
      recv.snap.setComponent(K("g1"), Pos, { x: 7, y: 8 });
    });
    expect(recv.snap.hasEntity(K("g1"))).toBe(true);
    expect(recv.snap.getComponent(K("g1"), Pos)).toEqual({ x: 7, y: 8 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("commit-boundary integrity (review fix 2)", () => {
  it("commit×2 + undo×2 over the wire → the receiver gets 4 distinct batches (no coalescing)", () => {
    const a = peer(10);
    const b = peer(20);
    // Create + SHARE e1 first, so neither undoable op is the container creation (undoing that would delete
    // the container and re-open the getPathToContainer hole — separately covered).
    a.snap.commit(() => a.snap.spawn(K("e1")));
    sync(a, b);

    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 })); // commit 0
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 })); // commit 1
    a.snap.undo(); // reverts commit 1
    a.snap.undo(); // reverts commit 0

    // b already holds the shared spawn, so applyRemote surfaces ONLY the 4 new changes.
    const batches = b.snap.applyRemote(a.snap.export());
    expect(batches).toHaveLength(4);
  });

  it("session restart reusing the peer id keeps boundaries distinct (commitSeq seeded from history)", () => {
    const doc1 = new LoroDoc();
    doc1.setPeerId(50);
    const s1 = new LoroSnapshot(doc1);
    s1.commit(() => s1.setComponent(K("e1"), Pos, { x: 1, y: 1 })); // strata:0
    const persisted = s1.export();

    // Reload: SAME peer id, import the persisted history, THEN construct (seeds commitSeq past strata:0).
    const doc2 = new LoroDoc();
    doc2.setPeerId(50);
    doc2.import(persisted);
    const s2 = new LoroSnapshot(doc2);
    s2.commit(() => s2.setComponent(K("e1"), Pos, { x: 2, y: 2 })); // must be strata:1, not a reused strata:0

    const receiver = peer(60);
    receiver.snap.commit(() => receiver.snap.spawn(K("r0"))); // non-empty → per-commit path (task #75)
    const batches = receiver.snap.applyRemote(s2.export());
    expect(batches).toHaveLength(2); // one reused "strata:0" would COALESCE the two into a single batch
    expect(receiver.snap.getComponent(K("e1"), Pos)).toEqual({ x: 2, y: 2 });
  });

  it("an untagged foreign writer triggers exactly one DEV warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = rawDoc();
    const child = raw.getMap("entities").setContainer("e1", new LoroMap());
    child.set("exists", true);
    raw.commit({ message: "appA" }); // NOT a strata tag
    child.set("comp:LSPos", { x: 1, y: 1 });
    raw.commit({ message: "appB" }); // NOT a strata tag — a second, distinct foreign change

    // The untagged-writer diagnostic lives on the per-commit path; a fresh doc's bootstrap import
    // never inspects commit boundaries (task #75) — seed local state so the boundary path runs.
    const receiver = peer(20);
    receiver.snap.commit(() => receiver.snap.spawn(K("r0")));
    receiver.snap.applyRemote(raw.export({ mode: "snapshot" }));
    const untagged = warn.mock.calls.filter((c) => String(c[0]).includes("untagged"));
    expect(untagged).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("the no-delete layout (review fix 3)", () => {
  it("[spawn+set][set][despawn] → 3 batches with the earlier facts intact (finding (b) regression)", () => {
    const sender = peer(10);
    sender.snap.commit(() => {
      sender.snap.spawn(K("e1"));
      sender.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 });
    }); // commit 0
    sender.snap.commit(() => sender.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 })); // commit 1
    sender.snap.commit(() => sender.snap.despawn(K("e1"))); // commit 2

    const receiver = peer(20);
    receiver.snap.commit(() => receiver.snap.spawn(K("r0"))); // non-empty → per-commit path (task #75)
    const batches = receiver.snap.applyRemote(sender.snap.export());
    expect(batches).toHaveLength(3);
    expect(batches[0].events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 1, y: 1 } }),
    );
    expect(batches[1].events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 2, y: 2 } }),
    );
    expect(batches[2].events).toContainEqual(expect.objectContaining({ kind: "despawn", key: K("e1") }));
  });

  it("[spawn+set][set][despawn] into a FRESH doc → NO batch: the bootstrap nets to absence (task #75)", () => {
    const sender = peer(10);
    sender.snap.commit(() => {
      sender.snap.spawn(K("e1"));
      sender.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 });
    });
    sender.snap.commit(() => sender.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 }));
    sender.snap.commit(() => sender.snap.despawn(K("e1")));

    const receiver = peer(20);
    const batches = receiver.snap.applyRemote(sender.snap.export());
    // The converged doc holds only e1's empty container (reads absent) — a world attached to the
    // receiver has nothing to hear. The doc state still imported fully (a later resurrect works).
    expect(batches).toEqual([]);
    expect(receiver.snap.hasEntity(K("e1"))).toBe(false);
    // sealedTo advanced past the import: the receiver's next LOCAL commit emits ONLY its own facts.
    const seen: string[] = [];
    receiver.snap.subscribe((b) => seen.push(...b.events.map((e) => e.kind)));
    receiver.snap.commit(() => receiver.snap.spawn(K("20-0")));
    expect(seen).toEqual(["spawn"]); // no re-emission of the imported history as "local"
  });

  it("concurrent resurrect into the shared container → BOTH peers' cells converge per-cell", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.spawn(K("e1")));
    sync(a, b); // both share the SAME container id
    a.snap.commit(() => a.snap.despawn(K("e1"))); // empties, keeps container
    sync(a, b);

    // Concurrent writes into that one shared container — different components.
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 }));
    b.snap.commit(() => b.snap.setComponent(K("e1"), Tile, { u: 5, i: 6 }));
    sync(a, b);

    for (const p of [a, b]) {
      expect(p.snap.getComponent(K("e1"), Pos)).toEqual({ x: 1, y: 1 });
      expect(p.snap.getComponent(K("e1"), Tile)).toEqual({ u: 5, i: 6 }); // NOT orphaned by container LWW
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("pending-import quarantine (review fix 4)", () => {
  it("a missing-deps import quarantines the adapter; export() still recovers local work", () => {
    const s = peer(10);
    s.snap.commit(() => s.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 })); // commit 0
    const vvAfter0 = s.doc.version();
    s.snap.commit(() => s.snap.setComponent(K("e1"), Pos, { x: 2, y: 2 })); // commit 1
    // Export ONLY the later half — it depends on commit 0, which the fresh receiver lacks → pending.
    const laterHalf = s.doc.export({ mode: "update", from: vvAfter0 });

    const recv = peer(20);
    recv.snap.commit(() => recv.snap.setComponent(K("z1"), Tile, { u: 1, i: 2 })); // local work to recover
    expect(() => recv.snap.applyRemote(laterHalf)).toThrow(PendingImportError);
    // Permanent: every future applyRemote throws.
    expect(() => recv.snap.applyRemote(new Uint8Array())).toThrow(PendingImportError);
    // The healthy-doc escape still works — local work is exportable.
    expect(() => recv.snap.export()).not.toThrow();
    expect(peer(30).snap.applyRemote(recv.snap.export())).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("commit-scope + reentrancy honesty (review fix 5)", () => {
  it("a throwing body still SEALS what it staged and emits it — local echo == receiver stream", () => {
    const a = peer(1);
    const seen: ChangeBatch[] = [];
    a.snap.subscribe((bt) => seen.push(bt));
    expect(() =>
      a.snap.commit(() => {
        a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("local");
    const receiver = peer(2);
    const [rbatch] = receiver.snap.applyRemote(a.snap.export());
    // The local echo and the receiver's stream agree on the staged fact.
    expect(seen[0].events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 1, y: 1 } }),
    );
    expect(rbatch.events).toContainEqual(
      expect.objectContaining({ kind: "component-set", comp: Pos, value: { x: 1, y: 1 } }),
    );
  });

  it("applyRemote / undo / redo THROW inside a commit scope", () => {
    const p = peer(1);
    expect(() => p.snap.commit(() => p.snap.applyRemote(new Uint8Array()))).toThrow(/applyRemote/);
    expect(() => p.snap.commit(() => p.snap.undo())).toThrow(/undo/);
    expect(() => p.snap.commit(() => p.snap.redo())).toThrow(/redo/);
  });

  it("export() seals staged (uncommitted) writes — local subscriber sees the batch, receiver stream identical", () => {
    const p = peer(1);
    const seen: ChangeBatch[] = [];
    p.snap.subscribe((bt) => seen.push(bt));
    p.snap.setComponent(K("e1"), Pos, { x: 3, y: 4 }); // staged, NO commit
    expect(seen).toHaveLength(0);
    const bytes = p.snap.export(); // seals the staged write
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("local");

    const [rbatch] = peer(2).snap.applyRemote(bytes);
    expect(rbatch.events).toEqual(
      seen[0].events.map((e) => ({ ...e, origin: "remote" })),
    );
  });
});

// ---------------------------------------------------------------------------------------------------
describe("undo semantics — the corrected invariant (review fix 6)", () => {
  it("undo CLOBBERS a causally-newer remote overwrite of the same cell (NOT 'leaves peer edits untouched')", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 }));
    sync(a, b);
    a.snap.commit(() => a.snap.setComponent(K("e1"), Pos, { x: 5, y: 5 })); // A's undoable op
    sync(a, b);
    b.snap.commit(() => b.snap.setComponent(K("e1"), Pos, { x: 9, y: 9 })); // causally NEWER remote overwrite
    sync(a, b);

    a.snap.undo(); // re-asserts {x:1,y:1} as a NEW lamport-latest op — clobbers B's {x:9,y:9}
    sync(a, b);
    for (const p of [a, b]) {
      expect(p.snap.getComponent(K("e1"), Pos)).toEqual({ x: 1, y: 1 });
    }
  });

  it("undoing a spawn commit despawns the entity — taking a peer's LATER component with it", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.spawn(K("e1"))); // A's undoable op (the spawn)
    sync(a, b);
    b.snap.commit(() => b.snap.setComponent(K("e1"), Tile, { u: 3, i: 4 })); // B's LATER component
    sync(a, b);

    a.snap.undo(); // undoes the spawn — despawns e1
    sync(a, b);
    for (const p of [a, b]) {
      expect(p.snap.hasEntity(K("e1"))).toBe(false);
      expect(p.snap.getComponent(K("e1"), Tile)).toBeUndefined(); // B's later work erased
    }
  });

  it("nested containers at comp:/resource keys are skipped in both reads and events (+ warn)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = rawDoc();
    const e1 = raw.getMap("entities").setContainer("e1", new LoroMap());
    e1.set("exists", true);
    e1.setContainer("comp:LSPos", new LoroMap()); // hostile container at a comp key
    raw.getMap("resources").setContainer("LSCam", new LoroMap()); // hostile container at a resource key
    raw.commit({ message: "strata:0" });

    const recv = peer(20);
    const facts = recv.snap.applyRemote(raw.export({ mode: "snapshot" })).flatMap((b) => b.events);
    // No event leaks the container.
    expect(facts.some((e) => e.kind === "component-set")).toBe(false);
    expect(facts.some((e) => e.kind === "resource-set")).toBe(false);
    // Reads return undefined, not a live wasm handle.
    expect(recv.snap.getComponent(K("e1"), Pos)).toBeUndefined();
    expect(recv.snap.getResource(Cam)).toBeUndefined();
    // The entity is still live (its `exists` cell), just without the poisoned component.
    expect(recv.snap.hasEntity(K("e1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("concurrent structural convergence — pins that a loro upgrade shifting semantics fails loudly", () => {
  it("despawn-vs-edit into the existing container → per-cell LWW (partial-cell resurrection is legal)", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => {
      a.snap.spawn(K("e1"));
      a.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 });
    });
    sync(a, b);
    a.snap.commit(() => a.snap.despawn(K("e1"))); // clears exists + Pos
    b.snap.commit(() => b.snap.setComponent(K("e1"), Tile, { u: 7, i: 8 })); // adds a DIFFERENT cell
    sync(a, b);
    for (const p of [a, b]) {
      expect(p.snap.getComponent(K("e1"), Pos)).toBeUndefined(); // despawn's cell removal held
      expect(p.snap.getComponent(K("e1"), Tile)).toEqual({ u: 7, i: 8 }); // the concurrent add survived
      expect(p.snap.hasEntity(K("e1"))).toBe(true); // partial-cell resurrection — a live cell
    }
  });

  it("sequential despawn→respawn leaves the entity existent but cell-less", () => {
    const p = peer(1);
    p.snap.commit(() => {
      p.snap.spawn(K("e1"));
      p.snap.setComponent(K("e1"), Pos, { x: 1, y: 1 });
    });
    p.snap.commit(() => p.snap.despawn(K("e1")));
    p.snap.commit(() => p.snap.spawn(K("e1"))); // respawn (existence-only)
    expect(p.snap.hasEntity(K("e1"))).toBe(true);
    expect(p.snap.getComponent(K("e1"), Pos)).toBeUndefined(); // the despawn cleared it; respawn didn't restore
  });

  it("rel1 set-vs-targeted-remove converges (both peers agree)", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => a.snap.setRelation(K("e1"), Parent, K("t1")));
    sync(a, b);
    a.snap.commit(() => a.snap.setRelation(K("e1"), Parent, K("t2"))); // move the edge
    b.snap.commit(() => b.snap.removeRelation(K("e1"), Parent, K("t1"))); // targeted remove of the base
    sync(a, b);
    expect(a.snap.getRelationOne(K("e1"), Parent)).toBe(b.snap.getRelationOne(K("e1"), Parent));
  });

  it("tag add-vs-remove converges (both peers agree)", () => {
    const a = peer(1);
    const b = peer(2);
    a.snap.commit(() => {
      a.snap.spawn(K("e1"));
      a.snap.addTag(K("e1"), Sel);
    });
    sync(a, b);
    a.snap.commit(() => a.snap.removeTag(K("e1"), Sel));
    b.snap.commit(() => {
      b.snap.removeTag(K("e1"), Sel);
      b.snap.addTag(K("e1"), Sel); // net re-add — a REAL op that competes with A's remove
    });
    sync(a, b);
    expect(a.snap.hasTag(K("e1"), Sel)).toBe(b.snap.hasTag(K("e1"), Sel));
  });
});

// ---------------------------------------------------------------------------------------------------
describe("CRDT-path fuzz — commit/export/applyRemote reproduce the ladder (the conformance gap)", () => {
  const keys = keyPool(12);
  for (const seed of [1, 7, 42, 99]) {
    it(`chunked commits ship to a fresh peer: batch count == non-empty commits, state reproduced (seed ${seed})`, () => {
      const rng = mulberry32(seed ^ 0x0d0f);
      const ops = genOps(rng, { keys, opCount: 90 });

      const a = peer(seed * 2 + 1);
      const aLocal: ChangeBatch[] = [];
      a.snap.subscribe((bt) => aLocal.push(bt));

      // Chunk the op stream into commit() scopes of random size.
      for (let i = 0; i < ops.length; ) {
        const n = 1 + Math.floor(rng() * 5);
        const chunk = ops.slice(i, i + n);
        a.snap.commit(() => {
          for (const op of chunk) applyToStore(a.snap, op);
        });
        i += n;
      }

      // FRESH receiver → the bootstrap fast path (task #75): the whole history coalesces to at most
      // ONE converged batch, and replaying it must reproduce A's ladder state exactly — the same
      // oracle the per-commit path answers to.
      const b = peer(seed * 2 + 2);
      const bBatches = b.snap.applyRemote(a.snap.export());
      expect(bBatches.length).toBeLessThanOrEqual(1);
      const fromB = new BaselineSnapshot();
      for (const bt of bBatches) for (const e of normalizeBatch(bt.events)) applyEvent(fromB, e);
      expect(diffStores(fromB, a.snap, keys, CFM_SCHEMA)).toBeNull();

      // NON-EMPTY receiver → the per-commit path: one batch per non-empty commit (A's local echo and
      // B2's derived split agree in count), and the replay reproduces the same ladder state.
      const b2 = peer(seed * 2 + 200);
      b2.snap.commit(() => b2.snap.spawn(K("zz-preseed"))); // outside the fuzz key pool
      const b2Batches = b2.snap.applyRemote(a.snap.export());
      expect(b2Batches.length).toBe(aLocal.length);
      const fromB2 = new BaselineSnapshot();
      for (const bt of b2Batches) for (const e of normalizeBatch(bt.events)) applyEvent(fromB2, e);
      expect(diffStores(fromB2, a.snap, keys, CFM_SCHEMA)).toBeNull();

      // ...and so does replaying A's OWN local stream (A's subscribe stream ≡ B's derived stream at the state level).
      const fromA = new BaselineSnapshot();
      for (const bt of aLocal) for (const e of normalizeBatch(bt.events)) applyEvent(fromA, e);
      expect(diffStores(fromA, a.snap, keys, CFM_SCHEMA)).toBeNull();
    });
  }
});

/** Apply one ChangeEvent to a MutableSnapshot (the fuzz replay). Mirrors harness.applyEvent for this file. */
function applyEvent(store: BaselineSnapshot, e: ChangeEvent): void {
  switch (e.kind) {
    case "spawn": return store.spawn(e.key);
    case "despawn": return store.despawn(e.key);
    case "component-set": return store.setComponent(e.key, e.comp, e.value);
    case "component-remove": return store.removeComponent(e.key, e.comp);
    case "tag-add": return store.addTag(e.key, e.tag);
    case "tag-remove": return store.removeTag(e.key, e.tag);
    case "relation-set": return store.setRelation(e.key, e.rel, e.target);
    case "relation-add": return store.addRelation(e.key, e.rel, e.target);
    case "relation-remove": return store.removeRelation(e.key, e.rel, e.target);
    case "resource-set": return store.setResource(e.res, e.value);
    case "resource-remove": return store.removeResource(e.res);
  }
}

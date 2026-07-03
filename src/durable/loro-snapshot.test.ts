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
import { LoroDoc, LoroMap } from "loro-crdt";
import { entityKey, field } from "../core/field";
import { defineComponent, defineRelation, defineResource, defineTag } from "../core/schema";
import type { ChangeBatch } from "../substrate";
import { LoroSnapshot } from "./loro-snapshot";

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

    const receiver = peer(20);
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

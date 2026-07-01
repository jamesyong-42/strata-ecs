import { beforeEach, describe, expect, it } from "vitest";
import { RelationStore } from "./relations";
import { __resetSchemaForTesting, defineRelation } from "./schema";
import { type Entity, pack } from "./entity";

// Fabricated handles (slot, generation) — the store only cares that they're distinct u32s.
const a = pack(1, 1);
const b = pack(2, 1);
const c = pack(3, 1);
const d = pack(4, 1);

/** A liveness predicate backed by a mutable set, so we can simulate a target dangling. */
function aliveness(initial: Entity[]) {
  const set = new Set(initial);
  return { isAlive: (e: Entity) => set.has(e), kill: (e: Entity) => set.delete(e) };
}

let ChildOf: ReturnType<typeof defineRelation>;
let Targets: ReturnType<typeof defineRelation>;

beforeEach(() => {
  __resetSchemaForTesting();
  ChildOf = defineRelation("ChildOf", { arity: "one" });
  Targets = defineRelation("Targets", { arity: "many" });
});

describe("RelationStore — arity one", () => {
  it("sets, reads, and reverse-indexes a single target", () => {
    const { isAlive } = aliveness([a, b]);
    const r = new RelationStore(isAlive);
    r.setOne(ChildOf, a, b);
    expect(r.getOne(ChildOf, a)).toBe(b);
    expect(r.getReverse(ChildOf, b)).toEqual([a]);
  });

  it("replacing the target unlinks the old target's reverse edge", () => {
    const { isAlive } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.setOne(ChildOf, a, b);
    r.setOne(ChildOf, a, c);
    expect(r.getOne(ChildOf, a)).toBe(c);
    expect(r.getReverse(ChildOf, b)).toEqual([]); // b no longer pointed at
    expect(r.getReverse(ChildOf, c)).toEqual([a]);
  });

  it("removes with a matching or undefined target, and no-ops on a non-matching target", () => {
    const { isAlive } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.setOne(ChildOf, a, b);
    r.remove(ChildOf, a, c); // non-matching target → strict no-op
    expect(r.getOne(ChildOf, a)).toBe(b);
    expect(r.getReverse(ChildOf, b)).toEqual([a]);
    r.remove(ChildOf, a, b); // matching target → drop edge + reverse
    expect(r.getOne(ChildOf, a)).toBeUndefined();
    expect(r.getReverse(ChildOf, b)).toEqual([]);
    r.setOne(ChildOf, a, c);
    r.remove(ChildOf, a); // undefined target → drop the single edge + reverse
    expect(r.getOne(ChildOf, a)).toBeUndefined();
    expect(r.getReverse(ChildOf, c)).toEqual([]);
  });
});

describe("RelationStore — arity many", () => {
  it("adds edges idempotently and reverse-indexes each", () => {
    const { isAlive } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.addMany(Targets, a, b);
    r.addMany(Targets, a, c);
    r.addMany(Targets, a, b); // idempotent (Set dedup)
    expect(r.getMany(Targets, a).sort()).toEqual([b, c].sort());
    expect(r.getReverse(Targets, b)).toEqual([a]);
    expect(r.hasAny(Targets, a)).toBe(true);
  });

  it("removes one edge or all edges", () => {
    const { isAlive } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.addMany(Targets, a, b);
    r.addMany(Targets, a, c);
    r.remove(Targets, a, b); // one edge
    expect(r.getMany(Targets, a)).toEqual([c]);
    expect(r.getReverse(Targets, b)).toEqual([]);
    r.remove(Targets, a); // all edges
    expect(r.getMany(Targets, a)).toEqual([]);
    expect(r.hasAny(Targets, a)).toBe(false);
  });
});

describe("RelationStore — validate-on-read", () => {
  it("skips a dangling target whose handle is no longer alive", () => {
    const { isAlive, kill } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.setOne(ChildOf, a, b);
    r.addMany(Targets, c, b);
    kill(b); // b is despawned but its edges haven't been cleared yet
    expect(r.getOne(ChildOf, a)).toBeUndefined();
    expect(r.getMany(Targets, c)).toEqual([]);
    // reverse traversal from a live target is unaffected
    r.setOne(ChildOf, a, c);
    expect(r.getReverse(ChildOf, c)).toEqual([a]);
  });
});

describe("RelationStore — clearEntity (despawn cascade)", () => {
  it("clears outgoing edges and unlinks them from targets' reverse sets", () => {
    const { isAlive } = aliveness([a, b, c, d]);
    const r = new RelationStore(isAlive);
    r.addMany(Targets, a, b);
    r.addMany(Targets, a, c);
    r.setOne(ChildOf, a, d);
    r.clearEntity(a);
    expect(r.getMany(Targets, a)).toEqual([]);
    expect(r.getOne(ChildOf, a)).toBeUndefined();
    expect(r.getReverse(Targets, b)).toEqual([]); // a removed from b's reverse
    expect(r.getReverse(ChildOf, d)).toEqual([]);
  });

  it("clears incoming edges so reverse queries no longer return the destroyed entity", () => {
    const { isAlive } = aliveness([a, b, c]);
    const r = new RelationStore(isAlive);
    r.setOne(ChildOf, a, c); // a → c
    r.addMany(Targets, b, c); // b → c
    r.clearEntity(c); // destroy the target
    expect(r.getOne(ChildOf, a)).toBeUndefined(); // a's forward edge to c is gone
    expect(r.getMany(Targets, b)).toEqual([]);
    expect(r.getReverse(ChildOf, c)).toEqual([]);
  });

  it("handles a self-loop without error", () => {
    const { isAlive } = aliveness([a]);
    const r = new RelationStore(isAlive);
    r.addMany(Targets, a, a);
    expect(() => r.clearEntity(a)).not.toThrow();
    expect(r.getMany(Targets, a)).toEqual([]);
  });
});

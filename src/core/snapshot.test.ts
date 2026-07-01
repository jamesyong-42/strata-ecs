import { describe, expect, it } from "vitest";
import { createWorld } from "./world";
import { defineComponent, defineRelation, defineResource, defineTag } from "./schema";
import { enumOf } from "./field";
import { Not, defineQuery } from "./query";
import type { Entity } from "./entity";

const Position = defineComponent<{ x: number; y: number }>("Position", { x: "f32", y: "f32" });
const Health = defineComponent<{ current: number; max: number }>("Health", { current: "u16", max: "u16" });
const Name = defineComponent<{ value: string | null }>("Name", { value: "string" });
const Team = defineComponent<{ side: "Red" | "Blue" }>("Team", { side: enumOf({ Red: 1, Blue: 2 }) });
const Flag = defineComponent<{ on: boolean }>("Flag", { on: "bool" });
const Link = defineComponent<{ target: number }>("Link", { target: "eid" });
const Bond = defineComponent<{ a: number; b: number }>("Bond", { a: "eid", b: "eid" });
const Enemy = defineTag("Enemy");
const Frozen = defineTag("Frozen");
const ChildOf = defineRelation("ChildOf", { arity: "one" });
const Targets = defineRelation("Targets", { arity: "many" });
const Score = defineResource<{ value: number }>("Score", { value: "u32" });

const encodeJson = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

describe("snapshot round-trip", () => {
  it("restores components, tags, relations, and resources by value", () => {
    const w = createWorld({ name: "doc" });
    const a = w.spawn({ components: [[Position, { x: 1, y: 2 }], [Name, { value: "alice" }]], tags: [Enemy] });
    const b = w.spawn({ components: [[Health, { current: 3, max: 5 }], [Team, { side: "Blue" }], [Flag, { on: true }]], tags: [Frozen] });
    const c = w.spawn({ components: [[Name, { value: null }]] }); // null string, distinct from ""
    w.setRelation(b, ChildOf, a);
    w.addRelation(a, Targets, b);
    w.addRelation(a, Targets, c);
    w.setResource(Score, { value: 99 });

    const bytes = w.export();

    const w2 = createWorld();
    w2.import(bytes);

    const a2 = w2.firstOf(defineQuery([Position])) as Entity;
    const b2 = w2.firstOf(defineQuery([Health])) as Entity;
    const c2 = w2.firstOf(defineQuery([Name, Not(Position)])) as Entity;

    expect(w2.read(a2, Position)).toEqual({ x: 1, y: 2 });
    expect(w2.read(a2, Name)).toEqual({ value: "alice" });
    expect(w2.hasTag(a2, Enemy)).toBe(true);

    expect(w2.read(b2, Health)).toEqual({ current: 3, max: 5 });
    expect(w2.read(b2, Team)).toEqual({ side: "Blue" }); // enum label round-trips
    expect(w2.read(b2, Flag)).toEqual({ on: true });
    expect(w2.hasTag(b2, Frozen)).toBe(true);

    expect(w2.read(c2, Name)).toEqual({ value: null }); // null preserved

    // Relations resolved across the dense-id remap (two-phase load).
    expect(w2.getRelation(b2, ChildOf)).toBe(a2);
    expect([...w2.getRelations(a2, Targets)].sort()).toEqual([b2, c2].sort());

    expect(w2.getResource(Score)).toEqual({ value: 99 });
  });

  it("remaps eid fields to the correct restored entity", () => {
    const w = createWorld();
    const x = w.spawn({ components: [[Position, { x: 7, y: 8 }]] });
    w.spawn({ components: [[Link, { target: x }]] });

    const w2 = createWorld();
    w2.import(w.export());
    const x2 = w2.firstOf(defineQuery([Position])) as Entity;
    const y2 = w2.firstOf(defineQuery([Link])) as Entity;
    expect(w2.read(y2, Link).target).toBe(x2); // eid remapped, not a stale handle
  });

  it("remaps ALL eid fields of a multi-eid component and preserves the empty string", () => {
    const w = createWorld();
    const p = w.spawn({ components: [[Position, { x: 1, y: 1 }], [Name, { value: "" }]] }); // empty string, ≠ null
    const q = w.spawn({ components: [[Health, { current: 1, max: 1 }]] });
    w.spawn({ components: [[Bond, { a: p, b: q }]] });

    const w2 = createWorld();
    w2.import(w.export());
    const p2 = w2.firstOf(defineQuery([Position])) as Entity;
    const q2 = w2.firstOf(defineQuery([Health])) as Entity;
    const bond2 = w2.firstOf(defineQuery([Bond])) as Entity;
    expect(w2.read(bond2, Bond)).toEqual({ a: p2, b: q2 }); // both eid fields remapped
    expect(w2.read(p2, Name)).toEqual({ value: "" }); // "" restored distinctly from null
  });

  it("nulls an eid field that points outside the snapshot", () => {
    const w = createWorld();
    const target = w.spawn();
    const holder = w.spawn({ components: [[Link, { target }]] });
    w.destroy(target); // holder's eid now dangles; target is not in the snapshot
    void holder;

    const w2 = createWorld();
    w2.import(w.export());
    const y2 = w2.firstOf(defineQuery([Link])) as Entity;
    expect(w2.read(y2, Link).target).toBe(0); // NULL_ENTITY
  });

  it("restores a tag-only entity in the empty archetype", () => {
    const w = createWorld();
    w.spawn({ tags: [Enemy] }); // no components
    const w2 = createWorld();
    w2.import(w.export());
    expect(w2.firstOf(defineQuery([Enemy]))).toBeDefined();
    expect(w2.firstOf(defineQuery([Enemy, Not(Position)]))).toBeDefined();
  });
});

describe("snapshot errors", () => {
  it("import requires an empty world", () => {
    const bytes = createWorld().export();
    const w = createWorld();
    w.spawn();
    expect(() => w.import(bytes)).toThrow(/empty world/);
  });

  it("rejects an unknown schema name", () => {
    const bogus = encodeJson({
      meta: { name: "x", format_version: 1 },
      resources: {},
      entities: [{ id: 0, components: { Nonexistent: {} }, tags: [], relations: {} }],
    });
    expect(() => createWorld().import(bogus)).toThrow(/unknown component "Nonexistent"/);
  });

  it("rejects an unsupported format version", () => {
    const bad = encodeJson({ meta: { name: "x", format_version: 99 }, resources: {}, entities: [] });
    expect(() => createWorld().import(bad)).toThrow(/format version/);
  });
});

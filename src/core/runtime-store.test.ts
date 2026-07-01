import { describe, expect, it } from "vitest";
import { RuntimeStore } from "./runtime-store";
import { defineComponent, defineRelation, defineResource, defineTag } from "./schema";
import { enumOf, field } from "./field";
import { slotOf } from "./entity";

// Schema is process-global; this file's module context is isolated by Vitest, so define once.
const Position = defineComponent<{ x: number; y: number }>("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent<{ x: number; y: number }>("Velocity", { x: "f32", y: "f32" });
const Health = defineComponent<{ current: number; max: number }>("Health", { current: "u16", max: "u16" });
const Name = defineComponent<{ value: string | null }>("Name", { value: "string" });
const Label = defineComponent<{ text: string | null }>("Label", { text: field("string", { default: "" }) });
const Team = defineComponent<{ side: "Red" | "Blue" | "Neutral" }>("Team", {
  side: enumOf({ Red: 1, Blue: 2, Neutral: 3 }),
});
const Ref = defineComponent<{ target: number }>("Ref", { target: "eid" });
const Flag = defineComponent<{ on: boolean }>("Flag", { on: "bool" });
const Score = defineResource<{ value: number }>("Score", { value: "u32" });
const Cfg = defineResource<{ a: number; b: number }>("Cfg", {
  a: field("u32", { default: 7 }),
  b: "u32",
});
const Enemy = defineTag("Enemy");
const Frozen = defineTag("Frozen");
const ChildOf = defineRelation("ChildOf", { arity: "one" });
const Targets = defineRelation("Targets", { arity: "many" });

describe("spawn / placement / reads", () => {
  it("spawns a componentless entity into the empty archetype (placed, queryable)", () => {
    const s = new RuntimeStore();
    const e = s.spawn();
    expect(s.isAlive(e)).toBe(true);
    expect(s.isPlaced(e)).toBe(true);
    expect(s.has(e, Position)).toBe(false);
  });

  it("spawns with components and reads them back", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    expect(s.has(e, Position)).toBe(true);
    expect(s.read(e, Position)).toEqual({ x: 1, y: 2 });
    expect(s.has(e, Velocity)).toBe(false);
  });

  it("read throws on an absent component; get returns undefined", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    expect(() => s.read(e, Velocity)).toThrow(/not present/);
    expect(s.get(e, Velocity)).toBeUndefined();
    expect(s.get(e, Position)).toEqual({ x: 1, y: 2 });
  });

  it("throws when the same component is supplied twice to spawn", () => {
    const s = new RuntimeStore();
    expect(() => s.spawn({ components: [[Position, { x: 0, y: 0 }], [Position, { x: 1, y: 1 }]] })).toThrow(
      /supplied twice/,
    );
  });
});

describe("addComponent / removeComponent (migration)", () => {
  it("adds a component, preserving existing field values across migration", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 3, y: 4 }]] });
    s.addComponent(e, Velocity, { x: 1, y: -1 });
    expect(s.read(e, Position)).toEqual({ x: 3, y: 4 }); // carried through the migrate
    expect(s.read(e, Velocity)).toEqual({ x: 1, y: -1 });
  });

  it("throws when adding a component that is already present", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(() => s.addComponent(e, Position, { x: 9, y: 9 })).toThrow(/already present/);
  });

  it("adds a first component to a componentless entity", () => {
    const s = new RuntimeStore();
    const e = s.spawn(); // empty archetype
    s.addComponent(e, Health, { current: 10, max: 10 });
    expect(s.read(e, Health)).toEqual({ current: 10, max: 10 });
  });

  it("removes a component (migrating to a smaller archetype)", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }], [Velocity, { x: 5, y: 6 }]] });
    s.removeComponent(e, Velocity);
    expect(s.has(e, Velocity)).toBe(false);
    expect(s.read(e, Position)).toEqual({ x: 1, y: 2 });
  });

  it("removing the last component leaves the entity placed in the empty archetype", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    s.removeComponent(e, Position);
    expect(s.isPlaced(e)).toBe(true);
    expect(s.has(e, Position)).toBe(false);
  });

  it("throws when removing an absent component", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(() => s.removeComponent(e, Velocity)).toThrow(/not present/);
  });
});

describe("writeComponent (value write)", () => {
  it("overwrites a present component's value; throws if absent", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    s.writeComponent(e, Position, { x: 10, y: 20 });
    expect(s.read(e, Position)).toEqual({ x: 10, y: 20 });
    expect(() => s.writeComponent(e, Velocity, { x: 0, y: 0 })).toThrow(/not present/);
  });
});

describe("enums, bools, strings", () => {
  it("round-trips enum labels through the discriminant column", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Team, { side: "Red" }]] });
    expect(s.read(e, Team)).toEqual({ side: "Red" });
    s.writeComponent(e, Team, { side: "Blue" });
    expect(s.read(e, Team)).toEqual({ side: "Blue" });
    expect(() => s.writeComponent(e, Team, { side: "Green" as "Red" })).toThrow(/not a variant/);
  });

  it("round-trips bools", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Flag, { on: true }]] });
    expect(s.read(e, Flag)).toEqual({ on: true });
    s.writeComponent(e, Flag, { on: false });
    expect(s.read(e, Flag)).toEqual({ on: false });
  });

  it("distinguishes unset (null) from empty string, and applies string defaults", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Name, { value: "foo" }]] });
    expect(s.read(a, Name)).toEqual({ value: "foo" });
    const b = s.spawn({ components: [[Name, { value: null }]] });
    expect(s.read(b, Name)).toEqual({ value: null });
    const c = s.spawn({ components: [[Label, {}]] }); // text omitted → default ""
    expect(s.read(c, Label)).toEqual({ text: "" });
  });
});

describe("swap-and-pop & the string-null invariant", () => {
  it("fixes the moved entity's back-pointer on destroy", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const b = s.spawn({ components: [[Position, { x: 1, y: 1 }]] });
    const c = s.spawn({ components: [[Position, { x: 2, y: 2 }]] });
    s.destroy(b); // b at row 1; c (last) swaps into row 1 — its back-pointer must be fixed
    expect(s.isAlive(b)).toBe(false);
    expect(s.read(a, Position)).toEqual({ x: 0, y: 0 });
    expect(s.read(c, Position)).toEqual({ x: 2, y: 2 }); // c still resolves after the move
  });

  it("nulls the vacated string cell so a deleted label cannot leak", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Name, { value: "first" }]] });
    const b = s.spawn({ components: [[Name, { value: "second" }]] });
    const arch = s.debugArchetypeOf(b);
    if (!arch) throw new Error("expected placed");
    const col = arch.columns.get(Name.fields[0].fieldId) as (string | null)[];
    s.destroy(a); // a at row 0; b swaps into row 0, row 1 must be nulled
    expect(arch.count).toBe(1);
    expect(col[1]).toBe(null); // no dangling reference above count (§3.4)
    expect(s.read(b, Name)).toEqual({ value: "second" });
  });

  it("preserves string values through a migration", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Name, { value: "keep" }], [Position, { x: 1, y: 1 }]] });
    s.addComponent(e, Velocity, { x: 0, y: 0 }); // migrate to a larger archetype
    expect(s.read(e, Name)).toEqual({ value: "keep" });
  });
});

describe("destroy", () => {
  it("frees identity-only entities without a row", () => {
    const s = new RuntimeStore();
    const e = s.allocateIdentity();
    expect(s.isIdentityOnly(e)).toBe(true);
    s.destroy(e);
    expect(s.isAlive(e)).toBe(false);
  });

  it("is a no-op on a stale handle", () => {
    const s = new RuntimeStore();
    const e = s.spawn();
    s.destroy(e);
    expect(() => s.destroy(e)).not.toThrow();
  });

  it("rejects structural mutation on a dead handle without corrupting a reused slot (RS-1)", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    s.destroy(e);
    const e2 = s.spawn(); // reuses e's freed slot, placed in the empty archetype
    expect(slotOf(e2)).toBe(slotOf(e));
    // The stale handle must not be treated as identity-only and placed — that would stamp e2's slot.
    expect(() => s.addComponent(e, Velocity, { x: 1, y: 1 })).toThrow(/dead or stale/);
    expect(() => s.writeComponent(e, Position, { x: 1, y: 1 })).toThrow(/dead or stale/);
    expect(() => s.removeComponent(e, Position)).toThrow(/dead or stale/);
    // e2 is untouched: still placed in the empty archetype, no phantom Velocity row.
    expect(s.isPlaced(e2)).toBe(true);
    expect(s.has(e2, Velocity)).toBe(false);
    expect(s.has(e2, Position)).toBe(false);
  });
});

describe("readEid", () => {
  it("returns the referenced entity, or undefined once it dangles", () => {
    const s = new RuntimeStore();
    const target = s.spawn();
    const holder = s.spawn({ components: [[Ref, { target }]] });
    const fid = Ref.fields[0].fieldId;
    expect(s.readEid(holder, Ref, fid)).toBe(target);
    s.destroy(target);
    expect(s.readEid(holder, Ref, fid)).toBeUndefined(); // validate-on-read caught the stale ref
  });

  it("returns undefined for an identity-only or component-less holder", () => {
    const s = new RuntimeStore();
    const fid = Ref.fields[0].fieldId;
    expect(s.readEid(s.allocateIdentity(), Ref, fid)).toBeUndefined(); // identity-only (no row)
    expect(s.readEid(s.spawn(), Ref, fid)).toBeUndefined(); // placed but lacks Ref
  });
});

describe("resources", () => {
  it("sets/gets a resource and reports unset as undefined", () => {
    const s = new RuntimeStore();
    expect(s.getResource(Score)).toBeUndefined();
    s.setResource(Score, { value: 42 });
    expect(s.getResource(Score)).toEqual({ value: 42 });
  });

  it("applies a declared default and throws on a missing required field", () => {
    const s = new RuntimeStore();
    s.setResource(Cfg, { b: 1 } as { a: number; b: number }); // a omitted → default 7
    expect(s.getResource(Cfg)).toEqual({ a: 7, b: 1 });
    expect(() => s.setResource(Cfg, {} as { a: number; b: number })).toThrow(/missing required field "b"/);
  });
});

describe("projectComponent", () => {
  it("places an identity-only entity on its first projected component", () => {
    const s = new RuntimeStore();
    const e = s.allocateIdentity();
    s.projectComponent(e, Position, { x: 1, y: 2 });
    expect(s.isPlaced(e)).toBe(true);
    expect(s.read(e, Position)).toEqual({ x: 1, y: 2 });
  });

  it("adds when absent and overwrites when present", () => {
    const s = new RuntimeStore();
    const e = s.spawn();
    s.projectComponent(e, Position, { x: 1, y: 1 }); // absent → add (migrate from empty)
    expect(s.read(e, Position)).toEqual({ x: 1, y: 1 });
    s.projectComponent(e, Position, { x: 9, y: 9 }); // present → overwrite
    expect(s.read(e, Position)).toEqual({ x: 9, y: 9 });
  });
});

describe("column growth", () => {
  it("preserves values across archetype capacity doublings", () => {
    const s = new RuntimeStore();
    const handles = [];
    for (let i = 0; i < 200; i++) {
      handles.push(s.spawn({ components: [[Position, { x: i, y: -i }]] }));
    }
    for (let i = 0; i < handles.length; i++) {
      expect(s.read(handles[i], Position)).toEqual({ x: i, y: -i });
      expect(slotOf(handles[i])).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("tags", () => {
  it("spawns with tags into the empty archetype (placed + tagged + queryable)", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ tags: [Enemy] });
    expect(s.isPlaced(e)).toBe(true);
    expect(s.hasTag(e, Enemy)).toBe(true);
    expect(s.hasTag(e, Frozen)).toBe(false);
  });

  it("addTag places an identity-only source; removeTag does not unplace", () => {
    const s = new RuntimeStore();
    const e = s.allocateIdentity();
    s.addTag(e, Enemy);
    expect(s.isPlaced(e)).toBe(true); // ensurePlaced ran
    expect(s.hasTag(e, Enemy)).toBe(true);
    s.removeTag(e, Enemy);
    expect(s.hasTag(e, Enemy)).toBe(false);
    expect(s.isPlaced(e)).toBe(true); // still placed
  });

  it("generation-guards hasTag and starts a reused slot clean", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ tags: [Enemy] });
    s.destroy(e);
    expect(s.hasTag(e, Enemy)).toBe(false); // stale handle
    const e2 = s.spawn(); // reuses the slot
    expect(slotOf(e2)).toBe(slotOf(e));
    expect(s.hasTag(e2, Enemy)).toBe(false); // reused slot inherits no tags (§5.5)
  });

  it("keeps a tag across archetype migration (slot-indexed, migration-invariant)", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]], tags: [Frozen] });
    s.addComponent(e, Velocity, { x: 0, y: 0 }); // migrates to a new archetype
    expect(s.hasTag(e, Frozen)).toBe(true);
    expect(s.read(e, Position)).toEqual({ x: 1, y: 2 });
  });

  it("addTag on a component-bearing entity does not disturb its archetype or values (§5.2)", () => {
    const s = new RuntimeStore();
    const e = s.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    const arch = s.debugArchetypeOf(e);
    s.addTag(e, Enemy); // ensurePlaced must no-op — the entity is already placed
    expect(s.debugArchetypeOf(e)).toBe(arch); // no migration / re-placement
    expect(s.read(e, Position)).toEqual({ x: 1, y: 2 });
    expect(s.hasTag(e, Enemy)).toBe(true);
  });
});

describe("relations", () => {
  it("sets an arity-one relation, placing the source but not the target", () => {
    const s = new RuntimeStore();
    const source = s.allocateIdentity();
    const target = s.allocateIdentity();
    s.setRelation(source, ChildOf, target);
    expect(s.getRelation(source, ChildOf)).toBe(target);
    expect(s.getReverse(target, ChildOf)).toEqual([source]);
    expect(s.isPlaced(source)).toBe(true); // ensurePlaced
    expect(s.isIdentityOnly(target)).toBe(true); // pointed-at ≠ placed (§5.2)
  });

  it("adds arity-many edges and reads them back", () => {
    const s = new RuntimeStore();
    const a = s.spawn();
    const b = s.spawn();
    const c = s.spawn();
    s.addRelation(a, Targets, b);
    s.addRelation(a, Targets, c);
    expect(s.getRelations(a, Targets).sort()).toEqual([b, c].sort());
    expect(s.getReverse(b, Targets)).toEqual([a]);
  });

  it("enforces arity", () => {
    const s = new RuntimeStore();
    const a = s.spawn();
    const b = s.spawn();
    expect(() => s.setRelation(a, Targets, b)).toThrow(/arity "one"/);
    expect(() => s.addRelation(a, ChildOf, b)).toThrow(/arity "many"/);
  });

  it("clears both directions on despawn", () => {
    const s = new RuntimeStore();
    const parent = s.spawn();
    const child = s.spawn();
    s.setRelation(child, ChildOf, parent);
    // Destroying the TARGET clears the incoming edge from the source.
    s.destroy(parent);
    expect(s.getRelation(child, ChildOf)).toBeUndefined();

    const a = s.spawn();
    const x = s.spawn();
    s.addRelation(a, Targets, x);
    // Destroying the SOURCE clears the outgoing edge from the target's reverse set.
    s.destroy(a);
    expect(s.getReverse(x, Targets)).toEqual([]);
  });

  it("removeRelation drops edges through the store surface (both arities)", () => {
    const s = new RuntimeStore();
    const a = s.spawn();
    const b = s.spawn();
    const c = s.spawn();
    s.addRelation(a, Targets, b);
    s.addRelation(a, Targets, c);
    s.removeRelation(a, Targets, b); // one edge
    expect(s.getRelations(a, Targets)).toEqual([c]);
    s.removeRelation(a, Targets); // all remaining edges
    expect(s.getRelations(a, Targets)).toEqual([]);

    const child = s.spawn();
    const parent = s.spawn();
    s.setRelation(child, ChildOf, parent);
    s.removeRelation(child, ChildOf); // arity-one via the store
    expect(s.getRelation(child, ChildOf)).toBeUndefined();
    expect(s.getReverse(parent, ChildOf)).toEqual([]);
  });
});

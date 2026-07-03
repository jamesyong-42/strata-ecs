/**
 * `BaselineSnapshot` (Patch Note 005 §1, §2; M2). Covers every `MutableSnapshot` op, the THREE-PART
 * despawn (incoming edges from BOTH arities cleaned — property P2), canon-at-write (§2), `readEntity`
 * aggregation (§1.2 direction rule), and respawn-fresh (§4.2).
 */

import { describe, expect, it } from "vitest";
import { entityKey, field } from "../core/field";
import { defineComponent, defineRelation, defineResource, defineTag } from "../core/schema";
import { BaselineSnapshot } from "./baseline";

const Pos = defineComponent("BASEPos", { x: "f32", y: "f32" });
const Health = defineComponent("BASEHealth", { hp: "u8", max: field("u8", { default: 100 }) });
const Sel = defineTag("BASESel");
const Parent = defineRelation("BASEParent", { arity: "one" });
const Children = defineRelation("BASEChildren", { arity: "many" });
const Cam = defineResource("BASECam", { zoom: "f32" });

const A = entityKey("A");
const B = entityKey("B");
const Cq = entityKey("C");
const D = entityKey("D");

describe("BaselineSnapshot — entities + components", () => {
  it("spawn / hasEntity / entities() iteration", () => {
    const bs = new BaselineSnapshot();
    expect(bs.hasEntity(A)).toBe(false);
    bs.spawn(A);
    bs.spawn(B);
    expect(bs.hasEntity(A)).toBe(true);
    expect([...bs.entities()].sort()).toEqual(["A", "B"]);
  });

  it("setComponent stores the CANONICAL value — f32 0.1 reads back Math.fround(0.1) (§2)", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Pos, { x: 0.1, y: 0.2 });
    const v = bs.getComponent(A, Pos)!;
    expect(v.x).toBe(Math.fround(0.1));
    expect(v.x).not.toBe(0.1);
    expect(bs.hasEntity(A)).toBe(true); // a component makes the entity live
  });

  it("fills a declared default at write (via canon)", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Health, { hp: 5 });
    expect(bs.getComponent(A, Health)).toEqual({ hp: 5, max: 100 });
  });

  it("removeComponent drops just that cell", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Pos, { x: 1, y: 2 });
    bs.setComponent(A, Health, { hp: 3 });
    bs.removeComponent(A, Pos);
    expect(bs.getComponent(A, Pos)).toBeUndefined();
    expect(bs.getComponent(A, Health)).toEqual({ hp: 3, max: 100 });
  });
});

describe("BaselineSnapshot — tags", () => {
  it("addTag / hasTag / removeTag", () => {
    const bs = new BaselineSnapshot();
    expect(bs.hasTag(A, Sel)).toBe(false);
    bs.addTag(A, Sel);
    expect(bs.hasTag(A, Sel)).toBe(true);
    expect(bs.hasEntity(A)).toBe(true);
    bs.removeTag(A, Sel);
    expect(bs.hasTag(A, Sel)).toBe(false);
  });
});

describe("BaselineSnapshot — relations (arity-split)", () => {
  it("setRelation (one) / getRelationOne; replace drops the old target's incoming edge", () => {
    const bs = new BaselineSnapshot();
    bs.setRelation(A, Parent, B);
    expect(bs.getRelationOne(A, Parent)).toBe(B);
    bs.setRelation(A, Parent, Cq); // replace
    expect(bs.getRelationOne(A, Parent)).toBe(Cq);
    // B no longer has an incoming edge → despawning B must not resurrect A's Parent
    bs.despawn(B);
    expect(bs.getRelationOne(A, Parent)).toBe(Cq);
  });

  it("addRelation (many) / getRelationMany / removeRelation one + all", () => {
    const bs = new BaselineSnapshot();
    bs.addRelation(A, Children, B);
    bs.addRelation(A, Children, Cq);
    bs.addRelation(A, Children, B); // idempotent
    expect(bs.getRelationMany(A, Children).sort()).toEqual(["B", "C"]);
    bs.removeRelation(A, Children, B);
    expect(bs.getRelationMany(A, Children)).toEqual(["C"]);
    bs.removeRelation(A, Children); // target-less: all edges
    expect(bs.getRelationMany(A, Children)).toEqual([]);
  });

  it("setRelation throws on a many relation; addRelation throws on a one relation (arity enforced)", () => {
    const bs = new BaselineSnapshot();
    expect(() => bs.setRelation(A, Children, B)).toThrow(/arity "one"/);
    expect(() => bs.addRelation(A, Parent, B)).toThrow(/arity "many"/);
  });
});

describe("BaselineSnapshot — three-part despawn (§1.3, P2)", () => {
  it("removes the record, outgoing edges, AND incoming edges from BOTH arities", () => {
    const bs = new BaselineSnapshot();
    bs.spawn(A);
    bs.setComponent(A, Pos, { x: 1, y: 2 });
    bs.addTag(A, Sel);
    // outgoing from A
    bs.setRelation(A, Parent, D);
    bs.addRelation(A, Children, D);
    // incoming to A from BOTH arities
    bs.setRelation(B, Parent, A); // arity-one incoming
    bs.addRelation(Cq, Children, A); // arity-many incoming

    bs.despawn(A);

    // 1: record gone
    expect(bs.hasEntity(A)).toBe(false);
    expect(bs.getComponent(A, Pos)).toBeUndefined();
    expect(bs.readEntity(A)).toBeUndefined();
    // 2: outgoing gone
    expect(bs.getRelationOne(A, Parent)).toBeUndefined();
    expect(bs.getRelationMany(A, Children)).toEqual([]);
    // 3: incoming gone — no edge to A survives anywhere (scan both source keys)
    expect(bs.getRelationOne(B, Parent)).toBeUndefined();
    expect(bs.getRelationMany(Cq, Children)).toEqual([]);
  });
});

describe("BaselineSnapshot — readEntity aggregation (§1.2)", () => {
  it("aggregates cells into a record; arity one → scalar, many → array (§8.1)", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Pos, { x: 1, y: 2 });
    bs.addTag(A, Sel);
    bs.setRelation(A, Parent, B);
    bs.addRelation(A, Children, B);
    bs.addRelation(A, Children, Cq);
    const rec = bs.readEntity(A)!;
    expect(rec.key).toBe(A);
    expect(rec.components).toEqual({ BASEPos: { x: 1, y: 2 } });
    expect(rec.tags).toEqual(["BASESel"]);
    expect(rec.relations.BASEParent).toBe(B); // scalar
    expect([...(rec.relations.BASEChildren as string[])].sort()).toEqual(["B", "C"]); // array
  });
});

describe("BaselineSnapshot — respawn-fresh (§4.2)", () => {
  it("despawn→respawn yields a fresh record", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Pos, { x: 1, y: 2 });
    bs.addTag(A, Sel);
    bs.despawn(A);
    bs.spawn(A);
    expect(bs.hasEntity(A)).toBe(true);
    expect(bs.getComponent(A, Pos)).toBeUndefined();
    expect(bs.hasTag(A, Sel)).toBe(false);
    expect(bs.readEntity(A)).toEqual({ key: A, components: {}, tags: [], relations: {} });
  });

  it("spawn on an existing key also clears its own record (fresh)", () => {
    const bs = new BaselineSnapshot();
    bs.setComponent(A, Pos, { x: 1, y: 2 });
    bs.spawn(A);
    expect(bs.getComponent(A, Pos)).toBeUndefined();
  });
});

describe("BaselineSnapshot — resources", () => {
  it("setResource stores defaults-filled value; getResource; removeResource", () => {
    const bs = new BaselineSnapshot();
    expect(bs.getResource(Cam)).toBeUndefined();
    bs.setResource(Cam, { zoom: 0.5 });
    expect(bs.getResource(Cam)).toEqual({ zoom: 0.5 }); // object-backed: raw, not fround (§2)
    bs.removeResource(Cam);
    expect(bs.getResource(Cam)).toBeUndefined();
  });
});

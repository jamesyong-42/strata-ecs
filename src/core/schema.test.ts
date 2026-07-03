import { beforeEach, describe, expect, it } from "vitest";
import { enumOf, field } from "./field";
import {
  __resetSchemaForTesting,
  defineComponent,
  defineRelation,
  defineResource,
  defineTag,
  encodeComponentValue,
  isReservedName,
} from "./schema";

beforeEach(() => {
  __resetSchemaForTesting();
});

describe("defineComponent", () => {
  it("assigns dense component ids and global field ids", () => {
    const Position = defineComponent("Position", { x: "f32", y: "f32" });
    const Health = defineComponent("Health", { current: "u16", max: "u16" });
    expect(Position.id).toBe(0);
    expect(Health.id).toBe(1);
    // Field ids are global and dense across components.
    expect(Position.fields.map((f) => f.fieldId)).toEqual([0, 1]);
    expect(Health.fields.map((f) => f.fieldId)).toEqual([2, 3]);
    expect(Position.fieldByName.get("y")?.kind).toBe("f32");
  });

  it("throws on a duplicate name and on a reserved name", () => {
    defineComponent("Position", { x: "f32" });
    expect(() => defineComponent("Position", { x: "f32" })).toThrow(/already defined/);
    expect(() => defineTag("Local")).toThrow(/reserved framework identifier/);
    expect(isReservedName("Local")).toBe(true);
  });
});

describe("defineTag / defineRelation / defineResource", () => {
  it("assigns per-kind dense ids", () => {
    const A = defineTag("A");
    const B = defineTag("B");
    expect([A.id, B.id]).toEqual([0, 1]);
  });

  it("defaults relation arity to one", () => {
    const ChildOf = defineRelation("ChildOf");
    const Targets = defineRelation("Targets", { arity: "many" });
    expect(ChildOf).toMatchObject({ id: 0, arity: "one" });
    expect(Targets).toMatchObject({ id: 1, arity: "many" });
  });

  it("defines resources with a schema", () => {
    const Score = defineResource("Score", { value: "u32" });
    expect(Score.id).toBe(0);
    expect(Score.fieldByName.get("value")?.kind).toBe("u32");
  });
});

describe("encodeComponentValue", () => {
  it("encodes a complete value and applies declared defaults", () => {
    const Position = defineComponent("Position", {
      x: field("f32", { default: 0 }),
      y: "f32",
    });
    const [fx, fy] = Position.fields.map((f) => f.fieldId);
    const encoded = encodeComponentValue(Position, { y: 5 }); // x omitted → default 0
    expect(encoded.get(fx)).toBe(0);
    expect(encoded.get(fy)).toBe(5);
  });

  it("throws when a required field without a default is missing", () => {
    const Position = defineComponent("Position", { x: "f32", y: "f32" });
    expect(() => encodeComponentValue(Position, { x: 1 })).toThrow(/missing required field "y"/);
  });

  it("encodes enum labels to discriminants", () => {
    const Team = defineComponent("Team", { side: enumOf({ Red: 1, Blue: 2 }) });
    const fid = Team.fields[0].fieldId;
    expect(encodeComponentValue(Team, { side: "Blue" }).get(fid)).toBe(2);
  });
});

describe("__resetSchemaForTesting", () => {
  it("clears schema state so ids restart", () => {
    defineComponent("Position", { x: "f32" });
    __resetSchemaForTesting();
    const again = defineComponent("Position", { x: "f32" }); // no longer a duplicate
    expect(again.id).toBe(0);
    expect(isReservedName("Local")).toBe(true); // framework reservations survive reset
  });
});

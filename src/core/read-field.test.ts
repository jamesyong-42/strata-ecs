import { describe, expect, it } from "vitest";
import { type Entity, createWorld, defineComponent, enumOf } from "./index";

describe("readField — allocation-free single-field read (§Part I ref)", () => {
  it("reads numeric, string, enum, and eid fields, matching read()", () => {
    const Kind = enumOf(["a", "b", "c"]);
    const C = defineComponent<{ n: number; f: number; s: string; k: string; ref: Entity }>("RF_C", {
      n: "u32",
      f: "f64",
      s: "string",
      k: Kind,
      ref: "eid",
    });
    const w = createWorld();
    const target = w.spawn();
    const e = w.spawn({ components: [[C, { n: 42, f: 1.5, s: "hi", k: "b", ref: target }]] });

    expect(w.readField(e, C, "n")).toBe(42);
    expect(w.readField(e, C, "f")).toBe(1.5);
    expect(w.readField<string>(e, C, "s")).toBe("hi");
    expect(w.readField<string>(e, C, "k")).toBe("b"); // enum decodes to its label
    expect(w.readField<Entity>(e, C, "ref")).toBe(target);

    // agrees with the whole-component read
    const whole = w.read(e, C);
    expect(w.readField(e, C, "n")).toBe(whole.n);
    expect(w.readField(e, C, "f")).toBe(whole.f);
  });

  it("returns undefined for a missing component or unknown field name", () => {
    const A = defineComponent<{ x: number }>("RF_A", { x: "u32" });
    const B = defineComponent<{ y: number }>("RF_B", { y: "u32" });
    const w = createWorld();
    const e = w.spawn({ components: [[A, { x: 7 }]] });

    expect(w.readField(e, B, "y")).toBeUndefined(); // component absent
    expect(w.readField(e, A, "nope")).toBeUndefined(); // unknown field
    expect(w.readField(e, A, "x")).toBe(7);
  });
});

import { describe, expect, it } from "vitest";
import {
  allocColumn,
  clearCell,
  columnKindOf,
  decodeField,
  encodeField,
  enumOf,
  field,
  growColumn,
  moveCell,
  normalizeField,
  readCell,
  writeCell,
} from "./field";

describe("enumOf", () => {
  it("assigns positional discriminants", () => {
    const e = enumOf(["Red", "Blue", "Neutral"]);
    expect(e.labelToDisc.get("Red")).toBe(0);
    expect(e.labelToDisc.get("Neutral")).toBe(2);
    expect(e.maxDisc).toBe(2);
  });

  it("uses explicit discriminants", () => {
    const e = enumOf({ Red: 1, Blue: 2, Neutral: 3 });
    expect(e.labelToDisc.get("Red")).toBe(1);
    expect(e.discToLabel.get(3)).toBe("Neutral");
    expect(e.maxDisc).toBe(3);
  });

  it("rejects duplicate labels, out-of-range discriminants, and empty sets", () => {
    expect(() => enumOf({ A: 1, B: 1 })).toThrow(/duplicate enum discriminant/);
    expect(() => enumOf({ A: -1 })).toThrow(/\[0, 2\^32\)/);
    expect(() => enumOf({ A: 4_294_967_296 })).toThrow(/\[0, 2\^32\)/); // 2^32 would truncate in a u32 column
    expect(() => enumOf([])).toThrow(/at least one/);
  });

  it("routes to the smallest unsigned integer that fits", () => {
    expect(columnKindOf(enumOf({ A: 255 }))).toBe("u8");
    expect(columnKindOf(enumOf({ A: 256 }))).toBe("u16");
    expect(columnKindOf(enumOf({ A: 65535 }))).toBe("u16");
    expect(columnKindOf(enumOf({ A: 65536 }))).toBe("u32");
  });
});

describe("field / normalizeField", () => {
  it("field() records an optional default", () => {
    expect(field("f32")).toEqual({ type: "f32", hasDefault: false });
    expect(field("f32", { default: 0 })).toEqual({ type: "f32", hasDefault: true, default: 0 });
  });

  it("normalizes bare types and enums to required specs, and passes specs through", () => {
    expect(normalizeField("f32")).toEqual({ type: "f32", hasDefault: false });
    const e = enumOf(["A"]);
    expect(normalizeField(e)).toEqual({ type: e, hasDefault: false });
    const spec = field("u8", { default: 1 });
    expect(normalizeField(spec)).toBe(spec);
  });
});

describe("columnKindOf", () => {
  it("routes scalar types to backing arrays", () => {
    expect(columnKindOf("f32")).toBe("f32");
    expect(columnKindOf("f64")).toBe("f64");
    expect(columnKindOf("i16")).toBe("i16");
    expect(columnKindOf("eid")).toBe("u32");
    expect(columnKindOf("bool")).toBe("u8");
    expect(columnKindOf("string")).toBe("string");
    expect(columnKindOf("key")).toBe("string");
  });
});

describe("allocColumn / growColumn", () => {
  it("allocates typed arrays and null-filled string arrays", () => {
    expect(allocColumn("f32", 4)).toBeInstanceOf(Float32Array);
    const s = allocColumn("string", 3) as (string | null)[];
    expect(s).toEqual([null, null, null]);
  });

  it("grows a typed column preserving values and zero-extending", () => {
    const c = allocColumn("i32", 2) as Int32Array;
    c[0] = 7;
    c[1] = 9;
    const g = growColumn(c, "i32", 4) as Int32Array;
    expect(Array.from(g)).toEqual([7, 9, 0, 0]);
  });

  it("grows a string column preserving values and null-extending (never undefined)", () => {
    const c = allocColumn("string", 2) as (string | null)[];
    c[0] = "a";
    const g = growColumn(c, "string", 4) as (string | null)[];
    expect(g).toEqual(["a", null, null, null]);
    expect(g.every((x) => x !== undefined)).toBe(true);
  });
});

describe("encodeField / decodeField", () => {
  it("round-trips bool, enum, string, and eid", () => {
    expect(encodeField("bool", true)).toBe(1);
    expect(encodeField("bool", false)).toBe(0);
    expect(decodeField("bool", 1)).toBe(true);

    const e = enumOf({ Red: 1, Blue: 2 });
    expect(encodeField(e, "Blue")).toBe(2);
    expect(decodeField(e, 1)).toBe("Red");

    expect(encodeField("string", "hi")).toBe("hi");
    expect(encodeField("string", null)).toBe(null);
    expect(decodeField("string", null)).toBe(null);

    expect(encodeField("eid", 0xffffffff)).toBe(0xffffffff); // stays unsigned
  });

  it("throws on an unknown enum label", () => {
    const e = enumOf(["Red", "Blue"]);
    expect(() => encodeField(e, "Green")).toThrow(/not a variant/);
  });
});

describe("cell helpers", () => {
  it("writes and reads typed and string cells", () => {
    const t = allocColumn("f32", 2) as Float32Array;
    writeCell(t, "f32", 1, 3.5);
    expect(readCell(t, "f32", 1)).toBe(3.5);

    const s = allocColumn("string", 2) as (string | null)[];
    writeCell(s, "string", 0, "x");
    expect(readCell(s, "string", 0)).toBe("x");
  });

  it("moveCell copies and nulls the string source; clearCell nulls only strings", () => {
    const s = allocColumn("string", 2) as (string | null)[];
    s[1] = "moved";
    moveCell(s, "string", 1, 0);
    expect(s).toEqual(["moved", null]); // copied to 0, source nulled

    const t = allocColumn("u8", 2) as Uint8Array;
    t[1] = 5;
    moveCell(t, "u8", 1, 0);
    expect(t[0]).toBe(5); // typed: no null discipline needed

    clearCell(s, "string", 0);
    expect(s[0]).toBe(null);
    clearCell(t, "u8", 0); // no-op for typed columns
    expect(t[0]).toBe(5);
  });
});

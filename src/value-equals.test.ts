/**
 * `valueEquals` (petition 10 / design-009 BF-D20) — the PUBLIC reconcile-grade component-cell
 * equality. Imported from the ROOT barrel on purpose: reachability through the public entry is
 * part of the contract (the primitives it wraps live in the internal substrate barrel).
 *
 * The load-bearing suite is the DIFFER-AGREEMENT battery: for every awkward value class the canon
 * parity suite exercises (fround, integer wrap, enum labels, defaults, NaN, ±0), a proposed write
 * must compare EQUAL to that same value's real-store read-back — which is exactly the differ's
 * production question ("is this write a no-op against the projected value?"). If this holds,
 * a differ built on valueEquals can never disagree with reconcile's settlement judgement.
 */

import { describe, expect, it } from "vitest";
import {
  type Component,
  createWorld,
  defineComponent,
  enumOf,
  field,
  valueEquals,
} from "./index";

// Own names — the schema registry is process-global per test file.
const Battery = defineComponent("VEQBattery", {
  f32v: "f32",
  f64v: "f64",
  u8v: "u8",
  i8v: "i8",
  u16v: "u16",
  team: enumOf({ Red: 1, Blue: 2 }),
  flag: "bool",
  label: "string",
});
const Defaulted = defineComponent("VEQDefaulted", {
  hp: "u8",
  max: field("u8", { default: 100 }),
});
const Pos = defineComponent("VEQPos", { x: "f32", y: "f32" });

const w = createWorld();

/** Write `v` through a real store and read it back — the differ's "projected value" side.
 *  Loosely typed on purpose: the fixed-point test feeds a read-back (unknown) straight back in. */
function readBack(C: Component, v: unknown): unknown {
  const e = w.spawn();
  w.addComponent(e, C as Component<Record<string, unknown>>, v as Record<string, unknown>);
  const r = w.read(e, C);
  w.destroy(e);
  return r;
}

describe("valueEquals — differ agreement (a proposed write equals its own store read-back)", () => {
  const fixtures: Array<Record<string, unknown>> = [
    { f32v: 0.1, f64v: 0.1, u8v: 300, i8v: -1, u16v: 70000, team: "Blue", flag: true, label: "hi" },
    { f32v: NaN, f64v: -0, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null },
    { f32v: 1e39, f64v: 1e39, u8v: 256, i8v: 128, u16v: 65536, team: "Blue", flag: true, label: "" },
  ];
  it("holds on every awkward-value fixture the canon parity battery uses", () => {
    for (const v of fixtures) {
      expect(valueEquals(Battery, v, readBack(Battery, v))).toBe(true);
    }
  });
  it("holds through default-fill: an omitted defaulted field equals its explicit default", () => {
    expect(valueEquals(Defaulted, { hp: 5 }, readBack(Defaulted, { hp: 5, max: 100 }))).toBe(true);
    expect(valueEquals(Defaulted, { hp: 5 }, { hp: 5, max: 100 })).toBe(true);
    expect(valueEquals(Defaulted, { hp: 5 }, { hp: 5, max: 99 })).toBe(false);
  });
});

describe("valueEquals — canonicalization (the petition acceptance rows)", () => {
  it("f32: raw 0.1 equals its fround through the column path; ±0 collapse", () => {
    expect(valueEquals(Pos, { x: 0.1, y: -0 }, { x: Math.fround(0.1), y: 0 })).toBe(true);
  });
  it("f64 keeps precision: 0.1 does NOT equal fround(0.1) in an f64 field", () => {
    const v = { f32v: 0, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null };
    expect(valueEquals(Battery, { ...v, f64v: 0.1 }, { ...v, f64v: Math.fround(0.1) })).toBe(false);
  });
  it("NaN cells compare equal to themselves (never strand)", () => {
    expect(valueEquals(Pos, { x: NaN, y: 1 }, { x: NaN, y: 1 })).toBe(true);
  });
  it("integer wrap: 300 in a u8 equals 44; -1 equals 255", () => {
    const base = { f32v: 0, f64v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null };
    expect(valueEquals(Battery, { ...base, u8v: 300 }, { ...base, u8v: 44 })).toBe(true);
    expect(valueEquals(Battery, { ...base, u8v: -1 }, { ...base, u8v: 255 })).toBe(true);
  });
  it("actually discriminates: unequal scalars, enum labels, and strings are unequal", () => {
    expect(valueEquals(Pos, { x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
    const base = { f32v: 0, f64v: 0, u8v: 0, i8v: 0, u16v: 0, flag: false, label: null };
    expect(valueEquals(Battery, { ...base, team: "Red" }, { ...base, team: "Blue" })).toBe(false);
    expect(valueEquals(Battery, { ...base, team: "Red", label: "a" }, { ...base, team: "Red", label: null })).toBe(false);
  });
});

describe("valueEquals — absent cells and malformation", () => {
  it("undefined means CELL ABSENT: both-undefined equal, one-undefined not", () => {
    expect(valueEquals(Pos, undefined, undefined)).toBe(true);
    expect(valueEquals(Pos, { x: 0, y: 0 }, undefined)).toBe(false);
    expect(valueEquals(Pos, undefined, { x: 0, y: 0 })).toBe(false);
  });
  it("throws on malformation exactly as a local write would", () => {
    expect(() => valueEquals(Pos, { x: 1 }, { x: 1, y: 2 })).toThrow(); // missing no-default field
    const base = { f32v: 0, f64v: 0, u8v: 0, i8v: 0, u16v: 0, flag: false, label: null };
    expect(() => valueEquals(Battery, { ...base, team: "Green" }, { ...base, team: "Red" })).toThrow(); // unknown enum label
  });
  it("null is refused loudly — it is not the absent sentinel (review finding 1)", () => {
    expect(() => valueEquals(Pos, null, null)).toThrow(/valueEquals\("VEQPos"\).*null/);
    expect(() => valueEquals(Pos, null, { x: 1, y: 2 })).toThrow(/null/);
    expect(() => valueEquals(Pos, { x: 1, y: 2 }, null)).toThrow(/null/);
  });
  it("a comparison against undefined short-circuits before validation (documented)", () => {
    expect(valueEquals(Pos, { x: 1 }, undefined)).toBe(false); // malformed left operand, no throw
  });
  it("a value of the WRONG component throws at runtime (unknown params compile anything)", () => {
    expect(() => valueEquals(Pos, { x: 1, y: 2 }, { hp: 3 })).toThrow(/missing required field/);
  });
});

describe("valueEquals — canon idempotency (the bridge to reconcile's raw-read comparison)", () => {
  // Reconcile judges cellEquals(RAW runtime read, canonical value); valueEquals judges
  // cellEquals(canon(a), canon(b)). The two coincide iff canon is a FIXED POINT on store
  // read-backs — pin it observationally: re-writing a read-back reads back field-wise identical.
  it("a store read-back is a fixed point: writing it again reproduces it exactly", () => {
    const fixtures: Array<Record<string, unknown>> = [
      { f32v: 0.1, f64v: 0.1, u8v: 300, i8v: -1, u16v: 70000, team: "Blue", flag: true, label: "hi" },
      { f32v: NaN, f64v: -0, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null },
      { f32v: 1e39, f64v: 1e39, u8v: 256, i8v: 128, u16v: 65536, team: "Blue", flag: true, label: "" },
    ];
    for (const v of fixtures) {
      const once = readBack(Battery, v);
      const twice = readBack(Battery, once);
      expect(valueEquals(Battery, once, twice)).toBe(true);
    }
  });
});

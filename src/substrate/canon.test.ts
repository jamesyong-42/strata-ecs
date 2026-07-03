/**
 * Canonical values + cell equality (Patch Note 005 §2). The load-bearing test is the RuntimeStore
 * PARITY battery: `canon(C, v)` must field-wise-equal `RuntimeStore.read` after writing `v` — proven
 * by writing awkward values through a REAL store and comparing (the typed-array coercion parity, §2.4).
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../core/world";
import { enumOf, field } from "../core/field";
import { type Component, defineComponent } from "../core/schema";
import { canon, cellEquals, scalarEquals, tryCanon } from "./canon";
import type { ComponentValue } from "./types";

// Own component names (schema is process-global) — the awkward-value battery covers every column kind.
const Battery = defineComponent("CANONBattery", {
  f32v: "f32",
  f64v: "f64",
  u8v: "u8",
  i8v: "i8",
  u16v: "u16",
  team: enumOf({ Red: 1, Blue: 2 }),
  flag: "bool",
  label: "string",
});
const Defaulted = defineComponent("CANONDefaulted", {
  hp: "u8",
  max: field("u8", { default: 100 }),
});

const w = createWorld();

/** Write `v` through a real RuntimeStore and read it back — exactly what reconcile compares against. */
function readBack<S>(C: Component<S>, v: S): ComponentValue {
  const e = w.spawn();
  w.addComponent(e, C, v);
  const r = w.read(e, C) as ComponentValue;
  w.destroy(e);
  return r;
}

/** canon(C, v) MUST field-wise-equal the runtime read-back (§2.2). */
function assertParity<S>(C: Component<S>, v: S): void {
  const stored = readBack(C, v);
  const c = canon(C as Component, v as ComponentValue);
  for (const f of (C as Component).fields) {
    expect(scalarEquals(c[f.name], stored[f.name])).toBe(true);
  }
}

describe("canon — RuntimeStore parity (§2.2, §2.4)", () => {
  it("matches the store for a battery of awkward values (wrap, fround, enum labels)", () => {
    assertParity(Battery, { f32v: 0.1, f64v: 0.1, u8v: 300, i8v: -1, u16v: 70000, team: "Blue", flag: true, label: "hi" });
    assertParity(Battery, { f32v: NaN, f64v: -0, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null });
    assertParity(Battery, { f32v: 1e39, f64v: 1e39, u8v: 256, i8v: 128, u16v: 65536, team: "Blue", flag: true, label: "" });
  });

  it("wraps, never clamps: 300 into u8 = 44, -1 into u8 = 255, 70000 into u16 = 4464", () => {
    const c = canon(Battery, { f32v: 0, f64v: 0, u8v: 300, i8v: 0, u16v: 70000, team: "Red", flag: false, label: null });
    expect(c.u8v).toBe(44); // 300 & 0xFF
    expect(c.u16v).toBe(70000 & 0xffff); // 4464
    const c2 = canon(Battery, { f32v: 0, f64v: 0, u8v: -1, i8v: 0, u16v: 0, team: "Red", flag: false, label: null });
    expect(c2.u8v).toBe(255); // -1 wraps, not clamps to 0
  });

  it("f32 fround: 0.1 canonicalizes to Math.fround(0.1), not 0.1", () => {
    const c = canon(Battery, { f32v: 0.1, f64v: 0.1, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null });
    expect(c.f32v).toBe(Math.fround(0.1));
    expect(c.f32v).not.toBe(0.1);
    expect(c.f64v).toBe(0.1); // f64 keeps full precision
  });

  it("is idempotent — canon(C, canon(C, v)) field-wise-equals canon(C, v) (§2.5)", () => {
    const v = { f32v: 0.1, f64v: 0.1, u8v: 300, i8v: -5, u16v: 70000, team: "Blue", flag: true, label: "x" };
    const once = canon(Battery, v);
    const twice = canon(Battery, once);
    expect(cellEquals(twice, once)).toBe(true);
  });

  it("fills declared defaults, throws on a missing no-default field", () => {
    expect(canon(Defaulted, { hp: 5 })).toEqual({ hp: 5, max: 100 });
    expect(() => canon(Defaulted, { max: 3 } as ComponentValue)).toThrow();
  });
});

describe("scalarEquals (§2.2)", () => {
  it("unifies NaN and collapses ±0", () => {
    expect(scalarEquals(NaN, NaN)).toBe(true); // the self-inequality trick
    expect(scalarEquals(0, -0)).toBe(true); // collapse signed zero (Object.is would not)
    expect(scalarEquals(1, 1)).toBe(true);
    expect(scalarEquals(1, 2)).toBe(false);
    expect(scalarEquals("a", "a")).toBe(true);
    expect(scalarEquals(NaN, 1)).toBe(false);
  });
});

describe("cellEquals (§2.2)", () => {
  it("both-undefined equal; one-undefined not; field-wise otherwise", () => {
    expect(cellEquals(undefined, undefined)).toBe(true);
    expect(cellEquals({ x: 1 }, undefined)).toBe(false);
    expect(cellEquals(undefined, { x: 1 })).toBe(false);
    expect(cellEquals({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(cellEquals({ x: 1 }, { x: 2 })).toBe(false);
    expect(cellEquals({ x: NaN }, { x: NaN })).toBe(true); // NaN field survives (§2.2)
  });
});

describe("tryCanon — inbound-safe, never throws (§2.3)", () => {
  it("default-fills a missing declared-default field", () => {
    const r = tryCanon(Defaulted, { hp: 7 });
    expect(r).toEqual({ ok: true, value: { hp: 7, max: 100 } });
  });

  it("rejects each malformation with ok:false — WITHOUT throwing", () => {
    const cases: Array<[string, ComponentValue]> = [
      ["wrong JS type (string into u8)", { f32v: 0, f64v: 0, u8v: "x", i8v: 0, u16v: 0, team: "Red", flag: false, label: null }],
      ["non-finite into an integer column", { f32v: 0, f64v: 0, u8v: NaN, i8v: 0, u16v: 0, team: "Red", flag: false, label: null }],
      ["unknown enum label", { f32v: 0, f64v: 0, u8v: 0, i8v: 0, u16v: 0, team: "Green", flag: false, label: null }],
    ];
    for (const [, v] of cases) {
      let result!: ReturnType<typeof tryCanon>;
      expect(() => (result = tryCanon(Battery, v))).not.toThrow();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.field).toBe("string");
    }
    // Missing a no-default field also rejects (does not throw).
    const miss = tryCanon(Defaulted, {} as ComponentValue);
    expect(miss.ok).toBe(false);
  });

  it("allows non-finite into a FLOAT column (NaN/±Inf survive the round-trip, §2.4)", () => {
    const r = tryCanon(Battery, { f32v: NaN, f64v: Infinity, u8v: 0, i8v: 0, u16v: 0, team: "Red", flag: false, label: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number.isNaN(r.value.f32v)).toBe(true);
      expect(r.value.f64v).toBe(Infinity);
    }
  });

  it("accepts a representable-but-out-of-range value (wraps, not malformed, §2.4)", () => {
    const r = tryCanon(Battery, { f32v: 0, f64v: 0, u8v: 300, i8v: 0, u16v: 0, team: "Red", flag: false, label: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.u8v).toBe(44);
  });
});

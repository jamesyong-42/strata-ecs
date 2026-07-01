import { describe, expect, it } from "vitest";
import {
  type Entity,
  GEN_BITS,
  GEN_MASK,
  INDEX_BITS,
  INDEX_MASK,
  MAX_GENERATION,
  MAX_SLOTS,
  NULL_ENTITY,
  genOf,
  pack,
  slotOf,
} from "./entity";

describe("entity constants", () => {
  it("index + generation fill exactly 32 bits", () => {
    expect(INDEX_BITS + GEN_BITS).toBe(32);
  });

  it("masks match the field widths", () => {
    expect(INDEX_MASK).toBe(0x000fffff);
    expect(GEN_MASK).toBe(0x00000fff);
    expect(MAX_SLOTS).toBe(1 << 20);
    expect(MAX_GENERATION).toBe(4095);
  });
});

describe("pack / slotOf / genOf", () => {
  it("round-trips representative values", () => {
    for (const [slot, gen] of [
      [0, 1],
      [1, 1],
      [42, 7],
      [12345, 4095],
      [INDEX_MASK, MAX_GENERATION],
      [INDEX_MASK, 1],
      [0, MAX_GENERATION],
    ] as const) {
      const e = pack(slot, gen);
      expect(slotOf(e)).toBe(slot);
      expect(genOf(e)).toBe(gen);
    }
  });

  it("keeps high-generation handles unsigned (> 2^31) and still unpacks", () => {
    const e = pack(12345, MAX_GENERATION); // generation 4095 sets bit 31
    expect(e).toBeGreaterThan(2 ** 31);
    expect(e).toBeLessThanOrEqual(0xffffffff);
    expect(slotOf(e)).toBe(12345);
    expect(genOf(e)).toBe(MAX_GENERATION);
  });

  it("slot and generation are independent fields", () => {
    const a = pack(100, 1);
    const b = pack(100, 2);
    expect(slotOf(a)).toBe(slotOf(b));
    expect(genOf(a)).not.toBe(genOf(b));
    expect(a).not.toBe(b);
  });

  it("rejects out-of-range fields in dev instead of silently masking them", () => {
    // The raw bit-ops mask overflow (`index & INDEX_MASK`, `gen & GEN_MASK`) — which in production
    // would ALIAS a different handle. The DEV guard (§2) turns that latent corruption into a throw.
    expect(() => pack(MAX_SLOTS, 1)).toThrow(/out of range/); // 2^20 would mask to slot 0
    expect(() => pack(0, MAX_GENERATION + 1)).toThrow(/out of range/); // 4096 would mask to gen 0
  });

  it("NULL_ENTITY is slot 0 / generation 0", () => {
    expect(NULL_ENTITY).toBe(0);
    expect(slotOf(NULL_ENTITY)).toBe(0);
    expect(genOf(NULL_ENTITY)).toBe(0);
  });

  it("distinct (slot,gen) pairs never collide across a wide sweep", () => {
    const seen = new Set<Entity>();
    for (let slot = 0; slot < 2000; slot++) {
      for (const gen of [1, 2, 4095]) {
        const e = pack(slot, gen);
        expect(seen.has(e)).toBe(false);
        seen.add(e);
      }
    }
  });
});

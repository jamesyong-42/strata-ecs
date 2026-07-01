import { describe, expect, it } from "vitest";
import { TagStore } from "./tags";

describe("TagStore", () => {
  it("sets, reads, and clears a bit", () => {
    const t = new TagStore();
    expect(t.has(0, 5)).toBe(false);
    t.set(0, 5);
    expect(t.has(0, 5)).toBe(true);
    t.clear(0, 5);
    expect(t.has(0, 5)).toBe(false);
  });

  it("returns false for an unknown tag or an out-of-range slot", () => {
    const t = new TagStore();
    expect(t.has(3, 0)).toBe(false); // no bitset for tag 3 yet
    t.set(3, 0);
    expect(t.has(3, 9999)).toBe(false); // slot beyond the bitset length
  });

  it("keeps tags independent and slots independent", () => {
    const t = new TagStore();
    t.set(0, 5);
    t.set(1, 5);
    t.set(0, 6);
    expect(t.has(1, 6)).toBe(false);
    t.clear(0, 5);
    expect(t.has(1, 5)).toBe(true); // clearing tag 0 didn't touch tag 1
    expect(t.has(0, 6)).toBe(true);
  });

  it("handles the sign bit (bit 31) and multi-word growth", () => {
    const t = new TagStore();
    t.set(0, 31); // word 0, bit 31
    t.set(0, 40); // word 1 — forces growth
    expect(t.has(0, 31)).toBe(true);
    expect(t.has(0, 40)).toBe(true);
    t.clear(0, 31);
    expect(t.has(0, 31)).toBe(false);
    expect(t.has(0, 40)).toBe(true);
  });

  it("clearAll clears one slot across every tag", () => {
    const t = new TagStore();
    t.set(0, 7);
    t.set(1, 7);
    t.set(0, 8);
    t.clearAll(7);
    expect(t.has(0, 7)).toBe(false);
    expect(t.has(1, 7)).toBe(false);
    expect(t.has(0, 8)).toBe(true); // a different slot is untouched
  });

  it("exposes the raw bitset", () => {
    const t = new TagStore();
    expect(t.bitset(0)).toBeUndefined();
    t.set(0, 1);
    expect(t.bitset(0)?.[0]).toBe(0b10);
  });
});

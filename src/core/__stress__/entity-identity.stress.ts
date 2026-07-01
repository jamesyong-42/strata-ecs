/**
 * Stress: the two hard limits baked into the 20/12 entity handle (design §2).
 *
 *  - **MAX_SLOTS (2^20)** — a clean throw at the ceiling, never a silent alias.
 *  - **MAX_GENERATION (2^12)** — a *pinned, documented* ABA tradeoff: after 4095 recycles of one
 *    slot the generation wraps `4095 → 1`, so a stale handle becomes indistinguishable from the
 *    live one. This is not a bug to fix here (a 53-bit fallback is the deferred "full hardening");
 *    these tests PIN the exact behavior so a future change can't alter it unnoticed.
 */

import { describe, expect, it } from "vitest";
import { type Entity, MAX_GENERATION, MAX_SLOTS, genOf, slotOf } from "../entity";
import { EntityTable } from "../entity-table";

describe("stress: generation wraparound (pinned ABA tradeoff, §2)", () => {
  it("one slot's generation cycles 1→MAX_GENERATION→1; a stale handle collides after exactly 4095 recycles", () => {
    const t = new EntityTable(1); // force single-slot reuse: the free list only ever holds slot 0
    const h0 = t.allocate();
    expect(slotOf(h0)).toBe(0);
    expect(genOf(h0)).toBe(1); // fresh slot's first generation (0 is reserved)

    // One recycle = free (bumps generation, wrap skips 0) + allocate (pops the same slot back).
    let current: Entity = h0;
    for (let i = 0; i < MAX_GENERATION; i++) {
      t.free(current);
      current = t.allocate();
    }

    // 4095 recycles later the generation has wrapped back to 1 → bit-identical to h0.
    expect(slotOf(current)).toBe(0);
    expect(genOf(current)).toBe(1);
    expect(current).toBe(h0);

    // The documented ABA: the ORIGINAL stale handle now reads alive again, aliasing the new occupant.
    expect(t.isAlive(h0)).toBe(true);
  });

  it("one recycle short of the wrap, the stale handle is still correctly detected as dead", () => {
    const t = new EntityTable(1);
    const h0 = t.allocate(); // gen 1
    let current: Entity = h0;
    for (let i = 0; i < MAX_GENERATION - 1; i++) {
      t.free(current);
      current = t.allocate();
    }
    // generation is now MAX_GENERATION (4095), not yet wrapped → h0 (gen 1) is still stale/dead.
    expect(genOf(current)).toBe(MAX_GENERATION);
    expect(t.isAlive(h0)).toBe(false);
    expect(t.isAlive(current)).toBe(true);
  });

  it("generation 0 is never issued across a full double-wrap (0 = 'never issued')", () => {
    const t = new EntityTable(1);
    let current = t.allocate();
    const seen = new Set<number>();
    for (let i = 0; i < MAX_GENERATION * 2; i++) {
      seen.add(genOf(current));
      t.free(current);
      current = t.allocate();
    }
    expect(seen.has(0)).toBe(false);
    expect(seen.size).toBe(MAX_GENERATION); // exactly 4095 distinct non-zero generations
  });
});

describe("stress: MAX_SLOTS exhaustion (clean throw at the 2^20 ceiling, §2)", () => {
  it("allocates exactly MAX_SLOTS entities, then throws cleanly on the next", () => {
    const t = new EntityTable();
    for (let i = 0; i < MAX_SLOTS; i++) t.allocate();
    expect(t.liveCount).toBe(MAX_SLOTS);
    expect(t.highWaterMark).toBe(MAX_SLOTS);
    expect(() => t.allocate()).toThrow(/slot capacity exceeded/);
  });

  it("the constructor rejects an initial capacity above MAX_SLOTS", () => {
    expect(() => new EntityTable(MAX_SLOTS + 1)).toThrow(/exceeds the maximum/);
    expect(() => new EntityTable(MAX_SLOTS)).not.toThrow();
  });

  it("mixed allocate/free stays under the ceiling by reusing freed slots", () => {
    const t = new EntityTable();
    const handles: Entity[] = [];
    for (let i = 0; i < 1000; i++) handles.push(t.allocate());
    for (const h of handles) t.free(h);
    // Reallocating drains the free list; the high-water mark stays put, no new slots consumed.
    for (let i = 0; i < 1000; i++) t.allocate();
    expect(t.liveCount).toBe(1000);
    expect(t.highWaterMark).toBe(1000);
  });
});

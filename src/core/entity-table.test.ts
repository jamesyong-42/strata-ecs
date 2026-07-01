import { describe, expect, it } from "vitest";
import { EntityTable, NO_ARCHETYPE, NO_ROW } from "./entity-table";
import { MAX_GENERATION, MAX_SLOTS, genOf, pack, slotOf } from "./entity";

describe("EntityTable — allocation", () => {
  it("allocates live, identity-only handles with distinct slots", () => {
    const t = new EntityTable();
    const a = t.allocate();
    const b = t.allocate();
    expect(t.isAlive(a)).toBe(true);
    expect(t.isAlive(b)).toBe(true);
    expect(slotOf(a)).not.toBe(slotOf(b));
    expect(t.isIdentityOnly(a)).toBe(true);
    expect(t.isPlaced(a)).toBe(false);
    expect(genOf(a)).toBe(1); // fresh slots start at generation 1
  });

  it("tracks live count and high-water mark", () => {
    const t = new EntityTable();
    const a = t.allocate();
    t.allocate();
    t.allocate();
    expect(t.liveCount).toBe(3);
    expect(t.highWaterMark).toBe(3);
    t.free(a);
    expect(t.liveCount).toBe(2);
    expect(t.highWaterMark).toBe(3); // hwm never shrinks
    t.allocate(); // reuses a's slot
    expect(t.liveCount).toBe(3);
    expect(t.highWaterMark).toBe(3);
  });
});

describe("EntityTable — free / reuse / generation safety", () => {
  it("frees a handle, invalidating it", () => {
    const t = new EntityTable();
    const a = t.allocate();
    expect(t.free(a)).toBe(true);
    expect(t.isAlive(a)).toBe(false);
  });

  it("reuses the freed slot (LIFO) with a bumped generation", () => {
    const t = new EntityTable();
    const a = t.allocate();
    t.free(a);
    const b = t.allocate();
    expect(slotOf(b)).toBe(slotOf(a)); // same slot reused
    expect(genOf(b)).toBe(genOf(a) + 1); // generation advanced
    expect(t.isAlive(b)).toBe(true);
    expect(t.isAlive(a)).toBe(false); // the stale handle is dead
  });

  it("is a no-op on a stale or double-freed handle", () => {
    const t = new EntityTable();
    const a = t.allocate();
    t.free(a);
    expect(t.free(a)).toBe(false); // double free
    const b = t.allocate(); // reuses the slot
    expect(t.free(a)).toBe(false); // stale handle can't free b's occupant
    expect(t.isAlive(b)).toBe(true);
  });

  it("reports a never-allocated slot as dead (isolates the bounds check)", () => {
    const t = new EntityTable();
    t.allocate();
    t.allocate(); // slotCount === 2
    // A fabricated handle for an in-range slot that was never allocated has stored
    // generation 0, so ONLY the `slot >= slotCount` bounds check keeps it from reading
    // alive against a gen-0 handle — this is the mutant-killer for that branch.
    expect(t.isAlive(pack(500, 0))).toBe(false);
    expect(t.isAlive(pack(500, 1))).toBe(false);
    expect(t.isAlive(pack(5000, 1))).toBe(false); // beyond the backing capacity, too
  });

  it("LIFO: most-recently-freed slot is handed out first", () => {
    const t = new EntityTable();
    const a = t.allocate();
    const b = t.allocate();
    const c = t.allocate();
    t.free(a);
    t.free(c);
    expect(slotOf(t.allocate())).toBe(slotOf(c)); // c freed last → reused first
    expect(slotOf(t.allocate())).toBe(slotOf(a));
    void b;
  });

  it("wraps generation past MAX_GENERATION skipping 0", () => {
    const t = new EntityTable();
    let last = t.allocate();
    const gens: number[] = [genOf(last)];
    // Cycle the same slot enough times to wrap the 12-bit generation counter.
    for (let i = 0; i < MAX_GENERATION + 5; i++) {
      t.free(last);
      last = t.allocate();
      gens.push(genOf(last));
    }
    expect(gens.every((g) => g >= 1 && g <= MAX_GENERATION)).toBe(true); // never 0
    expect(gens).toContain(MAX_GENERATION);
    // The allocation immediately after generation MAX_GENERATION wraps to 1.
    const peak = gens.indexOf(MAX_GENERATION);
    expect(gens[peak + 1]).toBe(1);
  });
});

describe("EntityTable — placement", () => {
  it("moves between identity-only and placed", () => {
    const t = new EntityTable();
    const a = t.allocate();
    const slot = slotOf(a);
    expect(t.isIdentityOnly(a)).toBe(true);
    expect(t.archetypeOf(slot)).toBe(NO_ARCHETYPE);
    expect(t.rowOf(slot)).toBe(NO_ROW);

    t.setPlacement(slot, 3, 7);
    expect(t.isPlaced(a)).toBe(true);
    expect(t.isIdentityOnly(a)).toBe(false);
    expect(t.archetypeOf(slot)).toBe(3);
    expect(t.rowOf(slot)).toBe(7);

    t.setRow(slot, 9);
    expect(t.rowOf(slot)).toBe(9);
    expect(t.archetypeOf(slot)).toBe(3);

    t.clearPlacement(slot);
    expect(t.isPlaced(a)).toBe(false);
    expect(t.isIdentityOnly(a)).toBe(true);
  });

  it("reconstructs the current handle for a slot", () => {
    const t = new EntityTable();
    const a = t.allocate();
    expect(t.entityAt(slotOf(a))).toBe(a);
  });

  it("free clears placement so a reused slot starts identity-only", () => {
    const t = new EntityTable();
    const a = t.allocate();
    t.setPlacement(slotOf(a), 2, 5);
    t.free(a);
    const b = t.allocate(); // reuses the slot
    expect(t.isIdentityOnly(b)).toBe(true);
    expect(t.archetypeOf(slotOf(b))).toBe(NO_ARCHETYPE);
  });
});

describe("EntityTable — growth", () => {
  it("grows past the initial capacity, preserving liveness", () => {
    const t = new EntityTable(2); // tiny initial capacity forces growth
    const handles = Array.from({ length: 10 }, () => t.allocate());
    for (const e of handles) expect(t.isAlive(e)).toBe(true);
    expect(new Set(handles.map(slotOf)).size).toBe(10); // all distinct slots
    expect(t.highWaterMark).toBe(10);
  });

  it("preserves placement across a capacity doubling", () => {
    const t = new EntityTable(2);
    const e = t.allocate();
    t.setPlacement(slotOf(e), 3, 7);
    for (let i = 0; i < 20; i++) t.allocate(); // force several doublings
    expect(t.isPlaced(e)).toBe(true);
    expect(t.archetypeOf(slotOf(e))).toBe(3);
    expect(t.rowOf(slotOf(e))).toBe(7);
  });
});

describe("EntityTable — capacity guard", () => {
  it("rejects an initial capacity beyond MAX_SLOTS", () => {
    expect(() => new EntityTable(MAX_SLOTS + 1)).toThrow(/capacity/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { MAX_GENERATION, MAX_SLOTS, pack } from "./entity";
import { createWorld, defineComponent, defineQuery, defineSystem, phase } from "./index";

describe("DEV guard: pack() range assertion (§2)", () => {
  it("throws on an out-of-range slot or generation instead of aliasing silently", () => {
    expect(() => pack(MAX_SLOTS, 1)).toThrow(/out of range/);
    expect(() => pack(-1, 1)).toThrow(/out of range/);
    expect(() => pack(0, MAX_GENERATION + 1)).toThrow(/out of range/);
    expect(() => pack(0, -1)).toThrow(/out of range/);
  });

  it("accepts the extreme in-range handle", () => {
    expect(() => pack(MAX_SLOTS - 1, MAX_GENERATION)).not.toThrow();
    expect(typeof pack(0, 1)).toBe("number");
  });
});

describe("DEV guard: command-buffer back-pressure warning (§5.4)", () => {
  it("warns once when a single phase defers more ops than the soft cap", () => {
    const Base = defineComponent("DGBase", { v: "u32" });
    const world = createWorld();
    for (let i = 0; i < 10; i++) world.spawn({ components: [[Base, { v: i }]] });
    world.runtime.setCommandBufferWarnThresholdForTesting(5);

    // Each of the 10 rows defers one spawn → 10 enqueues cross the soft cap of 5.
    const sys = defineSystem(defineQuery([Base]), (batch, ctx) => {
      for (const r of batch) {
        void r;
        ctx.spawn();
      }
    });

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    world.tick([phase("p", [sys])]);
    const calls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(calls.length).toBe(1); // fires exactly once, as the buffer crosses the threshold
    expect(calls[0]).toMatch(/command buffer/);
  });
});

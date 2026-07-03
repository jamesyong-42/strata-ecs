import { describe, expect, it, vi } from "vitest";
import { createWorld, defineComponent } from "../../core/index";
import { createLifecycleRecorder } from "./recorder";
import type { DescribeFn } from "./describe";

// Node-safe slice of strata-ecs/tools (no DOM): the recorder is pure hook plumbing.
const RPos = defineComponent("TOOLSRecPos", { x: "f32" });

const describeFn: DescribeFn = (world, e) => ({
  label: world.has(e, RPos) ? `pos:${world.readField(e, RPos, "x")}` : "bare",
  color: "#123456",
  phase: null,
});

describe("strata-ecs/tools lifecycle recorder", () => {
  it("records births and freezes the final description at death (pre-teardown)", () => {
    const w = createWorld();
    const rec = createLifecycleRecorder(w, describeFn);
    const e = w.spawn({ components: [[RPos, { x: 7 }]] });
    expect(rec.records()).toHaveLength(1);
    expect(rec.records()[0].diedMs).toBeNull();
    w.destroy(e);
    const r = rec.records()[0];
    expect(r.diedMs).not.toBeNull();
    expect(r.label).toBe("pos:7"); // read while still alive inside onDestroy
    expect(r.color).toBe("#123456");
    rec.dispose();
  });

  it("caps memory by evicting the oldest DEAD records, never living entities", () => {
    const w = createWorld();
    const rec = createLifecycleRecorder(w, describeFn, 10);
    const keeper = w.spawn(); // oldest record, but alive — must survive eviction
    for (let i = 0; i < 25; i++) w.destroy(w.spawn());
    const records = rec.records();
    expect(records.length).toBeLessThanOrEqual(11);
    expect(records.some((r) => r.id === keeper)).toBe(true);
    rec.dispose();
  });

  it("entities alive before attach are backfilled — attach order can't hide the population", () => {
    const w = createWorld();
    const a = w.spawn();
    const b = w.spawn({ components: [[RPos, { x: 1 }]] });
    const rec = createLifecycleRecorder(w, describeFn);
    expect(rec.records()).toHaveLength(2);
    expect(new Set(rec.records().map((r) => r.id))).toEqual(new Set([a, b]));
    expect(rec.records()[0].bornMs).toBe(0);
    w.destroy(b); // backfilled records still track their death normally
    expect(rec.records().find((r) => r.id === b)?.diedMs).not.toBeNull();
    rec.dispose();
  });

  it("a living population beyond cap never evicts (memory = living + cap) and keeps spawning cheap", () => {
    const w = createWorld();
    const rec = createLifecycleRecorder(w, describeFn, 100);
    for (let i = 0; i < 5000; i++) w.spawn();
    expect(rec.records()).toHaveLength(5000); // living records are exempt from the cap by design
    rec.dispose();
  });

  it("a generation-wrapped handle re-issue cannot orphan a living record (ABA)", () => {
    const w = createWorld();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); // the wrap devWarns
    const rec = createLifecycleRecorder(w, describeFn, 10_000);
    const first = w.spawn();
    w.destroy(first);
    let again = w.spawn();
    let guard = 0;
    while (again !== first && guard++ < 5000) {
      w.destroy(again);
      again = w.spawn(); // LIFO free list — same slot recycles until the 12-bit gen wraps
    }
    expect(again).toBe(first); // the packed handle repeated (core ABA, §2)
    rec.clear(); // used to delete the LIVING record's map entry via the old dead one
    w.destroy(again);
    expect(rec.records().filter((r) => r.diedMs === null)).toHaveLength(0); // no immortal orphan
    warn.mockRestore();
    rec.dispose();
  });

  it("clear() drops dead records only; dispose() stops recording", () => {
    const w = createWorld();
    const rec = createLifecycleRecorder(w, describeFn);
    const alive = w.spawn();
    w.destroy(w.spawn());
    rec.clear();
    expect(rec.records()).toHaveLength(1);
    expect(rec.records()[0].id).toBe(alive);
    rec.dispose();
    w.spawn();
    expect(rec.records()).toHaveLength(1); // detached — no new records
  });
});

/**
 * Profiler recorder unit tests — the DOM-free data layer, driven two ways:
 *
 *  - SYNTHETIC observer events through a stub world with an injected clock, so frame
 *    durations, percentiles, ring eviction and capture contents are exact and deterministic.
 *  - One REAL `createWorld` + `tick()` integration case pinning the wiring (structure, not
 *    timing values — real µs are nondeterministic).
 */
import { describe, expect, it, vi } from "vitest";

import type { World, WorldObserver } from "../../core/index";
import { createWorld, defineTickSystem, phase } from "../../core/index";
import { createProfilerRecorder, type ProfilerRecorderOptions } from "./recorder";

/** A stub world exposing the attached observer, plus a hand-cranked clock and tick driver. */
function harness(opts: ProfilerRecorderOptions = {}) {
  let obs: WorldObserver | null = null;
  let detached = false;
  const world = {
    observe(o: WorldObserver) {
      obs = o;
      return () => {
        detached = true;
        obs = null;
      };
    },
  } as unknown as World;
  const clock = { t: 0 };
  const rec = createProfilerRecorder(world, { now: () => clock.t, ...opts });
  /** One tick at `atMs`: run `systems` ([phase, name, µs]), then `flushes` ([phase, µs]).
   *  Tick µs defaults to the sum, override with `tickUs`. */
  const tickAt = (
    atMs: number,
    n: number,
    systems: Array<[string, string, number]> = [],
    flushes: Array<[string, number]> = [],
    tickUs?: number,
  ): void => {
    clock.t = atMs;
    obs!.onTickStart!(n);
    let sum = 0;
    for (const [ph, name, us] of systems) {
      obs!.onSystemRun!(ph, name, true, us);
      sum += us;
    }
    for (const [ph, us] of flushes) {
      obs!.onPhaseFlush!(ph, us);
      sum += us;
    }
    obs!.onTickEnd!(n, tickUs ?? sum);
  };
  return {
    rec,
    tickAt,
    raw: () => obs!,
    isDetached: () => detached,
  };
}

describe("profiler recorder — frame model", () => {
  it("no closed frame until the second tick; then frame/tick/fps settle at close", () => {
    const h = harness();
    h.tickAt(0, 1, [["p", "a", 500]]);
    let s = h.rec.stats();
    expect(s.samples).toBe(0);
    expect(s.fps).toBe(0);
    expect(s.worst).toBeNull();
    // the open tick's SYSTEM samples are already visible (slots fill at event time)
    expect(s.systems.map((x) => x.name)).toEqual(["a"]);

    h.tickAt(10, 2, [["p", "a", 500]]);
    s = h.rec.stats();
    expect(s.samples).toBe(1);
    expect(s.frame.last).toBe(10);
    expect(s.tick.last).toBe(0.5); // 500µs → ms
    expect(s.fps).toBe(100); // first close initializes the EMA directly
  });

  it("nearest-rank percentiles over a known 1..100ms distribution", () => {
    const h = harness();
    h.tickAt(0, 1);
    let at = 0;
    for (let i = 1; i <= 100; i++) {
      at += i; // frame i lasts exactly i ms
      h.tickAt(at, i + 1);
    }
    const s = h.rec.stats();
    expect(s.samples).toBe(100);
    expect(s.frame.p50).toBe(50);
    expect(s.frame.p95).toBe(95);
    expect(s.frame.p99).toBe(99);
    expect(s.frame.max).toBe(100);
    expect(s.frame.last).toBe(100);
  });

  it("copyRecent returns the newest samples chronologically, correct across ring wrap", () => {
    const h = harness({ windowSize: 4 });
    const frames = [10, 20, 30, 40, 50, 60]; // wraps a 4-slot ring
    let at = 0;
    h.tickAt(0, 1);
    frames.forEach((f, i) => {
      at += f;
      h.tickAt(at, i + 2);
    });
    const small = new Float32Array(3);
    expect(h.rec.copyRecent("frame", small)).toBe(3);
    expect([...small]).toEqual([40, 50, 60]);
    const big = new Float32Array(8);
    expect(h.rec.copyRecent("frame", big)).toBe(4); // only the window survives
    expect([...big.subarray(0, 4)]).toEqual([30, 40, 50, 60]);
  });

  it("the window ring evicts oldest samples; over-budget% counts the window only", () => {
    const h = harness({ windowSize: 4, budgetMs: 45 });
    const frames = [10, 20, 30, 40, 50, 60];
    let at = 0;
    h.tickAt(0, 1);
    frames.forEach((f, i) => {
      at += f;
      h.tickAt(at, i + 2);
    });
    const s = h.rec.stats();
    expect(s.samples).toBe(4); // 10 and 20 evicted
    expect(s.frame.p50).toBe(40); // sorted window [30,40,50,60]
    expect(s.frame.max).toBe(60);
    expect(s.overBudgetPct).toBe(50); // 50 and 60 over a 45ms budget
  });
});

describe("profiler recorder — systems", () => {
  it("duplicate system names in one phase get their own rows, in visit order", () => {
    const h = harness();
    const two: Array<[string, string, number]> = [
      ["sim", "move", 100],
      ["sim", "move", 200],
    ];
    h.tickAt(0, 1, two);
    h.tickAt(10, 2, two);
    const s = h.rec.stats();
    expect(s.systems.map((x) => x.name)).toEqual(["move", "move (2)"]);
    expect(s.systems[0].avgUs).toBe(100);
    expect(s.systems[1].avgUs).toBe(200);
    expect(s.systems[0].runs).toBe(2);
  });

  it("skipped systems count idle and contribute no time", () => {
    const h = harness();
    const drive = (n: number, at: number): void => {
      h.tickAt(at, n); // opens/closes frames around the raw skip event
      h.raw().onSystemRun!("p", "gated", false, 0);
    };
    drive(1, 0);
    drive(2, 10);
    const gated = h.rec.stats().systems.find((x) => x.name === "gated")!;
    expect(gated.skips).toBe(2);
    expect(gated.runs).toBe(0);
    expect(gated.avgUs).toBe(0);
  });

  it("flush rows are recorded per phase and share sums with systems against the tick", () => {
    const h = harness();
    const run = (at: number, n: number): void =>
      h.tickAt(at, n, [["sim", "move", 600]], [["sim", 400]], 1000);
    run(0, 1);
    run(10, 2);
    const s = h.rec.stats();
    const move = s.systems.find((x) => x.name === "move")!;
    const flush = s.systems.find((x) => x.isFlush)!;
    expect(flush.phase).toBe("sim");
    expect(move.share).toBeCloseTo(0.6, 5);
    expect(flush.share).toBeCloseTo(0.4, 5);
  });
});

describe("profiler recorder — lanes", () => {
  it("accumulates within a frame, zero-fills silent frames, auto-registers new names", () => {
    const h = harness({ lanes: ["paint"] });
    expect(h.rec.stats().lanes.map((l) => l.name)).toEqual(["paint"]); // pre-registered, empty
    h.tickAt(0, 1);
    h.rec.lane("paint", 2);
    h.rec.lane("paint", 3);
    h.rec.lane("overlay", 1); // auto-registers after the declared ones
    h.tickAt(10, 2); // closes frame 1
    h.tickAt(20, 3); // closes frame 2 — no lane reports
    const s = h.rec.stats();
    expect(s.lanes.map((l) => l.name)).toEqual(["paint", "overlay"]);
    expect(s.lanes[0].maxMs).toBe(5);
    expect(s.lanes[0].lastMs).toBe(0); // silent frame is a real 0, not a gap
    expect(s.lanes[0].avgMs).toBeCloseTo(2.5, 5);
  });

  it("ignores non-finite and negative ms with a dev warning, without registering the lane", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness();
      h.rec.lane("x", Number.NaN);
      h.rec.lane("x", -1);
      expect(h.rec.stats().lanes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toContain('profiler lane "x"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("profiler recorder — worst-frame capture and reset", () => {
  it("captures the worst frame's full breakdown and only a worse frame replaces it", () => {
    const h = harness();
    h.tickAt(0, 1, [["sim", "move", 300]], [["sim", 50]]);
    h.rec.lane("paint", 4);
    h.tickAt(10, 2, [["sim", "move", 800]], [["sim", 60]]); // closes the 10ms frame
    h.rec.lane("paint", 25);
    h.tickAt(40, 3, [["sim", "move", 100]], [["sim", 10]]); // closes the 30ms frame — the worst
    h.tickAt(60, 4); // closes a 20ms frame — must NOT replace
    const w = h.rec.stats().worst!;
    expect(w.frameMs).toBe(30);
    expect(w.tick).toBe(2); // the tick that ran inside the worst frame
    expect(w.tickMs).toBeCloseTo(0.86, 5);
    expect(w.lanes).toEqual([{ name: "paint", ms: 25 }]);
    expect(w.systems.map((x) => x.name)).toEqual(["move", "flush"]); // cost-descending
    expect(w.systems[0].micros).toBe(800);
  });

  it("reset() clears rings, counters, fps and the capture but keeps registrations", () => {
    const h = harness({ lanes: ["paint"] });
    h.tickAt(0, 1, [["p", "a", 100]]);
    h.rec.lane("paint", 2);
    h.tickAt(10, 2, [["p", "a", 100]]);
    h.rec.reset();
    const s = h.rec.stats();
    expect(s.samples).toBe(0);
    expect(s.fps).toBe(0);
    expect(s.worst).toBeNull();
    expect(s.frame.max).toBe(0);
    // rows survive with zeroed stats — display order stays stable across a reset
    expect(s.systems.map((x) => x.name)).toEqual(["a"]);
    expect(s.systems[0].runs).toBe(0);
    expect(s.lanes.map((l) => l.name)).toEqual(["paint"]);
    expect(s.lanes[0].maxMs).toBe(0);
  });
});

describe("profiler recorder — real world integration", () => {
  it("attaches through world.observe, sees named systems and flushes, detaches on dispose", () => {
    const w = createWorld();
    const rec = createProfilerRecorder(w);
    const spin = defineTickSystem(
      () => {
        let x = 0;
        for (let i = 0; i < 1000; i++) x += i;
        void x;
      },
      { name: "spin" },
    );
    w.tick([phase("p", [spin])]);
    w.tick([phase("p", [spin])]);
    const s = rec.stats();
    expect(s.samples).toBe(1); // two ticks → one closed frame
    expect(s.fps).toBeGreaterThan(0);
    const names = s.systems.map((x) => `${x.phase}/${x.name}`);
    expect(names).toContain("p/spin");
    expect(names).toContain("p/flush");
    expect(s.systems.find((x) => x.name === "spin")!.runs).toBe(2);

    rec.dispose();
    w.tick([phase("p", [spin])]);
    expect(rec.stats().samples).toBe(1); // detached — nothing new recorded
  });
});

/**
 * The frame profiler's data layer — `attachProfiler`'s DOM-free core, unit-testable headless.
 * Capture rides the core's `WorldObserver` tick hooks (observe.ts), like the lifecycle
 * recorder next door; the world pays the telemetry path only while attached.
 *
 * THE FRAME MODEL — a "frame" is one tick-to-tick interval. In the canonical loop shape
 * (design §16.2: one `world.tick()` per rAF) that IS the render frame: frame wall time runs
 * from one `onTickStart` to the next, the tick's own duration rides `onTickEnd`, and
 * everything the host reports through `lane()` between the two (paint, layout, …) lands in
 * the frame that just ticked. An app ticking on another cadence gets honest *tick-cadence*
 * stats instead — the numbers stay real, only the word "frame" stretches.
 *
 * A frame slot therefore CLOSES at the next tick's start: the rings, the lane accumulators,
 * the fps EMA and the worst-frame check all settle there. Until a second tick arrives there
 * is no closed frame and `stats()` reports zero samples.
 *
 * What makes this a profiler rather than an fps meter:
 *  - PERCENTILES over the window (p50/p95/p99/max) for frame and tick — averages hide the
 *    spikes that profilers exist to find.
 *  - WORST-FRAME CAPTURE — the full per-system µs breakdown (flush rows included) and lane
 *    split of the worst frame since attach/`reset()`, so "what made THAT frame slow" is
 *    answerable after the fact.
 *  - LANES — host-reported per-frame costs stacked next to the ECS share, so the tick is
 *    read in context of the whole frame without the tool knowing anything about rendering.
 */

import { DEV, devWarn } from "../../core/dev";
import type { World, WorldObserver } from "../../core/index";

/** Window percentiles in ms. `last` is the most recently closed frame. All 0 while empty. */
export interface ProfilerPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  last: number;
}

export interface ProfilerSystemStat {
  phase: string;
  name: string;
  /** True for the per-phase command-buffer flush rows. */
  isFlush: boolean;
  /** Ring-averaged / windowed-max body time, µs (runs only — skips don't dilute). */
  avgUs: number;
  maxUs: number;
  /** Since attach/reset. */
  runs: number;
  skips: number;
  /** This row's share of the average tick, 0..1. */
  share: number;
}

export interface ProfilerLaneStat {
  name: string;
  /** Per-frame ms over the window. Frames a lane never reported count as 0 — a skipped
   *  paint is a real 0-cost frame, not a gap. */
  avgMs: number;
  maxMs: number;
  lastMs: number;
}

export interface ProfilerCapturedSystem {
  phase: string;
  name: string;
  isFlush: boolean;
  micros: number;
}

/** One frame's full breakdown, frozen when it sets a new worst. */
export interface ProfilerFrameCapture {
  frameMs: number;
  tickMs: number;
  /** `world.tickCount` of the captured tick. */
  tick: number;
  /** Lanes that reported that frame (zero-cost lanes omitted). */
  lanes: ReadonlyArray<{ name: string; ms: number }>;
  /** Cost-descending per-system µs of that tick, flush rows included. */
  systems: readonly ProfilerCapturedSystem[];
}

export interface ProfilerStats {
  /** EMA of instantaneous fps — 0 until the first frame closes. */
  fps: number;
  /** Closed frames currently in the window. */
  samples: number;
  /** Percentage (0..100) of windowed frames over `budgetMs`. */
  overBudgetPct: number;
  frame: ProfilerPercentiles;
  tick: ProfilerPercentiles;
  /** Registration/first-report order. */
  lanes: readonly ProfilerLaneStat[];
  /** Pipeline visit order (phase-grouped), like the observer panel's systems tab. */
  systems: readonly ProfilerSystemStat[];
  /** The worst frame since attach/`reset()`, with its breakdown. */
  worst: ProfilerFrameCapture | null;
}

export interface ProfilerRecorderOptions {
  /** Sample-ring length in frames (default 240 — four seconds at 60fps). */
  windowSize?: number;
  /** Frame budget in ms — the over-budget line (default 16.7). */
  budgetMs?: number;
  /** Lanes to pre-register so display order/colors are stable before the first report. */
  lanes?: readonly string[];
  /** Clock, injectable for deterministic tests (default `performance.now`). */
  now?: () => number;
}

export interface ProfilerRecorder {
  /** Report a host-side cost for the CURRENT frame (between this tick and the next). Multiple
   *  reports to one lane within a frame accumulate. Non-finite/negative ms is ignored. */
  lane(name: string, ms: number): void;
  /** Snapshot of everything — computed on demand, never per frame. */
  stats(): ProfilerStats;
  /** Start measuring fresh: clears rings, run/skip counts, fps and the worst capture.
   *  Lane/system registrations survive (display order stays stable). */
  reset(): void;
  /** Detach from the world. */
  dispose(): void;
}

/** Fixed-size sample ring. `n` counts valid entries: `buf[0..n)` is always the live window
 *  (idx only laps once n === length), so stats can slice without unwrapping. */
interface Ring {
  buf: Float32Array;
  n: number;
  idx: number;
}

const ring = (size: number): Ring => ({ buf: new Float32Array(size), n: 0, idx: 0 });

function push(r: Ring, v: number): void {
  r.buf[r.idx] = v;
  r.idx = (r.idx + 1) % r.buf.length;
  if (r.n < r.buf.length) r.n++;
}

function avg(r: Ring): number {
  if (r.n === 0) return 0;
  let t = 0;
  for (let i = 0; i < r.n; i++) t += r.buf[i];
  return t / r.n;
}

function maxOf(r: Ring): number {
  let m = 0;
  for (let i = 0; i < r.n; i++) if (r.buf[i] > m) m = r.buf[i];
  return m;
}

function lastOf(r: Ring): number {
  if (r.n === 0) return 0;
  return r.buf[(r.idx - 1 + r.buf.length) % r.buf.length];
}

/** Nearest-rank percentile (ceil convention: q=0.5 over 100 samples → the 50th smallest). */
function percentilesOf(r: Ring): ProfilerPercentiles {
  if (r.n === 0) return { p50: 0, p95: 0, p99: 0, max: 0, last: 0 };
  const sorted = r.buf.slice(0, r.n).sort();
  const at = (q: number): number => sorted[Math.min(r.n - 1, Math.max(0, Math.ceil(q * r.n) - 1))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[r.n - 1], last: lastOf(r) };
}

interface SysSlot {
  phase: string;
  name: string;
  isFlush: boolean;
  runs: number;
  skips: number;
  ring: Ring;
}

interface LaneSlot {
  name: string;
  acc: number;
  ring: Ring;
}

export function createProfilerRecorder(world: World, opts: ProfilerRecorderOptions = {}): ProfilerRecorder {
  const windowSize = opts.windowSize ?? 240;
  const budgetMs = opts.budgetMs ?? 16.7;
  const now = opts.now ?? ((): number => performance.now());

  const frameRing = ring(windowSize);
  const tickRing = ring(windowSize);
  const sysSlots = new Map<string, SysSlot>();
  const sysOrder: SysSlot[] = [];
  const laneSlots = new Map<string, LaneSlot>();
  const laneOrder: LaneSlot[] = [];
  /** Per-tick duplicate-name counter (the LoopStats lesson): two same-named systems in one
   *  phase get their own rows, in visit order, instead of silently merging. */
  const seenThisTick = new Map<string, number>();

  // ── the OPEN frame (closes at the next onTickStart) ──
  let frameStart = -1; // -1 = no tick observed yet
  let openTick = 0;
  let openTickMs = 0;
  /** This tick's per-system entries — the worst-frame capture copies from here at close. */
  const scratch: ProfilerCapturedSystem[] = [];

  let fpsEma = 0;
  let worst: ProfilerFrameCapture | null = null;

  const laneSlot = (name: string): LaneSlot => {
    let l = laneSlots.get(name);
    if (l === undefined) {
      l = { name, acc: 0, ring: ring(windowSize) };
      laneSlots.set(name, l);
      laneOrder.push(l);
    }
    return l;
  };
  for (const name of opts.lanes ?? []) laneSlot(name);

  const sysSlot = (key: string, phase: string, name: string, isFlush: boolean): SysSlot => {
    let s = sysSlots.get(key);
    if (s === undefined) {
      s = { phase, name, isFlush, runs: 0, skips: 0, ring: ring(windowSize) };
      sysSlots.set(key, s);
      sysOrder.push(s);
    }
    return s;
  };

  const closeFrame = (at: number): void => {
    const frameMs = at - frameStart;
    push(frameRing, frameMs);
    push(tickRing, openTickMs);
    const inst = 1000 / Math.max(frameMs, 1e-6);
    fpsEma = fpsEma === 0 ? inst : fpsEma + (inst - fpsEma) * 0.08;
    if (worst === null || frameMs > worst.frameMs) {
      worst = {
        frameMs,
        tickMs: openTickMs,
        tick: openTick,
        lanes: laneOrder.filter((l) => l.acc > 0).map((l) => ({ name: l.name, ms: l.acc })),
        systems: [...scratch].sort((a, b) => b.micros - a.micros),
      };
    }
    for (const l of laneOrder) {
      push(l.ring, l.acc);
      l.acc = 0;
    }
    scratch.length = 0; // capture copied references to fresh per-tick objects — safe to truncate
  };

  const observer: WorldObserver = {
    onTickStart: (tick) => {
      const t = now();
      if (frameStart >= 0) closeFrame(t);
      frameStart = t;
      openTick = tick;
      openTickMs = 0;
      seenThisTick.clear();
    },
    onSystemRun: (phase, system, ran, micros) => {
      const base = `${phase}\u0000${system}`;
      const nth = seenThisTick.get(base) ?? 0;
      seenThisTick.set(base, nth + 1);
      const s = sysSlot(`${base}\u0000${nth}`, phase, nth > 0 ? `${system} (${nth + 1})` : system, false);
      if (ran) {
        s.runs++;
        push(s.ring, micros);
        scratch.push({ phase, name: s.name, isFlush: false, micros });
      } else {
        s.skips++;
      }
    },
    onPhaseFlush: (phase, micros) => {
      const s = sysSlot(`${phase}\u0000\u0000flush`, phase, "flush", true);
      s.runs++;
      push(s.ring, micros);
      scratch.push({ phase, name: "flush", isFlush: true, micros });
    },
    onTickEnd: (_tick, micros) => {
      openTickMs = micros / 1000;
    },
  };

  const detach = world.observe(observer);

  return {
    lane(name, ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        if (DEV) devWarn(`profiler lane "${name}" ignored a non-finite or negative ms (${ms})`);
        return;
      }
      laneSlot(name).acc += ms;
    },

    stats(): ProfilerStats {
      const tickAvgUs = avg(tickRing) * 1000;
      let over = 0;
      for (let i = 0; i < frameRing.n; i++) if (frameRing.buf[i] > budgetMs) over++;
      return {
        fps: fpsEma,
        samples: frameRing.n,
        overBudgetPct: frameRing.n === 0 ? 0 : (over / frameRing.n) * 100,
        frame: percentilesOf(frameRing),
        tick: percentilesOf(tickRing),
        lanes: laneOrder.map((l) => ({ name: l.name, avgMs: avg(l.ring), maxMs: maxOf(l.ring), lastMs: lastOf(l.ring) })),
        systems: sysOrder.map((s) => ({
          phase: s.phase,
          name: s.name,
          isFlush: s.isFlush,
          avgUs: avg(s.ring),
          maxUs: maxOf(s.ring),
          runs: s.runs,
          skips: s.skips,
          share: tickAvgUs <= 0 ? 0 : avg(s.ring) / tickAvgUs,
        })),
        worst,
      };
    },

    reset() {
      frameRing.n = frameRing.idx = 0;
      tickRing.n = tickRing.idx = 0;
      for (const l of laneOrder) l.ring.n = l.ring.idx = 0;
      for (const s of sysOrder) {
        s.ring.n = s.ring.idx = 0;
        s.runs = 0;
        s.skips = 0;
      }
      fpsEma = 0;
      worst = null;
      // The open frame's state (frameStart, accumulators, scratch) is left alone: it closes
      // normally at the next tick and lands as the fresh window's first sample.
    },

    dispose: detach,
  };
}

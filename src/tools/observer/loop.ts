/**
 * The loop readout — per-phase, per-system telemetry fed by the core's `WorldObserver`
 * tick hooks (observe.ts): a ran-this-tick dot, run/skip counts with idle% for gated
 * systems, real per-system microseconds (ring-buffer averaged), and a flush row per phase.
 * This is the profiling surface the original reactive-ecs observer never had.
 */

import type { WorldObserver } from "../../core/index";

const RING = 60;

interface Slot {
  key: string;
  phase: string;
  name: string;
  isFlush: boolean;
  runs: number;
  skips: number;
  ranThisTick: boolean;
  ring: Float64Array;
  ringN: number;
  ringIdx: number;
}

function avg(s: Slot): number {
  if (s.ringN === 0) return 0;
  let t = 0;
  for (let i = 0; i < s.ringN; i++) t += s.ring[i];
  return t / s.ringN;
}

function push(s: Slot, micros: number): void {
  s.ring[s.ringIdx] = micros;
  s.ringIdx = (s.ringIdx + 1) % RING;
  if (s.ringN < RING) s.ringN++;
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const fmtUs = (us: number): string => (us >= 1000 ? `${(us / 1000).toFixed(2)}ms` : `${us.toFixed(0)}µs`);

export class LoopStats {
  private readonly slots = new Map<string, Slot>();
  private readonly order: Slot[] = [];
  /** Per-tick duplicate-name counter: two same-named systems in one phase get their own
   *  rows (in visit order) instead of silently merging their stats. */
  private readonly seenThisTick = new Map<string, number>();
  lastTick = 0;
  lastTickMicros = 0;

  private slot(key: string, phase: string, name: string, isFlush: boolean): Slot {
    let s = this.slots.get(key);
    if (s === undefined) {
      s = { key, phase, name, isFlush, runs: 0, skips: 0, ranThisTick: false, ring: new Float64Array(RING), ringN: 0, ringIdx: 0 };
      this.slots.set(key, s);
      this.order.push(s);
    }
    return s;
  }

  /** The hooks to hand to `world.observe(...)`. */
  observer(): WorldObserver {
    return {
      onTickStart: () => {
        for (const s of this.order) s.ranThisTick = false;
        this.seenThisTick.clear();
      },
      onSystemRun: (phase, system, ran, micros) => {
        // \u0000 separators + a per-tick occurrence index make the key collision-free
        // (system names are display strings, not identifiers — duplicates are legal)
        const base = `${phase}\u0000${system}`;
        const nth = this.seenThisTick.get(base) ?? 0;
        this.seenThisTick.set(base, nth + 1);
        const s = this.slot(`${base}\u0000${nth}`, phase, nth > 0 ? `${system} (${nth + 1})` : system, false);
        s.ranThisTick = ran;
        if (ran) {
          s.runs++;
          push(s, micros);
        } else {
          s.skips++;
        }
      },
      onPhaseFlush: (phase, micros) => {
        const s = this.slot(`${phase}\u0000\u0000flush`, phase, "flush", true);
        s.ranThisTick = true;
        s.runs++;
        push(s, micros);
      },
      onTickEnd: (tick, micros) => {
        this.lastTick = tick;
        this.lastTickMicros = micros;
      },
    };
  }

  /** Rebuild the readout DOM (called at the panel's poll rate, ~8 Hz — never per frame). */
  render(root: HTMLElement): void {
    if (this.order.length === 0) {
      root.innerHTML = `<div class="strata-obs-empty">no ticks observed yet — is world.tick() running?</div>`;
      return;
    }
    let maxAvg = 1;
    for (const s of this.order) maxAvg = Math.max(maxAvg, avg(s));

    const parts: string[] = [];
    let currentPhase: string | null = null;
    for (const s of this.order) {
      if (s.phase !== currentPhase) {
        currentPhase = s.phase;
        parts.push(`<div class="strata-obs-phase">${esc(s.phase)}</div>`);
      }
      const a = avg(s);
      const total = s.runs + s.skips;
      const idle = total === 0 ? 0 : Math.round((s.skips / total) * 100);
      const stat = s.isFlush
        ? `${fmtUs(a)}`
        : s.skips > 0
          ? `${fmtUs(a)} · ${idle}% idle`
          : `${fmtUs(a)} · ${s.runs}▶`;
      parts.push(
        `<div class="strata-obs-sys${s.isFlush ? " flush" : ""}">` +
          `<span class="strata-obs-dot${s.ranThisTick ? " on" : ""}"></span>` +
          `<span class="strata-obs-sysname">${esc(s.isFlush ? "⤓ flush" : s.name)}</span>` +
          `<span class="strata-obs-bar"><i style="width:${Math.max(2, (a / maxAvg) * 100).toFixed(1)}%"></i></span>` +
          `<span class="strata-obs-stat">${stat}</span>` +
          `</div>`,
      );
    }
    root.innerHTML = parts.join("");
  }
}

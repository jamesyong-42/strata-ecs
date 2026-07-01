/**
 * Shared knobs for the stress + fuzz suites.
 *
 * `STRESS_SCALE` (env, default 1) multiplies the *tunable* sizes and fuzz run counts so the suite
 * can run in a few seconds locally (`STRESS_SCALE=1`) or be cranked up for a punishing soak
 * (`STRESS_SCALE=10`). Correctness-PINNING boundary tests (the 2^20 slot ceiling, the 2^12
 * generation wrap) use exact limit values from the encoding and deliberately ignore the scale —
 * they probe a fixed edge, not a variable load.
 *
 * All randomness is seeded so any failure replays deterministically (fast-check via {@link SEED},
 * hand-rolled loops via {@link mulberry32}).
 */

const rawScale = typeof process !== "undefined" ? Number(process.env.STRESS_SCALE) : NaN;

/** Load multiplier for tunable stress sizes and fuzz run counts. `>= 1`, default 1. */
export const SCALE: number = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

/** Scale a tunable base size by {@link SCALE}, rounded to an integer and at least 1. */
export function scaled(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}

/** Number of fast-check runs for a property, scaled (and floored so a property always runs). */
export function fuzzRuns(base: number): number {
  return Math.max(10, Math.round(base * SCALE));
}

/** Fixed fast-check seed: deterministic, replayable failures across machines and runs. */
export const SEED = 0x57_a7_a5 as const;

/**
 * A tiny deterministic PRNG (mulberry32) for the non-fast-check scenarios that need cheap,
 * reproducible randomness without property-shrinking. Returns a `() => number` in `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in `[0, n)` from a mulberry32 stream. */
export function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

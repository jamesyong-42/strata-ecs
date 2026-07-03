/**
 * Stress: the M4 reconcile matrix under a wide, seeded, interleaved two-peer op stream (design.md
 * §13.3–§13.5). The same whole-system convergence invariant the ci suite pins (reconcile.test.ts), run
 * with many more seeds, ops, and entities — the drag/drop/hold/commit/sweep paths crossed exhaustively.
 *
 * Scale with `STRESS_SCALE` (see src/core/__stress__/harness.ts): base is 15 seeds × 500 ops × 6
 * entities (well wider than ci's 5 × 100 × 4); `STRESS_SCALE=10` cranks each for a punishing soak. The
 * per-run cost grows with ops (the every-k-ops full-snapshot exchange scans the whole, growing doc), so
 * ops is the knob to raise carefully.
 */

import { describe, expect, it } from "vitest";
import { scaled } from "../../core/__stress__/harness";
import { runConvergenceProperty } from "./reconcile-harness";

describe("reconcile convergence — wide seeded soak (§13.3)", () => {
  const seeds = scaled(15);
  const ops = scaled(500);
  const entities = scaled(6);

  it(`converges across ${seeds} seeds (${ops} ops, ${entities} entities each)`, () => {
    for (let seed = 1; seed <= seeds; seed++) {
      expect(() => runConvergenceProperty({ seed: seed * 0x9e3779b1, ops, entities })).not.toThrow();
    }
  });
});

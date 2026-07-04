import { defineConfig } from "vitest/config";

/**
 * The ci fuzz SMOKE (review-part1 R7). Every `*.fuzz.ts` property runs on every `ci` at a reduced
 * scale (`STRESS_SCALE=0.1`, set by the `test:stress:smoke` script) so the fuzz tier can never rot
 * unrun — a property that stops compiling or starts throwing is caught in ci, not at the next soak.
 * The heavy `*.stress.ts` boundary scenarios (up to ~1M entities) stay OUT of the smoke and behind
 * the full `test:stress` soak; only the property fuzzers, which shrink cleanly with STRESS_SCALE
 * (fuzzRuns floors at 10, scaled sizes shrink), run here. See __stress__/harness.ts for the knobs.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.fuzz.ts", "test/stress/**/*.fuzz.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

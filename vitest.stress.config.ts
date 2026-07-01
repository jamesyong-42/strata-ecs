import { defineConfig } from "vitest/config";

/**
 * Heavy stress + property-based fuzz suites. Kept OUT of the default `test`/`ci` run (which stays
 * fast) and behind `pnpm test:stress`. Files use the `*.stress.ts` suffix so the default
 * `*.{test,spec}.ts` include never picks them up. Scale with `STRESS_SCALE` (see __stress__/harness.ts).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.stress.ts", "src/**/*.fuzz.ts", "test/stress/**/*.{stress,fuzz}.ts"],
    // Boundary scenarios allocate up to ~1M entities and fuzz runs many cases; give them room.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One worker keeps memory-heavy scenarios (1M-entity worlds) from running concurrently.
    fileParallelism: false,
  },
});

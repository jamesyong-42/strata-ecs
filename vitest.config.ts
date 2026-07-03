import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // .tsx covers the strata-ecs/react binding tests (src/react/react.test.tsx).
    include: ["src/**/*.{test,spec}.{ts,tsx}", "test/**/*.{test,spec}.{ts,tsx}"],
    benchmark: {
      include: ["src/**/*.bench.ts", "bench/**/*.bench.ts"],
    },
  },
  // Force esbuild's automatic JSX runtime for the .tsx tests, independent of which tsconfig it
  // happens to resolve (the root tsconfig sets no `jsx`); .ts files carry no JSX, so this is inert there.
  esbuild: { jsx: "automatic" },
});

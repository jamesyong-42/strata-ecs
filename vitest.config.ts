import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    benchmark: {
      include: ["src/**/*.bench.ts", "bench/**/*.bench.ts"],
    },
  },
});

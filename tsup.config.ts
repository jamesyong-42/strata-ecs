import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "durable/index": "src/durable/index.ts",
    "ephemeral/index": "src/ephemeral/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
});

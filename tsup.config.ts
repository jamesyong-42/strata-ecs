import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "durable/index": "src/durable/index.ts",
    "ephemeral/index": "src/ephemeral/index.ts",
    "tools/index": "src/tools/index.ts",
  },
  format: ["esm"],
  // The tools entry is a browser panel — its d.ts generation needs DOM lib types, which the
  // root tsconfig deliberately omits (the omission keeps the CORE provably browser-free; the
  // core's own typecheck still runs without DOM via `tsc --noEmit`).
  dts: { compilerOptions: { lib: ["ES2023", "DOM", "DOM.Iterable"] } },
  clean: true,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
});

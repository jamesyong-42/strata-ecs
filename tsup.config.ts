import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "durable/index": "src/durable/index.ts",
    "ephemeral/index": "src/ephemeral/index.ts",
    "tools/index": "src/tools/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm"],
  // The tools entry is a browser panel — its d.ts generation needs DOM lib types, which the
  // root tsconfig deliberately omits (the omission keeps the CORE provably browser-free; the
  // core's own typecheck still runs without DOM via `tsc --noEmit`).
  // `stripInternal` drops every `@internal`-marked declaration from the shipped .d.ts — the export
  // seam is narrower than the source (R2): the engine primitives on RuntimeStore, the Query plan
  // fields, and the reactive/access-enforcement hooks are all `@internal` and must not ship.
  dts: { compilerOptions: { lib: ["ES2023", "DOM", "DOM.Iterable"], stripInternal: true } },
  clean: true,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
});

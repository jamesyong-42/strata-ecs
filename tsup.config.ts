import { defineConfig, type Options } from "tsup";

const entry = {
  index: "src/index.ts",
  "durable/index": "src/durable/index.ts",
  "ephemeral/index": "src/ephemeral/index.ts",
  "tools/index": "src/tools/index.ts",
  "react/index": "src/react/index.ts",
};

const shared: Options = {
  entry,
  format: ["esm"],
  target: "es2022",
  treeshake: true,
  sourcemap: true,
  // Each config owns a distinct outDir, but `clean` must stay off: the dts config's outDir is
  // the dist ROOT, and cleaning it would race the dev/prod configs' subdirectories out from
  // under them. `pnpm build` pre-cleans dist once instead (package.json).
  clean: false,
};

// Two runtime artifacts + one shared type surface (the .d.ts are identical either way).
// `globalThis.__STRATA_DEV__` is pinned per artifact so `DEV` (src/core/dev.ts) becomes a
// literal: the dev build keeps every diagnostic; in the default build `false ?? x` folds and
// dead `if (DEV)` branches — message strings included — are eliminated. The exports map serves
// dev under the `development` condition and prod as the default; the consumer smoke greps both
// artifacts and runs them under both conditions to keep the elimination honest.
export default defineConfig([
  {
    ...shared,
    outDir: "dist/dev",
    define: { "globalThis.__STRATA_DEV__": "true" },
  },
  {
    ...shared,
    outDir: "dist/prod",
    define: { "globalThis.__STRATA_DEV__": "false" },
    // Fold constants and drop dead branches, but keep names and layout readable — consumers
    // step through this file; their own minifier does the byte-shaving.
    esbuildOptions(options) {
      options.minifySyntax = true;
    },
  },
  {
    ...shared,
    outDir: "dist",
    sourcemap: false,
    // The tools entry is a browser panel — its d.ts generation needs DOM lib types, which the
    // root tsconfig deliberately omits (the omission keeps the CORE provably browser-free; the
    // core's own typecheck still runs without DOM via `tsc --noEmit`).
    // `stripInternal` drops every `@internal`-marked declaration from the shipped .d.ts — the
    // export seam is narrower than the source (R2): the engine primitives on RuntimeStore, the
    // Query plan fields, and the reactive/access-enforcement hooks are all `@internal` and must
    // not ship.
    dts: {
      only: true,
      compilerOptions: { lib: ["ES2023", "DOM", "DOM.Iterable"], stripInternal: true },
    },
  },
]);

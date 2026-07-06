import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// Live-source mode (default): `@vibecook/strata-ecs` resolves straight to ../../src so framework edits
// hot-reload the example instantly — this example exists to drive strata-ecs's development.
// Set STRATA_DIST=1 to drop the alias and exercise the built dist through the exports map
// (requires `pnpm build` at the repo root first).
const useDist = process.env.STRATA_DIST === "1";

// High-resolution performance.now() needs cross-origin isolation; without these headers the
// browser clamps timer precision and the HUD's microsecond claims would be noise.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // The Pages deploy serves the built demo under a subpath (…github.io/strata-ecs/demo/), so
  // asset URLs need the prefix there; local dev and plain builds stay at root.
  base: process.env.DEMO_BASE ?? "/",
  // loro-crdt (the collab layers' CRDT engine) ships a wasm-bindgen module whose glue uses a
  // top-level await; Vite's dev server rejects the ESM-integration wasm import without these.
  // The collab boot is statically imported by main.ts, so loro is in the browser graph in BOTH
  // modes — omit these and even local-only mode fails to load (the whole app depends on them).
  plugins: [wasm(), topLevelAwait()],
  // topLevelAwait's transform emits syntax esbuild refuses to down-level to the es2020 default,
  // so the production build needs a target with native top-level await (every evergreen browser
  // has it). Dev is unaffected; this only gates `vite build`.
  build: { target: "esnext" },
  resolve: {
    alias: useDist
      ? []
      : [
          // Exact-match regexes, subpaths BEFORE the bare name: a plain string alias uses
          // prefix semantics and would rewrite `@vibecook/strata-ecs/tools` into `<src/index.ts>/tools`.
          { find: /^@vibecook\/strata-ecs\/tools$/, replacement: fileURLToPath(new URL("../../src/tools/index.ts", import.meta.url)) },
          { find: /^@vibecook\/strata-ecs\/durable$/, replacement: fileURLToPath(new URL("../../src/durable/index.ts", import.meta.url)) },
          { find: /^@vibecook\/strata-ecs\/ephemeral$/, replacement: fileURLToPath(new URL("../../src/ephemeral/index.ts", import.meta.url)) },
          { find: /^@vibecook\/strata-ecs$/, replacement: fileURLToPath(new URL("../../src/index.ts", import.meta.url)) },
        ],
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});

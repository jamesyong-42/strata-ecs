import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Live-source mode (default): `strata-ecs` resolves straight to ../../src so framework edits
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
  resolve: {
    alias: useDist
      ? []
      : [
          // Exact-match regexes, subpaths BEFORE the bare name: a plain string alias uses
          // prefix semantics and would rewrite `strata-ecs/tools` into `<src/index.ts>/tools`.
          { find: /^strata-ecs\/tools$/, replacement: fileURLToPath(new URL("../../src/tools/index.ts", import.meta.url)) },
          { find: /^strata-ecs\/durable$/, replacement: fileURLToPath(new URL("../../src/durable/index.ts", import.meta.url)) },
          { find: /^strata-ecs\/ephemeral$/, replacement: fileURLToPath(new URL("../../src/ephemeral/index.ts", import.meta.url)) },
          { find: /^strata-ecs$/, replacement: fileURLToPath(new URL("../../src/index.ts", import.meta.url)) },
        ],
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});

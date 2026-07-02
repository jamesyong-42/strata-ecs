import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Live-source mode (default): `strata` resolves straight to ../../src so framework edits
// hot-reload the example instantly — this example exists to drive strata's development.
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
          // Exact-match regex: a plain string alias uses prefix semantics and would also
          // rewrite future `strata/durable` imports into `<src/index.ts>/durable`.
          { find: /^strata$/, replacement: fileURLToPath(new URL("../../src/index.ts", import.meta.url)) },
        ],
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});

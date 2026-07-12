/**
 * Dev-mode diagnostics (design §5.5, as-amended). `DEV` gates warnings/errors.
 *
 * Resolution order:
 *
 *  1. `globalThis.__STRATA_DEV__` — the build-time constant. The shipped artifacts pin it via
 *     esbuild `define`: the dev build (exports-map `development` condition) hardcodes `true`,
 *     the default build hardcodes `false` — `false ?? x` folds to a literal, so every
 *     `if (DEV)` branch is ELIMINATED from the default artifact, diagnostics strings included
 *     (the consumer smoke greps the shipped files to keep this honest). Consumers never set
 *     this global themselves; bundlers choose the artifact through the exports map (Vite,
 *     webpack and friends apply `development`/production automatically; plain Node gets the
 *     production build unless run with `--conditions=development`).
 *
 *  2. Runtime fallback — running from SOURCE, where no define exists (vitest, the examples'
 *     live-src alias, tsx): dev unless NODE_ENV says production; a bare browser without
 *     `process` is dev. A `globalThis` property read cannot throw where a bare identifier
 *     would, which is what keeps unbuilt source runnable everywhere.
 */
declare global {
  // `var` (not let/const) is what declares a `globalThis` property in an ambient block.
  var __STRATA_DEV__: boolean | undefined;
}

export const DEV: boolean =
  globalThis.__STRATA_DEV__ ??
  (typeof process === "undefined" || process.env?.NODE_ENV !== "production");

/** A recoverable dev-mode warning (a likely mistake that is safely absorbed, e.g. a stale no-op). */
export function devWarn(message: string): void {
  if (DEV) console.warn(`strata: ${message}`);
}

/** A dev-mode error (a real bug the framework refuses to guess through, but must not throw mid-flush). */
export function devError(message: string): void {
  if (DEV) console.error(`strata: ${message}`);
}

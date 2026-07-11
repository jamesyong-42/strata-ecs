/**
 * Dev-mode diagnostics (design §5.5). `DEV` gates warnings/errors. Defaults to dev when there is
 * no `process` (e.g. a raw browser without a bundler define).
 *
 * FOLDING HONESTY NOTE (review 2026-07-11): the `typeof process` guard below is what keeps a raw,
 * bundler-less browser in DEV mode instead of throwing — but it also DEFEATS bundler constant
 * folding. Defining `process.env.NODE_ENV = "production"` folds only the SECOND disjunct, so
 * `if (DEV)` branches are dead at runtime only where `process` actually exists (node/SSR
 * production, or a browser build that shims/defines `process`); an UN-SHIMMED browser production
 * bundle RETAINS every `if (DEV)` branch and evaluates DEV = true at runtime. Full elimination
 * needs dev/prod artifacts behind conditional exports — a tracked follow-up. Until then, browser
 * apps that want DEV=false in production must provide a `process` shim/define.
 */
export const DEV: boolean =
  typeof process === "undefined" || process.env?.NODE_ENV !== "production";

/** A recoverable dev-mode warning (a likely mistake that is safely absorbed, e.g. a stale no-op). */
export function devWarn(message: string): void {
  if (DEV) console.warn(`strata: ${message}`);
}

/** A dev-mode error (a real bug the framework refuses to guess through, but must not throw mid-flush). */
export function devError(message: string): void {
  if (DEV) console.error(`strata: ${message}`);
}

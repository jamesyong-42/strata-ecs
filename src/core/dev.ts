/**
 * Dev-mode diagnostics (design §5.5). `DEV` gates warnings/errors that a bundler replaces and
 * tree-shakes out of production builds (define `process.env.NODE_ENV = "production"`). Defaults
 * to dev when there is no `process` (e.g. a raw browser without a bundler define).
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

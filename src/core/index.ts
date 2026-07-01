/**
 * Part I — The Runtime Core.
 *
 * A complete ECS: typed-array archetype columns, generational-index identity,
 * the schema API, the mutation layer (shape/value split + command buffer), the
 * query engine, the tick pipeline, and non-collaborative save/load.
 *
 * Implementation lands here milestone by milestone — see `docs/plan-part1.md`.
 */

/** Package version. Kept in sync with package.json at release time. */
export const VERSION = "0.0.0";

/**
 * The cross-library benchmark contract. Every library implements the same five canonical scenarios
 * (ported from the Rust `ecs_bench_suite` / noctjs JS suite) behind this interface, each in its own
 * idiomatic *fastest* form. A scenario's `run` returns a checksum (a summed component value) so that
 * (a) mitata's `do_not_optimize` can consume it to defeat dead-code elimination, and (b) the runner
 * can assert every library computed the SAME result from a fresh setup — proof they did equal work.
 *
 * Scenario ops are ADDITIVE / swap-based (not the canonical `*= 2`) to keep values finite over
 * mitata's many iterations, so the checksum can't drift to Infinity and confound the parity check.
 * The work profile (monomorphic per-entity arithmetic over the same entity counts) is unchanged.
 */

/** Canonical entity counts, shared across all library implementations. */
export const N = {
  packed: 1000, // packed_5: all entities carry all 5 components
  simplePerLayout: 1000, // simple_iter: 4 layouts × this = 4000
  fragPerType: 100, // frag_iter: 26 component types × this = 2600
  cycle: 1000, // entity_cycle: creations per op
  addRemove: 1000, // add_remove: entities toggled per op
} as const;

export const SCENARIO_IDS = [
  "packed_5",
  "simple_iter",
  "frag_iter",
  "entity_cycle",
  "add_remove",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface Scenario {
  readonly id: ScenarioId;
  /** Build the world once (outside timing). Returns opaque per-scenario state. */
  setup(): unknown;
  /** One measured operation. Returns a checksum derived from the work (for DCE-guard + parity). */
  run(state: unknown): number;
}

export interface LibraryBench {
  /** Display name, e.g. "strata". */
  readonly name: string;
  /** Exact version benchmarked, e.g. "0.4.0". */
  readonly version: string;
  readonly scenarios: readonly Scenario[];
}

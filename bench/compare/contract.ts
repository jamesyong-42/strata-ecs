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

/**
 * Extension scenarios — clearly labeled as BEYOND the canonical `ecs_bench_suite` set. They probe
 * editor/collab-relevant workloads: `serialize` (whole-world save/load round-trip — a strata built-in
 * that the rivals don't offer, so it's strata-only) and `random_access` (read a component for many
 * random entities by handle — a gather workload where flat eid-indexed stores have an edge).
 */
export const EXTENSION_IDS = ["serialize", "random_access"] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

/**
 * Realistic ECS-flow scenarios — a full frame run through EACH library's real system pipeline
 * (strata `world.tick`, becsy `world.execute`, or a hand-composed function pipeline for the
 * scheduler-less libs), not isolated micro-ops. They exercise what the abeimler / fireveined suites
 * emphasize: multiple interdependent systems, a heterogeneous world (query joins + exclusions +
 * per-row filters), raw column read/write inside systems, and in-system deferred structural change.
 *
 *  - sim_frame        — a 4-system frame over a mixed world (Not-exclusion + multi-component joins).
 *  - spawn_reap_frame — systems that spawn then destroy entities during iteration (lifecycle churn).
 *  - toggle_frame     — a system that adds then removes a component during iteration (shape churn).
 */
export const FRAME_IDS = ["sim_frame", "spawn_reap_frame", "toggle_frame"] as const;
export type FrameId = (typeof FRAME_IDS)[number];

/** Shared random-access parameters + the fixed access pattern, so every library reads the SAME
 *  entity sequence and computes the SAME checksum (parity by construction). Pos.x[i] = i. */
export const RANDOM_ACCESS = { entities: 10_000, reads: 10_000 } as const;
export function accessIndex(k: number, num: number): number {
  return (Math.imul(k, 2654435761) >>> 0) % num; // fixed 32-bit hash → deterministic, cross-library
}

export interface Scenario {
  readonly id: ScenarioId | ExtensionId | FrameId;
  /** Build the world once (outside timing). Returns opaque per-scenario state. */
  setup(): unknown;
  /**
   * One measured operation. Returns a checksum derived from the work (for DCE-guard + parity).
   * May be async (becsy's `world.execute()` is a Promise) — the harness awaits it.
   */
  run(state: unknown): number | Promise<number>;
}

export interface LibraryBench {
  /** Display name, e.g. "@vibecook/strata-ecs". */
  readonly name: string;
  /** Exact version benchmarked, e.g. "0.4.0". */
  readonly version: string;
  readonly scenarios: readonly Scenario[];
  /** Optional extension scenarios (a library may implement a subset, or none). */
  readonly extensions?: readonly Scenario[];
  /** Optional realistic-frame scenarios run through the library's real system pipeline. */
  readonly frames?: readonly Scenario[];
}

/**
 * strata-ecs — a collaborative ECS framework for editors and infinite-canvas apps.
 *
 * This is the public entry for **Part I, the Runtime Core**: a complete, fast,
 * local ECS with zero durability and zero sync. The optional layers are separate
 * subpath exports so you only pay for what you import:
 *
 *   - `@vibecook/strata-ecs/durable`   — Part III, collaborative persistence over a Loro CRDT
 *   - `@vibecook/strata-ecs/ephemeral` — Part IV, transient writer-partitioned presence state
 *
 * See `docs/design.md` for the full architecture and `docs/plan-part1.md` for
 * the Part I build plan.
 */
export * from "./core";

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
// Petition 10 — reconcile-grade component-cell equality for consumer differs (design-009 BF-D20).
// It lives in the substrate (canon.ts, beside the primitives it wraps) but is public on THIS
// barrel only; the substrate barrel itself stays internal.
export { valueEquals } from "./substrate/canon";

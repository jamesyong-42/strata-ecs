/**
 * Part I — The Runtime Core.
 *
 * A complete, fast, local ECS: typed-array archetype columns, generational-index identity, the
 * schema API, the mutation layer (shape/value split + command buffer), the query engine, the
 * value-driven tick pipeline. Zero durability, zero sync. See `docs/design.md`.
 */

/** Package version. Kept in sync with package.json at release time. */
export const VERSION = "0.0.0";

// --- entity handle ---
export type { Entity } from "./entity";

// --- schema ---
export {
  defineComponent,
  defineTag,
  defineRelation,
  defineResource,
} from "./schema";
export type {
  Component,
  Tag,
  Relation,
  Resource,
  Arity,
  ComponentId,
  TagId,
  RelationId,
  ResourceId,
  FieldId,
  FieldMeta,
  SpawnInitOf,
} from "./schema";

// --- field types + schema-literal inference helpers (§4) ---
export { field, enumOf, entityKey } from "./field";
export type {
  ScalarType,
  EnumType,
  FieldType,
  FieldSpec,
  FieldInput,
  Column,
  EntityKey,
  ValueOf,
  WriteOf,
  ColumnsOf,
} from "./field";

// --- queries ---
export { defineQuery, Not, Any, All, Related } from "./query";
export type { Query, QueryTerm, Atom, RelTerm, Batch } from "./query";

// --- systems + schedule ---
export { defineSystem, phase } from "./system";
// SystemCtx is type-only: the tick constructs it (World owns one internally) and hands it to bodies
// as `ctx`; applications never `new` it, so the concrete class is not public API (R2 seam).
export type { SystemCtx, System, Phase, Pipeline, Condition, SystemBody, EntityEditor, SystemAccess } from "./system";
export { validatePipelineAccess } from "./access-diagnostics";

// --- world ---
export { World, createWorld } from "./world";
export type { InboundSource } from "./world";

// --- reactivity (Patch Note 002) — the poll-at-boundary observer layer, reached via world.reactive ---
export { Reactive } from "./reactive";
export type { Unsubscribe } from "./reactive";

// --- dev-tool observability (the `strata/tools` data feed) ---
export type { WorldObserver } from "./observe";

// --- the store contract + implementation + command types (the seam Parts II–IV build on) ---
export type { ECSStore } from "./ecs-store";
// RuntimeStore is type-only: `world.runtime` is typed by it so tools/projection can reach the engine,
// but the concrete class — constructible, carrying the internal primitives — is not public API (R2).
// Those primitives are marked internal and stripped from the shipped .d.ts by `stripInternal`; the
// public seam is ECSStore plus the projection methods (design §ref ~1250).
export type { RuntimeStore, SpawnInit, ComponentEntry } from "./runtime-store";
export type { StructuralCommand, ComponentInit, CommandBuffer } from "./command";

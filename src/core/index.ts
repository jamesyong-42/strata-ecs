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
} from "./schema";

// --- field types ---
export { field, enumOf, entityKey } from "./field";
export type { ScalarType, EnumType, FieldType, FieldSpec, FieldInput, Column, EntityKey } from "./field";

// --- queries ---
export { defineQuery, Not, Any, All, Related } from "./query";
export type { Query, QueryTerm, Atom, RelTerm, Batch } from "./query";

// --- systems + schedule ---
export { defineSystem, phase, SystemCtx } from "./system";
export type { System, Phase, Pipeline, Condition, SystemBody, EntityEditor } from "./system";

// --- world ---
export { World, createWorld } from "./world";
export type { InboundSource } from "./world";

// --- the store contract + implementation + command types (the seam Parts II–IV build on) ---
export type { ECSStore } from "./ecs-store";
export { RuntimeStore } from "./runtime-store";
export type { SpawnInit, ComponentEntry } from "./runtime-store";
export type { StructuralCommand, ComponentInit, CommandBuffer } from "./command";

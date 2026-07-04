/**
 * The schema layer — declaring the data (design §4).
 *
 * Schema is **process-global**: `define*` populate module-level registries and return opaque
 * handles meant to be held as module constants and shared across worlds. Ids are dense **per
 * kind** (component / tag / relation / resource each count from 0), which keeps archetype
 * bitmasks (M4) and tag-bitset / relation-map indexing (M3) compact. Every component field
 * also gets a dense **global** `FieldId`, the key its archetype column is stored under.
 *
 * One shared name {@link Registry} enforces global name uniqueness across all kinds and owns
 * framework-name reservations (e.g. the ephemeral store's `Local` tag, §3.4).
 */

import { Registry } from "./registry";
import {
  type ColumnKind,
  type FieldInput,
  type FieldSpec,
  type ValueOf,
  type WriteOf,
  columnKindOf,
  encodeField,
  normalizeField,
} from "./field";

export type ComponentId = number;
export type TagId = number;
export type RelationId = number;
export type ResourceId = number;
export type FieldId = number;

/** Metadata for one component field: its global column key, name, spec, and routed kind. */
export interface FieldMeta {
  readonly fieldId: FieldId;
  readonly name: string;
  readonly spec: FieldSpec;
  readonly kind: ColumnKind;
  readonly component: ComponentId;
}

/**
 * The public component handle — opaque; carries identity + field layout (§3.4 identity stack).
 * `S` is the decoded read-value type; `Sch` is the schema LITERAL, retained so `col()` can recover
 * exact column types and `spawn` can check per-field values (the value type alone cannot tell an
 * f32 column from an f64, or a defaulted field from a required one). A bare `Component` keeps the
 * pre-inference behavior (unknown value, loose columns).
 */
export interface Component<S = unknown, Sch = Record<string, FieldInput>> {
  readonly id: ComponentId;
  readonly name: string;
  readonly fields: readonly FieldMeta[];
  readonly fieldByName: ReadonlyMap<string, FieldMeta>;
  /** Phantom marker for the field-value type `S`; never present at runtime. */
  readonly __value?: S;
  /** Phantom marker for the schema literal `Sch`; never present at runtime. */
  readonly __schema?: Sch;
}

/** The public tag handle. */
export interface Tag {
  readonly id: TagId;
  readonly name: string;
}

/**
 * The typed `spawn` init for `World`/`SystemCtx` (§5.2). `T` is the tuple of per-entry SCHEMA
 * literals, inferred from the component handles; each value is then checked against its component's
 * schema via {@link WriteOf} (defaulted fields optional, wrong/missing fields rejected). A
 * heterogeneous inline `components` array checks per element with no annotations. Two shapes the
 * mapped tuple cannot infer through — a value that is a UNION of differently-shaped tuples, and a
 * pre-built `readonly ComponentEntry[]` (the store's loose form) — are spawned by lifting the union
 * to the call site or by going through the loose store surface (`world.runtime.spawn`), respectively.
 */
export interface SpawnInitOf<T extends readonly Record<string, FieldInput>[]> {
  components?: readonly [...{ [K in keyof T]: readonly [Component<unknown, T[K]>, WriteOf<T[K]>] }];
  tags?: readonly Tag[];
}

export type Arity = "one" | "many";

/** The public relation handle. */
export interface Relation {
  readonly id: RelationId;
  readonly name: string;
  readonly arity: Arity;
}

/** The public resource (world-singleton) handle. `S`/`Sch` mirror {@link Component} (§3.4). */
export interface Resource<S = unknown, Sch = Record<string, FieldInput>> {
  readonly id: ResourceId;
  readonly name: string;
  readonly fields: readonly FieldMeta[];
  readonly fieldByName: ReadonlyMap<string, FieldMeta>;
  readonly __value?: S;
  readonly __schema?: Sch;
}

/** Framework-owned identifiers reserved so user schema can't collide with them (§3.4). */
const FRAMEWORK_RESERVED = ["Local"] as const;

// --- module-level schema state (reassigned by __resetSchemaForTesting) ---

let names!: Registry;
let componentsById!: Component[];
let tagsById!: Tag[];
let relationsById!: Relation[];
let resourcesById!: Resource[];
let fieldsById!: FieldMeta[];
let componentsByName!: Map<string, Component>;
let tagsByName!: Map<string, Tag>;
let relationsByName!: Map<string, Relation>;
let resourcesByName!: Map<string, Resource>;
let nextComponentId!: number;
let nextTagId!: number;
let nextRelationId!: number;
let nextResourceId!: number;
let nextFieldId!: number;

function initSchemaState(): void {
  names = new Registry();
  for (const n of FRAMEWORK_RESERVED) names.reserve(n);
  componentsById = [];
  tagsById = [];
  relationsById = [];
  resourcesById = [];
  fieldsById = [];
  componentsByName = new Map();
  tagsByName = new Map();
  relationsByName = new Map();
  resourcesByName = new Map();
  nextComponentId = 0;
  nextTagId = 0;
  nextRelationId = 0;
  nextResourceId = 0;
  nextFieldId = 0;
}
initSchemaState();

/**
 * Declare a component and route each field to a column (§4). Field names must be unique in the
 * schema. The schema literal is captured as `Sch` (via the `const` type parameter), so the returned
 * handle's value type is INFERRED from it — no hand-declared `<S>` that can silently drift.
 */
export function defineComponent<const Sch extends Record<string, FieldInput>>(
  name: string,
  schema: Sch,
): Component<ValueOf<Sch>, Sch> {
  names.define(name);
  const id = nextComponentId++;
  const fields: FieldMeta[] = [];
  const fieldByName = new Map<string, FieldMeta>();
  for (const [fieldName, input] of Object.entries(schema)) {
    const spec = normalizeField(input);
    const meta: FieldMeta = {
      fieldId: nextFieldId++,
      name: fieldName,
      spec,
      kind: columnKindOf(spec.type),
      component: id,
    };
    fields.push(meta);
    fieldByName.set(fieldName, meta);
    fieldsById[meta.fieldId] = meta;
  }
  const handle: Component<ValueOf<Sch>, Sch> = { id, name, fields, fieldByName };
  componentsById[id] = handle;
  componentsByName.set(name, handle);
  return handle;
}

/** Declare a zero-sized marker tag (§4). */
export function defineTag(name: string): Tag {
  names.define(name);
  const handle: Tag = { id: nextTagId++, name };
  tagsById[handle.id] = handle;
  tagsByName.set(name, handle);
  return handle;
}

/**
 * @internal Mint the handle for a framework-RESERVED tag (§3.4) — the path the framework itself uses,
 * since {@link defineTag} rejects reserved names (they are import-only for USER schema). Currently used
 * exactly once, for the ephemeral store's `Local` partition marker (design §15.4/§20 — `import { Local }
 * from "strata-ecs"`). Registers the handle in both tag maps so it behaves like any tag for the runtime's
 * `TagStore` and queries; the name is already interned by {@link initSchemaState}'s reservation, so this
 * does NOT call `names.define` (which would reject it). Requires the name to be reserved, so it can never
 * be used to shadow a user tag. Idempotent within a schema epoch (returns the existing handle) so a stray
 * second call after `__resetSchemaForTesting` is harmless.
 */
export function defineFrameworkTag(name: string): Tag {
  if (!names.isReserved(name)) {
    throw new Error(
      `strata: defineFrameworkTag("${name}") — only framework-reserved names may be defined this way (§3.4).`,
    );
  }
  const existing = tagsByName.get(name);
  if (existing !== undefined) return existing;
  const handle: Tag = { id: nextTagId++, name };
  tagsById[handle.id] = handle;
  tagsByName.set(name, handle);
  return handle;
}

/** Declare a typed directed link between entities (§4). */
export function defineRelation(
  name: string,
  opts?: { arity?: Arity },
): Relation {
  names.define(name);
  const handle: Relation = {
    id: nextRelationId++,
    name,
    arity: opts?.arity ?? "one",
  };
  relationsById[handle.id] = handle;
  relationsByName.set(name, handle);
  return handle;
}

/** Declare a world-scoped singleton (§4). Value type inferred from the schema literal, as with
 *  {@link defineComponent}. */
export function defineResource<const Sch extends Record<string, FieldInput>>(
  name: string,
  schema: Sch,
): Resource<ValueOf<Sch>, Sch> {
  names.define(name);
  const id = nextResourceId++;
  const fields: FieldMeta[] = [];
  const fieldByName = new Map<string, FieldMeta>();
  for (const [fieldName, input] of Object.entries(schema)) {
    const spec = normalizeField(input);
    const meta: FieldMeta = {
      fieldId: nextFieldId++,
      name: fieldName,
      spec,
      kind: columnKindOf(spec.type),
      component: -1,
    };
    fields.push(meta);
    fieldByName.set(fieldName, meta);
  }
  const handle: Resource<ValueOf<Sch>, Sch> = { id, name, fields, fieldByName };
  resourcesById[id] = handle;
  resourcesByName.set(name, handle);
  return handle;
}

// --- lookups (used by the store, queries, serialization) ---

export function componentById(id: ComponentId): Component | undefined {
  return componentsById[id];
}
export function tagById(id: TagId): Tag | undefined {
  return tagsById[id];
}
export function relationById(id: RelationId): Relation | undefined {
  return relationsById[id];
}
export function fieldById(id: FieldId): FieldMeta | undefined {
  return fieldsById[id];
}
export function resourceById(id: ResourceId): Resource | undefined {
  return resourcesById[id];
}
export function componentCount(): number {
  return nextComponentId;
}
export function tagCount(): number {
  return nextTagId;
}
export function relationCount(): number {
  return nextRelationId;
}

// --- name lookups (for serialization: durable/snapshot data is name-keyed, §3.4) ---

export function componentByName(name: string): Component | undefined {
  return componentsByName.get(name);
}
export function tagByName(name: string): Tag | undefined {
  return tagsByName.get(name);
}
export function relationByName(name: string): Relation | undefined {
  return relationsByName.get(name);
}
export function resourceByName(name: string): Resource | undefined {
  return resourcesByName.get(name);
}

/**
 * Expand a component value object into encoded per-field stored values, applying declared
 * defaults and enforcing completeness (§4): a field with no value and no default throws.
 */
export function encodeComponentValue(
  component: Component,
  value: Record<string, unknown> | undefined,
): Map<FieldId, number | string | null> {
  const out = new Map<FieldId, number | string | null>();
  for (const f of component.fields) {
    let v: unknown;
    if (value !== undefined && Object.prototype.hasOwnProperty.call(value, f.name)) {
      v = value[f.name];
    } else if (f.spec.hasDefault) {
      v = f.spec.default;
    } else {
      throw new Error(
        `strata: missing required field "${f.name}" for component "${component.name}" (declare a default with field(type, { default }) to make it optional).`,
      );
    }
    out.set(f.fieldId, encodeField(f.spec.type, v));
  }
  return out;
}

/** Whether a name is reserved for the framework (import-only, §3.4). */
export function isReservedName(name: string): boolean {
  return names.isReserved(name);
}

/**
 * Reset all process-global schema state. **Test-only** — the design intends schema handles to
 * be stable module constants for a process's lifetime. Handles created before a reset keep
 * their ids but are no longer registered.
 */
export function __resetSchemaForTesting(): void {
  initSchemaState();
}

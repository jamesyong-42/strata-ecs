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

/** The public component handle — opaque; carries identity + field layout (§3.4 identity stack). */
export interface Component<S = unknown> {
  readonly id: ComponentId;
  readonly name: string;
  readonly fields: readonly FieldMeta[];
  readonly fieldByName: ReadonlyMap<string, FieldMeta>;
  /** Phantom marker for the field-value type `S`; never present at runtime. */
  readonly __value?: S;
}

/** The public tag handle. */
export interface Tag {
  readonly id: TagId;
  readonly name: string;
}

export type Arity = "one" | "many";

/** The public relation handle. */
export interface Relation {
  readonly id: RelationId;
  readonly name: string;
  readonly arity: Arity;
  readonly ordered: boolean;
}

/** The public resource (world-singleton) handle. */
export interface Resource<S = unknown> {
  readonly id: ResourceId;
  readonly name: string;
  readonly fields: readonly FieldMeta[];
  readonly fieldByName: ReadonlyMap<string, FieldMeta>;
  readonly __value?: S;
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
  nextComponentId = 0;
  nextTagId = 0;
  nextRelationId = 0;
  nextResourceId = 0;
  nextFieldId = 0;
}
initSchemaState();

/** Declare a component and route each field to a column (§4). Field names must be unique in the schema. */
export function defineComponent<S = Record<string, unknown>>(
  name: string,
  schema: Record<string, FieldInput>,
): Component<S> {
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
  const handle: Component<S> = { id, name, fields, fieldByName };
  componentsById[id] = handle;
  return handle;
}

/** Declare a zero-sized marker tag (§4). */
export function defineTag(name: string): Tag {
  names.define(name);
  const handle: Tag = { id: nextTagId++, name };
  tagsById[handle.id] = handle;
  return handle;
}

/** Declare a typed directed link between entities (§4). */
export function defineRelation(
  name: string,
  opts?: { arity?: Arity; ordered?: boolean },
): Relation {
  names.define(name);
  const handle: Relation = {
    id: nextRelationId++,
    name,
    arity: opts?.arity ?? "one",
    ordered: opts?.ordered ?? false,
  };
  relationsById[handle.id] = handle;
  return handle;
}

/** Declare a world-scoped singleton (§4). */
export function defineResource<S = Record<string, unknown>>(
  name: string,
  schema: Record<string, FieldInput>,
): Resource<S> {
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
  const handle: Resource<S> = { id, name, fields, fieldByName };
  resourcesById[id] = handle;
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
export function componentCount(): number {
  return nextComponentId;
}
export function tagCount(): number {
  return nextTagId;
}
export function relationCount(): number {
  return nextRelationId;
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

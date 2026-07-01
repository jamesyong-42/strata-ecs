/**
 * The runtime store — the archetype / typed-array engine (design §3, §5.5).
 *
 * This is the one place that knows the in-memory data shape. It owns the entity table, the
 * archetype index, and the five physical primitives (place · unplace · migrate · cell write ·
 * — bit/map mutation arrives with tags/relations in M3). Every operation here is **immediate**;
 * deferral is the system context's concern, not the store's (§ Part I ref, ECSStore).
 *
 * M2 scope: components, placement, and immediate structural/value ops. Tags, relations, and the
 * despawn cascade land in M3; queries in M4; the deferring `ctx` and tick in M5.
 */

import { type Entity, slotOf } from "./entity";
import { EntityTable } from "./entity-table";
import { Archetype } from "./archetype";
import {
  type Column,
  clearCell,
  decodeField,
  moveCell,
  readCell,
  writeCell,
} from "./field";
import {
  type Component,
  type ComponentId,
  type FieldId,
  type FieldMeta,
  type Resource,
  componentById,
  encodeComponentValue,
} from "./schema";

/** A component handle paired with a value of its field type — the typed spawn/init form. */
export type ComponentEntry<S = unknown> = readonly [Component<S>, S];

/** What `spawn` accepts. (Tags arrive in M3.) */
export interface SpawnInit {
  components?: readonly ComponentEntry[];
}

/** Stored per-field value: a number for typed columns, `string | null` for string columns. */
type Stored = number | string | null;

const EMPTY_FIELD_VALUES: ReadonlyMap<FieldId, Stored> = new Map();

export class RuntimeStore {
  private readonly table = new EntityTable();
  private readonly archetypeIndex = new Map<string, Archetype>();
  private readonly archetypesById: Archetype[] = [];
  private readonly emptyArchetype: Archetype;
  private readonly resources = new Map<number, Record<string, unknown>>();
  private readonly archetypeObservers: ((a: Archetype) => void)[] = [];
  private nextArchetypeId = 0;

  constructor() {
    this.emptyArchetype = this.archetypeFor([]);
  }

  // ---------------------------------------------------------------------------
  // Archetype index
  // ---------------------------------------------------------------------------

  /** Look up (or lazily create) the archetype for a sorted, unique list of component ids. */
  private archetypeFor(componentIds: readonly ComponentId[]): Archetype {
    const key = componentIds.join(",");
    const existing = this.archetypeIndex.get(key);
    if (existing) return existing;

    const fields: FieldMeta[] = [];
    for (const cid of componentIds) {
      const c = componentById(cid);
      if (!c) throw new Error(`strata: unknown component id ${cid}.`);
      for (const f of c.fields) fields.push(f);
    }
    const arch = new Archetype(this.nextArchetypeId++, key, componentIds.slice(), fields);
    this.archetypeIndex.set(key, arch);
    this.archetypesById[arch.id] = arch;
    for (const observe of this.archetypeObservers) observe(arch);
    return arch;
  }

  /** Subscribe to archetype creation (queries cache matching-archetype lists this way, §3.1/§6). */
  observeArchetypes(fn: (a: Archetype) => void): void {
    this.archetypeObservers.push(fn);
  }

  /** All archetypes that currently exist (for queries to seed their caches). */
  archetypes(): readonly Archetype[] {
    return this.archetypesById;
  }

  private archetypeOfEntity(e: Entity): Archetype {
    return this.archetypesById[this.table.archetypeOf(slotOf(e))];
  }

  // ---------------------------------------------------------------------------
  // Physical primitives (§5.5)
  // ---------------------------------------------------------------------------

  /** Append entity `e`'s row to archetype `A`, writing every field and the back-pointer. */
  private place(e: Entity, A: Archetype, fieldValues: ReadonlyMap<FieldId, Stored>): void {
    const row = A.count;
    A.ensureCapacity(row + 1);
    for (const f of A.fields) {
      writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, fieldValues.get(f.fieldId) as Stored);
    }
    A.entities[row] = e;
    this.table.setPlacement(slotOf(e), A.id, row);
    A.count++;
  }

  /**
   * Remove the row at `(A, row)` via swap-and-pop, fixing the moved entity's back-pointer and
   * nulling vacated string cells (§5.5). Takes `A`/`row` explicitly — never re-reads the table,
   * which the migrate caller may already have re-pointed.
   */
  private unplace(A: Archetype, row: number, _vacating: Entity): void {
    const last = A.count - 1;
    if (row !== last) {
      const moved = A.entities[last] as Entity;
      for (const f of A.fields) {
        moveCell(A.columns.get(f.fieldId) as Column, f.kind, last, row); // last → row (+ null source if string)
      }
      A.entities[row] = moved;
      this.table.setRow(slotOf(moved), row); // fix the MOVED entity, not the vacating one
    } else {
      for (const f of A.fields) {
        clearCell(A.columns.get(f.fieldId) as Column, f.kind, last); // null a bare-popped string cell
      }
    }
    A.count--;
  }

  /**
   * Move `e` to `newComponentIds`, carrying overlapping fields. Read-before-place-before-unplace:
   * carried values are read from the old row first, then `place` re-points the table, then the old
   * row is swap-popped by its captured location (§5.5).
   */
  private migrate(
    e: Entity,
    newComponentIds: readonly ComponentId[],
    addedFieldValues: ReadonlyMap<FieldId, Stored>,
  ): void {
    const slot = slotOf(e);
    const oldA = this.archetypesById[this.table.archetypeOf(slot)];
    const oldRow = this.table.rowOf(slot);
    const newA = this.archetypeFor(newComponentIds);

    const fieldValues = new Map<FieldId, Stored>();
    for (const f of newA.fields) {
      if (oldA.hasField(f.fieldId)) {
        fieldValues.set(f.fieldId, readCell(oldA.columns.get(f.fieldId) as Column, f.kind, oldRow));
      } else {
        fieldValues.set(f.fieldId, addedFieldValues.get(f.fieldId) as Stored);
      }
    }
    this.place(e, newA, fieldValues); // appends to newA, re-points table[slot] → newA
    this.unplace(oldA, oldRow, e); // swap-pop out of the captured old location
  }

  private static sortedInsert(ids: readonly ComponentId[], id: ComponentId): ComponentId[] {
    return [...ids, id].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  // Identity + placement seams (used by projection, Parts II–IV; §Part I ref)
  // ---------------------------------------------------------------------------

  /** Mint an identity with no placement (§5.2). */
  allocateIdentity(): Entity {
    return this.table.allocate();
  }

  /** Idempotently place an identity-only entity into the empty archetype (§5.5). */
  ensurePlaced(e: Entity): void {
    if (this.table.isIdentityOnly(e)) {
      this.place(e, this.emptyArchetype, EMPTY_FIELD_VALUES);
    }
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  /** Create and immediately place a runtime entity (§5.2 — outside iteration, so immediate). */
  spawn(init?: SpawnInit): Entity {
    const e = this.table.allocate();
    const entries = init?.components ?? [];
    const seen = new Set<ComponentId>();
    const fieldValues = new Map<FieldId, Stored>();
    for (const [component, value] of entries) {
      if (seen.has(component.id)) {
        throw new Error(`strata: component "${component.name}" supplied twice to spawn.`);
      }
      seen.add(component.id);
      for (const [fid, v] of encodeComponentValue(component, value as Record<string, unknown>)) {
        fieldValues.set(fid, v);
      }
    }
    const componentIds = [...seen].sort((a, b) => a - b);
    this.place(e, this.archetypeFor(componentIds), fieldValues);
    return e;
  }

  /** Destroy an entity (M2: unplace + free identity; M3 adds the tag/relation cascade). */
  destroy(e: Entity): void {
    if (!this.table.isAlive(e)) return;
    const slot = slotOf(e);
    if (this.table.isPlaced(e)) {
      const A = this.archetypesById[this.table.archetypeOf(slot)];
      this.unplace(A, this.table.rowOf(slot), e);
    }
    this.table.free(e);
  }

  isAlive(e: Entity): boolean {
    return this.table.isAlive(e);
  }
  isPlaced(e: Entity): boolean {
    return this.table.isPlaced(e);
  }
  isIdentityOnly(e: Entity): boolean {
    return this.table.isIdentityOnly(e);
  }

  // ---------------------------------------------------------------------------
  // Components — shape changes (immediate on this surface)
  // ---------------------------------------------------------------------------

  has(e: Entity, c: Component): boolean {
    return this.table.isPlaced(e) && this.archetypeOfEntity(e).hasComponent(c.id);
  }

  /**
   * Reject a dead/stale handle before a mutating op. Without this, `!isPlaced` is true for BOTH
   * identity-only (state 2) and dead (state 1) handles, so a stale handle would fall into the
   * place-first branch and stamp a reused slot's placement — silent corruption (RS-1).
   */
  private assertAlive(e: Entity, op: string): void {
    if (!this.table.isAlive(e)) {
      throw new Error(`strata: ${op} called on a dead or stale entity handle.`);
    }
  }

  /** Attach a component the entity does not have (shape change). Throws if already present (§5.3). */
  addComponent<S>(e: Entity, c: Component<S>, value: S): void {
    this.assertAlive(e, "addComponent");
    if (this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is already present — use edit().set / writeComponent to overwrite its value.`);
    }
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    if (this.table.isIdentityOnly(e)) {
      // identity-only → placing its first component (state 2 → 3, §5.2)
      this.place(e, this.archetypeFor([c.id]), encoded);
    } else {
      const newIds = RuntimeStore.sortedInsert(this.archetypeOfEntity(e).componentIds, c.id);
      this.migrate(e, newIds, encoded);
    }
  }

  /** Detach a component (shape change). Throws if absent (§5.3). Empty result stays placed (∅). */
  removeComponent(e: Entity, c: Component): void {
    this.assertAlive(e, "removeComponent");
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present — cannot remove it.`);
    }
    const newIds = this.archetypeOfEntity(e).componentIds.filter((id) => id !== c.id);
    this.migrate(e, newIds, EMPTY_FIELD_VALUES);
  }

  /** Overwrite the value of a component the entity already has (value change). Throws if absent. */
  writeComponent<S>(e: Entity, c: Component<S>, value: S): void {
    this.assertAlive(e, "writeComponent");
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present — use addComponent to attach it first.`);
    }
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    for (const f of c.fields) {
      writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, encoded.get(f.fieldId) as Stored);
    }
  }

  // ---------------------------------------------------------------------------
  // Component projection primitives (key-facing wrappers live in the projector, §10.3)
  // ---------------------------------------------------------------------------

  /** Projection: add-if-absent-else-write; places an identity-only entity on its first component. */
  projectComponent<S>(e: Entity, c: Component<S>, value: S): void {
    this.assertAlive(e, "projectComponent");
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    if (this.table.isIdentityOnly(e)) {
      this.place(e, this.archetypeFor([c.id]), encoded);
    } else if (this.archetypeOfEntity(e).hasComponent(c.id)) {
      const A = this.archetypeOfEntity(e);
      const row = this.table.rowOf(slotOf(e));
      for (const f of c.fields) {
        writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, encoded.get(f.fieldId) as Stored);
      }
    } else {
      const newIds = RuntimeStore.sortedInsert(this.archetypeOfEntity(e).componentIds, c.id);
      this.migrate(e, newIds, encoded);
    }
  }

  /** Projection: detach a component if present, else no-op. */
  projectRemoveComponent(e: Entity, c: Component): void {
    if (this.has(e, c)) this.removeComponent(e, c);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Whole-component read — throws if absent (hot-path reader, §Part I ref). */
  read<S>(e: Entity, c: Component<S>): S {
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present on this entity.`);
    }
    return this.readPresent(e, c);
  }

  /** Safe read — `undefined` if absent or identity-only (§5.2). */
  get<S>(e: Entity, c: Component<S>): S | undefined {
    return this.has(e, c) ? this.readPresent(e, c) : undefined;
  }

  private readPresent<S>(e: Entity, c: Component<S>): S {
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    const out: Record<string, unknown> = {};
    for (const f of c.fields) {
      out[f.name] = decodeField(f.spec.type, readCell(A.columns.get(f.fieldId) as Column, f.kind, row));
    }
    return out as S;
  }

  /** Read a validated `eid` field: the referenced entity, or `undefined` if the ref dangles (§2). */
  readEid(e: Entity, c: Component, field: FieldId): Entity | undefined {
    if (!this.has(e, c)) return undefined;
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    const ref = (readCell(A.columns.get(field) as Column, "u32", row) as number) as Entity;
    return this.table.isAlive(ref) ? ref : undefined;
  }

  // ---------------------------------------------------------------------------
  // Resources (world singletons, stored as plain objects, §1)
  // ---------------------------------------------------------------------------

  setResource<S>(res: Resource<S>, value: S): void {
    const obj: Record<string, unknown> = {};
    const v = value as Record<string, unknown>;
    for (const f of res.fields) {
      if (v !== undefined && Object.prototype.hasOwnProperty.call(v, f.name)) {
        obj[f.name] = v[f.name];
      } else if (f.spec.hasDefault) {
        obj[f.name] = f.spec.default;
      } else {
        throw new Error(`strata: missing required field "${f.name}" for resource "${res.name}".`);
      }
    }
    this.resources.set(res.id, obj);
  }

  getResource<S>(res: Resource<S>): S | undefined {
    return this.resources.get(res.id) as S | undefined;
  }

  // ---------------------------------------------------------------------------
  // Introspection (for tests / tooling)
  // ---------------------------------------------------------------------------

  /** The archetype an entity is currently placed in, or `undefined` if identity-only. */
  debugArchetypeOf(e: Entity): Archetype | undefined {
    return this.table.isPlaced(e) ? this.archetypeOfEntity(e) : undefined;
  }
}

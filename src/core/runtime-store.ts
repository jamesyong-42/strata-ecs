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
import { TagStore } from "./tags";
import { RelationStore } from "./relations";
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
  type Relation,
  type Resource,
  type Tag,
  componentById,
  encodeComponentValue,
  relationById,
  relationCount,
  resourceById,
  tagById,
  tagCount,
} from "./schema";
import type { Batch, MemberCheck, Query, RowFilter } from "./query";
import type { CommandBuffer, StructuralCommand } from "./command";
import type { ECSStore } from "./ecs-store";
import { DEV, devError, devWarn } from "./dev";

/** A component handle paired with a value of its field type — the typed spawn/init form. */
export type ComponentEntry<S = unknown> = readonly [Component<S>, S];

/** What `spawn` accepts. */
export interface SpawnInit {
  components?: readonly ComponentEntry[];
  tags?: readonly Tag[];
}

/** Stored per-field value: a number for typed columns, `string | null` for string columns. */
type Stored = number | string | null;

const EMPTY_FIELD_VALUES: ReadonlyMap<FieldId, Stored> = new Map();

export class RuntimeStore implements ECSStore {
  private readonly table = new EntityTable();
  private readonly tags = new TagStore();
  private readonly relations = new RelationStore((e) => this.table.isAlive(e));
  private readonly archetypeIndex = new Map<string, Archetype>();
  private readonly archetypesById: Archetype[] = [];
  private readonly emptyArchetype: Archetype;
  private readonly resources = new Map<number, Record<string, unknown>>();
  private readonly archetypeObservers: ((a: Archetype) => void)[] = [];
  private readonly queryMatches = new Map<Query, Archetype[]>();
  private readonly bufferPool: StructuralCommand[][] = [];
  private readonly freeBuffers: CommandBuffer[] = [];
  private nextArchetypeId = 0;
  /**
   * Soft cap on deferred ops in a single phase. The buffer is otherwise unbounded (§5.4), so a
   * system deferring per row over a huge query can grow it without limit → OOM with no clean error.
   * Crossing this emits a one-shot DEV back-pressure warning (never a throw — a flush must not fail
   * mid-drain). DEV-only; stripped in production.
   */
  private commandBufferWarnThreshold = 1_000_000;

  constructor() {
    this.emptyArchetype = this.archetypeFor([]);
    // Keep every cached query's matching-archetype list current as new archetypes appear (§6.1).
    this.observeArchetypes((arch) => {
      for (const [q, list] of this.queryMatches) {
        if (this.archetypeMatchesQuery(q, arch)) list.push(arch);
      }
    });
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

  /** Place an already-allocated identity into its components' archetype and set its tags. */
  private placeComposed(
    e: Entity,
    componentIds: ComponentId[],
    fieldValues: ReadonlyMap<FieldId, Stored>,
    tagIds?: readonly number[],
  ): void {
    this.place(e, this.archetypeFor(componentIds), fieldValues);
    if (tagIds !== undefined && tagIds.length > 0) {
      const slot = slotOf(e);
      for (const t of tagIds) this.tags.set(t, slot);
    }
  }

  /** Create and immediately place a runtime entity (§5.2 — outside iteration, so immediate). */
  spawn(init?: SpawnInit): Entity {
    const e = this.table.allocate();
    const seen = new Set<ComponentId>();
    const fieldValues = new Map<FieldId, Stored>();
    for (const [component, value] of init?.components ?? []) {
      if (seen.has(component.id)) {
        throw new Error(`strata: component "${component.name}" supplied twice to spawn.`);
      }
      seen.add(component.id);
      for (const [fid, v] of encodeComponentValue(component, value as Record<string, unknown>)) {
        fieldValues.set(fid, v);
      }
    }
    this.placeComposed(
      e,
      [...seen].sort((a, b) => a - b),
      fieldValues,
      init?.tags?.map((t) => t.id),
    );
    return e;
  }

  /** Destroy an entity: clear its tags/relations inline, unplace, then free identity (§5.5). */
  destroy(e: Entity): void {
    if (!this.table.isAlive(e)) return;
    const slot = slotOf(e);
    // Per-entity state living outside the archetype must be torn down for placed AND
    // identity-only entities so a reused slot starts clean (§5.5):
    this.relations.clearEntity(e); // both directions, inline, terminal
    this.tags.clearAll(slot); // mandatory — bitsets are slot-indexed, not generation-indexed (§3.2)
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
  // Tags (slot-indexed bitsets, §3.2)
  // ---------------------------------------------------------------------------

  /** Add a tag; places an identity-only source so it becomes queryable (§5.2). */
  addTag(e: Entity, t: Tag): void {
    this.assertAlive(e, "addTag");
    this.ensurePlaced(e);
    this.tags.set(t.id, slotOf(e));
  }

  /** Remove a tag (does not unplace the entity). */
  removeTag(e: Entity, t: Tag): void {
    this.assertAlive(e, "removeTag");
    this.tags.clear(t.id, slotOf(e));
  }

  /** Generation-guarded tag read: a stale handle reads `false`, never the reused slot's bit (§3.2). */
  hasTag(e: Entity, t: Tag): boolean {
    if (!this.table.isAlive(e)) return false;
    return this.tags.has(t.id, slotOf(e));
  }

  /** @internal Raw tag bitset — for the query engine's row probes (§6). */
  tagBitset(t: Tag): Uint32Array | undefined {
    return this.tags.bitset(t.id);
  }

  // ---------------------------------------------------------------------------
  // Relations (bidirectional indices, §3.3)
  // ---------------------------------------------------------------------------

  /** Arity "one": set/replace the target. Places the source; the target is not placed (§5.2). */
  setRelation(e: Entity, rel: Relation, target: Entity): void {
    this.assertAlive(e, "setRelation");
    if (rel.arity !== "one") {
      throw new Error(`strata: setRelation is for arity "one" relations — use addRelation for "${rel.name}".`);
    }
    this.ensurePlaced(e);
    this.relations.setOne(rel, e, target);
  }

  /** Arity "many": add an edge (idempotent). Places the source; the target is not placed. */
  addRelation(e: Entity, rel: Relation, target: Entity): void {
    this.assertAlive(e, "addRelation");
    if (rel.arity !== "many") {
      throw new Error(`strata: addRelation is for arity "many" relations — use setRelation for "${rel.name}".`);
    }
    this.ensurePlaced(e);
    this.relations.addMany(rel, e, target);
  }

  /** Remove one edge (if `target` given) or all edges of `rel` from `e`. Does not unplace. */
  removeRelation(e: Entity, rel: Relation, target?: Entity): void {
    this.assertAlive(e, "removeRelation");
    this.relations.remove(rel, e, target);
  }

  /** The single target of an arity-"one" relation, validated (§3.3). */
  getRelation(e: Entity, rel: Relation): Entity | undefined {
    return this.relations.getOne(rel, e);
  }

  /** The targets of an arity-"many" relation, validated. */
  getRelations(e: Entity, rel: Relation): Entity[] {
    return this.relations.getMany(rel, e);
  }

  /** The entities pointing at `e` via `rel` (reverse index), validated. */
  getReverse(e: Entity, rel: Relation): Entity[] {
    return this.relations.getReverse(rel, e);
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
  // Command buffer — the system-iteration deferral facility (§5.4, §5.5)
  // ---------------------------------------------------------------------------

  /** Hand out a cleared buffer from the pool (grows the pool only on demand, §5.4). */
  allocateCommandBuffer(): CommandBuffer {
    const reused = this.freeBuffers.pop();
    if (reused !== undefined) {
      this.bufferPool[reused].length = 0;
      return reused;
    }
    this.bufferPool.push([]);
    return this.bufferPool.length - 1;
  }

  /** Append a command (producer-agnostic; only a system's `ctx` calls this, §5.4). */
  enqueue(buf: CommandBuffer, cmd: StructuralCommand): void {
    const arr = this.bufferPool[buf];
    arr.push(cmd);
    // Fires once as the buffer crosses the cap (length resets to 0 at flush, so each phase re-arms).
    if (DEV && arr.length === this.commandBufferWarnThreshold) {
      devWarn(
        `command buffer reached ${arr.length} deferred ops in one phase — this is unbounded and may exhaust memory. Split the work across phases/ticks, or apply changes immediately outside iteration (§5.4).`,
      );
    }
  }

  /** @internal Test-only: lower the command-buffer soft cap to exercise the back-pressure warning. */
  setCommandBufferWarnThresholdForTesting(n: number): void {
    this.commandBufferWarnThreshold = n;
  }

  /** Single-pass drain: apply every command, then clear. `apply` never enqueues, so no growth (§5.4). */
  flushCommandBuffer(buf: CommandBuffer): void {
    const cmds = this.bufferPool[buf];
    const n = cmds.length; // apply never appends to this buffer → n is stable
    for (let i = 0; i < n; i++) this.applyCommand(cmds[i]);
    cmds.length = 0;
  }

  /** Return a buffer to the pool when its phase is done. */
  releaseCommandBuffer(buf: CommandBuffer): void {
    this.bufferPool[buf].length = 0;
    this.freeBuffers.push(buf);
  }

  /**
   * Apply one buffered shape change (§5.5). Validate-on-read first (a command targeting an
   * entity an earlier command this flush destroyed is skipped), then dispatch to the primitives
   * with the flush-time precondition policy (idempotent no-ops; dev warn/error + skip).
   */
  private applyCommand(cmd: StructuralCommand): void {
    if (!this.table.isAlive(cmd.entity)) return; // validate-on-read
    switch (cmd.kind) {
      case "spawn": {
        const seen = new Set<ComponentId>();
        const fieldValues = new Map<FieldId, Stored>();
        for (const init of cmd.components ?? []) {
          const c = componentById(init.component);
          if (c === undefined || seen.has(init.component)) continue;
          seen.add(init.component);
          for (const [fid, v] of encodeComponentValue(c, init.value as Record<string, unknown>)) {
            fieldValues.set(fid, v);
          }
        }
        this.placeComposed(cmd.entity, [...seen].sort((a, b) => a - b), fieldValues, cmd.tags);
        return;
      }
      case "despawn":
        this.destroy(cmd.entity); // cascade + free (§5.5)
        return;
      case "addComponent": {
        const c = componentById(cmd.component);
        if (c === undefined) return;
        if (this.has(cmd.entity, c)) {
          devError(
            `addComponent at flush: "${c.name}" is already present (two systems added it in one phase?) — skipped; use a value write to overwrite.`,
          );
          return;
        }
        const encoded = encodeComponentValue(c, cmd.value as Record<string, unknown>);
        if (this.table.isIdentityOnly(cmd.entity)) {
          this.place(cmd.entity, this.archetypeFor([c.id]), encoded);
        } else {
          this.migrate(
            cmd.entity,
            RuntimeStore.sortedInsert(this.archetypeOfEntity(cmd.entity).componentIds, c.id),
            encoded,
          );
        }
        return;
      }
      case "removeComponent": {
        const c = componentById(cmd.component);
        if (c === undefined) return;
        if (!this.has(cmd.entity, c)) {
          devWarn(`removeComponent at flush: "${c.name}" is not present — skipped.`);
          return;
        }
        this.migrate(
          cmd.entity,
          this.archetypeOfEntity(cmd.entity).componentIds.filter((id) => id !== c.id),
          EMPTY_FIELD_VALUES,
        );
        return;
      }
      case "addTag":
        this.ensurePlaced(cmd.entity);
        this.tags.set(cmd.tag, slotOf(cmd.entity));
        return;
      case "removeTag":
        this.tags.clear(cmd.tag, slotOf(cmd.entity));
        return;
      case "setRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return; // drop an edge to a dead target
        this.ensurePlaced(cmd.entity);
        this.relations.setOne(rel, cmd.entity, cmd.target);
        return;
      }
      case "addRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return;
        this.ensurePlaced(cmd.entity);
        this.relations.addMany(rel, cmd.entity, cmd.target);
        return;
      }
      case "removeRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined) return;
        this.relations.remove(rel, cmd.entity, cmd.target);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queries — per-chunk dispatch (§6)
  // ---------------------------------------------------------------------------

  /** Run a compiled query, dispatching the body once per matching chunk (§6.2). */
  query(q: Query): { each(fn: (batch: Batch) => void): void } {
    return { each: (fn) => this.runQuery(q, fn) };
  }

  /** The first entity matching `q`, or `undefined` (§Part I ref). */
  firstOf(q: Query): Entity | undefined {
    let found: Entity | undefined;
    this.runQuery(q, (batch) => {
      if (found !== undefined) return;
      for (const r of batch) {
        found = batch.entity(r);
        break;
      }
    });
    return found;
  }

  private runQuery(q: Query, fn: (batch: Batch) => void): void {
    if (q.seed !== undefined) {
      this.runSeeded(q, fn);
      return;
    }
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    for (const arch of matches) {
      if (arch.count === 0) continue; // an empty archetype matches nothing (cheap skip)
      fn(new ArchetypeChunk(this, arch, q.rowFilters));
    }
  }

  /** Concrete-target relation: start from the reverse-index hit set, then verify every other term (§6.4). */
  private runSeeded(q: Query, fn: (batch: Batch) => void): void {
    const seed = q.seed as NonNullable<Query["seed"]>;
    const sources = this.relations.reverseSet(seed.relation, seed.target);
    if (sources === undefined) return;
    for (const src of sources) {
      if (!this.table.isAlive(src)) continue; // validate-on-read
      if (!this.table.isPlaced(src)) continue; // needs a row to be readable
      const arch = this.archetypeOfEntity(src);
      if (!this.archetypeMatchesQuery(q, arch)) continue;
      if (!this.passesRowFilters(q.rowFilters, src, arch)) continue;
      fn(new ArchetypeChunk(this, arch, q.rowFilters, [this.table.rowOf(slotOf(src))]));
    }
  }

  private buildMatches(q: Query): Archetype[] {
    const out: Archetype[] = [];
    for (const arch of this.archetypesById) {
      if (arch !== undefined && this.archetypeMatchesQuery(q, arch)) out.push(arch);
    }
    return out;
  }

  private archetypeMatchesQuery(q: Query, arch: Archetype): boolean {
    for (const id of q.required) if (!arch.hasComponent(id)) return false;
    for (const id of q.excluded) if (arch.hasComponent(id)) return false;
    for (const group of q.anyComponentGroups) {
      let ok = false;
      for (const id of group) {
        if (arch.hasComponent(id)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    return true;
  }

  /** @internal Evaluate all per-row filters for an entity (used by the chunk iterator). */
  passesRowFilters(rowFilters: readonly RowFilter[], e: Entity, arch: Archetype): boolean {
    for (const rf of rowFilters) if (!this.passesRowFilter(rf, e, arch)) return false;
    return true;
  }

  private passesRowFilter(rf: RowFilter, e: Entity, arch: Archetype): boolean {
    switch (rf.kind) {
      case "tag": {
        const has = this.tags.has(rf.tagId as number, slotOf(e));
        return rf.negate ? !has : has;
      }
      case "rel": {
        const rel = rf.relation as Relation;
        const has =
          rf.target !== undefined
            ? this.relations.hasEdge(rel, e, rf.target)
            : this.relations.hasAny(rel, e);
        return rf.negate ? !has : has;
      }
      case "any": {
        let ok = false;
        for (const m of rf.members as readonly MemberCheck[]) {
          if (this.memberCheck(m, e, arch)) {
            ok = true;
            break;
          }
        }
        return rf.negate ? !ok : ok;
      }
    }
  }

  private memberCheck(m: MemberCheck, e: Entity, arch: Archetype): boolean {
    switch (m.kind) {
      case "component":
        return arch.hasComponent(m.componentId as number);
      case "tag":
        return this.tags.has(m.tagId as number, slotOf(e));
      case "rel": {
        const rel = m.relation as Relation;
        return m.target !== undefined
          ? this.relations.hasEdge(rel, e, m.target)
          : this.relations.hasAny(rel, e);
      }
      case "all": {
        for (const mm of m.members as readonly MemberCheck[]) {
          if (!this.memberCheck(mm, e, arch)) return false;
        }
        return true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection (for tests / tooling)
  // ---------------------------------------------------------------------------

  /** The archetype an entity is currently placed in, or `undefined` if identity-only. */
  debugArchetypeOf(e: Entity): Archetype | undefined {
    return this.table.isPlaced(e) ? this.archetypeOfEntity(e) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Snapshot support (§8) — read-only walks over the live state
  // ---------------------------------------------------------------------------

  /** Number of live entities (placed + identity-only). */
  liveCount(): number {
    return this.table.liveCount;
  }

  /** Every placed entity, archetype by archetype (the order a snapshot walk emits). */
  placedEntities(): Entity[] {
    const out: Entity[] = [];
    for (const arch of this.archetypesById) {
      for (let r = 0; r < arch.count; r++) out.push(arch.entities[r] as Entity);
    }
    return out;
  }

  /** The components present on a placed entity. */
  componentsOf(e: Entity): Component[] {
    const arch = this.archetypeOfEntity(e);
    const out: Component[] = [];
    for (const id of arch.componentIds) {
      const c = componentById(id);
      if (c !== undefined) out.push(c);
    }
    return out;
  }

  /** The tags set on an entity (walks every tag type — for serialization). */
  tagsOf(e: Entity): Tag[] {
    const slot = slotOf(e);
    const out: Tag[] = [];
    for (let id = 0; id < tagCount(); id++) {
      if (this.tags.has(id, slot)) {
        const t = tagById(id);
        if (t !== undefined) out.push(t);
      }
    }
    return out;
  }

  /** The outgoing relation edges of an entity, validated (for serialization). */
  relationsOf(e: Entity): Array<{ relation: Relation; targets: Entity[] }> {
    const out: Array<{ relation: Relation; targets: Entity[] }> = [];
    for (let id = 0; id < relationCount(); id++) {
      const rel = relationById(id);
      if (rel === undefined) continue;
      const targets = rel.arity === "one" ? boxed(this.getRelation(e, rel)) : this.getRelations(e, rel);
      if (targets.length > 0) out.push({ relation: rel, targets });
    }
    return out;
  }

  /** Every set resource, with its handle (for serialization). */
  resourceValues(): Array<{ resource: Resource; value: unknown }> {
    const out: Array<{ resource: Resource; value: unknown }> = [];
    for (const [id, value] of this.resources) {
      const res = resourceById(id);
      if (res !== undefined) out.push({ resource: res, value });
    }
    return out;
  }
}

function boxed(e: Entity | undefined): Entity[] {
  return e !== undefined ? [e] : [];
}

/**
 * The per-archetype chunk (§6.2). For the dense path the iterator yields rows passing the
 * plan's row filters; for the seeded path it yields the pre-verified seed rows directly.
 */
class ArchetypeChunk implements Batch {
  constructor(
    private readonly store: RuntimeStore,
    private readonly arch: Archetype,
    private readonly rowFilters: readonly RowFilter[],
    private readonly seededRows?: readonly number[],
  ) {}

  get denseCount(): number {
    return this.arch.count;
  }

  get isDense(): boolean {
    return this.seededRows === undefined && this.rowFilters.length === 0;
  }

  col(c: Component): Record<string, Column> {
    const out: Record<string, Column> = {};
    for (const f of c.fields) out[f.name] = this.arch.columns.get(f.fieldId) as Column;
    return out;
  }

  get columns(): Record<string, Record<string, Column>> {
    const out: Record<string, Record<string, Column>> = {};
    for (const id of this.arch.componentIds) {
      const c = componentById(id);
      if (c !== undefined) out[c.name] = this.col(c);
    }
    return out;
  }

  entity(r: number): Entity {
    return this.arch.entities[r] as Entity;
  }

  getRelated(r: number, rel: Relation): Entity | undefined {
    const e = this.entity(r);
    if (rel.arity === "one") return this.store.getRelation(e, rel);
    const all = this.store.getRelations(e, rel);
    return all.length > 0 ? all[0] : undefined;
  }

  getAllRelated(r: number, rel: Relation): Entity[] {
    const e = this.entity(r);
    if (rel.arity === "one") {
      const t = this.store.getRelation(e, rel);
      return t !== undefined ? [t] : [];
    }
    return this.store.getRelations(e, rel);
  }

  [Symbol.iterator](): Iterator<number> {
    if (this.seededRows !== undefined) return this.seededRows[Symbol.iterator]();
    return this.denseIterator();
  }

  private *denseIterator(): Generator<number> {
    const arch = this.arch;
    for (let r = 0; r < arch.count; r++) {
      const e = arch.entities[r] as Entity;
      if (this.store.passesRowFilters(this.rowFilters, e, arch)) yield r;
    }
  }
}

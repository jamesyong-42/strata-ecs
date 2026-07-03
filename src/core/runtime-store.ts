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
  type ColumnsOf,
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
  type ResourceId,
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
import type { WorldObserver } from "./observe";
import type { System } from "./system";
import { effectiveRead } from "./access-diagnostics";

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
  /**
   * Ascending identity `[0,1,2,…]`, grown to the largest archetype seen and shared by every dense
   * chunk as its `rows` (§6.2). Read-only content, so sharing across (even nested) queries is safe:
   * growing replaces the array, and an outer chunk keeps its still-correct older reference.
   */
  private identityRows = new Int32Array(0);
  /** Transient scratch for materializing a row-filtered chunk's matches, before the exact-size copy. */
  private rowScratch = new Int32Array(0);
  /**
   * Attached dev-tool observers (observe.ts) — `null` whenever none are attached, so the
   * spawn/destroy hot paths pay exactly one branch-on-null (docs/plan-tools-observer.md).
   */
  private observerList: WorldObserver[] | null = null;
  /**
   * The reactive change-detection frame counter (Patch Note 002 §2.1). Every stamp — value writes,
   * structural bumps, tag/relation bumps — records this value; the reactive layer advances it at the
   * END of its notify pass (§4.1a), so an out-of-tick write between passes stamps a frame strictly
   * greater than any observer's `lastSeenFrame` and is never missed. Starts at 1 so a never-stamped
   * slot (0) always reads as older.
   */
  private frameCounter = 1;
  /**
   * The §4.2 global tag/relation membership version — set to `frameCounter` at every tag/relation
   * mutation (which move no archetype rows yet change tag/relation-filtered query membership). Only
   * row-filtered Tier-1 observers consult it; a coarse single counter is sufficient (§4.2).
   */
  private tagRelFrame = 0;
  /**
   * Per-resource `lastWrittenFrame` (Patch Note 003 §1.2), a dense array indexed by `ResourceId`
   * (ids are dense). Bumped in `setResource` only — resources have no column/structural path — behind
   * the `reactiveOn` gate. Grown lazily on first stamp past the current length; a never-stamped id
   * (0) reads as older than any observer. NOT on the stored value object (replaced wholesale per set).
   */
  private resourceFrames = new Float64Array(0);
  /**
   * Master gate for ALL reactive bookkeeping (value stamps, structural bumps, tag/relation bumps) —
   * false until the world's reactive layer is first touched, so a world that never uses reactivity
   * pays literally zero stores on the mutation paths (the same branch-on-null discipline as the T0
   * observer roster; the bench A/B gate measured the always-on variant at +17–28% on migrate-heavy
   * scenarios, which is what forced this gate).
   */
  private reactiveOn = false;

  /** @internal Arm reactive bookkeeping — one-way, flipped on first `world.reactive` access. */
  enableReactive(): void {
    this.reactiveOn = true;
  }

  /**
   * The reactive layer's eager-death hook (002 §3.4) — a single dedicated slot, deliberately NOT a
   * {@link WorldObserver}: routing it through `addObserver` would flip the T0 telemetry roster
   * non-null and tax every tick with per-system `performance.now` timing. `null` until the first
   * entity/value watch registers; called pre-teardown in {@link destroy} to QUEUE the dying entity
   * (queue-only — it must never fire callbacks or mutate).
   */
  private reactiveDeathHook: ((e: Entity) => void) | null = null;

  /** @internal Install/clear the reactive death hook (the reactive layer owns this seam, §3.4). */
  setReactiveDeathHook(hook: ((e: Entity) => void) | null): void {
    this.reactiveDeathHook = hook;
  }

  /** Set `tagRelFrame` (002 §4.2) — no-op until reactivity is enabled. */
  private bumpTagRel(): void {
    if (this.reactiveOn) this.tagRelFrame = this.frameCounter;
  }
  /**
   * Access enforcement state (001 Rule 3, armed by the reactive layer §2.4). `accessArmed` flips on
   * when the first reactive observer registers and stays on for the world's life; `currentSystem` is
   * set by the tick around each system's run so the `col()`/`writeComponent` chokepoints can name it
   * in a throw. Both reads are DEV-only and short-circuit when disarmed or outside a system, so the
   * hot path pays at most one branch.
   */
  private accessArmed = false;
  private currentSystem: System | null = null;
  /** Per-system allowed component set (write ∪ effectiveRead) for the `col()` check, memoized (001 Rule 3). */
  private readonly allowedAccess = new WeakMap<System, Set<ComponentId>>();

  private ensureIdentity(n: number): Int32Array {
    if (this.identityRows.length < n) {
      const next = new Int32Array(n);
      for (let i = 0; i < n; i++) next[i] = i;
      this.identityRows = next;
    }
    return this.identityRows;
  }

  private ensureScratch(n: number): Int32Array {
    if (this.rowScratch.length < n) this.rowScratch = new Int32Array(n);
    return this.rowScratch;
  }

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

  /** @internal Subscribe to archetype creation (queries cache matching-archetype lists this way, §3.1/§6). */
  observeArchetypes(fn: (a: Archetype) => void): void {
    this.archetypeObservers.push(fn);
  }

  // ---------------------------------------------------------------------------
  // Dev-tool observers (observe.ts; docs/plan-tools-observer.md)
  // ---------------------------------------------------------------------------

  /**
   * @internal Attach a dev-tool observer (use `world.observe`). Returns a detach function.
   * The roster is COPY-ON-WRITE: attach/detach publish a new array, never mutate one an emit
   * loop may be iterating — so detaching from inside a callback can never skip a sibling, and
   * roster changes take effect from the next event (next tick, for tick telemetry) on.
   */
  addObserver(obs: WorldObserver): () => void {
    this.observerList = this.observerList === null ? [obs] : [...this.observerList, obs];
    return () => {
      const list = this.observerList;
      if (list === null) return;
      const i = list.indexOf(obs);
      if (i === -1) return;
      const next = list.slice(0, i).concat(list.slice(i + 1));
      this.observerList = next.length > 0 ? next : null;
    };
  }

  /** @internal `null` when no observers are attached — `World.tick` branches on this. */
  get observers(): readonly WorldObserver[] | null {
    return this.observerList;
  }

  /** True while observer callbacks run — DEV mutation guards in spawn/destroy read it. */
  private inObserverEmit = false;

  /**
   * @internal Set the observer-emit reentrancy flag and return its prior value. `reactive.notify`
   * wraps its callback dispatch in this so the spawn/destroy DEV guards reject structural mutation
   * from a reactive callback (002 §6 — callbacks may SCHEDULE work instead).
   */
  setObserverEmit(active: boolean): boolean {
    const prev = this.inObserverEmit;
    this.inObserverEmit = active;
    return prev;
  }

  /**
   * DEV guard (002 §6): a STRUCTURAL mutation issued from inside an observer / reactive callback is
   * rejected — mid-flush it would corrupt the command-buffer drain, mid-notify it would re-enter
   * iteration; callbacks must SCHEDULE work instead. Returns true when blocked so the caller
   * early-returns. Value writes (`writeComponent`) are exempt — immediate and non-structural.
   */
  private rejectMutationInEmit(op: string): boolean {
    if (DEV && this.inObserverEmit) {
      devError(`observer callbacks must not mutate the world — ${op}() from inside a callback is ignored (observe.ts).`);
      return true;
    }
    return false;
  }

  /** Fan an entity birth out to observers. Callers guard `observerList !== null` (hot path). */
  private emitSpawn(e: Entity): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onSpawn?.(e);
        } catch (err) {
          devError(`observer onSpawn threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  /** Fan an imminent entity teardown out to observers. Callers guard `observerList !== null`. */
  private emitDestroy(e: Entity): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onDestroy?.(e);
        } catch (err) {
          devError(`observer onDestroy threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  /**
   * Fan a wholesale reset out to observers (observe.ts). Fired ONCE by {@link reset} AFTER teardown
   * — never a per-entity `onDestroy` (a 100k reset must not emit 100k callbacks). Callers guard
   * `observerList !== null`. Runs under the observer-emit flag so a callback cannot re-enter mutation.
   */
  private emitReset(): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onReset?.();
        } catch (err) {
          devError(`observer onReset threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  /** @internal All archetypes that currently exist (for queries to seed their caches; also the
   *  tools' reflection walk). Returns the internal {@link Archetype} type — not public API. */
  archetypes(): readonly Archetype[] {
    return this.archetypesById;
  }

  /** @internal The archetype an entity occupies — undefined for identity-only/dead handles
   *  (first-party tools use this for reflection; apps should stick to queries). */
  archetypeOf(e: Entity): Archetype | undefined {
    return this.table.isPlaced(e) ? this.archetypesById[this.table.archetypeOf(slotOf(e))] : undefined;
  }

  private archetypeOfEntity(e: Entity): Archetype {
    return this.archetypesById[this.table.archetypeOf(slotOf(e))];
  }

  // ---------------------------------------------------------------------------
  // Reactive change-detection stamps (Patch Note 002 §2)
  // ---------------------------------------------------------------------------

  /** @internal The current reactive frame; observers compare stamps against it (002 §2.1). */
  get frame(): number {
    return this.frameCounter;
  }

  /** @internal Advance the frame at the END of the reactive notify pass (002 §4.1a). */
  advanceFrame(): void {
    this.frameCounter++;
  }

  /** @internal The frame of the most recent tag/relation mutation (002 §4.2 membership). */
  get lastTagRelFrame(): number {
    return this.tagRelFrame;
  }

  /**
   * Stamp resource `id` at the current frame (003 §1.2). Gated on `reactiveOn` like every other stamp
   * site, and grows the dense array to fit `id` on first use (copy-forward, zero-fill). Called from
   * `setResource` only — the resource's single write chokepoint.
   */
  private bumpResource(id: ResourceId): void {
    if (!this.reactiveOn) return;
    if (id >= this.resourceFrames.length) {
      const next = new Float64Array(id + 1);
      next.set(this.resourceFrames);
      this.resourceFrames = next;
    }
    this.resourceFrames[id] = this.frameCounter;
  }

  /** @internal The frame of the most recent `setResource(id)` — 0 when never stamped/out of range (003 §1.2). */
  resourceFrame(id: ResourceId): number {
    return id < this.resourceFrames.length ? this.resourceFrames[id] : 0;
  }

  /**
   * Stamp `cid`'s column in `A` with the current frame (002 §2.1). No-op if `A` lacks the component,
   * so callers need not pre-check membership. A single integer store after a `componentSlot` scan.
   */
  private stampComponent(A: Archetype, cid: ComponentId): void {
    if (!this.reactiveOn) return;
    const slot = A.componentSlot(cid);
    if (slot >= 0) A.lastWrittenFrame[slot] = this.frameCounter;
  }

  /**
   * @internal 001 §3.1 route 1: after a system runs, stamp its `access.write` set across the
   * archetypes matching `q` (blanket, `hasComponent`-guarded — 002 §2.3). Seeds the query's
   * matching-archetype cache the same way {@link runQuery} does if it has never run.
   */
  stampWrites(q: Query, comps: readonly Component[]): void {
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    for (const arch of matches) {
      for (const c of comps) {
        if (arch.hasComponent(c.id)) this.stampComponent(arch, c.id);
      }
    }
  }

  /**
   * @internal 002 §2.2 escape hatch (`world.reactive.invalidate`): stamp `c`'s column in every
   * archetype that holds it — for writes no chokepoint can see (raw column pokes, future feeds).
   */
  invalidateComponent(c: Component): void {
    for (const arch of this.archetypesById) {
      if (arch !== undefined && arch.hasComponent(c.id)) this.stampComponent(arch, c.id);
    }
  }

  /**
   * @internal The cached matching-archetype list for `q`, seeded on first use exactly like
   * {@link stampWrites} / {@link runQuery} (Tier-1 observers read it directly, 002 §3.1). The
   * returned array is the store's live cache — the archetype-creation hook keeps appending
   * newly-matching archetypes to it, so a held reference stays current across spawns.
   */
  matchesFor(q: Query): readonly Archetype[] {
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    return matches;
  }

  // ---------------------------------------------------------------------------
  // Access enforcement (001 Rule 3 — accessor-level; armed by the reactive layer, §2.4)
  // ---------------------------------------------------------------------------

  /** @internal Turn on dev-mode access enforcement. The first reactive observer calls this once. */
  armAccessEnforcement(): void {
    this.accessArmed = true;
  }

  /** @internal Tick sets the running system so `col()`/`writeComponent` can enforce its access (DEV). */
  beginSystemAccess(system: System): void {
    this.currentSystem = system;
  }

  /** @internal Tick clears the running system after the phase (also the throw backstop). */
  endSystemAccess(): void {
    this.currentSystem = null;
  }

  /** The write ∪ effectiveRead id set the running system may `col()`, memoized per System (001 Rule 3). */
  private allowedFor(system: System): Set<ComponentId> {
    let set = this.allowedAccess.get(system);
    if (set === undefined) {
      set = new Set<ComponentId>();
      if (system.access?.write !== undefined) for (const c of system.access.write) set.add(c.id);
      for (const c of effectiveRead(system)) set.add(c.id);
      this.allowedAccess.set(system, set);
    }
    return set;
  }

  /**
   * @internal 001 Rule 3 accessor check — `batch.col(c)` for a `c` in neither `access.write` nor the
   * (default-or-declared) read set throws, naming the system + component. DEV + armed + in-a-system
   * only; out-of-tick `world.query().each` has `currentSystem === null` and is exempt.
   */
  enforceColAccess(c: Component<unknown, unknown>): void {
    if (!this.accessArmed) return;
    const system = this.currentSystem;
    if (system === null) return;
    if (!this.allowedFor(system).has(c.id)) {
      throw new Error(
        `strata: system "${system.name}" accessed component "${c.name}" via col() but did not declare it in access (add it to access.read or access.write, 001 Rule 3).`,
      );
    }
  }

  /**
   * 001 Rule 3 edit chokepoint — a `ctx.edit(e).set(c, v)` write to a `c` outside `access.write`
   * throws exactly (checks Rule 2's write-outside-query case). Out-of-tick edits are exempt
   * (`currentSystem === null`). DEV + armed only.
   */
  private enforceWriteAccess(c: Component): void {
    if (!this.accessArmed) return;
    const system = this.currentSystem;
    if (system === null) return;
    const w = system.access?.write;
    if (w === undefined || !w.some((x) => x.id === c.id)) {
      throw new Error(
        `strata: system "${system.name}" wrote component "${c.name}" via edit().set but did not declare it in access.write (001 Rule 3).`,
      );
    }
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
    if (this.reactiveOn) A.lastStructuralFrame = this.frameCounter; // rows-version bump (002 §4.2)
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
    if (this.reactiveOn) A.lastStructuralFrame = this.frameCounter; // rows-version bump (002 §4.2)
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
    // Reconcile the destination's per-column value stamps (002 §2.2(2)). One pass over the
    // destination's sorted componentIds (the loop index IS the stamp slot — no scans):
    //   - ADDED column (absent in the source) → a gained component is a value write → stamp now.
    //   - CARRIED column → carry the source's stamp FORWARD (max), so a value write made in the SAME
    //     frame as the migrate (its stamp lives in the OLD archetype) is not lost to a Tier-2/3 watch
    //     reading the entity's NEW archetype (adversarial-review fix). `max` never downgrades a
    //     destination column another entity stamped more recently.
    // Skipped wholesale until reactivity is enabled (the bench gate caught the always-on variant at
    // +28% on add_remove).
    if (this.reactiveOn) {
      const ids = newA.componentIds;
      const lwf = newA.lastWrittenFrame;
      for (let slot = 0; slot < ids.length; slot++) {
        const oldSlot = oldA.componentSlot(ids[slot]);
        if (oldSlot < 0) {
          lwf[slot] = this.frameCounter; // added column
        } else {
          const carried = oldA.lastWrittenFrame[oldSlot];
          if (carried > lwf[slot]) lwf[slot] = carried; // carry the pre-migrate value stamp forward
        }
      }
    }
  }

  private static sortedInsert(ids: readonly ComponentId[], id: ComponentId): ComponentId[] {
    return [...ids, id].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  // Identity + placement seams (used by projection, Parts II–IV; §Part I ref)
  // ---------------------------------------------------------------------------

  /** Mint an identity with no placement (§5.2). */
  allocateIdentity(): Entity {
    const e = this.table.allocate();
    // The entity exists from here (ctx.spawn's eager identity, §5.2) — this is its one onSpawn;
    // the flush-time placement of the same entity deliberately does not fire again.
    if (this.observerList !== null) this.emitSpawn(e);
    return e;
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
    if (DEV && this.inObserverEmit) {
      devError("observer callbacks must not mutate the world — spawn() from inside an observer (observe.ts).");
    }
    // Validate + encode BEFORE minting the identity: a bad value must throw with no identity
    // allocated, or the failed spawn would leak a live unreachable entity (and one for which
    // onSpawn never fired, breaking the exactly-once contract).
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
    const e = this.table.allocate();
    this.placeComposed(
      e,
      [...seen].sort((a, b) => a - b),
      fieldValues,
      init?.tags?.map((t) => t.id),
    );
    if (this.observerList !== null) this.emitSpawn(e); // after placement — readable in the hook
    return e;
  }

  /** Destroy an entity: clear its tags/relations inline, unplace, then free identity (§5.5). */
  destroy(e: Entity): void {
    if (DEV && this.inObserverEmit) {
      devError("observer callbacks must not mutate the world — destroy() from inside an observer is ignored (observe.ts).");
      return;
    }
    if (!this.table.isAlive(e)) return;
    // BEFORE teardown, so the dying entity is still fully readable inside the hook (observe.ts).
    // Covers both surfaces: immediate world.destroy and the flush's despawn command (§5.4).
    if (this.observerList !== null) this.emitDestroy(e);
    // The reactive layer's eager-death queue (002 §3.4) — a dedicated slot, not a WorldObserver, so it
    // never lights up the T0 tick-telemetry path. Pre-teardown + queue-only (fires undefined at notify).
    if (this.reactiveDeathHook !== null) this.reactiveDeathHook(e);
    const slot = slotOf(e);
    // Per-entity state living outside the archetype must be torn down for placed AND
    // identity-only entities so a reused slot starts clean (§5.5):
    this.relations.clearEntity(e); // both directions, inline, terminal
    this.tags.clearAll(slot); // mandatory — bitsets are slot-indexed, not generation-indexed (§3.2)
    this.bumpTagRel(); // teardown changes tag/relation-filtered membership (002 §4.2)
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

  /**
   * @internal Clear the world IN PLACE (R3), keeping this store's identity and every attached
   * observer + reactive registration. Surfaced via `world.reset()` (World rejects the mid-tick
   * case); a `world.import(bytes, { replace: true })` is reset-then-import. Contract:
   *
   * - **No alias.** Every live slot is freed WITH a generation bump (entity-table.reset), so every
   *   pre-reset handle reads dead — never aliased to an entity later minted at the same slot. This
   *   is the point: a fresh-world swap re-mints identical slot/gen sequences, so a stale pre-swap
   *   handle silently aliased a restored entity; freeing in place is strictly safer.
   * - **Archetypes are KEPT but emptied.** Their object identity backs the Tier-1 query caches
   *   (`queryMatches` / a watch's `matches` reference), which must stay valid; only rows are dropped.
   *   Tags, relations, and resources are cleared wholesale (no per-entity cascade — reset IS the
   *   cascade). The command buffers are pooled-empty at rest (reset runs only outside a tick), so
   *   there is no pending deferred state to clear.
   * - **WorldObserver attachments SURVIVE.** Per-entity `onDestroy` is NOT fired; a single `onReset`
   *   fires AFTER teardown (observe.ts).
   * - **Reactive registrations SURVIVE and settle at the next `notify()`.** Tier-1 watches wake from
   *   the emptied archetypes' bumped `lastStructuralFrame` + `tagRelFrame`; Tier-2/3 entity watches
   *   see their now-dead entity (generation bumped) via notifyWatches' dead-entity path and fire
   *   `undefined` once + self-remove; resource watches see the cleared value via bumped resource
   *   stamps. All stamps sit at the CURRENT frame — reset is a normal mutation burst and does NOT
   *   advance the frame (notify still owns that boundary, 002 §4.1a), so a watch subscribed AFTER a
   *   reset but before the next notify is correctly baselined and does not fire for the reset.
   *
   * Rejected from inside an observer/reactive callback (mid-emit): a wholesale teardown there would
   * corrupt an in-flight dispatch — the same posture as {@link rejectMutationInEmit}.
   */
  reset(): void {
    if (this.inObserverEmit) {
      throw new Error(
        "strata: world.reset() cannot run from inside an observer or reactive callback — reset only outside iteration (observe.ts).",
      );
    }
    const frame = this.frameCounter; // reset stamps at the CURRENT frame — a normal mutation burst
    // Empty every archetype that holds rows (keep identity for the query caches). Bump the emptied
    // archetype's rows-version so surviving Tier-1 watches wake at the next notify (002 §4.2).
    for (const arch of this.archetypesById) {
      if (arch === undefined || arch.count === 0) continue;
      arch.clear();
      if (this.reactiveOn) arch.lastStructuralFrame = frame;
    }
    // Stamp every resource that HELD a value so its watch observes the transition to undefined at
    // the next notify — keyed off the live map (not resourceFrames' length) so a resource set BEFORE
    // reactivity armed, whose stamp is still 0, is covered too; grows resourceFrames as needed. Runs
    // BEFORE the clear so the ids are still known. A never-set resource stays at 0 and does not fire.
    if (this.reactiveOn) for (const id of this.resources.keys()) this.bumpResource(id as ResourceId);
    // Clear tags / relations / resources wholesale.
    this.tags.reset();
    this.relations.reset();
    this.resources.clear();
    // Free every live slot with a generation bump — stale handles now read dead, never aliased.
    this.table.reset();
    // A single tag/relation bump wakes any row-filtered / relation-seeded Tier-1 watch once (§4.2).
    if (this.reactiveOn) this.tagRelFrame = frame;
    // WorldObserver roster survives — one wholesale onReset AFTER teardown (never per-entity onDestroy).
    if (this.observerList !== null) this.emitReset();
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
    if (this.rejectMutationInEmit("addComponent")) return; // 002 §6 — no structural mutation from a callback
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
    if (this.rejectMutationInEmit("removeComponent")) return; // 002 §6
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
    if (DEV) this.enforceWriteAccess(c); // 001 Rule 3: undeclared edit-path write throws before mutating
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    for (const f of c.fields) {
      writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, encoded.get(f.fieldId) as Stored);
    }
    this.stampComponent(A, c.id); // edit-path value write (002 §2.2(3), 001 §3.1 route 2)
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
      this.stampComponent(this.archetypeOfEntity(e), c.id); // initial value of the projected column
    } else if (this.archetypeOfEntity(e).hasComponent(c.id)) {
      const A = this.archetypeOfEntity(e);
      const row = this.table.rowOf(slotOf(e));
      for (const f of c.fields) {
        writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, encoded.get(f.fieldId) as Stored);
      }
      this.stampComponent(A, c.id); // overwrite branch writes cells directly — stamp explicitly (002 §2.2)
    } else {
      const newIds = RuntimeStore.sortedInsert(this.archetypeOfEntity(e).componentIds, c.id);
      this.migrate(e, newIds, encoded); // migrate stamps the added column
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

  /**
   * Read one field's decoded value with NO object allocation — the fast path for random access by
   * handle (whole-component {@link RuntimeStore.read} builds a value object per call). `undefined`
   * if the entity lacks `c` or `field` is not one of its fields. Generalizes {@link RuntimeStore.readEid}.
   */
  readField<S, K extends keyof S & string>(e: Entity, c: Component<S>, field: K): S[K] | undefined {
    if (!this.has(e, c)) return undefined;
    const meta = c.fieldByName.get(field);
    if (meta === undefined) return undefined;
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    return decodeField(meta.spec.type, readCell(A.columns.get(meta.fieldId) as Column, meta.kind, row)) as S[K];
  }

  /**
   * Read a validated `eid` field: the referenced entity, or `undefined` if the ref dangles (§2).
   * @internal Keyed by {@link FieldId} and liveness-validated — the store's own eid machinery. The
   * public read path is {@link RuntimeStore.readField} (keyed by name, decodes the raw handle).
   */
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
    if (this.rejectMutationInEmit("addTag")) return; // 002 §6
    this.assertAlive(e, "addTag");
    this.ensurePlaced(e);
    this.tags.set(t.id, slotOf(e));
    this.bumpTagRel(); // tag-filtered membership changed (002 §4.2)
  }

  /** Remove a tag (does not unplace the entity). */
  removeTag(e: Entity, t: Tag): void {
    if (this.rejectMutationInEmit("removeTag")) return; // 002 §6
    this.assertAlive(e, "removeTag");
    this.tags.clear(t.id, slotOf(e));
    this.bumpTagRel(); // tag-filtered membership changed (002 §4.2)
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
    if (this.rejectMutationInEmit("setRelation")) return; // 002 §6
    this.assertAlive(e, "setRelation");
    if (rel.arity !== "one") {
      throw new Error(`strata: setRelation is for arity "one" relations — use addRelation for "${rel.name}".`);
    }
    this.ensurePlaced(e);
    this.relations.setOne(rel, e, target);
    this.bumpTagRel(); // relation-filtered membership changed (002 §4.2)
  }

  /** Arity "many": add an edge (idempotent). Places the source; the target is not placed. */
  addRelation(e: Entity, rel: Relation, target: Entity): void {
    if (this.rejectMutationInEmit("addRelation")) return; // 002 §6
    this.assertAlive(e, "addRelation");
    if (rel.arity !== "many") {
      throw new Error(`strata: addRelation is for arity "many" relations — use setRelation for "${rel.name}".`);
    }
    this.ensurePlaced(e);
    this.relations.addMany(rel, e, target);
    this.bumpTagRel(); // relation-filtered membership changed (002 §4.2)
  }

  /** Remove one edge (if `target` given) or all edges of `rel` from `e`. Does not unplace. */
  removeRelation(e: Entity, rel: Relation, target?: Entity): void {
    if (this.rejectMutationInEmit("removeRelation")) return; // 002 §6
    this.assertAlive(e, "removeRelation");
    this.relations.remove(rel, e, target);
    this.bumpTagRel(); // relation-filtered membership changed (002 §4.2)
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
    if (DEV && this.inObserverEmit) {
      // Value writes are exempt from the structural rejection, but a setResource from inside a
      // reactive callback stamps the CURRENT frame — already seen by every watch processed this
      // pass — so it would be silently unobservable forever. Diagnose loudly; schedule instead.
      devWarn(
        `setResource("${res.name}") from inside a reactive callback is stamped at the current frame and will not be observed — schedule it for the next frame instead (002 §6).`,
      );
    }
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
    this.bumpResource(res.id); // resource-version stamp (003 §1.2) — gated on reactiveOn
  }

  getResource<S>(res: Resource<S>): S | undefined {
    return this.resources.get(res.id) as S | undefined;
  }

  // ---------------------------------------------------------------------------
  // Command buffer — the system-iteration deferral facility (§5.4, §5.5)
  // ---------------------------------------------------------------------------

  /** @internal Hand out a cleared buffer from the pool (grows the pool only on demand, §5.4). */
  allocateCommandBuffer(): CommandBuffer {
    const reused = this.freeBuffers.pop();
    if (reused !== undefined) {
      this.bufferPool[reused].length = 0;
      return reused;
    }
    this.bufferPool.push([]);
    return this.bufferPool.length - 1;
  }

  /** @internal Append a command (producer-agnostic; only a system's `ctx` calls this, §5.4). */
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

  /** @internal Single-pass drain: apply every command, then clear. `apply` never enqueues, so no growth (§5.4). */
  flushCommandBuffer(buf: CommandBuffer): void {
    const cmds = this.bufferPool[buf];
    const n = cmds.length; // apply never appends to this buffer → n is stable
    for (let i = 0; i < n; i++) this.applyCommand(cmds[i]);
    cmds.length = 0;
  }

  /** @internal Return a buffer to the pool when its phase is done. */
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
        this.bumpTagRel(); // direct bitset write — not routed through addTag (002 §4.2)
        return;
      case "removeTag":
        this.tags.clear(cmd.tag, slotOf(cmd.entity));
        this.bumpTagRel(); // direct bitset write — not routed through removeTag (002 §4.2)
        return;
      case "setRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return; // drop an edge to a dead target
        this.ensurePlaced(cmd.entity);
        this.relations.setOne(rel, cmd.entity, cmd.target);
        this.bumpTagRel(); // direct index write — not routed through setRelation (002 §4.2)
        return;
      }
      case "addRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return;
        this.ensurePlaced(cmd.entity);
        this.relations.addMany(rel, cmd.entity, cmd.target);
        this.bumpTagRel(); // direct index write — not routed through addRelation (002 §4.2)
        return;
      }
      case "removeRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined) return;
        this.relations.remove(rel, cmd.entity, cmd.target);
        this.bumpTagRel(); // direct index write — not routed through removeRelation (002 §4.2)
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
    const dense = q.rowFilters.length === 0;
    for (const arch of matches) {
      if (arch.count === 0) continue; // an empty archetype matches nothing (cheap skip)
      let rows: Int32Array;
      let count: number;
      if (dense) {
        rows = this.ensureIdentity(arch.count); // shared ascending array; no per-chunk allocation
        count = arch.count;
      } else {
        // Materialize matched rows with ONE filter pass into shared scratch, then copy to an
        // exact-size buffer the chunk owns — so a query nested inside the body can safely reuse
        // scratch. Replaces the former per-row generator (see docs/perf-hotpath.md).
        const scratch = this.ensureScratch(arch.count);
        count = this.fillMatchedRows(arch, q.rowFilters, scratch);
        rows = scratch.slice(0, count);
      }
      fn(new ArchetypeChunk(this, arch, rows, count, dense));
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
      fn(new ArchetypeChunk(this, arch, Int32Array.of(this.table.rowOf(slotOf(src))), 1, false));
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

  /**
   * Fill `scratch[0..return)` with the rows of `arch` whose entity passes every row filter, and
   * return the match count (§6.1). Fast path for a single tag filter — the common `tag` / `Not(tag)`
   * case — hoists the tag's bitset once and inlines the bit test, so there is no per-row `Map`
   * lookup (the dominant cost of a naive per-row `tags.has`). Other shapes fall back to the general
   * per-row predicate.
   */
  private fillMatchedRows(arch: Archetype, rowFilters: readonly RowFilter[], scratch: Int32Array): number {
    let n = 0;
    if (rowFilters.length === 1 && rowFilters[0].kind === "tag") {
      const rf = rowFilters[0];
      const bs = this.tags.bitset(rf.tagId as number); // hoisted out of the row loop (was per-row Map.get)
      const neg = rf.negate;
      const ents = arch.entities;
      const cnt = arch.count;
      for (let r = 0; r < cnt; r++) {
        const slot = slotOf(ents[r] as Entity);
        const word = slot >>> 5;
        const has = bs !== undefined && word < bs.length && ((bs[word] >>> (slot & 31)) & 1) === 1;
        if (has !== neg) scratch[n++] = r; // pass iff (neg ? !has : has)
      }
      return n;
    }
    for (let r = 0; r < arch.count; r++) {
      const e = arch.entities[r] as Entity;
      if (this.passesRowFilters(rowFilters, e, arch)) scratch[n++] = r;
    }
    return n;
  }

  /** @internal Evaluate all per-row filters for an entity (used by the seeded path + fallback). */
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

  /** @internal The archetype an entity is currently placed in, or `undefined` if identity-only.
   *  Legacy alias for {@link RuntimeStore.archetypeOf}; returns the internal {@link Archetype} type. */
  debugArchetypeOf(e: Entity): Archetype | undefined {
    return this.archetypeOf(e); // legacy alias — archetypeOf is the sanctioned reflection seam
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
    /** Matched row indices, `rows[0 .. count)`. Shared identity array (dense) or an owned copy. */
    readonly rows: Int32Array,
    readonly count: number,
    private readonly dense: boolean,
  ) {}

  get denseCount(): number {
    return this.arch.count;
  }

  get isDense(): boolean {
    return this.dense;
  }

  col<S, Sch>(c: Component<S, Sch>): ColumnsOf<Sch> {
    if (DEV) this.store.enforceColAccess(c); // 001 Rule 3 — undeclared access throws before any element (no-op unless armed + in a system)
    const out: Record<string, Column> = {};
    for (const f of c.fields) out[f.name] = this.arch.columns.get(f.fieldId) as Column;
    // The dynamic build is typed as a loose column bag; ColumnsOf<Sch> is the field-precise view of
    // the same object (each key routes to its declared column, verified by columnKindOf/allocColumn).
    return out as ColumnsOf<Sch>;
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
    // Non-generator iterator over the pre-materialized matched rows, reusing ONE result object (no
    // per-row allocation — a generator/naive iterator allocates `{value,done}` every `next()`). Still
    // pays the iterator-protocol call overhead; the raw `for (let i=0;i<b.count;i++) b.rows[i]` loop
    // is faster and is the documented hot path (§6.2).
    const rows = this.rows;
    const count = this.count;
    let i = 0;
    const result: { value: number; done: boolean } = { value: 0, done: false };
    return {
      next(): IteratorResult<number> {
        if (i < count) {
          result.value = rows[i++];
          result.done = false;
        } else {
          result.done = true;
        }
        return result as IteratorResult<number>;
      },
    };
  }
}

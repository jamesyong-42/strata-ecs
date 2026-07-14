/**
 * ChangeCollector — an opt-in, pull-based change journal (Patch Note 004;
 * born as infinite-canvas-engine petition 7).
 *
 * The missing layer between stamps and value observers:
 *
 *   Stamps           "might anything have changed?"   coarse, multi-consumer
 *   Collectors       "WHICH entities changed?"        exact where possible, opt-in
 *   Value observers  "did this decoded value differ?" equality-checked, callback
 *
 * A collector journals the entities touched by writes the store can
 * attribute — the sparse chokepoints (`doWriteCells`, place/migrate,
 * destroy, tag flips) all know the entity — and degrades HONESTLY to a
 * component-granular `coarse` record for writes it cannot see per-entity
 * (raw `batch.col()` typed-array writes, reported blanket-style from the
 * system's declared `access.write`, exactly like reactive stamping). It
 * never lies about exactness and it never misses: forgetting nothing is the
 * contract, over-reporting is the escape valve.
 *
 * PULL semantics: `drain()` is callable INSIDE the pipeline (between systems
 * or phases) — this is the whole point. Reactive observers fire at the
 * settled `notify()` boundary, one boundary LATE for a mid-frame consumer
 * (an observer-armed dirty flag gives a same-frame-stale spatial index; the
 * engine's picking contract cannot accept that). A drain sees every write
 * that landed before it, same-frame.
 *
 * Consumer contract (drives the API shape):
 *   - `changed` entities are ALIVE-or-dead hints, not facts: the consumer
 *     re-reads current state (`isIndexable(e) ? upsert : remove`). This is
 *     why component REMOVAL reports as `changed`, not `removed` — the
 *     entity is alive and recheckable.
 *   - `removed` is reserved for DESTROYED entities, where recheck is
 *     impossible; consumers drop them by their cached key. Records carry the
 *     packed handle (generation included) — usable after death.
 *   - `coarse` lists components whose rows may have changed ANYWHERE (raw
 *     column writes): the consumer re-scans its own query for those.
 *   - `reset: true` means wholesale invalidation (world.reset / replace
 *     import): rebuild from a full walk.
 *
 * Gate: collectors have their OWN attachment gate — they do NOT arm (and
 * are not armed by) `reactiveOn`. A UI value observer must not tax every
 * component write with journal checks, and a collector must not flip the
 * +17–28% reactive stamping profile. The store's fast path is a single
 * null check while no collector was ever attached.
 *
 * Allocation contract: `drain()` reuses internal buffers — the returned
 * arrays (and the delta object itself) are valid only until the NEXT
 * `drain()`/`clear()`. A per-frame drain allocates nothing in steady state.
 */
import type { Entity } from "./entity";
import type { Component, Tag } from "./schema";

/** The archetype face collectors need (avoids importing the class). */
export interface ArchetypeShape {
  hasComponent(id: number): boolean;
}

/** One drained batch of changes. Valid until the next drain()/clear(). */
export interface ChangeDelta {
  /** Touched, alive-at-touch-time entities — re-read current state to act. */
  readonly changed: readonly Entity[];
  /** DESTROYED entities (packed handles — safe to use as removal keys). */
  readonly removed: readonly Entity[];
  /**
   * Components with possible unattributed row writes (raw `batch.col()`
   * writers, reported from declared `access.write`): re-scan your query.
   */
  readonly coarse: readonly Component[];
  /** Wholesale invalidation (reset / replace import): rebuild everything. */
  readonly reset: boolean;
}

export interface CollectOptions {
  /** Value writes, adds, removals and destroys touching these journal the entity. */
  readonly components?: readonly Component[];
  /** Membership flips of these journal the entity (add/remove/destroy teardown). */
  readonly tags?: readonly Tag[];
  /**
   * Receive `coarse` records from the declared-`access.write` blanket
   * (default true — the never-miss contract for raw `batch.col()` writers).
   *
   * `false` is an ATTESTATION: "every writer of my subscribed components uses
   * store-visible writes (edit/set, ctx.*, projection) — no raw column
   * pokes". The blanket is CONSERVATIVE by construction: it cannot tell a
   * declared writer that wrote through the exact chokepoints from one that
   * wrote raw, so a pipeline whose exact-path writers run every frame would
   * drown the consumer in permanent coarse records (= a full rescan per
   * frame, the exact walk collectors exist to retire). Opting out under a
   * codebase-level absolute-writes discipline is sound; a future raw writer
   * of these components would then be MISSED — the explicit `touch()` row
   * operation is the planned precision upgrade for mixed pipelines.
   */
  readonly coarse?: boolean;
}

export interface ChangeCollector {
  /** Take everything since the last drain and reset the cursor. */
  drain(): ChangeDelta;
  /** Discard everything since the last drain without reading it. */
  clear(): void;
  /** Detach — the collector stops journaling and drains empty forever. */
  dispose(): void;
}

/** The `world.changes` surface (lazily created; creation installs the store sink). */
export interface WorldChanges {
  collect(opts?: CollectOptions): ChangeCollector;
}

/** @internal The store-facing sink (RuntimeStore holds one, null until first collect). */
export interface ChangesSink {
  componentTouched(e: Entity, componentId: number): void;
  /** place/migrate report the whole archetype — collectors filter by subscription. */
  archetypeTouched(e: Entity, archetype: ArchetypeShape): void;
  destroyed(e: Entity, archetype: ArchetypeShape | null, hasTag: (tagId: number) => boolean): void;
  tagTouched(e: Entity, tagId: number): void;
  /** Declared-writes blanket for raw column writers (the honest coarse route). */
  coarseWrites(comps: readonly Component[]): void;
  reset(): void;
}

class CollectorImpl implements ChangeCollector {
  readonly componentIds: readonly number[];
  readonly tagIds: readonly number[];
  readonly wantsCoarse: boolean;
  private readonly changedSet = new Set<Entity>();
  private readonly removedSet = new Set<Entity>();
  private readonly coarseSet = new Set<Component>();
  private resetPending = false;
  private disposed = false;
  // drain() reuses these; contents are valid until the next drain()/clear().
  private readonly changedOut: Entity[] = [];
  private readonly removedOut: Entity[] = [];
  private readonly coarseOut: Component[] = [];
  private readonly delta: {
    changed: Entity[];
    removed: Entity[];
    coarse: Component[];
    reset: boolean;
  };

  constructor(
    opts: CollectOptions,
    private readonly registry: ChangesRegistry,
  ) {
    this.componentIds = (opts.components ?? []).map((c) => c.id);
    this.tagIds = (opts.tags ?? []).map((t) => t.id);
    this.wantsCoarse = opts.coarse !== false;
    this.delta = { changed: this.changedOut, removed: this.removedOut, coarse: this.coarseOut, reset: false };
  }

  markChanged(e: Entity): void {
    if (!this.removedSet.has(e)) this.changedSet.add(e); // removed wins — dead entities are not recheckable
  }

  markRemoved(e: Entity): void {
    this.changedSet.delete(e);
    this.removedSet.add(e);
  }

  markCoarse(c: Component): void {
    this.coarseSet.add(c);
  }

  markReset(): void {
    // Reset SUBSUMES the journal — everything rebuilds anyway.
    this.changedSet.clear();
    this.removedSet.clear();
    this.coarseSet.clear();
    this.resetPending = true;
  }

  drain(): ChangeDelta {
    this.changedOut.length = 0;
    for (const e of this.changedSet) this.changedOut.push(e);
    this.changedSet.clear();
    this.removedOut.length = 0;
    for (const e of this.removedSet) this.removedOut.push(e);
    this.removedSet.clear();
    this.coarseOut.length = 0;
    for (const c of this.coarseSet) this.coarseOut.push(c);
    this.coarseSet.clear();
    this.delta.reset = this.resetPending;
    this.resetPending = false;
    return this.delta;
  }

  clear(): void {
    this.changedSet.clear();
    this.removedSet.clear();
    this.coarseSet.clear();
    this.resetPending = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.remove(this);
  }
}

/**
 * The per-world collector registry — installed as the store's ChangesSink on
 * the first `world.changes.collect()`. Dense per-id subscriber tables: a
 * write touching an unsubscribed component costs one Map miss.
 */
export class ChangesRegistry implements ChangesSink {
  private readonly byComponent = new Map<number, CollectorImpl[]>();
  private readonly byTag = new Map<number, CollectorImpl[]>();
  private readonly collectors: CollectorImpl[] = [];

  collect(opts: CollectOptions = {}): ChangeCollector {
    const c = new CollectorImpl(opts, this);
    this.collectors.push(c);
    for (const id of c.componentIds) {
      const list = this.byComponent.get(id);
      if (list === undefined) this.byComponent.set(id, [c]);
      else list.push(c);
    }
    for (const id of c.tagIds) {
      const list = this.byTag.get(id);
      if (list === undefined) this.byTag.set(id, [c]);
      else list.push(c);
    }
    return c;
  }

  /** @internal CollectorImpl.dispose unhooks through here. */
  remove(c: CollectorImpl): void {
    const drop = (map: Map<number, CollectorImpl[]>, ids: readonly number[]): void => {
      for (const id of ids) {
        const list = map.get(id);
        if (list === undefined) continue;
        const i = list.indexOf(c);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) map.delete(id);
      }
    };
    drop(this.byComponent, c.componentIds);
    drop(this.byTag, c.tagIds);
    const i = this.collectors.indexOf(c);
    if (i >= 0) this.collectors.splice(i, 1);
  }

  componentTouched(e: Entity, componentId: number): void {
    const list = this.byComponent.get(componentId);
    if (list === undefined) return;
    for (const c of list) c.markChanged(e);
  }

  archetypeTouched(e: Entity, archetype: ArchetypeShape): void {
    for (const [id, list] of this.byComponent) {
      if (!archetype.hasComponent(id)) continue;
      for (const c of list) c.markChanged(e);
    }
  }

  destroyed(e: Entity, archetype: ArchetypeShape | null, hasTag: (tagId: number) => boolean): void {
    for (const [id, list] of this.byComponent) {
      if (archetype === null || !archetype.hasComponent(id)) continue;
      for (const c of list) c.markRemoved(e);
    }
    for (const [id, list] of this.byTag) {
      if (!hasTag(id)) continue;
      for (const c of list) c.markRemoved(e);
    }
  }

  tagTouched(e: Entity, tagId: number): void {
    const list = this.byTag.get(tagId);
    if (list === undefined) return;
    for (const c of list) c.markChanged(e);
  }

  coarseWrites(comps: readonly Component[]): void {
    for (const comp of comps) {
      const list = this.byComponent.get(comp.id);
      if (list === undefined) continue;
      for (const c of list) {
        if (c.wantsCoarse) c.markCoarse(comp);
      }
    }
  }

  reset(): void {
    for (const c of this.collectors) c.markReset();
  }
}

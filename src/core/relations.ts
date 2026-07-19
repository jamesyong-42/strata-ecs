/**
 * Relation storage — bidirectional indices keyed by packed entity handles (design §3.3).
 *
 * - `oneForward[R]`  : `Map<source, target>`      — arity "one" (a single target).
 * - `manyForward[R]` : `Map<source, Set<target>>` — arity "many" (unordered, deduped).
 * - `reverse[R]`     : `Map<target, Set<source>>` — always a Set; powers reverse queries + cleanup.
 *
 * Keys and values are packed `Entity` handles (slot + generation), so edges are migration-
 * invariant and a reused slot can't misattribute an old edge (its generation won't match, §3.3).
 * Traversal getters validate-on-read (skip dangling targets); despawn eagerly clears both
 * directions (§5.5).
 */

import type { Entity } from "./entity";
import { type OrderPlace, type Relation, type RelationId, relationById } from "./schema";

/** Outcome of an ordered placement — `fellBack` marks a `before`/`after` anchor that was not a
 *  sibling of the same parent (degraded to "last"; the caller DEV-warns, never throws — §3.3). */
export interface PlaceOutcome {
  moved: boolean;
  fellBack: boolean;
}

/** Shared no-op outcomes (allocation-free hot path — the R5 discipline). */
const NO_PLACE: PlaceOutcome = { moved: false, fellBack: false };
const NO_EDGE: PlaceOutcome = { moved: false, fellBack: false };
const EMPTY_ORDER: ReadonlyMap<Entity, Entity[]> = new Map();

export class RelationStore {
  private readonly oneForward = new Map<RelationId, Map<Entity, Entity>>();
  private readonly manyForward = new Map<RelationId, Map<Entity, Set<Entity>>>();
  private readonly reverse = new Map<RelationId, Map<Entity, Set<Entity>>>();
  /**
   * Sibling sequences for ORDERED relations only (plan-ordered-relations §3.2): per relation, each
   * parent's children as a dense array — the runtime's authoritative order. Membership is still
   * owned by the edge indices above; these arrays are maintained in lockstep at every edge
   * mutation site and never disagree (despawn splices eagerly, so entries are alive by
   * construction — reads keep the validate-on-read filter as belt and braces).
   */
  private readonly orderedReverse = new Map<RelationId, Map<Entity, Entity[]>>();
  /** Fired on every effective-order change of (rel, parent) — the runtime store's orderStamp bump
   *  seam (bound once at construction; armed-check lives on the runtime side). */
  onOrderChanged: ((rel: Relation, parent: Entity) => void) | null = null;

  constructor(private readonly isAlive: (e: Entity) => boolean) {}

  // --- mutation ---

  /** Arity "one": set/replace the single target, unlinking the previous target's reverse edge.
   *  UNORDERED relations only — kept byte-identical to its pre-ordered shape so the hot path
   *  stays inlinable (the petitions-3/4 inlining-cliff lesson; the D8 bench gate measured the
   *  merged form at +12.7%). Ordered relations route through {@link setOneOrdered}. */
  setOne(rel: Relation, source: Entity, target: Entity): void {
    const fwd = this.mapFor(this.oneForward, rel.id);
    const old = fwd.get(source);
    if (old !== undefined) this.reverse.get(rel.id)?.get(old)?.delete(source);
    fwd.set(source, target);
    this.addReverse(rel.id, target, source);
  }

  /**
   * The ORDERED sibling of {@link setOne}: same edge semantics, plus `place` positions `source`
   * among the new target's children (default "last"). Re-setting the SAME target: with a
   * `place` it acts as a move; without one the current position is KEPT (idempotent re-set
   * never reorders — §3.3).
   */
  setOneOrdered(rel: Relation, source: Entity, target: Entity, place?: OrderPlace): PlaceOutcome {
    const fwd = this.mapFor(this.oneForward, rel.id);
    const old = fwd.get(source);
    if (old !== undefined) this.reverse.get(rel.id)?.get(old)?.delete(source);
    fwd.set(source, target);
    this.addReverse(rel.id, target, source);
    if (old === target && place === undefined) return NO_PLACE; // idempotent re-set: keep position
    if (old !== undefined && old !== target) this.spliceOrdered(rel, old, source); // leave the old parent's sequence
    return this.insertOrdered(rel, target, source, place ?? "last");
  }

  /** Arity "many": add an edge (idempotent — a Set can't hold a duplicate, §3.3). */
  addMany(rel: Relation, source: Entity, target: Entity): void {
    const fwd = this.mapFor(this.manyForward, rel.id);
    let set = fwd.get(source);
    if (set === undefined) {
      set = new Set();
      fwd.set(source, set);
    }
    set.add(target);
    this.addReverse(rel.id, target, source);
  }

  /** Remove one edge (if `target` given) or ALL of `rel` from `source`. */
  remove(rel: Relation, source: Entity, target?: Entity): void {
    if (rel.arity === "one") {
      const fwd = this.oneForward.get(rel.id);
      const old = fwd?.get(source);
      if (old !== undefined && (target === undefined || target === old)) {
        fwd!.delete(source);
        this.reverse.get(rel.id)?.get(old)?.delete(source);
        if (rel.ordered) this.spliceOrdered(rel, old, source);
      }
      return;
    }
    const set = this.manyForward.get(rel.id)?.get(source);
    if (set === undefined) return;
    if (target === undefined) {
      for (const t of set) this.reverse.get(rel.id)?.get(t)?.delete(source);
      this.manyForward.get(rel.id)!.delete(source);
    } else if (set.delete(target)) {
      this.reverse.get(rel.id)?.get(target)?.delete(source);
    }
  }

  /**
   * Remove every edge touching `e`, both directions, inline (§5.5). Outgoing: drop `e`'s forward
   * entries and unlink it from each target's reverse set. Incoming: for each source pointing at
   * `e`, drop `e` from that source's forward entry; then drop `e`'s reverse entry.
   *
   * `onCleared` (passed only on the reactive teardown path) reports each relation id `e` actually
   * touched — as a forward source (one/many) OR an incoming target — so the store stamps exactly those
   * per-id membership versions (§4.2). Reporting the incoming case is what wakes a concrete-target
   * seeded watch when its target is destroyed. Duplicate reports for one id are fine (idempotent stamp).
   */
  clearEntity(e: Entity, onCleared?: (id: RelationId) => void): void {
    // Outgoing (e as source), arity "one".
    for (const [rid, fwd] of this.oneForward) {
      const target = fwd.get(e);
      if (target !== undefined) {
        this.reverse.get(rid)?.get(target)?.delete(e);
        fwd.delete(e);
        const rel = relationById(rid);
        if (rel?.ordered) this.spliceOrdered(rel, target, e); // the child leaves its parent's sequence
        onCleared?.(rid);
      }
    }
    // Outgoing (e as source), arity "many".
    for (const [rid, fwd] of this.manyForward) {
      const targets = fwd.get(e);
      if (targets !== undefined) {
        for (const t of targets) this.reverse.get(rid)?.get(t)?.delete(e);
        fwd.delete(e);
        onCleared?.(rid);
      }
    }
    // Incoming (e as target): sources pointing at e, via the reverse index.
    for (const [rid, rev] of this.reverse) {
      const sources = rev.get(e);
      if (sources === undefined) continue;
      const arity = relationById(rid)?.arity;
      for (const src of sources) {
        if (arity === "many") this.manyForward.get(rid)?.get(src)?.delete(e);
        else this.oneForward.get(rid)?.delete(src);
      }
      rev.delete(e);
      onCleared?.(rid); // e had incoming edges under rid — wakes a seeded watch whose target was e
    }
    // e as PARENT of an ordered sequence: drop the whole array (no per-parent bump — the parent is
    // dying; watchers ride the incoming-edge report above).
    for (const [, byParent] of this.orderedReverse) byParent.delete(e);
  }

  // --- traversal (validate-on-read: dangling targets are skipped) ---

  getOne(rel: Relation, source: Entity): Entity | undefined {
    const t = this.oneForward.get(rel.id)?.get(source);
    return t !== undefined && this.isAlive(t) ? t : undefined;
  }

  getMany(rel: Relation, source: Entity): Entity[] {
    const set = this.manyForward.get(rel.id)?.get(source);
    if (set === undefined) return [];
    const out: Entity[] = [];
    for (const t of set) if (this.isAlive(t)) out.push(t);
    return out;
  }

  getReverse(rel: Relation, target: Entity): Entity[] {
    if (rel.ordered) {
      // Sibling order IS the contract for ordered relations (§3.3). Entries are alive by
      // construction (despawn splices eagerly); the filter is belt and braces, same as below.
      const arr = this.orderedReverse.get(rel.id)?.get(target);
      if (arr === undefined) return [];
      const out: Entity[] = [];
      for (const s of arr) if (this.isAlive(s)) out.push(s);
      return out;
    }
    const set = this.reverse.get(rel.id)?.get(target);
    if (set === undefined) return [];
    const out: Entity[] = [];
    for (const s of set) if (this.isAlive(s)) out.push(s);
    return out;
  }

  /**
   * Reorder `source` within its CURRENT parent's sibling sequence (§3.3). `moved` is false when
   * `source` has no edge under `rel` (the caller DEV-warns + no-ops — remote/hostile robustness).
   */
  moveOne(rel: Relation, source: Entity, place: OrderPlace): PlaceOutcome {
    const parent = this.oneForward.get(rel.id)?.get(source);
    if (parent === undefined) return NO_EDGE;
    return this.insertOrdered(rel, parent, source, place);
  }

  /** Raw reverse set for a concrete target — used by concrete-target query seeding (§6.4). */
  reverseSet(rel: Relation, target: Entity): ReadonlySet<Entity> | undefined {
    return this.reverse.get(rel.id)?.get(target);
  }

  /** Whether `source` has any outgoing edge of `rel` — used by abstract-target row filters (§6.4). */
  hasAny(rel: Relation, source: Entity): boolean {
    if (rel.arity === "one") return this.oneForward.get(rel.id)?.has(source) ?? false;
    const set = this.manyForward.get(rel.id)?.get(source);
    return set !== undefined && set.size > 0;
  }

  /** Whether `source` has an edge to a specific `target` under `rel` (concrete-target row filter). */
  hasEdge(rel: Relation, source: Entity, target: Entity): boolean {
    if (rel.arity === "one") return this.oneForward.get(rel.id)?.get(source) === target;
    return this.manyForward.get(rel.id)?.get(source)?.has(target) ?? false;
  }

  /** Drop every edge in both directions — the wholesale clear a `world.reset()` routes through (R3, §5.5). */
  reset(): void {
    this.oneForward.clear();
    this.manyForward.clear();
    this.reverse.clear();
    this.orderedReverse.clear();
  }

  /** @internal Every (parent, children) sequence of an ordered relation — the snapshot exporter
   *  walks these (§3.5). Live view; do not mutate. */
  orderedEntries(rel: Relation): IterableIterator<[Entity, readonly Entity[]]> {
    return (this.orderedReverse.get(rel.id) ?? EMPTY_ORDER).entries();
  }

  /**
   * @internal Overwrite a parent's sibling sequence wholesale — the snapshot importer's D7
   * application (§3.5) and, later, the projector's order-cell application (M2). The caller is
   * responsible for `children` being exactly the parent's current children (any order); this
   * only assigns sequence, never membership.
   */
  setOrderedChildren(rel: Relation, parent: Entity, children: Entity[]): void {
    let byParent = this.orderedReverse.get(rel.id);
    if (byParent === undefined) {
      byParent = new Map();
      this.orderedReverse.set(rel.id, byParent);
    }
    byParent.set(parent, children);
    this.onOrderChanged?.(rel, parent);
  }

  /** @internal Every relation id with any stored edge in any direction — reset's per-id membership
   *  stamping walks these (§4.2). Yields duplicates across the three indices; the caller's stamp is
   *  idempotent within a frame, so no dedup is needed. */
  *knownIds(): IterableIterator<RelationId> {
    yield* this.oneForward.keys();
    yield* this.manyForward.keys();
    yield* this.reverse.keys();
  }

  /** Remove `source` from `parent`'s sibling sequence (edge already unlinked by the caller). */
  private spliceOrdered(rel: Relation, parent: Entity, source: Entity): void {
    const arr = this.orderedReverse.get(rel.id)?.get(parent);
    if (arr === undefined) return;
    const i = arr.indexOf(source);
    if (i >= 0) {
      arr.splice(i, 1);
      this.onOrderChanged?.(rel, parent);
    }
  }

  /**
   * Place `source` in `parent`'s sibling sequence per `place`. Always splices any existing
   * occurrence first, so re-placement is a move and the array can never hold a duplicate.
   * A `before`/`after` anchor that is absent (or is `source` itself, whose position is
   * indeterminate mid-move) degrades to "last" and reports `fellBack` for the DEV warn.
   */
  private insertOrdered(rel: Relation, parent: Entity, source: Entity, place: OrderPlace): PlaceOutcome {
    let byParent = this.orderedReverse.get(rel.id);
    if (byParent === undefined) {
      byParent = new Map();
      this.orderedReverse.set(rel.id, byParent);
    }
    let arr = byParent.get(parent);
    if (arr === undefined) {
      arr = [];
      byParent.set(parent, arr);
    }
    const existing = arr.indexOf(source);
    if (existing >= 0) arr.splice(existing, 1);

    let index: number;
    let fellBack = false;
    if (place === "first") {
      index = 0;
    } else if (place === "last") {
      index = arr.length;
    } else {
      const anchor = "before" in place ? place.before : place.after;
      const at = anchor === source ? -1 : arr.indexOf(anchor);
      if (at < 0) {
        index = arr.length;
        fellBack = true;
      } else {
        index = "before" in place ? at : at + 1;
      }
    }
    arr.splice(index, 0, source);
    this.onOrderChanged?.(rel, parent);
    return { moved: true, fellBack };
  }

  private mapFor<V>(index: Map<RelationId, Map<Entity, V>>, rid: RelationId): Map<Entity, V> {
    let m = index.get(rid);
    if (m === undefined) {
      m = new Map();
      index.set(rid, m);
    }
    return m;
  }

  private addReverse(rid: RelationId, target: Entity, source: Entity): void {
    let rev = this.reverse.get(rid);
    if (rev === undefined) {
      rev = new Map();
      this.reverse.set(rid, rev);
    }
    let set = rev.get(target);
    if (set === undefined) {
      set = new Set();
      rev.set(target, set);
    }
    set.add(source);
  }
}

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
import { type Relation, type RelationId, relationById } from "./schema";

export class RelationStore {
  private readonly oneForward = new Map<RelationId, Map<Entity, Entity>>();
  private readonly manyForward = new Map<RelationId, Map<Entity, Set<Entity>>>();
  private readonly reverse = new Map<RelationId, Map<Entity, Set<Entity>>>();

  constructor(private readonly isAlive: (e: Entity) => boolean) {}

  // --- mutation ---

  /** Arity "one": set/replace the single target, unlinking the previous target's reverse edge. */
  setOne(rel: Relation, source: Entity, target: Entity): void {
    const fwd = this.mapFor(this.oneForward, rel.id);
    const old = fwd.get(source);
    if (old !== undefined) this.reverse.get(rel.id)?.get(old)?.delete(source);
    fwd.set(source, target);
    this.addReverse(rel.id, target, source);
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
    const set = this.reverse.get(rel.id)?.get(target);
    if (set === undefined) return [];
    const out: Entity[] = [];
    for (const s of set) if (this.isAlive(s)) out.push(s);
    return out;
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
  }

  /** @internal Every relation id with any stored edge in any direction — reset's per-id membership
   *  stamping walks these (§4.2). Yields duplicates across the three indices; the caller's stamp is
   *  idempotent within a frame, so no dedup is needed. */
  *knownIds(): IterableIterator<RelationId> {
    yield* this.oneForward.keys();
    yield* this.manyForward.keys();
    yield* this.reverse.keys();
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

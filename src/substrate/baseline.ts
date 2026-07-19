/**
 * `BaselineSnapshot` — the in-memory `MutableSnapshot` (Patch Note 005 §1, §2, M2).
 *
 * The baseline is reconcile's converged-value mirror (Part III §13.3): nested `Map`s keyed by
 * `EntityKey`, cells stored NAME-keyed (§1.2, the durable currency), with:
 * - CANONICAL VALUES enforced at every component/resource write (§2) — it stores `canon(C, v)` /
 *   `canonResource(res, v)`, never the raw literal, so `cellEquals(baseline, runtime)` holds for a
 *   converged cell instead of stranding on an f32 fround mismatch (§2.1).
 * - a REVERSE relation index so `despawn` satisfies the THREE-PART contract (§1.3): record removal +
 *   all OUTGOING edges + all INCOMING edges (from BOTH arities). Without the reverse index a
 *   forward-only store leaves dangling incoming references a later reconcile would read as a phantom
 *   edge (property P2).
 * - the DIRECTION RULE (§1.2): cells are the source of truth; `readEntity` AGGREGATES a record from
 *   them — the baseline never stores whole-entity blobs.
 *
 * CELL INDEPENDENCE (§4.1): every op touches EXACTLY ONE cell. Entity existence is its OWN cell,
 * addressed ONLY by `spawn`/`despawn`; a component/tag/relation write touches only its cell and does
 * NOT toggle a separate existence flag. Liveness is DERIVED — an entity is live iff it was spawned
 * (and not despawned) OR it currently holds any cell. This is what makes `normalizeBatch`'s per-cell
 * dominance sound: dropping a superseded `setComponent` (a later `removeComponent` wins) changes only
 * that component cell — never a cross-cell existence side effect (the §4.3 acceptance oracle).
 *
 * Arity-split like the runtime: `setRelation`/`getRelationOne` for arity "one", `addRelation`/
 * `getRelationMany` for arity "many"; the setters enforce arity and throw the runtime's message
 * (runtime-store.ts:943/955).
 */

import type { EntityKey } from "../core/field";
import type { Component, Relation, Resource, Tag } from "../core/schema";
import { relationByName } from "../core/schema";
import type { ComponentValue, EntityRecord, MutableSnapshot, OrderPlaceKey, OrderSource } from "./types";
import { canon, canonResource } from "./canon";

/**
 * One incoming edge: a source key pointing at the indexing target via a relation. Carries the
 * relation NAME + arity (not the handle) so despawn's incoming-cleanup routes to the right forward
 * map without a schema lookup — a relation name determines its arity globally.
 */
interface ReverseEdge {
  source: EntityKey;
  relName: string;
  arity: "one" | "many";
}

export class BaselineSnapshot implements MutableSnapshot, OrderSource {
  /** The existence cell (§4.1): keys explicitly spawned and not despawned. Liveness ALSO derives from cells. */
  private readonly spawned = new Set<EntityKey>();
  /** key → componentName → canonical value (§2). */
  private readonly components = new Map<EntityKey, Map<string, ComponentValue>>();
  /** key → set of tag names. */
  private readonly tags = new Map<EntityKey, Set<string>>();
  /** Arity "one": source → relationName → single target. */
  private readonly relOne = new Map<EntityKey, Map<string, EntityKey>>();
  /** Arity "many": source → relationName → set of targets. */
  private readonly relMany = new Map<EntityKey, Map<string, Set<EntityKey>>>();
  /** target → the edges pointing AT it (the §1.3 reverse index). Keyed by the edge TARGET. */
  private readonly reverse = new Map<EntityKey, ReverseEdge[]>();
  /**
   * ORDERED sibling sequences (plan-ordered-relations §3.2 at EntityKey currency): parent →
   * relationName → children in sibling order. Maintained in LOCKSTEP with the arity-one edges for
   * ordered relations, on every write path of the frozen interface (placeless `setRelation`
   * appends "last" on a NEW edge and keeps position on a re-set — the projector-parity default)
   * plus the placed/move extensions below. The ladder oracle's order truth.
   */
  private readonly orderSeqs = new Map<EntityKey, Map<string, EntityKey[]>>();
  /** resourceName → canonical value. */
  private readonly resources = new Map<string, ComponentValue>();

  // --- reads (Snapshot) ------------------------------------------------------

  hasEntity(key: EntityKey): boolean {
    return this.spawned.has(key) || this.hasAnyCell(key);
  }

  entities(): Iterable<EntityKey> {
    const live = new Set<EntityKey>(this.spawned);
    for (const map of [this.components, this.tags, this.relOne, this.relMany]) {
      for (const k of map.keys()) if (this.hasAnyCell(k)) live.add(k);
    }
    return live;
  }

  getComponent(key: EntityKey, c: Component): ComponentValue | undefined {
    return this.components.get(key)?.get(c.name);
  }

  hasTag(key: EntityKey, t: Tag): boolean {
    return this.tags.get(key)?.has(t.name) ?? false;
  }

  getRelationOne(key: EntityKey, r: Relation): EntityKey | undefined {
    return this.relOne.get(key)?.get(r.name);
  }

  getRelationMany(key: EntityKey, r: Relation): EntityKey[] {
    const set = this.relMany.get(key)?.get(r.name);
    return set === undefined ? [] : [...set];
  }

  getResource(res: Resource): ComponentValue | undefined {
    return this.resources.get(res.name);
  }

  /** Aggregate the entity's cells into a record — the derived bulk view (§1.2 direction rule). */
  readEntity(key: EntityKey): EntityRecord | undefined {
    if (!this.hasEntity(key)) return undefined;
    const components: Record<string, ComponentValue> = {};
    for (const [name, value] of this.components.get(key) ?? []) components[name] = value;
    const tags = [...(this.tags.get(key) ?? [])];
    const relations: Record<string, EntityKey | EntityKey[]> = {};
    for (const [name, target] of this.relOne.get(key) ?? []) relations[name] = target; // arity "one" → scalar (§8.1)
    for (const [name, targets] of this.relMany.get(key) ?? []) {
      if (targets.size > 0) relations[name] = [...targets]; // "many" → array (skip an emptied slot)
    }
    return { key, components, tags, relations };
  }

  // --- writes (MutableSnapshot) ---------------------------------------------

  /**
   * EXISTENCE-ONLY (§4.1): record the key in the existence cell, touch NOTHING else — no clearing of
   * components, tags, or edges. Existence is its own cell; erasure power belongs to `despawn` alone
   * (§4.1 cell independence). A spawn is therefore idempotent on a live key and never severs an
   * incoming reference. A despawn→respawn still yields a fresh record because the DESPAWN did the
   * erasing; a bare spawn over live cells leaves them intact (they are their own cells).
   */
  spawn(key: EntityKey): void {
    this.spawned.add(key);
  }

  /** THREE-PART despawn (§1.3): record + outgoing edges + incoming edges from BOTH arities. */
  despawn(key: EntityKey): void {
    // 1 + 2: drop the record and every outgoing edge (clears the reverse entries those edges own).
    this.clearOutgoing(key);
    this.components.delete(key);
    this.tags.delete(key);
    this.spawned.delete(key);
    // 3: drop every INCOMING edge `* --rel--> key` — the both-directions cleanup (P2). The reverse
    // index names each source; route to the arity-appropriate forward map to remove the edge.
    const incoming = this.reverse.get(key);
    if (incoming !== undefined) {
      for (const { source, relName, arity } of incoming) {
        if (arity === "one") {
          const m = this.relOne.get(source);
          if (m?.get(relName) === key) m.delete(relName);
        } else {
          this.relMany.get(source)?.get(relName)?.delete(key);
        }
      }
      this.reverse.delete(key);
    }
    // Ordered sequences: `key` as PARENT dies with its sequences; `key` as CHILD was spliced from
    // its parent's sequence by clearOutgoing above.
    this.orderSeqs.delete(key);
  }

  setComponent(key: EntityKey, c: Component, v: ComponentValue): void {
    let m = this.components.get(key);
    if (m === undefined) this.components.set(key, (m = new Map()));
    m.set(c.name, canon(c, v)); // §2: store the canonical value, never the raw literal
  }

  removeComponent(key: EntityKey, c: Component): void {
    this.components.get(key)?.delete(c.name);
  }

  addTag(key: EntityKey, t: Tag): void {
    let s = this.tags.get(key);
    if (s === undefined) this.tags.set(key, (s = new Set()));
    s.add(t.name);
  }

  removeTag(key: EntityKey, t: Tag): void {
    this.tags.get(key)?.delete(t.name);
  }

  setRelation(key: EntityKey, r: Relation, target: EntityKey): void {
    if (r.arity !== "one") {
      throw new Error(`strata: setRelation is for arity "one" relations — use addRelation for "${r.name}".`);
    }
    let m = this.relOne.get(key);
    if (m === undefined) this.relOne.set(key, (m = new Map()));
    const prev = m.get(r.name);
    if (prev !== undefined) this.dropReverse(prev, key, r.name); // replace: old target loses its incoming edge
    m.set(r.name, target);
    this.addReverse(target, key, r.name, "one");
    if (r.ordered) {
      // Placeless set: NEW edge appends "last"; re-set of the SAME target keeps position — the
      // exact runtime parity (M1 §3.3) the P8 cross-path determinism property rides on.
      if (prev === target) return;
      if (prev !== undefined) this.spliceSeq(prev, r.name, key);
      this.insertSeq(target, r.name, key, "last");
    }
  }

  /**
   * Ordered write extensions (plan-ordered-relations §4.3): NOT part of the frozen
   * {@link MutableSnapshot} — they live on the implementation the way the Loro adapter's
   * store-support surface does. Same semantics as the runtime: placed set (idempotent re-set with
   * a place = move), move-in-place (false when no edge), absent anchors degrade to "last".
   */
  setRelationPlaced(key: EntityKey, r: Relation, target: EntityKey, place?: OrderPlaceKey): void {
    if (!r.ordered) throw new Error(`strata: setRelationPlaced requires an ordered relation — "${r.name}".`);
    this.setRelation(key, r, target); // edge + lockstep default handling (new→"last", same→keep)
    if (place === undefined) return;
    this.insertSeq(target, r.name, key, place); // re-place (insertSeq splices any existing occurrence)
  }

  moveRelationPlaced(key: EntityKey, r: Relation, place: OrderPlaceKey): boolean {
    if (!r.ordered) throw new Error(`strata: moveRelationPlaced requires an ordered relation — "${r.name}".`);
    const parent = this.relOne.get(key)?.get(r.name);
    if (parent === undefined) return false;
    this.insertSeq(parent, r.name, key, place);
    return true;
  }

  /** {@link OrderSource}: the RAW recorded sequence — the ladder oracle's converged order. */
  readOrder(key: EntityKey, r: Relation): readonly EntityKey[] | undefined {
    return this.orderSeqs.get(key)?.get(r.name);
  }

  addRelation(key: EntityKey, r: Relation, target: EntityKey): void {
    if (r.arity !== "many") {
      throw new Error(`strata: addRelation is for arity "many" relations — use setRelation for "${r.name}".`);
    }
    let m = this.relMany.get(key);
    if (m === undefined) this.relMany.set(key, (m = new Map()));
    let set = m.get(r.name);
    if (set === undefined) m.set(r.name, (set = new Set()));
    if (!set.has(target)) {
      set.add(target); // idempotent (mirrors runtime.addRelation)
      this.addReverse(target, key, r.name, "many");
    }
  }

  /** Remove one edge (target given) or every edge of `r` from `key` (target-less). Keeps reverse in sync. */
  removeRelation(key: EntityKey, r: Relation, target?: EntityKey): void {
    if (r.arity === "one") {
      const m = this.relOne.get(key);
      const cur = m?.get(r.name);
      if (cur === undefined) return;
      if (target === undefined || target === cur) {
        m!.delete(r.name);
        this.dropReverse(cur, key, r.name);
        if (r.ordered) this.spliceSeq(cur, r.name, key);
      }
    } else {
      const set = this.relMany.get(key)?.get(r.name);
      if (set === undefined) return;
      if (target === undefined) {
        for (const t of set) this.dropReverse(t, key, r.name);
        this.relMany.get(key)!.delete(r.name); // drop the whole slot (no lingering empty set)
      } else if (set.delete(target)) {
        this.dropReverse(target, key, r.name);
      }
    }
  }

  setResource(res: Resource, v: ComponentValue): void {
    this.resources.set(res.name, canonResource(res, v)); // §2: object-backed canonical (defaults-filled, no coercion)
  }

  removeResource(res: Resource): void {
    this.resources.delete(res.name);
  }

  // --- internals -------------------------------------------------------------

  /** Any live cell on `key` (component / tag / non-empty relation) — the derived-liveness probe. */
  private hasAnyCell(key: EntityKey): boolean {
    if ((this.components.get(key)?.size ?? 0) > 0) return true;
    if ((this.tags.get(key)?.size ?? 0) > 0) return true;
    if ((this.relOne.get(key)?.size ?? 0) > 0) return true;
    const many = this.relMany.get(key);
    if (many !== undefined) for (const set of many.values()) if (set.size > 0) return true;
    return false;
  }

  /** Remove every OUTGOING edge from `key` (both arities), keeping the reverse index — and, for
   *  ordered relations, the target's sibling sequence — in sync. */
  private clearOutgoing(key: EntityKey): void {
    const one = this.relOne.get(key);
    if (one !== undefined) {
      for (const [name, target] of one) {
        this.dropReverse(target, key, name);
        if (relationByName(name)?.ordered) this.spliceSeq(target, name, key);
      }
      this.relOne.delete(key);
    }
    const many = this.relMany.get(key);
    if (many !== undefined) {
      for (const [name, targets] of many) {
        for (const target of targets) this.dropReverse(target, key, name);
      }
      this.relMany.delete(key);
    }
  }

  /** Remove `child` from `parent`'s sequence under `relName` (edge already unlinked). */
  private spliceSeq(parent: EntityKey, relName: string, child: EntityKey): void {
    const arr = this.orderSeqs.get(parent)?.get(relName);
    if (arr === undefined) return;
    const i = arr.indexOf(child);
    if (i >= 0) arr.splice(i, 1);
  }

  /** Place `child` in `parent`'s sequence per `place` — splices any existing occurrence first
   *  (re-placement is a move; no duplicates); absent/self anchors degrade to "last" (§3.3). */
  private insertSeq(parent: EntityKey, relName: string, child: EntityKey, place: OrderPlaceKey): void {
    let byRel = this.orderSeqs.get(parent);
    if (byRel === undefined) this.orderSeqs.set(parent, (byRel = new Map()));
    let arr = byRel.get(relName);
    if (arr === undefined) byRel.set(relName, (arr = []));
    const existing = arr.indexOf(child);
    if (existing >= 0) arr.splice(existing, 1);
    let index: number;
    if (place === "first") {
      index = 0;
    } else if (place === "last") {
      index = arr.length;
    } else {
      const anchor = "before" in place ? place.before : place.after;
      const at = anchor === child ? -1 : arr.indexOf(anchor);
      index = at < 0 ? arr.length : "before" in place ? at : at + 1;
    }
    arr.splice(index, 0, child);
  }

  private addReverse(target: EntityKey, source: EntityKey, relName: string, arity: "one" | "many"): void {
    let edges = this.reverse.get(target);
    if (edges === undefined) this.reverse.set(target, (edges = []));
    edges.push({ source, relName, arity });
  }

  /** Drop the single reverse entry for `source --relName--> target` ((target,source,relName) is unique). */
  private dropReverse(target: EntityKey, source: EntityKey, relName: string): void {
    const edges = this.reverse.get(target);
    if (edges === undefined) return;
    const i = edges.findIndex((e) => e.source === source && e.relName === relName);
    if (i !== -1) edges.splice(i, 1);
    if (edges.length === 0) this.reverse.delete(target);
  }
}

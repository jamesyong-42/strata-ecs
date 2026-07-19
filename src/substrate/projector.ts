/**
 * The projector kernel (Patch Note 005 §5) — the one mechanism the durable and ephemeral layers
 * share. Its job is narrow: maintain the key↔handle BIJECTION, and APPLY already-scheduled
 * projection changes to the runtime. It is policy-free — it never consults a baseline, owns no
 * queue, and decides no timing. The binding calls it only from `attach` (Part III §13.1) or from
 * `world.sync()` (§13.3), both OUTSIDE any system iteration, so its writes apply IMMEDIATELY and
 * never touch the command buffer (Part I §5.4).
 *
 * Every primitive it calls already carries the 002/003 reactivity stamp behind the `reactiveOn`
 * gate (§5.3), so a projected change is visible at the next `reactive.notify()` with zero extra
 * wiring. Projection routes ONLY through these stamped primitives — raw-column projection is
 * forbidden.
 */

import type { Entity } from "../core/entity";
import type { EntityKey } from "../core/field";
import type { Component, Relation, Tag } from "../core/schema";
// Value import: the barrel exports RuntimeStore type-only post-R2, but an internal value import is
// fine (the projector IS an internal driver of the engine seam, §5.2).
import { RuntimeStore } from "../core/runtime-store";
import type { OrderSource } from "./types";

const EMPTY_ORDER: readonly EntityKey[] = [];

export class Projector {
  private readonly keyToHandle = new Map<EntityKey, Entity>();
  private readonly handleToKey = new Map<Entity, EntityKey>();
  /** The converged-order read seam (plan-ordered-relations §4.2/§4.3) — wired by the binding
   *  (M3: the adapter's store-support surface; M2 conformance: the BaselineSnapshot). Null when
   *  the attached document has no order capability: D7 then runs completion-only. */
  private orderSource: OrderSource | null = null;

  constructor(
    private readonly runtime: RuntimeStore,
    /** The kernel owns BOTH id-spaces — keys via `mintKey`, handles via `runtime.allocateIdentity`. */
    private readonly mintKey: () => EntityKey,
  ) {}

  setOrderSource(src: OrderSource | null): void {
    this.orderSource = src;
  }

  /** The ONLY place a pair is recorded — `bind` is private, so there is no "allocate but don't link". */
  private bind(key: EntityKey, handle: Entity): void {
    this.keyToHandle.set(key, handle);
    this.handleToKey.set(handle, key);
  }

  // --- the three mint policies (§5.1) ---------------------------------------

  /**
   * PROJECTION: a remote/stored key arrived — ensure it has a bound handle. Mints IDENTITY only
   * (`allocateIdentity` — slot + generation, no placement, no key, runtime-store.ts:599) and is
   * IDEMPOTENT: a second call for the same key returns the same handle. Safe in any context (§5).
   */
  resolveByKey(key: EntityKey): Entity {
    let h = this.keyToHandle.get(key);
    if (h === undefined) {
      h = this.runtime.allocateIdentity();
      this.bind(key, h);
    }
    return h;
  }

  /** LOCAL SPAWN into a store (`tx.spawn` / `eph.spawn`): a fresh handle exists — mint a key, bind. */
  createPair(handle: Entity): EntityKey {
    if (this.handleToKey.has(handle)) throw new Error("strata: handle already has a key.");
    const key = this.mintKey();
    this.bind(key, handle);
    return key;
  }

  /**
   * REFERENCING an existing store entity (`tx.addComponent(rect, …) → keyOf`): the handle MUST
   * already belong to this store. No mint — a missing key means a runtime-only (`world.spawn`) or
   * other-store entity, which must NOT be silently promoted into document content. THROWS (§5.1);
   * property P3 tests it throws exactly for unbound handles.
   */
  requireKey(handle: Entity): EntityKey {
    const key = this.handleToKey.get(handle);
    if (key === undefined) throw new Error("strata: op references an entity not in this store.");
    return key;
  }

  /**
   * Read-only bijection peeks — NEITHER mints. `resolveByKey`/`requireKey` are the driving surface
   * (mint-or-throw); these are the INSPECTION surface. The conformance suite (005 §8) needs to read a
   * runtime cell back by key WITHOUT minting a phantom identity for an untouched key, and to map a
   * relation TARGET handle the runtime returned back to its key. An unbound argument returns
   * `undefined` (never throws, never mints) — safe to call on any key/handle at any time.
   */
  handleFor(key: EntityKey): Entity | undefined {
    return this.keyToHandle.get(key);
  }
  keyFor(handle: Entity): EntityKey | undefined {
    return this.handleToKey.get(handle);
  }

  // --- cell application (§5.2) ----------------------------------------------
  // All apply IMMEDIATELY — projection only ever runs OUTSIDE iteration, so no column walk is in
  // progress and nothing routes through the command buffer. Each method resolves identity (minting
  // it for a not-yet-seen key/target) and writes through a shipped, stamped RuntimeStore primitive.
  // NB: RESOURCE facts have NO kernel path — a resource carries no entity key, so the durable seam
  // lands `resource-set`/`resource-remove` DIRECTLY on `RuntimeStore.setResource`/`removeResource`
  // (§5.2, §6.1), bypassing the projector entirely.

  applyComponent<S>(key: EntityKey, c: Component<S>, v: S): void {
    this.runtime.projectComponent(this.resolveByKey(key), c, v); // add-if-absent(→place)-else-write (:824)
  }

  removeComponent(key: EntityKey, c: Component): void {
    this.runtime.projectRemoveComponent(this.resolveByKey(key), c); // remove-if-present, else no-op (:844)
  }

  /** A componentless spawn doc-fact: place into the empty archetype now, so the entity is queryable (§5.4). */
  applySpawn(key: EntityKey): void {
    this.runtime.ensurePlaced(this.resolveByKey(key)); // idempotent place (:608)
  }

  applyTag(key: EntityKey, t: Tag): void {
    const h = this.resolveByKey(key);
    this.runtime.ensurePlaced(h); // a tag makes the key live + queryable
    this.runtime.addTag(h, t); // (:907)
  }

  removeTag(key: EntityKey, t: Tag): void {
    this.runtime.removeTag(this.resolveByKey(key), t); // (:916)
  }

  applyRelationSet(key: EntityKey, r: Relation, target: EntityKey): void {
    const h = this.resolveByKey(key);
    this.runtime.ensurePlaced(h); // a relation makes the source live + queryable
    if (r.ordered) {
      // D7 COROLLARY (plan-ordered-relations §4.2): every ordered edge fact is ALSO an
      // order-invalidation for BOTH affected parents — without the re-derivation, a placeless
      // append here would diverge from a fresh joiner's bootstrap derivation. Old parent read
      // BEFORE the edge moves.
      const oldParent = this.runtime.getRelation(h, r);
      const t = this.resolveByKey(target);
      this.runtime.setRelation(h, r, t);
      if (oldParent !== undefined && oldParent !== t) {
        const oldKey = this.handleToKey.get(oldParent);
        // A keyless old parent is runtime-only (local, never doc-ordered): the M1 splice suffices.
        if (oldKey !== undefined) this.rederiveOrder(oldParent, oldKey, r);
      }
      this.rederiveOrder(t, target, r);
      return;
    }
    this.runtime.setRelation(h, r, this.resolveByKey(target)); // arity "one" (:939); target minted if new
  }

  /**
   * Apply an `order-invalidate` fact (plan-ordered-relations §4.2): payload-free — re-read the
   * converged sequence and apply the D7 effective order wholesale. An UNKNOWN parent key is inert
   * (nothing is projected under it; a pure order fact must never mint identity — hostile/stale
   * facts stay harmless), matching the edge-authority law: sequences never create membership.
   * Returns whether a re-derivation actually APPLIED (rev-m3 finding 2: the binding's
   * `lastAppliedFrame` counts real applies only — the inert paths must not advance it).
   */
  applyOrder(parentKey: EntityKey, r: Relation): boolean {
    const parent = this.keyToHandle.get(parentKey);
    if (parent === undefined) return false;
    return this.rederiveOrder(parent, parentKey, r);
  }

  /**
   * D7 (plan-ordered-relations D7): effective order = [converged-sequence entries that are live
   * children of the parent, first occurrence wins] ++ [remaining KEYED children in EntityKey
   * ascending order] ++ [keyless children in current relative order]. Keyless children are
   * runtime-only locals — invisible to the doc, peer-local by definition, so their placement
   * cannot diverge across peers; keyed completion is doc-derived and deterministic everywhere.
   */
  private rederiveOrder(parent: Entity, parentKey: EntityKey, r: Relation): boolean {
    const current = this.runtime.getReverse(parent, r);
    if (current.length === 0) return false;
    const raw = this.orderSource?.readOrder(parentKey, r) ?? EMPTY_ORDER;
    const byKey = new Map<EntityKey, Entity>();
    for (const h of current) {
      const k = this.handleToKey.get(h);
      if (k !== undefined) byKey.set(k, h);
    }
    const seen = new Set<Entity>();
    const effective: Entity[] = [];
    for (const k of raw) {
      const h = byKey.get(k);
      if (h === undefined || seen.has(h)) continue; // stale / foreign / duplicate — filtered (D2)
      seen.add(h);
      effective.push(h);
    }
    const keyedRest: Array<[EntityKey, Entity]> = [];
    const keylessRest: Entity[] = [];
    for (const h of current) {
      if (seen.has(h)) continue;
      const k = this.handleToKey.get(h);
      if (k === undefined) keylessRest.push(h);
      else keyedRest.push([k, h]);
    }
    keyedRest.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [, h] of keyedRest) effective.push(h);
    for (const h of keylessRest) effective.push(h);
    this.runtime.setOrderedChildren(r, parent, effective);
    return true;
  }

  applyRelationAdd(key: EntityKey, r: Relation, target: EntityKey): void {
    const h = this.resolveByKey(key);
    this.runtime.ensurePlaced(h);
    this.runtime.addRelation(h, r, this.resolveByKey(target)); // arity "many" (:951)
  }

  removeRelation(key: EntityKey, r: Relation, target?: EntityKey): void {
    this.runtime.removeRelation(
      this.resolveByKey(key),
      r,
      target !== undefined ? this.resolveByKey(target) : undefined,
    ); // (:963)
  }

  /**
   * Entity despawn — the reverse-index cascade is inline in `runtime.destroy` (Part I §5.5, :663).
   * ORDER (§5.2): `destroy` bumps the slot's generation, so the packed `Entity` that `handleToKey`
   * was stored under is `oldHandle` (pre-bump). Capture it, destroy, then delete BOTH directions
   * using the captured handle — never re-read after destroy, when its generation no longer matches.
   */
  remove(key: EntityKey): void {
    const oldHandle = this.keyToHandle.get(key);
    if (oldHandle !== undefined) {
      this.runtime.destroy(oldHandle);
      this.keyToHandle.delete(key);
      this.handleToKey.delete(oldHandle);
    }
  }

  /**
   * Teardown (§5.6). The full contract is FOUR steps; the BINDING (Part III) owns steps 0–2 and MUST
   * run them FIRST, so no queued-but-undrained batch can project into a torn-down binding:
   *   0. `World.unregisterInboundSource(this)` — stop `world.sync()` from ever draining us again;
   *   1. unsubscribe from the document / EphemeralStore — stop new doc-facts arriving;
   *   2. clear the binding's pending inbound queue — discard queued-but-undrained batches/events.
   * The projector owns STEP 3 only: despawn every projected entity and clear the bijection.
   */
  teardown(): void {
    for (const key of [...this.keyToHandle.keys()]) this.remove(key); // snapshot keys — remove() mutates the map
    this.keyToHandle.clear();
    this.handleToKey.clear();
  }
}

/**
 * The reactive observer layer (Patch Note 002 §3–4) — a poll-at-boundary read surface over the
 * change-detection stamps the store already carries (002 §2). Nothing here touches the hot loop:
 * observers are compared against column/rows/tag stamps at a single settled point per frame,
 * {@link Reactive.notify}, called once by the app after all ticks (002 §4.1).
 *
 * A cost ladder (002 §3):
 *   - Tier 1 {@link Reactive.observeQuery}  — query-level: did anything matching change / membership move.
 *   - Tier 2 — entity-level (column-granular): REMOVED pre-1.0. Its stamp was archetype-wide, so it fired
 *     on ANY co-resident component's write, not just the watched one — an attractive nuisance; use Tier 3.
 *   - Tier 3 {@link Reactive.observeValue}  — value-level: this entity's value actually differs (equality-checked).
 *
 * {@link Reactive.observeResource} adds a Tier-3-equivalent channel for world-singleton resources
 * (Patch Note 003 §1) — `setResource` replaces the object wholesale, so it is equality-suppressed too.
 *
 * Registration is a frame boundary (002 §4.1a): each `observe*` advances the store frame and baselines
 * the observer at `frame − 1`, so a change made in the SAME frame as registration is observed at the
 * very next `notify()` while nothing stamped before the subscription ever fires — no priming needed.
 *
 * The core stays framework-agnostic — it is built over a {@link RuntimeStore} alone; `@vibecook/strata-ecs/react`
 * is a thin `useSyncExternalStore` adapter over Tier 3 + {@link Reactive.peek} (002 §5).
 */

import type { Entity } from "./entity";
import type { Archetype } from "./archetype";
import type { Component, ComponentId, RelationId, Resource, ResourceId, TagId } from "./schema";
import type { Query } from "./query";
import type { RuntimeStore } from "./runtime-store";
import { devError } from "./dev";

/** The teardown handle every `observe*` returns — idempotent (002 §3). */
export type Unsubscribe = () => void;

/** A Tier-1 (query-level) registration. `matches` is the store's live cache (002 §3.1). */
interface QueryWatch {
  readonly matches: readonly Archetype[];
  readonly colIds: readonly ComponentId[];
  /**
   * The membership ids this watch depends on (§4.2 per-id): the tags/relations whose row filter or
   * concrete-target seed the query's plan carries (query.ts `membershipTagIds`/`membershipRelIds`). A
   * tag/relation mutation wakes the watch ONLY when it stamped one of THESE ids. Both are empty for a
   * query with no row filter and no seed — it never consults membership stamps (its rows move only
   * structurally), and empty too for a mixed-`Any` whose members are ALL components (they migrate rows).
   */
  readonly tagIds: readonly TagId[];
  readonly relIds: readonly RelationId[];
  readonly cb: () => void;
  /** `opts.immediate` — fire once at the first notify() after registration regardless of stamps, then self-clears. */
  immediate: boolean;
  /** Set by unsubscribe; a snapshot-iterated pass skips it so a mid-pass unsub never fires late. */
  dead: boolean;
  lastSeen: number;
}

/** A Tier-3 (value-level) registration. Cells hold an ARRAY — many watches per (component, entity). */
interface Watch {
  readonly component: Component;
  readonly entity: Entity;
  readonly cb: (v: unknown) => void;
  /** Value equality (custom or the shallow default). */
  readonly eq: (a: unknown, b: unknown) => boolean;
  /** Last-fired value — the stable reference {@link Reactive.peek} returns (002 §3.3/§5). */
  box: unknown;
  /** Last-known "present with a value" state — drives the fire-once-`undefined` on component removal (§3.4). */
  hadValue: boolean;
  /** Set by unsubscribe / self-removal; snapshot passes skip it. */
  dead: boolean;
  lastSeen: number;
}

/**
 * A resource watch (Patch Note 003 §1.3) — Tier-3 semantics over a world singleton. `setResource`
 * replaces the stored object wholesale, so identity alone cannot mean "changed"; the box + `eq`
 * suppress no-op writes exactly as the value tier does. No death path — resources are never removed.
 */
interface ResourceWatch {
  readonly resource: Resource;
  readonly cb: (v: unknown) => void;
  readonly eq: (a: unknown, b: unknown) => boolean;
  /** Last-delivered value — this watch's OWN eq baseline only (peek never serves boxes). */
  box: unknown;
  /** Set by unsubscribe; a snapshot-iterated pass skips it. */
  dead: boolean;
  lastSeen: number;
}

/** Shallow structural equality over a component's decoded field values (Tier 3 default, 002 §3.3). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) if (!Object.is(ao[k], bo[k])) return false;
  return true;
}

/**
 * The reactive layer for one world (002 §3). Per-world and mortal — it does not survive a
 * `world.import()` swap (002 §6); the app re-subscribes after a swap.
 */
export class Reactive {
  private readonly queryWatches: QueryWatch[] = [];
  /** (component, entity) → the watches on that cell. An array so a second watch never evicts the first. */
  private readonly watched = new Map<ComponentId, Map<Entity, Watch[]>>();
  /**
   * Per-component quiescent-skip watermark (review-part1 R5): a conservative lower bound on the
   * minimum `lastSeen` across the component's live watches. `notifyWatches` skips a whole component's
   * map when `store.componentFrame(cid) <= componentSeen[cid]` — one compare, no per-cell walk, no
   * allocation. Set to `frame − 1` when a component's first watch registers, and REPAIRED to `frame`
   * (exact — every surviving watch's `lastSeen` is advanced to `frame` during a full process) after
   * the map is walked. Removal leaves it (still a valid lower bound); it self-heals on the next walk.
   */
  private readonly componentSeen = new Map<ComponentId, number>();
  /** resource → its watches (003 §1.3). A collection, like the entity cells; no death path. */
  private readonly resourceWatched = new Map<ResourceId, ResourceWatch[]>();
  /** Entities the eager death hook saw destroyed, awaiting an undefined-fire at the next notify (§3.4). */
  private readonly pendingDeaths = new Set<Entity>();
  /** Live Tier-3 watch count — the eager death hook is installed while this is > 0 (§3.4). */
  private entityWatchCount = 0;

  constructor(private readonly store: RuntimeStore) {}

  // ---------------------------------------------------------------------------
  // Registration (a frame boundary; no immediate fire — see the file header)
  // ---------------------------------------------------------------------------

  /**
   * Tier 1 (002 §3.1) — fire when any matching archetype's watched column or membership changed.
   * `opts.cols` defaults to the query's OWN required components; pass it to narrow to a subset (or to
   * widen to co-resident columns the query does not itself require). `opts.immediate: true` fires the
   * callback once at the first notify() after registration regardless of stamps (a first-paint seed) —
   * registration itself still never back-fires synchronously.
   */
  observeQuery(q: Query, cb: () => void, opts?: { cols?: readonly Component[]; immediate?: boolean }): Unsubscribe {
    this.store.enableReactive(); // stamping arms at REGISTRATION — property reads are side-effect-free
    this.store.armAccessEnforcement(); // first observer arms 001 dev-enforcement (001 §2.4)
    this.store.advanceFrame(); // registration is a frame boundary (§4.1a) — see the file header
    const watch: QueryWatch = {
      matches: this.store.matchesFor(q),
      colIds: opts?.cols !== undefined ? opts.cols.map((c) => c.id) : q.required,
      // §4.2 per-id membership deps: the tags/relations whose row filter or concrete-target seed can
      // move this query's rows without a column/structural stamp. A concrete-target `Related(rel,
      // target)` compiles to a `seed` (no row filter) but still turns over on setRelation/removeRelation
      // — query.ts folds the seed's relation into membershipRelIds, so it is covered here too.
      tagIds: q.membershipTagIds,
      relIds: q.membershipRelIds,
      cb,
      immediate: opts?.immediate === true,
      dead: false,
      lastSeen: this.store.frame - 1,
    };
    this.queryWatches.push(watch);
    return () => {
      if (watch.dead) return;
      watch.dead = true;
      const i = this.queryWatches.indexOf(watch);
      if (i >= 0) this.queryWatches.splice(i, 1);
    };
  }

  /** Tier 3 (002 §3.3) — fire only when this entity's value actually differs (equality-checked). */
  observeValue<S>(
    e: Entity,
    c: Component<S>,
    cb: (v: S | undefined) => void,
    eq?: (a: S, b: S) => boolean,
  ): Unsubscribe {
    return this.registerWatch(
      e,
      c,
      cb as (v: unknown) => void,
      (eq as ((a: unknown, b: unknown) => boolean) | undefined) ?? shallowEqual,
    );
  }

  /**
   * Resource-level (003 §1.3) — Tier-3 semantics over a world singleton: fire only when a
   * `setResource` actually changed the value (equality-checked; default shallow eq over its fields).
   * A never-set resource baselines its box to `undefined`, so the first set fires with the value.
   */
  observeResource<S>(
    r: Resource<S>,
    cb: (v: S | undefined) => void,
    eq?: (a: S, b: S) => boolean,
  ): Unsubscribe {
    this.store.enableReactive(); // stamping arms at REGISTRATION — property reads are side-effect-free
    this.store.armAccessEnforcement(); // a reactive observer arms 001 dev-enforcement (001 §2.4)
    this.store.advanceFrame(); // registration frame boundary (§4.1a)
    let arr = this.resourceWatched.get(r.id);
    if (arr === undefined) {
      arr = [];
      this.resourceWatched.set(r.id, arr);
    }
    const watch: ResourceWatch = {
      resource: r,
      cb: cb as (v: unknown) => void,
      eq: (eq as ((a: unknown, b: unknown) => boolean) | undefined) ?? shallowEqual,
      box: this.store.getResource(r), // prime the box (undefined if unset) — no back-fire at registration
      dead: false,
      lastSeen: this.store.frame - 1,
    };
    arr.push(watch);
    return () => this.removeResourceWatch(r.id, watch);
  }

  private registerWatch(
    e: Entity,
    c: Component,
    cb: (v: unknown) => void,
    eq: (a: unknown, b: unknown) => boolean,
  ): Unsubscribe {
    this.store.enableReactive(); // stamping arms at REGISTRATION — property reads are side-effect-free
    this.store.armAccessEnforcement();
    this.store.advanceFrame(); // registration frame boundary (§4.1a)
    let m = this.watched.get(c.id);
    if (m === undefined) {
      m = new Map();
      this.watched.set(c.id, m);
    }
    let arr = m.get(e);
    if (arr === undefined) {
      arr = [];
      m.set(e, arr);
    }
    const current = this.store.get(e, c);
    const watch: Watch = {
      component: c,
      entity: e,
      cb,
      eq,
      // Prime the box with the current value so `peek` is stable from registration and the first
      // notify suppresses a same-value baseline (no fire on registration, §3.3).
      box: current,
      hadValue: current !== undefined,
      dead: false,
      lastSeen: this.store.frame - 1,
    };
    arr.push(watch);
    // Seed the skip watermark on the component's FIRST watch (R5). A later watch registers at a
    // higher frame (lastSeen ≥ the existing watermark), so it never lowers the bound — leave it.
    if (!this.componentSeen.has(c.id)) this.componentSeen.set(c.id, watch.lastSeen);
    this.retainLifecycle(); // counts EACH watch (many per cell), not each cell
    return () => this.removeWatch(c.id, e, watch);
  }

  // ---------------------------------------------------------------------------
  // The settled point (002 §4.1) — user-called once per frame after all ticks
  // ---------------------------------------------------------------------------

  /**
   * Compare stamps, fire dirty observers, then advance the frame (002 §4.1a). Order (002 §4.1):
   * (1) drain eager deaths, (2) Tier 1, (3) Tier 3, (4) always `advanceFrame()`. Callback dispatch
   * runs under the store's observer-emit flag so structural mutation from a callback is DEV-rejected
   * (002 §6 — callbacks may SCHEDULE work). A no-op but for the frame advance when nothing is watched.
   */
  notify(): void {
    const store = this.store;
    const prev = store.setObserverEmit(true);
    // Notify-only stamping: callback value writes stamp frame+1, consumed by the trailing
    // advanceFrame below. Dev-tool observer emits must NOT get the +1 (they have no consumer).
    const prevStamp = store.setNotifyStamping(true);
    try {
      if (this.pendingDeaths.size > 0) this.drainDeaths();
      if (this.queryWatches.length > 0) this.notifyQueries();
      if (this.resourceWatched.size > 0) this.notifyResources();
      if (this.watched.size > 0) this.notifyWatches();
    } finally {
      store.setObserverEmit(prev);
      store.setNotifyStamping(prevStamp);
      store.advanceFrame(); // ALWAYS — uniform §4.1a frame semantics, even with zero observers
    }
  }

  /** (1) Eager death (§3.4): every watch on the dead entity fires `undefined` once and self-removes. */
  private drainDeaths(): void {
    const dead = [...this.pendingDeaths];
    this.pendingDeaths.clear();
    for (const e of dead) {
      for (const cid of [...this.watched.keys()]) {
        const arr = this.watched.get(cid)?.get(e);
        if (arr === undefined) continue;
        for (const w of [...arr]) {
          if (w.dead) continue;
          // Null the box BEFORE firing (mirrors the component-removal path): a React binding's
          // getSnapshot reads peek() synchronously inside the notification, and a stale box
          // would make useSyncExternalStore skip the re-render (003 §2 — found by the binding).
          w.hadValue = false;
          w.box = undefined;
          fire(w.cb, undefined);
          this.removeWatch(cid, e, w);
        }
      }
    }
  }

  /**
   * (2) Tier 1 (§3.1/§4.2). Two-phase so the all-clean path allocates NOTHING (R5): phase 1 scans
   * the live array — safe because it never fires, so a callback can't mutate it — and collects the
   * dirty watches only if any exist; phase 2 fires them off that snapshot, re-checking `dead` so a
   * callback that unsubscribes a sibling mid-pass is honored. Semantics unchanged from the old
   * snapshot-every-pass form.
   */
  private notifyQueries(): void {
    const store = this.store;
    let dirty: QueryWatch[] | null = null;
    for (const w of this.queryWatches) {
      if (!w.dead && (w.immediate || queryDirty(w, store))) (dirty ??= []).push(w);
    }
    if (dirty === null) return; // no matching change since last seen — zero allocation
    const frame = store.frame;
    for (const w of dirty) {
      if (w.dead) continue; // an earlier callback in this pass may have removed it
      w.immediate = false; // consume the one-shot immediate seed (fires once, at the first notify)
      fire0(w.cb);
      w.lastSeen = frame;
    }
  }

  /** (2.5) Resources (003 §1.3). A Tier-3 pass between Tier 1 and the entity tiers. */
  private notifyResources(): void {
    const frame = this.store.frame;
    for (const [id, arr] of [...this.resourceWatched]) {
      const stamp = this.store.resourceFrame(id);
      // Read the current value at most once per resource, shared across its watches.
      let vRead = false;
      let v: unknown;
      for (const w of [...arr]) {
        if (w.dead) continue;
        if (stamp <= w.lastSeen) continue;
        if (!vRead) {
          v = this.store.getResource(w.resource);
          vRead = true;
        }
        const changed = w.box === undefined || v === undefined ? w.box !== v : !w.eq(v, w.box);
        if (changed) {
          w.box = v;
          fire(w.cb, v);
        }
        w.lastSeen = frame;
      }
    }
  }

  /**
   * (3) Tier 3 (§3.3). Two-phase for the quiescent fast path (R5):
   *
   * Phase 1 — a live-key scan (no fire, so `this.watched` can't mutate under us) compares
   * `store.componentFrame(cid)` against the component's skip watermark. A clean component costs ONE
   * compare and allocates nothing; the whole map is skipped. Only components that saw a value write,
   * a migrate add/remove of one of their columns, or a reset are collected — see the bump-site
   * enumeration on RuntimeStore.componentMaxFrame (per-entity DEATHS are handled by drainDeaths,
   * which ran before this pass, so they don't need the array).
   *
   * Phase 2 — process only dirty components, snapshotting each cell/array so a callback that
   * registers or unsubscribes a watch mid-dispatch can't corrupt iteration. Every surviving watch's
   * `lastSeen` is advanced to `frame` (even a clean one), which lets the watermark settle to `frame`
   * so the next idle pass skips.
   */
  private notifyWatches(): void {
    const store = this.store;
    // Phase 1 — collect dirty components without allocating on the all-clean path.
    let dirty: ComponentId[] | null = null;
    for (const cid of this.watched.keys()) {
      const seen = this.componentSeen.get(cid);
      if (seen === undefined || store.componentFrame(cid) > seen) (dirty ??= []).push(cid);
    }
    if (dirty === null) return; // fully quiescent — no per-cell work, no allocation
    // Phase 2 — process the dirty components.
    const frame = store.frame;
    for (const cid of dirty) {
      const m = this.watched.get(cid);
      if (m === undefined) continue; // emptied by a callback earlier in this pass
      for (const [e, arr] of [...m]) {
        if (!store.isAlive(e)) {
          // Fallback death path (§3.4) — eager cleanup usually removed it at drainDeaths already, but
          // a reset() bumps generations without queueing the hook, so a reset-killed watch lands here.
          for (const w of [...arr]) {
            if (w.dead) continue;
            w.hadValue = false;
            w.box = undefined; // before firing — peek() must not serve the dead value (003 §2)
            fire(w.cb, undefined);
            this.removeWatch(cid, e, w);
          }
          continue;
        }
        const arch = store.archetypeOf(e);
        const slot = arch !== undefined ? arch.componentSlot(cid) : -1;
        const present = slot >= 0;
        const stamp = present ? (arch as Archetype).lastWrittenFrame[slot] : 0;
        // Read the current value at most once per cell, shared across the cell's watches.
        let vRead = false;
        let v: unknown;
        for (const w of [...arr]) {
          if (w.dead) continue;
          if (present) {
            if (stamp > w.lastSeen) {
              if (!vRead) {
                v = store.get(e, w.component);
                vRead = true;
              }
              const changed = w.box === undefined || v === undefined ? w.box !== v : !w.eq(v, w.box);
              if (changed) {
                w.box = v;
                fire(w.cb, v);
              }
              w.hadValue = true;
            }
            w.lastSeen = frame; // ALWAYS advance (even a clean cell) so the watermark can settle (R5)
          } else if (w.hadValue) {
            // The watched COMPONENT was removed while the entity lives — fire `undefined` once and
            // keep the watch, so a later re-add re-fires via migrate's added-column stamp (§3.4).
            w.hadValue = false;
            w.box = undefined;
            fire(w.cb, undefined);
            w.lastSeen = frame;
          } else {
            w.lastSeen = frame; // absent + already fired the removal — advance so the watermark settles
          }
        }
      }
      // The map was fully walked → every surviving watch now has lastSeen == frame, so the watermark
      // is exactly `frame` (idle passes then skip). If death-removal emptied it, drop the entry.
      if (this.watched.has(cid)) this.componentSeen.set(cid, frame);
      else this.componentSeen.delete(cid);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads / escape hatch / frame view
  // ---------------------------------------------------------------------------

  /**
   * The CURRENT value, read from the store — never a watch's box. Per-watch boxes exist only
   * for each watch's own eq decision; serving one from peek made the snapshot depend on which
   * watch registered first (a coexisting coarse-eq watch starved React re-renders — an
   * adversarially-confirmed heisenbug). `get` decodes a fresh object per call, so a
   * `useSyncExternalStore` consumer must ref-cache its snapshot (strata-ecs/react does).
   */
  peek<S>(e: Entity, c: Component<S>): S | undefined {
    return this.store.get(e, c);
  }

  /**
   * The CURRENT resource value — the stored object itself, which is reference-stable between
   * `setResource` calls (that stability, not a watch box, is what makes it a valid
   * `useSyncExternalStore` snapshot). Same first-watch-box hazard rationale as {@link peek}.
   */
  peekResource<S>(r: Resource<S>): S | undefined {
    return this.store.getResource(r);
  }

  /** Manual whole-component stamp for writes no chokepoint can see (002 §2.2 escape hatch). */
  invalidate(c: Component): void {
    this.store.invalidateComponent(c);
  }

  /** Read-only view of the store's reactive frame counter (002 §2.1/§4.1a). */
  get frame(): number {
    return this.store.frame;
  }

  // ---------------------------------------------------------------------------
  // Eager death hook (§3.4) — one dedicated store slot while any entity is watched
  // ---------------------------------------------------------------------------

  private retainLifecycle(): void {
    this.entityWatchCount++;
    if (this.entityWatchCount === 1) {
      this.store.setReactiveDeathHook((e) => this.onEntityDestroyed(e));
    }
  }

  private releaseLifecycle(): void {
    this.entityWatchCount--;
    if (this.entityWatchCount === 0) {
      this.store.setReactiveDeathHook(null);
    }
  }

  /**
   * The death hook fires mid-flush pre-teardown (runtime-store.destroy), so it must ONLY queue — never
   * fire callbacks synchronously (§3.4). Queue only watched entities to keep `pendingDeaths` small.
   */
  private onEntityDestroyed(e: Entity): void {
    for (const m of this.watched.values()) {
      if (m.has(e)) {
        this.pendingDeaths.add(e);
        return;
      }
    }
  }

  /** Remove exactly `watch` from its cell — idempotent (guards its own `dead` flag). */
  private removeWatch(cid: ComponentId, e: Entity, watch: Watch): void {
    if (watch.dead) return;
    watch.dead = true;
    const m = this.watched.get(cid);
    const arr = m?.get(e);
    if (arr !== undefined) {
      const i = arr.indexOf(watch);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) m!.delete(e);
      if (m!.size === 0) {
        this.watched.delete(cid);
        this.componentSeen.delete(cid); // no watches left on cid — drop its skip watermark (R5)
      }
    }
    this.releaseLifecycle();
  }

  /** Remove exactly `watch` from its resource (003 §1.3) — idempotent; no lifecycle hook (no death path). */
  private removeResourceWatch(id: ResourceId, watch: ResourceWatch): void {
    if (watch.dead) return;
    watch.dead = true;
    const arr = this.resourceWatched.get(id);
    if (arr !== undefined) {
      const i = arr.indexOf(watch);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.resourceWatched.delete(id);
    }
  }
}

/** Fire a Tier-1 callback, swallowing throws (house rule: observer callbacks must not throw). */
function fire0(cb: () => void): void {
  try {
    cb();
  } catch (err) {
    devError(`reactive observer threw — swallowed; callbacks must not throw (reactive.ts): ${String(err)}`);
  }
}

/** Fire a Tier-3 callback with a value, swallowing throws. */
function fire(cb: (v: unknown) => void, v: unknown): void {
  try {
    cb(v);
  } catch (err) {
    devError(`reactive observer threw — swallowed; callbacks must not throw (reactive.ts): ${String(err)}`);
  }
}

/**
 * Tier-1 dirtiness (002 §3.1/§4.2): a watched column stamped, rows moved, or a tag/relation THIS query's
 * plan depends on had its per-id membership version bumped (§4.2). Allocation-free — the membership check
 * walks the watch's own small dep lists and polls the store's dense per-id stamps (empty lists for a
 * query with no row filter/seed, so it costs nothing there).
 */
function queryDirty(w: QueryWatch, store: RuntimeStore): boolean {
  const seen = w.lastSeen;
  for (const arch of w.matches) {
    if (arch.lastStructuralFrame > seen) return true;
    const lwf = arch.lastWrittenFrame;
    for (const cid of w.colIds) {
      const slot = arch.componentSlot(cid);
      if (slot >= 0 && lwf[slot] > seen) return true;
    }
  }
  for (const id of w.tagIds) if (store.tagFrame(id) > seen) return true;
  for (const id of w.relIds) if (store.relFrame(id) > seen) return true;
  return false;
}

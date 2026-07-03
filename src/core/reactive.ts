/**
 * The reactive observer layer (Patch Note 002 §3–4) — a poll-at-boundary read surface over the
 * change-detection stamps the store already carries (002 §2). Nothing here touches the hot loop:
 * observers are compared against column/rows/tag stamps at a single settled point per frame,
 * {@link Reactive.notify}, called once by the app after all ticks (002 §4.1).
 *
 * Three tiers, a visible cost ladder (002 §3):
 *   - Tier 1 {@link Reactive.observeQuery}  — query-level: did anything matching change / membership move.
 *   - Tier 2 {@link Reactive.observeEntity} — entity-level: this entity's column stamped (fires even if equal).
 *   - Tier 3 {@link Reactive.observeValue}  — value-level: this entity's value actually differs (equality-checked).
 *
 * Registration is a frame boundary (002 §4.1a): each `observe*` advances the store frame and baselines
 * the observer at `frame − 1`, so a change made in the SAME frame as registration is observed at the
 * very next `notify()` while nothing stamped before the subscription ever fires — no priming needed.
 *
 * The core stays framework-agnostic — it is built over a {@link RuntimeStore} alone; `@strata/react`
 * is a thin `useSyncExternalStore` adapter over Tier 3 + {@link Reactive.peek} (002 §5).
 */

import type { Entity } from "./entity";
import type { Archetype } from "./archetype";
import type { Component, ComponentId } from "./schema";
import type { Query } from "./query";
import type { RuntimeStore } from "./runtime-store";
import { devError } from "./dev";

/** The teardown handle every `observe*` returns — idempotent (002 §3). */
export type Unsubscribe = () => void;

/** A Tier-1 (query-level) registration. `matches` is the store's live cache (002 §3.1). */
interface QueryWatch {
  readonly matches: readonly Archetype[];
  readonly colIds: readonly ComponentId[];
  /** Whether membership can change without a column stamp — row filters OR a relation seed (§4.2). */
  readonly rowFiltered: boolean;
  readonly cb: () => void;
  /** Set by unsubscribe; a snapshot-iterated pass skips it so a mid-pass unsub never fires late. */
  dead: boolean;
  lastSeen: number;
}

/** A Tier-2/3 (entity/value-level) registration. Cells hold an ARRAY — many watches per (component, entity). */
interface Watch {
  readonly tier: 2 | 3;
  readonly component: Component;
  readonly entity: Entity;
  readonly cb: (v: unknown) => void;
  /** Tier 3 equality (custom or the shallow default); unused for Tier 2. */
  readonly eq: (a: unknown, b: unknown) => boolean;
  /** Tier 3 last-fired value — the stable reference {@link Reactive.peek} returns (002 §3.3/§5). */
  box: unknown;
  /** Last-known "present with a value" state — drives the fire-once-`undefined` on component removal (§3.4). */
  hadValue: boolean;
  /** Set by unsubscribe / self-removal; snapshot passes skip it. */
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
  /** Entities the eager death hook saw destroyed, awaiting an undefined-fire at the next notify (§3.4). */
  private readonly pendingDeaths = new Set<Entity>();
  /** Live Tier-2/3 watch count — the eager death hook is installed while this is > 0 (§3.4). */
  private entityWatchCount = 0;

  constructor(private readonly store: RuntimeStore) {}

  // ---------------------------------------------------------------------------
  // Registration (a frame boundary; no immediate fire — see the file header)
  // ---------------------------------------------------------------------------

  /** Tier 1 (002 §3.1) — fire when any matching archetype's watched column or membership changed. */
  observeQuery(q: Query, cols: readonly Component[], cb: () => void): Unsubscribe {
    this.store.armAccessEnforcement(); // first observer arms 001 dev-enforcement (001 §2.4)
    this.store.advanceFrame(); // registration is a frame boundary (§4.1a) — see the file header
    const watch: QueryWatch = {
      matches: this.store.matchesFor(q),
      colIds: cols.map((c) => c.id),
      // A concrete-target `Related(rel, target)` compiles to a `seed` with NO row filter, yet its
      // membership still turns over on setRelation/removeRelation — consult `tagRelFrame` for it too.
      rowFiltered: q.rowFilters.length > 0 || q.seed !== undefined,
      cb,
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

  /** Tier 2 (002 §3.2) — fire when this entity's column stamped, with the current value (even if equal). */
  observeEntity<S>(e: Entity, c: Component<S>, cb: (v: S | undefined) => void): Unsubscribe {
    return this.registerWatch(2, e, c, cb as (v: unknown) => void, shallowEqual);
  }

  /** Tier 3 (002 §3.3) — fire only when this entity's value actually differs (equality-checked). */
  observeValue<S>(
    e: Entity,
    c: Component<S>,
    cb: (v: S | undefined) => void,
    eq?: (a: S, b: S) => boolean,
  ): Unsubscribe {
    return this.registerWatch(
      3,
      e,
      c,
      cb as (v: unknown) => void,
      (eq as ((a: unknown, b: unknown) => boolean) | undefined) ?? shallowEqual,
    );
  }

  private registerWatch(
    tier: 2 | 3,
    e: Entity,
    c: Component,
    cb: (v: unknown) => void,
    eq: (a: unknown, b: unknown) => boolean,
  ): Unsubscribe {
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
      tier,
      component: c,
      entity: e,
      cb,
      eq,
      // Tier 3 primes its box with the current value so `peek` is stable from registration and the
      // first notify suppresses a same-value baseline (no fire on registration, §3.3).
      box: tier === 3 ? current : undefined,
      hadValue: current !== undefined,
      dead: false,
      lastSeen: this.store.frame - 1,
    };
    arr.push(watch);
    this.retainLifecycle(); // counts EACH watch (many per cell), not each cell
    return () => this.removeWatch(c.id, e, watch);
  }

  // ---------------------------------------------------------------------------
  // The settled point (002 §4.1) — user-called once per frame after all ticks
  // ---------------------------------------------------------------------------

  /**
   * Compare stamps, fire dirty observers, then advance the frame (002 §4.1a). Order (002 §4.1):
   * (1) drain eager deaths, (2) Tier 1, (3) Tier 2/3, (4) always `advanceFrame()`. Callback dispatch
   * runs under the store's observer-emit flag so structural mutation from a callback is DEV-rejected
   * (002 §6 — callbacks may SCHEDULE work). A no-op but for the frame advance when nothing is watched.
   */
  notify(): void {
    const store = this.store;
    const prev = store.setObserverEmit(true);
    try {
      if (this.pendingDeaths.size > 0) this.drainDeaths();
      if (this.queryWatches.length > 0) this.notifyQueries();
      if (this.watched.size > 0) this.notifyWatches();
    } finally {
      store.setObserverEmit(prev);
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
          fire(w.cb, undefined);
          this.removeWatch(cid, e, w);
        }
      }
    }
  }

  /** (2) Tier 1 (§3.1/§4.2). Iterates a snapshot + the `dead` flag so a callback may unsubscribe safely. */
  private notifyQueries(): void {
    const frame = this.store.frame;
    const tagRel = this.store.lastTagRelFrame;
    for (const w of [...this.queryWatches]) {
      if (w.dead) continue;
      if (queryDirty(w, tagRel)) {
        fire0(w.cb);
        w.lastSeen = frame;
      }
    }
  }

  /** (3) Tier 2/3 (§3.2/§3.3). Snapshot each cell so death-removal / self-unsub during dispatch is safe. */
  private notifyWatches(): void {
    const frame = this.store.frame;
    for (const cid of [...this.watched.keys()]) {
      const m = this.watched.get(cid);
      if (m === undefined) continue;
      for (const [e, arr] of [...m]) {
        if (!this.store.isAlive(e)) {
          // Fallback death path (§3.4) — eager cleanup usually removed it at drainDeaths already.
          for (const w of [...arr]) {
            if (w.dead) continue;
            fire(w.cb, undefined);
            this.removeWatch(cid, e, w);
          }
          continue;
        }
        const arch = this.store.archetypeOf(e);
        const slot = arch !== undefined ? arch.componentSlot(cid) : -1;
        const present = slot >= 0;
        const stamp = present ? (arch as Archetype).lastWrittenFrame[slot] : 0;
        // Read the current value at most once per cell, shared across the cell's watches.
        let vRead = false;
        let v: unknown;
        for (const w of [...arr]) {
          if (w.dead) continue;
          if (present) {
            if (stamp <= w.lastSeen) continue;
            if (!vRead) {
              v = this.store.get(e, w.component);
              vRead = true;
            }
            if (w.tier === 2) {
              fire(w.cb, v);
            } else {
              const changed = w.box === undefined || v === undefined ? w.box !== v : !w.eq(v, w.box);
              if (changed) {
                w.box = v;
                fire(w.cb, v);
              }
            }
            w.hadValue = true;
            w.lastSeen = frame;
          } else if (w.hadValue) {
            // The watched COMPONENT was removed while the entity lives — fire `undefined` once and
            // keep the watch, so a later re-add re-fires via migrate's added-column stamp (§3.4).
            w.hadValue = false;
            w.box = undefined;
            fire(w.cb, undefined);
            w.lastSeen = frame;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reads / escape hatch / frame view
  // ---------------------------------------------------------------------------

  /** The first Tier-3 watch's boxed value if `(e, c)` is value-watched (stable ref), else a `get` read (002 §5). */
  peek<S>(e: Entity, c: Component<S>): S | undefined {
    const arr = this.watched.get(c.id)?.get(e);
    if (arr !== undefined) {
      for (const w of arr) if (w.tier === 3) return w.box as S | undefined;
    }
    return this.store.get(e, c);
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
      if (m!.size === 0) this.watched.delete(cid);
    }
    this.releaseLifecycle();
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

/** Fire a Tier-2/3 callback with a value, swallowing throws. */
function fire(cb: (v: unknown) => void, v: unknown): void {
  try {
    cb(v);
  } catch (err) {
    devError(`reactive observer threw — swallowed; callbacks must not throw (reactive.ts): ${String(err)}`);
  }
}

/** Tier-1 dirtiness (002 §3.1/§4.2): a watched column stamped, rows moved, or (row-filtered) a tag/relation moved. */
function queryDirty(w: QueryWatch, tagRel: number): boolean {
  const seen = w.lastSeen;
  for (const arch of w.matches) {
    if (arch.lastStructuralFrame > seen) return true;
    const lwf = arch.lastWrittenFrame;
    for (const cid of w.colIds) {
      const slot = arch.componentSlot(cid);
      if (slot >= 0 && lwf[slot] > seen) return true;
    }
  }
  return w.rowFiltered && tagRel > seen;
}

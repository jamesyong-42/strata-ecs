/**
 * The lifecycle recorder — the timeline's data layer. Capture rides the core's
 * `WorldObserver` hooks, NOT a poll: entities born and destroyed between UI refreshes
 * (one-tick gesture entities, spawn/reap churn) are recorded too. `onDestroy` fires before
 * teardown, so the dying entity's final description is frozen while it is still readable.
 *
 * Entities already alive when the recorder attaches are BACKFILLED (bornMs 0, the current
 * tick) so attach order doesn't decide whether the timeline sees the world's population.
 */

import type { Entity, World } from "../../core/index";
import type { DescribeFn } from "./describe";

export interface LifeRecord {
  id: Entity;
  bornTick: number;
  /** Session-relative ms (performance.now − attach origin). Backfilled records use 0. */
  bornMs: number;
  diedTick: number | null;
  diedMs: number | null;
  /** Frozen at death; while alive, describe(world, id) live instead (see timeline). */
  label: string;
  color: string;
  phase: string | null;
}

export interface LifecycleRecorder {
  /** Every record in birth order — this IS the timeline's row order. */
  records(): readonly LifeRecord[];
  nowMs(): number;
  /** Drop all DEAD records; living entities keep their true birth. */
  clear(): void;
  /** Detach from the world. */
  dispose(): void;
}

function makeRecord(id: Entity, bornTick: number, bornMs: number): LifeRecord {
  return { id, bornTick, bornMs, diedTick: null, diedMs: null, label: "entity", color: "#768390", phase: null };
}

/**
 * `cap` bounds memory by evicting the oldest DEAD records — living entities are never
 * evicted (so total memory is living + cap, by design). Eviction is amortized: a spawn
 * with no dead records to shed costs O(1) — a world holding more than `cap` LIVING
 * entities must not tax every subsequent spawn (adversarial-review finding: the naive
 * front-scan hung bulk seeding by ~200×).
 */
export function createLifecycleRecorder(world: World, describe: DescribeFn, cap = 4000): LifecycleRecorder {
  const origin = performance.now();
  const now = (): number => performance.now() - origin;
  let list: LifeRecord[] = [];
  // byId entries exist ONLY while the entity is alive (deleted at death) — that also makes
  // a generation-wrap re-issue of a packed handle harmless: the old dead record no longer
  // owns a map entry the new one could be confused with.
  const byId = new Map<Entity, LifeRecord>();
  let deadCount = 0;

  // Backfill the already-alive population so the timeline starts complete.
  for (const arch of world.runtime.archetypes()) {
    for (let i = 0; i < arch.count; i++) {
      const e = arch.entities[i] as Entity;
      const rec = makeRecord(e, world.tickCount, 0);
      list.push(rec);
      byId.set(e, rec);
    }
  }

  /** One O(n) compaction dropping the oldest dead records; amortized by the caller. */
  const evict = (): void => {
    let target = Math.min(list.length - cap, deadCount);
    if (target <= 0) return;
    const next: LifeRecord[] = [];
    for (const r of list) {
      if (target > 0 && r.diedMs !== null) {
        target--;
        deadCount--;
        continue; // list is birth-ordered → drops oldest dead first
      }
      next.push(r);
    }
    list = next;
  };

  const detach = world.observe({
    onSpawn: (id) => {
      const rec = makeRecord(id, world.tickCount, now());
      list.push(rec);
      byId.set(id, rec);
      // amortize: compact in chunks, and only when there is actually something to shed
      if (deadCount > 0 && list.length > cap + Math.max(1, cap >> 3)) evict();
    },
    onDestroy: (id) => {
      const rec = byId.get(id);
      if (rec === undefined) return;
      byId.delete(id); // alive-only map — see note above
      rec.diedTick = world.tickCount;
      rec.diedMs = now();
      deadCount++;
      // still fully readable here (pre-teardown contract) — freeze the final identity
      const d = describe(world, id);
      rec.label = d.label;
      rec.color = d.color ?? rec.color;
      rec.phase = d.phase ?? null;
    },
    // A wholesale reset (world.reset / import replace) fires ONCE, in place of per-entity onDestroy,
    // and the reset entities are already dead + unreadable here — so freezing final labels is not an
    // option. A reset replaces the document, making the prior session's timeline meaningless, so drop
    // it entirely; the re-import's onSpawn events repopulate it. This mirrors the pre-R3 world swap,
    // which discarded the old recorder and built a fresh one on the new world.
    onReset: () => {
      list = [];
      byId.clear();
      deadCount = 0;
    },
  });

  return {
    records: () => list,
    nowMs: now,
    clear() {
      list = list.filter((r) => r.diedMs === null);
      deadCount = 0;
    },
    dispose: detach,
  };
}

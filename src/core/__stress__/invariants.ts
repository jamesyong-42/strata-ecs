/**
 * Reusable invariant assertions for the stress suite. Each walks the live store through the
 * `world.runtime` seam and throws with a precise message on the first violation, so a failing
 * soak points straight at the broken row/column rather than an opaque count mismatch.
 */

import { type Entity, slotOf } from "../entity";
import type { World } from "../world";

/**
 * String-null capacity invariant (design §3.4, §5.5): for every string column, every cell at or
 * beyond the archetype's live `count` must be exactly `null` — never `undefined` (a hole) and
 * never a retained string (a leak that also pins the referent from GC).
 */
export function assertStringColumnsClean(world: World): void {
  for (const arch of world.runtime.archetypes()) {
    if (arch === undefined) continue;
    for (const f of arch.fields) {
      if (f.kind !== "string") continue;
      const col = arch.columns.get(f.fieldId) as (string | null)[];
      for (let r = arch.count; r < col.length; r++) {
        if (col[r] !== null) {
          throw new Error(
            `string-null invariant broken: column "${f.name}" in archetype [${arch.key}], row ${r} ` +
              `(>= live count ${arch.count}) holds ${JSON.stringify(col[r])}, expected null.`,
          );
        }
      }
    }
  }
}

/**
 * Placement / back-pointer consistency: every placed entity appears exactly once across the
 * archetypes, its slot points back to the archetype it was found in, and it reads as alive+placed.
 * Row-level correctness is exercised transitively by the value-preservation checks in the churn
 * scenarios (a wrong row pointer would surface as a wrong read).
 */
export function assertPlacementConsistent(world: World): void {
  const store = world.runtime;
  const seenSlots = new Set<number>();
  let placedTotal = 0;

  for (const arch of store.archetypes()) {
    if (arch === undefined) continue;
    for (let r = 0; r < arch.count; r++) {
      const e = arch.entities[r] as Entity;
      const slot = slotOf(e);
      if (seenSlots.has(slot)) {
        throw new Error(`placement invariant broken: slot ${slot} appears in two archetype rows.`);
      }
      seenSlots.add(slot);
      placedTotal++;
      if (!store.isAlive(e) || !store.isPlaced(e)) {
        throw new Error(`placement invariant broken: entity in archetype [${arch.key}] row ${r} is not alive+placed.`);
      }
      if (store.debugArchetypeOf(e) !== arch) {
        throw new Error(`placement invariant broken: entity's slot back-pointer disagrees with its archetype row (found in [${arch.key}]).`);
      }
    }
  }

  if (placedTotal !== store.placedEntities().length) {
    throw new Error(`placement invariant broken: archetype row sum ${placedTotal} != placedEntities() ${store.placedEntities().length}.`);
  }
  if (placedTotal > store.liveCount()) {
    throw new Error(`placement invariant broken: placed ${placedTotal} exceeds liveCount ${store.liveCount()}.`);
  }
}

/**
 * THE mutation funnel. Every document mutation in the app goes through `mutate()` — still
 * load-bearing, but no longer as the change detector: CHANGE DETECTION now belongs to the
 * framework (one Tier-1 `world.reactive.observeQuery` in app/reactivity.ts drives repaint).
 * `mutate()` remains the seam it always was — the autosave hook fires here, and undo
 * checkpoints / Part III's `doc.transaction(...)` land here without a rewrite. It keeps the
 * `onMutate` hook specifically because SELECTION is a tag: tag churn moves no watched column
 * and `renderable` has no row filter, so it deliberately does NOT wake the Tier-1 observer —
 * yet `Selected` rides the snapshot and must still schedule an autosave. This hook is that
 * channel.
 */

export const dirty = {
  /** MANUAL force-repaint channel for app-state the world cannot see — cull-test / LOD /
   *  pipeline toggles (main.ts) and the first frame after boot/restore. NOT set by mutate():
   *  document content is detected by the reactive observer, and the camera by
   *  observeResource(Camera) (003 §1) — this flag is the honest residue, nothing more. */
  doc: true,
};

/** App-side counters: HUD reads `entities`; new shapes take `++zTop` so creation order
 *  stays explicit app data (row order is never stacking order in an archetype ECS). */
export const stats = { entities: 0, zTop: 0 };

/** Fired after every mutate() — persistence hangs its debounced autosave here. */
let onMutate: (() => void) | null = null;
export function setOnMutate(fn: () => void): void {
  onMutate = fn;
}

/** Run a document mutation, then fire the autosave hook. No repaint flag: the reactive
 *  observer sees the column stamps / membership change and repaints on its own. */
export function mutate(_label: string, fn: () => void): void {
  fn();
  onMutate?.();
}

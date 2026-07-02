/**
 * THE mutation funnel. Every document mutation in the app goes through `mutate()` — this is
 * load-bearing, not ceremony: strata Part I has no change events, so the funnel IS the
 * change detector (it raises the dirty flag the content layer repaints on). It is also the
 * documented seam where E-later features land without a rewrite: undo checkpoints wrap
 * `mutate()`, and Part III's `doc.transaction(...)` eventually replaces its body.
 */

export const dirty = {
  /** Document content changed (a mutate() ran) — repaint the content layer. */
  doc: true,
  /** Camera moved/zoomed/resized — repaint + re-sync the Camera resource before the tick. */
  camera: true,
};

/** App-side counters the HUD reads (cheaper and more honest than querying per frame). */
export const stats = { entities: 0 };

export function mutate(_label: string, fn: () => void): void {
  fn();
  dirty.doc = true;
}

/**
 * The one reactive subscription that drives the whole editor's repaint + autosave.
 *
 * strata Part I has no change events, so this example used to hand-raise a `dirty.doc` flag
 * from every mutation site. That change detection is now the FRAMEWORK's: a single Tier-1
 * `world.reactive.observeQuery` (Patch Note 002 §3.1) watches every drawable column across
 * the `renderable` query and fires once per settled frame when any of them stamped — a drag
 * (DragMove's `write: [Position]`), a draw/duplicate/delete (a structural rows-version bump),
 * a live resize (`edit().set` at the write chokepoint), or a running sim (Integrate's stamp).
 * The world is the change detector; the app just reacts.
 *
 * Subscribed ONCE, at boot — the World is stable now (restore clears in place via
 * `import(bytes, { replace: true })`, R3), so these registrations SURVIVE a restore. There is no
 * swap and no re-subscribe: the wipe + refill of a restore stamp the same archetypes this same
 * observer watches, so the first post-restore frame repaints on its own. The boot's very first
 * paint is driven by the query observer's `{ immediate: true }` seed — it fires once at the first
 * notify() after registration, so no manual first-paint flag is needed (registration itself is a
 * frame boundary and never back-fires).
 */

import { renderable } from "../ecs/queries";
import { Camera, Fill, Kind, Label, Position, Size, ZIndex } from "../ecs/schema";
import { scheduleAutosave } from "./persistence";
import { world } from "./worldRef";

/** Observer-driven repaint channel: raised by the reactive callbacks, consumed after each
 *  paint (the frame loop resets it alongside `dirty.doc`). Starts `false` — the `immediate`
 *  observeQuery below fires once at the first notify() and raises it, driving the first paint. */
export const repaint = { doc: false };

/**
 * Subscribe the editor's repaint observers to the world. Called once at boot; the subscriptions
 * live for the app's life (they survive restore — the World is stable, R3).
 */
export function wireReactivity(): void {
  const reactive = world.reactive;
  reactive.observeQuery(
    renderable,
    () => {
      repaint.doc = true;
      scheduleAutosave();
    },
    // Watch every drawable column. Label is a deliberate WIDENING — `renderable` does not itself
    // require it, but a note's text edit must repaint too. `immediate` fires this once at the first
    // notify() after registration, which drives the very first paint (no manual first-paint flag).
    { cols: [Position, Size, Fill, Kind, ZIndex, Label], immediate: true },
  );
  // Pan/zoom/resize: camera mutations write the Camera resource immediately (camera.ts), and this
  // Tier-3 watch turns the stamp into a repaint (003 §1.4). View-only — deliberately NOT wired to
  // autosave (per-pan churn is noise; any doc edit persists the viewport, which rides the snapshot
  // as a resource).
  reactive.observeResource(Camera, () => {
    repaint.doc = true;
  });
}

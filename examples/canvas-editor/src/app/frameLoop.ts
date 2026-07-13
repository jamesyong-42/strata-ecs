/**
 * The frame loop — design.md §16.2's canonical shape, verbatim:
 *
 *   world.sync()            ← a no-op in pure Part I; THE line Parts III–IV attach to
 *   world.tick(pipeline)    ← all per-frame logic (systems)
 *   paint()                 ← rendering reads the draw buffer AFTER tick returns
 *
 * Frame and tick timing live in the strata-ecs/tools profiler overlay (it measures both
 * through the world's observer hooks — one tick per rAF makes tick-to-tick THE frame). The
 * loop reports only what the ECS cannot see: the app's two paint costs, which main.ts
 * forwards as profiler lanes. Canvas2D will be the bottleneck long before the ECS is, and
 * that split keeps it visible and honest.
 */

import type { Pipeline } from "@vibecook/strata-ecs";
import { applyPendingSelection } from "../collab/history";
import { drawBuffer } from "../render/drawBuffer";
import { dirty } from "./commands";
import { repaint } from "./reactivity";
import { syncGestureResource } from "./tools";
import { world } from "./worldRef";

export interface FrameStats {
  /** Content-layer paint (0 on frames the dirty gate skipped). */
  contentMs: number;
  /** Overlay paint — every frame, reported separately so an overlay bottleneck is visible. */
  overlayMs: number;
}

export function startFrameLoop(
  pipeline: () => Pipeline,
  paintContent: () => void,
  paintOverlay: () => void,
  onFrame: (s: FrameStats) => void,
): void {
  const frame = (): void => {
    requestAnimationFrame(frame);

    world.sync(); // Part I no-op — kept from day one so the durable layer attaches with zero rewrite
    // A pending undo/redo selection resolves HERE, now sync() has drained the revert into the runtime and
    // its keys bind to handles (collab-only; a fast no-op with nothing pending — collab/history.ts).
    applyPendingSelection();
    // (No camera sync step: camera mutations write the Camera resource immediately, 003 §1.4.)
    syncGestureResource(); // pointer deltas accumulated between frames → the Gesture resource

    drawBuffer.reset();
    world.tick(pipeline());

    // THE settled point (002 §4.1): after all ticks, compare stamps and fire dirty observers.
    // The renderable Tier-1 observer (app/reactivity.ts) sets repaint.doc here when any drawn
    // column stamped this frame. The World is stable (restore clears in place, R3), so this is
    // always the same reactive layer — no re-read. Must run BEFORE the paint gate below.
    world.reactive.notify();

    // Content paint gate. The reactive observers (repaint.doc) ARE the change detection now —
    // drag/draw/duplicate/delete/running-sim reach it through column stamps + rows-version,
    // and pan/zoom through the Camera resource stamp (003 §1.4); dirty.doc survives only for
    // app-state the world can't see (toggles, boot/restore first paint).
    // The overlay repaints every frame; it never forces a content repaint.
    const painted = repaint.doc || dirty.doc;
    const p0 = performance.now();
    if (painted) {
      drawBuffer.sortByZ(); // app-side prep, honestly billed to paint, not to the ECS
      paintContent();
      repaint.doc = false;
      dirty.doc = false;
    }
    const p1 = performance.now();
    paintOverlay();
    const p2 = performance.now();

    onFrame({ contentMs: p1 - p0, overlayMs: p2 - p1 });
  };
  requestAnimationFrame(frame);
}

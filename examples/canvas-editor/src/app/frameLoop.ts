/**
 * The frame loop — design.md §16.2's canonical shape, verbatim:
 *
 *   world.sync()            ← a no-op in pure Part I; THE line Parts III–IV attach to
 *   world.tick(pipeline)    ← all per-frame logic (systems)
 *   paint()                 ← rendering reads the draw buffer AFTER tick returns
 *
 * The HUD gets ECS time and paint time as separate numbers every frame — Canvas2D will be
 * the bottleneck long before the ECS is, and the split keeps that visible and honest.
 */

import type { Pipeline } from "@vibecook/strata-ecs";
import { drawBuffer } from "../render/drawBuffer";
import { dirty } from "./commands";
import { repaint } from "./reactivity";
import { syncGestureResource } from "./tools";
import { world } from "./worldRef";

export interface FrameStats {
  frameMs: number;
  ecsMs: number;
  /** Content-layer paint (0 on frames the dirty gate skipped). */
  contentMs: number;
  /** Overlay paint — every frame, reported separately so an overlay bottleneck is visible. */
  overlayMs: number;
  painted: boolean;
}

export function startFrameLoop(
  pipeline: () => Pipeline,
  paintContent: () => void,
  paintOverlay: () => void,
  onFrame: (s: FrameStats) => void,
): void {
  let last = performance.now();
  const frame = (now: number): void => {
    requestAnimationFrame(frame);

    world.sync(); // Part I no-op — kept from day one so the durable layer attaches with zero rewrite
    // (No camera sync step: camera mutations write the Camera resource immediately, 003 §1.4.)
    syncGestureResource(); // pointer deltas accumulated between frames → the Gesture resource

    drawBuffer.reset();
    const t0 = performance.now();
    world.tick(pipeline());
    const ecsMs = performance.now() - t0;

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

    onFrame({ frameMs: now - last, ecsMs, contentMs: p1 - p0, overlayMs: p2 - p1, painted });
    last = now;
  };
  requestAnimationFrame(frame);
}

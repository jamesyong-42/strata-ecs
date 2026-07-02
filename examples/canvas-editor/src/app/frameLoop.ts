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

import type { Pipeline } from "strata";
import { drawBuffer } from "../render/drawBuffer";
import { syncCameraResource } from "./camera";
import { dirty } from "./commands";
import { gestureActive, syncGestureResource } from "./tools";
import { worldRef } from "./worldRef";

export interface FrameStats {
  frameMs: number;
  ecsMs: number;
  paintMs: number;
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
    const world = worldRef.current;

    world.sync(); // Part I no-op — kept from day one so the durable layer attaches with zero rewrite
    if (dirty.camera) syncCameraResource();
    syncGestureResource(); // pointer deltas accumulated between frames → the Gesture resource

    drawBuffer.reset();
    const t0 = performance.now();
    world.tick(pipeline());
    const ecsMs = performance.now() - t0;

    // Content paint is dirty-gated (no change events exist — the commands.ts funnel, the
    // camera, and an active gesture are the only writers, so their flags ARE the change
    // detection). The overlay repaints every frame; it never forces a content repaint.
    const painted = dirty.doc || dirty.camera || gestureActive();
    const p0 = performance.now();
    if (painted) {
      drawBuffer.sortByZ(); // app-side prep, honestly billed to paint, not to the ECS
      paintContent();
      dirty.doc = false;
      dirty.camera = false;
    }
    paintOverlay();
    const paintMs = performance.now() - p0;

    onFrame({ frameMs: now - last, ecsMs, paintMs, painted });
    last = now;
  };
  requestAnimationFrame(frame);
}

/**
 * Tools as plain state machines. A tool receives world-space pointer events (the input
 * layer converts + routes); continuous manipulation follows the design.md §18 gesture
 * pattern: PREVIEW is cheap and per-frame (the Gesture resource feeding DragMoveSystem, or
 * an app-side marquee array), COMMIT happens once at pointer-up (one bulk tag write, one
 * finalized shape) — the exact seam where undo checkpoints (E3) and Part III's
 * doc.transaction land.
 */

import type { Entity } from "strata";
import { Gesture, Selected } from "../ecs/schema";
import { cam, panBy } from "./camera";
import { dirty } from "./commands";
import {
  createShape,
  destroyShape,
  resizeShape,
  setSelection,
  toggleSelection,
  type ShapeKind,
} from "./editorOps";
import { hitTestPoint, hitTestRegion } from "./hitTest";
import { worldRef } from "./worldRef";

export type ToolId = "select" | "pan" | "rect" | "ellipse" | "note";

export interface PointerInfo {
  sx: number; // screen px
  sy: number;
  wx: number; // world units
  wy: number;
  shift: boolean;
}

/** Live interaction state the overlay layer draws every frame. */
export const interaction = {
  tool: "select" as ToolId,
  hover: undefined as Entity | undefined,
  /** Marquee rect in world space while mode==="marquee". */
  marquee: null as { x0: number; y0: number; x1: number; y1: number } | null,
  /** Marquee live preview — recomputed per move, committed as tags on pointer-up. */
  preview: [] as Entity[],
  /** Preview [x,y,w,h] quads captured in the same walk (overlay draws these directly). */
  previewRects: [] as number[],
  /** Pending world-space drag delta, flushed into the Gesture resource pre-tick. */
  pendingDx: 0,
  pendingDy: 0,
  /** "dragEnd" flushes the final pointer delta through one more tick before going idle —
   *  without it the last movement before pointer-up would be silently dropped. */
  mode: "idle" as "idle" | "drag" | "dragEnd" | "marquee" | "draw" | "pan",
  drawing: undefined as Entity | undefined,
  drawAnchor: { x: 0, y: 0 },
};

let lastSyncedIdle = false;

const toolListeners = new Set<(t: ToolId) => void>();
export function onToolChange(fn: (t: ToolId) => void): void {
  toolListeners.add(fn);
}
export function setTool(tool: ToolId): void {
  cancelGesture();
  interaction.tool = tool;
  for (const fn of toolListeners) fn(tool);
}

/** Sync the ECS Gesture resource from interaction state — called by the frame loop BEFORE
 *  the tick (§18.4: input lands between frames; systems read the resource, not the DOM). */
export function syncGestureResource(): void {
  const m = interaction.mode;
  // idle steady-state writes the resource once, then stops (no per-frame allocation at rest)
  if (m === "idle" && lastSyncedIdle && interaction.pendingDx === 0 && interaction.pendingDy === 0) return;
  const mode =
    m === "drag" || m === "dragEnd" ? "drag" : m === "marquee" ? "marquee" : m === "draw" ? "draw" : "idle";
  worldRef.current.setResource(Gesture, { mode, dx: interaction.pendingDx, dy: interaction.pendingDy });
  interaction.pendingDx = 0;
  interaction.pendingDy = 0;
  lastSyncedIdle = m === "idle";
  if (m === "dragEnd") interaction.mode = "idle"; // residual delta is now in flight
}

export function gestureActive(): boolean {
  return interaction.mode !== "idle";
}

export function pointerDown(p: PointerInfo): void {
  switch (interaction.tool) {
    case "pan":
      interaction.mode = "pan";
      return;
    case "select": {
      const hit = hitTestPoint(p.wx, p.wy);
      if (hit !== undefined) {
        if (p.shift) {
          // shift-click toggles; only drag if the shape ended up selected (a shift-DEselect
          // must not start dragging the rest of the selection out from under the cursor)
          toggleSelection(hit);
          interaction.mode = worldRef.current.hasTag(hit, Selected) ? "drag" : "idle";
          return;
        }
        if (!worldRef.current.hasTag(hit, Selected)) {
          // clicking an already-selected shape keeps the multi-selection (drag moves it all)
          setSelection([hit]);
        }
        interaction.mode = "drag";
      } else {
        interaction.mode = "marquee";
        interaction.marquee = { x0: p.wx, y0: p.wy, x1: p.wx, y1: p.wy };
        interaction.preview = [];
        interaction.previewRects = [];
      }
      return;
    }
    case "rect":
    case "ellipse":
    case "note": {
      interaction.mode = "draw";
      interaction.drawAnchor = { x: p.wx, y: p.wy };
      interaction.drawing = createShape(interaction.tool as ShapeKind, p.wx, p.wy);
      return;
    }
  }
}

export function pointerMove(p: PointerInfo, movementX: number, movementY: number): void {
  switch (interaction.mode) {
    case "pan":
      panBy(movementX, movementY);
      return;
    case "drag":
      // accumulate in world units; DragMoveSystem applies it inside the next tick
      interaction.pendingDx += movementX / cam.zoom;
      interaction.pendingDy += movementY / cam.zoom;
      return;
    case "marquee": {
      const m = interaction.marquee;
      if (m === null) return;
      m.x1 = p.wx;
      m.y1 = p.wy;
      const hits = hitTestRegion(m.x0, m.y0, m.x1, m.y1);
      interaction.preview = hits.entities;
      interaction.previewRects = hits.rects;
      return;
    }
    case "draw": {
      const d = interaction.drawing;
      if (d === undefined) return;
      const a = interaction.drawAnchor;
      resizeShape(d, (a.x + p.wx) / 2, (a.y + p.wy) / 2, Math.abs(p.wx - a.x), Math.abs(p.wy - a.y));
      return;
    }
    case "idle":
      if (interaction.tool === "select") interaction.hover = hitTestPoint(p.wx, p.wy);
      return;
  }
}

export function pointerUp(p: PointerInfo): void {
  switch (interaction.mode) {
    case "marquee":
      // COMMIT: one bulk tag write for the whole sweep (never per-frame churn). Selection is
      // overlay-only — no content repaint needed.
      setSelection(interaction.preview, p.shift);
      interaction.marquee = null;
      interaction.preview = [];
      interaction.previewRects = [];
      interaction.mode = "idle";
      return;
    case "draw": {
      const d = interaction.drawing;
      // COMMIT: clear the gesture state BEFORE setTool — setTool cancels active gestures,
      // and cancelling an active draw destroys the in-flight shape (review finding: the
      // draw tools could never produce a persistent shape).
      interaction.drawing = undefined;
      interaction.mode = "idle";
      if (d !== undefined) {
        const a = interaction.drawAnchor;
        // click-vs-drag threshold in SCREEN pixels — world units break at any zoom ≠ 100%
        const wPx = Math.abs(p.wx - a.x) * cam.zoom;
        const hPx = Math.abs(p.wy - a.y) * cam.zoom;
        if (wPx < 8 && hPx < 8) {
          // click without drag → sensible default size at the click point
          const def = interaction.tool === "ellipse" ? { w: 140, h: 140 } : interaction.tool === "note" ? { w: 180, h: 150 } : { w: 160, h: 100 };
          resizeShape(d, a.x, a.y, def.w, def.h);
        }
        setSelection([d]);
        setTool("select");
      }
      dirty.doc = true;
      return;
    }
    case "drag":
      // gesture end = the future one-commit point (undo checkpoint / doc.transaction);
      // dragEnd flushes the residual pointer delta through one more tick first
      interaction.mode = "dragEnd";
      dirty.doc = true;
      return;
    default:
      interaction.mode = "idle";
      return;
  }
}

/** Esc: abandon whatever is in flight (an unfinished draw is destroyed, not kept). */
export function cancelGesture(): void {
  if (interaction.mode === "draw" && interaction.drawing !== undefined) {
    destroyShape(interaction.drawing);
    interaction.drawing = undefined;
  }
  interaction.marquee = null;
  interaction.preview = [];
  interaction.previewRects = [];
  interaction.hover = undefined; // a stale ring must not outlive the tool/gesture it came from
  interaction.pendingDx = 0;
  interaction.pendingDy = 0;
  interaction.mode = "idle";
}

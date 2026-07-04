/**
 * Tools as plain state machines. A tool receives world-space pointer events (the input
 * layer converts + routes); continuous manipulation follows the design.md §18 gesture
 * pattern: PREVIEW is cheap and per-frame (the Gesture resource feeding DragMoveSystem, or
 * an app-side marquee array), COMMIT happens once at pointer-up (one bulk tag write, one
 * finalized shape) — the exact seam where undo checkpoints (E3) and Part III's
 * doc.transaction land.
 */

import type { Entity } from "strata-ecs";
import { Gesture, Selected } from "../ecs/schema";
import { commitCreate, commitDrag } from "../collab/ops";
import { isCollab } from "../collab/mode";
import { cam, panBy } from "./camera";
import {
  createShape,
  destroyShape,
  resizeShape,
  selectedEntities,
  setSelection,
  toggleSelection,
  type ShapeKind,
} from "./editorOps";
import { hitTestPoint, hitTestRegion } from "./hitTest";
import { world } from "./worldRef";

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
  world.setResource(Gesture, { mode, dx: interaction.pendingDx, dy: interaction.pendingDy });
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
          interaction.mode = world.hasTag(hit, Selected) ? "drag" : "idle";
          return;
        }
        if (!world.hasTag(hit, Selected)) {
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
        if (isCollab()) {
          // COLLAB gesture-end commit (§18.3): the draft was runtime-only (never converged — a peer must
          // not see a half-drawn shape); promote it into its durable twin as ONE document create, and
          // move selection to the twin (runtime-only, like local).
          const twin = commitCreate(d);
          setSelection(twin !== undefined ? [twin] : []);
        } else {
          setSelection([d]);
        }
        setTool("select");
      }
      // No manual repaint flag: the spawn + resize during the draw already stamped
      // Position/Size (and bumped the rows-version), so the reactive observer has fired.
      return;
    }
    case "drag":
      if (isCollab()) {
        // COLLAB gesture-end commit (§18.3): the drag wrote runtime Position every frame; seal the
        // settled position to the document ONCE — fold in the sub-frame residual the local path defers
        // to the dragEnd tick, so the committed value equals what the user sees (runtime == baseline, the
        // cell never strands), then go straight to idle so nothing re-applies it. Reconcile's drag
        // protection held remote edits off these cells until now — the framework's job, not ours (§18.5).
        commitDrag(selectedEntities(), interaction.pendingDx, interaction.pendingDy);
        interaction.pendingDx = 0;
        interaction.pendingDy = 0;
        interaction.mode = "idle";
      } else {
        // gesture end = the one-commit point; dragEnd flushes the residual pointer delta through one
        // more tick first — DragMove's Position stamps drove the repaints, so no manual flag is needed.
        interaction.mode = "dragEnd";
      }
      return;
    default:
      interaction.mode = "idle";
      return;
  }
}

/** Esc: abandon whatever is in flight (an unfinished draw is destroyed, not kept). */
export function cancelGesture(): void {
  const wasDragging = interaction.mode === "drag";
  if (interaction.mode === "draw" && interaction.drawing !== undefined) {
    destroyShape(interaction.drawing);
    interaction.drawing = undefined;
  }
  // A cancelled DRAG keeps the shapes where they were dragged to (local mode never reverts). In collab
  // that runtime move diverged from the baseline, so seal it to the document here — otherwise the cell
  // strands (runtime != baseline, no commit to reconcile it). An abort has no residual → commit as-is.
  if (wasDragging && isCollab()) commitDrag(selectedEntities(), 0, 0);
  interaction.marquee = null;
  interaction.preview = [];
  interaction.previewRects = [];
  interaction.hover = undefined; // a stale ring must not outlive the tool/gesture it came from
  interaction.pendingDx = 0;
  interaction.pendingDy = 0;
  interaction.mode = "idle";
  // force the next frame to rewrite the Gesture resource — after a world restore, the
  // imported resource may hold a mid-gesture snapshot that must be normalized to idle
  lastSyncedIdle = false;
}

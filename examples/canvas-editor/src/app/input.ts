/**
 * DOM input layer. Handlers run BETWEEN frames (design.md §18.4): they convert pointer
 * events to world space, route them through the active tool state machine (tools.ts), and
 * mutate the app camera. Nothing here touches Batch/columns or runs inside a tick.
 *
 * Camera gestures that always work, regardless of tool: wheel pan, ctrl/pinch zoom,
 * middle-drag or space-drag pan, Shift+1 zoom-to-fit.
 */

import { reportCursor } from "../collab/presence";
import { panBy, screenToWorld, zoomAt, zoomToFit } from "./camera";
import { clearSelection, deleteSelection, duplicateSelection } from "./editorOps";
import {
  cancelGesture,
  gestureActive,
  interaction,
  onToolChange,
  pointerDown,
  pointerMove,
  pointerUp,
  setTool,
  type PointerInfo,
  type ToolId,
} from "./tools";

const TOOL_KEYS: Record<string, ToolId> = {
  KeyV: "select",
  KeyH: "pan",
  KeyR: "rect",
  KeyO: "ellipse",
  KeyN: "note",
};

const TOOL_CURSOR: Record<ToolId, string> = {
  select: "default",
  pan: "grab",
  rect: "crosshair",
  ellipse: "crosshair",
  note: "crosshair",
};

export function attachInput(target: HTMLElement, notify: (msg: string) => void): void {
  let spaceHeld = false;
  let panDrag: { id: number } | null = null;
  // Deltas are computed from clientX/Y, not e.movementX/Y — movement* is device-pixel
  // scaled on some platforms (Windows Chromium), which makes drags drift under the cursor.
  let lastPt: { id: number; x: number; y: number } | null = null;

  onToolChange((t) => {
    target.style.cursor = TOOL_CURSOR[t];
  });

  const info = (e: PointerEvent): PointerInfo => {
    const w = screenToWorld(e.clientX, e.clientY);
    return { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, shift: e.shiftKey };
  };

  target.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      else panBy(-e.deltaX, -e.deltaY);
    },
    { passive: false },
  );

  target.addEventListener("pointerdown", (e) => {
    lastPt = { id: e.pointerId, x: e.clientX, y: e.clientY };
    if (e.button === 1 || spaceHeld) {
      panDrag = { id: e.pointerId };
      target.setPointerCapture(e.pointerId);
      target.style.cursor = "grabbing";
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    target.setPointerCapture(e.pointerId);
    pointerDown(info(e));
  });

  target.addEventListener("pointermove", (e) => {
    let dx = 0;
    let dy = 0;
    if (lastPt?.id === e.pointerId) {
      dx = e.clientX - lastPt.x;
      dy = e.clientY - lastPt.y;
      lastPt.x = e.clientX;
      lastPt.y = e.clientY;
    }
    if (panDrag?.id === e.pointerId) {
      panBy(dx, dy);
      return;
    }
    const p = info(e);
    reportCursor(p.wx, p.wy); // collab presence — world coords onto MY ephemeral cursor (no-op in local mode)
    pointerMove(p, dx, dy);
  });

  target.addEventListener("pointerup", (e) => {
    if (panDrag?.id === e.pointerId) {
      panDrag = null;
      target.style.cursor = TOOL_CURSOR[interaction.tool];
      return;
    }
    if (gestureActive()) pointerUp(info(e));
  });
  // a cancelled pointer (tab switch, OS gesture) ABORTS the gesture — it must not commit
  target.addEventListener("pointercancel", (e) => {
    if (panDrag?.id === e.pointerId) {
      panDrag = null;
      target.style.cursor = TOOL_CURSOR[interaction.tool];
      return;
    }
    if (gestureActive()) cancelGesture();
  });

  window.addEventListener("keydown", (e) => {
    const tool = TOOL_KEYS[e.code];
    if (tool !== undefined && !e.metaKey && !e.ctrlKey) {
      setTool(tool);
      return;
    }
    switch (e.code) {
      case "Space":
        spaceHeld = true;
        if (e.target === document.body) e.preventDefault();
        break;
      case "Digit1":
        if (e.shiftKey) zoomToFit();
        break;
      case "Backspace":
      case "Delete": {
        if (gestureActive()) break; // deleting mid-gesture would strand retained handles
        const n = deleteSelection();
        if (n > 0) notify(`deleted ${n.toLocaleString()} shape${n === 1 ? "" : "s"} (arrows cascaded for free)`);
        break;
      }
      case "KeyD":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          const d = duplicateSelection();
          if (d.count > 0) notify(`duplicated ${d.count.toLocaleString()} shapes in ${d.ms.toFixed(1)}ms`);
        }
        break;
      case "Escape":
        if (gestureActive()) cancelGesture();
        else clearSelection();
        break;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceHeld = false;
  });
}

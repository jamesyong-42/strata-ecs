/**
 * DOM input → camera (E0). Handlers run BETWEEN frames and mutate app state / the camera —
 * the frame loop syncs the Camera resource before each tick (design.md §18.4's "input
 * writes land between frames" rule). E1 re-routes left-drag to the tool state machines;
 * space-drag and middle-drag stay pan forever.
 */

import { panBy, zoomAt, zoomToFit } from "./camera";

export function attachInput(target: HTMLElement): void {
  let spaceHeld = false;
  let panning: { id: number } | null = null;

  target.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // trackpad pinch / ctrl+wheel — zoom around the cursor
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else {
        // two-finger scroll — pan
        panBy(-e.deltaX, -e.deltaY);
      }
    },
    { passive: false },
  );

  target.addEventListener("pointerdown", (e) => {
    // E0: any drag pans (space/middle keep panning once tools land in E1)
    if (e.button === 1 || e.button === 0 || spaceHeld) {
      panning = { id: e.pointerId };
      target.setPointerCapture(e.pointerId);
      target.style.cursor = "grabbing";
      e.preventDefault();
    }
  });
  target.addEventListener("pointermove", (e) => {
    if (panning?.id !== e.pointerId) return;
    panBy(e.movementX, e.movementY);
  });
  const endPan = (e: PointerEvent): void => {
    if (panning?.id !== e.pointerId) return;
    panning = null;
    target.style.cursor = "";
  };
  target.addEventListener("pointerup", endPan);
  target.addEventListener("pointercancel", endPan);

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      spaceHeld = true;
      if (e.target === document.body) e.preventDefault(); // keep the page from scrolling
    }
    if (e.shiftKey && e.code === "Digit1") zoomToFit();
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") spaceHeld = false;
  });
}

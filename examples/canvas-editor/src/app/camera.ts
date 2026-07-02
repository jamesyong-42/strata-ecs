/**
 * The infinite-canvas camera. App-side object is the source of truth (DOM events mutate it
 * at event rate); the frame loop syncs it into the Camera RESOURCE once per frame before
 * the tick, which is all CullSystem reads. cam.x/y = world coords at the view center,
 * cam.zoom = screen px per world unit.
 */

import { renderable } from "../ecs/queries";
import { Position, Size, Camera as CameraRes } from "../ecs/schema";
import { dirty } from "./commands";
import { worldRef } from "./worldRef";

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;

export const cam = { x: 0, y: 0, zoom: 1, w: 0, h: 0 };

/** Write the app camera into the ECS resource (frame loop calls this when dirty.camera). */
export function syncCameraResource(): void {
  worldRef.current.setResource(CameraRes, { x: cam.x, y: cam.y, zoom: cam.zoom, w: cam.w, h: cam.h });
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  return {
    x: cam.x + (sx - cam.w / 2) / cam.zoom,
    y: cam.y + (sy - cam.h / 2) / cam.zoom,
  };
}

/** Pan by a screen-pixel delta. */
export function panBy(dxPx: number, dyPx: number): void {
  cam.x -= dxPx / cam.zoom;
  cam.y -= dyPx / cam.zoom;
  dirty.camera = true;
}

/** Zoom by `factor`, keeping the world point under the cursor fixed (zoom-around-cursor). */
export function zoomAt(sx: number, sy: number, factor: number): void {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  if (next === cam.zoom) return;
  const wx = cam.x + (sx - cam.w / 2) / cam.zoom;
  const wy = cam.y + (sy - cam.h / 2) / cam.zoom;
  cam.zoom = next;
  cam.x = wx - (sx - cam.w / 2) / cam.zoom;
  cam.y = wy - (sy - cam.h / 2) / cam.zoom;
  dirty.camera = true;
}

export function setViewportSize(w: number, h: number): void {
  cam.w = w;
  cam.h = h;
  dirty.camera = true;
}

/** Frame the whole document (Shift+1). Read-only out-of-tick query walk (§16). */
export function zoomToFit(): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  worldRef.current.query(renderable).each((b) => {
    const px = b.col(Position).x as Float32Array;
    const py = b.col(Position).y as Float32Array;
    const sw = b.col(Size).w as Float32Array;
    const sh = b.col(Size).h as Float32Array;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      minX = Math.min(minX, px[r] - sw[r] / 2);
      maxX = Math.max(maxX, px[r] + sw[r] / 2);
      minY = Math.min(minY, py[r] - sh[r] / 2);
      maxY = Math.max(maxY, py[r] + sh[r] / 2);
    }
  });
  if (minX === Infinity || cam.w === 0) return;
  cam.x = (minX + maxX) / 2;
  cam.y = (minY + maxY) / 2;
  const pad = 1.1;
  cam.zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min(cam.w / ((maxX - minX) * pad), cam.h / ((maxY - minY) * pad))),
  );
  dirty.camera = true;
}

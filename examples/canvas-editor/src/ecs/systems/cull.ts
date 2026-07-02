/**
 * CullSystem — brute-force full-world viewport culling, every frame, no spatial index.
 *
 * This is the example's thesis in one system: at 100k shapes an AABB test over raw typed-
 * array columns is sub-millisecond (see the HUD row), which is why the example ships no
 * R-tree — the data layout does the work a tree normally would. Visible shapes are copied
 * into the app-side DrawBuffer INSIDE the each() callback (chunk-scoped arrays are never
 * retained), and paint consumes the buffer after tick() returns (design.md §16.2).
 */

import type { Batch } from "strata";
import { defineSystem } from "strata";
import { drawBuffer } from "../../render/drawBuffer";
import { renderable } from "../queries";
import { Camera, Fill, Kind, Position, Size, ZIndex } from "../schema";

export const CullSystem = defineSystem(
  renderable,
  (b: Batch, ctx) => {
    const cam = ctx.getResource(Camera);
    if (cam === undefined) return;
    // View rect in world space (camera x/y = view center, zoom = px per world unit).
    const halfW = cam.w / 2 / cam.zoom;
    const halfH = cam.h / 2 / cam.zoom;
    const minX = cam.x - halfW;
    const maxX = cam.x + halfW;
    const minY = cam.y - halfH;
    const maxY = cam.y + halfH;

    const P = b.col(Position);
    const px = P.x as Float32Array;
    const py = P.y as Float32Array;
    const S = b.col(Size);
    const sw = S.w as Float32Array;
    const sh = S.h as Float32Array;
    const F = b.col(Fill);
    const fr = F.r as Uint8Array;
    const fg = F.g as Uint8Array;
    const fb = F.b as Uint8Array;
    const fa = F.a as Uint8Array;
    const kk = b.col(Kind).shape as Uint8Array;
    const zz = b.col(ZIndex).z as Int32Array;

    const db = drawBuffer;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      const hw = sw[r] / 2;
      const hh = sh[r] / 2;
      const cx = px[r];
      const cy = py[r];
      if (cx + hw < minX || cx - hw > maxX || cy + hh < minY || cy - hh > maxY) continue;
      const color = ((fr[r] << 24) | (fg[r] << 16) | (fb[r] << 8) | fa[r]) >>> 0;
      db.push(cx, cy, sw[r], sh[r], color, kk[r], zz[r], b.entity(r));
    }
  },
  { name: "Cull" },
);

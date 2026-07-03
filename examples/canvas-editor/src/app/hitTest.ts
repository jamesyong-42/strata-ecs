/**
 * Brute-force hit-testing — a read-only out-of-tick query walk over raw columns, no spatial
 * index (same thesis as CullSystem: at editor scale the column sweep IS fast enough, and the
 * HUD can prove it). CONVENTION: these walks are read-only; callers collect results first
 * and mutate after (`world.query()` outside a tick has no command buffer — a shape change
 * mid-walk corrupts the iteration, §16).
 */

import type { Entity } from "strata-ecs";
import { renderable } from "../ecs/queries";
import { Position, Size, ZIndex } from "../ecs/schema";
import { world } from "./worldRef";

/** Topmost shape (by explicit z) containing the world-space point, or undefined. */
export function hitTestPoint(wx: number, wy: number): Entity | undefined {
  let best: Entity | undefined;
  let bestZ = -Infinity;
  world.query(renderable).each((b) => {
    const px = b.col(Position).x;
    const py = b.col(Position).y;
    const sw = b.col(Size).w;
    const sh = b.col(Size).h;
    const zz = b.col(ZIndex).z;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      if (zz[r] <= bestZ) continue;
      if (Math.abs(wx - px[r]) <= sw[r] / 2 && Math.abs(wy - py[r]) <= sh[r] / 2) {
        bestZ = zz[r];
        best = b.entity(r);
      }
    }
  });
  return best;
}

export interface RegionHits {
  entities: Entity[];
  /** [x, y, w, h] per hit (center + size), captured during the walk so the overlay can
   *  highlight thousands of preview shapes without any per-entity readField re-reads. */
  rects: number[];
}

/** Every shape whose AABB intersects the world-space rect (marquee semantics). */
export function hitTestRegion(x0: number, y0: number, x1: number, y1: number): RegionHits {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const entities: Entity[] = [];
  const rects: number[] = [];
  world.query(renderable).each((b) => {
    const px = b.col(Position).x;
    const py = b.col(Position).y;
    const sw = b.col(Size).w;
    const sh = b.col(Size).h;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      const hw = sw[r] / 2;
      const hh = sh[r] / 2;
      if (px[r] + hw >= minX && px[r] - hw <= maxX && py[r] + hh >= minY && py[r] - hh <= maxY) {
        entities.push(b.entity(r));
        rects.push(px[r], py[r], sw[r], sh[r]);
      }
    }
  });
  return { entities, rects };
}

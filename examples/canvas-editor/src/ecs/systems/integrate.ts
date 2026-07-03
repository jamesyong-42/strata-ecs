/**
 * The simulate phase — Integrate then Bounce, in that order (same-phase value-write order
 * is load-bearing and visible as array order in pipeline.ts, §7.2). Both are benchmark-
 * grade dense column loops over [Position, Velocity]; because Velocity lives on every shape
 * from birth (default 0), toggling simulation is a `runIf` gate costing ZERO migrations.
 */

import type { Batch } from "strata-ecs";
import { defineSystem } from "strata-ecs";
import { simulated } from "../queries";
import { Position, SimMode, Velocity } from "../schema";

const DT = 1 / 60; // fixed step — velocities are units/second

export const IntegrateSystem = defineSystem(
  simulated,
  (b: Batch) => {
    const px = b.col(Position).x;
    const py = b.col(Position).y;
    const vx = b.col(Velocity).vx;
    const vy = b.col(Velocity).vy;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      px[r] += vx[r] * DT;
      py[r] += vy[r] * DT;
    }
  },
  // Reads Velocity, writes Position — blanket-stamps Position every sim frame, which is what
  // drives repaint while simulating (the frame loop no longer keys paint off isSimOn()).
  { name: "Integrate", access: { write: [Position], read: [Velocity] } },
);

export const BounceSystem = defineSystem(
  simulated,
  (b: Batch, ctx) => {
    const bound = ctx.getResource(SimMode)?.bound ?? 4000;
    const px = b.col(Position).x;
    const py = b.col(Position).y;
    const vx = b.col(Velocity).vx;
    const vy = b.col(Velocity).vy;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      if (px[r] < -bound) {
        px[r] = -bound;
        vx[r] = -vx[r];
      } else if (px[r] > bound) {
        px[r] = bound;
        vx[r] = -vx[r];
      }
      if (py[r] < -bound) {
        py[r] = -bound;
        vy[r] = -vy[r];
      } else if (py[r] > bound) {
        py[r] = bound;
        vy[r] = -vy[r];
      }
    }
  },
  // Writes both columns (reflects Velocity, clamps Position at the walls).
  { name: "Bounce", access: { write: [Position, Velocity] } },
);

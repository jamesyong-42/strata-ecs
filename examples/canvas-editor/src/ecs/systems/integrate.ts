/**
 * The simulate phase — Integrate then Bounce, in that order (same-phase value-write order
 * is load-bearing and visible as array order in pipeline.ts, §7.2). Both are benchmark-
 * grade dense column loops over [Position, Velocity]; because Velocity lives on every shape
 * from birth (default 0), toggling simulation is a `runIf` gate costing ZERO migrations.
 */

import type { Batch } from "strata";
import { defineSystem } from "strata";
import { simulated } from "../queries";
import { Position, SimMode, Velocity } from "../schema";

const DT = 1 / 60; // fixed step — velocities are units/second

export const IntegrateSystem = defineSystem(
  simulated,
  (b: Batch) => {
    const px = b.col(Position).x as Float32Array;
    const py = b.col(Position).y as Float32Array;
    const vx = b.col(Velocity).vx as Float32Array;
    const vy = b.col(Velocity).vy as Float32Array;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      px[r] += vx[r] * DT;
      py[r] += vy[r] * DT;
    }
  },
  { name: "Integrate" },
);

export const BounceSystem = defineSystem(
  simulated,
  (b: Batch, ctx) => {
    const bound = ctx.getResource(SimMode)?.bound ?? 4000;
    const px = b.col(Position).x as Float32Array;
    const py = b.col(Position).y as Float32Array;
    const vx = b.col(Velocity).vx as Float32Array;
    const vy = b.col(Velocity).vy as Float32Array;
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
  { name: "Bounce" },
);

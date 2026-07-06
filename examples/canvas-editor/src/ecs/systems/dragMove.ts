/**
 * DragMove — the flagship gesture system: while a drag is active, add the frame's pointer
 * delta (already in world units) to the Position columns of the ENTIRE selection in one
 * tag-filtered dense pass. This is the "marquee 5,000 shapes and drag at 60fps" moment —
 * a Float32Array read-modify-write per selected shape and nothing else.
 *
 * Value writes on present components are immediate and legal inside systems (§5.1); the
 * per-frame delta arrives via the Gesture RESOURCE, written by the input layer between
 * frames (§18.4) — systems read resources, they never own DOM state.
 */

import type { Batch } from "@vibecook/strata-ecs";
import { defineSystem } from "@vibecook/strata-ecs";
import { movableSelected } from "../queries";
import { Gesture, Position } from "../schema";

export const DragMoveSystem = defineSystem(
  movableSelected,
  (b: Batch, ctx) => {
    const g = ctx.getResource(Gesture);
    if (g === undefined || (g.dx === 0 && g.dy === 0)) return;
    const px = b.col(Position).x;
    const py = b.col(Position).y;
    const dx = g.dx;
    const dy = g.dy;
    for (let i = 0; i < b.count; i++) {
      const r = b.rows[i];
      px[r] += dx;
      py[r] += dy;
    }
  },
  {
    name: "DragMove",
    // The runIf gate is load-bearing under reactivity (001 §3.4): a gated-off system doesn't
    // run, so its blanket `write: [Position]` stamp is never laid down — idle frames stay
    // stamp-free and the Tier-1 renderable observer (app/reactivity.ts) never fires at rest.
    runIf: (ctx) => ctx.getResource(Gesture)?.mode === "drag",
    access: { write: [Position] },
  },
);

/**
 * The schedule is a plain VALUE (design.md §7): an array of phases you build, filter, and
 * pass to `world.tick(...)` — no registration step, no scheduler. The HUD's per-system
 * checkboxes call buildPipeline with a disabled-set and swap the array live: schedule-as-
 * data as a demo control. The simulate phase is runIf-gated on the SimMode resource — it
 * costs zero while off, everything while on, and the observer's systems tab shows both.
 */

import type { Pipeline } from "strata";
import { phase } from "strata";
import { SimMode } from "./schema";
import { CullSystem } from "./systems/cull";
import { DragMoveSystem } from "./systems/dragMove";
import { BounceSystem, IntegrateSystem } from "./systems/integrate";

export const SYSTEM_NAMES = ["DragMove", "Integrate", "Bounce", "Cull"] as const;
export type SystemName = (typeof SYSTEM_NAMES)[number];

export function buildPipeline(disabled: ReadonlySet<SystemName> = new Set()): Pipeline {
  const gesture = [DragMoveSystem].filter((s) => !disabled.has(s.name as SystemName));
  const simulate = [IntegrateSystem, BounceSystem].filter((s) => !disabled.has(s.name as SystemName));
  const renderPrep = [CullSystem].filter((s) => !disabled.has(s.name as SystemName));
  return [
    phase("gesture", gesture),
    phase("simulate", simulate, { runIf: (ctx) => ctx.getResource(SimMode)?.on === true }),
    phase("renderPrep", renderPrep),
  ];
}

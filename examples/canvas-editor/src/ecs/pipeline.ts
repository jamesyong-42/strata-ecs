/**
 * The schedule is a plain VALUE (design.md §7): an array of phases you build, filter, and
 * pass to `world.tick(...)` — no registration step, no scheduler. E1 adds a `gesture` phase
 * and E2 a runIf-gated `simulate` phase in front of renderPrep; the HUD will rebuild this
 * array live to demo schedule-as-data.
 */

import type { Pipeline } from "strata";
import { phase } from "strata";
import { CullSystem } from "./systems/cull";

export function buildPipeline(): Pipeline {
  return [phase("renderPrep", [CullSystem])];
}

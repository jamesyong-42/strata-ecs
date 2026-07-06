/**
 * Stress controls — the bunnymark-style "+10k" buttons, with the honest twist that this is
 * an EDITOR: everything spawned stays fully selectable, draggable, and deletable. Spawn
 * timing feeds the toast (entity lifecycle is strata's measured benchmark win).
 */

import type { Entity } from "@vibecook/strata-ecs";
import { renderable } from "../ecs/queries";
import { mutate, stats } from "./commands";
import { scheduleAutosave } from "./persistence";
import { seedBoard } from "./seed";
import { isSimOn, setSimBound, setSimulate } from "./sim";
import { world } from "./worldRef";

export const MAX_ENTITIES = 100_000; // well under strata's 2^20 slot ceiling — Canvas2D is the real limit

export interface StressResult {
  spawned: number;
  ms: number;
}

export function stressSpawn(n: number): StressResult {
  const room = Math.max(0, MAX_ENTITIES - stats.entities);
  const count = Math.min(n, room);
  if (count === 0) return { spawned: 0, ms: 0 };
  // vary the seed per wave so clusters land in fresh spots
  const r = seedBoard(world, count, 42 + stats.entities);
  setSimBound(Math.sqrt(stats.entities) * 55 * 1.5);
  // spawning into a running storm: the new wave must move too (velocities default to 0)
  if (isSimOn()) setSimulate(true);
  scheduleAutosave(); // spawns bypass the mutate() funnel — persist them explicitly
  return { spawned: r.count, ms: r.ms };
}

/** Destroy the whole document (collect-then-mutate — never destroy mid-walk, §16). */
export function clearBoard(): number {
  const w = world;
  const doomed: Entity[] = [];
  w.query(renderable).each((b) => {
    for (const r of b) doomed.push(b.entity(r));
  });
  mutate("clear-board", () => {
    for (const e of doomed) w.destroy(e);
  });
  stats.entities = 0;
  stats.zTop = 0;
  return doomed.length;
}

/**
 * The single World reference. `world.import()` only loads into an EMPTY world, so restore
 * (E3) replaces the instance — everything reaches the world through this ref, and nothing
 * may cache a World or Entity handle across a swap (stale handles read as dead, silently).
 */

import type { World } from "strata";
import { createWorld } from "strata";
import { Camera, Gesture, SimMode } from "../ecs/schema";

function freshWorld(): World {
  const w = createWorld({ name: "canvas" });
  w.setResource(Camera, { x: 0, y: 0, zoom: 1, w: 0, h: 0 });
  w.setResource(Gesture, { mode: "idle", dx: 0, dy: 0 });
  w.setResource(SimMode, { on: false, bound: 4000 });
  return w;
}

export const worldRef: { current: World } = { current: freshWorld() };

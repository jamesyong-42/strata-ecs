/**
 * THE single World — constructed once and stable for the app's life. Restore no longer swaps the
 * instance: `world.import(bytes, { replace: true })` (R3) clears in place, keeping this identity,
 * every attached observer, and every reactive registration. So handles are only invalidated by the
 * restore that replaces the entities they name (and those read dead, never aliased) — there is no
 * app-wide swap to reason about, and nothing needs an indirection cell.
 */

import { createWorld } from "strata-ecs";
import { Camera, Gesture, SimMode } from "../ecs/schema";

export const world = createWorld({ name: "canvas" });
world.setResource(Camera, { x: 0, y: 0, zoom: 1, w: 0, h: 0 });
world.setResource(Gesture, { mode: "idle", dx: 0, dy: 0 });
world.setResource(SimMode, { on: false, bound: 4000 });

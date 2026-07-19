/**
 * The shared example schema — defined ONCE, at module level, on purpose.
 *
 * strata's component/tag/relation/resource registry is PROCESS-GLOBAL. `defineComponent("HHPos", …)`
 * registers the name "HHPos" in a table shared by EVERY World constructed anywhere in this Node process.
 * Call `defineComponent` twice with the same name and it THROWS. So the multi-World host (one World per
 * room, N rooms in one process — see host.mjs) does NOT re-declare the schema per room: it imports this
 * module once, and every room's World speaks the same registered vocabulary. The bytes that cross the
 * wire between processes are matched by component NAME, so the host process and every client process must
 * import this identical module — same names, same field shapes — or projection would not line up.
 *
 * THIS FILE IS THE "multiple Worlds share one process-global schema" documentation point.
 */

import { defineComponent, defineQuery, defineResource } from "@vibecook/strata-ecs";

/** A 2-D position — every entity a client spawns carries one, so a query over it counts the room. */
export const Pos = defineComponent("HHPos", { x: "f32", y: "f32" });

/** A little decoration, so an edit has something besides position to move. */
export const Tint = defineComponent("HHTint", { hue: "u16" });

/**
 * The host's per-room stats resource — a RUNTIME-LOCAL singleton (not durable, never leaves the process).
 * The host's tick system rewrites it every dispatch; it is the proof the ECS scheduler drives state with
 * no DOM and no rAF. `entities` = live entities the room's World holds; `ticks` = dispatches so far.
 */
export const HostStats = defineResource("HHHostStats", { entities: "u32", ticks: "u32" });

/** All room entities (each spawn carries {@link Pos}); the host counts them with this. */
export const AllEntities = defineQuery([Pos]);

/**
 * All compiled queries, defined once at module scope — strata caches the compiled plan per
 * store, so queries are constants you import, not something you build per frame (§6).
 */

import { defineQuery, Related } from "strata-ecs";
import { ConnectedTo, Fill, Kind, Label, Position, Selected, Size, Velocity, ZIndex } from "./schema";

/** Everything CullSystem sweeps: the drawable document. */
export const renderable = defineQuery([Position, Size, Fill, Kind, ZIndex]);

/** Shapes with at least one outgoing connector edge (arrow rendering walks this). */
export const connected = defineQuery([Position, Size, Related(ConnectedTo)]);

/** Sticky notes (label reads at paint time are capped to visible notes). */
export const notes = defineQuery([Position, Kind, Label]);

/** The drag gesture writes these columns in one dense pass (E1). */
export const movableSelected = defineQuery([Position, Selected]);

/** Selection outlines + bounds (overlay layer, delete/duplicate collect from this). */
export const selectedBoxes = defineQuery([Position, Size, Selected]);

/** The simulate phase integrates these (E2). */
export const simulated = defineQuery([Position, Velocity]);

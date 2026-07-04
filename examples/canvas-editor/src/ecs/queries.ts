/**
 * All compiled queries, defined once at module scope — strata caches the compiled plan per
 * store, so queries are constants you import, not something you build per frame (§6).
 */

import { defineQuery, Local, Not, Related } from "strata-ecs";
import { ConnectedTo, CursorPos, Fill, Kind, Label, Position, PresenceInfo, Selected, Size, Velocity, ZIndex } from "./schema";

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

/** Remote peers' live presence (collab). `Not(Local)` excludes MY own ephemeral entity — the
 *  overlay draws a labeled cursor per match, and resolves any `SelectionRef` facet to an
 *  outline. Empty (zero cost) in local-only mode, where nothing spawns these. */
export const remotePresence = defineQuery([CursorPos, PresenceInfo, Not(Local)]);

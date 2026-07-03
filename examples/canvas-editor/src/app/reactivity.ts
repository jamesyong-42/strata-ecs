/**
 * The one reactive subscription that drives the whole editor's repaint + autosave.
 *
 * strata Part I has no change events, so this example used to hand-raise a `dirty.doc` flag
 * from every mutation site. That change detection is now the FRAMEWORK's: a single Tier-1
 * `world.reactive.observeQuery` (Patch Note 002 §3.1) watches every drawable column across
 * the `renderable` query and fires once per settled frame when any of them stamped — a drag
 * (DragMove's `write: [Position]`), a draw/duplicate/delete (a structural rows-version bump),
 * a live resize (`edit().set` at the write chokepoint), or a running sim (Integrate's stamp).
 * The world is the change detector; the app just reacts.
 *
 * Per-observer, so it dies with its world (002 §6): a `world.import()` restore mints a fresh
 * world with a fresh reactive registry, so `wireReactivity()` re-subscribes after every swap
 * (main.ts's boot call + the `onRestore` re-attach). The registration itself is a frame
 * boundary and never fires for data that existed before it, so the first post-restore/boot
 * paint still comes from a manual `dirty.doc` (commands.ts) — see frameLoop.ts.
 */

import type { Unsubscribe } from "strata";
import { renderable } from "../ecs/queries";
import { Fill, Kind, Label, Position, Size, ZIndex } from "../ecs/schema";
import { scheduleAutosave } from "./persistence";
import { worldRef } from "./worldRef";

/** Observer-driven repaint channel: raised by the Tier-1 callback, consumed after each paint
 *  (the frame loop resets it alongside `dirty.doc`). Initial `true` so the very first frame
 *  paints even before anything stamps. */
export const repaint = { doc: true };

let unsub: Unsubscribe | null = null;

/**
 * (Re)subscribe the single Tier-1 renderable observer to the current world. Drops any prior
 * subscription first — a restore swaps `worldRef.current`, and a watch on the dead world's
 * registry would silently observe nothing.
 */
export function wireReactivity(): void {
  unsub?.();
  unsub = worldRef.current.reactive.observeQuery(
    renderable,
    // Watch every drawable column (Label included — a note's text edit must repaint too).
    [Position, Size, Fill, Kind, ZIndex, Label],
    () => {
      repaint.doc = true;
      scheduleAutosave();
    },
  );
}

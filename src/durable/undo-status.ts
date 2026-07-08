/**
 * `DurableUndoStatus` — the durable layer's runtime-local undo/redo availability resource (plan-undo U2).
 *
 * The {@link DurableSyncStatus} pattern applied to history state: a framework-defined, RUNTIME-LOCAL
 * resource (never written to the document) the binding publishes with producer-side set-on-change, so a
 * toolbar reads it with `useResource(world, DurableUndoStatus)` and re-renders exactly when a button's
 * enabled state actually flips — an idle stack produces zero re-renders even though history-change
 * notifications fire on every commit.
 *
 * The store's `canUndo()`/`canRedo()` methods are the pull-based equivalent (and the only surface when
 * the store is detached — resources live on worlds). This resource exists so UIs don't poll.
 */

import { defineResource } from "../core";

/** The runtime-local undo/redo availability resource (plan-undo U2). */
export const DurableUndoStatus = defineResource("DurableUndoStatus", {
  canUndo: "bool",
  canRedo: "bool",
});

/** The value shape of {@link DurableUndoStatus} — what the binding sets and `useResource` returns. */
export interface DurableUndoStatusValue {
  canUndo: boolean;
  canRedo: boolean;
}

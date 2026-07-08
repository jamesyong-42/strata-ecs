/**
 * Undo/redo — the history half of collab mode (plan-undo U2). Where boot.ts moves the shared DOCUMENT and
 * presence.ts moves PRESENCE, this module is the app glue over `DurableStore`'s history door: the two
 * `undo`/`redo` verbs the keyboard + HUD call, the selection side-channel that rides the undo stacks, and
 * the reactive HUD-button enablement. All of it is collab-only — `undo`/`redo` no-op in local-only mode
 * (no active session, so nothing to undo), exactly like the presence write hooks.
 *
 * THE ONE SUBTLETY (why the selection restore is two-phase): the store's `restore` hook fires SYNCHRONOUSLY
 * inside `undo()`/`redo()`, but an undo's reversal only reaches the runtime at the NEXT `world.sync()` (the
 * local-ops-only contract). So an entity a delete-undo brings back has NO runtime handle yet when `restore`
 * runs — its keys can't be resolved to a selection there. `restore` therefore only STASHES the keys;
 * {@link applyPendingSelection} resolves them one sync later (the frame loop calls it right after
 * `world.sync()`), dropping keys whose entities no longer exist.
 */

import type { Entity, EntityKey } from "@vibecook/strata-ecs";
import { DurableUndoStatus, type DurableUndoStatusValue } from "@vibecook/strata-ecs/durable";
import { recountShapes, selectedEntities, setSelection } from "../app/editorOps";
import { gestureActive } from "../app/tools";
import { world } from "../app/worldRef";
import type { Hud } from "../ui/hud";
import { activeCollab } from "./mode";

/**
 * Keys an undo/redo `restore` stashed, waiting for the next `world.sync()` to bind them to handles.
 * `null` = nothing pending (the fast path {@link applyPendingSelection} checks every frame).
 */
let pendingSelection: EntityKey[] | null = null;

/**
 * The capture side of the side-channel: the current selection as durable KEYS. Selection holds runtime
 * handles (the `Selected` tag), so each is translated via `store.keyOf`; a non-durable handle (no key)
 * is skipped. Runs inside the history call on PUSH — a pure runtime read, which the hook contract allows.
 */
function captureSelection(): EntityKey[] {
  const store = activeCollab()?.doc;
  if (store === undefined) return [];
  const keys: EntityKey[] = [];
  for (const e of selectedEntities()) {
    const k = store.keyOf(e);
    if (k !== undefined) keys.push(k);
  }
  return keys;
}

/**
 * The restore side: stash the captured keys for {@link applyPendingSelection}. `value` is whatever
 * {@link captureSelection} returned for this step (or `null` if that hook threw and stored null) — a
 * non-array means "no selection to restore", which resolves to a cleared selection one sync later.
 */
function stashRestore(value: unknown): void {
  pendingSelection = Array.isArray(value) ? (value as EntityKey[]) : [];
}

/**
 * Undo the last local change. No-op (returns `false`) in local-only mode so the keyboard handler leaves
 * the browser default alone, and while a gesture is in flight so a mid-drag button-click can't fight the
 * user's hand (the keybinding guards this too — this covers the HUD button path). In collab mode with no
 * gesture it always returns `true` (the key is ours to swallow), even on an empty stack — `store.undo()` is
 * itself the silent no-op there. The reversal reaches the runtime at the next `world.sync()`; the selection
 * it restores rides {@link applyPendingSelection}.
 */
export function undo(): boolean {
  const store = activeCollab()?.doc;
  if (store === undefined || gestureActive()) return false;
  store.undo();
  return true;
}

/** Redo the last undone change — the mirror of {@link undo}. */
export function redo(): boolean {
  const store = activeCollab()?.doc;
  if (store === undefined || gestureActive()) return false;
  store.redo();
  return true;
}

/**
 * Apply a stashed undo/redo selection — the frame loop calls this right AFTER `world.sync()`, once the
 * revert has drained and its keys resolve to live handles. A fast no-op when nothing is pending. Keys that
 * no longer resolve (their entity is gone) are dropped; an empty result clears the selection.
 */
export function applyPendingSelection(): void {
  if (pendingSelection === null) return;
  const keys = pendingSelection;
  pendingSelection = null;
  const store = activeCollab()?.doc;
  if (store === undefined) return;
  const entities: Entity[] = [];
  for (const k of keys) {
    const e = store.resolve(k);
    if (e !== undefined) entities.push(e);
  }
  setSelection(entities);
  // The revert just changed the shape population outside the incremental verbs — re-derive the HUD tally.
  recountShapes();
}

/**
 * Wire undo/redo for the active collab session — called once from the `?collab` boot after the store is
 * attached (so `DurableUndoStatus` is already published). Installs the selection side-channel on the undo
 * stacks, lights up the HUD's undo/redo buttons, and drives their disabled state reactively from
 * `DurableUndoStatus` (producer-side set-on-change, so steady-state editing never re-writes them). No-op in
 * local-only mode.
 */
export function installHistory(hud: Hud): void {
  const store = activeCollab()?.doc;
  if (store === undefined) return;

  // Selection rides the undo stacks as durable keys: capture on push, restore on pop. The hooks run INSIDE
  // the history call and touch only app state (runtime reads) — never doc.transaction/undo/redo, which throw there.
  store.setHistoryHooks({ capture: captureSelection, restore: stashRestore });

  // The HUD buttons exist only in collab mode; their enabled state follows DurableUndoStatus reactively.
  hud.enableHistory({ onUndo: undo, onRedo: redo });
  const paint = (v: DurableUndoStatusValue | undefined): void => {
    hud.setHistoryState(v?.canUndo ?? false, v?.canRedo ?? false);
  };
  world.reactive.observeResource(DurableUndoStatus, paint);
  paint(world.getResource(DurableUndoStatus)); // initial state — registration is a frame boundary, never back-fires (002 §4.1a)
}

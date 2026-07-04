/**
 * The four DOCUMENT mutations that change shape in collab mode — routed through `doc.transaction`
 * (design.md §12) instead of `world` directly. This is the whole of the app's collab write surface;
 * there is NO conflict-handling code here (the framework owns convergence — that is the pitch).
 *
 * The split mirrors §18.3/§18.5's "architecture in miniature":
 *  - **create** and **drag** are GESTURES: their frames are runtime-only (a draft renders, a drag moves
 *    Position every frame), and they seal to the document ONCE at gesture end — a create promotes its
 *    runtime draft into a durable twin; a drag commits its settled Position. A remote peer never sees an
 *    in-flight draft or an un-released drag.
 *  - **delete** and **duplicate** are DISCRETE: one `doc.transaction`, one commit, one undo unit.
 *
 * SELECTION stays runtime-only (the `Selected` tag) in both modes — so where a document spawn must end
 * up selected, the tag is added to the returned handle through `world` AFTER the transaction, never
 * inside it (a `tx.spawn`'d handle is identity-only until it projects, but `world.addTag` places it — so
 * the tag is safe and the components migrate onto it at the next `sync()`).
 */

import type { Entity } from "strata-ecs";
import { Fill, Kind, Label, Position, Selected, Size, Velocity, ZIndex } from "../ecs/schema";
import { stats } from "../app/commands";
import { world } from "../app/worldRef";
import { activeCollab } from "./mode";

/**
 * Promote a freshly-drawn RUNTIME draft (spawned by the draw tool via `world.spawn`, never converged)
 * into its durable document twin: read the draft's final geometry, `tx.spawn` the twin, destroy the
 * draft, and return the twin handle. The create is now ONE document change every peer converges to.
 * Reuses the draft's ZIndex so `stats.zTop` is not double-bumped; `stats.entities` already counted the
 * draft, and the twin replaces it one-for-one, so the tally is left untouched.
 */
export function commitCreate(draft: Entity): Entity | undefined {
  const collab = activeCollab();
  if (collab === null || !world.isAlive(draft)) return undefined;
  const pos = world.read(draft, Position);
  const size = world.read(draft, Size);
  const fill = world.read(draft, Fill);
  const kind = world.read(draft, Kind);
  const z = world.read(draft, ZIndex);
  const label = world.get(draft, Label);
  // Ternary at the CALL (see editorOps.duplicateSelection): the note arm carries a Label, so the two
  // arms are differently-shaped tuples the typed spawn can't unify.
  const twin = collab.doc.transaction((tx) =>
    label
      ? tx.spawn({
          components: [[Position, pos], [Size, size], [Fill, fill], [ZIndex, z], [Kind, kind], [Velocity, {}], [Label, label]],
        })
      : tx.spawn({
          components: [[Position, pos], [Size, size], [Fill, fill], [ZIndex, z], [Kind, kind], [Velocity, {}]],
        }),
  );
  world.destroy(draft);
  return twin;
}

/**
 * Delete the selection through the document (one commit). Only durable handles are destroyed (`keyOf`
 * gate, §17); the despawn cascades connector arrows on EVERY peer with zero app code — the relation-edge
 * cleanup is the framework's, exactly as in local mode.
 */
export function commitDelete(doomed: readonly Entity[]): void {
  const collab = activeCollab();
  if (collab === null) return;
  collab.doc.transaction((tx) => {
    for (const e of doomed) {
      if (collab.doc.keyOf(e) !== undefined) tx.destroy(e);
    }
  });
}

/**
 * Duplicate the selection into the document (one commit), then move the runtime `Selected` tag to the
 * clones. Reads come off the runtime (the current truth the user sees); the spawns are durable; the
 * selection swap is runtime-only. Returns the clone handles.
 */
export function commitDuplicate(originals: readonly Entity[]): Entity[] {
  const collab = activeCollab();
  if (collab === null) return [];
  const clones = collab.doc.transaction((tx) => {
    const out: Entity[] = [];
    for (const e of originals) {
      if (collab.doc.keyOf(e) === undefined || !world.isAlive(e)) continue;
      const pos = world.read(e, Position);
      const size = world.read(e, Size);
      const fill = world.read(e, Fill);
      const kind = world.read(e, Kind);
      const label = world.get(e, Label);
      out.push(
        label
          ? tx.spawn({
              components: [[Position, { x: pos.x + 16, y: pos.y + 16 }], [Size, size], [Fill, fill], [ZIndex, { z: ++stats.zTop }], [Kind, kind], [Velocity, {}], [Label, label]],
            })
          : tx.spawn({
              components: [[Position, { x: pos.x + 16, y: pos.y + 16 }], [Size, size], [Fill, fill], [ZIndex, { z: ++stats.zTop }], [Kind, kind], [Velocity, {}]],
            }),
      );
    }
    return out;
  });
  for (const e of originals) if (world.isAlive(e)) world.removeTag(e, Selected);
  for (const c of clones) world.addTag(c, Selected); // safe on a fresh tx handle — addTag places it
  return clones;
}

/**
 * Seal a finished drag (§18.3). The drag wrote runtime Position every frame; here the settled position
 * is committed to the document ONCE — folding in the sub-frame `residual` the local path would have
 * flushed through the extra `dragEnd` tick, so the committed value EXACTLY equals what the user sees.
 * That equality is load-bearing: `tx.edit().set` writes runtime + baseline + document to the same value,
 * so the own-echo finds `runtime == baseline` and does not strand the cell. Reconcile's drag protection
 * held remote edits to these cells off until this commit — the framework, not the app (§18.5).
 */
export function commitDrag(moved: readonly Entity[], residualDx: number, residualDy: number): void {
  const collab = activeCollab();
  if (collab === null || moved.length === 0) return;
  collab.doc.transaction((tx) => {
    for (const e of moved) {
      if (collab.doc.keyOf(e) === undefined || !world.isAlive(e) || !world.has(e, Position)) continue;
      const p = world.read(e, Position);
      tx.edit(e).set(Position, { x: p.x + residualDx, y: p.y + residualDy });
    }
  });
}

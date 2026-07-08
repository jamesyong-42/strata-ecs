/**
 * Editor verbs. Selection is the `Selected` TAG — the ECS is the single source of truth,
 * there is no mirror set to drift. Every op collects entities first, then mutates through
 * the commands.ts funnel (collect-then-mutate: out-of-tick query walks must not see shape
 * changes mid-iteration, §16). Tags are committed once per verb, never per frame — the
 * marquee's live preview is an app-side array until pointer-up.
 */

import type { Entity } from "@vibecook/strata-ecs";
import { renderable, selectedBoxes } from "../ecs/queries";
import { Fill, Kind, Label, Position, Selected, Size, Velocity, ZIndex } from "../ecs/schema";
import { commitDelete, commitDuplicate } from "../collab/ops";
import { activeCollab } from "../collab/mode";
import { reportSelection } from "../collab/presence";
import { mutate, stats } from "./commands";
import { world } from "./worldRef";

/** Collect the current selection (read-only walk). */
export function selectedEntities(): Entity[] {
  const out: Entity[] = [];
  world.query(selectedBoxes).each((b) => {
    for (const r of b) out.push(b.entity(r));
  });
  return out;
}

export function selectedCount(): number {
  let n = 0;
  world.query(selectedBoxes).each((b) => {
    n += b.count;
  });
  return n;
}

/** Re-derive the shape tally from the live document. The `stats.entities` counter is maintained
 *  incrementally by the create/delete/duplicate verbs, but undo/redo changes the population OUTSIDE those
 *  verbs (the revert projects through the drain), so the count is recomputed once per undo/redo — off the
 *  hot path (undo is a rare user action), which also reconverges any drift from remote peers' edits. */
export function recountShapes(): void {
  let n = 0;
  world.query(renderable).each((b) => {
    n += b.count;
  });
  stats.entities = n;
}

/** Replace (or extend, with `additive`) the selection — one bulk tag commit. Handles may
 *  have been retained across a delete (e.g. a marquee preview when Delete fired mid-sweep),
 *  so the commit re-validates liveness — stale handles are skipped, never thrown on. */
export function setSelection(entities: readonly Entity[], additive = false): void {
  const w = world;
  const prev = additive ? [] : selectedEntities();
  mutate("select", () => {
    for (const e of prev) w.removeTag(e, Selected);
    for (const e of entities) if (w.isAlive(e) && !w.hasTag(e, Selected)) w.addTag(e, Selected);
  });
  reportSelection(selectedEntities()); // collab presence: publish the primary selection (no-op in local mode)
}

export function toggleSelection(e: Entity): void {
  const w = world;
  mutate("toggle-select", () => {
    if (w.hasTag(e, Selected)) w.removeTag(e, Selected);
    else w.addTag(e, Selected);
  });
  reportSelection(selectedEntities());
}

export function clearSelection(): void {
  setSelection([]);
}

/** Delete the selection. Connector arrows touching a deleted shape vanish with ZERO app
 *  code — relation edges cascade-clean on destroy (the framework demo moment). */
export function deleteSelection(): number {
  const doomed = selectedEntities(); // collect BEFORE mutating
  if (activeCollab() !== null) {
    commitDelete(doomed); // the document owns the delete — converges + cascades arrows on every peer
  } else {
    const w = world;
    mutate("delete", () => {
      for (const e of doomed) w.destroy(e);
    });
  }
  stats.entities -= doomed.length;
  return doomed.length;
}

export interface DuplicateResult {
  count: number;
  ms: number;
}

/** Cmd-D: clone every selected shape (+16,+16), selection moves to the clones. The timing
 *  toast this feeds is honest evidence of strata's measured lifecycle win. */
export function duplicateSelection(): DuplicateResult {
  const w = world;
  const originals = selectedEntities();
  const t0 = performance.now();
  if (activeCollab() !== null) {
    // The document owns the clones (durable, converged); selection moves to them runtime-only (§12).
    const collabClones = commitDuplicate(originals);
    stats.entities += collabClones.length;
    return { count: collabClones.length, ms: performance.now() - t0 };
  }
  const clones: Entity[] = [];
  mutate("duplicate", () => {
    for (const e of originals) {
      const pos = w.read(e, Position);
      const size = w.read(e, Size);
      const fill = w.read(e, Fill);
      const kind = w.read(e, Kind);
      const label = w.get(e, Label);
      // Ternary at the CALL, not inside `components`: a value that unions two differently-shaped
      // entry tuples can't be inferred through the typed spawn (it fixes the shape from one arm).
      const clone = label
        ? w.spawn({
            components: [
              [Position, { x: pos.x + 16, y: pos.y + 16 }],
              [Size, size],
              [Fill, fill],
              [ZIndex, { z: ++stats.zTop }],
              [Kind, kind],
              [Velocity, {}],
              [Label, label],
            ],
            tags: [Selected],
          })
        : w.spawn({
            components: [
              [Position, { x: pos.x + 16, y: pos.y + 16 }],
              [Size, size],
              [Fill, fill],
              [ZIndex, { z: ++stats.zTop }],
              [Kind, kind],
              [Velocity, {}],
            ],
            tags: [Selected],
          });
      clones.push(clone);
    }
    for (const e of originals) w.removeTag(e, Selected);
  });
  stats.entities += clones.length;
  return { count: clones.length, ms: performance.now() - t0 };
}

export type ShapeKind = "rect" | "ellipse" | "note";

const CREATE_FILL: Record<ShapeKind, { r: number; g: number; b: number; a: number }> = {
  rect: { r: 88, g: 166, b: 255, a: 210 },
  ellipse: { r: 163, g: 113, b: 247, a: 210 },
  note: { r: 255, g: 223, b: 93, a: 255 },
};

/** Draw-tool entry: spawn a shape at a point (drag-to-size updates it live afterwards). */
export function createShape(kind: ShapeKind, x: number, y: number): Entity {
  const w = world;
  let e!: Entity;
  mutate("create", () => {
    // Ternary at the CALL (see duplicateSelected): the note arm carries a Label, so the two arms
    // are differently-shaped tuples the typed spawn can't unify.
    e =
      kind === "note"
        ? w.spawn({
            components: [
              [Position, { x, y }],
              [Size, { w: 1, h: 1 }],
              [Fill, CREATE_FILL.note],
              [ZIndex, { z: ++stats.zTop }],
              [Kind, { shape: "note" }],
              [Velocity, {}],
              [Label, { text: "new note" }],
            ],
          })
        : w.spawn({
            components: [
              [Position, { x, y }],
              [Size, { w: 1, h: 1 }],
              [Fill, CREATE_FILL[kind]],
              [ZIndex, { z: ++stats.zTop }],
              [Kind, { shape: kind }],
              [Velocity, {}],
            ],
          });
  });
  stats.entities += 1;
  return e;
}

/** Live drag-to-size during creation — whole-value `edit().set` on present components:
 *  the immediate outside-tick value-write surface (§5.6, row 1). */
export function resizeShape(e: Entity, cx: number, cy: number, w2: number, h2: number): void {
  const w = world;
  mutate("size", () => {
    w.edit(e).set(Position, { x: cx, y: cy }).set(Size, { w: Math.max(w2, 1), h: Math.max(h2, 1) });
  });
}

export function destroyShape(e: Entity): void {
  const w = world;
  mutate("destroy", () => w.destroy(e));
  stats.entities -= 1;
}

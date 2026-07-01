/**
 * End-to-end integration test against the PUBLIC `strata` entry (src/index.ts) — a mini
 * infinite-canvas scene. Doubles as a usage example: schema → systems → tick → queries →
 * snapshot, using only the exported surface (no reaching into internals).
 */
import { describe, expect, it } from "vitest";
import {
  Not,
  Related,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineSystem,
  defineTag,
  enumOf,
  field,
  phase,
  type Entity,
} from "./index";

// --- schema (component boundaries chosen for independent editing, §4) ---
const Position = defineComponent<{ x: number; y: number }>("Position", {
  x: field("f32", { default: 0 }),
  y: field("f32", { default: 0 }),
});
const Size = defineComponent<{ w: number; h: number }>("Size", { w: "f32", h: "f32" });
const Fill = defineComponent<{ color: "Red" | "Green" | "Blue" }>("Fill", {
  color: enumOf({ Red: 1, Green: 2, Blue: 3 }),
});
const Velocity = defineComponent<{ x: number; y: number }>("Velocity", { x: "f32", y: "f32" });
const Selected = defineTag("Selected");
const ChildOf = defineRelation("ChildOf", { arity: "one" });
const Grid = defineResource<{ snap: boolean }>("Grid", { snap: "bool" });

// --- systems ---
const Drag = defineSystem(defineQuery([Position, Velocity]), (batch) => {
  const P = batch.col(Position);
  const V = batch.col(Velocity);
  const px = P.x as Float32Array;
  const py = P.y as Float32Array;
  const vx = V.x as Float32Array;
  const vy = V.y as Float32Array;
  for (const r of batch) {
    px[r] += vx[r];
    py[r] += vy[r];
  }
});

// Snap only selected shapes, and only when the grid is on (a runIf on non-query state).
const SnapSelected = defineSystem(
  defineQuery([Position, Selected]),
  (batch, ctx) => {
    for (const r of batch) {
      const e = batch.entity(r);
      const p = ctx.read(e, Position);
      ctx.edit(e).set(Position, { x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 });
    }
  },
  { runIf: (ctx) => ctx.getResource(Grid)?.snap === true },
);

describe("canvas scene (public API)", () => {
  it("runs a pipeline, queries the three buckets, and round-trips through a snapshot", () => {
    const w = createWorld({ name: "canvas" });
    w.setResource(Grid, { snap: true });

    // A frame (parent) with two child shapes; one shape is selected and being dragged.
    const frame = w.spawn({ components: [[Position, { x: 0, y: 0 }], [Size, { w: 200, h: 200 }]] });
    const rect = w.spawn({
      components: [[Position, { x: 3, y: 4 }], [Size, { w: 20, h: 10 }], [Fill, { color: "Red" }], [Velocity, { x: 5, y: 5 }]],
      tags: [Selected],
    });
    const ellipse = w.spawn({
      components: [[Position, { x: 50, y: 60 }], [Size, { w: 15, h: 15 }], [Fill, { color: "Blue" }]],
    });
    w.setRelation(rect, ChildOf, frame);
    w.setRelation(ellipse, ChildOf, frame);

    // One tick: drag integrates velocity, then (in a later phase) snap the selected shape.
    w.tick([phase("input", [Drag]), phase("layout", [SnapSelected])]);

    // rect: (3,4) + (5,5) = (8,9) → snapped to (10,10).
    expect(w.read(rect, Position)).toEqual({ x: 10, y: 10 });
    // ellipse: not selected, not moved.
    expect(w.read(ellipse, Position)).toEqual({ x: 50, y: 60 });

    // Queries across the three buckets.
    const shapes = collect(w, defineQuery([Position, Size]));
    expect(shapes).toHaveLength(3);
    expect(collect(w, defineQuery([Selected]))).toEqual([rect]);
    expect(collect(w, defineQuery([Fill, Not(Selected)]))).toEqual([ellipse]);
    // Children of the frame (concrete-target relation → reverse-index seed).
    expect(collect(w, defineQuery([Position, Related(ChildOf, frame)])).sort()).toEqual([rect, ellipse].sort());

    // Snapshot round-trip through the public save/load surface.
    const w2 = createWorld();
    w2.import(w.export());
    const rect2 = w2.firstOf(defineQuery([Selected])) as Entity;
    const frame2 = w2.firstOf(defineQuery([Size, Not(Fill)])) as Entity; // the frame has Size but no Fill
    expect(w2.read(rect2, Position)).toEqual({ x: 10, y: 10 });
    expect(w2.read(rect2, Fill)).toEqual({ color: "Red" });
    expect(w2.getRelation(rect2, ChildOf)).toBe(frame2); // relation survived the round-trip
    expect(w2.getResource(Grid)).toEqual({ snap: true });
  });

  it("respects a runIf gate on the pipeline", () => {
    const w = createWorld();
    w.setResource(Grid, { snap: false }); // snapping disabled
    const s = w.spawn({ components: [[Position, { x: 3, y: 4 }]], tags: [Selected] });
    w.tick([phase("layout", [SnapSelected])]);
    expect(w.read(s, Position)).toEqual({ x: 3, y: 4 }); // untouched — gate was false
  });
});

function collect(w: ReturnType<typeof createWorld>, q: ReturnType<typeof defineQuery>): Entity[] {
  const out: Entity[] = [];
  w.query(q).each((batch) => {
    for (const r of batch) out.push(batch.entity(r));
  });
  return out;
}

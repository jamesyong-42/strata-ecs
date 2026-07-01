import { bench, describe } from "vitest";
import {
  type Entity,
  createWorld,
  defineComponent,
  defineQuery,
  defineSystem,
  phase,
} from "../src/index";

const Position = defineComponent<{ x: number; y: number }>("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent<{ x: number; y: number }>("Velocity", { x: "f32", y: "f32" });
const Health = defineComponent<{ hp: number }>("Health", { hp: "u16" });

const N = 10_000;

// --- movement hot loop: the core performance thesis (monomorphic, alloc-free per row) ---
{
  const w = createWorld();
  for (let i = 0; i < N; i++) {
    w.spawn({ components: [[Position, { x: i, y: i }], [Velocity, { x: 1, y: -1 }]] });
  }
  const Movement = defineSystem(defineQuery([Position, Velocity]), (b) => {
    const P = b.col(Position);
    const V = b.col(Velocity);
    const px = P.x as Float32Array;
    const py = P.y as Float32Array;
    const vx = V.x as Float32Array;
    const vy = V.y as Float32Array;
    for (const r of b) {
      px[r] += vx[r];
      py[r] += vy[r];
    }
  });
  const pipeline = [phase("sim", [Movement])];

  describe("movement", () => {
    bench(`tick ${N} entities`, () => {
      w.tick(pipeline);
    });
  });
}

// --- query iteration throughput ---
{
  const w = createWorld();
  for (let i = 0; i < N; i++) w.spawn({ components: [[Position, { x: i, y: i }]] });
  const q = defineQuery([Position]);

  describe("query", () => {
    bench(`iterate ${N} entities`, () => {
      let sum = 0;
      w.query(q).each((b) => {
        const px = b.col(Position).x as Float32Array;
        for (const r of b) sum += px[r];
      });
      if (sum < 0) throw new Error("unreachable"); // keep the loop from being optimized away
    });
  });
}

// --- structural throughput: spawn + despawn (balanced, free-list reused) ---
{
  describe("structural", () => {
    const w = createWorld();
    bench("spawn+despawn 1000 entities", () => {
      const handles: Entity[] = [];
      for (let i = 0; i < 1000; i++) {
        handles.push(w.spawn({ components: [[Position, { x: i, y: i }]] }));
      }
      for (const e of handles) w.destroy(e);
    });

    // migration: add then remove a component (round-trips the archetype)
    const mw = createWorld();
    const migrants: Entity[] = [];
    for (let i = 0; i < 1000; i++) migrants.push(mw.spawn({ components: [[Position, { x: i, y: i }]] }));
    bench("add+remove component on 1000 entities", () => {
      for (const e of migrants) mw.addComponent(e, Health, { hp: 1 });
      for (const e of migrants) mw.removeComponent(e, Health);
    });
  });
}

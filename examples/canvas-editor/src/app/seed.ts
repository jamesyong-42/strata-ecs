/**
 * Deterministic clustered board generator. A real-looking brainstorm board — mixed shape
 * kinds, varied sizes/colors, labeled sticky notes, connector arrows inside clusters —
 * never a uniform grid of squares (a grid screams synthetic benchmark; clusters read as a
 * product). Same seed + same ?count= → identical board, byte for byte.
 */

import type { Entity, World } from "strata";
import { ConnectedTo, Fill, Kind, Label, Position, Size, Velocity, ZIndex } from "../ecs/schema";
import { dirty, stats } from "./commands";

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE: readonly [number, number, number][] = [
  [88, 166, 255], [63, 185, 80], [247, 120, 186], [255, 166, 87], [163, 113, 247],
  [86, 212, 221], [227, 179, 65], [219, 109, 40], [110, 118, 129], [121, 192, 255],
  [255, 123, 114], [126, 231, 135],
];
const NOTE_COLORS: readonly [number, number, number][] = [
  [255, 223, 93], [255, 190, 120], [173, 255, 168], [161, 210, 255], [255, 170, 210],
];
const WORDS = [
  "idea", "todo", "ship it", "blocked", "why?", "v2 scope", "user pain", "metrics",
  "later", "keep", "kill", "merge", "split", "risky", "cheap win", "follow up",
  "design", "perf", "sync", "offline", "undo", "canvas", "zoom", "archetype",
];

export interface SeedResult {
  count: number;
  arrows: number;
  ms: number;
}

export function seedBoard(world: World, count: number, seed = 42): SeedResult {
  const rand = rng(seed);
  const gauss = (): number => {
    // Box–Muller (one lobe is plenty here)
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const t0 = performance.now();
  const clusterCount = Math.min(60, Math.max(6, Math.round(count / 400)));
  const spread = Math.sqrt(count) * 55;
  const clusters: { x: number; y: number; sigma: number }[] = [];
  for (let c = 0; c < clusterCount; c++) {
    const angle = rand() * Math.PI * 2;
    const radius = Math.sqrt(rand()) * spread;
    clusters.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      sigma: 260 + rand() * 420,
    });
  }

  // Spawn all shapes, remembering cluster membership for the arrow pass.
  const byCluster: Entity[][] = clusters.map(() => []);
  for (let i = 0; i < count; i++) {
    const ci = Math.floor(rand() * clusterCount);
    const cl = clusters[ci];
    const x = cl.x + gauss() * cl.sigma;
    const y = cl.y + gauss() * cl.sigma;

    const roll = rand();
    const isNote = roll >= 0.8;
    const [r, g, b] = isNote
      ? NOTE_COLORS[Math.floor(rand() * NOTE_COLORS.length)]
      : PALETTE[Math.floor(rand() * PALETTE.length)];
    const w = isNote ? 150 + rand() * 70 : 60 + rand() * 220;
    const h = isNote ? 130 + rand() * 60 : 40 + rand() * 160;

    // Velocity is present from birth (defaults 0,0) so simulate mode is migration-free.
    const e = isNote
      ? world.spawn({
          components: [
            [Position, { x, y }],
            [Size, { w, h }],
            [Fill, { r, g, b, a: 255 }],
            [ZIndex, { z: i }],
            [Kind, { shape: "note" }],
            [Velocity, {}],
            [Label, { text: WORDS[Math.floor(rand() * WORDS.length)] }],
          ],
        })
      : world.spawn({
          components: [
            [Position, { x, y }],
            [Size, { w, h }],
            [Fill, { r, g, b, a: 210 }],
            [ZIndex, { z: i }],
            [Kind, { shape: roll < 0.55 ? "rect" : "ellipse" }],
            [Velocity, {}],
          ],
        });
    byCluster[ci].push(e);
  }

  // Connector arrows inside clusters (~3% of shapes get one) — relations as engine data;
  // deleting either endpoint later makes the arrow vanish with zero cleanup code.
  let arrows = 0;
  for (const members of byCluster) {
    const n = Math.floor(members.length * 0.03);
    for (let k = 0; k < n; k++) {
      const a = members[Math.floor(rand() * members.length)];
      const b = members[Math.floor(rand() * members.length)];
      if (a === b) continue;
      world.addRelation(a, ConnectedTo, b);
      arrows++;
    }
  }

  stats.entities += count;
  stats.zTop = Math.max(stats.zTop, count);
  dirty.doc = true;
  return { count, arrows, ms: performance.now() - t0 };
}

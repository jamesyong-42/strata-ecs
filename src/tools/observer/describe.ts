/**
 * Entity descriptions — how the observer labels and colors entities. Apps know what their
 * entities MEAN (identity read off composition, design.md §18), so `attachObserver` takes a
 * `describe` callback; this default derives a label from the component set and a stable
 * color from its first component name. Descriptions are resolved live while an entity is
 * alive and frozen at death by the recorder (inside `onDestroy`, pre-teardown).
 */

import type { Entity, World } from "../../core/index";
import { componentById, componentCount } from "../../core/schema";

export interface EntityDescription {
  label: string;
  /** CSS color for timeline bars / list accents. */
  color?: string;
  /** Optional state annotation (e.g. a gesture phase) shown next to the label. */
  phase?: string | null;
}

export type DescribeFn = (world: World, e: Entity) => EntityDescription;

/** GitHub-dark friendly palette; picked by hashing the first component's name. */
const PALETTE = [
  "#58a6ff", "#3fb950", "#f778ba", "#ffa657", "#a371f7",
  "#56d4dd", "#e3b341", "#db6d28", "#79c0ff", "#ff7b72",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function colorFor(name: string): string {
  return PALETTE[hash(name) % PALETTE.length];
}

export const defaultDescribe: DescribeFn = (world, e) => {
  const names: string[] = [];
  const n = componentCount();
  for (let cid = 0; cid < n && names.length < 3; cid++) {
    const c = componentById(cid);
    if (c !== undefined && world.has(e, c)) names.push(c.name);
  }
  if (names.length === 0) return { label: "entity", color: "#768390", phase: null };
  return { label: names.join("·"), color: colorFor(names[0]), phase: null };
};

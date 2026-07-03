/**
 * The app's identity-off-composition labeling for the strata-ecs/tools observer — the observer
 * knows HOW to display entities; only the app knows what they mean (design.md §18).
 */

import type { DescribeFn } from "strata-ecs/tools";
import { Kind, Label, Selected } from "../ecs/schema";

const KIND_COLORS: Record<string, string> = {
  rect: "#58a6ff",
  ellipse: "#a371f7",
  note: "#e3b341",
};

export const describeShape: DescribeFn = (world, e) => {
  const kind = world.readField(e, Kind, "shape");
  if (kind === undefined) return { label: "entity", color: "#768390", phase: null };
  const label = kind === "note" ? (world.readField(e, Label, "text") ?? "note") : kind;
  return {
    label,
    color: KIND_COLORS[kind] ?? "#768390",
    phase: world.hasTag(e, Selected) ? "selected" : null,
  };
};

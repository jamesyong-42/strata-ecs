/**
 * Stress: relation storage under heavy fan-out and cascade despawn (design §3.3, §5.5).
 *
 * Probes `RelationStore.clearEntity`'s O(fan-out) cascade and the bidirectional-symmetry invariant:
 * every forward edge has a matching reverse edge, and despawn removes an entity from BOTH
 * directions — with no misattribution to a reused slot.
 */

import { describe, expect, it } from "vitest";
import { type Entity, createWorld, defineRelation } from "../index";
import { scaled } from "./harness";

// Sample indices spread across a range, so symmetry checks stay O(sample) not O(N).
function sample(n: number, count = 32): number[] {
  const step = Math.max(1, Math.floor(n / count));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

describe("stress: relation fan-out + cascade despawn (§3.3/§5.5)", () => {
  it("one target with N incoming edges: reverse index is complete and the cascade unlinks all", () => {
    const N = scaled(5000);
    const Links = defineRelation("StressLinks", { arity: "many" });
    const Parent = defineRelation("StressParent", { arity: "one" });
    const world = createWorld();

    const t = world.spawn();
    const sources: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const s = world.spawn();
      world.addRelation(s, Links, t);
      world.setRelation(s, Parent, t);
      sources.push(s);
    }

    // The reverse index sees every incoming edge, both arities.
    expect(world.getReverse(t, Links).length).toBe(N);
    expect(world.getReverse(t, Parent).length).toBe(N);

    // Forward/reverse symmetry on a sample.
    for (const i of sample(N)) {
      expect(world.getRelations(sources[i], Links)).toEqual([t]);
      expect(world.getRelation(sources[i], Parent)).toBe(t);
      expect(world.getReverse(t, Links)).toContain(sources[i]);
    }

    // Cascade: despawning the shared target must unlink every source's forward edge to it.
    world.destroy(t);
    for (const i of sample(N)) {
      expect(world.getRelations(sources[i], Links)).toEqual([]);
      expect(world.getRelation(sources[i], Parent)).toBeUndefined();
    }

    // A slot reused by a fresh entity must not inherit the dead target's reverse edges (§3.3).
    const t2 = world.spawn();
    expect(world.getReverse(t2, Links)).toEqual([]);
    expect(world.getReverse(t2, Parent)).toEqual([]);
  });

  it("despawning a high-out-degree source unlinks it from every target's reverse index", () => {
    const M = scaled(3000);
    const Links = defineRelation("StressLinks2", { arity: "many" });
    const world = createWorld();

    const hub = world.spawn();
    const targets: Entity[] = [];
    for (let j = 0; j < M; j++) {
      const tg = world.spawn();
      world.addRelation(hub, Links, tg);
      targets.push(tg);
    }
    expect(world.getRelations(hub, Links).length).toBe(M);
    for (const j of sample(M)) expect(world.getReverse(targets[j], Links)).toContain(hub);

    world.destroy(hub);
    for (const j of sample(M)) expect(world.getReverse(targets[j], Links)).toEqual([]);
  });
});

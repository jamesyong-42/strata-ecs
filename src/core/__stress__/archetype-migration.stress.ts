/**
 * Stress: the archetype index and the migration machinery under load.
 *
 *  3. Archetype explosion — thousands of distinct signatures; dedup + cached-query correctness.
 *  5. String-column leak hunt — the null-capacity invariant after every structural op.
 *  7. Archetype ping-pong — back-pointer symmetry + value preservation across A→B→A churn.
 */

import { describe, expect, it } from "vitest";
import {
  Any,
  type Component,
  type ComponentEntry,
  type Entity,
  Not,
  createWorld,
  defineComponent,
  defineQuery,
  field,
} from "../index";
import { assertPlacementConsistent, assertStringColumnsClean } from "./invariants";
import { scaled } from "./harness";

describe("stress: archetype explosion (dedup + cached-query correctness, §3.1/§6)", () => {
  it("one entity per distinct component subset yields exactly that many archetypes, with correct query matches", () => {
    const K = 12; // 2^12-1 = 4095 distinct non-empty signatures (fixed: this ceiling is exponential)
    const world = createWorld();
    const comps: Component<{ v: number }>[] = [];
    for (let i = 0; i < K; i++) {
      comps.push(defineComponent(`AX${i}`, { v: field("u32", { default: 0 }) }));
    }

    // Register the cached queries BEFORE any archetype exists, so each archetype creation runs the
    // observer's per-query re-test (the O(Q)-per-archetype path we want to exercise).
    const qReq0 = defineQuery([comps[0]]);
    const qReq01 = defineQuery([comps[0], comps[1]]);
    const qExcl = defineQuery([comps[0], Not(comps[1])]);
    const qAny = defineQuery([Any(comps[2], comps[3])]);
    const qMixed = defineQuery([comps[4], Not(comps[5]), Any(comps[6], comps[7])]);

    const maskOf = new Map<Entity, number>();
    for (let mask = 1; mask < 1 << K; mask++) {
      const parts: ComponentEntry[] = [];
      for (let i = 0; i < K; i++) if (mask & (1 << i)) parts.push([comps[i], { v: mask }]);
      // A dynamically-built ComponentEntry[] can't satisfy the typed spawn tuple — go through the
      // loose store surface (World.spawn only delegates to it), the same seam this harness already uses.
      maskOf.set(world.runtime.spawn({ components: parts }), mask);
    }

    const bit = (mask: number, i: number): boolean => (mask & (1 << i)) !== 0;
    const collect = (q: ReturnType<typeof defineQuery>): Set<number> => {
      const out = new Set<number>();
      world.query(q).each((b) => {
        for (const r of b) out.add(maskOf.get(b.entity(r)) as number);
      });
      return out;
    };
    const expected = (pred: (mask: number) => boolean): Set<number> => {
      const out = new Set<number>();
      for (let mask = 1; mask < 1 << K; mask++) if (pred(mask)) out.add(mask);
      return out;
    };

    // Each cached query's live match set must equal the brute-force predicate over all signatures.
    expect(collect(qReq0)).toEqual(expected((m) => bit(m, 0)));
    expect(collect(qReq01)).toEqual(expected((m) => bit(m, 0) && bit(m, 1)));
    expect(collect(qExcl)).toEqual(expected((m) => bit(m, 0) && !bit(m, 1)));
    expect(collect(qAny)).toEqual(expected((m) => bit(m, 2) || bit(m, 3)));
    expect(collect(qMixed)).toEqual(
      expected((m) => bit(m, 4) && !bit(m, 5) && (bit(m, 6) || bit(m, 7))),
    );

    // Exactly one archetype per distinct signature, plus the ever-present empty archetype. No dupes.
    const archCount = world.runtime.archetypes().filter((a) => a !== undefined).length;
    expect(archCount).toBe((1 << K) - 1 + 1);
  });
});

describe("stress: string-column leak hunt (null-capacity invariant, §3.4/§5.5)", () => {
  it("holds every string cell above count === null across add/write/remove/destroy churn", () => {
    const N = scaled(400);
    const S = defineComponent("LeakText", { text: "string" });
    const T = defineComponent("LeakToggle", { n: "u32" });
    const world = createWorld();
    const big = (i: number): string => `blob-${"x".repeat(48)}-${i}`;

    const ents: Entity[] = [];
    for (let i = 0; i < N; i++) ents.push(world.spawn({ components: [[S, { text: big(i) }]] }));
    assertStringColumnsClean(world);

    // Add T to every entity: [S] → [S,T], swap-popping the source column on each migration.
    for (let i = 0; i < N; i++) {
      world.addComponent(ents[i], T, { n: i });
      assertStringColumnsClean(world);
    }
    // Overwrite every string with a fresh distinct value (old strings must not linger above count).
    for (let i = 0; i < N; i++) world.edit(ents[i]).set(S, { text: big(i + 1_000_000) });
    assertStringColumnsClean(world);
    // Remove T from every entity: [S,T] → [S], migrating back and swap-popping again.
    for (let i = 0; i < N; i++) {
      world.removeComponent(ents[i], T);
      assertStringColumnsClean(world);
    }
    // Destroy everything, checking after each despawn (bare-pop path must null the vacated cell).
    for (let i = 0; i < N; i++) {
      world.destroy(ents[i]);
      assertStringColumnsClean(world);
    }
    expect(world.runtime.liveCount()).toBe(0);
  });
});

describe("stress: archetype ping-pong (back-pointer symmetry + value preservation, §5.5)", () => {
  it("preserves every entity's carried values across many A→B→A migrations", () => {
    const N = scaled(500);
    const rounds = scaled(20);
    const P = defineComponent("PingPos", { x: "f64", y: "f64" });
    const H = defineComponent("PingHp", { hp: "u32" });
    const world = createWorld();

    const ents: Entity[] = [];
    for (let i = 0; i < N; i++) ents.push(world.spawn({ components: [[P, { x: i, y: i * 2 }]] }));

    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < N; i++) world.addComponent(ents[i], H, { hp: round });
      assertPlacementConsistent(world);
      for (let i = 0; i < N; i++) world.removeComponent(ents[i], H);
      assertPlacementConsistent(world);
      // A wrong row pointer after swap-pop would surface here as a mismatched read.
      for (let i = 0; i < N; i++) expect(world.read(ents[i], P)).toEqual({ x: i, y: i * 2 });
    }
    assertStringColumnsClean(world);
  });
});

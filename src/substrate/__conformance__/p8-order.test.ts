/**
 * P8 — ordered relations, the Loro-free subset (plan-ordered-relations §4.4; M2).
 *
 * The doc-order truth here is the `BaselineSnapshot` (the ladder oracle implements
 * {@link OrderSource}); the runtime side is driven through the `Projector` exactly as the binding
 * drives it: edge facts via `applyRelationSet` (whose ordered arm carries the D7 COROLLARY —
 * every ordered edge fact re-derives BOTH affected parents), pure reorders via `applyOrder`
 * (payload-free re-read). Properties:
 *
 *   P8.1 EDGE AUTHORITY — hostile/stale/duplicate sequence entries (foreign keys, dead children,
 *        the parent itself, duplicates) NEVER create membership, never throw, and D7-filter away.
 *   P8.2 CROSS-PATH DETERMINISM — incremental application, wholesale re-derivation, and a
 *        fresh-projector "bootstrap" replay (shuffled edge order) read the IDENTICAL effective
 *        order from the same converged state.
 *   P8.3 RANDOM SOAK — seeded random op sequences (placed sets, moves, removes, despawns of
 *        children AND parents) hold runtime-vs-D7(reference) equality after EVERY op.
 *   P8.4 A pure order fact for an unknown parent is INERT — it never mints identity.
 *   P8.5 normalizeBatch — order-invalidate dedupes last-wins to ≤1 per (parent, rel) per segment
 *        and is erased by the parent's despawn dominance.
 *
 * Concurrent-move convergence (P8.3/P8.7 of the plan) is deliberately ABSENT here: those
 * semantics are loro's, pinned by the M0 probe and re-pinned through the adapter in M3.
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../../core/world";
import type { Entity } from "../../core/entity";
import { type EntityKey, entityKey } from "../../core/field";
import { defineRelation } from "../../core/schema";
import { Related, defineQuery } from "../../core/query";
import { Projector } from "../projector";
import { BaselineSnapshot } from "../baseline";
import { normalizeBatch } from "../normalize";
import type { ChangeEvent, OrderPlaceKey, OrderSource } from "../types";
import { mulberry32, pick, randInt, type Rng } from "./harness";

const Stack = defineRelation("P8Stack", { arity: "one", ordered: true });

const K = (s: string): EntityKey => entityKey(s);

function setup() {
  const world = createWorld();
  const rt = world.runtime;
  let mint = 0;
  const proj = new Projector(rt, () => K(`p8mint-${mint++}`));
  const base = new BaselineSnapshot();
  proj.setOrderSource(base);
  return { rt, proj, base };
}

type Setup = ReturnType<typeof setup>;

/** The test's own membership truth: child → parent. */
type Edges = Map<EntityKey, EntityKey>;

/** Reference D7: sequence entries that are live children (first wins) ++ rest ascending. */
function d7(base: BaselineSnapshot, parent: EntityKey, edges: Edges): EntityKey[] {
  const children = [...edges].filter(([, p]) => p === parent).map(([c]) => c);
  const set = new Set(children);
  const raw = base.readOrder(parent, Stack) ?? [];
  const seen = new Set<EntityKey>();
  const out: EntityKey[] = [];
  for (const k of raw) {
    if (!set.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  const rest = children.filter((c) => !seen.has(c)).sort();
  return [...out, ...rest];
}

/** The runtime's effective order for `parent`, mapped back to keys. */
function runtimeOrder(s: Setup, parent: EntityKey): EntityKey[] {
  const h = s.proj.handleFor(parent);
  if (h === undefined) return [];
  return s.rt.getReverse(h, Stack).map((c: Entity) => {
    const k = s.proj.keyFor(c);
    expect(k).toBeDefined(); // every projected child is keyed
    return k as EntityKey;
  });
}

function assertParent(s: Setup, parent: EntityKey, edges: Edges): void {
  const expected = d7(s.base, parent, edges);
  const got = runtimeOrder(s, parent);
  expect(got).toEqual(expected); // order AND membership (edge authority) in one comparison
}

/**
 * HARNESS ARTIFACT, not the real drain order (rev-m2 finding 2): reconcile applies projector
 * FIRST, baseline second (binding.ts relation-set arm). Baseline-first here SIMULATES the real
 * M3 reality that the projector's OrderSource is the doc's CONVERGED read — already final when
 * the projector applies. The load-bearing constraint this encodes: **M3 must wire
 * `setOrderSource` to the adapter's converged read, NEVER the binding baseline** (stale under
 * projector-first, and reconcile writes it placeless — stranded order forever).
 */
function applySet(s: Setup, edges: Edges, child: EntityKey, parent: EntityKey, place?: OrderPlaceKey): void {
  s.base.setRelationPlaced(child, Stack, parent, place);
  edges.set(child, parent);
  s.proj.applyRelationSet(child, Stack, parent); // ordered arm re-derives both parents (D7 corollary)
}

function applyMove(s: Setup, child: EntityKey, place: OrderPlaceKey, edges: Edges): void {
  if (!s.base.moveRelationPlaced(child, Stack, place)) return;
  const parent = edges.get(child);
  if (parent !== undefined) s.proj.applyOrder(parent, Stack); // a pure reorder ships as an order cell
}

describe("P8.1 — edge authority under hostile sequences", () => {
  it("foreign keys, duplicates, dead children, and the parent itself filter away; membership never changes", () => {
    const s = setup();
    const edges: Edges = new Map();
    const [p, a, b, c] = ["P", "a", "b", "c"].map(K);
    for (const child of [a, b, c]) applySet(s, edges, child, p);
    expect(runtimeOrder(s, p)).toEqual([a, b, c]);

    // A hostile source replaces the baseline: junk of every D7-filterable kind.
    const hostile: OrderSource = {
      readOrder: () => [K("zz-foreign"), c, c, p, K("dead"), a],
    };
    s.proj.setOrderSource(hostile);
    s.proj.applyOrder(p, Stack);
    // Filtered: [c, a] survive from the junk (first occurrence), b appends via completion.
    expect(runtimeOrder(s, p)).toEqual([c, a, b]);
    // Membership untouched — no phantom "zz-foreign"/"dead" children were minted or attached.
    expect(s.proj.handleFor(K("zz-foreign"))).toBeUndefined();
    expect(s.proj.handleFor(K("dead"))).toBeUndefined();
  });
});

describe("P8.2 — cross-path determinism", () => {
  it("incremental, wholesale, and shuffled bootstrap replays read the identical effective order", () => {
    // Converged truth: 6 children with a non-trivial order.
    const truth = setup();
    const edges: Edges = new Map();
    const p = K("P");
    const kids = ["k0", "k1", "k2", "k3", "k4", "k5"].map(K);
    for (const c of kids) applySet(truth, edges, c, p);
    applyMove(truth, kids[3]!, "first", edges);
    applyMove(truth, kids[0]!, { after: kids[5]! }, edges);
    applySet(truth, edges, kids[2]!, p, { before: kids[3]! });
    const expected = runtimeOrder(truth, p);
    expect(expected).toHaveLength(6);

    // Path B — wholesale: fresh runtime, edges applied placeless in DEFINITION order, one applyOrder.
    const b = setup();
    b.proj.setOrderSource(truth.base);
    for (const c of kids) b.proj.applyRelationSet(c, Stack, p);
    b.proj.applyOrder(p, Stack);
    expect(runtimeOrder({ ...b, base: truth.base }, p)).toEqual(expected);

    // Path C — bootstrap: fresh projector, edges in SHUFFLED arrival order, no explicit order cell
    // at all (the edge-implied re-derivation must land the same place).
    const rng = mulberry32(0xc0ffee);
    const shuffled = [...kids].sort(() => (rng() < 0.5 ? -1 : 1));
    const c2 = setup();
    c2.proj.setOrderSource(truth.base);
    for (const k of shuffled) c2.proj.applyRelationSet(k, Stack, p);
    expect(runtimeOrder({ ...c2, base: truth.base }, p)).toEqual(expected);
  });
});

describe("P8.3 — random soak (seeded)", () => {
  for (const seed of [7, 1234, 99991]) {
    it(`seed ${seed}: runtime matches reference D7 after every op`, () => {
      const s = setup();
      const edges: Edges = new Map();
      const rng: Rng = mulberry32(seed);
      const parents = ["PA", "PB", "PC"].map(K);
      const children = Array.from({ length: 12 }, (_, i) => K(`c${i}`));
      const places = (anchorPool: EntityKey[]): OrderPlaceKey[] => [
        "first",
        "last",
        { before: pick(rng, anchorPool) },
        { after: pick(rng, anchorPool) },
      ];

      for (let op = 0; op < 300; op++) {
        const roll = randInt(rng, 100);
        if (roll < 45) {
          // placed set / reparent
          const child = pick(rng, children);
          const parent = pick(rng, parents);
          applySet(s, edges, child, parent, pick(rng, places(children)));
        } else if (roll < 70) {
          const child = pick(rng, children);
          applyMove(s, child, pick(rng, places(children)), edges);
        } else if (roll < 80) {
          // remove the edge
          const child = pick(rng, children);
          if (edges.has(child)) {
            s.base.removeRelation(child, Stack);
            s.proj.removeRelation(child, Stack);
            edges.delete(child);
          }
        } else if (roll < 90) {
          // despawn a child (three-part on baseline; projector remove destroys + splices)
          const child = pick(rng, children);
          s.base.despawn(child);
          s.proj.remove(child);
          edges.delete(child);
        } else {
          // despawn a parent: children's edges die with it on BOTH sides
          const parent = pick(rng, parents);
          s.base.despawn(parent);
          s.proj.remove(parent);
          for (const [c, pp] of [...edges]) if (pp === parent) edges.delete(c);
        }
        for (const parent of parents) assertParent(s, parent, edges);
      }
    });
  }
});

describe("P8.6 — remote pure reorder wakes reactivity (rev-m2 finding 1)", () => {
  it("applyOrder wakes an observeQuery naming the relation, exactly like a local moveRelation", () => {
    const world = createWorld();
    const rt = world.runtime;
    let mint = 0;
    const proj = new Projector(rt, () => K(`p86-${mint++}`));
    const base = new BaselineSnapshot();
    proj.setOrderSource(base);

    const [p, a, b] = ["P", "a", "b"].map(K);
    base.setRelationPlaced(a, Stack, p);
    base.setRelationPlaced(b, Stack, p);
    proj.applyRelationSet(a, Stack, p);
    proj.applyRelationSet(b, Stack, p);

    const q = defineQuery([Related(Stack)]);
    let fires = 0;
    world.reactive.observeQuery(q, () => {
      fires++;
    });
    world.reactive.notify();
    const baseFires = fires;

    base.moveRelationPlaced(b, Stack, "first"); // the converged doc changed…
    proj.applyOrder(p, Stack); // …and the pure order fact drains
    world.reactive.notify();
    expect(fires).toBeGreaterThan(baseFires); // remote reorder repaints, same as local (§3.4)
  });
});

describe("P8.7 — null OrderSource (the shipping M1→M3 window; rev-m2 finding 3)", () => {
  it("edge facts with no order capability re-derive to the deterministic completion order, arrival-order-independent", () => {
    const run = (arrival: EntityKey[]): EntityKey[] => {
      const s = setup();
      s.proj.setOrderSource(null); // the REAL M2 shipping configuration — no adapter emits order yet
      const p = K("P");
      for (const c of arrival) s.proj.applyRelationSet(c, Stack, p);
      return runtimeOrder(s, p);
    };
    const kids = ["kD", "kA", "kC", "kB"].map(K);
    const sorted = [...kids].sort();
    expect(run(kids)).toEqual(sorted); // EntityKey-ascending, NOT arrival order
    expect(run([...kids].reverse())).toEqual(sorted); // two peers, two arrival orders, one result
  });
});

describe("P8.8 — reparent-loser stale entry (the plan's §4.4.4 race shape)", () => {
  it("a raw entry for a child that is ALIVE but edged to another parent filters away without touching membership", () => {
    const s = setup();
    const edges: Edges = new Map();
    const [p1, p2, x, y] = ["P1", "P2", "x", "y"].map(K);
    applySet(s, edges, x, p1);
    applySet(s, edges, y, p1);
    applySet(s, edges, x, p2); // x reparents away; P1's baseline sequence spliced it…
    // …but a CONVERGED doc can still hold x in P1's list (the reparent LOSER's entry). Simulate:
    const stale: OrderSource = { readOrder: (k) => (k === p1 ? [x, y] : undefined) };
    s.proj.setOrderSource(stale);
    s.proj.applyOrder(p1, Stack);
    expect(runtimeOrder(s, p1)).toEqual([y]); // x filtered — alive elsewhere, not P1's child
    expect(runtimeOrder(s, p2)).toEqual([x]); // and untouched where it actually lives
  });
});

describe("P8.4 — unknown-parent order facts are inert", () => {
  it("applyOrder for an unbound key mints nothing and changes nothing", () => {
    const s = setup();
    const ghost = K("never-projected");
    s.proj.applyOrder(ghost, Stack);
    expect(s.proj.handleFor(ghost)).toBeUndefined();
  });
});

describe("P8.5 — normalizeBatch over order cells", () => {
  const p = K("P");
  const q = K("Q");
  const ord = (key: EntityKey): ChangeEvent => ({ kind: "order-invalidate", key, rel: Stack, origin: "remote" });

  it("dedupes to at most one order cell per (parent, rel), last wins, order preserved", () => {
    const out = normalizeBatch([ord(p), ord(q), ord(p), ord(p)]);
    expect(out.filter((e) => e.kind === "order-invalidate" && e.key === p)).toHaveLength(1);
    expect(out.filter((e) => e.kind === "order-invalidate" && e.key === q)).toHaveLength(1);
    // Survivors keep batch order: q's (index 1) precedes p's LAST (index 3).
    expect(out.map((e) => (e.kind === "order-invalidate" ? e.key : "?"))).toEqual([q, p]);
  });

  it("a parent's despawn dominates its pending order-invalidations; a respawn segment starts clean", () => {
    const spawnP: ChangeEvent = { kind: "spawn", key: p, origin: "remote" };
    const despawnP: ChangeEvent = { kind: "despawn", key: p, origin: "remote" };
    const out = normalizeBatch([spawnP, ord(p), despawnP]);
    expect(out.some((e) => e.kind === "order-invalidate")).toBe(false);
    // Respawn after the barrier keeps a FRESH order fact.
    const out2 = normalizeBatch([spawnP, ord(p), despawnP, spawnP, ord(p)]);
    expect(out2.filter((e) => e.kind === "order-invalidate")).toHaveLength(1);
    expect(out2[out2.length - 1]!.kind).toBe("order-invalidate");
  });
});

/**
 * Ordered relations — M1 runtime core (plan-ordered-relations §3).
 *
 * The contract under test: `defineRelation(name, { arity: "one", ordered: true })` makes each
 * parent's reverse set a sibling SEQUENCE. `getReverse` order IS the API; placement is
 * `"first" | "last" | {before} | {after}` with DEV-warn + "last" fallback on a racing anchor;
 * `moveRelation` reorders in place; `orderStamp` is a pull-only per-parent version armed on
 * first read; reorders bump the relation's membership stamp (legal over-fire, §3.4); the JSON
 * snapshot round-trips order and D7-completes legacy/partial sections deterministically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Related,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineSystem,
  phase,
  defineTag,
} from "./index";
import type { Entity, World } from "./index";

// One module-level schema (process-global registries; the shared test discipline).
const Pos = defineComponent("ORPos", { x: "f32" });
const Mark = defineTag("ORMark");
const Stack = defineRelation("ORStack", { arity: "one", ordered: true });
const Plain = defineRelation("ORPlain", { arity: "one" });
const allQ = defineQuery([Pos]);

function spawn(world: World, x = 0): Entity {
  return world.spawn({ components: [[Pos, { x }]] });
}

/** Parent + n children appended in spawn order; returns [parent, ...children]. */
function family(world: World, n: number): Entity[] {
  const parent = spawn(world, -1);
  const out = [parent];
  for (let i = 0; i < n; i++) {
    const c = spawn(world, i);
    world.setRelation(c, Stack, parent);
    out.push(c);
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("schema", () => {
  it("ordered defaults to false; the flag is carried on the handle", () => {
    expect(Plain.ordered).toBe(false);
    expect(Stack.ordered).toBe(true);
  });

  it("ordered + arity 'many' is rejected at definition time", () => {
    expect(() => defineRelation("ORBadMany", { arity: "many", ordered: true })).toThrow(/arity "one"/);
  });
});

describe("sibling sequences", () => {
  it("default placement is 'last' — getReverse returns spawn/set order", () => {
    const world = createWorld();
    const [p, a, b, c] = family(world, 3);
    expect(world.getReverse(p, Stack)).toEqual([a, b, c]);
  });

  it("'first' and before/after anchors position exactly", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    const c = spawn(world);
    world.setRelation(c, Stack, p, "first");
    expect(world.getReverse(p, Stack)).toEqual([c, a, b]);
    const d = spawn(world);
    world.setRelation(d, Stack, p, { before: b });
    expect(world.getReverse(p, Stack)).toEqual([c, a, d, b]);
    const e = spawn(world);
    world.setRelation(e, Stack, p, { after: c });
    expect(world.getReverse(p, Stack)).toEqual([c, e, a, d, b]);
  });

  it("idempotent re-set keeps position; re-set WITH a place moves (§3.3)", () => {
    const world = createWorld();
    const [p, a, b, c] = family(world, 3);
    world.setRelation(b, Stack, p); // no place → keep
    expect(world.getReverse(p, Stack)).toEqual([a, b, c]);
    world.setRelation(b, Stack, p, "last"); // place → move
    expect(world.getReverse(p, Stack)).toEqual([a, c, b]);
  });

  it("reparent leaves the old sequence and enters the new one at the given place", () => {
    const world = createWorld();
    const [p1, a, b] = family(world, 2);
    const [p2, x] = family(world, 1);
    world.setRelation(a, Stack, p2, "first");
    expect(world.getReverse(p1, Stack)).toEqual([b]);
    expect(world.getReverse(p2, Stack)).toEqual([a, x]);
  });

  it("a racing/foreign anchor degrades to 'last' with a DEV warning — never a throw", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    const stranger = spawn(world); // not a sibling
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = spawn(world);
    world.setRelation(c, Stack, p, { before: stranger });
    expect(world.getReverse(p, Stack)).toEqual([a, b, c]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not a sibling"));
  });

  it("unordered relations ignore a place with a DEV warning and keep set-iteration semantics", () => {
    const world = createWorld();
    const p = spawn(world);
    const a = spawn(world);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    world.setRelation(a, Plain, p, "first");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not an ordered relation"));
    expect(world.getRelation(a, Plain)).toBe(p);
  });
});

describe("moveRelation", () => {
  it("reorders within the current parent", () => {
    const world = createWorld();
    const [p, a, b, c] = family(world, 3);
    world.moveRelation(c, Stack, "first");
    expect(world.getReverse(p, Stack)).toEqual([c, a, b]);
    world.moveRelation(a, Stack, { after: b });
    expect(world.getReverse(p, Stack)).toEqual([c, b, a]);
  });

  it("no edge → DEV-warn + no-op; unordered relation → throws (local API misuse)", () => {
    const world = createWorld();
    const loner = spawn(world);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    world.moveRelation(loner, Stack, "first"); // no edge
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("no edge"));
    expect(() => world.moveRelation(loner, Plain, "first")).toThrow(/ordered relation/);
  });

  it("an anchor that is the moved entity itself degrades to 'last' (position indeterminate mid-move)", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    world.moveRelation(a, Stack, { after: a });
    expect(world.getReverse(p, Stack)).toEqual([b, a]);
  });
});

describe("lifecycle", () => {
  it("despawning a child splices it out; the rest keep their order", () => {
    const world = createWorld();
    const [p, a, b, c] = family(world, 3);
    world.destroy(b);
    expect(world.getReverse(p, Stack)).toEqual([a, c]);
  });

  it("despawning the parent clears the sequence with the edges", () => {
    const world = createWorld();
    const [p, a] = family(world, 1);
    world.destroy(p);
    expect(world.getRelation(a, Stack)).toBeUndefined();
    const p2 = spawn(world);
    world.setRelation(a, Stack, p2);
    expect(world.getReverse(p2, Stack)).toEqual([a]);
  });

  it("removeRelation splices; world.reset clears sequences and stamps", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    world.removeRelation(a, Stack);
    expect(world.getReverse(p, Stack)).toEqual([b]);
    world.reset();
    expect(world.orderStamp(p, Stack)).toBe(0);
  });
});

describe("orderStamp", () => {
  it("first read arms; mutations then bump monotonically, per parent", () => {
    const world = createWorld();
    const [p1, a] = family(world, 1);
    const [p2] = family(world, 1);
    expect(world.orderStamp(p1, Stack)).toBe(0); // arms
    const s0 = world.orderStamp(p2, Stack);
    world.moveRelation(a, Stack, "first");
    const s1 = world.orderStamp(p1, Stack);
    expect(s1).toBeGreaterThan(0);
    expect(world.orderStamp(p2, Stack)).toBe(s0); // untouched parent unchanged
    const c = spawn(world);
    world.setRelation(c, Stack, p1);
    expect(world.orderStamp(p1, Stack)).toBeGreaterThan(s1);
  });

  it("a child despawn bumps its parent's stamp (the sequence changed)", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    world.orderStamp(p, Stack); // arm
    world.destroy(a);
    expect(world.orderStamp(p, Stack)).toBeGreaterThan(0);
    expect(world.getReverse(p, Stack)).toEqual([b]);
  });

  it("a destroyed parent's stamps are pruned — no monotonic retention under parent churn (rev-m1-core f1)", () => {
    const world = createWorld();
    const [p, a] = family(world, 2);
    world.orderStamp(p, Stack); // arm
    world.moveRelation(a, Stack, "last");
    expect(world.orderStamp(p, Stack)).toBeGreaterThan(0);
    world.destroy(p);
    expect(world.orderStamp(p, Stack)).toBe(0); // entry pruned with the parent
  });

  it("orderStamp on an unordered relation DEV-warns, reads 0, and does NOT arm collection (rev-m1-core f2)", () => {
    const world = createWorld();
    const [p, a] = family(world, 1);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(world.orderStamp(p, Plain)).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not an ordered relation"));
    world.moveRelation(a, Stack, "first"); // would bump IF the misuse call had armed
    expect(world.orderStamp(p, Stack)).toBe(0); // first ORDERED read arms only now
  });

  it("a reparent bumps BOTH parents' stamps", () => {
    const world = createWorld();
    const [p1, a] = family(world, 1);
    const [p2] = family(world, 1);
    world.orderStamp(p1, Stack); // arm
    const before1 = world.orderStamp(p1, Stack);
    const before2 = world.orderStamp(p2, Stack);
    world.setRelation(a, Stack, p2);
    expect(world.orderStamp(p1, Stack)).toBeGreaterThan(before1);
    expect(world.orderStamp(p2, Stack)).toBeGreaterThan(before2);
  });
});

describe("ctx paths (command buffer)", () => {
  it("ctx.setRelation with a place and ctx.moveRelation apply at the flush, in order", () => {
    const world = createWorld();
    const [p, a, b] = family(world, 2);
    const c = spawn(world);
    const q = defineQuery([Pos]);
    let ran = false;
    const sys = defineSystem(q, (_b, ctx) => {
      if (ran) return;
      ran = true;
      ctx.setRelation(c, Stack, p, "first");
      ctx.moveRelation(a, Stack, "last");
    });
    world.tick([phase("t", [sys])]);
    expect(world.getReverse(p, Stack)).toEqual([c, b, a]);
  });

  it("ctx.moveRelation on an unordered relation throws at ENQUEUE (misuse caught early)", () => {
    const world = createWorld();
    const e = spawn(world);
    const q = defineQuery([Pos]);
    const sys = defineSystem(q, (_b, ctx) => {
      expect(() => ctx.moveRelation(e, Plain, "first")).toThrow(/ordered relation/);
    });
    world.tick([phase("t", [sys])]);
  });
});

describe("reactivity (§3.4 — reorder is a legal over-fire on watches naming the relation)", () => {
  it("a pure reorder wakes an observeQuery whose grammar names the relation", () => {
    const world = createWorld();
    const [_p, a] = family(world, 2);
    const q = defineQuery([Pos, Related(Stack)]);
    let fires = 0;
    world.reactive.observeQuery(q, () => {
      fires++;
    });
    world.reactive.notify();
    const base = fires;
    world.moveRelation(a, Stack, "last");
    world.reactive.notify();
    expect(fires).toBeGreaterThan(base);
  });

  it("a reorder does NOT wake an unrelated component watch (the quiescent path holds)", () => {
    const world = createWorld();
    const [_p, a] = family(world, 2);
    const other = spawn(world, 99);
    world.addTag(other, Mark);
    const q = defineQuery([Pos, Mark]);
    let fires = 0;
    world.reactive.observeQuery(q, () => {
      fires++;
    });
    world.reactive.notify();
    const base = fires;
    world.moveRelation(a, Stack, "first");
    world.reactive.notify();
    expect(fires).toBe(base);
  });
});

describe("JSON snapshot (§3.5)", () => {
  it("round-trips sibling order exactly, including non-spawn order", () => {
    const world = createWorld();
    const [p, a, b, c] = family(world, 3);
    world.moveRelation(a, Stack, "last"); // [b, c, a]
    world.moveRelation(c, Stack, "first"); // [c, b, a]
    expect(world.getReverse(p, Stack)).toEqual([c, b, a]);
    const xs = world.getReverse(p, Stack).map((e) => world.readField(e, Pos, "x"));

    const fresh = createWorld();
    fresh.import(world.export());
    const parents = fresh.entities(allQ).filter((e) => fresh.getReverse(e, Stack).length > 0);
    expect(parents.length).toBe(1);
    const got = fresh.getReverse(parents[0]!, Stack).map((e) => fresh.readField(e, Pos, "x"));
    expect(got).toEqual(xs); // [2, 1, 0]
  });

  it("a legacy snapshot (order section stripped) imports with the deterministic completion order", () => {
    const world = createWorld();
    const [p, , , ] = family(world, 3);
    world.moveRelation(world.getReverse(p, Stack)[0]!, Stack, "last");
    const json = JSON.parse(new TextDecoder().decode(world.export())) as Record<string, unknown>;
    expect(json.order).toBeDefined();
    delete json.order;
    const bytes = new TextEncoder().encode(JSON.stringify(json));

    const fresh = createWorld();
    fresh.import(bytes);
    const parent = fresh.entities(allQ).find((e) => fresh.getReverse(e, Stack).length === 3)!;
    // Completion order = ascending snapshot id = original spawn order [0, 1, 2].
    expect(fresh.getReverse(parent, Stack).map((e) => fresh.readField(e, Pos, "x"))).toEqual([0, 1, 2]);
  });

  it("a partial/stale order section is D7-completed: foreign + duplicate entries drop, missing children append by id", () => {
    const world = createWorld();
    const [_p, , b] = family(world, 3);
    world.destroy(b); // exercise export skipping nothing (b gone before export)
    const json = JSON.parse(new TextDecoder().decode(world.export())) as {
      order?: Record<string, Record<string, number[]>>;
      entities: Array<{ id: number; relations: Record<string, number> }>;
    };
    const [pid, list] = Object.entries(json.order!.ORStack)[0]!;
    // Tamper: keep only the LAST child in the section, duplicated, plus the parent id itself (foreign).
    json.order!.ORStack[pid] = [list[list.length - 1]!, list[list.length - 1]!, Number(pid)];
    const fresh = createWorld();
    fresh.import(new TextEncoder().encode(JSON.stringify(json)));
    const parent = fresh.entities(allQ).find((e) => fresh.getReverse(e, Stack).length === 2)!;
    const got = fresh.getReverse(parent, Stack).map((e) => fresh.readField(e, Pos, "x"));
    // Section pinned the last child (x=2) first; the remaining child (x=0) appends by id.
    expect(got).toEqual([2, 0]);
  });

  it("a malformed order section fails CLOSED on replace:true — the live world is untouched", () => {
    const world = createWorld();
    family(world, 2);
    const bytes = world.export();
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    (json as { order: unknown }).order = { ORStack: { "9999": [0] } }; // unknown parent id
    const bad = new TextEncoder().encode(JSON.stringify(json));

    const live = createWorld();
    const [lp] = family(live, 2);
    expect(() => live.import(bad, { replace: true })).toThrow(/order/);
    expect(live.getReverse(lp, Stack).length).toBe(2); // fail-closed: board intact
  });

  it("worlds with no ordered sequences export WITHOUT an order section (legacy-identical shape)", () => {
    const world = createWorld();
    const p = spawn(world);
    const a = spawn(world);
    world.setRelation(a, Plain, p);
    const json = JSON.parse(new TextDecoder().decode(world.export())) as Record<string, unknown>;
    expect(json.order).toBeUndefined();
  });
});

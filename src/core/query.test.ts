import { describe, expect, it } from "vitest";
import { All, Any, Not, Related, defineQuery } from "./query";
import { RuntimeStore } from "./runtime-store";
import { defineComponent, defineRelation, defineTag } from "./schema";
import { type Entity, pack } from "./entity";

// Isolated module context → fresh schema for this file.
const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });
const Health = defineComponent("Health", { hp: "u16" });
const Frozen = defineTag("Frozen");
const Enemy = defineTag("Enemy");
const Selected = defineTag("Selected");
const Targets = defineRelation("Targets", { arity: "many" });

/** Collect every entity a query matches. */
function collect(store: RuntimeStore, q: ReturnType<typeof defineQuery>): Entity[] {
  const out: Entity[] = [];
  store.query(q).each((batch) => {
    for (const r of batch) out.push(batch.entity(r));
  });
  return out;
}

const sortE = (es: Entity[]) => [...es].sort((a, b) => a - b);

describe("defineQuery — compilation", () => {
  it("folds bare components into required, Not(component) into excluded", () => {
    const q = defineQuery([Position, Velocity, Not(Health)]);
    expect(q.required).toEqual([Position.id, Velocity.id]);
    expect(q.excluded).toEqual([Health.id]);
    expect(q.rowFilters).toEqual([]);
    expect(q.seed).toBeUndefined();
  });

  it("routes tags and Not(tag) to row filters", () => {
    const q = defineQuery([Position, Frozen, Not(Enemy)]);
    expect(q.required).toEqual([Position.id]);
    expect(q.rowFilters).toEqual([
      { kind: "tag", negate: false, tagId: Frozen.id },
      { kind: "tag", negate: true, tagId: Enemy.id },
    ]);
  });

  it("keeps a pure-component Any at archetype level, but drops a mixed Any to a row filter", () => {
    const pure = defineQuery([Any(Position, Velocity)]);
    expect(pure.anyComponentGroups).toEqual([[Position.id, Velocity.id]]);
    expect(pure.rowFilters).toEqual([]);

    const mixed = defineQuery([Any(Position, Frozen)]);
    expect(mixed.anyComponentGroups).toEqual([]);
    expect(mixed.rowFilters[0].kind).toBe("any");
    expect(mixed.rowFilters[0].members).toEqual([
      { kind: "component", componentId: Position.id },
      { kind: "tag", tagId: Frozen.id },
    ]);
  });

  it("compiles an abstract relation to a row filter and a concrete target to a seed", () => {
    const abstract = defineQuery([Related(Targets)]);
    expect(abstract.rowFilters[0]).toMatchObject({ kind: "rel", relation: Targets });
    expect(abstract.seed).toBeUndefined();

    const target = pack(9, 1);
    const concrete = defineQuery([Position, Related(Targets, target)]);
    expect(concrete.seed).toEqual({ relation: Targets, target });
  });

  it("routes Not(Related), incl. a negated concrete target, to a negated row filter (never a seed)", () => {
    const abstract = defineQuery([Position, Not(Related(Targets))]);
    expect(abstract.rowFilters).toContainEqual({ kind: "rel", negate: true, relation: Targets });
    expect(abstract.seed).toBeUndefined();

    const t = pack(3, 1);
    const concrete = defineQuery([Position, Not(Related(Targets, t))]);
    expect(concrete.seed).toBeUndefined();
    expect(concrete.rowFilters).toContainEqual({ kind: "rel", negate: true, relation: Targets, target: t });
  });

  it("supports All inside Any for (A ∧ B) ∨ C", () => {
    const q = defineQuery([Any(All(Position, Velocity), Health)]);
    expect(q.rowFilters[0].kind).toBe("any");
    expect(q.rowFilters[0].members).toEqual([
      { kind: "all", members: [{ kind: "component", componentId: Position.id }, { kind: "component", componentId: Velocity.id }] },
      { kind: "component", componentId: Health.id },
    ]);
  });
});

describe("query execution — components", () => {
  it("matches archetypes that are supersets of the required set (§6.3)", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 1 }]] });
    const b = s.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 1 }], [Health, { hp: 5 }]] });
    s.spawn({ components: [[Position, { x: 0, y: 0 }], [Health, { hp: 5 }]] }); // lacks Velocity
    expect(sortE(collect(s, defineQuery([Position, Velocity])))).toEqual(sortE([a, b]));
  });

  it("excludes archetypes with a Not(component)", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    s.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 1 }]] });
    expect(collect(s, defineQuery([Position, Not(Velocity)]))).toEqual([a]);
  });

  it("reads raw columns via col and reports isDense for a pure-component query", () => {
    const s = new RuntimeStore();
    s.spawn({ components: [[Position, { x: 2, y: 3 }]] });
    let sum = 0;
    let dense = false;
    s.query(defineQuery([Position])).each((batch) => {
      dense = batch.isDense;
      const { x, y } = batch.col(Position);
      for (const r of batch) sum += (x as Float32Array)[r] + (y as Float32Array)[r];
    });
    expect(sum).toBe(5);
    expect(dense).toBe(true);
  });
});

describe("query execution — tags", () => {
  it("filters rows by a tag (row filter, not archetype)", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]], tags: [Frozen] });
    s.spawn({ components: [[Position, { x: 0, y: 0 }]] }); // no Frozen
    expect(collect(s, defineQuery([Position, Frozen]))).toEqual([a]);
    expect(sortE(collect(s, defineQuery([Position, Not(Frozen)])))).toHaveLength(1);
  });

  it("reports raw denseCount (not matched) and isDense=false on a filtered chunk (§6.2)", () => {
    const s = new RuntimeStore();
    s.spawn({ components: [[Position, { x: 0, y: 0 }]], tags: [Frozen] });
    s.spawn({ components: [[Position, { x: 0, y: 0 }]] }); // same archetype, not Frozen
    let denseCount = -1;
    let matched = 0;
    let isDense = true;
    s.query(defineQuery([Position, Frozen])).each((batch) => {
      denseCount = batch.denseCount;
      isDense = batch.isDense;
      for (const _r of batch) matched++;
    });
    expect(denseCount).toBe(2); // raw archetype row count — both Position rows
    expect(matched).toBe(1); // only the Frozen row passed the filter
    expect(isDense).toBe(false); // a filtered chunk is never dense
  });

  it("finds a tag-only entity living in the empty archetype", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ tags: [Enemy] });
    s.spawn(); // untagged, also in the empty archetype
    expect(collect(s, defineQuery([Enemy]))).toEqual([a]);
  });

  it("mixed Any is a per-row OR over component membership and tag bits", () => {
    const s = new RuntimeStore();
    const hasPos = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const hasSel = s.spawn({ tags: [Selected] });
    s.spawn({ components: [[Velocity, { x: 0, y: 0 }]] }); // neither Position nor Selected
    expect(sortE(collect(s, defineQuery([Any(Position, Selected)])))).toEqual(sortE([hasPos, hasSel]));
  });
});

describe("query execution — relations", () => {
  it("abstract Related filters by presence and captures a target", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const t1 = s.spawn();
    const t2 = s.spawn();
    s.addRelation(a, Targets, t1);
    s.addRelation(a, Targets, t2);
    s.spawn({ components: [[Position, { x: 0, y: 0 }]] }); // no Targets edge

    const captured: Entity[] = [];
    let all: Entity[] = [];
    s.query(defineQuery([Position, Related(Targets)])).each((batch) => {
      for (const r of batch) {
        captured.push(batch.getRelated(r, Targets) as Entity);
        all = batch.getAllRelated(r, Targets);
      }
    });
    expect(captured).toHaveLength(1); // only `a` matched
    expect(sortE(all)).toEqual(sortE([t1, t2]));
  });

  it("concrete Related seeds from the reverse index", () => {
    const s = new RuntimeStore();
    const target = s.spawn();
    const p1 = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const p2 = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const noPos = s.spawn(); // points at target but lacks Position
    s.addRelation(p1, Targets, target);
    s.addRelation(p2, Targets, target);
    s.addRelation(noPos, Targets, target);
    expect(sortE(collect(s, defineQuery([Position, Related(Targets, target)])))).toEqual(sortE([p1, p2]));
  });

  it("seeded iteration skips a source that was destroyed", () => {
    const s = new RuntimeStore();
    const target = s.spawn();
    const p1 = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const p2 = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    s.addRelation(p1, Targets, target);
    s.addRelation(p2, Targets, target);
    s.destroy(p1);
    expect(collect(s, defineQuery([Position, Related(Targets, target)]))).toEqual([p2]);
  });

  it("Not(Related) excludes entities that have any edge of the relation", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const b = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const t = s.spawn();
    s.addRelation(a, Targets, t);
    expect(collect(s, defineQuery([Position, Not(Related(Targets))]))).toEqual([b]);
  });
});

describe("query execution — caching & edge cases", () => {
  it("picks up an archetype created after the query was first run", () => {
    const s = new RuntimeStore();
    const a = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const q = defineQuery([Position]);
    expect(collect(s, q)).toEqual([a]); // caches matching archetypes
    const b = s.spawn({ components: [[Position, { x: 0, y: 0 }], [Health, { hp: 1 }]] }); // new archetype
    expect(sortE(collect(s, q))).toEqual(sortE([a, b])); // observer added it
  });

  it("an empty query matches all placed entities; firstOf returns one match", () => {
    const s = new RuntimeStore();
    const a = s.spawn();
    const b = s.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(sortE(collect(s, defineQuery([])))).toEqual(sortE([a, b]));
    expect(s.firstOf(defineQuery([Position]))).toBe(b);
    expect(s.firstOf(defineQuery([Velocity]))).toBeUndefined(); // nothing has Velocity
  });
});

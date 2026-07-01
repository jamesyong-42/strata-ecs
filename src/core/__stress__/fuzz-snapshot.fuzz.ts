/**
 * Property fuzz: export→import must reproduce a random world exactly (design §8).
 *
 * A random world (components, tags, one/many relations; every entity carries a stable uid) is
 * serialized and loaded into a fresh world; a uid-keyed canonical model of both must be identical.
 * Identity is relabeled on import, so the model compares topology (references mapped through uid),
 * not handles. Strings use a JSON/UTF-8-safe alphabet — the lone-surrogate and -0/NaN edge cases are
 * pinned separately (see snapshot.stress.ts / docs/stress-report.md).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ComponentEntry,
  type Entity,
  type World,
  createWorld,
  defineComponent,
  defineRelation,
  defineTag,
} from "../index";
import { SEED, fuzzRuns } from "./harness";

const SUid = defineComponent<{ id: number }>("SsUid", { id: "u32" });
const SPos = defineComponent<{ x: number; y: number }>("SsPos", { x: "f32", y: "f32" });
const SName = defineComponent<{ label: string }>("SsName", { label: "string" });
const TG = [defineTag("SsT0"), defineTag("SsT1")];
const Parent = defineRelation("SsParent", { arity: "one" });
const Links = defineRelation("SsLinks", { arity: "many" });

function model(w: World): Map<number, unknown> {
  const store = w.runtime;
  const uidOf = new Map<Entity, number>();
  for (const e of store.placedEntities()) uidOf.set(e, w.read(e, SUid).id);

  const out = new Map<number, unknown>();
  for (const e of store.placedEntities()) {
    const components: Record<string, unknown> = {};
    for (const c of store.componentsOf(e)) components[c.name] = w.read(e, c);
    const tags = store
      .tagsOf(e)
      .map((t) => t.name)
      .sort();
    const relations: Record<string, unknown> = {};
    const par = w.getRelation(e, Parent);
    if (par !== undefined) relations["SsParent"] = uidOf.get(par);
    const links = w
      .getRelations(e, Links)
      .map((h) => uidOf.get(h))
      .sort();
    if (links.length > 0) relations["SsLinks"] = links;
    out.set(w.read(e, SUid).id, { components, tags, relations });
  }
  return out;
}

// JSON/UTF-8-safe label (no lone surrogates — that edge is a documented snapshot limitation).
const label = fc.array(fc.constantFrom("a", "b", "c", "x", "y", "z", "0", "1", " "), { maxLength: 10 }).map((a) => a.join(""));
const coord = fc.integer({ min: -1000, max: 1000 }); // exact in f32, never -0
const entitySpec = fc.record({
  pos: fc.option(fc.record({ x: coord, y: coord }), { nil: undefined }),
  name: fc.option(label, { nil: undefined }),
  tags: fc.integer({ min: 0, max: 3 }),
});
const relSpec = fc.record({ src: fc.nat(), tgt: fc.nat(), one: fc.boolean() });

describe("fuzz: snapshot round-trip fidelity (§8)", () => {
  it("export→import reproduces a random world's topology exactly", () => {
    fc.assert(
      fc.property(
        fc.array(entitySpec, { minLength: 1, maxLength: 30 }),
        fc.array(relSpec, { maxLength: 40 }),
        (specs, rels) => {
          const n = specs.length;
          const w1 = createWorld();
          const handles: Entity[] = [];
          for (let i = 0; i < n; i++) {
            const s = specs[i];
            const comps: ComponentEntry[] = [[SUid, { id: i }]];
            if (s.pos !== undefined) comps.push([SPos, s.pos]);
            if (s.name !== undefined) comps.push([SName, { label: s.name }]);
            const tags = [];
            for (let t = 0; t < 2; t++) if (s.tags & (1 << t)) tags.push(TG[t]);
            handles.push(w1.spawn({ components: comps, tags }));
          }
          for (const r of rels) {
            const src = handles[r.src % n];
            const tgt = handles[r.tgt % n];
            if (r.one) w1.setRelation(src, Parent, tgt);
            else w1.addRelation(src, Links, tgt);
          }

          const w2 = createWorld();
          w2.import(w1.export());
          expect(model(w2)).toEqual(model(w1));
        },
      ),
      { seed: SEED, numRuns: fuzzRuns(150) },
    );
  });
});

/**
 * Property fuzz: a compiled query must return exactly the set a naive per-entity predicate does.
 *
 * A random world (components + tags + one/many relations, all entities alive so validate-on-read is
 * a non-issue) is matched by a random query built from required/excluded/Any/tag/relation terms —
 * including concrete-target relations that trigger the reverse-index seed path. The query engine's
 * result set must equal the brute-force filter over every placed entity, for both the dense and the
 * seeded dispatch.
 */

import fc from "fast-check";
import { describe, it } from "vitest";
import {
  Any,
  type Entity,
  Not,
  type QueryTerm,
  Related,
  type World,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineTag,
  field,
} from "../index";
import { SEED, fuzzRuns } from "./harness";

const C = [
  defineComponent("QA", { v: field("u32", { default: 0 }) }),
  defineComponent("QB", { v: field("u32", { default: 0 }) }),
  defineComponent("QC", { v: field("u32", { default: 0 }) }),
];
const TG = [defineTag("QT0"), defineTag("QT1")];
const ROne = defineRelation("QROne", { arity: "one" });
const RMany = defineRelation("QRMany", { arity: "many" });

type TermD =
  | { k: "req"; c: number }
  | { k: "not"; c: number }
  | { k: "any2"; a: number; b: number }
  | { k: "tag"; t: number }
  | { k: "nottag"; t: number }
  | { k: "relAny"; one: boolean }
  | { k: "relTgt"; one: boolean; tgt: number };

function buildTerm(d: TermD, handles: Entity[], n: number): QueryTerm {
  switch (d.k) {
    case "req":
      return C[d.c];
    case "not":
      return Not(C[d.c]);
    case "any2":
      return Any(C[d.a], C[d.b]);
    case "tag":
      return TG[d.t];
    case "nottag":
      return Not(TG[d.t]);
    case "relAny":
      return Related(d.one ? ROne : RMany);
    case "relTgt":
      return Related(d.one ? ROne : RMany, handles[d.tgt % n]);
  }
}

function matches(d: TermD, w: World, e: Entity, handles: Entity[], n: number): boolean {
  switch (d.k) {
    case "req":
      return w.has(e, C[d.c]);
    case "not":
      return !w.has(e, C[d.c]);
    case "any2":
      return w.has(e, C[d.a]) || w.has(e, C[d.b]);
    case "tag":
      return w.hasTag(e, TG[d.t]);
    case "nottag":
      return !w.hasTag(e, TG[d.t]);
    case "relAny":
      return d.one ? w.getRelation(e, ROne) !== undefined : w.getRelations(e, RMany).length > 0;
    case "relTgt": {
      const target = handles[d.tgt % n];
      return d.one
        ? w.getRelation(e, ROne) === target
        : w.getRelations(e, RMany).some((x) => x === target);
    }
  }
}

const cSel = fc.integer({ min: 0, max: 2 });
const tSel = fc.integer({ min: 0, max: 1 });
const termD = fc.oneof(
  fc.record({ k: fc.constant("req"), c: cSel }),
  fc.record({ k: fc.constant("not"), c: cSel }),
  fc.record({ k: fc.constant("any2"), a: cSel, b: cSel }),
  fc.record({ k: fc.constant("tag"), t: tSel }),
  fc.record({ k: fc.constant("nottag"), t: tSel }),
  fc.record({ k: fc.constant("relAny"), one: fc.boolean() }),
  fc.record({ k: fc.constant("relTgt"), one: fc.boolean(), tgt: fc.nat() }),
) as fc.Arbitrary<TermD>;

const entitySpec = fc.record({ comps: fc.integer({ min: 0, max: 7 }), tags: fc.integer({ min: 0, max: 3 }) });
const relSpec = fc.record({ src: fc.nat(), tgt: fc.nat(), one: fc.boolean() });

describe("fuzz: query engine vs brute-force predicate (§6)", () => {
  it("dense and seeded queries return exactly the entities matching the predicate", () => {
    fc.assert(
      fc.property(
        fc.array(entitySpec, { minLength: 1, maxLength: 40 }),
        fc.array(relSpec, { maxLength: 60 }),
        fc.array(termD, { minLength: 1, maxLength: 4 }),
        (specs, rels, terms) => {
          const n = specs.length;
          const w = createWorld();
          const handles: Entity[] = [];
          for (const s of specs) {
            const comps = [];
            for (let c = 0; c < 3; c++) if (s.comps & (1 << c)) comps.push([C[c], { v: 1 }] as const);
            const tags = [];
            for (let t = 0; t < 2; t++) if (s.tags & (1 << t)) tags.push(TG[t]);
            handles.push(w.spawn({ components: comps, tags }));
          }
          for (const r of rels) {
            const s = handles[r.src % n];
            const t = handles[r.tgt % n];
            if (r.one) w.setRelation(s, ROne, t);
            else w.addRelation(s, RMany, t);
          }

          const q = defineQuery(terms.map((d) => buildTerm(d, handles, n)));
          const got = new Set<Entity>();
          w.query(q).each((b) => {
            for (const row of b) got.add(b.entity(row));
          });

          const expected = new Set<Entity>();
          for (const e of w.runtime.placedEntities()) {
            if (terms.every((d) => matches(d, w, e, handles, n))) expected.add(e);
          }

          const a = [...got].sort((x, y) => x - y);
          const b = [...expected].sort((x, y) => x - y);
          if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
            throw new Error(`query/predicate mismatch: query=${a.length} predicate=${b.length}`);
          }
        },
      ),
      { seed: SEED, numRuns: fuzzRuns(150) },
    );
  });
});

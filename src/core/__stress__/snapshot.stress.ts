/**
 * Stress: large-world snapshot round-trip fidelity (design §8).
 *
 * Builds a world spanning many archetypes with eid cross-references, one/many relations, tags, and
 * a resource; exports, imports into a fresh world, and asserts a canonical model is identical. The
 * model is keyed by a stable per-entity uid (not the handle, which is relabeled on import) and maps
 * every eid/relation reference through that uid so topology is compared, not identity.
 *
 * NOTE: the hard `RangeError` at the V8 single-string ceiling (`JSON.stringify` of a huge world) is
 * a documented limit; it is NOT triggered here — reliably reaching it needs hundreds of MB of
 * string and would destabilize the suite. See docs/stress-report.md.
 */

import { describe, expect, it } from "vitest";
import {
  type ComponentEntry,
  type Entity,
  type World,
  createWorld,
  defineComponent,
  defineRelation,
  defineResource,
  defineTag,
} from "../index";
import { scaled } from "./harness";

const Uid = defineComponent("SnapUid", { id: "u32" });
const Pos = defineComponent("SnapPos", { x: "f32", y: "f32" });
const Name = defineComponent("SnapName", { label: "string" });
const Ref = defineComponent("SnapRef", { to: "eid" });
const Edge = defineComponent("SnapEdge", {
  a: "f64",
  b: "f64",
  c: "f64",
});
const TagA = defineTag("SnapTagA");
const TagB = defineTag("SnapTagB");
const Parent = defineRelation("SnapParent", { arity: "one" });
const Links = defineRelation("SnapLinks", { arity: "many" });
const Cfg = defineResource("SnapCfg", { seed: "u32" });

const REF_FIELD = Ref.fieldByName.get("to")!.fieldId;

/** A canonical, identity-independent view of a world, keyed by each entity's stable uid. */
function model(w: World): Map<number, unknown> {
  const store = w.runtime;
  const placed = store.placedEntities();
  const uidOf = new Map<Entity, number>();
  for (const e of placed) uidOf.set(e, w.read(e, Uid).id);

  const out = new Map<number, unknown>();
  for (const e of placed) {
    const components: Record<string, unknown> = {};
    for (const c of store.componentsOf(e)) {
      if (c.name === "SnapRef") {
        // Liveness-validated eid read via the internal store seam — the public API is readField
        // (keyed by name, decodes the raw handle); this harness needs the validated form.
        const ref = store.readEid(e, c, REF_FIELD);
        components[c.name] = { to: ref !== undefined ? uidOf.get(ref) ?? null : null };
      } else {
        components[c.name] = w.read(e, c);
      }
    }
    const tags = store
      .tagsOf(e)
      .map((t) => t.name)
      .sort();
    const relations: Record<string, unknown> = {};
    const par = w.getRelation(e, Parent);
    if (par !== undefined) relations["SnapParent"] = uidOf.get(par);
    const links = w
      .getRelations(e, Links)
      .map((h) => uidOf.get(h))
      .sort();
    if (links.length > 0) relations["SnapLinks"] = links;
    out.set(w.read(e, Uid).id, { components, tags, relations });
  }
  return out;
}

describe("stress: large-world snapshot round-trip (§8)", () => {
  it("reproduces components, eid refs, one/many relations, tags, and resources exactly", () => {
    const N = scaled(3000);
    const w1 = createWorld({ name: "big" });

    const ents: Entity[] = [];
    for (let i = 0; i < N; i++) {
      const comps: ComponentEntry[] = [[Uid, { id: i }]];
      // y stays away from -0 (JSON can't represent it — see the edge-case test below).
      if (i % 2 === 0) comps.push([Pos, { x: i, y: -(i + 1) }]);
      if (i % 3 === 0) comps.push([Name, { label: `n-${i}` }]);
      const tags = [];
      if (i % 5 === 0) tags.push(TagA);
      if (i % 7 === 0) tags.push(TagB);
      // Dynamically-built entries go through the loose store surface (see archetype-migration.stress).
      ents.push(w1.runtime.spawn({ components: comps, tags }));
    }

    // Second pass: eid refs + relations, now that every target entity exists (all placed).
    for (let i = 0; i < N; i++) {
      if (i % 4 === 0) w1.addComponent(ents[i], Ref, { to: ents[(i + 1) % N] });
      if (i % 6 === 0) w1.setRelation(ents[i], Parent, ents[(i + 2) % N]);
      if (i % 9 === 0) {
        w1.addRelation(ents[i], Links, ents[(i + 3) % N]);
        w1.addRelation(ents[i], Links, ents[(i + 4) % N]);
      }
    }
    w1.setResource(Cfg, { seed: 0xc0ffee });

    const bytes = w1.export();
    const w2 = createWorld();
    w2.import(bytes);

    expect(w2.runtime.placedEntities().length).toBe(N);
    expect(w2.getResource(Cfg)).toEqual(w1.getResource(Cfg));
    expect(model(w2)).toEqual(model(w1));
  });

  it("PINNED limitation: JSON snapshot does not preserve -0, NaN, or Infinity (§8)", () => {
    // JSON has no representation for these — stringify turns -0 into "0" and NaN/Infinity into
    // "null", which import decodes back to +0. This is an inherent property of the JSON snapshot
    // format, not a strata bug; it is documented in docs/stress-report.md. Pin it so a future
    // format change (e.g. a binary snapshot) surfaces as an intentional behavior change here.
    const w1 = createWorld();
    const e = w1.spawn({ components: [[Edge, { a: -0, b: NaN, c: Infinity }]] });
    expect(Object.is(w1.read(e, Edge).a, -0)).toBe(true); // still -0 in the live store

    const w2 = createWorld();
    w2.import(w1.export());
    const back = w2.read(w2.runtime.placedEntities()[0], Edge);

    expect(Object.is(back.a, -0)).toBe(false);
    expect(back.a).toBe(0); // -0 → +0
    expect(Number.isNaN(back.b)).toBe(false);
    expect(back.b).toBe(0); // NaN → null → 0
    expect(back.c).toBe(0); // Infinity → null → 0
  });
});

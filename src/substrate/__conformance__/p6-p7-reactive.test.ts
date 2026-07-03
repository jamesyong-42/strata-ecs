/**
 * P6 + P7-notify — projection reactivity (Patch Note 005 §8, §5.3, §6.1).
 *
 * P6: every projector cell-apply / remove is observable at the NEXT `reactive.notify()` — the §5.3
 * guarantee that projection routes only through stamped primitives, so `observeQuery` / `observeValue`
 * / `observeResource` light up on projected change with zero extra wiring. Extends the
 * `stamps.test.ts` pattern to the projection path.
 *
 * P7-notify: re-applying an already-applied fact fires NO watch — SCOPED to where the reactive layer
 * is idempotence-suppressed:
 *   - the EQUALITY-SUPPRESSED value channels (`observeValue` Tier 3, `observeResource` Tier 3): a
 *     same-value re-write re-stamps the column but delivers no callback;
 *   - the GENUINELY STAMPLESS structural no-ops (absent-resource `removeResource`, `remove` of an
 *     already-removed key, `projectRemoveComponent` of an absent component): no stamp, so nothing to see.
 * DEVIATION FROM THE LITERAL §8 P7 (documented): a duplicate `applyTag`/`applyRelationAdd` is STATE-
 * idempotent (neither runtime nor baseline changes) but is NOT Tier-1-silent — the store's membership
 * version (`lastTagRelFrame`, 002 §4.2) is a COARSE global stamp bumped UNCONDITIONALLY by every
 * tag/relation op, by design, so a Tier-1 query re-fires. Idempotence is asserted at the state +
 * Tier-3 level (where the reactive layer suppresses), not at that coarse membership signal.
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../../core/world";
import { entityKey } from "../../core/field";
import { defineQuery, Related } from "../../core/query";
import { Projector } from "../projector";
import { BaselineSnapshot } from "../baseline";
import { CPos, CTile, RCam, RChild, RParent, TSel } from "./harness";

function setup() {
  const w = createWorld();
  void w.reactive; // arm the reactive layer (002 §2.2 master gate)
  const reactive = w.reactive;
  const rt = w.runtime;
  let counter = 0;
  const proj = new Projector(rt, () => entityKey(`rx${counter++}`));
  return { w, reactive, rt, proj };
}

describe("P6 — projection visible at next notify (§5.3)", () => {
  it("applyComponent: observeValue fires the value AND observeQuery fires", () => {
    const { reactive, proj } = setup();
    const k = entityKey("e");
    const h = proj.resolveByKey(k); // resolve first so the value watch has a handle
    let vSeen: unknown = "unset";
    let qFired = 0;
    reactive.observeValue(h, CPos, (v) => (vSeen = v));
    reactive.observeQuery(defineQuery([CPos]), [CPos], () => qFired++);

    proj.applyComponent(k, CPos, { x: 0.1, y: 0.2 });
    reactive.notify();

    expect(vSeen).toEqual({ x: Math.fround(0.1), y: Math.fround(0.2) }); // canonical value delivered
    expect(qFired).toBe(1);
  });

  it("applySpawn: the componentless placement is visible to an all-matching query", () => {
    const { reactive, proj } = setup();
    let fired = 0;
    reactive.observeQuery(defineQuery([]), [], () => fired++); // matches every archetype incl. empty

    proj.applySpawn(entityKey("e")); // ensurePlaced → row appears in the empty archetype
    reactive.notify();

    expect(fired).toBe(1);
  });

  it("removeComponent: observeValue fires undefined", () => {
    const { reactive, proj } = setup();
    const k = entityKey("e");
    proj.applyComponent(k, CPos, { x: 1, y: 2 });
    const h = proj.resolveByKey(k);
    const calls: unknown[] = [];
    reactive.observeValue(h, CPos, (v) => calls.push(v));

    proj.removeComponent(k, CPos);
    reactive.notify();

    expect(calls).toEqual([undefined]);
  });

  it("applyTag: observeQuery on the tag fires", () => {
    const { reactive, proj } = setup();
    let fired = 0;
    reactive.observeQuery(defineQuery([TSel]), [], () => fired++);

    proj.applyTag(entityKey("e"), TSel);
    reactive.notify();

    expect(fired).toBe(1);
  });

  it("removeTag: observeQuery on the tag fires", () => {
    const { reactive, proj } = setup();
    const k = entityKey("e");
    proj.applyTag(k, TSel);
    let fired = 0;
    reactive.observeQuery(defineQuery([TSel]), [], () => fired++);
    reactive.notify(); // settle the add
    fired = 0;

    proj.removeTag(k, TSel);
    reactive.notify();

    expect(fired).toBe(1);
  });

  it("applyRelationSet / applyRelationAdd / removeRelation: observeQuery on Related fires", () => {
    for (const rel of [RParent, RChild] as const) {
      const { reactive, proj } = setup();
      let fired = 0;
      reactive.observeQuery(defineQuery([Related(rel)]), [], () => fired++);

      const src = entityKey("s");
      const tgt = entityKey("t");
      if (rel === RParent) proj.applyRelationSet(src, rel, tgt);
      else proj.applyRelationAdd(src, rel, tgt);
      reactive.notify();
      expect(fired).toBe(1);

      proj.removeRelation(src, rel, tgt);
      reactive.notify();
      expect(fired).toBe(2); // the removal is visible too
    }
  });

  it("remove (despawn): observeValue fires undefined via the death path", () => {
    const { reactive, proj } = setup();
    const k = entityKey("e");
    proj.applyComponent(k, CPos, { x: 1, y: 2 });
    const h = proj.resolveByKey(k);
    const calls: unknown[] = [];
    reactive.observeValue(h, CPos, (v) => calls.push(v));

    proj.remove(k);
    reactive.notify();

    expect(calls).toEqual([undefined]);
  });

  it("setResource / removeResource: observeResource fires (§6.1)", () => {
    const { reactive, rt } = setup();
    const seen: unknown[] = [];
    reactive.observeResource(RCam, (v) => seen.push(v));

    rt.setResource(RCam, { zoom: 0.5, mode: 1 });
    reactive.notify();
    expect(seen).toEqual([{ zoom: 0.5, mode: 1 }]); // defaults-filled value delivered

    rt.removeResource(RCam);
    reactive.notify();
    expect(seen).toEqual([{ zoom: 0.5, mode: 1 }, undefined]);
  });
});

describe("P7 — projection idempotence fires no watch (§2.5, §6.1)", () => {
  it("duplicate applyComponent (same value): observeValue does NOT fire; runtime unchanged", () => {
    const { reactive, proj, rt } = setup();
    const k = entityKey("e");
    proj.applyComponent(k, CPos, { x: 1, y: 2 });
    const h = proj.resolveByKey(k);
    const calls: unknown[] = [];
    reactive.observeValue(h, CPos, (v) => calls.push(v));
    reactive.notify(); // settle (no fire — same-value baseline)
    calls.length = 0;

    proj.applyComponent(k, CPos, { x: 1, y: 2 }); // re-apply the SAME value
    reactive.notify();

    expect(calls).toEqual([]); // Tier-3 equality-suppressed
    expect(rt.get(h, CPos)).toEqual({ x: 1, y: 2 }); // runtime unchanged
  });

  it("duplicate setResource (same value): observeResource does NOT fire; runtime unchanged", () => {
    const { reactive, rt } = setup();
    rt.setResource(RCam, { zoom: 0.5, mode: 1 });
    const calls: unknown[] = [];
    reactive.observeResource(RCam, (v) => calls.push(v));
    reactive.notify(); // settle
    calls.length = 0;

    rt.setResource(RCam, { zoom: 0.5, mode: 1 }); // same canonical value
    reactive.notify();

    expect(calls).toEqual([]);
    expect(rt.getResource(RCam)).toEqual({ zoom: 0.5, mode: 1 });
  });

  it("absent-resource removeResource: no fire, and the stamp does not advance (stampless, §6.1)", () => {
    const { reactive, rt } = setup();
    const calls: unknown[] = [];
    reactive.observeResource(RCam, (v) => calls.push(v));
    reactive.notify(); // settle (RCam absent)
    calls.length = 0;
    const before = rt.resourceFrame(RCam.id);

    rt.removeResource(RCam); // absent → Map.delete false → no bumpResource
    expect(rt.resourceFrame(RCam.id)).toBe(before); // stampless no-op
    reactive.notify();

    expect(calls).toEqual([]);
  });

  it("remove of an already-removed key: no throw, no membership bump, no query fire", () => {
    const { reactive, proj, rt } = setup();
    let fired = 0;
    reactive.observeQuery(defineQuery([CPos]), [CPos], () => fired++);
    reactive.notify(); // settle
    fired = 0;
    const before = rt.lastTagRelFrame;

    expect(() => proj.remove(entityKey("never-bound"))).not.toThrow();
    expect(rt.lastTagRelFrame).toBe(before); // no destroy → no bumpTagRel
    reactive.notify();

    expect(fired).toBe(0);
  });

  it("projectRemoveComponent of an absent component: no fire, runtime unchanged", () => {
    const { reactive, proj, rt } = setup();
    const k = entityKey("e");
    proj.applyComponent(k, CTile, { u: 1, i: 2 }); // has CTile, NOT CPos
    const h = proj.resolveByKey(k);
    const calls: unknown[] = [];
    reactive.observeValue(h, CPos, (v) => calls.push(v));
    reactive.notify(); // settle
    calls.length = 0;

    proj.removeComponent(k, CPos); // absent → has-guard no-op
    reactive.notify();

    expect(calls).toEqual([]);
    expect(rt.get(h, CTile)).toEqual({ u: 1, i: 2 }); // untouched
  });

  it("duplicate applySpawn on an already-placed key: state-idempotent AND stampless (no fire)", () => {
    // A FIRST applySpawn fires an empty-query watch (P6). A duplicate is existence-only — `ensurePlaced`
    // no-ops on an already-placed handle, so it bumps no structural stamp and notifies no one (§4.1).
    const { reactive, proj, rt } = setup();
    const k = entityKey("e");
    proj.applySpawn(k); // first placement into the empty archetype
    const h = proj.resolveByKey(k);
    let fired = 0;
    reactive.observeQuery(defineQuery([]), [], () => fired++); // matches every archetype incl. empty
    reactive.notify(); // settle the initial placement (post-registration → no retro-fire)
    fired = 0;

    proj.applySpawn(k); // duplicate — no-op
    reactive.notify();

    expect(fired).toBe(0); // stampless: no placement bump
    expect(rt.isPlaced(h)).toBe(true); // still placed, unchanged
  });

  it("duplicate applyTag / applyRelationAdd: state idempotent (runtime AND baseline unchanged)", () => {
    // The value channels have nothing to suppress for tags/edges; the STATE claim is what holds
    // (Tier-1 membership re-stamps by design — see the file header). Assert both stores are unmoved.
    const { proj, rt } = setup();
    const bs = new BaselineSnapshot();
    const k = entityKey("e");
    const t = entityKey("t");

    proj.applyTag(k, TSel);
    bs.addTag(k, TSel);
    proj.applyRelationAdd(k, RChild, t);
    bs.addRelation(k, RChild, t);

    const h = proj.resolveByKey(k);
    const th = proj.resolveByKey(t);

    proj.applyTag(k, TSel); // duplicate
    bs.addTag(k, TSel);
    proj.applyRelationAdd(k, RChild, t); // duplicate
    bs.addRelation(k, RChild, t);

    expect(rt.hasTag(h, TSel)).toBe(true);
    expect(rt.getRelations(h, RChild)).toEqual([th]); // still exactly one edge
    expect(bs.hasTag(k, TSel)).toBe(true);
    expect(bs.getRelationMany(k, RChild)).toEqual([t]);
  });
});

/**
 * The `Projector` kernel (Patch Note 005 §5; M3). Covers the three mint policies (§5.1), `remove`
 * (generation bump + bijection clear + re-resolve to a fresh handle, §5.2), four-step teardown's
 * step 3 (§5.6), and cell-apply routing proven through a REAL World-level query (§5.2/§5.4).
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../core/world";
import type { Entity } from "../core/entity";
import { entityKey } from "../core/field";
import { defineComponent, defineRelation, defineTag } from "../core/schema";
import { defineQuery, Related } from "../core/query";
import { Projector } from "./projector";

const PPos = defineComponent("PROJPos", { x: "u8", y: "u8" });
const PSel = defineTag("PROJSel");
const PParent = defineRelation("PROJParent", { arity: "one" });

/** A fresh world + projector with a monotonic key minter. */
function setup() {
  const w = createWorld();
  const rt = w.runtime;
  let counter = 0;
  const proj = new Projector(rt, () => entityKey(`k${counter++}`));
  return { w, rt, proj };
}

/** Entities a query matches, iterated outside a tick (world.query, §16). */
function matches(w: ReturnType<typeof createWorld>, q: ReturnType<typeof defineQuery>): Entity[] {
  const out: Entity[] = [];
  w.query(q).each((b) => {
    for (const r of b) out.push(b.entity(r));
  });
  return out;
}

describe("Projector — mint policies (§5.1)", () => {
  it("resolveByKey mints identity once and is idempotent", () => {
    const { rt, proj } = setup();
    const k = entityKey("e");
    const h1 = proj.resolveByKey(k);
    const h2 = proj.resolveByKey(k);
    expect(h2).toBe(h1); // idempotent — same handle
    expect(rt.isAlive(h1)).toBe(true);
    expect(rt.isPlaced(h1)).toBe(false); // identity-only until a component/tag/spawn migrates it (§5.4)
  });

  it("createPair mints a key for a fresh handle and throws on an already-keyed one", () => {
    const { rt, proj } = setup();
    const handle = rt.allocateIdentity();
    const key = proj.createPair(handle);
    expect(typeof key).toBe("string");
    expect(proj.requireKey(handle)).toBe(key); // now bound both ways
    expect(() => proj.createPair(handle)).toThrow(/already has a key/);
  });

  it("requireKey throws EXACTLY for unbound handles (P3)", () => {
    const { rt, proj } = setup();
    const bound = proj.resolveByKey(entityKey("bound"));
    expect(proj.requireKey(bound)).toBe("bound");
    const runtimeOnly = rt.allocateIdentity(); // never went through the projector
    expect(() => proj.requireKey(runtimeOnly)).toThrow(/not in this store/);
  });
});

describe("Projector — remove (§5.2)", () => {
  it("kills the old handle (generation), clears the bijection, re-resolves to a FRESH handle", () => {
    const { rt, proj } = setup();
    const k = entityKey("gone");
    const h = proj.resolveByKey(k);
    proj.applySpawn(k); // place it so it is a real live entity
    expect(rt.isAlive(h)).toBe(true);

    proj.remove(k);
    expect(rt.isAlive(h)).toBe(false); // old handle dead — generation bumped
    expect(() => proj.requireKey(h)).toThrow(); // bijection cleared

    const h2 = proj.resolveByKey(k); // key re-resolves to a fresh handle
    expect(h2).not.toBe(h);
    expect(rt.isAlive(h2)).toBe(true);
  });

  it("remove of a never-resolved key is a no-op", () => {
    const { proj } = setup();
    expect(() => proj.remove(entityKey("never"))).not.toThrow();
  });
});

describe("Projector — teardown step 3 (§5.6)", () => {
  it("despawns every projected entity and clears the bijection", () => {
    const { rt, proj } = setup();
    const keys = [entityKey("t0"), entityKey("t1"), entityKey("t2")];
    const handles = keys.map((k) => {
      const h = proj.resolveByKey(k);
      proj.applySpawn(k);
      return h;
    });
    proj.teardown();
    for (const h of handles) expect(rt.isAlive(h)).toBe(false);
    // bijection cleared — the key re-resolves to a brand-new handle
    const fresh = proj.resolveByKey(keys[0]);
    expect(fresh).not.toBe(handles[0]);
  });
});

describe("Projector — cell-apply routes to the runtime (§5.2), visible to a real query", () => {
  it("applyComponent places + fills the cell; a World query sees it with its value", () => {
    const { w, proj } = setup();
    proj.applyComponent(entityKey("e1"), PPos, { x: 3, y: 4 });
    const seen = matches(w, defineQuery([PPos]));
    expect(seen.length).toBe(1);
    expect(w.read(seen[0], PPos)).toEqual({ x: 3, y: 4 });
  });

  it("applyTag makes the key queryable by the tag; removeTag removes it", () => {
    const { w, proj } = setup();
    const k = entityKey("e2");
    proj.applyTag(k, PSel);
    expect(matches(w, defineQuery([PSel])).length).toBe(1);
    proj.removeTag(k, PSel);
    expect(matches(w, defineQuery([PSel])).length).toBe(0);
  });

  it("applyRelationSet mints the target's handle and wires the edge (query by Related)", () => {
    const { w, rt, proj } = setup();
    const src = entityKey("s");
    const tgt = entityKey("t");
    proj.applyRelationSet(src, PParent, tgt);
    const seen = matches(w, defineQuery([Related(PParent)]));
    expect(seen.length).toBe(1);
    // the edge resolves to the target's projected handle
    expect(rt.getRelation(seen[0], PParent)).toBe(proj.resolveByKey(tgt));
  });

  it("removeComponent then re-query: the entity leaves the result set", () => {
    const { w, proj } = setup();
    const k = entityKey("e3");
    proj.applyComponent(k, PPos, { x: 1, y: 1 });
    expect(matches(w, defineQuery([PPos])).length).toBe(1);
    proj.removeComponent(k, PPos);
    expect(matches(w, defineQuery([PPos])).length).toBe(0);
  });
});

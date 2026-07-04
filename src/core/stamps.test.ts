/**
 * Change-detection substrate (Patch Note 002 §2) — the stamps/versions the reactive layer polls.
 *
 * Covers the frame counter (§2.1/§4.1a), per-(archetype, component) value stamps at every write
 * chokepoint (writeComponent/edit, migrate's added columns, projection), the per-archetype
 * rows-version (`lastStructuralFrame`, §4.2), the global tag/relation membership version, and the
 * two internal fan-out helpers (`stampWrites` — 001 §3.1 route 1, `invalidateComponent` — §2.2).
 * Internals are reached through `world.runtime`, the @internal seam the store tests already use.
 */

import { describe, expect, it } from "vitest";
import { createWorld, type World } from "./world";
import type { RuntimeStore } from "./runtime-store";
import type { Entity } from "./entity";
import { type Component, defineComponent, defineRelation, defineTag } from "./schema";
import { defineQuery } from "./query";
import { defineSystem, phase } from "./system";

const Pos = defineComponent("STMPosition", { x: "f32", y: "f32" });
const Vel = defineComponent("STMVelocity", { x: "f32", y: "f32" });
const Driver = defineComponent("STMDriver", { v: "u8" });
const Selected = defineTag("STMSelected");
const Owns = defineRelation("STMOwns", { arity: "one" });
const Links = defineRelation("STMLinks", { arity: "many" });

/** Stamping is gated on the reactive layer being touched (002 §2.2's master gate) — arm it. */
function reactiveWorld(): World {
  const w = createWorld();
  void w.reactive;
  return w;
}

/** The archetype `e` is placed in (throws if identity-only/dead — tests always place first). */
function archOf(rt: RuntimeStore, e: Entity) {
  const a = rt.archetypeOf(e);
  if (a === undefined) throw new Error("STM: entity is not placed");
  return a;
}

/** The value stamp for `c`'s column on `e`'s archetype. */
function writeStamp(rt: RuntimeStore, e: Entity, c: Component): number {
  const a = archOf(rt, e);
  return a.lastWrittenFrame[a.componentSlot(c.id)];
}

describe("frame counter (§2.1)", () => {
  it("starts at 1 and advanceFrame increments it", () => {
    const rt = reactiveWorld().runtime;
    expect(rt.frame).toBe(1);
    rt.advanceFrame();
    expect(rt.frame).toBe(2);
    rt.advanceFrame();
    expect(rt.frame).toBe(3);
  });
});

describe("value-write stamps (§2.2(3), 001 §3.1 route 2)", () => {
  it("place does not stamp value columns; edit().set stamps only the written component at the current frame", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }], [Vel, { x: 0, y: 0 }]] });
    // A spawn's initial values are covered by membership, not value stamps (the final §2.2 rule).
    expect(writeStamp(rt, e, Pos)).toBe(0);
    expect(writeStamp(rt, e, Vel)).toBe(0);

    rt.advanceFrame(); // frame 2
    w.edit(e).set(Pos, { x: 1, y: 1 });
    expect(writeStamp(rt, e, Pos)).toBe(2); // the written column, stamped at the current frame
    expect(writeStamp(rt, e, Vel)).toBe(0); // its sibling is left untouched
  });
});

describe("migration stamps (§2.2(2))", () => {
  it("immediate addComponent stamps the added column and bumps both archetypes' rows-version", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const oldA = archOf(rt, e); // [Pos]
    expect(oldA.lastStructuralFrame).toBe(1); // placed at spawn, frame 1

    rt.advanceFrame(); // frame 2
    w.addComponent(e, Vel, { x: 1, y: 1 });
    const newA = archOf(rt, e); // [Pos, Vel]
    expect(newA).not.toBe(oldA);

    expect(writeStamp(rt, e, Vel)).toBe(2); // added column stamped
    expect(writeStamp(rt, e, Pos)).toBe(0); // carried column left unstamped by migrate
    expect(oldA.lastStructuralFrame).toBe(2); // unplace bumped the source
    expect(newA.lastStructuralFrame).toBe(2); // place bumped the destination
  });

  it("immediate removeComponent bumps both rows-versions and stamps no added column", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }], [Vel, { x: 1, y: 1 }]] });
    const oldA = archOf(rt, e); // [Pos, Vel]

    rt.advanceFrame(); // frame 2
    w.removeComponent(e, Vel);
    const newA = archOf(rt, e); // [Pos]

    expect(writeStamp(rt, e, Pos)).toBe(0); // carried, not stamped
    expect(oldA.lastStructuralFrame).toBe(2);
    expect(newA.lastStructuralFrame).toBe(2);
  });
});

describe("rows-version on spawn / destroy — immediate path (§4.2)", () => {
  it("spawn bumps the target archetype's rows-version; destroy bumps it too", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const a = archOf(rt, e);
    expect(a.lastStructuralFrame).toBe(3); // place at frame 3

    rt.advanceFrame(); // frame 4
    w.destroy(e);
    expect(a.lastStructuralFrame).toBe(4); // unplace at frame 4 (archetype outlives the row)
  });
});

describe("rows-version on the flush path converges on place/unplace (§4.2)", () => {
  it("ctx.spawn through a tick bumps the new archetype's rows-version at flush", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    w.spawn({ components: [[Driver, { v: 0 }]] }); // driver so the system body runs once
    let spawned: Entity | undefined;
    const Spawner = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      spawned = ctx.spawn({ components: [[Vel, { x: 0, y: 0 }]] });
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("spawn", [Spawner])]);

    const a = archOf(rt, spawned as Entity); // [Vel], created + placed at flush
    expect(a.lastStructuralFrame).toBe(3);
  });

  it("ctx.destroy through a tick bumps the archetype's rows-version at flush", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const victim = w.spawn({ components: [[Vel, { x: 0, y: 0 }]] });
    w.spawn({ components: [[Driver, { v: 0 }]] });
    const a = archOf(rt, victim); // [Vel]
    const Destroyer = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.destroy(victim);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("destroy", [Destroyer])]);

    expect(w.isAlive(victim)).toBe(false);
    expect(a.lastStructuralFrame).toBe(3); // unplace at flush
  });
});

describe("tag/relation membership version (§4.2)", () => {
  it("addTag / removeTag / setRelation / addRelation / removeRelation / destroy each bump lastTagRelFrame", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const t1 = w.spawn();
    const t2 = w.spawn();
    expect(rt.lastTagRelFrame).toBe(0); // no tag/relation mutation yet

    rt.advanceFrame(); // 2
    w.addTag(e, Selected);
    expect(rt.lastTagRelFrame).toBe(2);

    rt.advanceFrame(); // 3
    w.removeTag(e, Selected);
    expect(rt.lastTagRelFrame).toBe(3);

    rt.advanceFrame(); // 4
    w.setRelation(e, Owns, t1);
    expect(rt.lastTagRelFrame).toBe(4);

    rt.advanceFrame(); // 5
    w.addRelation(e, Links, t2);
    expect(rt.lastTagRelFrame).toBe(5);

    rt.advanceFrame(); // 6
    w.removeRelation(e, Links, t2);
    expect(rt.lastTagRelFrame).toBe(6);

    rt.advanceFrame(); // 7
    w.destroy(e); // teardown of tags/relations changes filtered membership
    expect(rt.lastTagRelFrame).toBe(7);
  });

  it("a plain spawn/place does NOT bump lastTagRelFrame (rows-version only)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    rt.advanceFrame(); // 2
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    expect(rt.lastTagRelFrame).toBe(0); // untouched by structural-only work
  });

  it("ctx.addTag through a tick bumps lastTagRelFrame at flush (applyCommand path)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Driver, { v: 0 }]] });
    const Tagger = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.addTag(e, Selected);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("tag", [Tagger])]);

    expect(w.hasTag(e, Selected)).toBe(true);
    expect(rt.lastTagRelFrame).toBe(3);
  });

  // The other four flush arms' bumpTagRel were untested before R6 (only ctx.addTag was covered) —
  // each is now routed through the shared do* primitive, so each must still advance lastTagRelFrame
  // at flush. A row-filtered Tier-1 watch keys off exactly this version (§4.2).
  it("ctx.removeTag through a tick bumps lastTagRelFrame at flush (applyCommand path)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Driver, { v: 0 }]] });
    w.addTag(e, Selected); // present before the tick
    const Untagger = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.removeTag(e, Selected);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("untag", [Untagger])]);

    expect(w.hasTag(e, Selected)).toBe(false);
    expect(rt.lastTagRelFrame).toBe(3);
  });

  it("ctx.setRelation through a tick bumps lastTagRelFrame at flush (applyCommand path)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Driver, { v: 0 }]] });
    const target = w.spawn();
    const Setter = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.setRelation(e, Owns, target);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("set", [Setter])]);

    expect(w.getRelation(e, Owns)).toBe(target);
    expect(rt.lastTagRelFrame).toBe(3);
  });

  it("ctx.addRelation through a tick bumps lastTagRelFrame at flush (applyCommand path)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Driver, { v: 0 }]] });
    const target = w.spawn();
    const Adder = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.addRelation(e, Links, target);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("add", [Adder])]);

    expect(w.getRelations(e, Links)).toContain(target);
    expect(rt.lastTagRelFrame).toBe(3);
  });

  it("ctx.removeRelation through a tick bumps lastTagRelFrame at flush (applyCommand path)", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Driver, { v: 0 }]] });
    const target = w.spawn();
    w.addRelation(e, Links, target); // edge present before the tick
    const Remover = defineSystem(defineQuery([Driver]), (_batch, ctx) => {
      ctx.removeRelation(e, Links, target);
    });

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    w.tick([phase("rmrel", [Remover])]);

    expect(w.getRelations(e, Links)).not.toContain(target);
    expect(rt.lastTagRelFrame).toBe(3);
  });
});

describe("stampWrites — 001 §3.1 route 1 (blanket over query-matching archetypes)", () => {
  it("stamps declared components across matching archetypes, guarded by hasComponent", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e1 = w.spawn({ components: [[Pos, { x: 0, y: 0 }], [Vel, { x: 0, y: 0 }]] }); // [Pos, Vel]
    const e2 = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // [Pos]
    const A = archOf(rt, e1);
    const B = archOf(rt, e2);
    const q = defineQuery([Pos]);

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    rt.stampWrites(q, [Pos, Vel]);

    expect(A.lastWrittenFrame[A.componentSlot(Pos.id)]).toBe(3);
    expect(B.lastWrittenFrame[B.componentSlot(Pos.id)]).toBe(3);
    expect(A.lastWrittenFrame[A.componentSlot(Vel.id)]).toBe(3); // present in A → stamped
    expect(B.componentSlot(Vel.id)).toBe(-1); // absent in B → the hasComponent guard skips it
  });

  it("does not touch archetypes outside the query's match set", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const inQ = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // [Pos] matches [Pos]
    const outQ = w.spawn({ components: [[Vel, { x: 0, y: 0 }]] }); // [Vel] does not
    const A = archOf(rt, inQ);
    const C = archOf(rt, outQ);
    const q = defineQuery([Pos]);

    rt.advanceFrame(); // frame 2
    rt.stampWrites(q, [Pos, Vel]);

    expect(A.lastWrittenFrame[A.componentSlot(Pos.id)]).toBe(2);
    // C holds Vel, but it is outside q's match set — scoping must keep it dark.
    expect(C.lastWrittenFrame[C.componentSlot(Vel.id)]).toBe(0);
  });

  it("seeds the match cache for a query that has never run", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const A = archOf(rt, e);
    const q = defineQuery([Pos]); // never dispatched

    rt.advanceFrame(); // frame 2
    rt.stampWrites(q, [Pos]); // must build + cache matches internally
    expect(A.lastWrittenFrame[A.componentSlot(Pos.id)]).toBe(2);
  });
});

describe("invalidateComponent — §2.2 escape hatch", () => {
  it("stamps every archetype that holds the component, and no others", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e1 = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // [Pos]
    const e2 = w.spawn({ components: [[Pos, { x: 0, y: 0 }], [Vel, { x: 0, y: 0 }]] }); // [Pos, Vel]
    const e3 = w.spawn({ components: [[Vel, { x: 0, y: 0 }]] }); // [Vel]
    const A = archOf(rt, e1);
    const B = archOf(rt, e2);
    const C = archOf(rt, e3);

    rt.advanceFrame();
    rt.advanceFrame(); // frame 3
    rt.invalidateComponent(Pos);

    expect(A.lastWrittenFrame[A.componentSlot(Pos.id)]).toBe(3);
    expect(B.lastWrittenFrame[B.componentSlot(Pos.id)]).toBe(3);
    expect(C.componentSlot(Pos.id)).toBe(-1); // [Vel] has no Pos column
    expect(B.lastWrittenFrame[B.componentSlot(Vel.id)]).toBe(0); // Vel columns untouched
    expect(C.lastWrittenFrame[C.componentSlot(Vel.id)]).toBe(0);
  });
});

describe("out-of-tick ordering (§4.1a — the off-by-one fix)", () => {
  it("stamps the current frame, and a write after advanceFrame is strictly greater than an observer's baseline", () => {
    const w = reactiveWorld();
    const rt = w.runtime;
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });

    const F = rt.frame; // an observer's lastSeenFrame baseline is < F
    w.edit(e).set(Pos, { x: 1, y: 1 });
    expect(writeStamp(rt, e, Pos)).toBe(F); // stamped against the CURRENT frame

    // The reactive layer advances at the END of notify(); a later out-of-tick write stamps F+1.
    rt.advanceFrame();
    const seen = writeStamp(rt, e, Pos); // what the just-finished pass observed (== F)
    w.edit(e).set(Pos, { x: 2, y: 2 });
    expect(writeStamp(rt, e, Pos)).toBe(F + 1);
    expect(writeStamp(rt, e, Pos)).toBeGreaterThan(seen); // observable at the next pass, never missed
  });
});

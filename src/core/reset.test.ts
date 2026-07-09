/**
 * `world.reset()` + `world.import(bytes, { replace: true })` (R3) — the in-place teardown that
 * replaces the world-swap document-open path. The contract under test:
 *
 * - NO ALIAS: every live slot is freed WITH a generation bump, so a pre-reset handle reads dead —
 *   never aliased to an entity later minted at the same slot (the swap hazard this removes).
 * - WorldObserver attachments SURVIVE; a single `onReset` fires AFTER teardown, never per-entity
 *   `onDestroy`.
 * - Reactive registrations SURVIVE and settle at the next `notify()`: Tier-1 wakes on the wipe,
 *   Tier-2/3 entity watches fire `undefined` once + self-remove, resource watches see the cleared
 *   value. Reset stamps at the CURRENT frame (a normal mutation burst) and does NOT advance it, so a
 *   watch subscribed after a reset but before the next notify is not fired for the reset.
 * - reset is rejected mid-tick and mid-emit (both would corrupt in-flight iteration).
 */

import { describe, expect, it } from "vitest";
import type { Entity, World } from "./index";
import {
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineSystem,
  defineTag,
  phase,
} from "./index";
import { genOf, slotOf } from "./entity";

// Process-global schema names, unique to this file (the registry has no reset in normal runs).
const Pos = defineComponent("RSTPos", { x: "f32", y: "f32" });
const Vel = defineComponent("RSTVel", { x: "f32", y: "f32" });
const Label = defineComponent("RSTLabel", { text: "string" }); // exercises string-column clearing
const Link = defineComponent("RSTLink", { target: "eid" }); // exercises eid remap through replace
const Selected = defineTag("RSTSelected");
const Rel = defineRelation("RSTRel", { arity: "one" });
const Cam = defineResource("RSTCam", { x: "f32", y: "f32", zoom: "f32" });

const posQ = defineQuery([Pos]);

function count(w: World, q = posQ): number {
  let n = 0;
  w.query(q).each((b) => {
    n += b.count;
  });
  return n;
}

describe("stale handles after reset (R3 no-alias)", () => {
  it("a pre-reset handle reads dead: isAlive false, get undefined, edit throws", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    expect(w.isAlive(e)).toBe(true);

    w.reset();

    expect(w.isAlive(e)).toBe(false);
    expect(w.get(e, Pos)).toBeUndefined();
    expect(w.has(e, Pos)).toBe(false);
    expect(() => w.edit(e).set(Pos, { x: 9, y: 9 })).toThrow(/dead or stale/);
    expect(count(w)).toBe(0);
  });

  it("a re-minted entity at the same slot is NOT the pre-reset handle (generation bumped)", () => {
    const w = createWorld();
    const before = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const slot = slotOf(before);

    w.reset();
    const after = w.spawn({ components: [[Pos, { x: 3, y: 4 }]] });

    // Same physical slot is reused, but the handle differs — the swap re-minted an IDENTICAL handle
    // (the verified hazard); the in-place bump guarantees a strictly-greater generation instead.
    expect(slotOf(after)).toBe(slot);
    expect(after).not.toBe(before);
    expect(genOf(after)).toBeGreaterThan(genOf(before));
    expect(w.isAlive(before)).toBe(false); // the stale handle stays dead — never aliases `after`
    expect(w.isAlive(after)).toBe(true);
    expect(w.get(before, Pos)).toBeUndefined();
    expect(w.read(after, Pos)).toEqual({ x: 3, y: 4 });
  });

  it("frees component-less entities in the empty archetype too", () => {
    const w = createWorld();
    const bareA = w.spawn(); // no components/tags → placed in the empty archetype
    const bareB = w.spawn();
    expect(w.isAlive(bareA)).toBe(true);
    w.reset();
    expect(w.isAlive(bareA)).toBe(false);
    expect(w.isAlive(bareB)).toBe(false);
  });
});

describe("WorldObserver semantics on reset (T0)", () => {
  it("fires onReset once, never per-entity onDestroy, and the roster survives", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    w.spawn({ components: [[Pos, { x: 3, y: 4 }]] });

    let spawns = 0;
    let destroys = 0;
    let resets = 0;
    w.observe({ onSpawn: () => spawns++, onDestroy: () => destroys++, onReset: () => resets++ });

    w.reset();
    expect(resets).toBe(1);
    expect(destroys).toBe(0); // wholesale reset must NOT emit one onDestroy per entity

    // The attachment survived — a subsequent spawn still notifies this same observer.
    w.spawn({ components: [[Pos, { x: 5, y: 6 }]] });
    expect(spawns).toBe(1);
    expect(resets).toBe(1);
  });

  it("import({ replace: true }) fires onReset then onSpawn per re-imported entity", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    w.spawn({ components: [[Pos, { x: 3, y: 4 }]] });
    const bytes = w.export();

    const events: string[] = [];
    w.observe({ onSpawn: () => events.push("spawn"), onReset: () => events.push("reset") });

    w.import(bytes, { replace: true });
    expect(events[0]).toBe("reset"); // teardown signal first…
    expect(events.filter((e) => e === "spawn")).toHaveLength(2); // …then a spawn per re-imported entity
    expect(events.filter((e) => e === "reset")).toHaveLength(1);
  });
});

describe("reactive Tier-1 (query) on reset", () => {
  it("survives reset and fires once at the next notify (membership wiped, behind reactiveOn)", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, () => fired++);
    w.reactive.notify(); // baseline — nothing stamped since registration
    expect(fired).toBe(0);

    w.reset(); // the [Pos] archetype held rows → its rows-version bumps
    w.reactive.notify();
    expect(fired).toBe(1);
  });

  it("survives reset + replace-import and fires once, then keeps working on later change", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    const bytes = w.export();
    let fired = 0;
    w.reactive.observeQuery(posQ, () => fired++);
    w.reactive.notify();
    expect(fired).toBe(0);

    w.import(bytes, { replace: true }); // reset (wipe) + reimport (refill) both stamp the archetype
    w.reactive.notify();
    expect(fired).toBe(1);

    // The watch's `matches` reference was NOT orphaned by the reset (archetype identity kept) — a
    // subsequent edit still wakes it.
    const e = w.firstOf(posQ) as Entity;
    w.edit(e).set(Pos, { x: 2, y: 2 });
    w.reactive.notify();
    expect(fired).toBe(2);
  });

  it("a row-filtered (tag) query wakes on reset via the tag/relation frame", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    w.addTag(e, Selected);
    const tagQ = defineQuery([Pos, Selected]);
    let fired = 0;
    w.reactive.observeQuery(tagQ, () => fired++);
    w.reactive.notify();
    expect(fired).toBe(0);

    w.reset();
    w.reactive.notify();
    expect(fired).toBe(1);
  });
});

describe("reactive frame coherence around reset (registration is a boundary)", () => {
  it("subscribe-before-reset observes the wipe", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, () => fired++);
    w.reactive.notify();
    w.reset();
    w.reactive.notify();
    expect(fired).toBe(1);
  });

  it("subscribe-after-reset-before-notify does NOT fire for the reset", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    void w.reactive; // arm stamping BEFORE the reset so the wipe is stamped
    w.reset();

    let fired = 0;
    w.reactive.observeQuery(posQ, () => fired++); // baselined AFTER the reset
    w.reactive.notify();
    expect(fired).toBe(0); // the wipe predates the subscription — not observed
  });
});

describe("reactive Tier-3 (value) on reset", () => {
  it("fires undefined exactly once and self-removes (the death path)", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    w.reset(); // e's generation bumps → the watch's handle is now dead
    w.reactive.notify();
    expect(seen).toEqual([undefined]);
    expect(w.reactive.peek(e, Pos)).toBeUndefined(); // box nulled — peek never serves the dead value

    w.reactive.notify();
    expect(seen).toEqual([undefined]); // self-removed — silent thereafter
  });
});

describe("reactive resources on reset (no death path — resources survive)", () => {
  it("a set resource fires undefined when reset clears it", () => {
    const w = createWorld();
    w.setResource(Cam, { x: 5, y: 0, zoom: 1 });
    const seen: unknown[] = [];
    w.reactive.observeResource(Cam, (v) => seen.push(v));

    w.reset();
    w.reactive.notify();
    expect(seen).toEqual([undefined]); // the cleared value is observed once
    expect(w.reactive.peekResource(Cam)).toBeUndefined();
  });

  it("a replace-import that re-sets the resource delivers the new value", () => {
    const w = createWorld();
    w.setResource(Cam, { x: 5, y: 0, zoom: 1 });
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    // Snapshot carries a DIFFERENT camera, so the round-trip is a real change.
    w.setResource(Cam, { x: 9, y: 9, zoom: 2 });
    const bytes = w.export();
    w.setResource(Cam, { x: 5, y: 0, zoom: 1 }); // back to the starting value before subscribing

    const seen: unknown[] = [];
    w.reactive.observeResource(Cam, (v) => seen.push(v));
    w.import(bytes, { replace: true }); // reset clears, then reimport sets {9,9,2}
    w.reactive.notify();
    expect(seen).toEqual([{ x: 9, y: 9, zoom: 2 }]);
  });
});

describe("reset rejection (mid-tick / mid-emit)", () => {
  it("throws when called from inside a system body (mid-tick)", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const Bad = defineSystem(posQ, () => w.reset(), { name: "RSTResetInTick" });
    expect(() => w.tick([phase("x", [Bad])])).toThrow(/reset only outside iteration/);
    // The ticking guard was cleared by the finally — reset works again afterward.
    expect(() => w.reset()).not.toThrow();
  });

  it("throws when called from inside a reactive callback (mid-emit) and leaves the world intact", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let threw = false;
    w.reactive.observeQuery(posQ, () => {
      try {
        w.reset();
      } catch {
        threw = true;
      }
    });
    w.edit(e).set(Pos, { x: 1, y: 0 });
    w.reactive.notify();
    expect(threw).toBe(true);
    expect(w.isAlive(e)).toBe(true); // the rejected reset did not tear anything down
  });
});

describe("import({ replace: true }) content fidelity", () => {
  it("round-trips content byte-for-byte on the same world (eid, string, tag, relation, resource)", () => {
    const w = createWorld();
    w.setResource(Cam, { x: 3, y: 4, zoom: 2 });
    const a = w.spawn({ components: [[Pos, { x: 1, y: 2 }], [Label, { text: "hello" }]] });
    const b = w.spawn({ components: [[Pos, { x: 5, y: 6 }], [Link, { target: a }]] });
    w.addTag(a, Selected);
    w.setRelation(b, Rel, a);
    const bytes1 = w.export();

    w.import(bytes1, { replace: true });
    const bytes2 = w.export();

    expect(new TextDecoder().decode(bytes2)).toBe(new TextDecoder().decode(bytes1));
    // and the content is actually live + re-wired (eid + relation resolved to the NEW handles)
    expect(count(w)).toBe(2);
    const a2 = w.firstOf(defineQuery([Pos, Label])) as Entity;
    const b2 = w.firstOf(defineQuery([Pos, Link])) as Entity;
    expect(w.read(a2, Label)).toEqual({ text: "hello" });
    expect(w.readField(b2, Link, "target")).toBe(a2); // eid remapped to the re-minted handle
    expect(w.getRelation(b2, Rel)).toBe(a2);
    expect(w.hasTag(a2, Selected)).toBe(true);
    expect(w.getResource(Cam)).toEqual({ x: 3, y: 4, zoom: 2 });
  });

  it("replace-import on a lived-in world equals a fresh import of the same bytes", () => {
    // Target snapshot (spawn-only content → deterministic archetype set).
    const src = createWorld();
    src.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    src.spawn({ components: [[Pos, { x: 2, y: 2 }], [Vel, { x: 0, y: 0 }]] });
    const bytes = src.export();

    // Fresh world importing the bytes.
    const fresh = createWorld();
    fresh.import(bytes);
    const freshBytes = fresh.export();

    // Lived-in world (its own prior content used the SAME archetypes) replace-imported.
    const lived = createWorld();
    lived.spawn({ components: [[Pos, { x: 9, y: 9 }]] });
    lived.spawn({ components: [[Pos, { x: 8, y: 8 }], [Vel, { x: 1, y: 1 }]] });
    lived.import(bytes, { replace: true });
    const livedBytes = lived.export();

    expect(new TextDecoder().decode(livedBytes)).toBe(new TextDecoder().decode(freshBytes));
  });

  it("plain import (no replace) still requires an empty world", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const bytes = w.export();
    expect(() => w.import(bytes)).toThrow(/requires an empty world/);
    expect(() => w.import(bytes, { replace: true })).not.toThrow(); // replace clears first
  });

  it("a schema-incompatible replace-import leaves the board intact (validates before reset)", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const bogus = new TextEncoder().encode(
      JSON.stringify({
        meta: { name: "x", format_version: 1 },
        resources: {},
        entities: [{ id: 0, components: { RSTNoSuchComponent: { a: 1 } }, tags: [], relations: {} }],
      }),
    );
    expect(() => w.import(bogus, { replace: true })).toThrow(/unknown component/);
    expect(count(w)).toBe(1); // the reset never ran — a failed document-open must not wipe the world
  });
});

describe("reset with reactivity never armed pays nothing (no stamps)", () => {
  it("clears content without arming any change-detection stamp", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    w.addTag(e, Selected);
    w.setResource(Cam, { x: 1, y: 1, zoom: 1 });

    w.reset(); // reactiveOn is false — the gated stamp sites are all skipped

    const rt = w.runtime;
    for (const arch of rt.archetypes()) {
      if (arch === undefined) continue;
      expect(arch.lastStructuralFrame).toBe(0);
    }
    expect(rt.tagFrame(Selected.id)).toBe(0); // reactivity never armed → the per-id membership stamp is 0
    expect(rt.resourceFrame(Cam.id)).toBe(0);
    expect(count(w)).toBe(0);
  });
});

describe("reset frees a large population without per-entity observer cost", () => {
  it("empties thousands of entities and re-imports cleanly", () => {
    const w = createWorld();
    for (let i = 0; i < 5000; i++) w.spawn({ components: [[Pos, { x: i, y: i }]] });
    expect(count(w)).toBe(5000);

    let destroys = 0;
    let resets = 0;
    w.observe({ onDestroy: () => destroys++, onReset: () => resets++ });

    w.reset();
    expect(count(w)).toBe(0);
    expect(resets).toBe(1);
    expect(destroys).toBe(0); // 5000-entity reset emitted ZERO per-entity callbacks

    // Reused slots stay honest — spawn again and read back.
    const e = w.spawn({ components: [[Pos, { x: 42, y: 42 }]] });
    expect(w.read(e, Pos)).toEqual({ x: 42, y: 42 });
  });
});

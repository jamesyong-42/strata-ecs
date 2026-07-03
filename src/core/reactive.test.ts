/**
 * The reactive observer layer (Patch Note 002 §3–4) — the three tiers, the settled `notify` point,
 * the §4.1a frame semantics, eager entity-death (§3.4), and the 001 Rule-3 dev enforcement that arms
 * when the first observer registers. Reached through `world.reactive`.
 *
 * Frame model (§4.1a): registration is a FRAME BOUNDARY — each `observe*` advances the store frame
 * and baselines the observer at `frame − 1`. So a change made in the same frame as registration is
 * observed at the very next `notify()`, while nothing stamped before the subscription ever fires.
 * No priming needed — the first regression below pins exactly that.
 */

import { describe, expect, it, vi } from "vitest";
import type { Batch, Entity, SystemCtx, Unsubscribe } from "./index";
import {
  Any,
  Related,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineSystem,
  defineTag,
  phase,
} from "./index";

// Unique process-global schema names for this file (schema has no reset in normal runs).
const Pos = defineComponent("RCTPos", { x: "f32", y: "f32" });
const Vel = defineComponent("RCTVel", { x: "f32", y: "f32" });
const Other = defineComponent("RCTOther", { n: "u32" });
const Driver = defineComponent("RCTDriver", { n: "u32" });
const Selected = defineTag("RCTSelected");
const Rel = defineRelation("RCTRel", { arity: "one" });
const Camera = defineResource("RCTCamera", { x: "f32", y: "f32", zoom: "f32" });

const posQ = defineQuery([Pos]);
const driverQ = defineQuery([Driver]);

describe("Tier 1 — query-level (002 §3.1)", () => {
  it("fires on a system's declared write (blanket route), and NOT when the system is runIf-gated off", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);

    const Mover = defineSystem(
      posQ,
      (b: Batch) => {
        const px = b.col(Pos).x as Float32Array;
        for (let i = 0; i < b.count; i++) px[b.rows[i]] += 1;
      },
      { name: "RCTMover", access: { write: [Pos] } },
    );
    w.tick([phase("move", [Mover])]);
    w.reactive.notify();
    expect(fired).toBe(1); // the blanket stamp of access.write drove the Tier-1 fire
    expect(w.read(e, Pos).x).toBe(1);

    // Gate the same writer off — it never runs, never stamps, so the observer stays quiet.
    fired = 0;
    const GatedMover = defineSystem(posQ, (b: Batch) => void b, { name: "RCTGatedMover", access: { write: [Pos] }, runIf: () => false });
    w.tick([phase("move", [GatedMover])]);
    w.reactive.notify();
    expect(fired).toBe(0);
  });

  it("membership fires on immediate spawn and destroy", () => {
    const w = createWorld();
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);

    const e = w.spawn({ components: [[Pos, { x: 1, y: 1 }]] }); // rows gained → structural bump
    w.reactive.notify();
    expect(fired).toBe(1);

    w.destroy(e); // rows lost → structural bump
    w.reactive.notify();
    expect(fired).toBe(2);
  });

  it("membership fires on ctx-flush spawn and ctx-flush destroy", () => {
    const w = createWorld();
    w.spawn({ components: [[Driver, { n: 1 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);

    let spawned: Entity | undefined;
    const Spawner = defineSystem(
      driverQ,
      (_b: Batch, ctx: SystemCtx) => {
        spawned = ctx.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
      },
      { name: "RCTSpawner" },
    );
    w.tick([phase("spawn", [Spawner])]);
    w.reactive.notify();
    expect(fired).toBe(1); // the [Pos] archetype was created + placed at flush

    const victim = spawned as Entity;
    const Reaper = defineSystem(driverQ, (_b: Batch, ctx: SystemCtx) => ctx.destroy(victim), { name: "RCTReaper" });
    w.tick([phase("reap", [Reaper])]);
    w.reactive.notify();
    expect(fired).toBe(2);
  });

  it("a row-filtered query fires on addTag/removeTag; a non-row-filtered query ignores pure tag churn", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const tagQ = defineQuery([Pos, Selected]); // Selected → a row filter (rowFiltered)
    let taggedFires = 0;
    let plainFires = 0;
    w.reactive.observeQuery(tagQ, [Pos], () => taggedFires++);
    w.reactive.observeQuery(posQ, [Pos], () => plainFires++);

    w.addTag(e, Selected); // moves no rows, changes tag-filtered membership only
    w.reactive.notify();
    expect(taggedFires).toBe(1);
    expect(plainFires).toBe(0); // pure tag churn is invisible to a non-row-filtered query

    w.removeTag(e, Selected);
    w.reactive.notify();
    expect(taggedFires).toBe(2);
    expect(plainFires).toBe(0);
  });

  it("a seeded Related(rel, target) query fires on setRelation/removeRelation (§4.2 membership)", () => {
    const w = createWorld();
    const target = w.spawn();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const relQ = defineQuery([Pos, Related(Rel, target)]); // concrete target → a seed, no row filter
    let fired = 0;
    w.reactive.observeQuery(relQ, [Pos], () => fired++);

    w.setRelation(e, Rel, target); // relation membership turns over, moving no rows
    w.reactive.notify();
    expect(fired).toBe(1);

    w.removeRelation(e, Rel, target);
    w.reactive.notify();
    expect(fired).toBe(2);
  });

  it("a quiet world fires nothing", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // pre-registration structural work
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);
    w.reactive.notify(); // nothing changed since registration
    w.reactive.notify();
    expect(fired).toBe(0);
  });

  it("invalidate(c) makes a Tier-1 observer fire (§2.2 escape hatch)", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);

    w.reactive.invalidate(Pos);
    w.reactive.notify();
    expect(fired).toBe(1);
  });
});

describe("frame semantics (002 §4.1a)", () => {
  it("a change in the same frame as registration is observed at the next notify — no priming (the off-by-one fix)", () => {
    // (a) subscribe → same-frame declared-writer tick → notify fires.
    const wa = createWorld();
    const ea = wa.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let firedA = 0;
    wa.reactive.observeQuery(posQ, [Pos], () => firedA++);
    const Mover = defineSystem(posQ, (b: Batch) => void b, { name: "RCTBoundaryMover", access: { write: [Pos] } });
    wa.tick([phase("move", [Mover])]);
    wa.reactive.notify();
    expect(firedA).toBe(1);
    expect(ea).toBeDefined();

    // (b) subscribe → same-frame out-of-tick edit → notify fires.
    const wb = createWorld();
    const eb = wb.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let firedB = 0;
    wb.reactive.observeQuery(posQ, [Pos], () => firedB++);
    wb.edit(eb).set(Pos, { x: 1, y: 1 });
    wb.reactive.notify();
    expect(firedB).toBe(1);
  });

  it("an out-of-tick world.edit() after a pass is observed at the next notify, then not re-observed", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);
    w.reactive.notify(); // a pass runs and advances the frame

    w.edit(e).set(Pos, { x: 1, y: 1 }); // an input handler between frames
    w.reactive.notify();
    expect(fired).toBe(1);

    w.reactive.notify();
    expect(fired).toBe(1); // not re-observed on a subsequent quiet pass
  });

  it("multiple ticks then one notify yields exactly one fire", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++);

    const Mover = defineSystem(posQ, (b: Batch) => void b, { name: "RCTMultiMover", access: { write: [Pos] } });
    const pipe = [phase("move", [Mover])];
    w.tick(pipe);
    w.tick(pipe);
    w.tick(pipe);
    w.reactive.notify();
    expect(fired).toBe(1); // three stamped ticks collapse to one settled fire
  });

  it("notify() with zero observers advances the frame; an observer registered later still sees a write", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    void w.reactive; // enable the layer without registering an observer
    const f0 = w.reactive.frame;
    w.reactive.notify();
    w.reactive.notify();
    w.reactive.notify();
    expect(w.reactive.frame).toBeGreaterThan(f0); // each empty notify advanced the frame (§4.1a)

    let fired = 0;
    w.reactive.observeQuery(posQ, [Pos], () => fired++); // registers after several empty passes
    w.edit(e).set(Pos, { x: 5, y: 0 });
    w.reactive.notify();
    expect(fired).toBe(1); // still baselined correctly against the current frame
  });
});

describe("Tier 2 — entity-level (002 §3.2)", () => {
  it("fires on a column stamp even when the value is equal", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    const seen: unknown[] = [];
    w.reactive.observeEntity(e, Pos, (v) => seen.push(v));

    w.edit(e).set(Pos, { x: 5, y: 0 }); // same value — still stamps the column
    w.reactive.notify();
    expect(seen).toEqual([{ x: 5, y: 0 }]); // Tier 2 is column-granular, not value-checked
  });
});

describe("Tier 3 — value-level (002 §3.3)", () => {
  it("suppresses equal values, fires on real change; peek always reads the CURRENT store value", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    w.edit(e).set(Pos, { x: 5, y: 0 }); // equal — suppressed
    w.reactive.notify();
    expect(seen).toHaveLength(0);
    expect(w.reactive.peek(e, Pos)).toStrictEqual({ x: 5, y: 0 });

    w.edit(e).set(Pos, { x: 9, y: 0 }); // real change — fires
    w.reactive.notify();
    expect(seen).toEqual([{ x: 9, y: 0 }]);
    // peek reads the STORE, never a watch's box (a first watch with a coarse eq must not be
    // able to starve other consumers — the adversarially-confirmed heisenbug). Reference
    // stability for useSyncExternalStore is the binding's ref-cache's job, not peek's.
    expect(w.reactive.peek(e, Pos)).toStrictEqual({ x: 9, y: 0 });
  });

  it("peek/peekResource are immune to a coexisting coarse-eq watch (registration order)", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 1 }]] });
    // A coarse watch registered FIRST — only cares about y. Its box will go stale on x-only
    // changes; peek must not serve it.
    w.reactive.observeValue(e, Pos, () => {}, (a, b) => (a as { y: number }).y === (b as { y: number }).y);
    const fired: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => fired.push(v)); // default eq, registered second
    w.edit(e).set(Pos, { x: 99, y: 1 }); // x-only change
    w.reactive.notify();
    expect(fired).toEqual([{ x: 99, y: 1 }]); // fine watch fires…
    expect(w.reactive.peek(e, Pos)).toStrictEqual({ x: 99, y: 1 }); // …and peek agrees with the store
  });

  it("honors a custom equality predicate", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    let fired = 0;
    // Consider values equal iff x matches — a y-only change must be suppressed.
    w.reactive.observeValue(
      e,
      Pos,
      () => fired++,
      (a, b) => a.x === b.x,
    );

    w.edit(e).set(Pos, { x: 5, y: 99 });
    w.reactive.notify();
    expect(fired).toBe(0); // custom eq ignores y

    w.edit(e).set(Pos, { x: 7, y: 99 });
    w.reactive.notify();
    expect(fired).toBe(1); // x changed
  });

  it("supports many watches on one (entity, component) cell — none evicts another", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = w.reactive.observeValue(e, Pos, (v) => a.push(v));
    w.reactive.observeValue(e, Pos, (v) => b.push(v));

    w.edit(e).set(Pos, { x: 9, y: 0 });
    w.reactive.notify();
    expect(a).toEqual([{ x: 9, y: 0 }]);
    expect(b).toEqual([{ x: 9, y: 0 }]); // both fired — the second did not evict the first

    offA(); // unsubscribe exactly one watch on the shared cell
    w.edit(e).set(Pos, { x: 12, y: 0 });
    w.reactive.notify();
    expect(a).toEqual([{ x: 9, y: 0 }]); // A is gone
    expect(b).toEqual([{ x: 9, y: 0 }, { x: 12, y: 0 }]); // B is still live
  });

  it("sees a value write made in the same frame as a migrate (the stamp is carried forward)", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    w.edit(e).set(Pos, { x: 9, y: 0 }); // stamps Pos in the OLD archetype
    w.addComponent(e, Other, { n: 1 }); // migrate [Pos] → [Pos, Other] in the same frame
    w.reactive.notify();
    expect(seen).toEqual([{ x: 9, y: 0 }]); // the pre-migrate stamp was carried into the destination
  });
});

describe("entity death and component removal (002 §3.4)", () => {
  it("an immediate destroy of a watched entity fires undefined exactly once and self-removes", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    w.destroy(e); // eager death hook queues the death
    w.reactive.notify();
    expect(seen).toEqual([undefined]);

    w.reactive.notify();
    expect(seen).toEqual([undefined]); // the watch removed itself — silent thereafter
  });

  it("a ctx-flush destroy of a watched entity fires undefined exactly once", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    w.spawn({ components: [[Driver, { n: 1 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    const Reaper = defineSystem(driverQ, (_b: Batch, ctx: SystemCtx) => ctx.destroy(e), { name: "RCTFlushReaper" });
    w.tick([phase("reap", [Reaper])]);
    w.reactive.notify();
    expect(seen).toEqual([undefined]);

    w.reactive.notify();
    expect(seen).toEqual([undefined]);
  });

  it("removing the watched component fires undefined once, keeps the watch, and re-add re-fires", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 5, y: 0 }]] });
    const seen: unknown[] = [];
    w.reactive.observeValue(e, Pos, (v) => seen.push(v));

    w.removeComponent(e, Pos); // entity lives; the watched column is gone
    w.reactive.notify();
    expect(seen).toEqual([undefined]);
    expect(w.reactive.peek(e, Pos)).toBeUndefined(); // the box is cleared, not left stale

    w.reactive.notify();
    expect(seen).toEqual([undefined]); // fired exactly once for the removal

    w.addComponent(e, Pos, { x: 7, y: 0 }); // re-add — the watch survived
    w.reactive.notify();
    expect(seen).toEqual([undefined, { x: 7, y: 0 }]);
    expect(w.reactive.peek(e, Pos)).toEqual({ x: 7, y: 0 });
  });
});

describe("reentrancy / robustness (002 §6)", () => {
  it("unsubscribing from inside a callback is safe and never skips a sibling", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let c1 = 0;
    let c2 = 0;
    let off1: Unsubscribe = () => {};
    off1 = w.reactive.observeQuery(posQ, [Pos], () => {
      c1++;
      off1(); // detach self mid-notify
    });
    w.reactive.observeQuery(posQ, [Pos], () => c2++);

    w.edit(e).set(Pos, { x: 1, y: 0 });
    w.reactive.notify();
    expect([c1, c2]).toEqual([1, 1]); // sibling still fired despite the self-detach

    w.edit(e).set(Pos, { x: 2, y: 0 });
    w.reactive.notify();
    expect([c1, c2]).toEqual([1, 2]); // the detached observer no longer fires
  });

  it("an observer unsubscribed by an earlier callback in the same pass does not fire", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    let c1 = 0;
    let c2 = 0;
    let offSecond: Unsubscribe = () => {};
    // First observer detaches the SECOND before its turn in this same pass.
    w.reactive.observeQuery(posQ, [Pos], () => {
      c1++;
      offSecond();
    });
    offSecond = w.reactive.observeQuery(posQ, [Pos], () => c2++);

    w.edit(e).set(Pos, { x: 1, y: 0 });
    w.reactive.notify();
    expect([c1, c2]).toEqual([1, 0]); // the dead flag skipped the second observer
  });

  it("a throwing callback is swallowed and never aborts the pass", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let sibling = 0;
    w.reactive.observeQuery(posQ, [Pos], () => {
      throw new Error("observer exploded");
    });
    w.reactive.observeQuery(posQ, [Pos], () => sibling++);

    w.edit(e).set(Pos, { x: 1, y: 0 });
    w.reactive.notify();
    expect(sibling).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("must not throw"));
    spy.mockRestore();
  });

  it("a structural mutation from inside a callback is DEV-rejected and not applied", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.reactive.observeQuery(posQ, [Pos], () => {
      w.addTag(e, Selected); // forbidden mid-notify — callbacks may only SCHEDULE work
    });

    w.edit(e).set(Pos, { x: 1, y: 0 });
    w.reactive.notify();
    expect(w.hasTag(e, Selected)).toBe(false); // the addTag was ignored
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("must not mutate"));
    spy.mockRestore();
  });
});

describe("001 Rule 3 enforcement (armed by the first observer)", () => {
  it("col() on an undeclared component throws in DEV, naming the system", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    w.reactive.observeQuery(posQ, [Pos], () => {}); // arms enforcement

    const BadReader = defineSystem(
      posQ,
      (b: Batch) => void b.col(Vel), // Vel is neither declared nor even present
      { name: "RCTBadReader", access: { write: [Pos] } },
    );
    expect(() => w.tick([phase("bad", [BadReader])])).toThrow(
      /RCTBadReader.*RCTVel|RCTVel.*RCTBadReader/,
    );
  });

  it("ctx.edit().set of an undeclared component throws (the edit chokepoint, Rule 2 case)", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // drives the [Pos] body
    const ve = w.spawn({ components: [[Vel, { x: 0, y: 0 }]] }); // written outside the query
    w.reactive.observeQuery(posQ, [Pos], () => {});

    const BadWriter = defineSystem(
      posQ,
      (_b: Batch, ctx: SystemCtx) => ctx.edit(ve).set(Vel, { x: 1, y: 1 }),
      { name: "RCTBadWriter", access: { write: [Pos] } }, // declares Pos, writes Vel
    );
    expect(() => w.tick([phase("bad", [BadWriter])])).toThrow(/RCTBadWriter/);
  });

  it("a pure-reader system reading its query components is fine", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 3, y: 4 }]] });
    w.reactive.observeQuery(posQ, [Pos], () => {});

    let sum = 0;
    const Reader = defineSystem(
      posQ,
      (b: Batch) => {
        const px = b.col(Pos).x as Float32Array; // Pos is a query component → allowed with no access decl
        for (let i = 0; i < b.count; i++) sum += px[b.rows[i]];
      },
      { name: "RCTPureReader" },
    );
    expect(() => w.tick([phase("read", [Reader])])).not.toThrow();
    expect(sum).toBe(3);
  });

  it("a component that appears only inside a mixed Any(...) is a legal read", () => {
    const w = createWorld();
    w.spawn({ components: [[Pos, { x: 3, y: 0 }], [Vel, { x: 2, y: 0 }]] }); // matches [Pos, Any(Vel, Selected)] via Vel
    w.reactive.observeQuery(posQ, [Pos], () => {}); // arms enforcement

    const anyQ = defineQuery([Pos, Any(Vel, Selected)]); // mixed Any → a row filter carrying Vel
    let sum = 0;
    const AnyReader = defineSystem(
      anyQ,
      (b: Batch) => {
        const vx = b.col(Vel).x as Float32Array; // Vel is an Any-member → a legal read, no access decl
        for (let i = 0; i < b.count; i++) sum += vx[b.rows[i]];
      },
      { name: "RCTAnyReader" },
    );
    expect(() => w.tick([phase("read", [AnyReader])])).not.toThrow();
    expect(sum).toBe(2);
  });

  it("a world with no observers never enforces (undeclared writes run freely)", () => {
    const w = createWorld(); // world.reactive is never touched → disarmed
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const Writer = defineSystem(
      posQ,
      (_b: Batch, ctx: SystemCtx) => ctx.edit(e).set(Pos, { x: 42, y: 0 }), // no access declared
      { name: "RCTUnenforcedWriter" },
    );
    expect(() => w.tick([phase("write", [Writer])])).not.toThrow();
    expect(w.read(e, Pos).x).toBe(42);
  });
});

describe("master gate + advisory diagnostics wiring", () => {
  it("a world that never touches world.reactive leaves every change-detection stamp at 0", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    w.edit(e).set(Pos, { x: 1, y: 0 }); // value write
    w.addTag(e, Selected); // tag/relation membership
    const Mover = defineSystem(
      posQ,
      (b: Batch) => {
        const px = b.col(Pos).x as Float32Array;
        for (let i = 0; i < b.count; i++) px[b.rows[i]] += 1;
      },
      { name: "RCTGateMover", access: { write: [Pos] } },
    );
    w.tick([phase("move", [Mover])]); // a declared writer — would blanket-stamp if reactive were on
    w.addComponent(e, Other, { n: 1 }); // migrate
    w.setResource(Camera, { x: 1, y: 2, zoom: 1 }); // resource write

    const rt = w.runtime;
    for (const arch of rt.archetypes()) {
      if (arch === undefined) continue;
      expect(arch.lastStructuralFrame).toBe(0);
      for (let i = 0; i < arch.lastWrittenFrame.length; i++) expect(arch.lastWrittenFrame[i]).toBe(0);
    }
    expect(rt.lastTagRelFrame).toBe(0);
    expect(rt.resourceFrame(Camera.id)).toBe(0); // setResource did not stamp — reactive never armed (003 §1.2)
  });

  it("validatePipelineAccess warns once in a reactive world on a read-before-write phase; a never-reactive world never warns", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Reactive-touched world: a reader of Pos positioned before a writer of Pos in one phase.
    const w = createWorld();
    void w.reactive;
    w.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const Reader = defineSystem(posQ, () => {}, { name: "RCTDiagReader" });
    const Writer = defineSystem(posQ, () => {}, { name: "RCTDiagWriter", access: { write: [Pos] } });
    const pipe = [phase("p", [Reader, Writer])];
    w.tick(pipe);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    w.tick(pipe);
    expect(spy.mock.calls.length).toBe(afterFirst); // dedup: analyzed once per pipeline object

    // A never-reactive world with the same shape never runs the diagnostic.
    spy.mockClear();
    const w2 = createWorld();
    w2.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const pipe2 = [
      phase("p", [
        defineSystem(posQ, () => {}, { name: "RCTDiagReader2" }),
        defineSystem(posQ, () => {}, { name: "RCTDiagWriter2", access: { write: [Pos] } }),
      ]),
    ];
    w2.tick(pipe2);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("resource reactivity (003 §1)", () => {
  it("fires on setResource + notify", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 0, y: 0, zoom: 1 });
    const seen: unknown[] = [];
    w.reactive.observeResource(Camera, (v) => seen.push(v));

    w.setResource(Camera, { x: 5, y: 0, zoom: 1 });
    w.reactive.notify();
    expect(seen).toEqual([{ x: 5, y: 0, zoom: 1 }]);
  });

  it("suppresses an equal-value setResource (a new object with the same fields)", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 5, y: 0, zoom: 1 });
    let fired = 0;
    w.reactive.observeResource(Camera, () => fired++);

    w.setResource(Camera, { x: 5, y: 0, zoom: 1 }); // fresh object, identical fields
    w.reactive.notify();
    expect(fired).toBe(0); // default shallow-eq over fields suppresses it
  });

  it("honors a custom equality predicate", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 0, y: 0, zoom: 1 });
    let fired = 0;
    // Consider the resource equal iff zoom matches — pan-only changes are suppressed.
    w.reactive.observeResource(Camera, () => fired++, (a, b) => a.zoom === b.zoom);

    w.setResource(Camera, { x: 99, y: 99, zoom: 1 });
    w.reactive.notify();
    expect(fired).toBe(0); // zoom unchanged

    w.setResource(Camera, { x: 99, y: 99, zoom: 2 });
    w.reactive.notify();
    expect(fired).toBe(1); // zoom changed
  });

  it("observes a setResource made in the same frame as registration — no priming", () => {
    const w = createWorld();
    const seen: unknown[] = [];
    w.reactive.observeResource(Camera, (v) => seen.push(v)); // Camera is unset here

    w.setResource(Camera, { x: 1, y: 2, zoom: 3 }); // same frame as registration
    w.reactive.notify();
    expect(seen).toEqual([{ x: 1, y: 2, zoom: 3 }]);
  });

  it("observes an out-of-tick setResource made between two notifies", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 0, y: 0, zoom: 1 });
    let fired = 0;
    w.reactive.observeResource(Camera, () => fired++);
    w.reactive.notify(); // a pass runs and advances the frame

    w.setResource(Camera, { x: 4, y: 0, zoom: 1 }); // between passes
    w.reactive.notify();
    expect(fired).toBe(1);

    w.reactive.notify();
    expect(fired).toBe(1); // not re-observed on a quiet pass
  });

  it("peekResource returns a stable reference across quiet notifies and a fresh one after a change", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 5, y: 0, zoom: 1 });
    w.reactive.observeResource(Camera, () => {});
    const ref0 = w.reactive.peekResource(Camera);

    w.reactive.notify(); // quiet
    expect(w.reactive.peekResource(Camera)).toBe(ref0);

    w.setResource(Camera, { x: 9, y: 0, zoom: 1 });
    w.reactive.notify();
    const ref1 = w.reactive.peekResource(Camera);
    expect(ref1).not.toBe(ref0);
    expect(ref1).toEqual({ x: 9, y: 0, zoom: 1 });
  });

  it("supports many watches on one resource — none evicts another; unsubscribe removes just one", () => {
    const w = createWorld();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = w.reactive.observeResource(Camera, (v) => a.push(v));
    w.reactive.observeResource(Camera, (v) => b.push(v));

    w.setResource(Camera, { x: 9, y: 0, zoom: 1 });
    w.reactive.notify();
    expect(a).toEqual([{ x: 9, y: 0, zoom: 1 }]);
    expect(b).toEqual([{ x: 9, y: 0, zoom: 1 }]);

    offA();
    w.setResource(Camera, { x: 12, y: 0, zoom: 1 });
    w.reactive.notify();
    expect(a).toEqual([{ x: 9, y: 0, zoom: 1 }]); // A is gone
    expect(b).toEqual([{ x: 9, y: 0, zoom: 1 }, { x: 12, y: 0, zoom: 1 }]); // B still live
  });

  it("baselines an unset resource to an undefined box; the first set fires with the value", () => {
    const w = createWorld();
    const seen: unknown[] = [];
    w.reactive.observeResource(Camera, (v) => seen.push(v)); // Camera never set
    expect(w.reactive.peekResource(Camera)).toBeUndefined();

    w.setResource(Camera, { x: 1, y: 2, zoom: 3 });
    w.reactive.notify();
    expect(seen).toEqual([{ x: 1, y: 2, zoom: 3 }]);
    expect(w.reactive.peekResource(Camera)).toEqual({ x: 1, y: 2, zoom: 3 });
  });

  it("unsubscribing a resource watch from inside its own callback is safe", () => {
    const w = createWorld();
    let fired = 0;
    let off: Unsubscribe = () => {};
    off = w.reactive.observeResource(Camera, () => {
      fired++;
      off();
    });

    w.setResource(Camera, { x: 1, y: 0, zoom: 1 });
    w.reactive.notify();
    expect(fired).toBe(1);

    w.setResource(Camera, { x: 2, y: 0, zoom: 1 });
    w.reactive.notify();
    expect(fired).toBe(1); // detached — no further fire
  });

  it("a resource watch does not survive into a fresh world (each World has its own Reactive)", () => {
    const w1 = createWorld();
    w1.setResource(Camera, { x: 1, y: 0, zoom: 1 });
    let fired1 = 0;
    w1.reactive.observeResource(Camera, () => fired1++);
    const r1 = w1.reactive;

    // A world swap re-mints the World + its Reactive (002 §6 — registries die with their world).
    const w2 = createWorld();
    expect(w2.reactive).not.toBe(r1);
    w2.setResource(Camera, { x: 99, y: 0, zoom: 1 });
    w2.reactive.notify();
    expect(fired1).toBe(0); // w1's watch is untouched by w2's activity

    w1.setResource(Camera, { x: 5, y: 0, zoom: 1 });
    w1.reactive.notify();
    expect(fired1).toBe(1); // …and still live on its own world
  });
});

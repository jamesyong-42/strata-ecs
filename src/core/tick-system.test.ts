/**
 * Petition 5 — system execution semantics.
 *
 * Two changes under test: (1) the non-empty batch invariant — zero-match row-filtered chunks are
 * never delivered, so every batch a body or `world.query` callback sees has `count ≥ 1`; (2) tick
 * systems — `defineTickSystem(body)` runs exactly once per dispatch regardless of archetype count,
 * with `ctx.query` as the sanctioned in-body walk, attributed to the running system for access
 * enforcement (001 Rule 3) and write stamping (001 §3.1 route 1, generalized to inner walks).
 */

import { describe, expect, it, vi } from "vitest";
import {
  createWorld,
  defineComponent,
  defineQuery,
  defineSystem,
  defineTag,
  defineTickSystem,
  phase,
  Not,
  type Batch,
  type Pipeline,
} from "./index";
import { effectiveRead, validatePipelineAccess } from "./access-diagnostics";

const Pos = defineComponent("TS5Pos", { x: "f32" });
const Vel = defineComponent("TS5Vel", { dx: "f32" });
const Aux = defineComponent("TS5Aux", { n: "u32" });
const Wheel = defineComponent("TS5Wheel", { d: "f32" });
const Sel = defineTag("TS5Sel");
const Surface = defineTag("TS5Surface");

/** Spawn one entity per distinct archetype so tag-only queries see several match candidates. */
function seedThreeArchetypes(world: ReturnType<typeof createWorld>): void {
  world.spawn({ components: [[Pos, { x: 0 }]] });
  world.spawn({ components: [[Pos, { x: 0 }], [Vel, { dx: 0 }]] });
  world.spawn({ components: [[Aux, { n: 0 }]] });
}

describe("zero-match chunks are not delivered (petition 5 — the non-empty batch invariant)", () => {
  it("a tag-only query across populated archetypes invokes nothing when no row carries the tag", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    let calls = 0;
    world.query(defineQuery([Surface])).each(() => calls++);
    expect(calls).toBe(0);
  });

  it("tagging one row delivers exactly one batch with count 1 — and every batch has count ≥ 1", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    const e = world.spawn({ components: [[Pos, { x: 7 }]], tags: [Sel] });
    const q = defineQuery([Pos, Sel]);
    const counts: number[] = [];
    let seen = 0;
    world.query(q).each((b) => {
      counts.push(b.count);
      for (const r of b) if (b.entity(r) === e) seen++;
    });
    expect(counts).toEqual([1]);
    expect(seen).toBe(1);
  });

  it("a chunk SYSTEM anchored on a tag stops running when nothing matches (the anchor-abuse killer)", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    let calls = 0;
    const sys = defineSystem(defineQuery([Surface]), () => calls++, { name: "anchored" });
    const pipeline: Pipeline = [phase("p", [sys])];
    world.tick(pipeline);
    expect(calls).toBe(0); // no tagged row anywhere → zero invocations, not one per archetype

    world.spawn({ components: [[Pos, { x: 0 }]], tags: [Surface] });
    world.tick(pipeline);
    expect(calls).toBe(1); // one matching row → exactly one batch
  });

  it("Not(tag) mirrors: all rows tagged → nothing delivered; untag-shaped spawn → one batch", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 1 }]], tags: [Sel] });
    world.spawn({ components: [[Pos, { x: 2 }]], tags: [Sel] });
    const q = defineQuery([Pos, Not(Sel)]);
    let calls = 0;
    world.query(q).each(() => calls++);
    expect(calls).toBe(0);

    world.spawn({ components: [[Pos, { x: 3 }]] });
    const counts: number[] = [];
    world.query(q).each((b) => counts.push(b.count));
    expect(counts).toEqual([1]);
  });

  it("world.count is unchanged by the skip (sums to the same totals)", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    expect(world.count(defineQuery([Surface]))).toBe(0);
    world.spawn({ components: [[Pos, { x: 0 }]], tags: [Surface] });
    expect(world.count(defineQuery([Surface]))).toBe(1);
  });
});

describe("defineTickSystem — once per dispatch (petition 5 P2)", () => {
  it("runs exactly once per tick, independent of archetype count (the cameraControl shape)", () => {
    const world = createWorld();
    let integrated = 0;
    const tick = defineTickSystem(() => {
      integrated += 50; // non-idempotent global effect — the class the per-chunk form multiplied
    });
    const pipeline: Pipeline = [phase("sim", [tick])];

    world.tick(pipeline); // empty world
    expect(integrated).toBe(50);

    seedThreeArchetypes(world); // three populated archetypes
    world.tick(pipeline);
    expect(integrated).toBe(100); // still exactly once — not once per archetype
  });

  it("contrast pin: a chunk system's body IS per matching chunk (the two-form model)", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0 }]] });
    world.spawn({ components: [[Pos, { x: 0 }], [Vel, { dx: 0 }]] });
    let calls = 0;
    const sys = defineSystem(defineQuery([Pos]), () => calls++);
    world.tick([phase("p", [sys])]);
    expect(calls).toBe(2); // two archetypes hold Pos — per-chunk cardinality, documented and kept
  });

  it("runIf composes: a skipped dispatch is zero invocations", () => {
    const world = createWorld();
    let calls = 0;
    let enabled = false;
    const tick = defineTickSystem(() => calls++, { name: "gated", runIf: () => enabled });
    const pipeline: Pipeline = [phase("p", [tick])];
    world.tick(pipeline);
    expect(calls).toBe(0);
    enabled = true;
    world.tick(pipeline);
    expect(calls).toBe(1);
  });

  it("round-trips name/access/runIf; name falls back to the body fn's name", () => {
    const runIf = () => true;
    const named = defineTickSystem(() => {}, { name: "cameraControl", access: { write: [Pos] }, runIf });
    expect(named.name).toBe("cameraControl");
    expect(named.access).toEqual({ write: [Pos] });
    expect(named.runIf).toBe(runIf);
    expect(named.query).toBeUndefined();

    const fromFn = defineTickSystem(function pointerIngest() {});
    expect(fromFn.name).toBe("pointerIngest");
  });

  it("ctx shape changes defer to the phase boundary; immediate world structural calls throw", () => {
    const world = createWorld();
    let duringBody: number | undefined;
    let structuralThrew = false;
    const q = defineQuery([Aux]);
    const tick = defineTickSystem((ctx) => {
      ctx.spawn({ components: [[Aux, { n: 1 }]] }); // deferred — lands at the phase boundary
      duringBody = world.count(q);
      try {
        world.spawn(); // immediate structural mutation inside a system body — §A4 uniform law
      } catch {
        structuralThrew = true;
      }
    });
    world.tick([phase("p", [tick])]);
    expect(duringBody).toBe(0); // not yet flushed while the body runs
    expect(structuralThrew).toBe(true); // tick bodies run under the same guard as chunk bodies
    expect(world.count(q)).toBe(1); // flushed at the phase boundary
  });

  it("world.tick cannot be driven from inside a tick body (no system drives the frame)", () => {
    const world = createWorld();
    let threw: Error | undefined;
    const inner: Pipeline = [phase("inner", [])];
    const tick = defineTickSystem(() => {
      try {
        world.tick(inner);
      } catch (err) {
        threw = err as Error;
      }
    });
    world.tick([phase("p", [tick])]);
    expect(threw?.message).toMatch(/cannot run during query iteration|cannot run inside another tick/);
  });

  it("telemetry: onSystemRun fires once per dispatch with ran=true; skipped reports ran=false", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    const runs: [string, boolean][] = [];
    world.observe({ onSystemRun: (_ph, sys, ran) => void runs.push([sys, ran]) });
    const tick = defineTickSystem(() => {}, { name: "fx" });
    const gated = defineTickSystem(() => {}, { name: "off", runIf: () => false });
    world.tick([phase("p", [tick, gated])]);
    expect(runs).toEqual([
      ["fx", true],
      ["off", false],
    ]);
  });
});

describe("ctx.query — the sanctioned in-body walk (petition 5 P1/P3)", () => {
  it("a tick body sees ALL matching rows across archetypes in one dispatch (the arbitration shape)", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 1 }]] });
    world.spawn({ components: [[Pos, { x: 2 }], [Vel, { dx: 0 }]] });
    world.spawn({ components: [[Pos, { x: 4 }], [Aux, { n: 0 }]] });
    const q = defineQuery([Pos]);
    let bodyRuns = 0;
    let total = 0;
    const tick = defineTickSystem((ctx) => {
      bodyRuns++;
      ctx.query(q).each((b: Batch) => {
        const x = b.col(Pos).x;
        for (const r of b) total += x[r];
      });
    });
    world.tick([phase("p", [tick])]);
    expect(bodyRuns).toBe(1); // one top-level invocation…
    expect(total).toBe(7); // …that saw every row across three archetypes in one pass
  });

  it("inner walks never deliver empty batches either", () => {
    const world = createWorld();
    seedThreeArchetypes(world);
    let batches = 0;
    const tick = defineTickSystem((ctx) => {
      ctx.query(defineQuery([Surface])).each(() => batches++);
    });
    world.tick([phase("p", [tick])]);
    expect(batches).toBe(0);
  });

  it("raw col() writes through an inner walk are STAMPED — a row-filtered observer wakes (the closed hole)", () => {
    const world = createWorld();
    world.spawn({ components: [[Wheel, { d: 1 }]] });
    world.spawn({ components: [[Wheel, { d: 2 }], [Aux, { n: 0 }]] }); // second archetype, outside any top query
    const qWheel = defineQuery([Wheel]);
    const wakes = vi.fn();
    world.reactive.observeQuery(qWheel, wakes);
    world.reactive.notify();
    const before = wakes.mock.calls.length;

    // A tick system has NO top-level query — without per-walk stamping its raw column writes
    // would be invisible to route-1 blanket stamping (the may-miss petition 5 closes).
    const tick = defineTickSystem(
      (ctx) => {
        ctx.query(qWheel).each((b) => {
          const d = b.col(Wheel).d;
          for (const r of b) d[r] += 1;
        });
      },
      { name: "wheelDamp", access: { write: [Wheel], read: [Wheel] } },
    );
    world.tick([phase("p", [tick])]);
    world.reactive.notify();
    expect(wakes.mock.calls.length).toBeGreaterThan(before);
  });

  it("world.query used inside a body stamps identically (the two surfaces cannot diverge)", () => {
    const world = createWorld();
    world.spawn({ components: [[Wheel, { d: 1 }]] });
    const qWheel = defineQuery([Wheel]);
    const wakes = vi.fn();
    world.reactive.observeQuery(qWheel, wakes);
    world.reactive.notify();
    const before = wakes.mock.calls.length;

    const tick = defineTickSystem(
      () => {
        world.query(qWheel).each((b) => {
          const d = b.col(Wheel).d;
          for (const r of b) d[r] += 1;
        });
      },
      { name: "wheelDampViaWorld", access: { write: [Wheel], read: [Wheel] } },
    );
    world.tick([phase("p", [tick])]);
    world.reactive.notify();
    expect(wakes.mock.calls.length).toBeGreaterThan(before);
  });

  it("an onSystemRun observer that walks world.query inherits NO attribution (review fix)", () => {
    // Attribution must end with the body: telemetry callbacks run user code, and an inspector that
    // reads via world.query must not stamp the just-ran system's writes over its own query.
    const world = createWorld();
    world.spawn({ components: [[Wheel, { d: 1 }]] });
    const qWheel = defineQuery([Wheel]);
    const wakes = vi.fn();
    world.reactive.observeQuery(qWheel, wakes);
    world.reactive.notify();
    const before = wakes.mock.calls.length;

    // The system declares Wheel writes but its query matches a DIFFERENT archetype and its body
    // writes nothing — so no stamp may reach qWheel from this dispatch.
    const sys = defineSystem(defineQuery([Aux]), () => {}, { name: "idleW", access: { write: [Wheel] } });
    world.spawn({ components: [[Aux, { n: 0 }]] });
    world.observe({ onSystemRun: () => world.query(qWheel).each(() => {}) });
    world.tick([phase("p", [sys])]);
    world.reactive.notify();
    expect(wakes.mock.calls.length).toBe(before);
  });

  it("out-of-tick world.query never stamps (attribution is system-scoped)", () => {
    const world = createWorld();
    world.spawn({ components: [[Wheel, { d: 1 }]] });
    const qWheel = defineQuery([Wheel]);
    const wakes = vi.fn();
    world.reactive.observeQuery(qWheel, wakes);
    world.reactive.notify();
    const before = wakes.mock.calls.length;
    world.query(qWheel).each(() => {}); // a pure read walk outside any system
    world.reactive.notify();
    expect(wakes.mock.calls.length).toBe(before);
  });

  it("access enforcement charges inner-walk col() reads to the RUNNING system (af8fbe5 pin)", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 1 }]] });
    world.reactive.observeQuery(defineQuery([Aux]), () => {}); // arm reactivity + DEV enforcement
    const q = defineQuery([Pos]);
    let threw: Error | undefined;
    const tick = defineTickSystem(
      (ctx) => {
        ctx.query(q).each((b) => {
          try {
            b.col(Pos); // undeclared: tick systems have NO default read set (001 §2.3 amendment)
          } catch (err) {
            threw = err as Error;
          }
        });
      },
      { name: "undeclaredReader" },
    );
    world.tick([phase("p", [tick])]);
    expect(threw?.message).toMatch(/access|declare/);
  });
});

describe("diagnostics compose across both forms (001 §3.3 / §2.3)", () => {
  it("effectiveRead of a queryless system: explicit read wins; the default is ∅", () => {
    const declared = defineTickSystem(() => {}, { access: { read: [Pos, Vel] } });
    expect(effectiveRead(declared).map((c) => c.name).sort()).toEqual(["TS5Pos", "TS5Vel"]);
    const bare = defineTickSystem(() => {});
    expect(effectiveRead(bare)).toEqual([]);
  });

  it("advisory (a) sees a tick writer and a chunk writer as a same-phase writer pair", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chunkWriter = defineSystem(defineQuery([Aux]), () => {}, { name: "chunkW", access: { write: [Aux] } });
    const tickWriter = defineTickSystem(() => {}, { name: "tickW", access: { write: [Aux] } });
    validatePipelineAccess([phase("p", [chunkWriter, tickWriter])]);
    const warns = spy.mock.calls.map((c) => String(c[0])).filter((m) => /order-dependence/.test(m));
    spy.mockRestore();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("TS5Aux");
  });
});

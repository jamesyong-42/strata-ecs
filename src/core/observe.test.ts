import { describe, expect, it, vi } from "vitest";
import type { Batch, Entity, SystemCtx } from "./index";
import { createWorld, defineComponent, defineQuery, defineRelation, defineSystem, defineTag, phase } from "./index";

// Unique process-global schema names for this file (schema has no reset in normal runs).
const Pos = defineComponent("OBSPos", { x: "f32", y: "f32" });
const Marked = defineTag("OBSMarked");
const Owns = defineRelation("OBSOwns", { arity: "one" });
const Driver = defineComponent("OBSDriver", { n: "u32" });

const driverQ = defineQuery([Driver]);
const posQ = defineQuery([Pos]);

describe("world.observe — lifecycle hooks (observe.ts)", () => {
  it("onSpawn fires once for world.spawn, after placement (components readable in the hook)", () => {
    const w = createWorld();
    const seen: { e: Entity; placed: boolean; x: number | undefined }[] = [];
    w.observe({
      onSpawn: (e) => seen.push({ e, placed: w.isPlaced(e), x: w.readField(e, Pos, "x") }),
    });
    const e = w.spawn({ components: [[Pos, { x: 7, y: 8 }]], tags: [Marked] });
    expect(seen).toHaveLength(1);
    expect(seen[0].e).toBe(e);
    expect(seen[0].placed).toBe(true);
    expect(seen[0].x).toBe(7);
  });

  it("onDestroy fires before teardown — component, tag, and relation still readable", () => {
    const w = createWorld();
    const target = w.spawn();
    const e = w.spawn({ components: [[Pos, { x: 3, y: 4 }]], tags: [Marked] });
    w.setRelation(e, Owns, target);
    const seen: { x: number | undefined; tagged: boolean; rel: Entity | undefined }[] = [];
    w.observe({
      onDestroy: (dying) => {
        if (dying !== e) return;
        seen.push({
          x: w.readField(e, Pos, "x"),
          tagged: w.hasTag(e, Marked),
          rel: w.getRelation(e, Owns),
        });
      },
    });
    w.destroy(e);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ x: 3, tagged: true, rel: target });
    expect(w.isAlive(e)).toBe(false);
    // double destroy is a no-op: no second event
    w.destroy(e);
    expect(seen).toHaveLength(1);
  });

  it("ctx.spawn fires onSpawn exactly once, at the eager identity mint (placement at flush)", () => {
    const w = createWorld();
    w.spawn({ components: [[Driver, { n: 1 }]] });
    const births: { e: Entity; identityOnly: boolean }[] = [];
    w.observe({ onSpawn: (e) => births.push({ e, identityOnly: w.isIdentityOnly(e) }) });
    const spawner = defineSystem(
      driverQ,
      (_b: Batch, ctx: SystemCtx) => {
        ctx.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
      },
      { name: "Spawner" },
    );
    w.tick([phase("spawn", [spawner])]);
    expect(births).toHaveLength(1); // mint only — flush placement must NOT fire a second event
    expect(births[0].identityOnly).toBe(true);
    expect(w.isPlaced(births[0].e)).toBe(true); // placed by the phase flush
    expect(w.readField(births[0].e, Pos, "x")).toBe(1);
  });

  it("a deferred ctx.destroy fires onDestroy at flush, pre-teardown", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Pos, { x: 9, y: 9 }]] });
    const seen: (number | undefined)[] = [];
    w.observe({ onDestroy: (dying) => seen.push(w.readField(dying, Pos, "x")) });
    const reaper = defineSystem(
      posQ,
      (b: Batch, ctx: SystemCtx) => {
        for (const r of b) ctx.destroy(b.entity(r));
      },
      { name: "Reaper" },
    );
    w.tick([phase("reap", [reaper])]);
    expect(seen).toEqual([9]);
    expect(w.isAlive(e)).toBe(false);
  });

  it("detach stops events; multiple observers each fire", () => {
    const w = createWorld();
    let a = 0;
    let b = 0;
    const offA = w.observe({ onSpawn: () => a++ });
    w.observe({ onSpawn: () => b++ });
    w.spawn();
    expect([a, b]).toEqual([1, 1]);
    offA();
    w.spawn();
    expect([a, b]).toEqual([1, 2]);
    offA(); // second detach is a no-op
    w.spawn();
    expect([a, b]).toEqual([1, 3]);
  });

  it("snapshot import fires onSpawn per loaded entity, scalar fields readable in the hook", () => {
    const w1 = createWorld();
    for (let i = 0; i < 5; i++) w1.spawn({ components: [[Pos, { x: i, y: 0 }]] });
    const bytes = w1.export();
    const w2 = createWorld();
    const xs: (number | undefined)[] = [];
    w2.observe({ onSpawn: (e) => xs.push(w2.readField(e, Pos, "x")) });
    w2.import(bytes);
    expect(xs.length).toBe(5);
    expect([...xs].sort((a, b) => (a as number) - (b as number))).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("world.observe — robustness (adversarial-review findings)", () => {
  it("a throwing observer cannot abort a flush mid-drain: every queued command still applies", () => {
    const w = createWorld();
    const e1 = w.spawn({ components: [[Pos, { x: 1, y: 0 }]] });
    const e2 = w.spawn({ components: [[Pos, { x: 2, y: 0 }]] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.observe({
      onDestroy: () => {
        throw new Error("panel exploded");
      },
    });
    const reaper = defineSystem(
      posQ,
      (b: Batch, ctx: SystemCtx) => {
        for (const r of b) ctx.destroy(b.entity(r));
      },
      { name: "Reaper" },
    );
    w.tick([phase("reap", [reaper])]);
    expect(w.isAlive(e1)).toBe(false); // neither destroy is stranded by the observer's throw
    expect(w.isAlive(e2)).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("must not throw"));
    spy.mockRestore();
  });

  it("an observer detaching itself mid-event never skips a sibling (copy-on-write roster)", () => {
    const w = createWorld();
    let bSaw = 0;
    const offA: (() => void)[] = [];
    offA.push(w.observe({ onSpawn: () => offA[0]() }));
    w.observe({ onSpawn: () => bSaw++ });
    w.spawn();
    expect(bSaw).toBe(1); // B still received the event A detached during
    w.spawn();
    expect(bSaw).toBe(2);
  });

  it("a spawn that fails validation mints no identity and fires no onSpawn", () => {
    const w = createWorld();
    let births = 0;
    w.observe({ onSpawn: () => births++ });
    const before = w.runtime.liveCount();
    expect(() => w.spawn({ components: [[Pos, { x: 1 } as never]] })).toThrow(); // y has no default
    expect(births).toBe(0);
    expect(w.runtime.liveCount()).toBe(before); // no leaked live identity
  });

  it("DEV diagnostic: mutating the world from inside a callback is reported; reentrant destroy is ignored", () => {
    const w = createWorld();
    const bystander = w.spawn();
    const e = w.spawn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.observe({ onDestroy: () => w.destroy(bystander) });
    w.destroy(e);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("must not mutate"));
    expect(w.isAlive(bystander)).toBe(true); // the forbidden reentrant destroy did not run
    expect(w.isAlive(e)).toBe(false); // the outer destroy completed normally
    spy.mockRestore();
  });

  it("tick telemetry snapshots the roster at tick entry — a mid-tick attach starts next tick", () => {
    const w = createWorld();
    w.spawn({ components: [[Driver, { n: 1 }]] });
    const late: number[] = [];
    let attached = false;
    w.observe({
      onTickStart: () => {
        if (!attached) {
          attached = true;
          w.observe({ onTickEnd: (t) => late.push(t) });
        }
      },
    });
    const noop = defineSystem(driverQ, () => {}, { name: "Noop" });
    w.tick([phase("p", [noop])]);
    expect(late).toEqual([]); // not delivered to the tick it was attached during
    w.tick([phase("p", [noop])]);
    expect(late).toEqual([2]);
  });
});

describe("world.observe — tick instrumentation + tickCount", () => {
  it("tickCount increments per tick and is delivered to onTickStart/onTickEnd in order", () => {
    const w = createWorld();
    w.spawn({ components: [[Driver, { n: 1 }]] });
    const log: string[] = [];
    w.observe({
      onTickStart: (t) => log.push(`start:${t}`),
      onSystemRun: (ph, sys, ran) => log.push(`sys:${ph}/${sys}:${ran}`),
      onPhaseFlush: (ph) => log.push(`flush:${ph}`),
      onTickEnd: (t, micros) => {
        expect(micros).toBeGreaterThanOrEqual(0);
        log.push(`end:${t}`);
      },
    });
    const noop = defineSystem(driverQ, () => {}, { name: "Noop" });
    const pipeline = [phase("p1", [noop])];
    expect(w.tickCount).toBe(0);
    w.tick(pipeline);
    w.tick(pipeline);
    expect(w.tickCount).toBe(2);
    expect(log).toEqual([
      "start:1",
      "sys:p1/Noop:true",
      "flush:p1",
      "end:1",
      "start:2",
      "sys:p1/Noop:true",
      "flush:p1",
      "end:2",
    ]);
  });

  it("runIf-gated systems and phases report ran=false; a gated phase never flushes", () => {
    const w = createWorld();
    w.spawn({ components: [[Driver, { n: 1 }]] });
    const runs: [string, string, boolean, number][] = [];
    const flushes: string[] = [];
    w.observe({
      onSystemRun: (ph, sys, ran, micros) => runs.push([ph, sys, ran, micros]),
      onPhaseFlush: (ph) => flushes.push(ph),
    });
    const on = defineSystem(driverQ, () => {}, { name: "On" });
    const gated = defineSystem(driverQ, () => {}, { name: "Gated", runIf: () => false });
    const inDark = defineSystem(driverQ, () => {}, { name: "InDark" });
    w.tick([phase("live", [on, gated]), phase("dark", [inDark], { runIf: () => false })]);
    expect(runs).toEqual([
      ["live", "On", true, expect.any(Number)],
      ["live", "Gated", false, 0],
      ["dark", "InDark", false, 0],
    ]);
    expect(runs[0][3]).toBeGreaterThanOrEqual(0);
    expect(flushes).toEqual(["live"]); // the gated-off phase has no phase boundary
  });

  it("system names: opts.name wins, a named function body is the fallback, else 'system'", () => {
    const named = defineSystem(driverQ, () => {}, { name: "Explicit" });
    function BodyName(_b: Batch, _ctx: SystemCtx): void {}
    const fromFn = defineSystem(driverQ, BodyName);
    const anon = defineSystem(driverQ, () => {});
    expect(named.name).toBe("Explicit");
    expect(fromFn.name).toBe("BodyName");
    expect(anon.name).toBe("system");
  });
});

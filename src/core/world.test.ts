import { describe, expect, it, vi } from "vitest";
import { createWorld, type InboundSource, type World } from "./world";
import { defineComponent, defineRelation, defineResource, defineTag } from "./schema";
import { All, Not, type Query, defineQuery } from "./query";
import { defineSystem, phase } from "./system";
import type { Entity } from "./entity";

const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });
const Health = defineComponent("Health", { hp: "u16" });
const Link = defineComponent("Link", { target: "eid" });
const Marker = defineTag("Marker");
const Trigger = defineTag("Trigger");
const Targets = defineRelation("Targets", { arity: "many" });
const ChildOf = defineRelation("ChildOf", { arity: "one" });
const Config = defineResource("Config", { enabled: "bool" });

function count(w: World, q: Query): number {
  let n = 0;
  w.runtime.query(q).each((b) => {
    for (const _r of b) n++;
  });
  return n;
}

describe("world.* immediate mutation", () => {
  it("applies structural changes immediately outside a tick", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 1, y: 2 }]] });
    expect(w.read(e, Position)).toEqual({ x: 1, y: 2 });
    w.addComponent(e, Velocity, { x: 3, y: 4 });
    expect(w.read(e, Velocity)).toEqual({ x: 3, y: 4 }); // visible at once
    w.addTag(e, Marker);
    expect(w.hasTag(e, Marker)).toBe(true);
  });
});

describe("systems — the hot loop", () => {
  it("runs a value-writing system every tick over raw columns", () => {
    const Movement = defineSystem(defineQuery([Position, Velocity]), (batch) => {
      const P = batch.col(Position);
      const V = batch.col(Velocity);
      for (const r of batch) {
        (P.x as Float32Array)[r] += (V.x as Float32Array)[r];
        (P.y as Float32Array)[r] += (V.y as Float32Array)[r];
      }
    });
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 2 }]] });
    const pipeline = [phase("sim", [Movement])];
    w.tick(pipeline);
    expect(w.read(e, Position)).toEqual({ x: 1, y: 2 });
    w.tick(pipeline);
    expect(w.read(e, Position)).toEqual({ x: 2, y: 4 }); // buffer reuse across ticks
  });
});

describe("deferral timing (§5.2, §7)", () => {
  it("ctx.spawn returns a usable handle immediately; the entity is placed at the phase boundary", () => {
    let spawned: Entity | undefined;
    let aliveInside = false;
    const Spawner = defineSystem(defineQuery([Marker]), (batch, ctx) => {
      for (const _r of batch) {
        spawned = ctx.spawn({ components: [[Position, { x: 9, y: 9 }]] });
        aliveInside = ctx.isAlive(spawned); // identity is eager
      }
    });
    const w = createWorld();
    w.spawn({ tags: [Marker] });
    w.tick([phase("spawn", [Spawner])]);
    expect(aliveInside).toBe(true);
    expect(w.isPlaced(spawned as Entity)).toBe(true); // placed at flush
    expect(w.read(spawned as Entity, Position)).toEqual({ x: 9, y: 9 });
  });

  it("shape changes are visible in a LATER phase, not the same phase", () => {
    const AddHealth = defineSystem(defineQuery([Position, Not(Health)]), (batch, ctx) => {
      for (const r of batch) ctx.addComponent(batch.entity(r), Health, { hp: 100 });
    });
    let seen = 0;
    const CountHealth = defineSystem(defineQuery([Health]), (batch) => {
      for (const _r of batch) seen++;
    });

    // Same phase: CountHealth runs before AddHealth's flush → sees nothing.
    const w1 = createWorld();
    w1.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    w1.spawn({ components: [[Position, { x: 1, y: 1 }]] });
    seen = 0;
    w1.tick([phase("both", [AddHealth, CountHealth])]);
    expect(seen).toBe(0);

    // Separate phases: phase 2 sees what phase 1 added (visible at the boundary).
    const w2 = createWorld();
    w2.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    w2.spawn({ components: [[Position, { x: 1, y: 1 }]] });
    seen = 0;
    w2.tick([phase("add", [AddHealth]), phase("count", [CountHealth])]);
    expect(seen).toBe(2);
  });

  it("value writes are immediate and order-sensitive within a phase", () => {
    const Double = defineSystem(defineQuery([Position]), (batch, ctx) => {
      for (const r of batch) {
        const e = batch.entity(r);
        const p = ctx.read(e, Position);
        ctx.edit(e).set(Position, { x: p.x * 2, y: p.y });
      }
    });
    const AddOne = defineSystem(defineQuery([Position]), (batch, ctx) => {
      for (const r of batch) {
        const e = batch.entity(r);
        const p = ctx.read(e, Position);
        ctx.edit(e).set(Position, { x: p.x + 1, y: p.y });
      }
    });
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 5, y: 0 }]] });
    w.tick([phase("v", [Double, AddOne])]); // AddOne sees Double's immediate write
    expect(w.read(e, Position).x).toBe(11); // (5*2)+1
  });

  it("a single system sees its own value write on a LATER row (§7.2)", () => {
    const w = createWorld();
    const a = w.spawn({ components: [[Position, { x: 1, y: 0 }]] }); // row 0 (spawned first)
    w.spawn({ components: [[Position, { x: 2, y: 0 }]] }); // row 1
    let laterRowSawUpdate = false;
    const System = defineSystem(defineQuery([Position]), (batch, ctx) => {
      for (const r of batch) {
        const e = batch.entity(r);
        if (e === a) ctx.edit(a).set(Position, { x: 100, y: 0 }); // write on a's row
        else laterRowSawUpdate = ctx.read(a, Position).x === 100; // later row reads a's fresh value
      }
    });
    w.tick([phase("v", [System])]);
    expect(laterRowSawUpdate).toBe(true);
  });
});

describe("no coalescing (§5.4)", () => {
  it("ctx.spawn then ctx.destroy in one phase is a transient with no net effect", () => {
    const SpawnDestroy = defineSystem(defineQuery([Trigger]), (batch, ctx) => {
      for (const _r of batch) {
        const tmp = ctx.spawn({ components: [[Position, { x: 0, y: 0 }]] });
        ctx.destroy(tmp);
      }
    });
    const w = createWorld();
    w.spawn({ tags: [Trigger] });
    const before = count(w, defineQuery([Position]));
    w.tick([phase("x", [SpawnDestroy])]);
    expect(count(w, defineQuery([Position]))).toBe(before); // net zero
  });

  it("a shape change enqueued after the entity's despawn is dropped (validate-on-read)", () => {
    const w = createWorld();
    const target = w.spawn();
    w.spawn({ tags: [Trigger] });
    const DestroyRelate = defineSystem(defineQuery([Trigger]), (batch, ctx) => {
      for (const r of batch) {
        const e = batch.entity(r);
        ctx.destroy(e);
        ctx.addRelation(e, Targets, target); // e is despawned at flush → this is skipped
      }
    });
    w.tick([phase("x", [DestroyRelate])]);
    expect(w.getReverse(target, Targets)).toEqual([]); // the relation was never created
  });

  it("two systems adding the same component in one phase: first wins, second is a dev-error skip", () => {
    const AddOne = defineSystem(defineQuery([Marker]), (batch, ctx) => {
      for (const r of batch) ctx.addComponent(batch.entity(r), Health, { hp: 1 });
    });
    const AddTwo = defineSystem(defineQuery([Marker]), (batch, ctx) => {
      for (const r of batch) ctx.addComponent(batch.entity(r), Health, { hp: 2 });
    });
    const w = createWorld();
    const e = w.spawn({ tags: [Marker] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.tick([phase("both", [AddOne, AddTwo])]);
    expect(spy).toHaveBeenCalled(); // dev-mode error for the second add — assert before restoring
    spy.mockRestore();
    expect(w.read(e, Health)).toEqual({ hp: 1 }); // first add won; second was skipped
  });

  it("drops a deferred relation whose TARGET was destroyed earlier the same phase (both arities)", () => {
    const w = createWorld();
    const source = w.spawn({ tags: [Marker] });
    const targetOne = w.spawn();
    const targetMany = w.spawn();
    const System = defineSystem(defineQuery([Marker]), (batch, ctx) => {
      for (const r of batch) {
        const e = batch.entity(r);
        ctx.destroy(targetOne);
        ctx.setRelation(e, ChildOf, targetOne); // arity-one; target dead at flush → dropped
        ctx.destroy(targetMany);
        ctx.addRelation(e, Targets, targetMany); // arity-many; target dead at flush → dropped
      }
    });
    w.tick([phase("x", [System])]);
    expect(w.getRelation(source, ChildOf)).toBeUndefined();
    expect(w.getRelations(source, Targets)).toEqual([]);
  });

  it("removeComponent that is absent at flush is a dev-warn skip, not a throw", () => {
    const RemoveA = defineSystem(defineQuery([Health]), (batch, ctx) => {
      for (const r of batch) ctx.removeComponent(batch.entity(r), Health);
    });
    const RemoveB = defineSystem(defineQuery([Health]), (batch, ctx) => {
      for (const r of batch) ctx.removeComponent(batch.entity(r), Health);
    });
    const w = createWorld();
    const e = w.spawn({ components: [[Health, { hp: 3 }]] });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => w.tick([phase("both", [RemoveA, RemoveB])])).not.toThrow();
    expect(spy).toHaveBeenCalled(); // second remove found it absent → warn (no throw)
    spy.mockRestore();
    expect(w.has(e, Health)).toBe(false); // first remove still took effect
  });
});

describe("run conditions & sync", () => {
  it("gates a phase on a resource flag via runIf", () => {
    let ran = 0;
    const Gated = defineSystem(defineQuery([All(Position)]), (batch) => {
      for (const _r of batch) ran++;
    });
    const enabled = (ctx: import("./system").SystemCtx) => ctx.getResource(Config)?.enabled === true;
    const w = createWorld();
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });

    w.setResource(Config, { enabled: false });
    w.tick([phase("g", [Gated], { runIf: enabled })]);
    expect(ran).toBe(0); // phase skipped

    w.setResource(Config, { enabled: true });
    w.tick([phase("g", [Gated], { runIf: enabled })]);
    expect(ran).toBe(1);
  });

  it("gates an individual system on its own runIf, independent of its siblings", () => {
    let aRan = 0;
    let bRan = 0;
    const A = defineSystem(defineQuery([Position]), (batch) => {
      for (const _r of batch) aRan++;
    });
    const B = defineSystem(
      defineQuery([Position]),
      (batch) => {
        for (const _r of batch) bRan++;
      },
      { runIf: (ctx) => ctx.getResource(Config)?.enabled === true },
    );
    const w = createWorld();
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });

    w.setResource(Config, { enabled: false });
    w.tick([phase("p", [A, B])]);
    expect(aRan).toBe(1); // sibling still runs
    expect(bRan).toBe(0); // B gated off by its own runIf

    w.setResource(Config, { enabled: true });
    w.tick([phase("p", [A, B])]);
    expect(bRan).toBe(1); // B now runs
  });

  it("sync() is a no-op in a pure Part I world", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 1, y: 1 }]] });
    expect(() => w.sync()).not.toThrow();
    expect(w.read(e, Position)).toEqual({ x: 1, y: 1 });
  });
});

describe("conformance-audit fixes", () => {
  it("surfaces a ctx.spawn schema error at the call site, not mid-flush (§4/§5.5)", () => {
    const BadSpawner = defineSystem(defineQuery([Marker]), (batch, ctx) => {
      for (const _r of batch) ctx.spawn({ components: [[Health, {} as { hp: number }]] }); // missing hp
    });
    const w = createWorld();
    w.spawn({ tags: [Marker] });
    expect(() => w.tick([phase("x", [BadSpawner])])).toThrow(/missing required field "hp"/);
    // The buffer was released despite the throw — a later tick still works.
    expect(() => w.tick([phase("y", [])])).not.toThrow();
  });

  it("exposes readField for an eid field and batch.columns", () => {
    const w = createWorld();
    const target = w.spawn({ components: [[Position, { x: 1, y: 1 }]] });
    w.spawn({ components: [[Link, { target }]] });
    let viaReadField: Entity | undefined;
    let viaColumns = -1;
    const S = defineSystem(defineQuery([Link]), (batch, ctx) => {
      const linkTarget = batch.columns.Link.target as Uint32Array; // name-keyed convenience
      for (const r of batch) {
        viaColumns = linkTarget[r];
        viaReadField = ctx.readField(batch.entity(r), Link, "target"); // eid decoded by name
      }
    });
    w.tick([phase("read", [S])]);
    expect(viaReadField).toBe(target); // ctx.readField decoded the eid field
    expect(viaColumns).toBe(target); // batch.columns exposed the raw column
    expect(w.readField(w.firstOf(defineQuery([Link])) as Entity, Link, "target")).toBe(target); // World.readField too
  });
});

describe("the iterationDepth guard (006 §A4)", () => {
  const posQ = defineQuery([Position]);

  it("every structural world.* throws inside a world.query().each body; the board is untouched", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 0, y: 0 }], [Health, { hp: 3 }]] });
    const other = w.spawn({ components: [[Position, { x: 1, y: 1 }]] });

    // Each thunk opens a fresh iteration and issues one structural op from inside it. eachGuarded's
    // finally restores the depth after every throw, so the thunks are independent.
    const inBody = (fn: () => void) => () => w.query(posQ).each(() => fn());

    expect(inBody(() => w.spawn({ components: [[Position, { x: 2, y: 2 }]] }))).toThrow(
      /world\.spawn\(\) cannot run during query iteration/,
    );
    expect(inBody(() => w.destroy(other))).toThrow(/world\.destroy\(\)/);
    expect(inBody(() => w.addComponent(e, Velocity, { x: 0, y: 0 }))).toThrow(/world\.addComponent\(\)/);
    expect(inBody(() => w.removeComponent(e, Health))).toThrow(/world\.removeComponent\(\)/);
    expect(inBody(() => w.addTag(e, Marker))).toThrow(/world\.addTag\(\)/);
    expect(inBody(() => w.removeTag(e, Marker))).toThrow(/world\.removeTag\(\)/);
    expect(inBody(() => w.setRelation(e, ChildOf, other))).toThrow(/world\.setRelation\(\)/);
    expect(inBody(() => w.addRelation(e, Targets, other))).toThrow(/world\.addRelation\(\)/);
    expect(inBody(() => w.removeRelation(e, Targets, other))).toThrow(/world\.removeRelation\(\)/);
    expect(inBody(() => w.import(new Uint8Array()))).toThrow(/world\.import\(\)/);
    expect(inBody(() => w.reset())).toThrow(/world\.reset\(\) cannot run during query iteration/);

    // Nothing landed: every attempt threw at the facade before delegating to the store.
    expect(w.isAlive(other)).toBe(true);
    expect(w.has(e, Health)).toBe(true);
    expect(w.has(e, Velocity)).toBe(false);
    expect(w.hasTag(e, Marker)).toBe(false);
  });

  it("value writes (edit().set, setResource, removeResource) succeed mid-iteration — they reorder no columns", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    w.setResource(Config, { enabled: true });

    w.query(posQ).each(() => {
      w.edit(e).set(Position, { x: 9, y: 9 }); // value write — exempt
      w.setResource(Config, { enabled: false }); // resource value — exempt
      w.removeResource(Config); // resource remove — value-shaped, exempt
    });

    expect(w.read(e, Position)).toEqual({ x: 9, y: 9 });
    expect(w.getResource(Config)).toBeUndefined();
  });

  it("a nested query keeps the guard armed at every depth, and depth unwinds to 0 after", () => {
    const w = createWorld();
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    w.spawn({ components: [[Velocity, { x: 0, y: 0 }]] });
    const velQ = defineQuery([Velocity]);
    let innerRan = false;
    let outerResumed = false;

    w.query(posQ).each(() => {
      expect(() => w.spawn()).toThrow(/query iteration/); // depth 1
      w.query(velQ).each(() => {
        innerRan = true;
        expect(() => w.addTag(w.firstOf(posQ) as Entity, Marker)).toThrow(/query iteration/); // depth 2
      });
      outerResumed = true;
      expect(() => w.destroy(w.firstOf(posQ) as Entity)).toThrow(/query iteration/); // back to depth 1, still armed
    });

    expect(innerRan).toBe(true);
    expect(outerResumed).toBe(true);
    expect(() => w.spawn()).not.toThrow(); // depth back to 0 — structural ops work again
  });

  it("a structural world.* inside a system body throws during tick(), and the depth unwinds", () => {
    const w = createWorld();
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    const Bad = defineSystem(posQ, () => {
      w.spawn({ components: [[Position, { x: 1, y: 1 }]] }); // world.spawn (not ctx.spawn) mid-tick
    });
    expect(() => w.tick([phase("x", [Bad])])).toThrow(/query iteration/);
    expect(() => w.spawn()).not.toThrow(); // the finally unwound the depth
  });

  it("the guard is unconditional — it fires even in a world that never armed reactivity", () => {
    // 001 Rule-3 enforcement only arms once an observer exists; this guard does not ride that gate
    // (a mid-iteration migration is memory corruption in every build), so it throws with reactive off.
    const w = createWorld(); // w.reactive never touched → reactiveOn stays false
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(() => {
      w.query(posQ).each(() => w.addComponent(w.firstOf(posQ) as Entity, Velocity, { x: 0, y: 0 }));
    }).toThrow(/query iteration/);
  });
});

describe("sync() boundary guards (005 §5.5 / 006 §C2)", () => {
  const posQ = defineQuery([Position]);

  it("throws when called mid query-iteration (all builds)", () => {
    const w = createWorld();
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(() => w.query(posQ).each(() => w.sync())).toThrow(
      /world\.sync\(\) cannot run during query iteration/,
    );
  });

  it("the in-emit guard throws directly when the store is inside an observer/reactive emit", () => {
    const w = createWorld();
    const prev = w.runtime.setObserverEmit(true);
    try {
      expect(() => w.sync()).toThrow(/from inside an observer or reactive callback/);
    } finally {
      w.runtime.setObserverEmit(prev);
    }
  });

  it("DEV-throws from inside a WorldObserver callback (swallowed by the emit wrapper, then reported)", () => {
    const w = createWorld();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.observe({ onSpawn: () => w.sync() }); // onSpawn runs with inObserverEmit set
    w.spawn({ components: [[Position, { x: 0, y: 0 }]] });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("world.sync() cannot run from inside an observer or reactive callback"),
    );
    spy.mockRestore();
  });

  it("DEV-throws from inside a reactive callback (swallowed, then reported)", () => {
    const w = createWorld();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    w.setResource(Config, { enabled: true });
    w.reactive.observeResource(Config, () => w.sync());
    w.setResource(Config, { enabled: false }); // a real change → fires the callback at notify
    w.reactive.notify();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("world.sync() cannot run from inside an observer or reactive callback"),
    );
    spy.mockRestore();
  });

  it("drains normally outside iteration and emit", () => {
    const w = createWorld();
    let drained = 0;
    w.registerInboundSource({ drain: () => void drained++ });
    w.sync();
    w.sync();
    expect(drained).toBe(2);
  });
});

describe("unregisterInboundSource (005 §6.2)", () => {
  it("a registered source drains on sync; after unregister it never drains again", () => {
    const w = createWorld();
    let drained = 0;
    const src: InboundSource = { drain: () => void drained++ };
    w.registerInboundSource(src);
    w.sync();
    expect(drained).toBe(1);

    w.unregisterInboundSource(src);
    w.sync();
    w.sync();
    expect(drained).toBe(1); // never drained after removal (teardown step 0, §5.6)
  });

  it("unregistering an unknown source is a no-op and leaves registered sources draining", () => {
    const w = createWorld();
    let drained = 0;
    const known: InboundSource = { drain: () => void drained++ };
    w.registerInboundSource(known);

    expect(() => w.unregisterInboundSource({ drain: () => {} })).not.toThrow(); // never registered
    w.sync();
    expect(drained).toBe(1); // the known source still drains
  });
});

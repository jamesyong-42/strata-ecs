/**
 * miniplex scenario implementations — idiomatic fastest form: an archetypal AoS world where entities
 * are plain objects and components are named nested objects. Every query is compiled ONCE in setup()
 * via `world.with(...)` (a connected, auto-maintained bucket) and iterated with `for..of` in run().
 * Structural ops use `world.add` / `world.remove` (entity_cycle) and `world.addComponent` /
 * `world.removeComponent` (add_remove); the entity object identity is preserved across runs, so the
 * cached entity references stay valid for mitata's repeated invocations.
 */

import { World } from "miniplex";
import { type LibraryBench, N, RANDOM_ACCESS, type Scenario, accessIndex } from "../contract.ts";

type Val = { value: number };
type Vec = { x: number; y: number };

// --- packed_5 -----------------------------------------------------------------
type P5Entity = { a: Val; b: Val; c: Val; d: Val; e: Val };

const packed_5: Scenario = {
  id: "packed_5",
  setup() {
    const world = new World<P5Entity>();
    for (let i = 0; i < N.packed; i++) {
      world.add({
        a: { value: 0 },
        b: { value: 0 },
        c: { value: 0 },
        d: { value: 0 },
        e: { value: 0 },
      });
    }
    return {
      qa: world.with("a"),
      qb: world.with("b"),
      qc: world.with("c"),
      qd: world.with("d"),
      qe: world.with("e"),
    };
  },
  run(state) {
    const s = state as {
      qa: Iterable<P5Entity>;
      qb: Iterable<P5Entity>;
      qc: Iterable<P5Entity>;
      qd: Iterable<P5Entity>;
      qe: Iterable<P5Entity>;
    };
    for (const e of s.qa) e.a.value += 1;
    for (const e of s.qb) e.b.value += 1;
    for (const e of s.qc) e.c.value += 1;
    for (const e of s.qd) e.d.value += 1;
    for (const e of s.qe) e.e.value += 1;
    let sum = 0;
    for (const e of s.qa) sum += e.a.value;
    return sum;
  },
};

// --- simple_iter --------------------------------------------------------------
type SIEntity = { a?: Vec; b?: Vec; c?: Vec; d?: Vec; e?: Vec };

const simple_iter: Scenario = {
  id: "simple_iter",
  setup() {
    const world = new World<SIEntity>();
    const off: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4 };
    const layouts: (keyof SIEntity)[][] = [
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
      ["a", "b", "c", "e"],
    ];
    for (const layout of layouts) {
      for (let i = 0; i < N.simplePerLayout; i++) {
        const ent: SIEntity = {};
        for (const k of layout) {
          ent[k] = { x: (i % 97) + off[k as string], y: i % 97 };
        }
        world.add(ent);
      }
    }
    return {
      qab: world.with("a", "b"),
      qcd: world.with("c", "d"),
      qce: world.with("c", "e"),
      qa: world.with("a"),
    };
  },
  run(state) {
    const s = state as {
      qab: Iterable<Required<Pick<SIEntity, "a" | "b">>>;
      qcd: Iterable<Required<Pick<SIEntity, "c" | "d">>>;
      qce: Iterable<Required<Pick<SIEntity, "c" | "e">>>;
      qa: Iterable<Required<Pick<SIEntity, "a">>>;
    };
    for (const e of s.qab) {
      const t = e.a.x;
      e.a.x = e.b.x;
      e.b.x = t;
    }
    for (const e of s.qcd) {
      const t = e.c.x;
      e.c.x = e.d.x;
      e.d.x = t;
    }
    for (const e of s.qce) {
      const t = e.c.x;
      e.c.x = e.e.x;
      e.e.x = t;
    }
    let sum = 0;
    for (const e of s.qa) sum += e.a.x;
    return sum;
  },
};

// --- frag_iter ----------------------------------------------------------------
type FragEntity = Record<string, Val>;

const frag_iter: Scenario = {
  id: "frag_iter",
  setup() {
    const world = new World<FragEntity>();
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    for (const l of letters) {
      for (let i = 0; i < N.fragPerType; i++) {
        world.add({ [l]: { value: 0 }, data: { value: 0 } });
      }
    }
    return { qData: world.with("data"), qZ: world.with("z") };
  },
  run(state) {
    const s = state as { qData: Iterable<FragEntity>; qZ: Iterable<FragEntity> };
    for (const e of s.qData) e.data.value += 1;
    for (const e of s.qZ) e.z.value += 1;
    let sum = 0;
    for (const e of s.qData) sum += e.data.value;
    for (const e of s.qZ) sum += e.z.value;
    return sum;
  },
};

// --- entity_cycle -------------------------------------------------------------
type CycleEntity = { a?: Val; b?: Val };

const entity_cycle: Scenario = {
  id: "entity_cycle",
  setup() {
    const world = new World<CycleEntity>();
    for (let i = 0; i < N.cycle; i++) world.add({ a: { value: 1 } });
    return { world, qB: world.with("b") };
  },
  run(state) {
    const s = state as {
      world: World<CycleEntity>;
      qB: Iterable<Required<Pick<CycleEntity, "b">>>;
    };
    const spawned: CycleEntity[] = [];
    for (let i = 0; i < N.cycle; i++) {
      spawned.push(s.world.add({ b: { value: 1 } }));
    }
    let sum = 0;
    for (const e of s.qB) sum += e.b.value;
    for (const e of spawned) s.world.remove(e);
    return sum;
  },
};

// --- add_remove ---------------------------------------------------------------
type AREntity = { a?: Val; b?: Val };

const add_remove: Scenario = {
  id: "add_remove",
  setup() {
    const world = new World<AREntity>();
    const ents: AREntity[] = [];
    for (let i = 0; i < N.addRemove; i++) ents.push(world.add({ a: { value: 1 } }));
    return { world, ents, qB: world.with("b") };
  },
  run(state) {
    const s = state as {
      world: World<AREntity>;
      ents: AREntity[];
      qB: Iterable<Required<Pick<AREntity, "b">>>;
    };
    for (const e of s.ents) s.world.addComponent(e, "b", { value: 1 });
    let sum = 0;
    for (const e of s.qB) sum += e.b.value;
    for (const e of s.ents) s.world.removeComponent(e, "b");
    return sum;
  },
};

// --- extension: random_access -------------------------------------------------
type RAEntity = { p: Val };

const random_access: Scenario = {
  id: "random_access",
  setup() {
    const world = new World<RAEntity>();
    const handles = new Array<RAEntity>(RANDOM_ACCESS.entities);
    for (let i = 0; i < RANDOM_ACCESS.entities; i++) handles[i] = world.add({ p: { value: i } });
    return { handles };
  },
  run(state) {
    const { handles } = state as { handles: RAEntity[] };
    let sum = 0;
    for (let k = 0; k < RANDOM_ACCESS.reads; k++) sum += handles[accessIndex(k, RANDOM_ACCESS.entities)].p.value;
    return sum;
  },
};

const bench: LibraryBench = {
  name: "miniplex",
  version: "2.0.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  extensions: [random_access],
};
export default bench;

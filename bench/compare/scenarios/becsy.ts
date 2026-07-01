/**
 * becsy scenario implementations (v0.16.0, ESM PERF build).
 *
 * Uses the plain static-schema API (no decorators). Each scenario runs ONE becsy System per world
 * (systems are becsy's idiomatic execution unit; a single system holding several query loops is the
 * fastest form and — crucially — avoids the multi-system dependency graph, which for shared
 * read+write components like simple_iter's C would form a precedence cycle that the PERF build's
 * topological sort can't resolve). The iteration scenarios therefore mirror strata's "N passes over
 * the columns" as N query loops inside one `execute()`.
 *
 * becsy's `World.create` and `world.execute` are async, and `setup()` (per the contract) is sync, so
 * setup kicks off world construction and stores a `ready` promise that `run()` awaits — the world is
 * still built exactly once, before the first (parity) run, outside mitata's timing.
 *
 * Checksums are read out of the systems via a closure-captured accumulator object.
 */

import { System, Type, World } from "@lastolivegames/becsy/lib/perf.js";
import { type LibraryBench, N, type Scenario } from "../contract.ts";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// A distinctly-named component class with a single f64 `value` field.
function valueComponent(name: string): any {
  const C = class {
    static schema = { value: Type.float64 };
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}
// A distinctly-named component class with f64 `x`/`y` fields.
function xyComponent(name: string): any {
  const C = class {
    static schema = { x: Type.float64, y: Type.float64 };
  };
  Object.defineProperty(C, "name", { value: name });
  return C;
}

// --- packed_5 -----------------------------------------------------------------
const packed_5: Scenario = {
  id: "packed_5",
  setup() {
    const out = { sum: 0 };
    const A = valueComponent("P5_A");
    const B = valueComponent("P5_B");
    const C = valueComponent("P5_C");
    const D = valueComponent("P5_D");
    const E = valueComponent("P5_E");

    class PackedSystem extends System {
      qA = this.query((q: any) => q.current.with(A).write);
      qB = this.query((q: any) => q.current.with(B).write);
      qC = this.query((q: any) => q.current.with(C).write);
      qD = this.query((q: any) => q.current.with(D).write);
      qE = this.query((q: any) => q.current.with(E).write);
      execute() {
        for (const e of (this as any).qA.current) (e.write(A) as any).value += 1;
        for (const e of (this as any).qB.current) (e.write(B) as any).value += 1;
        for (const e of (this as any).qC.current) (e.write(C) as any).value += 1;
        for (const e of (this as any).qD.current) (e.write(D) as any).value += 1;
        for (const e of (this as any).qE.current) (e.write(E) as any).value += 1;
        let sum = 0;
        for (const e of (this as any).qA.current) sum += (e.read(A) as any).value;
        out.sum = sum;
      }
    }

    const state: any = { out, world: null, ready: null };
    state.ready = (async () => {
      const world = await World.create({
        maxEntities: 4096,
        defs: [A, B, C, D, E, PackedSystem],
      });
      for (let i = 0; i < N.packed; i++) world.createEntity(A, B, C, D, E);
      state.world = world;
    })();
    return state;
  },
  async run(state) {
    const s = state as any;
    await s.ready;
    await s.world.execute();
    return s.out.sum;
  },
};

// --- simple_iter --------------------------------------------------------------
const simple_iter: Scenario = {
  id: "simple_iter",
  setup() {
    const out = { sum: 0 };
    const A = xyComponent("SI_A");
    const B = xyComponent("SI_B");
    const C = xyComponent("SI_C");
    const D = xyComponent("SI_D");
    const E = xyComponent("SI_E");

    class SwapSystem extends System {
      qAB = this.query((q: any) => q.current.with(A, B).write);
      qCD = this.query((q: any) => q.current.with(C, D).write);
      qCE = this.query((q: any) => q.current.with(C, E).write);
      execute() {
        for (const e of (this as any).qAB.current) {
          const a = e.write(A) as any;
          const b = e.write(B) as any;
          const t = a.x;
          a.x = b.x;
          b.x = t;
        }
        for (const e of (this as any).qCD.current) {
          const c = e.write(C) as any;
          const d = e.write(D) as any;
          const t = c.x;
          c.x = d.x;
          d.x = t;
        }
        for (const e of (this as any).qCE.current) {
          const c = e.write(C) as any;
          const ee = e.write(E) as any;
          const t = c.x;
          c.x = ee.x;
          ee.x = t;
        }
        let sum = 0;
        for (const e of (this as any).qAB.current) sum += (e.read(A) as any).x;
        out.sum = sum;
      }
    }

    const offsets = new Map<any, number>([
      [A, 0],
      [B, 1],
      [C, 2],
      [D, 3],
      [E, 4],
    ]);
    const layouts: any[][] = [
      [A, B],
      [A, B, C],
      [A, B, C, D],
      [A, B, C, E],
    ];

    const state: any = { out, world: null, ready: null };
    state.ready = (async () => {
      const world = await World.create({
        maxEntities: 8192,
        defs: [A, B, C, D, E, SwapSystem],
      });
      for (const layout of layouts) {
        for (let i = 0; i < N.simplePerLayout; i++) {
          const args: any[] = [];
          for (const c of layout) {
            args.push(c, { x: (i % 97) + (offsets.get(c) as number), y: i % 97 });
          }
          world.createEntity(...args);
        }
      }
      state.world = world;
    })();
    return state;
  },
  async run(state) {
    const s = state as any;
    await s.ready;
    await s.world.execute();
    return s.out.sum;
  },
};

// --- frag_iter ----------------------------------------------------------------
const frag_iter: Scenario = {
  id: "frag_iter",
  setup() {
    const out = { sum: 0 };
    const Data = valueComponent("FR_Data");
    const types = LETTERS.map((l) => valueComponent(`FR_${l}`));
    const Z = types[25];

    class FragSystem extends System {
      qData = this.query((q: any) => q.current.with(Data).write);
      qZ = this.query((q: any) => q.current.with(Z).write);
      execute() {
        for (const e of (this as any).qData.current) (e.write(Data) as any).value += 1;
        for (const e of (this as any).qZ.current) (e.write(Z) as any).value += 1;
        let sum = 0;
        for (const e of (this as any).qData.current) sum += (e.read(Data) as any).value;
        for (const e of (this as any).qZ.current) sum += (e.read(Z) as any).value;
        out.sum = sum;
      }
    }

    const state: any = { out, world: null, ready: null };
    state.ready = (async () => {
      const world = await World.create({
        maxEntities: 4096,
        defs: [Data, ...types, FragSystem],
      });
      for (const t of types) {
        for (let i = 0; i < N.fragPerType; i++) world.createEntity(t, Data);
      }
      state.world = world;
    })();
    return state;
  },
  async run(state) {
    const s = state as any;
    await s.ready;
    await s.world.execute();
    return s.out.sum;
  },
};

// --- entity_cycle -------------------------------------------------------------
// becsy enacts structural changes at frame boundaries and enrolls new entities into queries only at
// the start of the NEXT frame, so one op = two execute()s: frame 0 spawns 1000 B-entities, frame 1
// counts them (checksum) then deletes them, returning the world to baseline.
const entity_cycle: Scenario = {
  id: "entity_cycle",
  setup() {
    const out = { count: 0 };
    const ctl = { phase: 0 };
    const A = valueComponent("EC_A");
    const B = valueComponent("EC_B");

    class CycleSystem extends System {
      qB = this.query((q: any) => q.current.with(B).write);
      execute() {
        if (ctl.phase === 0) {
          for (let i = 0; i < N.cycle; i++) (this as any).createEntity(B, { value: 1 });
        } else {
          let sum = 0;
          for (const e of (this as any).qB.current) {
            sum += (e.read(B) as any).value;
            e.delete();
          }
          out.count = sum;
        }
      }
    }

    const state: any = { out, ctl, world: null, ready: null };
    state.ready = (async () => {
      const world = await World.create({
        maxEntities: 16384,
        defs: [A, B, CycleSystem],
      });
      for (let i = 0; i < N.cycle; i++) world.createEntity(A, { value: 1 });
      state.world = world;
    })();
    return state;
  },
  async run(state) {
    const s = state as any;
    await s.ready;
    s.ctl.phase = 0;
    await s.world.execute(); // spawn 1000 B-entities
    s.ctl.phase = 1;
    await s.world.execute(); // count B (= 1000) then destroy them
    return s.out.count;
  },
};

// --- add_remove ---------------------------------------------------------------
// Same two-frame model: frame 0 adds B to all 1000 A-entities, frame 1 counts B (checksum) then
// removes B from all of them, returning the world to baseline.
const add_remove: Scenario = {
  id: "add_remove",
  setup() {
    const out = { count: 0 };
    const ctl = { phase: 0 };
    const A = valueComponent("AR_A");
    const B = valueComponent("AR_B");

    class AddRemoveSystem extends System {
      qA = this.query((q: any) => q.current.with(A).write);
      qB = this.query((q: any) => q.current.with(B).write);
      execute() {
        if (ctl.phase === 0) {
          for (const e of (this as any).qA.current) e.add(B, { value: 1 });
        } else {
          let sum = 0;
          for (const e of (this as any).qB.current) {
            sum += (e.read(B) as any).value;
            e.remove(B);
          }
          out.count = sum;
        }
      }
    }

    const state: any = { out, ctl, world: null, ready: null };
    state.ready = (async () => {
      const world = await World.create({
        maxEntities: 16384,
        defs: [A, B, AddRemoveSystem],
      });
      for (let i = 0; i < N.addRemove; i++) world.createEntity(A, { value: 1 });
      state.world = world;
    })();
    return state;
  },
  async run(state) {
    const s = state as any;
    await s.ready;
    s.ctl.phase = 0;
    await s.world.execute(); // add B to all 1000
    s.ctl.phase = 1;
    await s.world.execute(); // count B (= 1000) then remove B from all 1000
    return s.out.count;
  },
};

const bench: LibraryBench = {
  name: "becsy",
  version: "0.16.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
};
export default bench;

/**
 * bitecs scenario implementations — idiomatic fastest form: SoA components are plain objects of
 * PRE-SIZED typed arrays (user-managed, indexed by eid). Iteration uses a buffered `query` (returns
 * the live dense Uint32Array, no per-call copy) and a raw index loop over `Comp.field[eid]`. No
 * scheduler — bitecs' functional API is called directly (matching strata/miniplex/koota, which also
 * iterate without a scheduler). bitecs 0.4.0 arg order is eid-BEFORE-component.
 */

import {
  addComponent,
  addEntity,
  createWorld,
  query,
  removeComponent,
  removeEntity,
} from "bitecs";
import { type LibraryBench, N, type Scenario } from "../contract.ts";

// Capacity: max concurrent eid any scenario reaches (simple_iter 4000, entity_cycle ~2000). eids are
// contiguous small ints (versioning off), so this doubles as the typed-array length. 8192 is safe.
const CAP = 8192;

type World = ReturnType<typeof createWorld>;
type C1 = { value: Float64Array };
type C2 = { x: Float64Array; y: Float64Array };

const c1 = (): C1 => ({ value: new Float64Array(CAP) });
const c2 = (): C2 => ({ x: new Float64Array(CAP), y: new Float64Array(CAP) });

// Buffered query -> live dense Uint32Array of eids (the fastest read form in bitecs 0.4.0).
const BUF = { buffered: true } as const;
const eids = (w: World, terms: unknown[]): Uint32Array =>
  query(w, terms as never[], BUF) as Uint32Array;

// --- packed_5 -----------------------------------------------------------------
const packed_5: Scenario = {
  id: "packed_5",
  setup() {
    const comps: C1[] = [c1(), c1(), c1(), c1(), c1()];
    const w = createWorld();
    for (let i = 0; i < N.packed; i++) {
      const e = addEntity(w);
      for (const c of comps) {
        addComponent(w, e, c);
        c.value[e] = 0;
      }
    }
    return { w, comps };
  },
  run(state) {
    const { w, comps } = state as { w: World; comps: C1[] };
    let firstEnts: Uint32Array = new Uint32Array(0);
    for (let k = 0; k < comps.length; k++) {
      const c = comps[k];
      const es = eids(w, [c]);
      for (let i = 0; i < es.length; i++) c.value[es[i]] += 1;
      if (k === 0) firstEnts = es;
    }
    let sum = 0;
    const a = comps[0].value;
    for (let i = 0; i < firstEnts.length; i++) sum += a[firstEnts[i]];
    return sum;
  },
};

// --- simple_iter --------------------------------------------------------------
const simple_iter: Scenario = {
  id: "simple_iter",
  setup() {
    const A = c2(),
      B = c2(),
      C = c2(),
      D = c2(),
      E = c2();
    const w = createWorld();
    // Init is library-agnostic: x = (i % 97) + fixed per-component offset (A=0…E=4), y = i % 97,
    // where i is the 0..999 index WITHIN each layout.
    const off = new Map<C2, number>([
      [A, 0],
      [B, 1],
      [C, 2],
      [D, 3],
      [E, 4],
    ]);
    const layouts: C2[][] = [
      [A, B],
      [A, B, C],
      [A, B, C, D],
      [A, B, C, E],
    ];
    for (const layout of layouts) {
      for (let i = 0; i < N.simplePerLayout; i++) {
        const e = addEntity(w);
        const base = i % 97;
        for (const c of layout) {
          addComponent(w, e, c);
          c.x[e] = base + (off.get(c) as number);
          c.y[e] = base;
        }
      }
    }
    return { w, A, B, C, D, E };
  },
  run(state) {
    const s = state as { w: World; A: C2; B: C2; C: C2; D: C2; E: C2 };
    const w = s.w;
    const swap = (c1x: Float64Array, c2x: Float64Array, es: Uint32Array) => {
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        const t = c1x[e];
        c1x[e] = c2x[e];
        c2x[e] = t;
      }
    };
    swap(s.A.x, s.B.x, eids(w, [s.A, s.B])); // all 4000 (every layout has A&B)
    swap(s.C.x, s.D.x, eids(w, [s.C, s.D])); // 1000 (layout [A,B,C,D])
    swap(s.C.x, s.E.x, eids(w, [s.C, s.E])); // 1000 (layout [A,B,C,E])
    let sum = 0;
    const ax = s.A.x;
    const es = eids(w, [s.A]);
    for (let i = 0; i < es.length; i++) sum += ax[es[i]];
    return sum;
  },
};

// --- frag_iter ----------------------------------------------------------------
const frag_iter: Scenario = {
  id: "frag_iter",
  setup() {
    const Data = c1();
    const types: C1[] = Array.from({ length: 26 }, c1);
    const w = createWorld();
    for (const t of types) {
      for (let i = 0; i < N.fragPerType; i++) {
        const e = addEntity(w);
        addComponent(w, e, t);
        t.value[e] = 0;
        addComponent(w, e, Data);
        Data.value[e] = 0;
      }
    }
    return { w, Data, Z: types[25] };
  },
  run(state) {
    const { w, Data, Z } = state as { w: World; Data: C1; Z: C1 };
    const dv = Data.value;
    const zv = Z.value;
    const de = eids(w, [Data]); // 2600
    for (let i = 0; i < de.length; i++) dv[de[i]] += 1;
    const ze = eids(w, [Z]); // 100
    for (let i = 0; i < ze.length; i++) zv[ze[i]] += 1;
    let sum = 0;
    for (let i = 0; i < de.length; i++) sum += dv[de[i]];
    for (let i = 0; i < ze.length; i++) sum += zv[ze[i]];
    return sum;
  },
};

// --- entity_cycle -------------------------------------------------------------
const entity_cycle: Scenario = {
  id: "entity_cycle",
  setup() {
    const A = c1();
    const B = c1();
    const w = createWorld();
    for (let i = 0; i < N.cycle; i++) {
      const e = addEntity(w);
      addComponent(w, e, A);
      A.value[e] = 1;
    }
    return { w, B };
  },
  run(state) {
    const { w, B } = state as { w: World; B: C1 };
    const bv = B.value;
    const spawned = new Array<number>(N.cycle);
    for (let i = 0; i < N.cycle; i++) {
      const e = addEntity(w);
      addComponent(w, e, B);
      bv[e] = 1;
      spawned[i] = e;
    }
    let sum = 0;
    for (let i = 0; i < N.cycle; i++) sum += bv[spawned[i]];
    // Return the world to baseline.
    for (let i = 0; i < N.cycle; i++) removeEntity(w, spawned[i]);
    return sum;
  },
};

// --- add_remove ---------------------------------------------------------------
const add_remove: Scenario = {
  id: "add_remove",
  setup() {
    const A = c1();
    const B = c1();
    const w = createWorld();
    const ents = new Array<number>(N.addRemove);
    for (let i = 0; i < N.addRemove; i++) {
      const e = addEntity(w);
      addComponent(w, e, A);
      A.value[e] = 1;
      ents[i] = e;
    }
    return { w, B, ents };
  },
  run(state) {
    const { w, B, ents } = state as { w: World; B: C1; ents: number[] };
    const bv = B.value;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      addComponent(w, e, B);
      bv[e] = 1;
    }
    let sum = 0;
    for (let i = 0; i < ents.length; i++) sum += bv[ents[i]];
    // Return the world to baseline.
    for (let i = 0; i < ents.length; i++) removeComponent(w, ents[i], B);
    return sum;
  },
};

const bench: LibraryBench = {
  name: "bitecs",
  version: "0.4.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
};
export default bench;

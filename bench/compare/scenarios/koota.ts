/**
 * koota scenario implementations — idiomatic fastest form: warmed `createQuery` objects iterated
 * with `useStores`, hoisting the SoA plain-`number[]` columns and indexing them by the raw entity id
 * (`entity & ENTITY_ID_MASK`, mask = 0xfffff — same value koota's `Entity.id()` computes, inlined to
 * skip the `Number.prototype` method call). `useStores` bypasses change detection, and zero
 * `onChange` subscribers are registered, so writes are plain array stores with no tracking overhead.
 */

import { type Trait, type World, createQuery, createWorld, trait } from "koota";
import { type LibraryBench, N, type Scenario } from "../contract.ts";

// koota packs [worldId(4) | generation(8) | entityId(20)]; the low 20 bits are the SoA store index.
const ID_MASK = 0xfffff;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type Query = ReturnType<typeof createQuery>;
type NumStore = { value: number[] };
type XYStore = { x: number[]; y: number[] };

// --- packed_5 -----------------------------------------------------------------
const packed_5: Scenario = {
  id: "packed_5",
  setup() {
    const comps = ["A", "B", "C", "D", "E"].map(() => trait({ value: 0 }));
    const w = createWorld();
    for (let i = 0; i < N.packed; i++) w.spawn(...comps);
    const queries = comps.map((c) => createQuery(c));
    return { w, queries };
  },
  run(state) {
    const { w, queries } = state as { w: World; queries: Query[] };
    for (const q of queries) {
      w.query(q).useStores((stores, entities) => {
        const vals = (stores[0] as NumStore).value;
        for (let i = 0; i < entities.length; i++) vals[entities[i] & ID_MASK] += 1;
      });
    }
    let sum = 0;
    w.query(queries[0]).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) sum += vals[entities[i] & ID_MASK];
    });
    return sum;
  },
};

// --- simple_iter --------------------------------------------------------------
const simple_iter: Scenario = {
  id: "simple_iter",
  setup() {
    const A = trait({ x: 0, y: 0 });
    const B = trait({ x: 0, y: 0 });
    const C = trait({ x: 0, y: 0 });
    const D = trait({ x: 0, y: 0 });
    const E = trait({ x: 0, y: 0 });
    const off = new Map<Trait, number>([[A, 0], [B, 1], [C, 2], [D, 3], [E, 4]]);
    const w = createWorld();
    const layouts: Trait[][] = [[A, B], [A, B, C], [A, B, C, D], [A, B, C, E]];
    for (const layout of layouts) {
      for (let i = 0; i < N.simplePerLayout; i++) {
        w.spawn(...layout.map((c) => c({ x: (i % 97) + (off.get(c) as number), y: i % 97 })));
      }
    }
    return { w, qAB: createQuery(A, B), qCD: createQuery(C, D), qCE: createQuery(C, E) };
  },
  run(state) {
    const s = state as { w: World; qAB: Query; qCD: Query; qCE: Query };
    // Each system swaps stores[0].x <-> stores[1].x over its matched entities.
    const swap = (q: Query) => {
      s.w.query(q).useStores((stores, entities) => {
        const ax = (stores[0] as XYStore).x;
        const bx = (stores[1] as XYStore).x;
        for (let i = 0; i < entities.length; i++) {
          const id = entities[i] & ID_MASK;
          const t = ax[id];
          ax[id] = bx[id];
          bx[id] = t;
        }
      });
    };
    swap(s.qAB); // A.x <-> B.x over all with A&B
    swap(s.qCD); // C.x <-> D.x over all with C&D
    swap(s.qCE); // C.x <-> E.x over all with C&E
    let sum = 0;
    s.w.query(s.qAB).useStores((stores, entities) => {
      const ax = (stores[0] as XYStore).x;
      for (let i = 0; i < entities.length; i++) sum += ax[entities[i] & ID_MASK];
    });
    return sum;
  },
};

// --- frag_iter ----------------------------------------------------------------
const frag_iter: Scenario = {
  id: "frag_iter",
  setup() {
    const Data = trait({ value: 0 });
    const types = LETTERS.map(() => trait({ value: 0 }));
    const w = createWorld();
    for (const t of types) {
      for (let i = 0; i < N.fragPerType; i++) w.spawn(t, Data);
    }
    return { w, qData: createQuery(Data), qZ: createQuery(types[25]) };
  },
  run(state) {
    const s = state as { w: World; qData: Query; qZ: Query };
    s.w.query(s.qData).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) vals[entities[i] & ID_MASK] += 1;
    });
    s.w.query(s.qZ).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) vals[entities[i] & ID_MASK] += 1;
    });
    let sum = 0;
    s.w.query(s.qData).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) sum += vals[entities[i] & ID_MASK];
    });
    s.w.query(s.qZ).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) sum += vals[entities[i] & ID_MASK];
    });
    return sum;
  },
};

// --- entity_cycle -------------------------------------------------------------
const entity_cycle: Scenario = {
  id: "entity_cycle",
  setup() {
    const A = trait({ value: 1 });
    const B = trait({ value: 1 });
    const w = createWorld();
    for (let i = 0; i < N.cycle; i++) w.spawn(A);
    return { w, B, qB: createQuery(B) };
  },
  run(state) {
    const s = state as { w: World; B: Trait; qB: Query };
    const spawned: number[] = new Array(N.cycle);
    for (let i = 0; i < N.cycle; i++) spawned[i] = s.w.spawn(s.B({ value: 1 }));
    let sum = 0;
    s.w.query(s.qB).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) sum += vals[entities[i] & ID_MASK];
    });
    for (let i = 0; i < spawned.length; i++) (spawned[i] as number).destroy();
    return sum;
  },
};

// --- add_remove ---------------------------------------------------------------
const add_remove: Scenario = {
  id: "add_remove",
  setup() {
    const A = trait({ value: 1 });
    const B = trait({ value: 1 });
    const w = createWorld();
    const ents: number[] = new Array(N.addRemove);
    for (let i = 0; i < N.addRemove; i++) ents[i] = w.spawn(A);
    return { w, B, ents, qB: createQuery(B) };
  },
  run(state) {
    const s = state as { w: World; B: Trait; ents: number[]; qB: Query };
    const ents = s.ents;
    for (let i = 0; i < ents.length; i++) (ents[i] as number).add(s.B({ value: 1 }));
    let sum = 0;
    s.w.query(s.qB).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      for (let i = 0; i < entities.length; i++) sum += vals[entities[i] & ID_MASK];
    });
    for (let i = 0; i < ents.length; i++) (ents[i] as number).remove(s.B);
    return sum;
  },
};

const bench: LibraryBench = {
  name: "koota",
  version: "0.6.6",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
};
export default bench;

/**
 * strata scenario implementations — idiomatic fastest form: compiled queries iterated with a raw
 * `denseCount` loop over hoisted typed-array columns (`b.col(C).field`). No scheduler/tick overhead
 * on the iteration path (matching bitecs/miniplex/koota, which also iterate without a scheduler).
 */

import {
  type Component,
  type Entity,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineTag,
} from "strata";
import { type LibraryBench, N, RANDOM_ACCESS, type Scenario, accessIndex } from "../contract.ts";

const VALUE = { value: "f64" } as const;
const XY = { x: "f64", y: "f64" } as const;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type World = ReturnType<typeof createWorld>;

// --- packed_5 -----------------------------------------------------------------
const packed_5: Scenario = {
  id: "packed_5",
  setup() {
    const comps = ["A", "B", "C", "D", "E"].map((k) =>
      defineComponent<{ value: number }>(`P5_${k}`, VALUE),
    );
    const w = createWorld();
    for (let i = 0; i < N.packed; i++) {
      w.spawn({ components: comps.map((c) => [c, { value: 0 }]) });
    }
    const queries = comps.map((c) => ({ c, q: defineQuery([c]) }));
    return { w, queries };
  },
  run(state) {
    const { w, queries } = state as { w: World; queries: { c: Component; q: ReturnType<typeof defineQuery> }[] };
    for (const { c, q } of queries) {
      w.query(q).each((b) => {
        const col = b.col(c).value as Float64Array;
        for (let r = 0; r < b.denseCount; r++) col[r] += 1;
      });
    }
    let sum = 0;
    const first = queries[0];
    w.query(first.q).each((b) => {
      const col = b.col(first.c).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += col[r];
    });
    return sum;
  },
};

// --- simple_iter --------------------------------------------------------------
const simple_iter: Scenario = {
  id: "simple_iter",
  setup() {
    const A = defineComponent<{ x: number; y: number }>("SI_A", XY);
    const B = defineComponent<{ x: number; y: number }>("SI_B", XY);
    const C = defineComponent<{ x: number; y: number }>("SI_C", XY);
    const D = defineComponent<{ x: number; y: number }>("SI_D", XY);
    const E = defineComponent<{ x: number; y: number }>("SI_E", XY);
    const w = createWorld();
    // Init is library-agnostic: x = (i % 97) + fixed per-component offset (A=0…E=4), so the
    // post-swap checksum is reproducible across every library (never tied to internal ids).
    const off = new Map<Component, number>([[A, 0], [B, 1], [C, 2], [D, 3], [E, 4]]);
    const layouts: Component[][] = [
      [A, B],
      [A, B, C],
      [A, B, C, D],
      [A, B, C, E],
    ];
    for (const layout of layouts) {
      for (let i = 0; i < N.simplePerLayout; i++) {
        w.spawn({ components: layout.map((c) => [c, { x: (i % 97) + (off.get(c) as number), y: i % 97 }]) });
      }
    }
    return { w, A, B, C, D, E, qAB: defineQuery([A, B]), qCD: defineQuery([C, D]), qCE: defineQuery([C, E]) };
  },
  run(state) {
    const s = state as {
      w: World;
      A: Component; B: Component; C: Component; D: Component; E: Component;
      qAB: ReturnType<typeof defineQuery>; qCD: ReturnType<typeof defineQuery>; qCE: ReturnType<typeof defineQuery>;
    };
    const swap = (q: ReturnType<typeof defineQuery>, c1: Component, c2: Component) => {
      s.w.query(q).each((b) => {
        const a = b.col(c1).x as Float64Array;
        const bb = b.col(c2).x as Float64Array;
        for (let r = 0; r < b.denseCount; r++) {
          const t = a[r];
          a[r] = bb[r];
          bb[r] = t;
        }
      });
    };
    swap(s.qAB, s.A, s.B);
    swap(s.qCD, s.C, s.D);
    swap(s.qCE, s.C, s.E);
    let sum = 0;
    s.w.query(s.qAB).each((b) => {
      const a = b.col(s.A).x as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += a[r];
    });
    return sum;
  },
};

// --- frag_iter ----------------------------------------------------------------
const frag_iter: Scenario = {
  id: "frag_iter",
  setup() {
    const Data = defineComponent<{ value: number }>("FR_Data", VALUE);
    const types = LETTERS.map((l) => defineComponent<{ value: number }>(`FR_${l}`, VALUE));
    const w = createWorld();
    for (const t of types) {
      for (let i = 0; i < N.fragPerType; i++) {
        w.spawn({ components: [[t, { value: 0 }], [Data, { value: 0 }]] });
      }
    }
    return { w, Data, Z: types[25], qData: defineQuery([Data]), qZ: defineQuery([types[25]]) };
  },
  run(state) {
    const s = state as { w: World; Data: Component; Z: Component; qData: ReturnType<typeof defineQuery>; qZ: ReturnType<typeof defineQuery> };
    s.w.query(s.qData).each((b) => {
      const col = b.col(s.Data).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) col[r] += 1;
    });
    s.w.query(s.qZ).each((b) => {
      const col = b.col(s.Z).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) col[r] += 1;
    });
    let sum = 0;
    s.w.query(s.qData).each((b) => {
      const col = b.col(s.Data).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += col[r];
    });
    s.w.query(s.qZ).each((b) => {
      const col = b.col(s.Z).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += col[r];
    });
    return sum;
  },
};

// --- entity_cycle -------------------------------------------------------------
const entity_cycle: Scenario = {
  id: "entity_cycle",
  setup() {
    const A = defineComponent<{ value: number }>("EC_A", VALUE);
    const B = defineComponent<{ value: number }>("EC_B", VALUE);
    const w = createWorld();
    for (let i = 0; i < N.cycle; i++) w.spawn({ components: [[A, { value: 1 }]] });
    return { w, B, qB: defineQuery([B]) };
  },
  run(state) {
    const s = state as { w: World; B: Component; qB: ReturnType<typeof defineQuery> };
    const spawned: Entity[] = [];
    for (let i = 0; i < N.cycle; i++) spawned.push(s.w.spawn({ components: [[s.B, { value: 1 }]] }));
    let sum = 0;
    s.w.query(s.qB).each((b) => {
      const col = b.col(s.B).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += col[r];
    });
    for (const e of spawned) s.w.destroy(e);
    return sum;
  },
};

// --- add_remove ---------------------------------------------------------------
const add_remove: Scenario = {
  id: "add_remove",
  setup() {
    const A = defineComponent<{ value: number }>("AR_A", VALUE);
    const B = defineComponent<{ value: number }>("AR_B", VALUE);
    const w = createWorld();
    const ents: Entity[] = [];
    for (let i = 0; i < N.addRemove; i++) ents.push(w.spawn({ components: [[A, { value: 1 }]] }));
    return { w, B, ents, qB: defineQuery([B]) };
  },
  run(state) {
    const s = state as { w: World; B: Component; ents: Entity[]; qB: ReturnType<typeof defineQuery> };
    for (const e of s.ents) s.w.addComponent(e, s.B, { value: 1 });
    let sum = 0;
    s.w.query(s.qB).each((b) => {
      const col = b.col(s.B).value as Float64Array;
      for (let r = 0; r < b.denseCount; r++) sum += col[r];
    });
    for (const e of s.ents) s.w.removeComponent(e, s.B);
    return sum;
  },
};

// --- extension: serialize (strata built-in snapshot round-trip; §8) -----------
const serialize: Scenario = {
  id: "serialize",
  setup() {
    const Uid = defineComponent<{ id: number }>("XS_Uid", { id: "u32" });
    const Pos = defineComponent<{ x: number; y: number }>("XS_Pos", XY);
    const Name = defineComponent<{ label: string }>("XS_Name", { label: "string" });
    const Tag = defineTag("XS_Tag");
    const Rel = defineRelation("XS_Rel", { arity: "many" });
    const w = createWorld();
    const NUM = 5000;
    const ents: Entity[] = [];
    for (let i = 0; i < NUM; i++) {
      const comps: [Component, Record<string, unknown>][] = [[Uid, { id: i }]];
      if (i % 2 === 0) comps.push([Pos, { x: i, y: i + 1 }]);
      if (i % 3 === 0) comps.push([Name, { label: `n-${i}` }]);
      const e = w.spawn({ components: comps, tags: i % 5 === 0 ? [Tag] : [] });
      ents.push(e);
    }
    for (let i = 0; i < NUM; i += 4) w.addRelation(ents[i], Rel, ents[(i + 1) % NUM]);
    return { w, NUM };
  },
  run(state) {
    const s = state as { w: World; NUM: number };
    const bytes = s.w.export(); // read-only: w is unchanged, so run() is repeatable
    const w2 = createWorld();
    w2.import(bytes);
    return w2.runtime.liveCount();
  },
};

// --- extension: random_access (read a component for many random entities by handle) ------------
const random_access: Scenario = {
  id: "random_access",
  setup() {
    const Pos = defineComponent<{ x: number }>("XR_Pos", { x: "f64" });
    const w = createWorld();
    const handles: Entity[] = [];
    for (let i = 0; i < RANDOM_ACCESS.entities; i++) handles.push(w.spawn({ components: [[Pos, { x: i }]] }));
    return { w, Pos, handles };
  },
  run(state) {
    const { w, Pos, handles } = state as { w: World; Pos: Component<{ x: number }>; handles: Entity[] };
    let sum = 0;
    for (let k = 0; k < RANDOM_ACCESS.reads; k++) {
      sum += w.read(handles[accessIndex(k, RANDOM_ACCESS.entities)], Pos).x;
    }
    return sum;
  },
};

const bench: LibraryBench = {
  name: "strata",
  version: "0.0.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  extensions: [serialize, random_access],
};
export default bench;

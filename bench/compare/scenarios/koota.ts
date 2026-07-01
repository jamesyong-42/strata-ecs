/**
 * koota scenario implementations — idiomatic fastest form: warmed `createQuery` objects iterated
 * with `useStores`, hoisting the SoA plain-`number[]` columns and indexing them by the raw entity id
 * (`entity & ENTITY_ID_MASK`, mask = 0xfffff — same value koota's `Entity.id()` computes, inlined to
 * skip the `Number.prototype` method call). `useStores` bypasses change detection, and zero
 * `onChange` subscribers are registered, so writes are plain array stores with no tracking overhead.
 */

import { type ConfigurableTrait, type Entity, Not, type Trait, type World, createQuery, createWorld, trait } from "koota";
import { type LibraryBench, N, RANDOM_ACCESS, type Scenario, accessIndex } from "../contract.ts";

// koota packs [worldId(4) | generation(8) | entityId(20)]; the low 20 bits are the SoA store index.
const ID_MASK = 0xfffff;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

type Query = ReturnType<typeof createQuery>;
type NumStore = { value: number[] };
type XYStore = { x: number[]; y: number[] };
type HpStore = { hp: number[] };
type AmountStore = { amount: number[] };
type AccStore = { acc: number[] };

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
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += vals[entities[i] & ID_MASK]; sum += sc;
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
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += ax[entities[i] & ID_MASK]; sum += sc;
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
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += vals[entities[i] & ID_MASK]; sum += sc;
    });
    s.w.query(s.qZ).useStores((stores, entities) => {
      const vals = (stores[0] as NumStore).value;
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += vals[entities[i] & ID_MASK]; sum += sc;
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
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += vals[entities[i] & ID_MASK]; sum += sc;
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
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += vals[entities[i] & ID_MASK]; sum += sc;
    });
    for (let i = 0; i < ents.length; i++) (ents[i] as number).remove(s.B);
    return sum;
  },
};

// --- extension: random_access -------------------------------------------------
// koota's idiomatic random read is entity.get(trait) (returns a fresh value snapshot — allocates,
// like strata's whole-component read). useStores is for query iteration, not random by-handle access.
const random_access: Scenario = {
  id: "random_access",
  setup() {
    const P = trait({ value: 0 });
    const w = createWorld();
    const handles = new Array<number>(RANDOM_ACCESS.entities);
    for (let i = 0; i < RANDOM_ACCESS.entities; i++) handles[i] = w.spawn(P({ value: i }));
    return { P, handles };
  },
  run(state) {
    const s = state as { P: Trait; handles: number[] };
    let sum = 0;
    for (let k = 0; k < RANDOM_ACCESS.reads; k++) {
      sum += ((s.handles[accessIndex(k, RANDOM_ACCESS.entities)] as number).get(s.P) as { value: number }).value;
    }
    return sum;
  },
};

// --- frame: sim_frame ---------------------------------------------------------
// koota has no scheduler, so the "pipeline" is four system-functions called in fixed order per
// frame. Each system iterates a warmed createQuery via useStores (raw SoA columns indexed by the
// masked entity id). Movement excludes Frozen (a tag trait) via Not(Frozen); Render reads Position
// AFTER Movement wrote it. The checksum accumulates across mitata iterations, matching every rival.
const sim_frame: Scenario = {
  id: "sim_frame",
  setup() {
    const Position = trait({ x: 0, y: 0 });
    const Velocity = trait({ x: 0, y: 0 });
    const Health = trait({ hp: 0 });
    const Damage = trait({ amount: 0 });
    const Renderable = trait({ acc: 0 });
    const Frozen = trait(); // tag trait — marks an entity, no data
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      const comps: ConfigurableTrait[] = [Position({ x: 0, y: 0 }), Velocity({ x: 1, y: 2 })];
      if (i % 2 === 0) comps.push(Health({ hp: 0 }));
      if (i % 3 === 0) comps.push(Damage({ amount: 1 }));
      if (i % 5 === 0) comps.push(Renderable({ acc: 0 }));
      if (i % 4 === 0) comps.push(Frozen);
      w.spawn(...comps);
    }
    // Warm every query once (built here, iterated in run()). Zero onChange subscribers registered.
    return {
      w,
      qMove: createQuery(Position, Velocity, Not(Frozen)),
      qHealth: createQuery(Health),
      qHealthDamage: createQuery(Health, Damage),
      qRenderPos: createQuery(Renderable, Position),
      qPos: createQuery(Position),
      qRender: createQuery(Renderable),
    };
  },
  run(state) {
    const s = state as {
      w: World;
      qMove: Query; qHealth: Query; qHealthDamage: Query; qRenderPos: Query; qPos: Query; qRender: Query;
    };
    // 1. Movement over [Position, Velocity] EXCLUDING Frozen → Position += Velocity.
    s.w.query(s.qMove).useStores((stores, entities) => {
      const px = (stores[0] as XYStore).x;
      const py = (stores[0] as XYStore).y;
      const vx = (stores[1] as XYStore).x;
      const vy = (stores[1] as XYStore).y;
      for (let i = 0; i < entities.length; i++) {
        const id = entities[i] & ID_MASK;
        px[id] += vx[id];
        py[id] += vy[id];
      }
    });
    // 2. Regen over [Health] → hp += 1.
    s.w.query(s.qHealth).useStores((stores, entities) => {
      const hp = (stores[0] as HpStore).hp;
      for (let i = 0; i < entities.length; i++) hp[entities[i] & ID_MASK] += 1;
    });
    // 3. ApplyDamage over [Health, Damage] → hp -= amount.
    s.w.query(s.qHealthDamage).useStores((stores, entities) => {
      const hp = (stores[0] as HpStore).hp;
      const amt = (stores[1] as AmountStore).amount;
      for (let i = 0; i < entities.length; i++) {
        const id = entities[i] & ID_MASK;
        hp[id] -= amt[id];
      }
    });
    // 4. Render over [Renderable, Position] → acc += Position.x (reads Position AFTER Movement).
    s.w.query(s.qRenderPos).useStores((stores, entities) => {
      const acc = (stores[0] as AccStore).acc;
      const px = (stores[1] as XYStore).x;
      for (let i = 0; i < entities.length; i++) {
        const id = entities[i] & ID_MASK;
        acc[id] += px[id];
      }
    });
    // Checksum: sum(Position.x over ALL) + sum(Health.hp over Health) + sum(Renderable.acc over Renderable).
    let sum = 0;
    s.w.query(s.qPos).useStores((stores, entities) => {
      const px = (stores[0] as XYStore).x;
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += px[entities[i] & ID_MASK]; sum += sc;
    });
    s.w.query(s.qHealth).useStores((stores, entities) => {
      const hp = (stores[0] as HpStore).hp;
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += hp[entities[i] & ID_MASK]; sum += sc;
    });
    s.w.query(s.qRender).useStores((stores, entities) => {
      const acc = (stores[0] as AccStore).acc;
      let sc = 0; for (let i = 0; i < entities.length; i++) sc += acc[entities[i] & ID_MASK]; sum += sc;
    });
    return sum;
  },
};

// --- frame: spawn_reap_frame --------------------------------------------------
// Movement moves the base, a Spawner spawns one Particle per base (immediate world.spawn), the count
// is the checksum, then a Reaper destroys every Particle (immediate entity.destroy) → back to
// baseline. world.query() returns a sliced snapshot, so destroying while iterating it is safe.
const spawn_reap_frame: Scenario = {
  id: "spawn_reap_frame",
  setup() {
    const Position = trait({ x: 0, y: 0 });
    const Velocity = trait({ x: 0, y: 0 });
    const Particle = trait({ life: 0 });
    const w = createWorld();
    const NUM = 5000;
    for (let i = 0; i < NUM; i++) w.spawn(Position({ x: 0, y: 0 }), Velocity({ x: 1, y: 1 }));
    return { w, Particle, qMove: createQuery(Position, Velocity), qParticle: createQuery(Particle) };
  },
  run(state) {
    const s = state as { w: World; Particle: Trait; qMove: Query; qParticle: Query };
    // (a) Movement over [Position, Velocity] moves the base.
    s.w.query(s.qMove).useStores((stores, entities) => {
      const px = (stores[0] as XYStore).x;
      const py = (stores[0] as XYStore).y;
      const vx = (stores[1] as XYStore).x;
      const vy = (stores[1] as XYStore).y;
      for (let i = 0; i < entities.length; i++) {
        const id = entities[i] & ID_MASK;
        px[id] += vx[id];
        py[id] += vy[id];
      }
    });
    // (b) Spawner over [Position, Velocity]: one Particle{life:1} per base entity.
    const base = s.w.query(s.qMove);
    for (let i = 0; i < base.length; i++) s.w.spawn(s.Particle({ life: 1 }));
    // (c) count the Particles = checksum.
    const particles = s.w.query(s.qParticle);
    const count = particles.length;
    // (d) Reaper destroys every Particle → baseline (snapshot slice → safe to destroy while iterating).
    for (let i = 0; i < particles.length; i++) (particles[i] as Entity).destroy();
    return count;
  },
};

// --- frame: toggle_frame ------------------------------------------------------
// Movement moves all, a Stun system adds Stunned to every [Health] not-Stunned (immediate
// entity.add), the count is the checksum, then an Unstun system removes Stunned from every [Stunned]
// (immediate entity.remove) → baseline. Removing Stunned re-admits entities to [Health, Not(Stunned)].
const toggle_frame: Scenario = {
  id: "toggle_frame",
  setup() {
    const Position = trait({ x: 0, y: 0 });
    const Velocity = trait({ x: 0, y: 0 });
    const Health = trait({ hp: 100 });
    const Stunned = trait({ since: 0 });
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      w.spawn(Position({ x: 0, y: 0 }), Velocity({ x: 1, y: 1 }), Health({ hp: 100 }));
    }
    return {
      w, Stunned,
      qMove: createQuery(Position, Velocity),
      qStun: createQuery(Health, Not(Stunned)),
      qStunned: createQuery(Stunned),
    };
  },
  run(state) {
    const s = state as { w: World; Stunned: Trait; qMove: Query; qStun: Query; qStunned: Query };
    // (a) Movement over [Position, Velocity] → Position.x += Velocity.x.
    s.w.query(s.qMove).useStores((stores, entities) => {
      const px = (stores[0] as XYStore).x;
      const vx = (stores[1] as XYStore).x;
      for (let i = 0; i < entities.length; i++) {
        const id = entities[i] & ID_MASK;
        px[id] += vx[id];
      }
    });
    // (b) Stun over [Health] NOT Stunned → add Stunned{since:0} (snapshot slice → safe to add while iterating).
    const toStun = s.w.query(s.qStun);
    for (let i = 0; i < toStun.length; i++) (toStun[i] as Entity).add(s.Stunned({ since: 0 }));
    // (c) count entities now carrying Stunned = checksum.
    const stunned = s.w.query(s.qStunned);
    const count = stunned.length;
    // (d) Unstun over [Stunned] → remove Stunned → baseline.
    for (let i = 0; i < stunned.length; i++) (stunned[i] as Entity).remove(s.Stunned);
    return count;
  },
};

const bench: LibraryBench = {
  name: "koota",
  version: "0.6.6",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  frames: [sim_frame, spawn_reap_frame, toggle_frame],
  extensions: [random_access],
};
export default bench;

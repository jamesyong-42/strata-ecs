/**
 * bitecs scenario implementations — idiomatic fastest form: SoA components are plain objects of
 * PRE-SIZED typed arrays (user-managed, indexed by eid). Iteration uses a buffered `query` (returns
 * the live dense Uint32Array, no per-call copy) and a raw index loop over `Comp.field[eid]`. No
 * scheduler — bitecs' functional API is called directly (matching strata/miniplex/koota, which also
 * iterate without a scheduler). bitecs 0.4.0 arg order is eid-BEFORE-component.
 */

import {
  Not,
  addComponent,
  addEntity,
  createWorld,
  query,
  removeComponent,
  removeEntity,
} from "bitecs";
import { type LibraryBench, N, RANDOM_ACCESS, type Scenario, accessIndex } from "../contract.ts";

// Capacity: max concurrent eid any scenario reaches (simple_iter 4000, entity_cycle ~2000). eids are
// contiguous small ints (versioning off), so this doubles as the typed-array length. 8192 is safe.
const CAP = 8192;

// Frames reach higher eids: sim/toggle 10000, and spawn_reap holds 5000 base + 5000 particles
// concurrently (eids start at 1). 16384 covers every frame's max concurrent eid.
const FRAME_CAP = 16384;
const f2 = (): C2 => ({ x: new Float64Array(FRAME_CAP), y: new Float64Array(FRAME_CAP) });

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

// --- extension: random_access -------------------------------------------------
const random_access: Scenario = {
  id: "random_access",
  setup() {
    // Fresh world → eids are contiguous small ints; size the store to cover all of them.
    const P: C1 = { value: new Float64Array(RANDOM_ACCESS.entities + 16) };
    const w = createWorld();
    const handles = new Array<number>(RANDOM_ACCESS.entities);
    for (let i = 0; i < RANDOM_ACCESS.entities; i++) {
      const e = addEntity(w);
      addComponent(w, e, P);
      P.value[e] = i;
      handles[i] = e;
    }
    return { P, handles };
  },
  run(state) {
    const { P, handles } = state as { P: C1; handles: number[] };
    const v = P.value;
    let sum = 0;
    for (let k = 0; k < RANDOM_ACCESS.reads; k++) sum += v[handles[accessIndex(k, RANDOM_ACCESS.entities)]];
    return sum;
  },
};

// --- frame: sim_frame ---------------------------------------------------------
// A full frame = calling the four systems as plain functions in order (bitecs has no scheduler).
// Later systems read earlier writes (Render reads Position AFTER Movement). Structural ops are
// immediate. Frozen is an empty-object marker excluded via Not(Frozen) in a buffered query.
type Health = { hp: Float64Array };
type Damage = { amount: Float64Array };
type Renderable = { acc: Float64Array };
type Particle = { life: Float64Array };
type Stunned = { since: Float64Array };
type Marker = Record<string, never>;

const sim_frame: Scenario = {
  id: "sim_frame",
  setup() {
    const Position = f2();
    const Velocity = f2();
    const Health: Health = { hp: new Float64Array(FRAME_CAP) };
    const Damage: Damage = { amount: new Float64Array(FRAME_CAP) };
    const Renderable: Renderable = { acc: new Float64Array(FRAME_CAP) };
    const Frozen: Marker = {};
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      const e = addEntity(w);
      addComponent(w, e, Position);
      Position.x[e] = 0;
      Position.y[e] = 0;
      addComponent(w, e, Velocity);
      Velocity.x[e] = 1;
      Velocity.y[e] = 2;
      if (i % 2 === 0) {
        addComponent(w, e, Health);
        Health.hp[e] = 0;
      }
      if (i % 3 === 0) {
        addComponent(w, e, Damage);
        Damage.amount[e] = 1;
      }
      if (i % 5 === 0) {
        addComponent(w, e, Renderable);
        Renderable.acc[e] = 0;
      }
      if (i % 4 === 0) addComponent(w, e, Frozen);
    }
    // Movement over [Position, Velocity] EXCLUDING Frozen → Position += Velocity.
    const Movement = (world: World) => {
      const es = eids(world, [Position, Velocity, Not(Frozen)]);
      const px = Position.x;
      const py = Position.y;
      const vx = Velocity.x;
      const vy = Velocity.y;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        px[e] += vx[e];
        py[e] += vy[e];
      }
    };
    // Regen over [Health] → hp += 1.
    const Regen = (world: World) => {
      const es = eids(world, [Health]);
      const hp = Health.hp;
      for (let i = 0; i < es.length; i++) hp[es[i]] += 1;
    };
    // ApplyDamage over [Health, Damage] → hp -= amount.
    const ApplyDamage = (world: World) => {
      const es = eids(world, [Health, Damage]);
      const hp = Health.hp;
      const amt = Damage.amount;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        hp[e] -= amt[e];
      }
    };
    // Render over [Renderable, Position] → acc += Position.x (reads Position AFTER Movement).
    const Render = (world: World) => {
      const es = eids(world, [Renderable, Position]);
      const acc = Renderable.acc;
      const px = Position.x;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        acc[e] += px[e];
      }
    };
    return { w, Position, Health, Renderable, Movement, Regen, ApplyDamage, Render };
  },
  run(state) {
    const s = state as {
      w: World;
      Position: C2;
      Health: Health;
      Renderable: Renderable;
      Movement: (w: World) => void;
      Regen: (w: World) => void;
      ApplyDamage: (w: World) => void;
      Render: (w: World) => void;
    };
    s.Movement(s.w);
    s.Regen(s.w);
    s.ApplyDamage(s.w);
    s.Render(s.w);
    // checksum = sum(Position.x over ALL) + sum(Health.hp over Health) + sum(Renderable.acc over Renderable).
    let sum = 0;
    const px = s.Position.x;
    const pe = eids(s.w, [s.Position]);
    for (let i = 0; i < pe.length; i++) sum += px[pe[i]];
    const hp = s.Health.hp;
    const he = eids(s.w, [s.Health]);
    for (let i = 0; i < he.length; i++) sum += hp[he[i]];
    const acc = s.Renderable.acc;
    const re = eids(s.w, [s.Renderable]);
    for (let i = 0; i < re.length; i++) sum += acc[re[i]];
    return sum;
  },
};

// --- frame: spawn_reap_frame --------------------------------------------------
// Move the base, spawn one Particle per base (immediate addEntity+addComponent), count Particles,
// then reap every Particle back to baseline. The Reaper snapshots the buffered eids before removing
// so swap-remove during iteration can't skip entities.
const spawn_reap_frame: Scenario = {
  id: "spawn_reap_frame",
  setup() {
    const Position = f2();
    const Velocity = f2();
    const Particle: Particle = { life: new Float64Array(FRAME_CAP) };
    const w = createWorld();
    const NUM = 5000;
    for (let i = 0; i < NUM; i++) {
      const e = addEntity(w);
      addComponent(w, e, Position);
      Position.x[e] = 0;
      Position.y[e] = 0;
      addComponent(w, e, Velocity);
      Velocity.x[e] = 1;
      Velocity.y[e] = 1;
    }
    const Movement = (world: World) => {
      const es = eids(world, [Position, Velocity]);
      const px = Position.x;
      const py = Position.y;
      const vx = Velocity.x;
      const vy = Velocity.y;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        px[e] += vx[e];
        py[e] += vy[e];
      }
    };
    // One Particle per base entity. New entities lack Position/Velocity so they don't join this
    // query; capturing the base count up front keeps the loop bounded.
    const Spawner = (world: World) => {
      const es = eids(world, [Position, Velocity]);
      const n = es.length;
      const life = Particle.life;
      for (let i = 0; i < n; i++) {
        const p = addEntity(world);
        addComponent(world, p, Particle);
        life[p] = 1;
      }
    };
    const Reaper = (world: World) => {
      const es = eids(world, [Particle]);
      const snap = Array.from(es); // snapshot: removeEntity swap-removes from the live query
      for (let i = 0; i < snap.length; i++) removeEntity(world, snap[i]);
    };
    return { w, Particle, Movement, Spawner, Reaper };
  },
  run(state) {
    const s = state as {
      w: World;
      Particle: Particle;
      Movement: (w: World) => void;
      Spawner: (w: World) => void;
      Reaper: (w: World) => void;
    };
    s.Movement(s.w); // move base
    s.Spawner(s.w); // spawn NUM particles
    const count = eids(s.w, [s.Particle]).length; // = 5000
    s.Reaper(s.w); // destroy every particle → back to baseline
    return count;
  },
};

// --- frame: toggle_frame ------------------------------------------------------
// Move, add Stunned to every [Health] NOT Stunned, count Stunned, then remove Stunned back to
// baseline. Stun/Unstun snapshot the buffered eids first since addComponent/removeComponent
// mutate the live query (swap-remove) during iteration.
const toggle_frame: Scenario = {
  id: "toggle_frame",
  setup() {
    const Position = f2();
    const Velocity = f2();
    const Health: Health = { hp: new Float64Array(FRAME_CAP) };
    const Stunned: Stunned = { since: new Float64Array(FRAME_CAP) };
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      const e = addEntity(w);
      addComponent(w, e, Position);
      Position.x[e] = 0;
      Position.y[e] = 0;
      addComponent(w, e, Velocity);
      Velocity.x[e] = 1;
      Velocity.y[e] = 1;
      addComponent(w, e, Health);
      Health.hp[e] = 100;
    }
    const Movement = (world: World) => {
      const es = eids(world, [Position, Velocity]);
      const px = Position.x;
      const vx = Velocity.x;
      for (let i = 0; i < es.length; i++) px[es[i]] += vx[es[i]];
    };
    const Stun = (world: World) => {
      const es = eids(world, [Health, Not(Stunned)]);
      const snap = Array.from(es);
      const since = Stunned.since;
      for (let i = 0; i < snap.length; i++) {
        const e = snap[i];
        addComponent(world, e, Stunned);
        since[e] = 0;
      }
    };
    const Unstun = (world: World) => {
      const es = eids(world, [Stunned]);
      const snap = Array.from(es);
      for (let i = 0; i < snap.length; i++) removeComponent(world, snap[i], Stunned);
    };
    return { w, Stunned, Movement, Stun, Unstun };
  },
  run(state) {
    const s = state as {
      w: World;
      Stunned: Stunned;
      Movement: (w: World) => void;
      Stun: (w: World) => void;
      Unstun: (w: World) => void;
    };
    s.Movement(s.w); // move base
    s.Stun(s.w); // add Stunned to every Health entity
    const count = eids(s.w, [s.Stunned]).length; // = 10000
    s.Unstun(s.w); // remove Stunned → back to baseline
    return count;
  },
};

const bench: LibraryBench = {
  name: "bitecs",
  version: "0.4.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  frames: [sim_frame, spawn_reap_frame, toggle_frame],
  extensions: [random_access],
};
export default bench;

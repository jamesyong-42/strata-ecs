/**
 * miniplex scenario implementations — idiomatic fastest form: an archetypal AoS world where entities
 * are plain objects and components are named nested objects. Every query is compiled ONCE in setup()
 * via `world.with(...)` (a connected, auto-maintained bucket) and iterated with `for..of` in run().
 * Structural ops use `world.add` / `world.remove` (entity_cycle) and `world.addComponent` /
 * `world.removeComponent` (add_remove); the entity object identity is preserved across runs, so the
 * cached entity references stay valid for mitata's repeated invocations.
 */

import { type Query, World } from "miniplex";
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

// --- frame: sim_frame (4-system frame; scheduler-less → systems are functions called in order) ---
// miniplex has no scheduler, so the "pipeline" is a fixed sequence of function calls per frame. Each
// query is a connected `with(...)`/`without(...)` bucket compiled ONCE in setup; systems mutate the
// nested component objects in place. Later systems read earlier writes (Render reads Position AFTER
// Movement) purely by call order — matching strata's phased tick.
type SimEntity = {
  position: Vec;
  velocity: Vec;
  health?: { hp: number };
  damage?: { amount: number };
  renderable?: { acc: number };
  frozen?: boolean;
};

const sim_frame: Scenario = {
  id: "sim_frame",
  setup() {
    const world = new World<SimEntity>();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      const e: SimEntity = { position: { x: 0, y: 0 }, velocity: { x: 1, y: 2 } };
      if (i % 2 === 0) e.health = { hp: 0 };
      if (i % 3 === 0) e.damage = { amount: 1 };
      if (i % 5 === 0) e.renderable = { acc: 0 };
      if (i % 4 === 0) e.frozen = true;
      world.add(e);
    }
    return {
      // Movement excludes Frozen (a plain property → .without('frozen')), reads Velocity, writes Position.
      qMove: world.with("position", "velocity").without("frozen"),
      qHealth: world.with("health"),
      qHealthDamage: world.with("health", "damage"),
      qRender: world.with("renderable", "position"),
      qPos: world.with("position"),
    };
  },
  run(state) {
    const s = state as {
      qMove: Iterable<Required<Pick<SimEntity, "position" | "velocity">>>;
      qHealth: Iterable<Required<Pick<SimEntity, "health">>>;
      qHealthDamage: Iterable<Required<Pick<SimEntity, "health" | "damage">>>;
      qRender: Iterable<Required<Pick<SimEntity, "renderable" | "position">>>;
      qPos: Iterable<Required<Pick<SimEntity, "position">>>;
    };
    // 1. Movement (non-Frozen): Position += Velocity.
    for (const e of s.qMove) {
      e.position.x += e.velocity.x;
      e.position.y += e.velocity.y;
    }
    // 2. Regen: hp += 1.
    for (const e of s.qHealth) e.health.hp += 1;
    // 3. ApplyDamage: hp -= amount.
    for (const e of s.qHealthDamage) e.health.hp -= e.damage.amount;
    // 4. Render: acc += Position.x (reads Position after Movement).
    for (const e of s.qRender) e.renderable.acc += e.position.x;
    let sum = 0;
    for (const e of s.qPos) sum += e.position.x;
    for (const e of s.qHealth) sum += e.health.hp;
    for (const e of s.qRender) sum += e.renderable.acc;
    return sum;
  },
};

// --- frame: spawn_reap_frame (a Spawner spawns then a Reaper destroys — lifecycle churn) ----------
// miniplex applies structural ops immediately (no deferral), but the spawned Particles carry neither
// Position nor Velocity, so they never enter the [position,velocity] Movement/Spawner query mid-loop.
// The Reaper iterates the connected Particle query and `world.remove`s each (reverse-safe under
// removal), returning the world to its 5000-base baseline so mitata can call run() repeatedly.
type SREntity = { position?: Vec; velocity?: Vec; particle?: { life: number } };

const spawn_reap_frame: Scenario = {
  id: "spawn_reap_frame",
  setup() {
    const world = new World<SREntity>();
    const NUM = 5000;
    for (let i = 0; i < NUM; i++) world.add({ position: { x: 0, y: 0 }, velocity: { x: 1, y: 1 } });
    return {
      world,
      qMove: world.with("position", "velocity"),
      qParticle: world.with("particle"),
    };
  },
  run(state) {
    const s = state as {
      world: World<SREntity>;
      qMove: Query<Required<Pick<SREntity, "position" | "velocity">>>;
      qParticle: Query<Required<Pick<SREntity, "particle">>>;
    };
    // (a) Movement moves the base.
    for (const e of s.qMove) {
      e.position.x += e.velocity.x;
      e.position.y += e.velocity.y;
    }
    // (b) Spawner: one Particle{life:1} per base (5000 new entities).
    for (const _ of s.qMove) s.world.add({ particle: { life: 1 } });
    // (c) count the Particles (= 5000) → checksum.
    const count = s.qParticle.size;
    // (d) Reaper destroys every Particle → back to baseline.
    for (const p of s.qParticle) s.world.remove(p);
    return count;
  },
};

// --- frame: toggle_frame (a Stun system adds then an Unstun removes a component — shape churn) -----
// Stun iterates [health] NOT stunned and `addComponent`s Stunned — which reindexes each entity OUT of
// that same query as we go (reverse-safe). Unstun iterates the connected Stunned query and
// `removeComponent`s, returning every entity to its Stunned-free baseline for repeated run() calls.
type TGEntity = { position: Vec; velocity: Vec; health: { hp: number }; stunned?: { since: number } };

const toggle_frame: Scenario = {
  id: "toggle_frame",
  setup() {
    const world = new World<TGEntity>();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      world.add({ position: { x: 0, y: 0 }, velocity: { x: 1, y: 1 }, health: { hp: 100 } });
    }
    return {
      world,
      qMove: world.with("position", "velocity"),
      qStun: world.with("health").without("stunned"),
      qStunned: world.with("stunned"),
    };
  },
  run(state) {
    const s = state as {
      world: World<TGEntity>;
      qMove: Iterable<Required<Pick<TGEntity, "position" | "velocity">>>;
      qStun: Query<Required<Pick<TGEntity, "health">>>;
      qStunned: Query<Required<Pick<TGEntity, "stunned">>>;
    };
    // (a) Movement.
    for (const e of s.qMove) {
      e.position.x += e.velocity.x;
      e.position.y += e.velocity.y;
    }
    // (b) Stun: over [health] NOT stunned → add Stunned{since:0}.
    for (const e of s.qStun) s.world.addComponent(e, "stunned", { since: 0 });
    // (c) count entities now carrying Stunned (= 10000) → checksum.
    const count = s.qStunned.size;
    // (d) Unstun: over [stunned] → remove Stunned → back to baseline.
    for (const e of s.qStunned) s.world.removeComponent(e, "stunned");
    return count;
  },
};

const bench: LibraryBench = {
  name: "miniplex",
  version: "2.0.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  frames: [sim_frame, spawn_reap_frame, toggle_frame],
  extensions: [random_access],
};
export default bench;

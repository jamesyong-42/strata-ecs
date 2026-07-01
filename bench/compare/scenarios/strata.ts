/**
 * strata scenario implementations — idiomatic fastest form: compiled queries iterated with a raw
 * `denseCount` loop over hoisted typed-array columns (`b.col(C).field`). No scheduler/tick overhead
 * on the iteration path (matching bitecs/miniplex/koota, which also iterate without a scheduler).
 */

import {
  type Component,
  type Entity,
  Not,
  type Pipeline,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineSystem,
  defineTag,
  phase,
} from "strata";
import { type LibraryBench, N, RANDOM_ACCESS, type Scenario, accessIndex } from "../contract.ts";

const VALUE = { value: "f64" } as const;
const XY = { x: "f64", y: "f64" } as const;
type F64 = Float64Array;
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

// --- frame: sim_frame (4-system frame over a mixed world; run via world.tick) ------------------
const sim_frame: Scenario = {
  id: "sim_frame",
  setup() {
    const Position = defineComponent<{ x: number; y: number }>("SF_Pos", XY);
    const Velocity = defineComponent<{ x: number; y: number }>("SF_Vel", XY);
    const Health = defineComponent<{ hp: number }>("SF_Health", { hp: "f64" });
    const Damage = defineComponent<{ amount: number }>("SF_Damage", { amount: "f64" });
    const Renderable = defineComponent<{ acc: number }>("SF_Render", { acc: "f64" });
    const Frozen = defineTag("SF_Frozen");
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      const comps: [Component, Record<string, unknown>][] = [
        [Position, { x: 0, y: 0 }],
        [Velocity, { x: 1, y: 2 }],
      ];
      if (i % 2 === 0) comps.push([Health, { hp: 0 }]);
      if (i % 3 === 0) comps.push([Damage, { amount: 1 }]);
      if (i % 5 === 0) comps.push([Renderable, { acc: 0 }]);
      w.spawn({ components: comps, tags: i % 4 === 0 ? [Frozen] : [] });
    }
    // Movement excludes Frozen (per-row tag filter), reads Velocity, writes Position. Uses the
    // generator-free matched-row fast path: raw loop over b.rows[0..count).
    const Movement = defineSystem(defineQuery([Position, Velocity, Not(Frozen)]), (b) => {
      const px = b.col(Position).x as F64;
      const py = b.col(Position).y as F64;
      const vx = b.col(Velocity).x as F64;
      const vy = b.col(Velocity).y as F64;
      const rows = b.rows;
      for (let i = 0; i < b.count; i++) {
        const r = rows[i];
        px[r] += vx[r];
        py[r] += vy[r];
      }
    });
    const Regen = defineSystem(defineQuery([Health]), (b) => {
      const hp = b.col(Health).hp as F64;
      for (let r = 0; r < b.denseCount; r++) hp[r] += 1;
    });
    const ApplyDamage = defineSystem(defineQuery([Health, Damage]), (b) => {
      const hp = b.col(Health).hp as F64;
      const amt = b.col(Damage).amount as F64;
      for (let r = 0; r < b.denseCount; r++) hp[r] -= amt[r];
    });
    const Render = defineSystem(defineQuery([Renderable, Position]), (b) => {
      const acc = b.col(Renderable).acc as F64;
      const px = b.col(Position).x as F64;
      for (let r = 0; r < b.denseCount; r++) acc[r] += px[r];
    });
    const pipeline: Pipeline = [phase("frame", [Movement, Regen, ApplyDamage, Render])];
    return {
      w, Position, Health, Renderable, pipeline,
      qPos: defineQuery([Position]), qHealth: defineQuery([Health]), qRender: defineQuery([Renderable]),
    };
  },
  run(state) {
    const s = state as {
      w: World; Position: Component; Health: Component; Renderable: Component; pipeline: Pipeline;
      qPos: ReturnType<typeof defineQuery>; qHealth: ReturnType<typeof defineQuery>; qRender: ReturnType<typeof defineQuery>;
    };
    s.w.tick(s.pipeline);
    let sum = 0;
    s.w.query(s.qPos).each((b) => { const px = b.col(s.Position).x as F64; for (let r = 0; r < b.denseCount; r++) sum += px[r]; });
    s.w.query(s.qHealth).each((b) => { const hp = b.col(s.Health).hp as F64; for (let r = 0; r < b.denseCount; r++) sum += hp[r]; });
    s.w.query(s.qRender).each((b) => { const acc = b.col(s.Renderable).acc as F64; for (let r = 0; r < b.denseCount; r++) sum += acc[r]; });
    return sum;
  },
};

// --- frame: spawn_reap_frame (systems spawn then destroy entities via ctx, deferred) -----------
const spawn_reap_frame: Scenario = {
  id: "spawn_reap_frame",
  setup() {
    const Position = defineComponent<{ x: number; y: number }>("SR_Pos", XY);
    const Velocity = defineComponent<{ x: number; y: number }>("SR_Vel", XY);
    const Particle = defineComponent<{ life: number }>("SR_Particle", { life: "f64" });
    const w = createWorld();
    const NUM = 5000;
    for (let i = 0; i < NUM; i++) w.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 1 }]] });
    const Movement = defineSystem(defineQuery([Position, Velocity]), (b) => {
      const px = b.col(Position).x as F64;
      const py = b.col(Position).y as F64;
      const vx = b.col(Velocity).x as F64;
      const vy = b.col(Velocity).y as F64;
      for (let r = 0; r < b.denseCount; r++) { px[r] += vx[r]; py[r] += vy[r]; }
    });
    const Spawner = defineSystem(defineQuery([Position, Velocity]), (b, ctx) => {
      for (let r = 0; r < b.denseCount; r++) ctx.spawn({ components: [[Particle, { life: 1 }]] });
    });
    const Reaper = defineSystem(defineQuery([Particle]), (b, ctx) => {
      const rows = b.rows;
      for (let i = 0; i < b.count; i++) ctx.destroy(b.entity(rows[i]));
    });
    return {
      w, qParticle: defineQuery([Particle]),
      spawnPhase: [phase("spawn", [Movement, Spawner])] as Pipeline,
      reapPhase: [phase("reap", [Reaper])] as Pipeline,
    };
  },
  run(state) {
    const s = state as { w: World; qParticle: ReturnType<typeof defineQuery>; spawnPhase: Pipeline; reapPhase: Pipeline };
    s.w.tick(s.spawnPhase); // move base + defer NUM ctx.spawns (applied at the phase boundary)
    let count = 0;
    s.w.query(s.qParticle).each((b) => { count += b.denseCount; });
    s.w.tick(s.reapPhase); // ctx.destroy every particle → back to baseline
    return count;
  },
};

// --- frame: toggle_frame (a system adds then removes a component via ctx, deferred) ------------
const toggle_frame: Scenario = {
  id: "toggle_frame",
  setup() {
    const Position = defineComponent<{ x: number; y: number }>("TG_Pos", XY);
    const Velocity = defineComponent<{ x: number; y: number }>("TG_Vel", XY);
    const Health = defineComponent<{ hp: number }>("TG_Health", { hp: "f64" });
    const Stunned = defineComponent<{ since: number }>("TG_Stunned", { since: "f64" });
    const w = createWorld();
    const NUM = 10_000;
    for (let i = 0; i < NUM; i++) {
      w.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 1 }], [Health, { hp: 100 }]] });
    }
    const Movement = defineSystem(defineQuery([Position, Velocity]), (b) => {
      const px = b.col(Position).x as F64;
      const vx = b.col(Velocity).x as F64;
      for (let r = 0; r < b.denseCount; r++) px[r] += vx[r];
    });
    const Stun = defineSystem(defineQuery([Health, Not(Stunned)]), (b, ctx) => {
      for (let r = 0; r < b.denseCount; r++) ctx.addComponent(b.entity(r), Stunned, { since: 0 });
    });
    const Unstun = defineSystem(defineQuery([Stunned]), (b, ctx) => {
      for (let r = 0; r < b.denseCount; r++) ctx.removeComponent(b.entity(r), Stunned);
    });
    return {
      w, qStunned: defineQuery([Stunned]),
      stunPhase: [phase("stun", [Movement, Stun])] as Pipeline,
      unstunPhase: [phase("unstun", [Unstun])] as Pipeline,
    };
  },
  run(state) {
    const s = state as { w: World; qStunned: ReturnType<typeof defineQuery>; stunPhase: Pipeline; unstunPhase: Pipeline };
    s.w.tick(s.stunPhase); // defer addComponent Stunned to every Health entity (archetype migration at boundary)
    let count = 0;
    s.w.query(s.qStunned).each((b) => { count += b.denseCount; });
    s.w.tick(s.unstunPhase); // defer removeComponent → back to baseline
    return count;
  },
};

const bench: LibraryBench = {
  name: "strata",
  version: "0.0.0",
  scenarios: [packed_5, simple_iter, frag_iter, entity_cycle, add_remove],
  frames: [sim_frame, spawn_reap_frame, toggle_frame],
  extensions: [serialize, random_access],
};
export default bench;

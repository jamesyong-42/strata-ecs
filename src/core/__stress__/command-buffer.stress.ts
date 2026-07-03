/**
 * Stress: the command buffer under a deep single-phase batch and the flush-time ordering hazards
 * (design §5.4, §5.5). Verifies the single-pass drain applies every deferred op, the pool does not
 * leak across ticks, and validate-on-read / dev-error-skip policies hold under load.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type Entity,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineSystem,
  defineTag,
  phase,
} from "../index";
import { scaled } from "./harness";

const Base = defineComponent("CBBase", { v: "u32" });
const Spawned = defineComponent("CBSpawned", { v: "u32" });
const Marked = defineTag("CBMarked");
const Parent = defineRelation("CBParent", { arity: "one" });

function collectSpawned(world: ReturnType<typeof createWorld>): Entity[] {
  const out: Entity[] = [];
  world.query(defineQuery([Spawned])).each((b) => {
    for (const r of b) out.push(b.entity(r));
  });
  return out;
}

describe("stress: deep command buffer within one phase (§5.4/§5.5)", () => {
  it("applies a spawn+tag+relation per row across a large query, with no leak across ticks", () => {
    const N = scaled(2000);
    const world = createWorld();
    const bases: Entity[] = [];
    for (let i = 0; i < N; i++) bases.push(world.spawn({ components: [[Base, { v: i }]] }));

    // Each row defers three ops (spawn child, tag it via spawn init, relate it to its base) →
    // ~2N commands accumulate in one phase buffer, flushed once at the boundary.
    const sys = defineSystem(defineQuery([Base]), (batch, ctx) => {
      for (const r of batch) {
        const base = batch.entity(r);
        const child = ctx.spawn({ components: [[Spawned, { v: 1 }]], tags: [Marked] });
        ctx.setRelation(child, Parent, base);
      }
    });
    const pipe = [phase("spawnChildren", [sys])];

    world.tick(pipe);
    const children = collectSpawned(world);
    expect(children.length).toBe(N);
    for (const c of children) {
      expect(world.hasTag(c, Marked)).toBe(true);
      const p = world.getRelation(c, Parent);
      expect(p).toBeDefined();
      expect(world.has(p as Entity, Base)).toBe(true);
    }

    // Re-ticking must reuse the pooled buffer cleanly: only [Base] matches (children carry
    // Spawned, not Base), so exactly N more children appear — no residue, no double-apply.
    world.tick(pipe);
    expect(collectSpawned(world).length).toBe(2 * N);
  });

  it("destroy-then-add in the same phase: validate-on-read skips the stranded add", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Base, { v: 1 }]] });
    const sys = defineSystem(defineQuery([Base]), (batch, ctx) => {
      for (const r of batch) {
        const x = batch.entity(r);
        ctx.destroy(x);
        ctx.addComponent(x, Spawned, { v: 2 }); // enqueued, but x is freed first at flush → skipped
      }
    });
    world.tick([phase("p", [sys])]);
    expect(world.isAlive(e)).toBe(false);
  });

  it("double-add of one component in a phase: the second is a dev-error skip, first write wins", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Base, { v: 1 }]] });
    const sys = defineSystem(defineQuery([Base]), (batch, ctx) => {
      for (const r of batch) {
        const x = batch.entity(r);
        ctx.addComponent(x, Spawned, { v: 10 });
        ctx.addComponent(x, Spawned, { v: 20 }); // both enqueue (state not yet applied); 2nd skips at flush
      }
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    world.tick([phase("p", [sys])]);
    const errored = spy.mock.calls.length; // capture before restore (mockRestore clears history)
    spy.mockRestore();

    expect(errored).toBeGreaterThan(0); // the second add emitted a dev-error
    expect(world.has(e, Spawned)).toBe(true);
    expect(world.read(e, Spawned)).toEqual({ v: 10 }); // first add wins; second was skipped
  });
});

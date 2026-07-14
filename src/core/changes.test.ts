/**
 * Patch Note 004 — the pull-based ChangeCollector (petition 7: change
 * detection for eager derivation systems).
 *
 * Contracts under test: exact journaling at every sparse chokepoint
 * (edit/set, add/remove component, spawn, destroy, tag flips — immediate AND
 * ctx-flush paths); `removed` reserved for destroys (component removal is
 * `changed` — the consumer rechecks); per-window dedup; drain cursor +
 * buffer-reuse allocation contract; the reset marker; the coarse
 * declared-writes fallback for raw column writers; and GATE INDEPENDENCE —
 * collectors neither arm nor require the reactive layer.
 */
import { describe, expect, it } from "vitest";
import {
  createWorld,
  defineComponent,
  defineQuery,
  defineTag,
  defineTickSystem,
  phase,
  type Pipeline,
} from "./index";

const Pos = defineComponent("CHPos", { x: "f32", y: "f32" });
const Sz = defineComponent("CHSz", { w: "f32" });
const Other = defineComponent("CHOther", { n: "u32" });
const Live = defineTag("CHLive");
const Aside = defineTag("CHAside");

describe("exact journal — immediate mutation routes", () => {
  it("value write / addComponent / removeComponent / spawn → changed; unsubscribed stays silent", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos, Sz] });

    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // spawn with subscribed comp
    const b = world.spawn({ components: [[Other, { n: 1 }]] }); // unsubscribed only
    let d = col.drain();
    expect(d.changed).toEqual([a]);
    expect(d.removed).toEqual([]);
    expect(d.reset).toBe(false);

    world.edit(a).set(Pos, { x: 5, y: 5 }); // value overwrite
    world.addComponent(b, Sz, { w: 9 }); // migrate-add of a subscribed comp
    d = col.drain();
    expect([...d.changed].sort()).toEqual([a, b].sort());

    world.removeComponent(b, Sz); // removal → CHANGED (alive + recheckable), not removed
    d = col.drain();
    expect(d.changed).toEqual([b]);
    expect(d.removed).toEqual([]);

    world.edit(b).set(Other, { n: 2 }); // unsubscribed write → silent
    expect(col.drain().changed).toEqual([]);
  });

  it("destroy → removed (wins over an earlier changed in the same window); handle is the packed key", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const a = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    col.drain();

    world.edit(a).set(Pos, { x: 2, y: 2 });
    world.destroy(a);
    const d = col.drain();
    expect(d.changed).toEqual([]); // removed wins — dead entities are not recheckable
    expect(d.removed).toEqual([a]); // the packed handle survives as a removal key
    expect(world.isAlive(a)).toBe(false);
  });

  it("tag flips on subscribed tags → changed; tagged destroy → removed via the tag route", () => {
    const world = createWorld();
    const col = world.changes.collect({ tags: [Live] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    world.addTag(a, Live);
    expect(col.drain().changed).toEqual([a]);
    world.removeTag(a, Live);
    expect(col.drain().changed).toEqual([a]);

    world.addTag(a, Aside); // unsubscribed tag → silent
    expect(col.drain().changed).toEqual([]);

    world.addTag(a, Live);
    col.drain();
    world.destroy(a); // carried the subscribed tag → removed
    expect(col.drain().removed).toEqual([a]);
  });
});

describe("exact journal — ctx flush route (deferred mutations land at the phase boundary)", () => {
  it("ctx.edit / ctx.addTag / ctx.destroy journal exactly like the immediate path", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos], tags: [Live] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const b = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    const sys = defineTickSystem(
      (ctx) => {
        ctx.edit(a).set(Pos, { x: 7, y: 7 });
        ctx.addTag(a, Live);
        ctx.destroy(b);
      },
      { name: "chFlush", access: { write: [Pos] } },
    );
    const pipeline: Pipeline = [phase("p", [sys])];
    world.tick(pipeline);

    const d = col.drain();
    expect(d.changed).toEqual([a]); // deduped: value write + tag flip = one entry
    expect(d.removed).toEqual([b]);
  });
});

describe("drain cursor, dedup, buffers, clear, dispose", () => {
  it("dedups within a window; drain resets the cursor; buffers are REUSED across drains", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    world.edit(a).set(Pos, { x: 1, y: 0 });
    world.edit(a).set(Pos, { x: 2, y: 0 });
    world.edit(a).set(Pos, { x: 3, y: 0 });
    const d1 = col.drain();
    expect(d1.changed).toEqual([a]); // three writes, one entry
    const buf = d1.changed;

    const d2 = col.drain();
    expect(d2.changed).toEqual([]); // cursor advanced
    // Allocation contract: the SAME array object, mutated in place — valid
    // only until the next drain (a per-frame drain allocates nothing).
    expect(d2.changed).toBe(buf);
  });

  it("clear() discards without reading; dispose() detaches for good", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    world.edit(a).set(Pos, { x: 1, y: 1 });
    col.clear();
    expect(col.drain().changed).toEqual([]);

    col.dispose();
    world.edit(a).set(Pos, { x: 2, y: 2 });
    expect(col.drain().changed).toEqual([]); // detached — no further journaling

    // A second live collector is unaffected by the first's dispose.
    const col2 = world.changes.collect({ components: [Pos] });
    world.edit(a).set(Pos, { x: 3, y: 3 });
    expect(col2.drain().changed).toEqual([a]);
  });
});

describe("the reset marker", () => {
  it("world.reset() subsumes the journal: reset:true, entity lists emptied", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    world.edit(a).set(Pos, { x: 1, y: 1 });
    world.reset();
    const d = col.drain();
    expect(d.reset).toBe(true);
    expect(d.changed).toEqual([]); // wholesale rebuild — per-entity records are noise
    expect(d.removed).toEqual([]);
    expect(col.drain().reset).toBe(false); // consumed
  });
});

describe("coarse fallback — raw column writers report via declared access.write", () => {
  it("a tick system's raw col() writes surface as coarse components, WITHOUT the reactive layer", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();
    expect(world.isReactiveEnabled).toBe(false); // reactive untouched throughout

    const q = defineQuery([Pos]);
    const raw = defineTickSystem(
      (ctx) => {
        ctx.query(q).each((b) => {
          const xs = b.col(Pos).x;
          for (const r of b) (xs as Float32Array)[r] = 42; // invisible to the exact journal
        });
      },
      { name: "chRaw", access: { write: [Pos] } },
    );
    world.tick([phase("p", [raw])]);

    const d = col.drain();
    expect(d.changed).toEqual([]); // the store never saw the entity
    expect(d.coarse).toEqual([Pos]); // …but the blanket names the component — re-scan your query
    expect(world.get(e, Pos)?.x).toBe(42);
    expect(world.isReactiveEnabled).toBe(false); // GATE INDEPENDENCE: collectors never arm reactive
  });

  it("declared writes on UNSUBSCRIBED components stay silent", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Sz] });
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    const q = defineQuery([Pos]);
    const raw = defineTickSystem(
      (ctx) => {
        ctx.query(q).each((b) => {
          const xs = b.col(Pos).x;
          for (const r of b) (xs as Float32Array)[r] = 1;
        });
      },
      { name: "chRaw2", access: { write: [Pos] } },
    );
    world.tick([phase("p", [raw])]);
    expect(col.drain().coarse).toEqual([]);
  });
});

describe("gate independence — the other direction", () => {
  it("arming the reactive layer does not create journal entries; both layers coexist", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos] });
    const a = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    let observed = 0;
    world.reactive.observeQuery(defineQuery([Pos]), () => observed++, { cols: [Pos] });
    expect(world.isReactiveEnabled).toBe(true);

    world.edit(a).set(Pos, { x: 9, y: 9 });
    expect(col.drain().changed).toEqual([a]); // journal still exact
    world.reactive.notify(); // reactive delivers at its own boundary
    expect(observed).toBeGreaterThan(0);
  });
});

describe("coarse opt-out (the exact-writers attestation)", () => {
  it("coarse: false suppresses blanket records; exact journaling is unaffected", () => {
    const world = createWorld();
    const col = world.changes.collect({ components: [Pos], coarse: false });
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    col.drain();

    const q = defineQuery([Pos]);
    const raw = defineTickSystem(
      (ctx) => {
        ctx.query(q).each((b) => {
          const xs = b.col(Pos).x;
          for (const r of b) (xs as Float32Array)[r] = 5; // attested away — NOT reported
        });
      },
      { name: "chRaw3", access: { write: [Pos] } },
    );
    world.tick([phase("p", [raw])]);
    const d = col.drain();
    expect(d.coarse).toEqual([]); // the attestation: raw writers are the consumer's problem now
    expect(d.changed).toEqual([]);

    world.edit(e).set(Pos, { x: 6, y: 6 }); // exact path still journals
    expect(col.drain().changed).toEqual([e]);
  });
});

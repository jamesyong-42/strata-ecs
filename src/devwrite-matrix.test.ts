/**
 * The `world.devOnWrite` MATRIX (petition 4) — a table pinning WHICH internal mutation chokepoints fire
 * the DEV pre-mutation write hook, with WHICH {@link WriteKind}, and how a THROWING hook behaves (the veto).
 *
 * Placed at the `src` root (beside example.test.ts) rather than under `src/core`, because the contract is
 * that devOnWrite observes EVERY route into the runtime — so the matrix must exercise the durable and
 * ephemeral projection paths too, which import the optional layers (`./durable`, `./ephemeral`) on top of
 * `./core`. The declarative style mirrors `src/core/enforcement-matrix.test.ts`.
 *
 * The contract under test (petition 4):
 *   - FIRES synchronously, BEFORE each mutation, at strata's internal chokepoints — so world.* mutators,
 *     `edit().set`, the deferred `ctx.*` command-buffer flush, durable `tx` record/seal, `sync()`/attach
 *     drains, undo/redo echoes, ephemeral mutators + inbound projection, `import`, and `reset` are ALL
 *     observed, INCLUDING strata's own runtime-local status-resource writes during sync/attach.
 *   - A compound op fires MORE THAN ONCE and may span kinds: fire-at-least-once-pre-mutation-per-logical
 *     write, MAY over-fire, NEVER miss. Assertions are therefore INCLUSION (`toContain`), never exact-match.
 *   - THROWS PROPAGATE (unlike WorldObserver callbacks, which are swallowed). For a single-op mutation the
 *     fire precedes the first state change, so a throwing hook is a clean VETO.
 *
 * PROD-MODE NOTE (item 6): that `devOnWrite` is a no-op under `NODE_ENV=production` is NOT testable
 * in-process — `DEV` (src/core/dev.ts) is a MODULE-LOAD const, fixed the moment the module graph
 * evaluated, so a test cannot flip it after import. That path is covered by the build/bundle DCE, not here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LoroDoc, EphemeralStore as LoroEphemeralStore } from "loro-crdt";
import {
  type Entity,
  type ReadonlyWorld,
  type WorldMutatorName,
  type WriteKind,
  Local,
  Not,
  World,
  createWorld,
  defineComponent,
  defineQuery,
  defineRelation,
  defineResource,
  defineSystem,
  defineTag,
  phase,
} from "./core";
import { attachDurable, createDurableStore } from "./durable";
import {
  type EphemeralSource,
  attachEphemeral,
  createEphemeralStore,
  LoroEphemeralSnapshot,
} from "./ephemeral";

// --- process-global schema (DW-prefixed to stay unique across the suite) ----------------------------
const Pos = defineComponent("DWPos", { x: "f32", y: "f32" });
const Vel = defineComponent("DWVel", { x: "f32", y: "f32" });
const Sel = defineTag("DWSel");
const Parent = defineRelation("DWParent", { arity: "one" });
const Children = defineRelation("DWChildren", { arity: "many" });
const Stacked = defineRelation("DWStacked", { arity: "one", ordered: true });
const Cam = defineResource("DWCam", { zoom: "f32" });
const qPos = defineQuery([Pos]);

/** Snapshot bytes of a one-entity world — the payload for the `import` routes (distinct value from any setup). */
const POPULATED_BYTES = (() => {
  const w = createWorld();
  w.spawn({ components: [[Pos, { x: 7, y: 8 }]] });
  return w.export();
})();

/** A hook that records every kind it is told about — the recording half of the matrix. */
function recorder(): { kinds: WriteKind[]; cb: (k: WriteKind) => void; reset: () => void } {
  const kinds: WriteKind[] = [];
  return { kinds, cb: (k) => kinds.push(k), reset: () => (kinds.length = 0) };
}

// ===================================================================================================
// 1. ROUTE TABLE — world.* (each records ≥1 with the expected kind; a throwing hook propagates)
// ===================================================================================================

interface WorldRoute {
  name: string;
  mutator: WorldMutatorName;
  /** Build a fresh world + any entities the act needs. Runs BEFORE the hook registers, so setup never records. */
  setup: () => { world: World; e?: Entity; target?: Entity };
  act: (ctx: { world: World; e?: Entity; target?: Entity }) => void;
  /** The kind(s) the recording hook MUST include (inclusion, not exact — compound ops over-fire). */
  expect: WriteKind[];
}

const worldRoutes: WorldRoute[] = [
  {
    name: "spawn",
    mutator: "spawn",
    setup: () => ({ world: createWorld() }),
    act: (c) => void c.world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }),
    expect: ["structural"],
  },
  {
    name: "destroy",
    mutator: "destroy",
    setup: () => {
      const world = createWorld();
      return { world, e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }) };
    },
    act: (c) => c.world.destroy(c.e!),
    expect: ["structural"],
  },
  {
    name: "addComponent",
    mutator: "addComponent",
    setup: () => {
      const world = createWorld();
      return { world, e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }) };
    },
    act: (c) => c.world.addComponent(c.e!, Vel, { x: 1, y: 1 }),
    expect: ["structural"], // add/removeComponent migrate archetypes → "structural", never "component"
  },
  {
    name: "removeComponent",
    mutator: "removeComponent",
    setup: () => {
      const world = createWorld();
      return {
        world,
        e: world.spawn({
          components: [
            [Pos, { x: 0, y: 0 }],
            [Vel, { x: 1, y: 1 }],
          ],
        }),
      };
    },
    act: (c) => c.world.removeComponent(c.e!, Vel),
    expect: ["structural"],
  },
  {
    name: "addTag",
    mutator: "addTag",
    setup: () => {
      const world = createWorld();
      return { world, e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }) }; // placed → addTag fires only "tag"
    },
    act: (c) => c.world.addTag(c.e!, Sel),
    expect: ["tag"],
  },
  {
    name: "removeTag",
    mutator: "removeTag",
    setup: () => {
      const world = createWorld();
      const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
      world.addTag(e, Sel);
      return { world, e };
    },
    act: (c) => c.world.removeTag(c.e!, Sel),
    expect: ["tag"],
  },
  {
    name: "setRelation",
    mutator: "setRelation",
    setup: () => {
      const world = createWorld();
      return {
        world,
        e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }),
        target: world.spawn({ components: [[Pos, { x: 1, y: 1 }]] }),
      };
    },
    act: (c) => c.world.setRelation(c.e!, Parent, c.target!),
    expect: ["relation"],
  },
  {
    name: "moveRelation",
    mutator: "moveRelation",
    setup: () => {
      const world = createWorld();
      const target = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
      const sib = world.spawn({ components: [[Pos, { x: 2, y: 2 }]] });
      const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
      world.setRelation(sib, Stacked, target);
      world.setRelation(e, Stacked, target);
      return { world, e, target };
    },
    act: (c) => c.world.moveRelation(c.e!, Stacked, "first"),
    expect: ["relation"],
  },
  {
    name: "addRelation",
    mutator: "addRelation",
    setup: () => {
      const world = createWorld();
      return {
        world,
        e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }),
        target: world.spawn({ components: [[Pos, { x: 1, y: 1 }]] }),
      };
    },
    act: (c) => c.world.addRelation(c.e!, Children, c.target!),
    expect: ["relation"],
  },
  {
    name: "removeRelation",
    mutator: "removeRelation",
    setup: () => {
      const world = createWorld();
      const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
      const target = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
      world.addRelation(e, Children, target);
      return { world, e, target };
    },
    act: (c) => c.world.removeRelation(c.e!, Children, c.target!),
    expect: ["relation"],
  },
  {
    name: "edit().set",
    mutator: "edit",
    setup: () => {
      const world = createWorld();
      return { world, e: world.spawn({ components: [[Pos, { x: 1, y: 1 }]] }) };
    },
    act: (c) => void c.world.edit(c.e!).set(Pos, { x: 9, y: 9 }),
    expect: ["component"], // value overwrite of a present component
  },
  {
    name: "setResource",
    mutator: "setResource",
    setup: () => ({ world: createWorld() }),
    act: (c) => c.world.setResource(Cam, { zoom: 1 }),
    expect: ["resource"],
  },
  {
    name: "updateResource",
    mutator: "updateResource",
    setup: () => {
      const world = createWorld();
      world.setResource(Cam, { zoom: 1 });
      return { world };
    },
    act: (c) => c.world.updateResource(Cam, (v) => ({ zoom: v.zoom + 1 })),
    expect: ["resource"],
  },
  {
    name: "removeResource",
    mutator: "removeResource",
    setup: () => {
      const world = createWorld();
      world.setResource(Cam, { zoom: 1 });
      return { world };
    },
    act: (c) => c.world.removeResource(Cam),
    expect: ["resource"],
  },
  {
    name: "import (plain, empty world)",
    mutator: "import",
    setup: () => ({ world: createWorld() }),
    act: (c) => c.world.import(POPULATED_BYTES),
    expect: ["structural"],
  },
  {
    name: "import({replace:true})",
    mutator: "import",
    setup: () => {
      const world = createWorld();
      return { world, e: world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }) };
    },
    act: (c) => c.world.import(POPULATED_BYTES, { replace: true }),
    expect: ["structural"],
  },
  {
    name: "reset",
    mutator: "reset",
    setup: () => {
      const world = createWorld();
      world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
      return { world };
    },
    act: (c) => c.world.reset(),
    expect: ["structural"],
  },
];

describe("route table — world.* mutators fire the expected kind and propagate throws", () => {
  for (const route of worldRoutes) {
    it(`${route.name} → records ${route.expect.join("+")} (≥1) and a throwing hook propagates`, () => {
      // (a) a recording hook fires ≥1 with the expected kind(s)
      const rc = route.setup();
      const rec = recorder();
      rc.world.devOnWrite(rec.cb);
      route.act(rc);
      expect(rec.kinds.length).toBeGreaterThan(0);
      for (const k of route.expect) expect(rec.kinds).toContain(k);

      // (b) route-appropriate throw behavior: a throwing hook propagates from the same route
      const rc2 = route.setup();
      rc2.world.devOnWrite(() => {
        throw new Error(`veto:${route.name}`);
      });
      expect(() => route.act(rc2)).toThrow(`veto:${route.name}`);
    });
  }
});

// ===================================================================================================
// 2. ROUTE TABLE — ctx.* inside a ticking system (mint-time vs flush-time fires)
// ===================================================================================================

/** Tick a single-system pipeline whose body runs `op` once per matching row (the entity carries Pos). */
function tickWithBody(
  world: World,
  op: (ctx: import("./core").SystemCtx, self: Entity, target: Entity) => void,
  target: Entity,
): void {
  const sys = defineSystem(qPos, (batch, ctx) => {
    for (const r of batch) op(ctx, batch.entity(r), target);
  });
  world.tick([phase("p", [sys])]);
}

describe("route table — ctx.* (deferred) fire at identity-mint and at the phase flush", () => {
  it("ctx.spawn fires structural at mint time AND again at the flush", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] }); // the row the system iterates
    const rec = recorder();
    world.devOnWrite(rec.cb);
    tickWithBody(world, (ctx) => void ctx.spawn({ components: [[Pos, { x: 5, y: 5 }]] }), 0 as unknown as Entity);
    // mint (allocateIdentity, during the body) + placement (placeComposed → place, at the flush) both structural
    expect(rec.kinds.filter((k) => k === "structural").length).toBeGreaterThanOrEqual(2);
  });

  it("ctx.destroy fires structural at the flush", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    tickWithBody(world, (ctx, self) => ctx.destroy(self), e);
    expect(rec.kinds).toContain("structural");
  });

  it("ctx.addComponent fires structural at the flush", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    tickWithBody(world, (ctx, self) => ctx.addComponent(self, Vel, { x: 1, y: 1 }), 0 as unknown as Entity);
    expect(rec.kinds).toContain("structural");
  });

  it("ctx.addTag fires tag at the flush", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    tickWithBody(world, (ctx, self) => ctx.addTag(self, Sel), 0 as unknown as Entity);
    expect(rec.kinds).toContain("tag");
  });

  it("ctx.setRelation fires relation at the flush", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const target = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    tickWithBody(world, (ctx, self, t) => ctx.setRelation(self, Parent, t), target);
    expect(rec.kinds).toContain("relation");
  });

  it("a tick whose systems only READ fires NOTHING (no fire on a read path)", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    const reader = defineSystem(qPos, (batch, ctx) => {
      for (const r of batch) {
        batch.col(Pos); // column read
        ctx.read(batch.entity(r), Pos); // handle read
      }
    });
    world.tick([phase("p", [reader])]);
    expect(rec.kinds).toEqual([]); // query iteration + reads never fire (guards a mis-gated read path)
  });

  it("an out-of-tick query().each() read fires NOTHING", () => {
    const world = createWorld();
    world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const rec = recorder();
    world.devOnWrite(rec.cb);
    world.query(qPos).each((b) => {
      for (let i = 0; i < b.count; i++) b.col(Pos);
    });
    world.count(qPos);
    world.read(world.firstOf(qPos)!, Pos);
    expect(rec.kinds).toEqual([]);
  });
});

// ===================================================================================================
// 3. ROUTE TABLE — durable (record-time, seal-time, projection-at-sync, remote drain, undo echo)
// ===================================================================================================

function makeDurableStore(peerId: number): ReturnType<typeof createDurableStore> {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/** A single attached durable peer — for local record/seal + own-echo projection. */
function makeDurablePeer(peerId: number): { store: ReturnType<typeof createDurableStore>; world: World } {
  const store = makeDurableStore(peerId);
  const world = createWorld();
  attachDurable(world, store);
  return { store, world };
}

/**
 * Two attached peers with a buffered outbound wire both ways + the bidirectional snapshot bootstrap
 * (mirrors reconcile.test.ts's `twoPeers`). `deliverToB` applies A's queued increments to B.
 */
function twoDurablePeers() {
  const a = makeDurableStore(1);
  const wA = createWorld();
  attachDurable(wA, a);
  const b = makeDurableStore(2);
  const wB = createWorld();
  attachDurable(wB, b);
  b.applyRemote(a.snapshot.export());
  a.applyRemote(b.snapshot.export());
  wA.sync();
  wB.sync();
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  a.subscribeOutbound((x) => toB.push(x));
  b.subscribeOutbound((x) => toA.push(x));
  const deliverToB = () => {
    for (const x of toB.splice(0)) b.applyRemote(x);
  };
  const deliverToA = () => {
    for (const x of toA.splice(0)) a.applyRemote(x);
  };
  return { a, wA, b, wB, deliverToB, deliverToA };
}

describe("route table — durable record / seal / projection", () => {
  it("tx.spawn fires structural at RECORD time (before sync)", () => {
    const { store, world } = makeDurablePeer(1);
    const rec = recorder();
    world.devOnWrite(rec.cb);
    store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 0, y: 0 }]] }));
    expect(rec.kinds).toContain("structural"); // allocateIdentity fires synchronously during recording
    void world;
  });

  it("tx.edit on a PRE-EXISTING component fires component at seal", () => {
    const { store, world } = makeDurablePeer(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 0, y: 0 }]] }));
    world.sync(); // project Pos → it becomes pre-existing in the baseline
    const rec = recorder();
    world.devOnWrite(rec.cb);
    store.transaction((tx) => tx.edit(h).set(Pos, { x: 5, y: 5 }));
    expect(rec.kinds).toContain("component"); // seal stage 1: synchronous writeComponent
  });

  it("tx.setResource / tx.removeResource fire resource at seal", () => {
    const { store, world } = makeDurablePeer(1);
    const recSet = recorder();
    const dispose = world.devOnWrite(recSet.cb);
    store.transaction((tx) => tx.setResource(Cam, { zoom: 1 }));
    expect(recSet.kinds).toContain("resource"); // seal stage 2: runtime setResource
    dispose();
    const recRem = recorder();
    world.devOnWrite(recRem.cb);
    store.transaction((tx) => tx.removeResource(Cam));
    expect(recRem.kinds).toContain("resource");
  });

  it("tx.addComponent projects structural at the NEXT world.sync(), not at seal", () => {
    const { store, world } = makeDurablePeer(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 0, y: 0 }]] }));
    world.sync();
    const rec = recorder();
    world.devOnWrite(rec.cb);
    store.transaction((tx) => tx.addComponent(h, Vel, { x: 1, y: 1 }));
    // structure is document-only at seal — the runtime is untouched until it projects
    expect(rec.kinds).not.toContain("structural");
    rec.reset();
    world.sync();
    expect(rec.kinds).toContain("structural"); // own-echo projection migrates the archetype now
    expect(world.has(h, Vel)).toBe(true);
  });

  it("remote-import drain: component-set / tag-add / relation-set / resource-set facts each fire on sync", () => {
    const h = twoDurablePeers();
    const e1 = h.a.transaction((tx) => {
      const x = tx.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
      tx.addTag(x, Sel);
      return x;
    });
    const e2 = h.a.transaction((tx) => tx.spawn({ components: [[Pos, { x: 3, y: 4 }]] }));
    h.a.transaction((tx) => tx.setRelation(e1, Parent, e2));
    h.wA.sync(); // A projects its own echoes; outbound increments queue for B

    // Register BEFORE deliverToB: DurableSyncStatus publishes at ENQUEUE (pendingInbound 0→1) as
    // well as at drain, so both measured windows below must span enqueue+drain SYMMETRICALLY.
    const rec = recorder();
    h.wB.devOnWrite(rec.cb);
    rec.reset();
    h.deliverToB();
    h.wB.sync(); // B drains A's REMOTE facts through the projector (NO resource fact in this drain)

    const kinds = new Set(rec.kinds);
    expect(kinds.has("structural")).toBe(true); // spawn/component placement + relation-source placement
    expect(kinds.has("tag")).toBe(true); // tag-add
    expect(kinds.has("relation")).toBe(true); // relation-set
    // B's own DurableSyncStatus/UndoStatus writes fire "resource" on ANY non-empty enqueue+drain, so a
    // bare kinds.has("resource") would be VACUOUS for the remote resource-projection route (review fix,
    // 2026-07-11). Pin it DIFFERENTIALLY instead — and note the status resources are SET-ON-CHANGE with
    // first-publish warm-up, so the window above only WARMS them; the baseline is a SECOND, steady-state
    // fact-less window, and the resource-fact window must fire exactly ONE more "resource" than that.
    rec.reset();
    h.a.transaction((tx) => tx.edit(e2).set(Pos, { x: 9, y: 9 })); // fact-less w.r.t. resources
    h.wA.sync();
    h.deliverToB();
    h.wB.sync();
    expect(rec.kinds).toContain("component"); // the value fact drained (window sanity)
    const statusBaseline = rec.kinds.filter((k) => k === "resource").length;

    rec.reset();
    h.a.transaction((tx) => tx.setResource(Cam, { zoom: 2 }));
    h.wA.sync();
    h.deliverToB();
    h.wB.sync(); // drains exactly ONE remote fact: the resource-set
    const factDrain = rec.kinds.filter((k) => k === "resource").length;
    expect(factDrain).toBe(statusBaseline + 1); // the fact's fire, on top of the status baseline
    expect(h.wB.getResource(Cam)).toEqual({ zoom: 2 }); // and the projection actually landed
  });

  it("remote despawn fact fires structural on sync", () => {
    const h = twoDurablePeers();
    const e1 = h.a.transaction((tx) => tx.spawn({ components: [[Pos, { x: 1, y: 2 }]] }));
    h.wA.sync();
    h.deliverToB();
    h.wB.sync(); // B now holds the entity
    const rec = recorder();
    h.wB.devOnWrite(rec.cb);
    h.a.transaction((tx) => tx.destroy(e1));
    h.wA.sync();
    h.deliverToB();
    rec.reset();
    h.wB.sync();
    expect(rec.kinds).toContain("structural"); // projector.remove → runtime.destroy
  });

  it("undo() echo fires on the FOLLOWING sync", () => {
    const { store, world } = makeDurablePeer(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 0, y: 0 }]] }));
    world.sync();
    store.transaction((tx) => tx.addComponent(h, Vel, { x: 1, y: 1 }));
    world.sync();
    expect(world.has(h, Vel)).toBe(true);
    const rec = recorder();
    world.devOnWrite(rec.cb);
    expect(store.undo()).toBe(true); // inverse committed to the document + enqueued; no runtime write yet
    rec.reset();
    world.sync(); // the echo drains → removeComponent(Vel) → migrate
    expect(rec.kinds).toContain("structural");
    expect(world.has(h, Vel)).toBe(false);
  });

  it("attachDurable SEEDS an existing document through the fire sites", () => {
    const store = makeDurableStore(1);
    const wSeed = createWorld();
    const attSeed = attachDurable(wSeed, store);
    store.transaction((tx) => tx.spawn({ components: [[Pos, { x: 1, y: 2 }]] }));
    wSeed.sync(); // the document now holds one entity
    attSeed.detach();

    const wReattach = createWorld();
    const rec = recorder();
    wReattach.devOnWrite(rec.cb);
    attachDurable(wReattach, store); // re-attach a fresh world → seed projects the existing entity
    expect(rec.kinds).toContain("structural"); // the projected placement during seeding
  });
});

// ===================================================================================================
// 4. ROUTE TABLE — ephemeral (local immediate mutators + inbound presence projection on sync)
// ===================================================================================================

interface EphPeer {
  world: World;
  eph: ReturnType<typeof createEphemeralStore>;
  source: EphemeralSource;
  loro: LoroEphemeralStore;
  outbound: Uint8Array[];
  detach: () => void;
}

const ephPeers: EphPeer[] = [];

/** A fresh attached ephemeral peer (surface.test.ts pattern). TTL far past the test → no mid-test expiry. */
function makeEphPeer(peerId: string): EphPeer {
  const world = createWorld();
  const loro = new LoroEphemeralStore(30_000);
  const source: EphemeralSource = new LoroEphemeralSnapshot(loro);
  const outbound: Uint8Array[] = [];
  const eph = createEphemeralStore(source, { peerId, send: (b) => outbound.push(b), throttleMs: 16 });
  const attachment = attachEphemeral(world, eph);
  const peer: EphPeer = { world, eph, source, loro, outbound, detach: () => attachment.detach() };
  ephPeers.push(peer);
  return peer;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  for (const p of ephPeers.splice(0)) {
    try {
      p.detach();
    } catch {
      /* already detached in-test */
    }
    p.loro.destroy(); // clear the Loro store's wasm cleanup timer
  }
});

describe("route table — ephemeral local mutators fire immediately", () => {
  it("eph.spawn fires structural (identity + placement + the Local auto-tag)", () => {
    const p = makeEphPeer("alice");
    const rec = recorder();
    p.world.devOnWrite(rec.cb);
    p.eph.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    expect(rec.kinds).toContain("structural");
    expect(rec.kinds).toContain("tag"); // the store auto-applies Local through doAddTag
  });

  it("eph.edit().set fires component", () => {
    const p = makeEphPeer("alice");
    const h = p.eph.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const rec = recorder();
    p.world.devOnWrite(rec.cb);
    p.eph.edit(h).set(Pos, { x: 3, y: 4 });
    expect(rec.kinds).toContain("component");
  });

  it("eph.addComponent fires structural", () => {
    const p = makeEphPeer("alice");
    const h = p.eph.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const rec = recorder();
    p.world.devOnWrite(rec.cb);
    p.eph.addComponent(h, Vel, { x: 5, y: 6 });
    expect(rec.kinds).toContain("structural");
  });

  it("eph.addTag fires tag", () => {
    const p = makeEphPeer("alice");
    const h = p.eph.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    const rec = recorder();
    p.world.devOnWrite(rec.cb);
    p.eph.addTag(h, Sel);
    expect(rec.kinds).toContain("tag");
  });

  it("inbound presence bytes fire on world.sync()", async () => {
    const alice = makeEphPeer("alice");
    const bob = makeEphPeer("bob");
    const rec = recorder();
    bob.world.devOnWrite(rec.cb);

    alice.eph.spawn({ components: [[Pos, { x: 1, y: 2 }]] });
    await sleep(40); // alice's change-throttle (16ms) ships bytes into alice.outbound
    for (const b of alice.outbound.splice(0)) bob.source.apply(b); // the transport hop
    rec.reset();
    bob.world.sync(); // drain → project alice's presence entity onto bob

    expect(rec.kinds).toContain("structural"); // the projected placement of the remote entity
    const remote = defineQuery([Pos, Not(Local)]);
    expect(bob.world.firstOf(remote)).toBeDefined(); // sanity: the projection really landed
  });
});

// ===================================================================================================
// 5. VETO ATOMICITY — a throwing hook leaves the world exactly as it was
// ===================================================================================================

describe("veto atomicity — a throwing hook is a clean single-op veto", () => {
  it("spawn: propagates, entity count unchanged, NO onSpawn observed", () => {
    const world = createWorld();
    let onSpawn = 0;
    world.observe({ onSpawn: () => void onSpawn++ });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    const before = world.count(qPos);
    expect(() => world.spawn({ components: [[Pos, { x: 0, y: 0 }]] })).toThrow("veto");
    expect(world.count(qPos)).toBe(before); // nothing allocated
    expect(onSpawn).toBe(0); // the fire precedes emitSpawn, so no observer saw a birth
  });

  it("destroy: propagates, the entity is still alive", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    expect(() => world.destroy(e)).toThrow("veto");
    expect(world.isAlive(e)).toBe(true);
  });

  it("edit().set: propagates, the old value is intact", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    expect(() => world.edit(e).set(Pos, { x: 9, y: 9 })).toThrow("veto");
    expect(world.read(e, Pos)).toEqual({ x: 1, y: 1 });
  });

  it("addTag / setRelation / setResource: propagate, state unchanged", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    const target = world.spawn({ components: [[Pos, { x: 1, y: 1 }]] });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    expect(() => world.addTag(e, Sel)).toThrow("veto");
    expect(world.hasTag(e, Sel)).toBe(false);
    expect(() => world.setRelation(e, Parent, target)).toThrow("veto");
    expect(world.getRelation(e, Parent)).toBeUndefined();
    expect(() => world.setResource(Cam, { zoom: 5 })).toThrow("veto");
    expect(world.getResource(Cam)).toBeUndefined();
  });

  it("reset: propagates, the data is intact", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 2, y: 3 }]] });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    expect(() => world.reset()).toThrow("veto");
    expect(world.isAlive(e)).toBe(true);
    expect(world.read(e, Pos)).toEqual({ x: 2, y: 3 });
  });

  it("import({replace:true}): propagates BEFORE the internal reset — the world is completely untouched", () => {
    const world = createWorld();
    const e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    // THE critical case: the fire is upstream of reset(), so a veto must not leave the world EMPTY.
    expect(() => world.import(POPULATED_BYTES, { replace: true })).toThrow("veto");
    expect(world.isAlive(e)).toBe(true); // the pre-existing entity survives
    expect(world.read(e, Pos)).toEqual({ x: 0, y: 0 }); // its value is untouched
    expect(world.count(qPos)).toBe(1); // the import's x:7,y:8 entity never loaded
  });

  it("import (plain): propagates, the empty world stays empty", () => {
    const world = createWorld();
    world.devOnWrite(() => {
      throw new Error("veto");
    });
    expect(() => world.import(POPULATED_BYTES)).toThrow("veto");
    expect(world.count(qPos)).toBe(0);
  });
});

// ===================================================================================================
// 6. THROW-PROPAGATION CONTRAST — observer callbacks swallow; devOnWrite propagates
// ===================================================================================================

describe("throw-propagation contrast (same mutation)", () => {
  it("a throwing WorldObserver.onSpawn is SWALLOWED — the world keeps working", () => {
    const world = createWorld();
    world.observe({
      onSpawn: () => {
        throw new Error("observer boom");
      },
    });
    let e: Entity | undefined;
    expect(() => {
      e = world.spawn({ components: [[Pos, { x: 0, y: 0 }]] });
    }).not.toThrow();
    expect(world.isAlive(e!)).toBe(true); // the spawn completed despite the throwing observer
  });

  it("a throwing devOnWrite PROPAGATES — the same spawn throws", () => {
    const world = createWorld();
    world.devOnWrite(() => {
      throw new Error("hook boom");
    });
    expect(() => world.spawn({ components: [[Pos, { x: 0, y: 0 }]] })).toThrow("hook boom");
    expect(world.count(qPos)).toBe(0); // and nothing was allocated
  });
});

// ===================================================================================================
// 7. REGISTRY MECHANICS — COW roster: dispose, multi-hook, mid-fire dispose, re-register
// ===================================================================================================

describe("registry mechanics (copy-on-write roster)", () => {
  it("dispose stops future fires", () => {
    const world = createWorld();
    const rec = recorder();
    const dispose = world.devOnWrite(rec.cb);
    world.setResource(Cam, { zoom: 1 });
    expect(rec.kinds.length).toBeGreaterThan(0);
    dispose();
    rec.reset();
    world.setResource(Cam, { zoom: 2 });
    expect(rec.kinds).toEqual([]); // disposed → silent
  });

  it("two hooks both fire", () => {
    const world = createWorld();
    const a = recorder();
    const b = recorder();
    world.devOnWrite(a.cb);
    world.devOnWrite(b.cb);
    world.setResource(Cam, { zoom: 1 });
    expect(a.kinds).toContain("resource");
    expect(b.kinds).toContain("resource");
  });

  it("disposing hook B from INSIDE hook A mid-fire does not skip B on that fire", () => {
    const world = createWorld();
    const firedA: WriteKind[] = [];
    const firedB: WriteKind[] = [];
    let disposeB = () => {};
    world.devOnWrite((k) => {
      firedA.push(k);
      disposeB(); // republishes the roster, but the in-flight fire iterates a captured snapshot
    });
    disposeB = world.devOnWrite((k) => firedB.push(k));

    world.setResource(Cam, { zoom: 1 }); // one "resource" fire
    expect(firedA).toEqual(["resource"]);
    expect(firedB).toEqual(["resource"]); // B ran this fire despite being disposed by A mid-fire

    firedA.length = 0;
    firedB.length = 0;
    world.setResource(Cam, { zoom: 2 }); // next fire: B is gone
    expect(firedA).toEqual(["resource"]);
    expect(firedB).toEqual([]);
  });

  it("re-register after dispose-to-empty works (roster returns to null then re-arms)", () => {
    const world = createWorld();
    const rec = recorder();
    const dispose = world.devOnWrite(rec.cb);
    dispose(); // roster → null (empty)
    rec.reset();
    world.devOnWrite(rec.cb); // re-arm from null
    world.setResource(Cam, { zoom: 1 });
    expect(rec.kinds).toContain("resource");
  });
});

// ===================================================================================================
// 8. DRIFT-PROOFING — exhaustiveness + a reflective classification of every World method
// ===================================================================================================

/**
 * Every {@link WorldMutatorName} mapped to WHERE this file exercises it. This object is typed
 * `Record<WorldMutatorName, string>`, so adding a name to the union makes it fail to compile until the
 * author documents coverage (and, for a new ECS mutator, adds a fire site + a route-table row).
 */
const MUTATOR_MANIFEST: Record<WorldMutatorName, string> = {
  spawn: "world route table + veto + ctx.spawn + durable tx.spawn + ephemeral eph.spawn",
  destroy: "world route table + veto + ctx.destroy + durable remote despawn",
  addComponent: "world route table + ctx.addComponent + durable tx.addComponent + ephemeral eph.addComponent",
  removeComponent: "world route table + durable undo echo",
  addTag: "world route table + ctx.addTag + ephemeral eph.addTag + durable remote drain",
  removeTag: "world route table",
  setRelation: "world route table + ctx.setRelation + durable remote drain",
  moveRelation: "world route table (ordered sibling reorder, plan-ordered-relations §3.3)",
  addRelation: "world route table",
  removeRelation: "world route table",
  setResource: "world route table + veto + durable tx.setResource + remote drain",
  updateResource: "world route table",
  removeResource: "world route table + durable tx.removeResource",
  edit: "world edit().set route + veto + durable tx.edit + ephemeral eph.edit",
  import: "world import routes + veto (plain + replace)",
  reset: "world route table + veto",
  sync: "durable + ephemeral drains fire on sync()",
  tick: "ctx flush rows + the read-only-tick-fires-nothing guard",
};

/** The ECS mutators — derived from the exhaustive manifest, so it can never drift from the union. */
const ECS_MUTATORS = new Set<string>(Object.keys(MUTATOR_MANIFEST));

/** Non-mutating public methods/getters — reads, observers, and the read-only introspection seams. */
const READERS = new Set<string>([
  "tickCount",
  "reactive",
  // Patch Note 004: like `reactive`, a lazy layer getter — collecting journals
  // OBSERVES writes (the fire sites live with the mutators), never mutates ECS.
  "changes",
  "isReactiveEnabled",
  "observe",
  "devOnWrite",
  "isAlive",
  "isPlaced",
  "isIdentityOnly",
  "read",
  "get",
  "readField",
  "has",
  "hasTag",
  // petition 6 — exhaustive entity introspection; pure reads, no stamps touched (delegate to
  // the store's generation-guarded componentsOf/tagsOf).
  "componentsOf",
  "tagsOf",
  "getRelation",
  "getRelations",
  "getReverse",
  // plan-ordered-relations §3.3: a pull-only version read (its bump sites live with the
  // relation mutators); the first call arms collection but never writes ECS state.
  "orderStamp",
  "resourceStamp",
  "firstOf",
  "query",
  "count",
  "entities",
  "getResource",
  "export",
  "runtime", // @internal getter — returns the store reference; the call is a read
  "inImmediateProjectionUnsafeContext", // @internal getter — read-only introspection
]);

/**
 * Public but NOT in {@link WorldMutatorName}: they mutate the world's BINDING-lifecycle state (the inbound
 * source list), not ECS data, so a `ReadonlyWorld` deliberately keeps them (petition 4). Classified so the
 * reflective walk still passes, and so a future ECS mutator added WITHOUT a fire site cannot hide here.
 */
const BINDING_SEAMS = new Set<string>(["registerInboundSource", "unregisterInboundSource"]);

/** TypeScript `private` erases at runtime, so these still sit on `World.prototype` — skip them explicitly.
 * `walkAttributed`/`dispatchSystem` (petition 5) are walk/dispatch plumbing: the former's write-stamp is a
 * reactive frame bump, not an ECS mutation, so neither owes a WriteKind fire site. */
const PRIVATE_ERASED = new Set<string>([
  "assertNotIterating",
  "eachGuarded",
  "walkAttributed",
  "dispatchSystem",
  "stampAndClearWrites",
]);

describe("drift-proofing", () => {
  it("(a) WorldMutatorName is exhaustively covered by this file (compile error when the union grows)", () => {
    // The `Record<WorldMutatorName, string>` type above is the hard gate: this test just proves it is
    // materialized. A `ReadonlyWorld` strips exactly these keys.
    expect(ECS_MUTATORS.size).toBe(18);
    for (const name of ECS_MUTATORS) expect(typeof MUTATOR_MANIFEST[name as WorldMutatorName]).toBe("string");
  });

  it("(b) every public World.prototype method is classified as reader / ECS-mutator / binding-seam", () => {
    const unclassified: string[] = [];
    for (const name of Object.getOwnPropertyNames(World.prototype)) {
      if (name === "constructor" || PRIVATE_ERASED.has(name)) continue;
      if (READERS.has(name) || ECS_MUTATORS.has(name) || BINDING_SEAMS.has(name)) continue;
      unclassified.push(name);
    }
    expect(
      unclassified,
      `Unclassified World method(s): ${unclassified.join(", ")}. Classify each in src/devwrite-matrix.test.ts. ` +
        `If it MUTATES ECS state, add it to WorldMutatorName, add a WriteKind fire site in runtime-store.ts/world.ts, ` +
        `and add a route-table row here; if it is a pure reader, add it to READERS; if it is a binding seam, to BINDING_SEAMS.`,
    ).toEqual([]);

    // The reverse guard: every name in a manifest must still exist on the prototype (catches a rename/removal).
    for (const name of [...READERS, ...ECS_MUTATORS, ...BINDING_SEAMS, ...PRIVATE_ERASED]) {
      expect(Object.getOwnPropertyNames(World.prototype), `manifest names a missing method "${name}"`).toContain(name);
    }
  });

  it("ReadonlyWorld strips mutators but keeps readers (compile-time)", () => {
    // Readers must survive the Omit — indexing a stripped key would fail to compile.
    const survivors: Array<keyof ReadonlyWorld> = ["read", "get", "query", "count", "firstOf", "observe", "devOnWrite", "getResource"];
    expect(survivors.length).toBeGreaterThan(0);
    // Mutators must be gone — each @ts-expect-error fails to compile if the key were still present.
    // @ts-expect-error spawn is a mutator, stripped from ReadonlyWorld
    type _NoSpawn = ReadonlyWorld["spawn"];
    // @ts-expect-error setResource is a mutator, stripped
    type _NoSetResource = ReadonlyWorld["setResource"];
    // @ts-expect-error tick is a mutator, stripped
    type _NoTick = ReadonlyWorld["tick"];
    // @ts-expect-error import is a mutator, stripped
    type _NoImport = ReadonlyWorld["import"];
  });
});

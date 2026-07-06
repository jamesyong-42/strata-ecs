/**
 * `createEphemeralStore` + the writer-partitioned Mutator — Part IV M1 tests (docs/plan-part4.md).
 *
 * The M2-less pattern: install the runtime seam DIRECTLY against a real World / RuntimeStore / Projector
 * (M2's `attachEphemeral` will wire the same seam to the real world). `isIterating` reads the World facade's
 * `inImmediateProjectionUnsafeContext` (real query-walk / tick state); `isInEmit` reads the runtime's
 * `inObserverEmitActive`, with a test-forced override for the emit-rejection case (a real emit swallows the
 * throws we want to assert). These pin the load-bearing behaviours: Option-A immediacy, `Local` auto-tag,
 * partition ownership, the in-system throw, the in-emit reject, the blob codec, and the eid-field ban.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralStore as LoroStore } from "loro-crdt";
import {
  type Entity,
  Local,
  Not,
  createWorld,
  defineComponent,
  defineQuery,
  defineSystem,
  defineTag,
  entityKey,
  phase,
} from "../core";
import { Projector } from "../substrate";
import { LoroEphemeralSnapshot } from "./loro-ephemeral-snapshot";
import { createEphemeralStore, type EphemeralStore } from "./ephemeral-store";
import type { EphemeralSource } from "./types";

// --- schema (module-scope, unique names; vitest isolates modules per file so no reset is needed) ---
const CursorPos = defineComponent("EphCursorPos", { x: "f32", y: "f32" });
const PresenceInfo = defineComponent("EphPresence", { name: "string", color: "u32" });
const EditingRef = defineComponent("EphEditingRef", { target: "key" }); // a `key`-field reference
const BadEid = defineComponent("EphBadEid", { ref: "eid" }); // eid-ban trip wire
const Selecting = defineTag("EphSelecting");
const localCursors = defineQuery([CursorPos, Local]);
const remoteCursors = defineQuery([CursorPos, Not(Local)]);

// --- harness ---------------------------------------------------------------------------------------
interface Harness {
  readonly world: ReturnType<typeof createWorld>;
  readonly loro: LoroStore;
  readonly eph: EphemeralStore;
  readonly projector: Projector;
  readonly sent: Uint8Array[];
  readonly emit: { force: boolean };
}

const loros: LoroStore[] = [];
afterEach(() => {
  for (const s of loros.splice(0)) s.destroy(); // clear each store's wasm cleanup timer
  vi.restoreAllMocks();
});

function makeLoro(ttlMs = 30_000): LoroStore {
  const s = new LoroStore(ttlMs);
  loros.push(s);
  return s;
}

function setup(peerId = "alice"): Harness {
  const world = createWorld();
  const loro = makeLoro();
  const source = new LoroEphemeralSnapshot(loro);
  const sent: Uint8Array[] = [];
  const eph = createEphemeralStore(source, { peerId, send: (b) => sent.push(b) });
  const projector = new Projector(world.runtime, () => eph.mintKey());
  const emit = { force: false };
  eph.installRuntime({
    runtime: world.runtime,
    projector,
    isIterating: () => world.inImmediateProjectionUnsafeContext,
    isInEmit: () => emit.force || world.runtime.inObserverEmitActive,
  });
  return { world, loro, eph, projector, sent, emit };
}

/** The minted key bound to `e` (via the projector bijection) — the source-store key for blob assertions. */
function keyOf(h: Harness, e: Entity): string {
  const k = h.projector.keyFor(e);
  if (k === undefined) throw new Error("entity not bound");
  return k;
}

// --- pre-attach ------------------------------------------------------------------------------------
describe("pre-attach", () => {
  it("every mutator throws before the runtime seam is installed", () => {
    const eph = createEphemeralStore(new LoroEphemeralSnapshot(makeLoro()), { peerId: "alice", send: () => {} });
    const fake = 1 as unknown as Entity; // requireSeam throws before the handle is touched
    expect(() => eph.spawn()).toThrow(/attach/i);
    expect(() => eph.despawn(fake)).toThrow(/attach/i);
    expect(() => eph.addComponent(fake, CursorPos, { x: 0, y: 0 })).toThrow(/attach/i);
    expect(() => eph.removeComponent(fake, CursorPos)).toThrow(/attach/i);
    expect(() => eph.edit(fake)).toThrow(/attach/i);
    expect(() => eph.addTag(fake, Selecting)).toThrow(/attach/i);
    expect(() => eph.removeTag(fake, Selecting)).toThrow(/attach/i);
  });
});

// --- Option-A immediacy + Local --------------------------------------------------------------------
describe("local mutation is immediate (Option A) and Local auto-tags", () => {
  it("spawn-then-edit in one handler works; the entity is queryable now with Local", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 2 }]] });
    h.eph.edit(cursor).set(CursorPos, { x: 3, y: 4 }); // same input handler, no tick/sync between the calls
    expect(h.world.get(cursor, CursorPos)).toEqual({ x: 3, y: 4 });
    expect(h.world.hasTag(cursor, Local)).toBe(true);
    expect(h.world.firstOf(localCursors)).toBe(cursor); // queryable immediately
    expect(h.world.firstOf(remoteCursors)).toBeUndefined(); // Not(Local) excludes my own
  });

  it("addComponent then removeComponent migrates the runtime archetype immediately", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 0, y: 0 }]] });
    h.eph.addComponent(cursor, PresenceInfo, { name: "Alice", color: 0xff0000 });
    expect(h.world.get(cursor, PresenceInfo)).toEqual({ name: "Alice", color: 0xff0000 });
    h.eph.removeComponent(cursor, PresenceInfo);
    expect(h.world.has(cursor, PresenceInfo)).toBe(false);
  });
});

// --- partition ownership ---------------------------------------------------------------------------
describe("partition ownership is absolute", () => {
  it("mutating a projected foreign-key entity throws, including value writes", () => {
    const h = setup("alice");
    const foreign = h.projector.resolveByKey(entityKey("bob-1")); // fake a projected remote entity
    expect(() => h.eph.addComponent(foreign, CursorPos, { x: 0, y: 0 })).toThrow(/partition/i);
    expect(() => h.eph.removeComponent(foreign, CursorPos)).toThrow(/partition/i);
    expect(() => h.eph.despawn(foreign)).toThrow(/partition/i);
    expect(() => h.eph.addTag(foreign, Selecting)).toThrow(/partition/i);
    expect(() => h.eph.edit(foreign).set(CursorPos, { x: 0, y: 0 })).toThrow(/partition/i);
  });

  it("mutating a runtime-only (non-ephemeral) handle throws", () => {
    const h = setup();
    const runtimeOnly = h.world.spawn(); // never entered the ephemeral bijection
    expect(() => h.eph.addComponent(runtimeOnly, CursorPos, { x: 0, y: 0 })).toThrow(/partition/i);
    expect(() => h.eph.edit(runtimeOnly).set(CursorPos, { x: 0, y: 0 })).toThrow(/partition/i);
  });
});

// --- the in-system rules ---------------------------------------------------------------------------
describe("in-system rules (via the seam's isIterating / isInEmit)", () => {
  it("structural eph.* throws inside a query walk (all builds)", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    expect(() => {
      h.world.query(localCursors).each(() => {
        h.eph.addComponent(cursor, PresenceInfo, { name: "a", color: 0 });
      });
    }).toThrow(/query iteration or a tick/i);
    // the throw did not leak the mutation
    expect(h.world.has(cursor, PresenceInfo)).toBe(false);
  });

  it("structural eph.* throws inside a tick system (all builds)", () => {
    const h = setup();
    h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] }); // makes localCursors non-empty so the body runs
    const sys = defineSystem(localCursors, () => {
      h.eph.spawn({ components: [[CursorPos, { x: 2, y: 2 }]] }); // structural eph.* mid-tick → throws
    });
    expect(() => h.world.tick([phase("main", [sys])])).toThrow(/query iteration or a tick/i);
  });

  it("value edit().set on an own entity succeeds inside a tick system", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    const sys = defineSystem(localCursors, () => {
      h.eph.edit(cursor).set(CursorPos, { x: 9, y: 9 }); // value write — legal in-system (§15.2)
    });
    h.world.tick([phase("main", [sys])]);
    expect(h.world.get(cursor, CursorPos)).toEqual({ x: 9, y: 9 });
  });

  it("all mutation is DEV-rejected inside an observer emit", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    h.emit.force = true; // simulate inObserverEmitActive

    h.eph.addComponent(cursor, PresenceInfo, { name: "x", color: 1 });
    h.eph.addTag(cursor, Selecting);
    h.eph.edit(cursor).set(CursorPos, { x: 5, y: 5 });
    h.eph.despawn(cursor);

    expect(h.world.has(cursor, PresenceInfo)).toBe(false); // structural no-op
    expect(h.world.hasTag(cursor, Selecting)).toBe(false); // structural no-op
    expect(h.world.get(cursor, CursorPos)).toEqual({ x: 1, y: 1 }); // value write no-op
    expect(h.world.isAlive(cursor)).toBe(true); // despawn no-op
    expect(errs).toHaveBeenCalled(); // each rejection devError'd
    // spawn cannot no-op-and-return, so it THROWS in an emit
    expect(() => h.eph.spawn()).toThrow(/observer or reactive callback/i);
    h.emit.force = false;
  });
});

// --- the own-blob codec ----------------------------------------------------------------------------
describe("the own-blob codec", () => {
  it("encodes canonical values (f32), tags, and key-field passthrough; excludes Local", () => {
    const h = setup();
    const cursor = h.eph.spawn({
      components: [
        [CursorPos, { x: 0.1, y: 0.2 }],
        [EditingRef, { target: entityKey("shape-7") }],
      ],
      tags: [Selecting],
    });
    const blob = h.loro.get(keyOf(h, cursor)) as {
      components: Record<string, Record<string, unknown>>;
      tags: string[];
    };
    expect(blob.components.EphCursorPos.x).toBe(Math.fround(0.1)); // canonical f32, not the raw 0.1
    expect(blob.components.EphCursorPos.y).toBe(Math.fround(0.2));
    expect(blob.components.EphEditingRef.target).toBe("shape-7"); // key field passes through as a string
    expect(blob.tags).toContain("EphSelecting");
    expect(blob.tags).not.toContain("Local"); // NEVER transmitted (each peer computes Local locally)
    expect(h.world.hasTag(cursor, Local)).toBe(true); // ...but the runtime carries it
  });

  it("removeComponent drops the component from the blob", () => {
    const h = setup();
    const cursor = h.eph.spawn({
      components: [
        [CursorPos, { x: 1, y: 1 }],
        [PresenceInfo, { name: "a", color: 0 }],
      ],
    });
    const key = keyOf(h, cursor);
    expect((h.loro.get(key) as { components: Record<string, unknown> }).components.EphPresence).toBeDefined();
    h.eph.removeComponent(cursor, PresenceInfo);
    const blob = h.loro.get(key) as { components: Record<string, unknown> };
    expect(blob.components.EphPresence).toBeUndefined();
    expect(blob.components.EphCursorPos).toBeDefined(); // the sibling component survives
  });

  it("despawn deletes the source key", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    const key = keyOf(h, cursor); // capture BEFORE despawn unbinds the pair
    expect(h.loro.get(key)).toBeDefined();
    h.eph.despawn(cursor);
    expect(h.loro.get(key)).toBeUndefined();
    expect(h.world.isAlive(cursor)).toBe(false);
  });

  it("a bare spawn (no components/tags) still stages an exists blob", () => {
    const h = setup();
    const e = h.eph.spawn();
    const blob = h.loro.get(keyOf(h, e)) as { components: Record<string, unknown>; tags: string[] };
    expect(blob).toEqual({ components: {}, tags: [] });
  });
});

// --- the eid-field ban -----------------------------------------------------------------------------
describe("the eid-field ban (005 §7)", () => {
  it("DEV-throws on the first replicated use of a component carrying an eid field", () => {
    const h = setup();
    const eidHandle = 0 as unknown as Entity; // the value is irrelevant — the ban throws before it is used
    expect(() => h.eph.spawn({ components: [[BadEid, { ref: eidHandle }]] })).toThrow(/eid/i);
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    expect(() => h.eph.addComponent(cursor, BadEid, { ref: eidHandle })).toThrow(/eid/i);
  });
});

// --- Local: the core export ------------------------------------------------------------------------
describe("Local (the core-barrel export)", () => {
  it("is importable from the core barrel and applied by the store, but excluded from the blob", () => {
    expect(Local.name).toBe("Local");
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    expect(h.world.hasTag(cursor, Local)).toBe(true);
    expect((h.loro.get(keyOf(h, cursor)) as { tags: string[] }).tags).not.toContain("Local");
  });

  it("rejects addTag/removeTag of Local (store-owned, query-only)", () => {
    const h = setup();
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    expect(() => h.eph.addTag(cursor, Local)).toThrow(/Local/);
    expect(() => h.eph.removeTag(cursor, Local)).toThrow(/Local/);
  });
});

// --- config validation -----------------------------------------------------------------------------
describe("config validation", () => {
  it("clamps throttleMs and ttlMs below their floors, with a DEV warning", () => {
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const eph = createEphemeralStore(new LoroEphemeralSnapshot(makeLoro()), {
      peerId: "alice",
      send: () => {},
      throttleMs: 1,
      ttlMs: 10,
    });
    expect(eph.throttleMs).toBe(8);
    expect(eph.ttlMs).toBe(100);
    expect(warns).toHaveBeenCalled();
  });

  it("keeps in-range config and defaults the omitted values", () => {
    const eph = createEphemeralStore(new LoroEphemeralSnapshot(makeLoro()), { peerId: "alice", send: () => {} });
    expect(eph.throttleMs).toBe(16);
    expect(eph.ttlMs).toBe(5000);
  });

  it("rejects an empty peerId (session-uniqueness is the app's obligation, 006 B5)", () => {
    expect(() =>
      createEphemeralStore(new LoroEphemeralSnapshot(makeLoro()), { peerId: "", send: () => {} }),
    ).toThrow(/peerId/i);
  });
});

// --- debug / observability (the tools observer's ephemeral tab) -------------------------------------
describe("debugDump (the observer tab's read-all)", () => {
  it("returns peerId/ttlMs/throttleMs and every partition's entry, sorted by key", () => {
    const h = setup("alice");
    const cursor = h.eph.spawn({ components: [[CursorPos, { x: 1, y: 2 }]] }); // this peer's OWN entity
    const ownKey = keyOf(h, cursor);

    // A remote peer's blob arriving over the wire, applied through the store's source.
    const remote = new LoroEphemeralSnapshot(makeLoro());
    remote.set(entityKey("zoe-0"), { name: "Zoe" });
    h.eph.ephemeralSource.apply(remote.encodeChanged()!);

    const dump = h.eph.debugDump();
    expect(dump.peerId).toBe("alice");
    expect(dump.ttlMs).toBe(5000); // the store's config scalar (default), not the loro store's TTL
    expect(dump.throttleMs).toBe(16);
    expect(dump.entries.map((e) => e.key)).toEqual([ownKey, "zoe-0"].sort()); // sorted by key
    expect(dump.entries.find((e) => e.key === ownKey)!.blob).toEqual({
      components: { EphCursorPos: { x: 1, y: 2 } },
      tags: [],
    });
    expect(dump.entries.find((e) => e.key === "zoe-0")!.blob).toEqual({ name: "Zoe" });
  });

  it("degrades gracefully: a source WITHOUT debugEntries yields an empty list and never throws", () => {
    // A minimal EphemeralSource test double — every required method, but NO optional debugEntries.
    const source: EphemeralSource = {
      set: () => {},
      delete: () => {},
      encodeChanged: () => null,
      encodeKeys: () => null,
      encodeDeletes: () => [],
      apply: () => {},
      subscribe: () => () => {},
    };
    const eph = createEphemeralStore(source, { peerId: "solo", send: () => {} });
    const dump = eph.debugDump();
    expect(dump).toEqual({ peerId: "solo", ttlMs: 5000, throttleMs: 16, entries: [] });
  });
});

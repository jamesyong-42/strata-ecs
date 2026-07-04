/**
 * `attachEphemeral` — Part IV **M2** tests (docs/plan-part4.md).
 *
 * Two-store scenarios over REAL `LoroEphemeralSnapshot` adapters: peer A broadcasts to `A.outbound`
 * (the binding's throttle/keepalive timers fill it), the harness forwards those bytes to peer B's source,
 * and `B.world.sync()` drains the projection. Timing follows the M0 rule — Loro's per-key LWW and TTL live
 * in the wasm wall clock, NOT in JS we can fake — so cross-peer sequencing uses REAL short waits (a distinct
 * wall-clock ms between two sends of one key, a real TTL for expiry), exactly as the adapter's own tests do.
 * Fake timers appear only where no Loro clock is involved (the guard asserts).
 *
 * Coverage (the task brief's list): the presence flow end-to-end (remote cursor projects as `Not(Local)`,
 * observeQuery lights up); the blob-diff (component removal propagates; a same-value keepalive re-set fires
 * NOTHING; a changed value fires); peer-left atomicity (a TTL burst despawns a peer's entities together);
 * `leave()` (tombstone-driven immediate removal); keepalive hygiene (own keys stay alive; a forged ghost is
 * refused + never re-sent); the own-prefix timeout recovery; `EphemeralSyncStatus`; detach teardown; the
 * attach/drain guards.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EphemeralStore as LoroStore } from "loro-crdt";
import {
  type InboundSource,
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
import { LoroEphemeralSnapshot } from "./loro-ephemeral-snapshot";
import { createEphemeralStore, type EphemeralStore } from "./ephemeral-store";
import { attachEphemeral, type Attachment } from "./attach";
import { EphemeralSyncStatus } from "./sync-status";

// --- schema (module-scope, file-unique names) ------------------------------------------------------
const CursorPos = defineComponent("AttCursorPos", { x: "f32", y: "f32" });
const PresenceInfo = defineComponent("AttPresence", { name: "string", color: "u32" });
const EditingRef = defineComponent("AttEditingRef", { target: "key" });
const BadEid = defineComponent("AttBadEid", { ref: "eid" });
const Selecting = defineTag("AttSelecting");
const remoteCursors = defineQuery([CursorPos, Not(Local)]);
const localCursors = defineQuery([CursorPos, Local]);

type AnyQuery = ReturnType<typeof defineQuery>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const K = (s: string) => entityKey(s);

// --- harness ---------------------------------------------------------------------------------------
interface Peer {
  readonly world: ReturnType<typeof createWorld>;
  readonly loro: LoroStore;
  readonly source: LoroEphemeralSnapshot;
  readonly eph: EphemeralStore;
  attachment: Attachment;
  readonly outbound: Uint8Array[];
}

const peers: Peer[] = [];
const loros: LoroStore[] = [];
const extraAttachments: Attachment[] = [];

/** A fresh attached peer over a real adapter. Short `ttlMs` opts into TTL-expiry behaviour. */
function makePeer(peerId: string, ttlMs = 5000, throttleMs = 16): Peer {
  const world = createWorld();
  const loro = new LoroStore(ttlMs);
  loros.push(loro);
  const source = new LoroEphemeralSnapshot(loro);
  const outbound: Uint8Array[] = [];
  const eph = createEphemeralStore(source, { peerId, send: (b) => outbound.push(b), ttlMs, throttleMs });
  const attachment = attachEphemeral(world, eph);
  const peer: Peer = { world, loro, source, eph, attachment, outbound };
  peers.push(peer);
  return peer;
}

/** Forward every buffer `from` has broadcast into `to`'s source (the transport hop). */
function deliver(from: Peer, to: Peer): void {
  for (const b of from.outbound.splice(0)) to.source.apply(b);
}

/** Entities a query matches — `world.query(q)` exposes only `.each`, so count by iterating (durable's pattern). */
function countMatches(peer: Peer, q: AnyQuery): number {
  let n = 0;
  peer.world.query(q).each((b) => {
    n += [...b].length;
  });
  return n;
}

afterEach(() => {
  for (const p of peers.splice(0)) {
    try {
      p.attachment.detach(); // stop the binding's timers (idempotent)
    } catch {
      /* already detached in-test */
    }
  }
  for (const a of extraAttachments.splice(0)) {
    try {
      a.detach();
    } catch {
      /* already detached */
    }
  }
  vi.useRealTimers();
  for (const s of loros.splice(0)) s.destroy(); // clear each Loro store's wasm cleanup timer
  vi.restoreAllMocks();
});

// --- the presence flow end-to-end ------------------------------------------------------------------
describe("presence flow end-to-end (§15.3/§15.4)", () => {
  it("A's cursor projects onto B as a Not(Local) entity and lights up observeQuery", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");

    // Arm an observeQuery on B BEFORE the remote arrives — it must fire once at the next notify (005 §5.3).
    let fired = 0;
    B.world.reactive.observeQuery(remoteCursors, [CursorPos], () => {
      fired++;
    });
    B.world.reactive.notify(); // baseline the watch
    fired = 0;

    const cursor = A.eph.spawn({
      components: [
        [CursorPos, { x: 1, y: 2 }],
        [PresenceInfo, { name: "Alice", color: 0xff0000 }],
      ],
    });
    A.eph.edit(cursor).set(CursorPos, { x: 3, y: 4 }); // same handler, no tick between (Option A)

    await sleep(25); // A's change-throttle fires → bytes in A.outbound
    deliver(A, B);
    B.world.sync(); // drain → project

    const rc = B.world.firstOf(remoteCursors);
    expect(rc).toBeDefined();
    expect(B.world.get(rc!, CursorPos)).toEqual({ x: 3, y: 4 }); // the coalesced latest value
    expect(B.world.get(rc!, PresenceInfo)).toEqual({ name: "Alice", color: 0xff0000 });
    expect(B.world.hasTag(rc!, Local)).toBe(false); // NO Local on a remote projection (§15.4)

    B.world.reactive.notify();
    expect(fired).toBe(1); // the remote cursor lit observeQuery at the frame's single notify
  });

  it("a key-field reference in a blob round-trips as a plain string on B", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    A.eph.spawn({ components: [[EditingRef, { target: K("shape-7") }]] });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    const rc = B.world.firstOf(defineQuery([EditingRef, Not(Local)]))!;
    expect(B.world.get(rc, EditingRef)).toEqual({ target: "shape-7" });
  });
});

// --- the blob-diff (§15.6) -------------------------------------------------------------------------
describe("blob-diff projection (§15.6)", () => {
  it("removing a component on A drops it from B's projection", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    const cursor = A.eph.spawn({
      components: [
        [CursorPos, { x: 1, y: 1 }],
        [PresenceInfo, { name: "A", color: 1 }],
      ],
    });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    const rc = B.world.firstOf(remoteCursors)!;
    expect(B.world.has(rc, PresenceInfo)).toBe(true);

    A.eph.removeComponent(cursor, PresenceInfo); // the facet vanishes from the blob (§15.6)
    await sleep(25); // distinct wall-clock ms so the new blob out-timestamps the last
    deliver(A, B);
    B.world.sync();
    expect(B.world.has(rc, PresenceInfo)).toBe(false); // removed on B
    expect(B.world.has(rc, CursorPos)).toBe(true); // the sibling survives
  });

  it("a same-value keepalive re-set projects NOTHING (cellEquals no-op → no reactive fire)", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    const cursor = A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    const rc = B.world.firstOf(remoteCursors)!;

    let valFires = 0;
    B.world.reactive.observeValue(rc, CursorPos, () => {
      valFires++;
    });
    B.world.reactive.notify(); // baseline
    valFires = 0;

    // A keepalive re-set of the UNCHANGED blob (a fresh timestamp, same value — M0 finding 4).
    await sleep(5); // distinct ms so the re-set is a real `updated` event on B, not an LWW-tie drop
    const keepalive = A.source.encodeKeys([...A.eph.mintedKeys]);
    expect(keepalive).not.toBeNull();
    B.source.apply(keepalive!);
    B.world.sync();
    B.world.reactive.notify();
    expect(valFires).toBe(0); // unchanged value → no runtime write → no reactive fire (decision E)
    expect(B.world.get(rc, CursorPos)).toEqual({ x: 1, y: 1 });

    // A genuine value change DOES project + fire.
    A.eph.edit(cursor).set(CursorPos, { x: 9, y: 9 });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    B.world.reactive.notify();
    expect(valFires).toBe(1);
    expect(B.world.get(rc, CursorPos)).toEqual({ x: 9, y: 9 });
  });

  it("adding then dropping a tag facet propagates both directions", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    const cursor = A.eph.spawn({ components: [[CursorPos, { x: 0, y: 0 }]] });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    const rc = B.world.firstOf(remoteCursors)!;

    A.eph.addTag(cursor, Selecting);
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    expect(B.world.hasTag(rc, Selecting)).toBe(true);

    A.eph.removeTag(cursor, Selecting);
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    expect(B.world.hasTag(rc, Selecting)).toBe(false);
  });
});

// --- peer-left atomicity (§15.3) -------------------------------------------------------------------
describe("peer-left atomicity (§15.3)", () => {
  it("a whole peer's entities despawn together in ONE drain when its TTL lapses", async () => {
    const A = makePeer("alice", 250);
    const B = makePeer("bob", 250);
    A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    A.eph.spawn({ components: [[CursorPos, { x: 2, y: 2 }]] });
    A.eph.spawn({ components: [[CursorPos, { x: 3, y: 3 }]] });
    await sleep(30);
    deliver(A, B);
    B.world.sync();
    expect(countMatches(B, remoteCursors)).toBe(3);

    A.attachment.detach(); // A "crashes" — no more keepalive refresh reaches B
    await sleep(500); // > ttl + a cleanup tick: B's three copies expire in the same Loro sweep

    // The three timeout events are all queued; ONE sync drains them atomically (no partial state).
    expect(countMatches(B, remoteCursors)).toBe(3); // still present until we drain
    B.world.sync();
    expect(countMatches(B, remoteCursors)).toBe(0); // all three gone after a SINGLE drain
  });
});

// --- leave() ---------------------------------------------------------------------------------------
describe("leave() — best-effort explicit departure (§15.3)", () => {
  it("tombstones remove the peer's entities on B immediately (before any TTL)", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    A.eph.spawn({ components: [[PresenceInfo, { name: "A", color: 1 }]] });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    expect(countMatches(B, remoteCursors)).toBe(1);

    await sleep(5); // the tombstone must out-timestamp the last set (M0 finding 5)
    A.eph.leave(); // deletes minted keys + flushes tombstones NOW (synchronously into A.outbound)
    deliver(A, B);
    B.world.sync();
    expect(countMatches(B, remoteCursors)).toBe(0); // despawned via tombstone, not TTL
    // leave() also despawned A's own runtime entities and emptied the minted set.
    expect(countMatches(A, localCursors)).toBe(0);
    expect([...A.eph.mintedKeys]).toHaveLength(0);
  });
});

// --- keepalive hygiene (006 B5) --------------------------------------------------------------------
describe("keepalive hygiene (006 B5)", () => {
  it("own-minted keys stay alive on the receiver across several TTL windows", async () => {
    const A = makePeer("alice", 240);
    const B = makePeer("bob", 240);
    A.eph.spawn({ components: [[CursorPos, { x: 5, y: 5 }]] });
    // Forward A's traffic (change + keepalive) for ~3 TTL windows; the binding's keepalive (~ttl/3 = 80ms)
    // refreshes B's copy so it never expires.
    for (let i = 0; i < 10; i++) {
      await sleep(80);
      deliver(A, B);
      B.world.sync();
    }
    expect(countMatches(B, remoteCursors)).toBe(1); // never flickered out
  });

  it("a forged own-prefix ghost is refused (peerId-reuse warn), never projected, never re-sent", () => {
    const A = makePeer("alice");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Forge a buffer under alice's prefix from a store this session did not mint (a reused-peerId ghost).
    const scratch = new LoroStore(30_000);
    loros.push(scratch);
    scratch.set("alice-999", { components: { AttCursorPos: { x: 7, y: 7 } }, tags: [] });
    A.source.apply(scratch.encodeAll());
    A.world.sync();

    // Not projected, and warned exactly once.
    expect(countMatches(A, remoteCursors)).toBe(0);
    expect(A.world.firstOf(defineQuery([CursorPos]))).toBeUndefined();
    A.source.apply(scratch.encodeAll()); // a second arrival must not warn again
    A.world.sync();
    const reuseWarns = warn.mock.calls.filter((c) => String(c[0]).includes("peerId reuse"));
    expect(reuseWarns).toHaveLength(1);

    // The keepalive re-sends ONLY minted keys — the ghost never goes back out.
    const keepalive = A.source.encodeKeys([...A.eph.mintedKeys]);
    expect(keepalive).toBeNull(); // alice minted nothing this session
  });
});

// --- own-prefix timeout recovery (M0 finding 4) ----------------------------------------------------
describe("own-prefix timeout (keepalive suppressed)", () => {
  it("DEV-warns and KEEPS the own entity — never despawns a live local entity", async () => {
    const A = makePeer("alice", 200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Suppress the keepalive's real-store refresh: encodeKeys no longer re-`set`s, so the own key expires.
    vi.spyOn(A.source, "encodeKeys").mockReturnValue(null);

    const cursor = A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    await sleep(400); // > ttl + a cleanup tick → Loro fires a timeout for the owner's own key (finding 4)
    A.world.sync(); // drain the own-prefix timeout

    expect(A.world.isAlive(cursor)).toBe(true); // NOT despawned — the entity is still live locally
    expect(A.world.hasTag(cursor, Local)).toBe(true);
    const ownWarns = warn.mock.calls.filter((c) => String(c[0]).includes("keepalive lapsed"));
    expect(ownWarns.length).toBeGreaterThanOrEqual(1);
  });
});

// --- EphemeralSyncStatus (006 C7) ------------------------------------------------------------------
describe("EphemeralSyncStatus (006 C7)", () => {
  it("is published at attach and starts at zero", () => {
    const A = makePeer("alice");
    expect(A.world.getResource(EphemeralSyncStatus)).toEqual({ peerCount: 0, lastInboundFrame: 0 });
  });

  it("idle drains fire observeResource zero times (set-on-change)", () => {
    const B = makePeer("bob");
    let fires = 0;
    B.world.reactive.observeResource(EphemeralSyncStatus, () => {
      fires++;
    });
    B.world.reactive.notify(); // baseline
    fires = 0;
    for (let i = 0; i < 5; i++) {
      B.world.sync(); // empty drains — nothing projected
      B.world.reactive.notify();
    }
    expect(fires).toBe(0); // no field moved → no setResource → no re-render
  });

  it("a projecting drain bumps lastInboundFrame; peerCount tracks distinct live remote prefixes", async () => {
    const A = makePeer("alice");
    const A2 = makePeer("carol");
    const B = makePeer("bob");

    A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] });
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    let status = B.world.getResource(EphemeralSyncStatus)!;
    expect(status.peerCount).toBe(1);
    expect(status.lastInboundFrame).toBe(1);

    // A second peer → peerCount 2, lastInboundFrame advances again.
    A2.eph.spawn({ components: [[CursorPos, { x: 2, y: 2 }]] });
    await sleep(25);
    deliver(A2, B);
    B.world.sync();
    status = B.world.getResource(EphemeralSyncStatus)!;
    expect(status.peerCount).toBe(2);
    expect(status.lastInboundFrame).toBe(2);

    // An idle drain moves neither.
    B.world.sync();
    status = B.world.getResource(EphemeralSyncStatus)!;
    expect(status.peerCount).toBe(2);
    expect(status.lastInboundFrame).toBe(2);
  });

  it("detach removes the resource (useResource → undefined)", () => {
    const A = makePeer("alice");
    expect(A.world.getResource(EphemeralSyncStatus)).toBeDefined();
    A.attachment.detach();
    expect(A.world.getResource(EphemeralSyncStatus)).toBeUndefined();
  });
});

// --- detach teardown -------------------------------------------------------------------------------
describe("detach — full teardown (§5.6)", () => {
  it("despawns all projections (remote AND own), stops timers, and re-attach is fresh", async () => {
    const A = makePeer("alice");
    const B = makePeer("bob");
    A.eph.spawn({ components: [[CursorPos, { x: 1, y: 1 }]] }); // an own entity on A
    await sleep(25);
    deliver(A, B);
    B.world.sync();
    expect(countMatches(B, remoteCursors)).toBe(1); // B holds a remote projection

    B.attachment.detach();
    expect(countMatches(B, remoteCursors)).toBe(0); // remote projection despawned — no residue
    B.outbound.length = 0;
    await sleep(60); // past a throttle window — a torn-down binding must send nothing
    expect(B.outbound).toHaveLength(0);

    // A detaches: its OWN entities despawn too, and its mutators throw again (seam cleared).
    A.attachment.detach();
    expect(countMatches(A, localCursors)).toBe(0);
    expect(() => A.eph.spawn()).toThrow(/attach/i);

    // Re-attach the SAME store works (per-listener unsubscribe left the adapter re-subscribable) — a fresh
    // projection whose minted counter CONTINUES (no collision with in-flight prior keys — M1 clearRuntime).
    A.attachment = attachEphemeral(A.world, A.eph);
    const reCursor = A.eph.spawn({ components: [[CursorPos, { x: 9, y: 9 }]] }); // mutators legal again
    expect(A.world.get(reCursor, CursorPos)).toEqual({ x: 9, y: 9 });
  });
});

// --- guards ----------------------------------------------------------------------------------------
describe("attach / drain guards", () => {
  it("attachEphemeral throws mid-tick", () => {
    const world = createWorld();
    const loro = new LoroStore(5000);
    loros.push(loro);
    const eph = createEphemeralStore(new LoroEphemeralSnapshot(loro), { peerId: "alice", send: () => {} });

    // Attach a throwaway store first so a Local entity exists and the system body runs.
    const probeLoro = new LoroStore(5000);
    loros.push(probeLoro);
    const probe = createEphemeralStore(new LoroEphemeralSnapshot(probeLoro), { peerId: "probe", send: () => {} });
    extraAttachments.push(attachEphemeral(world, probe));
    probe.spawn({ components: [[CursorPos, { x: 0, y: 0 }]] });

    const sys = defineSystem(localCursors, () => {
      attachEphemeral(world, eph); // mid-tick → throws (immediate projection would corrupt the walk)
    });
    expect(() => world.tick([phase("main", [sys])])).toThrow(/query iteration or a tick/i);
  });

  it("double attach throws", () => {
    const A = makePeer("alice");
    expect(() => attachEphemeral(A.world, A.eph)).toThrow(/already attached/i);
  });

  it("drain() from inside an observer emit DEV-throws (the InboundSource obligation)", () => {
    const world = createWorld();
    const loro = new LoroStore(5000);
    loros.push(loro);
    const eph = createEphemeralStore(new LoroEphemeralSnapshot(loro), { peerId: "alice", send: () => {} });

    // Capture the binding (registered as an InboundSource) so we can call its drain() directly.
    const spy = vi.spyOn(world, "registerInboundSource");
    extraAttachments.push(attachEphemeral(world, eph));
    const source = spy.mock.calls[0][0] as InboundSource;

    vi.spyOn(world.runtime, "inObserverEmitActive", "get").mockReturnValue(true);
    expect(() => source.drain()).toThrow(/observer or reactive callback/i);
  });

  it("the eid-field ban trips on the first replicated use of an inbound component", () => {
    const B = makePeer("bob");
    void BadEid; // registered by defineComponent at module load — resolved by name during projection
    // Forge a blob carrying an eid-field component from another peer's prefix.
    const scratch = new LoroStore(30_000);
    loros.push(scratch);
    scratch.set("alice-0", { components: { AttBadEid: { ref: 123 } }, tags: [] });
    B.source.apply(scratch.encodeAll());
    expect(() => B.world.sync()).toThrow(/eid/i);
  });
});

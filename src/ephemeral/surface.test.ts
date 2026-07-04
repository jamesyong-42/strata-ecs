/**
 * `strata-ecs/ephemeral` — the public barrel (Part IV **M3**; design.md §15 API reference, 006 C7 as
 * amended). Imports come THROUGH THE BARREL (`./index`) so the test doubles as proof the public entry
 * resolves and wires end-to-end (the durable-M5 precedent: test the `./index` entry, not the built dist).
 * The exhaustive presence / blob-diff / TTL behaviours live in attach.test.ts; this file guards the SURFACE:
 *   - every public value/type export resolves, and a two-peer presence round-trip works through the barrel;
 *   - the FOUR values are the EXACT runtime export set (no internals leak into the namespace);
 *   - the adapter class is public and is the object `createEphemeralStore` accepts (the M3 decision — see the
 *     barrel header: `createEphemeralStore(source)` takes a caller-owned EphemeralSource, unlike durable's
 *     `createDurableStore(loroDoc)`, so `LoroEphemeralSnapshot` MUST be public);
 *   - `EphemeralSyncStatus` is the framework resource object, published at attach.
 *
 * Loro's per-key LWW + TTL live in the wasm wall clock (not JS we can fake, the M0 rule), so the cross-peer
 * hop uses a REAL short wait, exactly as attach.test.ts does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EphemeralStore as LoroEphemeralStore } from "loro-crdt";
import { Local, Not, createWorld, defineComponent, defineQuery } from "../core";
import {
  EphemeralSyncStatus,
  LoroEphemeralSnapshot,
  attachEphemeral,
  createEphemeralStore,
  type Attachment,
  type EphemeralSource,
  type EphemeralStore,
  type EphemeralSyncStatusValue,
} from "./index";
import * as EphemeralBarrel from "./index";

const CursorPos = defineComponent("SurfCursorPos", { x: "f32", y: "f32" });
const PresenceInfo = defineComponent("SurfPresence", { name: "string", color: "u32" });
const remoteCursors = defineQuery([CursorPos, Not(Local)]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- harness (mirrors attach.test.ts, minus the extras) --------------------------------------------
interface Peer {
  readonly world: ReturnType<typeof createWorld>;
  readonly loro: LoroEphemeralStore;
  readonly source: EphemeralSource;
  readonly eph: EphemeralStore;
  readonly attachment: Attachment;
  readonly outbound: Uint8Array[];
}

const peers: Peer[] = [];
const loros: LoroEphemeralStore[] = [];

/** A fresh attached peer, built through ONLY the public barrel exports (the round-trip under test). */
function makePeer(peerId: string): Peer {
  const world = createWorld();
  const loro = new LoroEphemeralStore(30_000); // TTL far past the test → no mid-test expiry
  loros.push(loro);
  // The public construction path: the app `new`s the adapter (a LoroEphemeralSnapshot IS an EphemeralSource),
  // then hands it to createEphemeralStore. Annotating `source` proves EphemeralSource resolves from the barrel.
  const source: EphemeralSource = new LoroEphemeralSnapshot(loro);
  const outbound: Uint8Array[] = [];
  const eph: EphemeralStore = createEphemeralStore(source, { peerId, send: (b) => outbound.push(b), throttleMs: 16 });
  const attachment: Attachment = attachEphemeral(world, eph);
  const peer: Peer = { world, loro, source, eph, attachment, outbound };
  peers.push(peer);
  return peer;
}

/** Forward every buffer `from` broadcast into `to`'s source (the transport hop the app owns). */
function deliver(from: Peer, to: Peer): void {
  for (const b of from.outbound.splice(0)) to.source.apply(b);
}

afterEach(() => {
  for (const p of peers.splice(0)) {
    try {
      p.attachment.detach();
    } catch {
      /* already detached in-test */
    }
  }
  for (const s of loros.splice(0)) s.destroy(); // clear each Loro store's wasm cleanup timer
});

// ===================================================================================================
describe("the public barrel (strata-ecs/ephemeral)", () => {
  it("exposes the documented value + type surface, and it wires a presence round-trip end-to-end", async () => {
    expect(typeof createEphemeralStore).toBe("function");
    expect(typeof attachEphemeral).toBe("function");
    expect(typeof LoroEphemeralSnapshot).toBe("function"); // the adapter class (a value + a type)
    // EphemeralSyncStatus is the framework resource object (not a factory).
    expect(EphemeralSyncStatus.name).toBe("EphemeralSyncStatus");

    // A presence round-trip through ONLY the public exports. The `source`/`eph`/`attachment` annotations in
    // makePeer prove EphemeralSource / EphemeralStore / Attachment resolve from the barrel (compile-time);
    // the projection proves the wiring runs (runtime).
    const alice = makePeer("alice");
    const bob = makePeer("bob");

    alice.eph.spawn({
      components: [
        [CursorPos, { x: 1, y: 2 }],
        [PresenceInfo, { name: "Alice", color: 0xff0000 }],
      ],
    });
    await sleep(25); // alice's change-throttle fires → bytes in alice.outbound
    deliver(alice, bob);
    bob.world.sync(); // drain → project alice's cursor onto bob

    const rc = bob.world.firstOf(remoteCursors);
    expect(rc).toBeDefined();
    expect(bob.world.get(rc!, CursorPos)).toEqual({ x: 1, y: 2 });
    expect(bob.world.hasTag(rc!, Local)).toBe(false); // a remote projection is NEVER Local (§15.4)

    // EphemeralSyncStatus published through the binding; the `EphemeralSyncStatusValue` annotation resolves it.
    const status: EphemeralSyncStatusValue | undefined = bob.world.getResource(EphemeralSyncStatus);
    expect(status).toEqual({ peerCount: 1, lastInboundFrame: 1 });

    alice.attachment.detach();
    bob.attachment.detach();
  });

  it("the FOUR values are the exact runtime export set (no internals leak)", () => {
    // Types erase at runtime, so the barrel namespace holds exactly the four public values. If an internal
    // (the binding, the Projector, key minting) ever leaked as a value export, this fails.
    expect(Object.keys(EphemeralBarrel).sort()).toEqual(
      ["EphemeralSyncStatus", "LoroEphemeralSnapshot", "attachEphemeral", "createEphemeralStore"].sort(),
    );
  });

  it("the adapter class is public and is the EphemeralSource createEphemeralStore accepts (the M3 decision)", () => {
    // Unlike durable's createDurableStore(loroDoc) (adapter internal), createEphemeralStore takes a
    // caller-built EphemeralSource — so the ONE constructible source, LoroEphemeralSnapshot, must be public.
    const loro = new LoroEphemeralStore(30_000);
    loros.push(loro);
    const source: EphemeralSource = new LoroEphemeralSnapshot(loro);
    const eph = createEphemeralStore(source, { peerId: "carol", send: () => {} });
    expect(eph.peerId).toBe("carol");
  });
});

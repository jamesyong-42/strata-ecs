/**
 * `@vibecook/strata-ecs/ephemeral` — the ephemeral layer's public surface (Part IV; docs/design.md §15 as amended by
 * 006, and the Part IV API reference).
 *
 * A writable, writer-partitioned, LWW/TTL ephemeral entity store over Loro's `EphemeralStore` (presence,
 * cursors, live previews): each peer OWNS its own partition, mutates it immediately (Option A), and the
 * binding projects every other peer's blobs in as live `Not(Local)` entities that self-expire on TTL. Built
 * entirely on Part II. `loro-crdt` is an OPTIONAL peer dependency — it is named in exactly one place (the
 * `LoroEphemeralSnapshot` adapter) and never bundled.
 *
 *   import { LoroEphemeralSnapshot, createEphemeralStore, attachEphemeral } from "@vibecook/strata-ecs/ephemeral";
 *   import { EphemeralStore as LoroEphemeralStore } from "loro-crdt";
 *   const loro = new LoroEphemeralStore(5000);                 // the backing Loro store — you own its lifecycle
 *   const source = new LoroEphemeralSnapshot(loro);            // the ONE place loro-crdt enters this layer
 *   const eph = createEphemeralStore(source, { peerId: crypto.randomUUID(), send: b => transport.send(b) });
 *   const attachment = attachEphemeral(world, eph);            // project peers in; start the timers (§15.3)
 *   transport.onMessage(bytes => source.apply(bytes));         // INBOUND wire (you own the source ↔ transport)
 *   // …later: attachment.detach();
 *
 * ── WHY THE ADAPTER CLASS IS PUBLIC (the one divergence from durable's M5 surface) ──
 * Durable's `createDurableStore(loroDoc)` takes a raw `LoroDoc` and constructs its `LoroSnapshot` INTERNALLY,
 * so that adapter stays unexported. Ephemeral is the mirror image: `createEphemeralStore(source, opts)` takes
 * a caller-owned {@link EphemeralSource} — the app owns the backing Loro `EphemeralStore`'s lifecycle and its
 * inbound `apply` ↔ transport wiring (design §15.2). The ONLY `EphemeralSource` a consumer can build is
 * {@link LoroEphemeralSnapshot} (the second and last Loro-aware class, design §0), so it MUST be public —
 * it is the object the consumer `new`s. `EphemeralSource` itself is exported for the advanced case (a test
 * double or an alternative backend); the internals (the `EphemeralStore` binding, the `Projector` seam, the
 * blob-diff cache, key minting) stay unexported.
 *
 * The surface is deliberately MINIMAL. `EphemeralStore` is exported TYPE-ONLY (the `DurableStore` precedent —
 * you get one from `createEphemeralStore`, never `new` the class; the constructor is not API). `EphemeralDebugDump`
 * — the read-all shape `eph.debugDump()` returns for the tools observer's ephemeral tab — is likewise TYPE-ONLY
 * (a debug/observability seam, never a sync path). `Local` is
 * NOT re-exported here — its canonical home is the core barrel (`@vibecook/strata-ecs`; design §20, one home per
 * symbol); a presence query is `defineQuery([PresenceInfo, Not(Local)])` with both imported from `@vibecook/strata-ecs`.
 * `Attachment` is the ephemeral layer's OWN handle (`{ detach() }`, no `baseline` seam — the writer-partitioned
 * layer keeps no baseline), deliberately distinct from durable's identically-named handle; the two never
 * collide (separate entry points) and are structurally compatible at the public surface.
 */

// The adapter — the one Loro-aware class a consumer constructs (see the header note). Exported as a value
// (the class) and, implicitly, as a type; wraps a caller-owned Loro `EphemeralStore`.
export { LoroEphemeralSnapshot } from "./loro-ephemeral-snapshot";

// The store + its constructor. `EphemeralStore` is TYPE-ONLY (you get one from createEphemeralStore); the
// binding, the Projector seam, and key minting stay unexported.
export { createEphemeralStore } from "./ephemeral-store";
export type { EphemeralStore } from "./ephemeral-store";

// The read-all shape `eph.debugDump()` returns for the tools observer's ephemeral tab — TYPE-ONLY
// (debug/observability, never a sync seam).
export type { EphemeralDebugDump } from "./ephemeral-store";

// Attach / detach (a package-level function, not `world.attachEphemeral` — the core names no ephemeral type).
export { attachEphemeral } from "./attach";
export type { Attachment } from "./attach";

// The Loro-quarantining source interface — the type of `createEphemeralStore`'s first argument, exported for
// the advanced case (implementing an alternative source / a test double).
export type { EphemeralSource } from "./types";

// The runtime-local sync-status resource — `useResource(world, EphemeralSyncStatus)` (006 C7, §15.7).
export { EphemeralSyncStatus } from "./sync-status";
export type { EphemeralSyncStatusValue } from "./sync-status";

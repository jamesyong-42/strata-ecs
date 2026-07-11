/**
 * `@vibecook/strata-ecs/durable` — the durable layer's public surface (Part III; docs/design.md §11–§14 as
 * amended by 006, and the Part III API reference).
 *
 * Opt-in collaborative persistence and sync over a Loro CRDT: a document you change at explicit
 * boundaries (`doc.transaction`), projected into the one queryable runtime as live entities, converged
 * by a lagging baseline. Built entirely on Part II. `loro-crdt` is an OPTIONAL peer dependency — it is
 * named in exactly one place (the `LoroSnapshot` adapter behind `createDurableStore`) and never bundled.
 *
 *   import { createDurableStore, attachDurable, DurableSyncStatus } from "@vibecook/strata-ecs/durable";
 *   const doc = createDurableStore(loroDoc);        // the ONE place a LoroDoc enters (§14.2)
 *   const attachment = attachDurable(world, doc);   // project the document in; register the drain (§12.4)
 *   doc.subscribeOutbound(bytes => transport.send(bytes));   // OUTBOUND wire
 *   transport.onMessage(bytes => doc.applyRemote(bytes));    // INBOUND wire
 *   // …later: attachment.detach();
 *
 * The surface is deliberately MINIMAL (the Part III API reference is the guide): the internals —
 * `LoroSnapshot`, the `Projector`, the baseline, the `DurableBinding`, the `TxRuntime` seam, key
 * minting — are NOT exported. `DurableStore` is exported type-only, so app code annotates with it but
 * obtains one only from `createDurableStore` (it never `new`s the class — the constructor is not API).
 */

// The store + its constructor. `DurableStore` is TYPE-ONLY (the constructor is not public API — you get
// one from createDurableStore); DurableBijection / the LoroSnapshot it holds stay unexported.
export { createDurableStore } from "./durable-store";
export type { DurableStore, DurableStoreOptions } from "./durable-store";

// History (plan-undo): undo/redo/canUndo/canRedo/undoGroup/clearHistory/setHistoryHooks live ON
// `DurableStore`; these are their companion types. Local-ops-only, one transaction = one undo step.
export type { HistoryHooks, HistoryStack } from "./loro-snapshot";

// The editor a `DurableStore.metaTransaction(fn)` body receives — primitive get/set over the document's
// reserved metadata map (engine version / schema markers), excluded from undo and invisible to observers
// (petition 3b; 005 §10.11).
export type { MetaEditor } from "./loro-snapshot";

// Attach / detach (a package-level function, not `world.attachDurable` — the core names no durable type).
export { attachDurable } from "./binding";
export type { Attachment } from "./binding";

// The transaction authoring vocabulary — the `tx` a `doc.transaction(fn)` body receives (§12).
export type { Mutator, TxEditor } from "./transaction";

// The quarantine breach the transport must resync on (the loro-crdt out-of-order import panic, 006 §A4).
export { PendingImportError } from "./loro-snapshot";

// The runtime-local sync-status resource — `useResource(world, DurableSyncStatus)` (006 C7, §15.7).
export { DurableSyncStatus } from "./sync-status";
export type { DurableSyncStatusValue } from "./sync-status";

// The runtime-local undo/redo availability resource — drives toolbar enablement reactively (plan-undo U2).
export { DurableUndoStatus } from "./undo-status";
export type { DurableUndoStatusValue } from "./undo-status";

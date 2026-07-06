/**
 * `createDurableStore(doc)` + `DurableStore` — Part III **M1** (docs/plan-part3.md).
 *
 * `createDurableStore` is THE ONE PLACE a `LoroDoc` enters the durable layer (design.md §14.2): it wraps
 * the caller-owned doc in a {@link LoroSnapshot} (Loro's only quarantine breach) and returns a
 * `DurableStore` — the object app code holds, opens transactions on (M3), and wires to its transport.
 * This file's ONLY `loro-crdt` reference is the `LoroDoc` PARAMETER TYPE; every actual Loro call lives
 * inside `LoroSnapshot`, reached here through its adapter-level surface (`peerIdStr`/`entityKeysRaw`/
 * `version`/`exportUpdatesSince`/`readMeta`/`ensureMeta`) plus the frozen `CRDTSnapshot`.
 *
 * M1 SCOPE (what this milestone ships; the rest is stubbed at its seam):
 *   - **Key minting** (§14.1/§14.2): peer-prefixed `${peerId}-<counter>`, the counter RESUMED past this
 *     peer's max existing key at construction so a reloaded doc never re-mints a used key. `mintKey()`
 *     is @internal for M2's projector / M3's executor.
 *   - **`docId`** (§14.1): a stable GUID stored in the doc's reserved "meta" root map, written
 *     once-if-absent at construction (see the DECISIONS block). Shared by all collaborators.
 *   - **Reads**: `getComponentByKey` (key-addressed, works pre-attach) delegates to the snapshot;
 *     `getComponent`/`keyOf`/`resolve` are handle-addressed and consult the projector bijection, which is
 *     null until M2's attach installs it — so they return `undefined` pre-attach (the documented seam).
 *   - **`applyRemote`** (§14.2): the fire-and-forget INBOUND wire — delegates to the snapshot and ENQUEUES
 *     the returned per-commit batches for M2's binding to drain at `sync()`. `PendingImportError`
 *     propagates uncaught (the transport must resync — 006 §A4).
 *   - **`subscribeOutbound`** (§14.2): the OUTBOUND wire — on each sealed LOCAL commit, ship the update
 *     increment since the last send to every subscriber.
 *
 * NOT M1: `attachDurable`/the binding/projection/reconcile (M2/M4), the public `@vibecook/strata-ecs/durable`
 * barrel (M5 — `src/durable/index.ts` keeps throwing until then). **M3 adds `transaction`** (the
 * upward boundary, §12) — recorder + executor in `transaction.ts`, reached through the `TxRuntime`
 * seam M2's attach installs here; legal only on an attached store.
 *
 * ============================================================================================
 * DECISIONS (load-bearing; see the task brief + design.md §14)
 * ============================================================================================
 *  A. **docId storage = reserved "meta" root map, first-writer-wins.** The GUID is written to
 *     `meta["docId"]` ONCE at construction, only if absent, inside one sealed commit (adapter
 *     `ensureMeta`). "meta" is a THIRD root map — never "entities"/"resources" — so it can't collide with
 *     an entity key or resource name, and it is TRANSPARENT to batch translation (a meta diff resolves to
 *     path `["meta"]`, which the adapter's child-map guard skips → no ChangeEvent, no undo step — the
 *     commit carries the adapter's META_ORIGIN, excluded from the UndoManager). Under true concurrency
 *     (two peers each minting on a fresh doc) the writes race and LWW picks one docId; harmless because in
 *     practice all collaborators derive from ONE shared initial doc (one peer creates it, others load its
 *     bytes → they read the existing docId, never mint). `docId` is read once at construction and frozen.
 *  B. **Outbound versioning STARTS AT CONSTRUCTION.** `lastSentVersion` is seeded from the doc version
 *     right after the docId write, and each local commit ships `exportUpdatesSince(lastSentVersion)`. A
 *     subscriber attaching mid-life therefore MISSES commits sealed before it subscribed — acceptable
 *     because §14.2's flow wires transport before editing, and a joining peer bootstraps from a snapshot
 *     (006 §A5.2), not from the increment stream. The construction-time docId commit is likewise not
 *     shipped incrementally; it rides that bootstrap snapshot.
 *  C. **Quarantine propagates.** `applyRemote` does NOT catch `PendingImportError`: the transport layer
 *     must see the quarantine and resync (fresh doc + snapshot). Because the snapshot is PERMANENTLY
 *     quarantined after a pending import, every later `applyRemote` throws BEFORE enqueuing, so the
 *     inbound queue cannot grow post-quarantine (006 §A4 addendum).
 */

import type { LoroDoc } from "loro-crdt"; // the ONE loro import — parameter type ONLY (Loro stays in the adapter)
import { type Component, type Entity, type EntityKey, entityKey } from "../core";
import type { ChangeBatch, Unsubscribe } from "../substrate";
import { LoroSnapshot, type OutboundCursor } from "./loro-snapshot";
import { type Mutator, runTransaction, type TxRuntime } from "./transaction";

/** The reserved "meta" slot holding the document GUID (§14.1). */
const DOC_ID_KEY = "docId";

/**
 * The projector's key↔handle bijection (§10), installed by M2's `attachDurable`. Pre-attach the store
 * holds `null` and every handle-addressed read returns `undefined` — a runtime handle has no meaning
 * until a runtime exists to mint it. Exposed so M2 can wire the seam without widening the public surface.
 */
export interface DurableBijection {
  keyOf(e: Entity): EntityKey | undefined;
  resolve(key: EntityKey): Entity | undefined;
}

/**
 * The greatest integer suffix among `keys` carrying `prefix` (this peer's own minted keys), or `-1` if
 * none — so the resumed counter is `max + 1` (§14.2). Keys with a different prefix (foreign peers) and
 * non-integer suffixes are ignored, so neither can bump this peer's counter. Empty suffix is skipped so a
 * bare `"1-"` never reads as `0`.
 */
function maxMintedSuffix(keys: readonly string[], prefix: string): number {
  let max = -1;
  for (const k of keys) {
    if (!k.startsWith(prefix)) continue;
    const suffix = k.slice(prefix.length);
    if (suffix === "") continue;
    const n = Number(suffix);
    if (Number.isInteger(n) && n >= 0 && n > max) max = n;
  }
  return max;
}

/**
 * `DurableStore` — the durable layer's public object (design.md §14, API reference). M1 implements the
 * identity + wire surface; `transaction` (M3) and the attach/projection machinery (M2+) land later. App
 * code obtains one from {@link createDurableStore}, never `new`s it directly in practice.
 */
export class DurableStore {
  /** Stable document GUID, shared by all collaborators (§14.1). Read once at construction (decision A). */
  readonly docId: string;

  /**
   * @internal The Loro adapter. M2's binding projects/subscribes/imports through it; M3's executor writes
   * the transaction batch through it; tests drive local commits through it (M1 has no `transaction` yet).
   * Not public surface — the store's own methods are the boundary (§14.2).
   */
  readonly snapshot: LoroSnapshot;

  /** `${peerIdStr}-` — the minted-key prefix, derived from the doc's own peer id (§14.1). */
  private readonly prefix: string;
  /** Next counter value; resumed past existing keys at construction, only ever moves forward (§12.3 burn). */
  private counter: number;
  /** Installed by M2's attach; null pre-attach → handle-addressed reads return undefined (the seam). */
  private bijection: DurableBijection | null = null;
  /**
   * The transaction seam (runtime + projector + baseline) M2's attach installs; null pre-/post-attach
   * (M3). `transaction` needs the projector to mint identity and the baseline for the overlay, so it is
   * legal ONLY while attached — a null seam is the "unattached" signal (§12.4, transaction.ts decision A).
   */
  private txRuntime: TxRuntime | null = null;
  /** True between `transaction` entry and exit — the one-open-transaction-per-store gate (nested throws). */
  private txOpen = false;
  /** Per-commit batches awaiting M2's binding drain (both own-echo and remote arrive here via applyRemote). */
  private pendingInbound: ChangeBatch[] = [];
  /**
   * The binding installs this at attach (M5): called after `applyRemote` enqueues remote batches, so the
   * binding can republish `DurableSyncStatus.pendingInbound` at the ENQUEUE boundary (006 C7 — measured at
   * enqueue). Null pre-/post-attach; the local-echo enqueue is the binding's own subscription, not this.
   */
  private onInboundEnqueue: (() => void) | null = null;
  /** Outbound-byte sinks (transport senders). All receive the SAME bytes per commit (decision B). */
  private readonly outboundSubscribers = new Set<(bytes: Uint8Array) => void>();
  /** The doc version as of the last outbound send — the "from" of the next increment (decision B). */
  private lastSentVersion: OutboundCursor;

  constructor(doc: LoroDoc) {
    const snap = new LoroSnapshot(doc); // Loro quarantined behind CRDTSnapshot (§14.2)
    this.snapshot = snap;

    // Key minting: prefix from the doc's peer id; counter RESUMES past this peer's max existing key so a
    // reloaded doc never re-mints (§14.2). The scan uses RAW entity keys (despawned containers linger).
    this.prefix = `${snap.peerIdStr()}-`;
    this.counter = maxMintedSuffix(snap.entityKeysRaw(), this.prefix) + 1;

    // docId: reserved "meta" slot, written once-if-absent inside a sealed commit (decision A).
    this.docId = snap.ensureMeta(DOC_ID_KEY, crypto.randomUUID());

    // Outbound versioning starts HERE, after the docId write (decision B): the cursor advances on every
    // local commit whether or not anyone is subscribed, so a late subscriber misses earlier commits.
    this.lastSentVersion = snap.version();
    // Local echo ONLY (`origin === "local"`): a local commit's increment is the outbound payload. Remote
    // batches reach the runtime via applyRemote's return value, NOT here — subscribing to remote too would
    // double-deliver them to the M2 binding.
    snap.subscribe((batch) => this.onLocalBatch(batch));
  }

  // --- identity (§14.1/§14.3) ----------------------------------------------------------------------

  /**
   * @internal Mint the next peer-prefixed key (§14.1). The counter resumed past existing keys at
   * construction and only ever moves forward (burned, never rolled back — §12.3). For M2's projector and
   * M3's executor, which mint a key per newly-introduced durable entity.
   */
  mintKey(): EntityKey {
    return entityKey(`${this.prefix}${this.counter++}`);
  }

  /**
   * @internal Install (or clear) the projector's key↔handle bijection — M2's `attachDurable` sets it,
   * detach clears it back to null. Until set, `keyOf`/`resolve`/`getComponent` return undefined.
   */
  setBijection(bijection: DurableBijection | null): void {
    this.bijection = bijection;
  }

  /**
   * @internal Install (or clear) the transaction seam — M2's `attachDurable` sets it alongside the
   * bijection, detach clears it back to null (M3, §12.4). Until set, `transaction` throws (an
   * unattached store has no projector to mint identity / no baseline for the overlay).
   */
  setTxRuntime(txRuntime: TxRuntime | null): void {
    this.txRuntime = txRuntime;
  }

  /**
   * @internal The count of undrained REMOTE batches on the store's queue — the store's half of
   * `DurableSyncStatus.pendingInbound` (the binding adds its own local-echo queue length, 006 C7).
   */
  get pendingCount(): number {
    return this.pendingInbound.length;
  }

  /**
   * @internal Install (or clear) the enqueue listener M5's `attachDurable` sets alongside the bijection,
   * detach clears it back to null. `applyRemote` calls it after enqueuing so the binding can republish the
   * sync-status resource at the enqueue boundary; null means no attachment is watching (006 C7).
   */
  setInboundListener(cb: (() => void) | null): void {
    this.onInboundEnqueue = cb;
  }

  // --- the transaction: the upward boundary (§12) --------------------------------------------------

  /**
   * Run a block as ONE document change (design.md §12): `fn` records mutations through the `tx`
   * {@link Mutator}, the block seals as one Loro commit / one undo unit / one sync message, and
   * `fn`'s result is returned. Value writes to pre-existing components apply to runtime + document +
   * baseline synchronously; all structure reaches the runtime via projection at the next `sync()`
   * (§12.3). Works identically inside or outside a system (identity-mint and value-writes are
   * iteration-safe; structure rides projection) — no iteration guard. On any throw nothing commits
   * and the transaction rolls back (minted identities invalidated, keys burned — transaction.ts).
   *
   * Legal ONLY on an ATTACHED store (the recorder needs the projector + baseline the binding installs)
   * and NOT re-entrantly (one open transaction per store — a nested `transaction` throws).
   */
  transaction<R>(fn: (tx: Mutator) => R): R {
    if (this.txRuntime === null) {
      throw new Error("strata: doc.transaction requires an attached store — call attachDurable(world, store) first (§12.4).");
    }
    if (this.txOpen) {
      throw new Error("strata: nested doc.transaction is not allowed — one open transaction per store (§12.2).");
    }
    this.txOpen = true;
    try {
      return runTransaction(this.snapshot, this.txRuntime, fn);
    } finally {
      this.txOpen = false;
    }
  }

  /** The durable key bound to `e`, or `undefined` if `e` isn't a durable handle — or pre-attach (§14.3). */
  keyOf(e: Entity): EntityKey | undefined {
    return this.bijection?.keyOf(e);
  }

  /** The current handle for `key`, or `undefined` if it isn't present — or pre-attach (§14.3). */
  resolve(key: EntityKey): Entity | undefined {
    return this.bijection?.resolve(key);
  }

  // --- reads (§14, API reference) ------------------------------------------------------------------

  /**
   * The converged DOCUMENT value of `e`'s component `c`, or `undefined` (absent, `e` not durable, or
   * pre-attach). Handle-addressed: translates `e` → key via the bijection (null pre-attach → undefined),
   * then reads the snapshot. Distinct from the runtime read — this is the document's converged truth.
   */
  getComponent<S>(e: Entity, c: Component<S>): S | undefined {
    const key = this.keyOf(e);
    return key === undefined ? undefined : this.getComponentByKey(key, c);
  }

  /**
   * @internal Key-addressed converged read — the PRE-ATTACH path (no bijection needed), delegating
   * straight to the snapshot. `getComponent` is this composed with `keyOf`; M2 uses it directly when it
   * holds a key (projection). Exists because before attach there is no handle to address a read by.
   */
  getComponentByKey<S>(key: EntityKey, c: Component<S>): S | undefined {
    // The snapshot returns a structural ComponentValue; S is its decoded shape (unrelated to TS, so the
    // bridge is a deliberate assertion — the caller's Component<S> names the intended value type).
    return this.snapshot.getComponent(key, c) as unknown as S | undefined;
  }

  // --- the wire (§14.2) ----------------------------------------------------------------------------

  /**
   * INBOUND wire — the fire-and-forget transport entry point (§14.2). Delegates to the snapshot's
   * `applyRemote`, which imports the bytes and returns one origin-tagged `ChangeBatch` per remote commit;
   * those batches are ENQUEUED for M2's binding to drain at the next `world.sync()` (returns `void` — the
   * caller has no use for them; §14.2's "two applyRemotes, two layers"). `PendingImportError` propagates
   * UNCAUGHT (decision C): the transport must resync. Post-quarantine the snapshot throws here before any
   * enqueue, so the inbound queue never grows once poisoned.
   */
  applyRemote(bytes: Uint8Array): void {
    const batches = this.snapshot.applyRemote(bytes);
    for (const b of batches) this.pendingInbound.push(b);
    // Republish DurableSyncStatus.pendingInbound at the enqueue boundary (006 C7) — but ONLY when this
    // import actually carried new commits, so a redundant re-import (no new batches) stays a no-op and
    // cannot flicker the panel on an idle wire.
    if (batches.length > 0) this.onInboundEnqueue?.();
  }

  /**
   * @internal Drain the inbound queue (empties and returns it) — M2's binding calls this from
   * `world.sync()` to reconcile pending doc changes into the runtime (§13.3).
   */
  drainPending(): ChangeBatch[] {
    const out = this.pendingInbound;
    this.pendingInbound = [];
    return out;
  }

  /**
   * FULL SNAPSHOT for a late joiner's bootstrap (§14.2 transport wiring; docs/plan-collab-demo.md's
   * hello/snapshot protocol). Delegates to the adapter's `export()` — the whole converged document as
   * self-contained bytes a fresh peer imports (via `applyRemote`) BEFORE it applies any live increment,
   * so the increments' causal base is present and none quarantines (loro-snapshot finding 11 / 006 §A5.2).
   * This is a legitimate transport surface: an increment presupposes its base was shipped first, and a
   * joining peer has no base — so it needs the snapshot, not the increment stream. Keep the byte-moving
   * in the app; the store only encodes (Loro stays quarantined behind the adapter, §14.2).
   */
  exportSnapshot(): Uint8Array {
    return this.snapshot.export();
  }

  /**
   * OUTBOUND wire (§14.2). `fn` receives the encoded bytes of each sealed LOCAL commit; forward them to
   * the transport. Multiple subscribers all receive the SAME bytes per commit. A subscriber attaching
   * mid-life misses commits sealed before it subscribed (decision B). Returns an `Unsubscribe`.
   */
  subscribeOutbound(fn: (bytes: Uint8Array) => void): Unsubscribe {
    this.outboundSubscribers.add(fn);
    return () => {
      this.outboundSubscribers.delete(fn);
    };
  }

  /**
   * The snapshot's local-echo callback: on each sealed LOCAL commit, ship the increment since the last
   * send and advance the cursor. Remote batches are ignored here (they arrive via `applyRemote`). The
   * cursor advances even with zero subscribers (decision B) — a late subscriber starts from "now", not
   * from construction. The export is skipped when no one is listening (nothing to ship), but the cursor
   * still moves; if an event-less local commit intervened it simply rides the next increment (harmless
   * superset — Loro import is idempotent).
   */
  private onLocalBatch(batch: ChangeBatch): void {
    if (batch.origin !== "local") return;
    if (this.outboundSubscribers.size > 0) {
      const bytes = this.snapshot.exportUpdatesSince(this.lastSentVersion);
      for (const fn of [...this.outboundSubscribers]) fn(bytes);
    }
    this.lastSentVersion = this.snapshot.version();
  }
}

/**
 * Wrap a caller-owned `LoroDoc` in a {@link DurableStore} — THE one place a `LoroDoc` enters the durable
 * layer (design.md §14.2). The caller owns the doc's lifecycle (construction, loading bytes, transport);
 * this constructs the `LoroSnapshot`, seeds key minting, and establishes the docId. Everything downstream
 * speaks only Part II interfaces plus the store's methods.
 */
export function createDurableStore(doc: LoroDoc): DurableStore {
  return new DurableStore(doc);
}

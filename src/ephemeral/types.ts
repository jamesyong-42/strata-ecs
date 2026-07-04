/**
 * The ephemeral layer's vocabulary (design §15, Part IV API reference; 006 B5) — types only.
 *
 * `EphemeralSource` is the Part II citizen that lives OUTSIDE the snapshot ladder (design:1417): the
 * ephemeral store is per-key value *blobs* with three coarse events, NOT cell-addressable, so it gets
 * its own lean interface rather than extending {@link "../substrate".Snapshot}. It is the ephemeral
 * twin of `CRDTSnapshot`: Loro is quarantined behind it by exactly one adapter class
 * (`LoroEphemeralSnapshot`), the second and last Loro-aware type in the codebase (design §0).
 *
 * ALL projection logic (blob → spawn/update-with-diff/despawn, the `lastSeenBlobByKey` cache, the
 * `Local` auto-tag, partition ownership) lives ABOVE this interface, in the store (M1/M2). The source
 * only MOVES blobs and REPORTS the three events (plan-part4 locked decision) — no timers, no
 * projection, no partition logic here.
 *
 * ── ADJUSTMENTS FROM design §15.6's `EphemeralSource` sketch (each forced by the M0 spike; see the
 * findings block in loro-ephemeral-snapshot.ts) ──
 *   1. `encodeChanged`/`encodeKeys` return `Uint8Array | null` (null when there is nothing to send),
 *      not a bare `Uint8Array` — the store's throttle/keepalive timers fire on a clock, so "clean →
 *      null → don't call send()" is the natural contract (a wasted empty broadcast otherwise).
 *   2. `encodePartition(prefix: string)` is generalized to `encodeKeys(keys)` — the CALLER picks the
 *      exact key set. 006 B5 requires the keepalive to re-send only keys THIS session MINTED, never
 *      own-prefix keys learned from inbound (a reused peerId would otherwise refresh ghosts forever),
 *      and a prefix scan cannot separate minted from learned. So the store passes its minted set.
 *   3. `encodeDeletes(): Uint8Array[]` is NEW. Loro's `encode`/`encodeAll` snapshot PRESENT state
 *      only — they cannot carry a removal (a deleted key is simply absent). A deletion crosses the
 *      wire ONLY as an incremental tombstone buffer, and `apply` consumes exactly one framed message
 *      (buffers never concatenate), so N deletes are N buffers. This method drains the tombstones the
 *      source captured at `delete()` time; the store sends each individually. Deletes are best-effort
 *      (design §15.3) — the guaranteed despawn is always TTL `timeout`.
 */

import type { EntityKey } from "../core/field";
import type { Unsubscribe } from "../substrate";

/**
 * A per-entity value blob — one Loro `EphemeralStore` key's value (design §15.3): that entity's
 * components (+ tags), a plain object. The store encodes/decodes it; the source treats it opaquely
 * (it moves the whole object, never a cell). Loro preserves `NaN`/`±Infinity`/nested objects/arrays
 * (M0 finding 5), so the blob shape is unconstrained beyond "a JSON-ish object".
 */
export type EphemeralBlob = Record<string, unknown>;

/**
 * One source event, translated from a Loro `EphemeralStore` event (design §15.3's three-event table):
 *  - `local`   — this peer's own `set`/`delete` echoed back (the outbound wire copy). The store IGNORES
 *                it for runtime purposes (Option A already applied it, design §15.3) — surfaced for
 *                faithfulness / diagnostics only. Carries `value` for a set echo, none for a delete echo.
 *  - `remote`  — another peer's blob arrived via `apply`. Carries the whole `value` (the store's
 *                blob-diff, §15.6, runs against it). The store SPAWNS (unseen key) or DIFFS (seen key).
 *  - `timeout` — a despawn: the key's TTL lapsed OR a remote peer explicitly deleted it. design §15.3
 *                treats an explicit remote delete and a TTL timeout IDENTICALLY at the projector (both
 *                `projector.remove`), so the adapter folds a remote delete into `timeout`. No `value`.
 */
export interface EphemeralEvent {
  kind: "local" | "remote" | "timeout";
  key: EntityKey;
  /** The whole blob — present on `remote` (and `local` set echoes), absent on `timeout`/delete. */
  value?: EphemeralBlob;
}

/**
 * The Loro-quarantining interface for the ephemeral store (design §15.6 API reference, as amended by
 * the M0 spike — see the ADJUSTMENTS note above). Per-key value blobs, three coarse events; NOT a
 * cell-addressable `Snapshot`.
 */
export interface EphemeralSource {
  /** Upsert this entity's whole value blob (its components + tags). Scoped to the caller's partition. */
  set(key: EntityKey, value: EphemeralBlob): void;
  /**
   * Explicit removal (best-effort leave, design §15.3). Captures the tombstone bytes for
   * {@link encodeDeletes} to drain. A guaranteed despawn is always TTL `timeout`, never this.
   */
  delete(key: EntityKey): void;
  /**
   * The THROTTLE path: a single buffer encoding the CURRENT value of every key dirtied by `set` since
   * the last call (coalesced to the latest per key), or `null` if nothing was dirtied. Re-stamps at
   * send time so send-order == timestamp-order (the per-key LWW ordering contract, below). Carries
   * NO removals — deletes drain through {@link encodeDeletes}.
   */
  encodeChanged(): Uint8Array | null;
  /**
   * The KEEPALIVE path: a single buffer re-encoding the CURRENT value of exactly the given keys that
   * are still present, or `null` if none are. Re-stamping REFRESHES their TTL on both this store and
   * receivers (idle-but-live entities never self-expire, design §15.3/§15.5). The caller passes only
   * keys this session MINTED (006 B5) — never own-prefix keys learned from inbound.
   */
  encodeKeys(keys: readonly EntityKey[]): Uint8Array | null;
  /**
   * Drain the tombstone buffers captured since the last call (one per `delete`), clearing the pending
   * set. Each element is a single framed loro message — send them INDIVIDUALLY (buffers don't
   * concatenate, M0 finding 3). Empty array when nothing was deleted.
   */
  encodeDeletes(): Uint8Array[];
  /** Inbound: apply a peer's buffer. Fires `remote`/`timeout` events synchronously to subscribers. */
  apply(bytes: Uint8Array): void;
  /**
   * Subscribe to the three events. The callback fires SYNCHRONOUSLY during `set`/`delete`/`apply`
   * (M0 finding 1) and from Loro's TTL cleanup timer (`timeout`). The consumer ENQUEUES; it must not
   * apply mid-callback (the Part III enqueue-never-apply discipline).
   *
   * PER-KEY LWW ORDERING CONTRACT (design §15.6 / dynamics-trace E5, REQUIRED). A `remote` event is
   * surfaced for a key only when its blob is at least as new as the last one applied for that key; a
   * stale, out-of-order blob (an older blob arriving after a newer one) is DROPPED and NEVER surfaced.
   * Loro's `EphemeralStore` provides this natively (M0 finding 2: a stale `apply` yields empty
   * added/updated arrays, so nothing is surfaced; and the blob is always re-read via `get`, which
   * returns the LWW winner). The store's blob-diff (§15.6) DEPENDS on this — an out-of-order older
   * blob would otherwise resurrect stale state (re-add a component the owner already removed).
   */
  subscribe(fn: (ev: EphemeralEvent) => void): Unsubscribe;
}

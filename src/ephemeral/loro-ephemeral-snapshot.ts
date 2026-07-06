/**
 * `LoroEphemeralSnapshot` — the SECOND and LAST Loro-aware adapter (Part IV M0, docs/plan-part4.md).
 *
 * `LoroEphemeralSnapshot implements EphemeralSource` (src/ephemeral/types.ts) over a caller-supplied
 * Loro `EphemeralStore`. It is THE ONLY file besides `loro-snapshot.ts` that may import `loro-crdt`
 * (design §0). Like the durable adapter it moves blobs and reports events and makes NO projection
 * decision — all projection (blob-diff, the `lastSeenBlobByKey` cache, the `Local` auto-tag, partition
 * ownership, the two outbound timers) lives ABOVE this interface in the store (M1/M2).
 *
 * The one value import of `loro-crdt` here is the `EphemeralStore` CLASS — needed because a subset
 * buffer is built from a THROWAWAY scratch `EphemeralStore` (finding 3); the durable adapter only holds
 * `LoroDoc` as a param type, but subset encoding has no type-only path.
 *
 * ============================================================================================
 * LORO EphemeralStore API FINDINGS (verified empirically against loro-crdt@1.13.6 in throwaway spikes;
 * training data was NOT trusted). Extends the Part III knowledge block in loro-snapshot.ts. This is the
 * Part IV knowledge base — M1/M2 build on it.
 * ============================================================================================
 *
 *  1. EVENT TIMING IS SYNCHRONOUS, AND EVENTS CARRY KEY LISTS ONLY (no values). `store.subscribe(fn)`
 *     fires DURING `set()`, `delete()`, and `apply(bytes)` — before the call returns — and also from
 *     Loro's TTL cleanup timer. The payload is `{ by: "local"|"import"|"timeout"; added: string[];
 *     updated: string[]; removed: string[] }` — KEYS ONLY, never values. So the adapter reads the blob
 *     with `store.get(key)` INSIDE the callback; `get` returns the just-applied CONVERGED value (the LWW
 *     winner — verified: get() inside the callback returns v10/v20/v30 as each applies). `by` maps to the
 *     three design events: `local` = own set/delete echo, `import` = a peer's `apply`, `timeout` = TTL.
 *     `subscribeLocalUpdates(fn)` fires SYNCHRONOUSLY on every local `set`/`delete` with the incremental
 *     wire bytes — used ONLY to capture delete tombstones (finding 5).
 *
 *  2. PER-KEY LWW IS COARSE WALL-CLOCK, AND E5 HOLDS NATIVELY IF YOU KEY OFF THE EVENT ARRAYS.
 *     Conflict resolution is timestamp-LWW per key on a MILLISECOND wall clock (no lamport counter — a
 *     three-version in-ORDER replay of blobs all set within one ms keeps the FIRST, proving there is no
 *     per-op tiebreak). Consequences, each probe-pinned:
 *       - STALE DROP (the E5 contract, design §15.6): apply a newer blob then a stale older one → the
 *         stale `apply` yields EMPTY added/updated/removed arrays, so keying surfaced events off those
 *         arrays surfaces NOTHING for the stale blob; and `get` returns the winner regardless. So the
 *         adapter needs NO own last-applied filter — loro's arrays already reflect only real changes.
 *         (Idempotent re-apply of an identical buffer is likewise an empty-array event → nothing surfaced.)
 *       - SAME-MS TIES ARE FIRST-APPLIED-WINS, NOT LAST-SET-WINS. Two blobs of ONE key encoded within
 *         the same ms carry equal timestamps; the later-applied one is a no-op. So encoding the SAME key
 *         twice in one ms is unsafe (the newer value can be lost on in-order delivery). The adapter
 *         defends by RE-STAMPING at send time (the scratch `encodeAll`, finding 3): send-order becomes
 *         timestamp-order, and the store's throttle (≥ throttleMs, ≥ 1ms; design default 16ms) guarantees
 *         two distinct-value sends of any key are ≥ 1ms apart → distinct timestamps → out-of-order
 *         delivery resolves correctly. LOAD-BEARING for M2: throttleMs and the keepalive interval MUST
 *         stay ≥ ~1ms (trivially true at the design defaults). CORRECTION (P4-R): the throttle is not the
 *         only sender — the KEEPALIVE (`encodeKeys`) is a second one on its own clock, so the ≥1ms floor
 *         alone does NOT bound the gap between a throttle send and a keepalive send of the SAME key. A
 *         key mid-change is dirty AND about to ride the change path; a same-ms keepalive copy carrying the
 *         OLD value could tie and win (first-applied-wins). So `encodeKeys` (keepalive) SKIPS currently-
 *         dirty keys — they ship (fresh-stamped) via the change path only; the keepalive re-stamps solely
 *         idle keys, which by definition have no competing in-flight change.
 *       - CROSS-PEER SAME-KEY CONTENTION DOES NOT CONVERGE (two stores writing one key diverge by
 *         apply-order on a tie). This is UNREACHABLE under writer-partitioning (every key has exactly one
 *         writer, design §15.1) — and is precisely WHY partitioning is load-bearing, not an optimization.
 *         A non-Loro `EphemeralSource`, or a raw caller minting non-peer-unique keys, breaks E5 silently.
 *
 *  3. ENCODING GRANULARITY: `encode(key)` = one key's present state; `encodeAll()` = all present keys;
 *     there is NO native subset encode and NO native `encodeChanged` (`subscribeLocalUpdates` is push,
 *     not a pull). CRUCIALLY, `apply(bytes)` consumes EXACTLY ONE framed message — concatenating two
 *     encoded buffers and applying once keeps only the FIRST (verified for BOTH `encode` and incremental
 *     update buffers). So a chosen-subset buffer cannot be assembled by concatenation. The adapter builds
 *     it via a THROWAWAY scratch `EphemeralStore`: `set` each chosen key's current value into it,
 *     `encodeAll()`, `destroy()`. The scratch's `set` RE-STAMPS with a fresh timestamp — which is exactly
 *     what the keepalive needs (finding 4). `destroy()` is MANDATORY: `set` starts a `setInterval`
 *     (finding 4), so an undestroyed scratch leaks a timer. Cost: one wasm alloc per encode call — fine
 *     at presence scale (a few keys per throttle window); poolable later if a hot path ever needs it.
 *
 *  4. TTL/TIMEOUT: the JS wrapper runs `setInterval(removeOutdated, timeout/2)` while non-empty;
 *     `removeOutdated` fires `by:"timeout"` with `removed:[expired…]` (empty-`removed` cleanup ticks also
 *     fire — IGNORE them by keying off the `removed` array). Timeout fires on the OWNER too: an owner's
 *     OWN key self-expires if not refreshed. And `encode`/`encodeAll` ship the SET-TIME (frozen)
 *     timestamp, so re-encoding a key WITHOUT re-setting does NOT refresh a receiver's TTL (verified:
 *     receiver expired). To refresh, you MUST re-`set` (which re-stamps; a re-set of an IDENTICAL value
 *     still refreshes and fires a `local` event). Therefore the keepalive (`encodeKeys`) re-`set`s each
 *     chosen key on the REAL store (keeping the owner's own key alive) AND ships a fresh-stamped scratch
 *     buffer (refreshing receivers). A re-`set` refresh re-emits a same-value `updated` event on
 *     receivers every keepalive — the store's blob-diff must no-op on an unchanged blob (cheap).
 *
 *  5. DELETE CROSSES THE WIRE ONLY AS AN INCREMENTAL TOMBSTONE, NEVER VIA encode/encodeAll (which
 *     snapshot PRESENT state — a deleted key is simply absent, so a state buffer can't remove it). The
 *     tombstone is the `subscribeLocalUpdates` buffer emitted synchronously at `delete()`; the adapter
 *     captures it (transient sub/unsub) into a pending list that `encodeDeletes` drains. A remote delete
 *     arrives as `by:"import"` `removed:[key]` (distinct from `by:"timeout"`); the adapter folds BOTH to
 *     the `timeout` event (design §15.3: a remote delete and a TTL timeout both mean despawn). BEST-EFFORT
 *     ONLY: a delete whose tombstone shares the same wall-clock ms as the key's last `set` LWW-ties and is
 *     DROPPED on receivers (30/30 in the spike) — so an explicit leave shortens despawn latency but the
 *     GUARANTEED despawn is always TTL `timeout` (design §15.3). A set→delete→set of one key in one window
 *     ships both a state buffer and a now-stale tombstone; the tombstone's older timestamp loses LWW to
 *     the re-set, so the net effect is correct (key present) — benign.
 *
 *  6. VALUES: `NaN`, `Infinity`, `-Infinity`, nested objects and arrays round-trip through a blob (both
 *     nested-in-object and direct); `-0` normalizes to `+0` on readback (irrelevant — the store's
 *     `cellEquals` unifies `NaN` and collapses `±0`). `store.get` returns a FRESH object each call (never
 *     reference-equal to what was set) — never rely on identity.
 * ============================================================================================
 *
 * WHAT THIS FILE IS NOT: not the `EphemeralStore` (the Entity-level Mutator, M1), not `attachEphemeral`
 * / inbound projection / the timers / status (M2), not the public `@vibecook/strata-ecs/ephemeral` barrel (M3 —
 * `src/ephemeral/index.ts` keeps throwing until then). It is the medium adapter: it moves blobs and
 * reports the three events, and makes no apply/skip/partition decision.
 */

import { EphemeralStore } from "loro-crdt";
import type { Value } from "loro-crdt";
import { type EntityKey, entityKey } from "../core/field";
import type { Unsubscribe } from "../substrate";
import type { EphemeralBlob, EphemeralEvent, EphemeralSource } from "./types";

/**
 * A throwaway scratch store's inactivity timeout. Irrelevant to correctness (the scratch is `set` then
 * `encodeAll`'d then `destroy()`'d synchronously, long before any cleanup tick), but large so the
 * `setInterval(timeout/2)` a `set` schedules is far in the future — `destroy()` clears it either way.
 */
const SCRATCH_TTL_MS = 2 ** 30;

/**
 * `LoroEphemeralSnapshot` — an `EphemeralSource` over one Loro `EphemeralStore`.
 *
 * Blobs are staged/read directly on the store (immediately visible to `get`); the three events are
 * derived synchronously from `store.subscribe` (finding 1) and fanned out to the adapter's own listener
 * set. Outbound subset buffers are built from throwaway scratch stores (finding 3); deletes are captured
 * as tombstones (finding 5). Per-key LWW ordering (E5) is guaranteed by Loro natively (finding 2) — the
 * adapter surfaces `remote` events only for keys in the event's added/updated arrays, so a stale blob is
 * never surfaced, and it never keeps its own last-applied cache.
 */
export class LoroEphemeralSnapshot implements EphemeralSource {
  private readonly source: EphemeralStore;
  /** Keys dirtied by `set` since the last `encodeChanged` — the throttle path's coalesce set (finding 3). */
  private readonly dirty = new Set<string>();
  /** Captured delete tombstones awaiting `encodeDeletes` (finding 5); each is one framed loro message. */
  private pendingDeletes: Uint8Array[] = [];
  /** Our own listeners (fan-out of the single `source.subscribe`). Copy-on-iterate so a mid-emit unsub is safe. */
  private readonly listeners = new Set<(ev: EphemeralEvent) => void>();
  /** The single `source.subscribe` handle, released by {@link dispose}. */
  private readonly sourceUnsub: Unsubscribe;

  constructor(source: EphemeralStore) {
    this.source = source;
    // ONE subscription to the backing store; every adapter event is a translation of these (finding 1).
    this.sourceUnsub = source.subscribe((ev) => this.onSourceEvent(ev));
  }

  // --- writes (this peer's partition; ownership is enforced ABOVE, in the store) --------------------

  set(key: EntityKey, value: EphemeralBlob): void {
    this.source.set(key, value as Value); // loro quarantined here — the blob is opaque app data
    this.dirty.add(key);
  }

  /**
   * Explicit removal (best-effort leave, finding 5). Captures the tombstone the local-update stream
   * emits SYNCHRONOUSLY (finding 1) so `encodeDeletes` can ship it — `encode`/`encodeAll` cannot carry a
   * removal. Un-dirties the key so a same-window set-then-delete does not also encode it as a live value.
   *
   * PRESENCE GUARD (fix 6): loro `delete` of an ABSENT key still emits a BLIND incremental tombstone (the
   * prior comment claiming "no-op → no tombstone" was false). Shipping that useless removal is pure waste,
   * so skip the whole capture when the key is not present — un-dirty and return.
   */
  delete(key: EntityKey): void {
    this.dirty.delete(key);
    if (this.source.get(key) === undefined) return; // absent → loro would emit a blind tombstone; skip it
    let tombstone: Uint8Array | undefined;
    const capture = this.source.subscribeLocalUpdates((bytes) => {
      tombstone = bytes;
    });
    this.source.delete(key); // fires the local-update (tombstone) AND the `by:"local"` removed event, synchronously
    capture();
    if (tombstone !== undefined) this.pendingDeletes.push(tombstone);
  }

  // --- outbound encoders (the store's timers call these; the adapter owns NO timer) -----------------

  /** THROTTLE path: one re-stamped buffer of the current value of every set-dirtied key, or null if clean. */
  encodeChanged(): Uint8Array | null {
    if (this.dirty.size === 0) return null;
    const keys = [...this.dirty];
    this.dirty.clear();
    return this.encodeSubset(keys, false); // false: keys are freshly set → no REAL-store re-stamp needed
  }

  /**
   * KEEPALIVE path: one re-stamped buffer of the current value of exactly the given still-present keys,
   * or null if none are present. Re-`set`s each on the REAL store too, so the owner's own idle keys never
   * self-expire (finding 4). The caller passes only keys this session MINTED (006 B5).
   */
  encodeKeys(keys: readonly EntityKey[]): Uint8Array | null {
    return this.encodeSubset(keys, true); // true: refresh the REAL store (keepalive keeps the owner alive)
  }

  /** Drain and clear the captured delete tombstones (finding 5). Send each element individually. */
  encodeDeletes(): Uint8Array[] {
    if (this.pendingDeletes.length === 0) return [];
    const out = this.pendingDeletes;
    this.pendingDeletes = [];
    return out;
  }

  // --- inbound --------------------------------------------------------------------------------------

  /**
   * Apply a peer's buffer. `source.subscribe` fires `by:"import"` SYNCHRONOUSLY (finding 1), so any
   * `remote`/`timeout` events are delivered to listeners before this returns; the store's listener
   * ENQUEUES (never applies) per the Part III discipline. A stale (older-timestamp) blob yields empty
   * event arrays → nothing surfaced (finding 2, the E5 contract).
   */
  apply(bytes: Uint8Array): void {
    this.source.apply(bytes);
  }

  subscribe(fn: (ev: EphemeralEvent) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Debug/observability read-all (NOT a sync path): loro's `getAllStates()` is a TTL-pruned point-in-time
   * snapshot of every present key's blob — this peer's own included. The values are loro `Value`s, cast to
   * `EphemeralBlob` (opaque app data, as everywhere here); nothing in encode/apply consults this.
   */
  debugEntries(): Record<string, EphemeralBlob> {
    return this.source.getAllStates() as Record<string, EphemeralBlob>;
  }

  /**
   * Adapter-level (NOT on `EphemeralSource`): release the backing `source.subscribe` handle. M2's detach
   * calls it so a torn-down store stops translating events. Idempotent-safe for the caller to hold.
   */
  dispose(): void {
    this.sourceUnsub();
    this.listeners.clear();
  }

  // --- internals ------------------------------------------------------------------------------------

  /**
   * Build one wire buffer for `keys` via a throwaway scratch store (finding 3 — `apply` reads one framed
   * message, so buffers can't be concatenated; `encodeAll` on a store holding only the subset is the way
   * to a single buffer). Skips keys absent from the real store. When `refreshReal`, also re-`set`s each on
   * the REAL store first — the keepalive's TTL refresh for the owner's own entries (finding 4). Returns
   * null when no chosen key is present. Always `destroy()`s the scratch (its `set` armed a timer).
   */
  private encodeSubset(keys: readonly string[], refreshReal: boolean): Uint8Array | null {
    const scratch = new EphemeralStore(SCRATCH_TTL_MS);
    try {
      let any = false;
      for (const key of keys) {
        // KEEPALIVE (refreshReal) SKIPS currently-dirty keys (fix 6): a dirty key already rides the change
        // path (encodeChanged) with a fresh stamp this same window. Re-emitting it on the keepalive can tie
        // the throttle send within one wall-clock ms carrying the OLD value, and a same-ms LWW tie is
        // first-applied-wins (M0 finding 2) — so the stale keepalive copy could win and strand the receiver.
        // (The change path itself, refreshReal=false, must NOT skip — those keys ARE the change.)
        if (refreshReal && this.dirty.has(key)) continue;
        const v = this.source.get(key);
        if (v === undefined) continue; // deleted / never-present → nothing to encode or refresh
        if (refreshReal) this.source.set(key, v); // re-stamp on the REAL store (keeps the owner alive)
        scratch.set(key, v); // re-stamp on the scratch → the outbound buffer carries a fresh timestamp
        any = true;
      }
      return any ? scratch.encodeAll() : null;
    } finally {
      scratch.destroy(); // MANDATORY: `set` armed a setInterval; destroy clears it (finding 3)
    }
  }

  /**
   * Translate one Loro `EphemeralStore` event into the three design events (finding 1, design §15.3):
   *  - `by:"local"`  → own echo: added/updated → `local` (with value), removed → `local` (delete echo).
   *  - `by:"import"` → a peer: added/updated → `remote` (with value), removed → `timeout` (remote delete
   *                    ≡ despawn, design §15.3).
   *  - `by:"timeout"`→ TTL: removed → `timeout` (added/updated are always empty for a timeout).
   * Keying strictly off the event arrays is what makes the E5 stale-drop native (finding 2): a stale
   * apply carries empty arrays and surfaces nothing.
   */
  private onSourceEvent(ev: { by: "local" | "import" | "timeout"; added: string[]; updated: string[]; removed: string[] }): void {
    if (ev.by === "timeout") {
      for (const key of ev.removed) this.emit({ kind: "timeout", key: entityKey(key) });
      return;
    }
    const setKind = ev.by === "local" ? "local" : "remote";
    for (const key of ev.added) this.emit({ kind: setKind, key: entityKey(key), value: this.getBlob(key) });
    for (const key of ev.updated) this.emit({ kind: setKind, key: entityKey(key), value: this.getBlob(key) });
    // A removed key under `local` is our own delete echo (no value); under `import` it is a remote delete
    // → despawn, folded to `timeout` (design §15.3 treats it identically to a TTL lapse at the projector).
    const removedKind = ev.by === "local" ? "local" : "timeout";
    for (const key of ev.removed) this.emit({ kind: removedKind, key: entityKey(key) });
  }

  /** The blob at `key`, or undefined if absent / not a plain object (a malformed peer value is not leaked). */
  private getBlob(key: string): EphemeralBlob | undefined {
    const v = this.source.get(key);
    if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) return undefined;
    return v as EphemeralBlob;
  }

  private emit(ev: EphemeralEvent): void {
    for (const fn of [...this.listeners]) fn(ev);
  }
}

/**
 * `attachEphemeral(world, eph)` — Part IV **M2** (docs/plan-part4.md; design.md §15.3–§15.6; 006 B5, C7).
 *
 * The ephemeral binding: the one object that holds BOTH a runtime reference (through the {@link Projector})
 * and the inbound-projection state (the `lastSeenBlobByKey` blob-diff cache), because the one piece of logic
 * that needs the wire and the runtime together — projecting a peer's blob into queryable entities — lives
 * here at the seam. It is the ephemeral sibling of `attachDurable`, and it is DELIBERATELY SIMPLER: writer
 * partitioning means no ephemeral cell is ever contended (§15.1), so there is NO baseline, NO reconcile
 * matrix, NO held-cell ledger, NO two-phase relation projection (§15.6). Inbound projection is
 * unconditional per-key blob-diff; own changes never travel this path (Option A applied them synchronously,
 * their echo is a runtime no-op — §15.3).
 *
 * The binding has two faces. The DOWNWARD one (this file wires it) implements {@link InboundSource} — its
 * `drain()` reconciles the source's queued events into the runtime at `world.sync()`. The UPWARD one is the
 * two self-owned outbound timers (change-throttle + keepalive) that hand bytes to the store's `send` sink on
 * their own clock, plus the store's `leave()` — there is no per-frame user call (§15.5).
 *
 * ============================================================================================
 * DECISIONS (load-bearing; see the task brief + the cited spec + the M0 findings in loro-ephemeral-snapshot.ts)
 * ============================================================================================
 *  A. **`attachEphemeral` is a package-level FUNCTION** (the Part III precedent, design.md §15.2's
 *     `world.attachEphemeral` sketch notwithstanding): the core NEVER names an ephemeral type — its only
 *     concession to the layers is `registerInboundSource(InboundSource)` (§16.1). So attach lives here and
 *     reaches the world through that single seam. Ephemeral starts EMPTY — there is NO seed phase (design
 *     §15.6: the store fills from live peers), so attach is lighter than durable's two-phase seed.
 *  B. **One projector, shared.** The binding constructs ONE {@link Projector} over `world.runtime` and uses
 *     it for BOTH inbound projection (this file) AND the store's own mutators — it installs that projector
 *     into M1's runtime seam. So a spawn's own key↔handle pair and a projected remote key live in one
 *     bijection, and detach's `projector.teardown()` despawns BOTH in one pass (the "no ephemeral residue"
 *     rule). No `CountingProjector` (durable's device) is needed: `lastInboundFrame` counts drains-that-
 *     projected, tracked with a boolean in {@link EphemeralBinding.drain}, not per-primitive.
 *  C. **Enqueue-never-apply.** The adapter fires events SYNCHRONOUSLY during `set`/`apply`/the TTL timer
 *     (M0 finding 1). The subscription ENQUEUES them onto {@link EphemeralBinding.pending}; `drain()`
 *     applies. `drain()` DEV-asserts `!inObserverEmit` at entry (the InboundSource obligation, 006 §C2) and
 *     drains the whole queue in ONE synchronous pass — **batch-atomic** (design §15.3: a departed peer's
 *     entities, whose keys share a keepalive timestamp and time out in one Loro tick, despawn TOGETHER; no
 *     render lands mid-burst showing a half-gone peer).
 *  D. **The own-prefix filter (§15.3 / 006 B5).** Own-prefix events are NOT projected — the owner's runtime
 *     is already correct (Option A):
 *       - `local` echoes: ignored (the wire copy going out).
 *       - own-prefix + minted, `remote`: ignored (runtime already correct).
 *       - own-prefix + minted, `timeout`: keepalive lapsed and Loro expired our OWN key (M0 finding 4).
 *         DEV-warn once and RE-STAGE the blob (`eph.restageMinted`) so peers keep seeing our live entity —
 *         do NOT despawn a live local entity.
 *       - own-prefix + NOT minted, `remote`: a crashed prior session's ghost under a REUSED peerId (006 B5).
 *         One-shot "peerId reuse detected" DEV warn; do NOT project, do NOT keepalive (the keepalive re-sends
 *         only MINTED keys, so the ghost simply TTLs out).
 *  E. **The blob-diff runs against `lastSeenBlobByKey`, NEVER runtime reads (§15.6).** The runtime carries
 *     the locally-applied `Local` tag (never in any blob) and anything a local system attached — diffing
 *     against it would strip peer state or leak framework state. The cache holds exactly the CANONICAL
 *     values we last projected, so the diff is blob-against-blob and clean, and a keepalive's same-value
 *     re-set (M0 finding 4) no-ops via `cellEquals` (no reactive fire). NO `Local` is ever applied to a
 *     remote projection — remote entities are ordinary queryables (§15.4).
 *  F. **Two self-owned outbound timers (§15.5), started at attach, stopped at detach.** The change-throttle
 *     (`throttleMs`) ships `encodeChanged()` (coalesced-dirty) AND drains despawn tombstones
 *     (`encodeDeletes()`); the keepalive (`~ttlMs/3` — several-missed-beat headroom, §15.3) ships
 *     `encodeKeys([...mintedKeys])` — own-MINTED keys only (006 B5), which re-stamps the real store (keeps
 *     the owner's own keys alive) AND fresh-stamps for receivers. Both skip a null encode (nothing to send).
 *  G. **`EphemeralSyncStatus`, producer-side set-on-change (006 C7).** `peerCount` = distinct remote peer
 *     prefixes with ≥1 live projected entity; `lastInboundFrame` = a monotonic per-applied-drain counter
 *     (bumps only when a drain projected ≥1 fact). Published at drain end (set-on-change) + once at attach;
 *     removed at detach. (Unlike durable there is no `pendingInbound` field, so there is no enqueue-boundary
 *     publish — no ephemeral field is measured at enqueue.)
 *  H. **Detach releases the adapter via the per-listener UNSUBSCRIBE, not the adapter's `dispose()`.** The
 *     store exposes only the `EphemeralSource` interface (dispose is adapter-level, off the interface by
 *     design), so the binding cannot reach `dispose()` without breaching that boundary. More decisively:
 *     `dispose()` permanently releases the adapter's backing Loro subscription, which would break the
 *     SAME-store re-attach that M1's `clearRuntime` counter-comment explicitly designs for (the counter is
 *     not reset "so a re-attach mints fresh keys"). The per-listener unsubscribe (mirroring durable's
 *     `this.unsubscribe?.()`) stops events reaching a torn-down binding AND leaves the adapter re-
 *     subscribable. Consequence: the adapter keeps translating Loro events into an EMPTY listener set until
 *     the app destroys the Loro store it owns — a cheap no-op. (Flagged for the M3 review gate: this
 *     deviates from the task's literal "call dispose()" for the re-attach-safety reason above.)
 */

import { DEV, devWarn } from "../core/dev";
import type { Component, ComponentId, EntityKey, InboundSource, Tag, World } from "../core";
import {
  Projector,
  cellEquals,
  componentByName,
  isReservedName,
  tagByName,
  tryCanon,
} from "../substrate";
import type { ComponentValue, Unsubscribe } from "../substrate";
import type { EphemeralBlob, EphemeralEvent, EphemeralSource } from "./types";
import type { EphemeralStore } from "./ephemeral-store";
import { EphemeralSyncStatus, type EphemeralSyncStatusValue } from "./sync-status";

/**
 * The detach handle {@link attachEphemeral} returns (design §15.2/§15.6). Mirrors durable's `Attachment` but
 * has NO `baseline` seam — the ephemeral layer keeps no baseline (writer-partitioned → never contended).
 */
export interface Attachment {
  /** Tear the binding down — the four-step teardown (005 §5.6). Idempotent; re-attach is a fresh projection. */
  detach(): void;
}

/**
 * One store ↔ at most one attachment (§13.1's hardened invariant, mirrored for ephemeral). A `WeakSet`
 * keyed by the store, so a detached-then-GC'd store leaves no trace and a re-attach after `detach()` (which
 * deletes the entry) is a fresh, legal projection.
 */
const ATTACHED = new WeakSet<EphemeralStore>();

/** The last CANONICAL blob projected for one remote key — the blob-diff memory (decision E, §15.6). */
interface LastSeen {
  /** Component name → the canonical value we last applied (compared with `cellEquals` to no-op re-sets). */
  readonly components: Map<string, ComponentValue>;
  /** The tag names we last applied. */
  readonly tags: Set<string>;
}

/**
 * Attach `eph` to `world`: install M1's runtime seam (making the store's mutators legal), subscribe to the
 * source (enqueue-never-apply), register the binding as the world's inbound source, and start the two
 * outbound timers. Returns an {@link Attachment} whose `detach()` reverses all of it. Guards at entry mirror
 * `sync()`'s posture, because inbound projection — like a drain — writes structure IMMEDIATELY through the
 * projector:
 * - throws if the world is mid query-iteration or mid-tick (an immediate migration corrupts a live walk —
 *   006 §A4);
 * - DEV-throws inside an observer / reactive emit (the projection primitives are unguarded and would
 *   half-apply — 005 §5.5);
 * - throws on DOUBLE attach.
 */
export function attachEphemeral(world: World, eph: EphemeralStore): Attachment {
  if (ATTACHED.has(eph)) {
    throw new Error("strata: this EphemeralStore is already attached — one store has at most one attachment.");
  }
  if (world.inImmediateProjectionUnsafeContext) {
    throw new Error(
      "strata: attachEphemeral() cannot run during query iteration or a tick — inbound projection writes structure immediately (like a drain), and a mid-iteration migration corrupts the walk; attach at the frame boundary.",
    );
  }
  if (DEV && world.runtime.inObserverEmitActive) {
    throw new Error(
      "strata: attachEphemeral() cannot run from inside an observer or reactive callback — projection half-applies through the mixed in-emit guards; schedule it for the next frame boundary.",
    );
  }

  const binding = new EphemeralBinding(world, eph);
  binding.attach();
  ATTACHED.add(eph);
  return { detach: () => binding.teardown() };
}

/**
 * The binding proper — {@link InboundSource} to the world, blob-diff projector to the ephemeral layer. Holds
 * the projector (runtime side) and the `lastSeenBlobByKey` cache (the blob-diff memory); `drain()` projects
 * the queued source events at `sync()`, batch-atomically.
 */
class EphemeralBinding implements InboundSource {
  private readonly source: EphemeralSource;
  private readonly projector: Projector;
  /** This peer's id — a key is ours iff it parses to the minted shape `${peerId}-<int>` (decision D, fix 5). */
  private readonly peerId: string;

  /** The source events awaiting drain — filled by the subscription (decision C), emptied by `drain()`. */
  private pending: EphemeralEvent[] = [];
  /** The subscription's unsubscribe (teardown step 1); null until `attach`. */
  private unsubscribe: Unsubscribe | null = null;
  /**
   * The blob-diff memory (§15.6, decision E): the last CANONICAL blob projected per REMOTE key. Its keyset
   * IS the live remote projection — `peerCount` is computed from it. Own keys never enter it (own events are
   * filtered before projection).
   */
  private readonly lastSeenBlobByKey = new Map<EntityKey, LastSeen>();
  /** eid-ban memo (005 §7): a ComponentId is here once validated clean; re-checks are skipped. */
  private readonly validatedComponents = new Set<ComponentId>();
  /** eid-ban memo, reject side (fix 4): a ComponentId with an `eid` field — soft-rejected, warned once. */
  private readonly rejectedComponents = new Set<ComponentId>();
  /** One-shot DEV-diagnostic dedupe: `key|comp` canon rejects, `name:<kind>:<name>` unknowns, singletons. */
  private readonly warned = new Set<string>();

  /** The change-throttle timer (decision F) — `null` until `attach`, cleared at detach. */
  private throttleTimer: ReturnType<typeof setInterval> | null = null;
  /** The keepalive timer (decision F). */
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  /** True after teardown — makes `detach()` idempotent and a late `drain()`/timer tick a no-op. */
  private detached = false;

  /**
   * `EphemeralSyncStatus.lastInboundFrame` (006 C7, decision G): a monotonic counter bumped once per drain
   * that projected ≥1 fact — NEVER per-drain, so an idle network (empty drains project nothing) leaves it
   * fixed and the set-on-change gate suppresses the write. Tick-independent by design.
   */
  private lastInboundFrame = 0;
  /** The last {@link EphemeralSyncStatusValue} published — the producer-side set-on-change memo (006 C7). */
  private lastSyncStatus: EphemeralSyncStatusValue | null = null;

  constructor(
    private readonly world: World,
    private readonly eph: EphemeralStore,
  ) {
    this.source = eph.ephemeralSource;
    this.peerId = eph.peerId;
    // ONE projector, shared with the store's mutators via the seam (decision B).
    this.projector = new Projector(world.runtime, () => eph.mintKey());
  }

  /**
   * Wire the binding: install M1's runtime seam, subscribe (enqueue-never-apply), register the downward
   * face, start the timers, publish the initial status. No user code runs during this synchronous setup, so
   * nothing can drain or mutate into a half-built binding. Ephemeral starts EMPTY — no seed (decision A).
   */
  attach(): void {
    this.eph.installRuntime({
      runtime: this.world.runtime,
      projector: this.projector,
      isIterating: () => this.world.inImmediateProjectionUnsafeContext,
      isInEmit: () => this.world.runtime.inObserverEmitActive,
    });
    this.unsubscribe = this.source.subscribe((ev) => {
      if (ev.kind === "local") return; // own echo — Option A already applied it; project() drops it too, but
      // filtering HERE bounds `pending` growth if sync() is never called and shrinks every drain (P4-R).
      this.pending.push(ev); // enqueue-never-apply (decision C) — drain() applies at sync()
    });
    // Ephemeral projection is INDEPENDENT of durable drain order (004 A5's open question): the two layers
    // share no keyspace and no bijection, so registration order among inbound sources is a non-requirement.
    this.world.registerInboundSource(this);
    this.startTimers();
    this.publishSyncStatus(); // initial EphemeralSyncStatus: peerCount 0, lastInboundFrame 0
  }

  // --- the downward face: batch-atomic blob-diff projection (§15.3/§15.6) ----------------------------

  /**
   * Project the pending source events into the runtime (design §15.3). DEV-asserts `!inObserverEmit` at
   * entry (006 §C2 — a drain mid-`notify()` would half-apply through the mixed in-emit guards), then drains
   * the WHOLE queue in one synchronous pass (batch-atomic, decision C): a departed peer's keys — which share
   * a keepalive timestamp and time out together — despawn in the same drain, so no render sees a half-gone
   * peer. Runs from `world.sync()` at the frame boundary (outside iteration, outside any emit), so its
   * structural writes apply IMMEDIATELY (§10.3).
   */
  drain(): void {
    if (this.detached) return;
    if (DEV && this.world.runtime.inObserverEmitActive) {
      throw new Error(
        "strata: ephemeral drain() cannot run from inside an observer or reactive callback — it would half-apply a projection; drain at the frame boundary.",
      );
    }
    const pending = this.pending;
    this.pending = []; // events enqueued DURING this drain (e.g. from restageMinted's re-set) defer to next
    let projected = false;
    for (const ev of pending) {
      if (this.project(ev)) projected = true;
    }
    // lastInboundFrame advances ONLY when this drain projected ≥1 fact (006 C7) — an idle/own-only drain
    // moves nothing, so the set-on-change gate writes no stamp and no useResource panel re-renders.
    if (projected) this.lastInboundFrame++;
    this.publishSyncStatus();
  }

  /** Route one event by origin (§15.3). Returns whether it projected ≥1 runtime fact (drives `lastInboundFrame`). */
  private project(ev: EphemeralEvent): boolean {
    const { kind, key } = ev;
    if (kind === "local") return false; // own echo — Option A already applied it (also filtered at enqueue)
    if (this.isOwnKey(key)) return this.projectOwnPrefix(kind, key); // own-partition remote/timeout (fix 5)
    // A remote peer's key.
    if (kind === "remote") return this.projectRemoteSet(key, ev.value);
    return this.projectRemoteRemove(key); // kind === "timeout" (TTL lapse OR a remote delete, folded — §15.3)
  }

  /**
   * An own-prefix `remote`/`timeout` event (decision D). Never projected — the owner's runtime is already
   * correct. The only actions are the two hygiene paths: revive an own key that self-expired (keepalive
   * lapse), and the peerId-reuse warning.
   */
  private projectOwnPrefix(kind: "remote" | "timeout", key: EntityKey): boolean {
    if (this.eph.mintedKeys.has(key)) {
      if (kind === "timeout") {
        // Keepalive lapsed and Loro expired our OWN live key (M0 finding 4). Do NOT despawn — re-stage the
        // blob so peers keep seeing our still-live entity (the next throttle re-broadcasts it).
        this.warnOnce("own-timeout", () =>
          "an own ephemeral key expired via TTL (its keepalive lapsed) — the entity is kept alive locally and re-broadcast; check that the keepalive timer is running (§15.3).",
        );
        this.eph.restageMinted(key);
      }
      // own-prefix + minted + `remote`: our own set echoed via the import path — runtime already correct.
      return false;
    }
    // Own-prefix key this session did NOT mint = a crashed prior session's ghost under a reused peerId.
    if (kind === "remote") {
      this.warnOnce("peerid-reuse", () =>
        "peerId reuse detected — an own-prefix ephemeral key arrived from a peer that this session did not mint. The peerId MUST be session-unique (crypto.randomUUID()); a stable id makes crashed-session ghosts permanent. This key is NOT projected and NOT kept alive — it will TTL out (006 B5).",
      );
    }
    // Never project it, never keepalive it — it simply times out on its own.
    return false;
  }

  /**
   * A remote peer's `set` (§15.3/§15.6): spawn (unseen key) or blob-diff (seen key). NO `Local` is ever
   * applied (remote entities are ordinary queryables, §15.4). A malformed blob (the adapter could not read a
   * plain object) is skipped with a one-shot warn.
   */
  private projectRemoteSet(key: EntityKey, blob: EphemeralBlob | undefined): boolean {
    if (blob === undefined) {
      this.warnCanonReject("blob", "(blob)", "(value)", "not a plain object"); // bounded dedupe (fix 6)
      return false;
    }
    const comps = readBlobComponents(blob);
    const tags = readBlobTags(blob);
    const seen = this.lastSeenBlobByKey.get(key);
    return seen === undefined ? this.projectUnseen(key, comps, tags) : this.projectSeen(key, seen, comps, tags);
  }

  /**
   * First `remote` `set` for a key (§15.3): spawn a local entity, place it (so a componentless blob is still
   * queryable), write its components (tryCanon-gated) and tags, and cache the CANONICAL blob. The projector's
   * `resolveByKey` mints a fresh LOCAL handle for the remote key and binds it (§15.3 — the handle is
   * per-runtime, the key is the shared identity). Placing the entity is itself a projected fact, so an empty
   * blob still counts (the entity becomes queryable).
   */
  private projectUnseen(key: EntityKey, comps: Record<string, ComponentValue>, tags: string[]): boolean {
    this.projector.applySpawn(key); // ensurePlaced — the entity is queryable even if componentless/tagless
    const seen: LastSeen = { components: new Map(), tags: new Set() };
    for (const [name, raw] of Object.entries(comps)) {
      const fact = this.canonInbound(name, raw); // NEVER throws — hostile facts are skipped (fixes 3/4)
      if (fact === null) continue;
      this.projector.applyComponent(key, fact.comp, fact.value);
      seen.components.set(name, fact.value);
    }
    for (const name of tags) {
      const tag = this.resolveInboundTag(name); // null skips unknown/reserved tags (fix 2)
      if (tag === null) continue;
      this.projector.applyTag(key, tag);
      seen.tags.add(name);
    }
    // Record the cache entry UNCONDITIONALLY, even if every fact was rejected (fix 3c): the empty `seen`
    // still tracks the key, so its eventual TTL `timeout`/remote-delete despawns the placed entity via
    // projectRemoteRemove — a fully-rejected blob leaves a queryable-empty entity that TTLs out, never a
    // permanent orphan. (This is reachable now that canonInbound cannot throw before this line.)
    this.lastSeenBlobByKey.set(key, seen);
    return true;
  }

  /**
   * A `remote` `set` on a SEEN key — the blob-diff (§15.6, decision E). Diffs the new blob against the cache
   * (never runtime reads): remove components/tags present in the cache but absent now; write changed/added
   * components (a `cellEquals` match against the cached canonical value NO-OPS the keepalive's same-value
   * re-set, so it fires no reactive change — the load-bearing cheapness of decision E); add new tags. The
   * cache is updated in place. A malformed value leaves the prior projection standing (inbound reject, §2.3);
   * an unknown name is skipped.
   */
  private projectSeen(key: EntityKey, seen: LastSeen, comps: Record<string, ComponentValue>, tags: string[]): boolean {
    let projected = false;

    // The whole path is TOTAL — no step throws (fixes 3/4): canonInbound skips a hostile fact, tryCanon is
    // root-guarded, the inbound eid ban soft-rejects. So the removals (steps 1–2) can never be stranded
    // half-applied by a later throw the way the DEV eid-throw once did (the review's half-apply finding).

    // 1. Components that vanished from the blob → remove them from the projection (§15.6 dynamic components).
    for (const name of [...seen.components.keys()]) {
      if (Object.prototype.hasOwnProperty.call(comps, name)) continue;
      const comp = componentByName(name);
      if (comp !== undefined) {
        this.projector.removeComponent(key, comp);
        projected = true;
      }
      seen.components.delete(name);
    }
    // 2. Tags that vanished → remove (seen.tags never holds a reserved tag — fix 2 never added one).
    for (const name of [...seen.tags]) {
      if (tags.includes(name)) continue;
      const tag = tagByName(name);
      if (tag !== undefined) {
        this.projector.removeTag(key, tag);
        projected = true;
      }
      seen.tags.delete(name);
    }
    // 3. Present components → write changed/added, no-op unchanged (the same-value keepalive re-set).
    for (const [name, raw] of Object.entries(comps)) {
      const fact = this.canonInbound(name, raw); // NEVER throws — hostile facts are skipped (fixes 3/4)
      if (fact === null) continue;
      const prev = seen.components.get(name);
      if (prev !== undefined && cellEquals(fact.value, prev)) continue; // unchanged → no runtime write, no fire
      this.projector.applyComponent(key, fact.comp, fact.value);
      seen.components.set(name, fact.value);
      projected = true;
    }
    // 4. Present tags → add the new ones (an already-present tag is left alone → no spurious reactive fire).
    for (const name of tags) {
      if (seen.tags.has(name)) continue;
      const tag = this.resolveInboundTag(name); // null skips unknown/reserved tags (fix 2)
      if (tag === null) continue;
      this.projector.applyTag(key, tag);
      seen.tags.add(name);
      projected = true;
    }
    return projected;
  }

  /**
   * A remote `timeout` (§15.3): TTL lapse OR a remote delete (the adapter folds both — both mean despawn).
   * Despawn the local entity and evict the cache. A key we never projected (no cache entry) is a no-op — a
   * tombstone/timeout for an entity we never saw (e.g. spawned-and-left before we ever received its `set`).
   */
  private projectRemoteRemove(key: EntityKey): boolean {
    if (!this.lastSeenBlobByKey.has(key)) return false;
    this.projector.remove(key); // despawn the local runtime entity + unbind the key↔handle pair
    this.lastSeenBlobByKey.delete(key);
    return true;
  }

  // --- the upward face: the two self-owned outbound timers (§15.5, decision F) -----------------------

  /**
   * Start the change-throttle and keepalive timers (design §15.5). Both are self-owned (no per-frame user
   * call) and run on the macrotask queue, outside any synchronous drain/tick, so they only READ the source
   * and call `send` — never mutate the runtime. Sized off the store's validated `throttleMs`/`ttlMs`.
   */
  private startTimers(): void {
    const keepaliveMs = Math.max(1, Math.floor(this.eph.ttlMs / 3)); // ~ttlMs/3 — several-missed-beat headroom (§15.3)
    this.throttleTimer = setInterval(() => this.throttleTick(), this.eph.throttleMs);
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), keepaliveMs);
  }

  /**
   * The change-throttle tick (§15.5): ship the latest dirty entities (Loro coalesces to latest-per-key
   * natively) AND drain any despawn tombstones (`encodeDeletes`, so a plain `eph.despawn` propagates
   * promptly, not only via TTL). Skips a null change encode (nothing dirty).
   */
  private throttleTick(): void {
    if (this.detached) return;
    const changed = this.source.encodeChanged();
    if (changed !== null) this.eph.send(changed);
    for (const buf of this.source.encodeDeletes()) this.eph.send(buf); // best-effort despawn tombstones (§15.3)
  }

  /**
   * The keepalive tick (§15.3/§15.5): re-send OUR partition's current entries — own-MINTED keys ONLY (006
   * B5; the store's `mintedKeys` already excludes despawned keys). `encodeKeys` re-`set`s each on the REAL
   * store (keeping the owner's own idle keys from self-expiring, M0 finding 4) and ships a fresh-stamped
   * buffer (refreshing receivers). Skips a null encode (no minted key present).
   */
  private keepaliveTick(): void {
    if (this.detached) return;
    const bytes = this.source.encodeKeys([...this.eph.mintedKeys]);
    if (bytes !== null) this.eph.send(bytes);
  }

  // --- the sync-status resource (006 C7, decision G) ------------------------------------------------

  /**
   * Publish {@link EphemeralSyncStatus} with PRODUCER-SIDE SET-ON-CHANGE (006 C7): `peerCount` = distinct
   * remote peer prefixes with a live projection, `lastInboundFrame` = the applied-drain counter. Compare
   * against the last value set and SKIP `setResource` when nothing moved — so an idle network (drains that
   * project nothing) produces ZERO re-renders. Called at drain end and once at attach. (No enqueue-boundary
   * publish: unlike durable there is no `pendingInbound` field, so nothing is measured at enqueue.)
   */
  private publishSyncStatus(): void {
    const next: EphemeralSyncStatusValue = {
      peerCount: this.countRemotePeers(),
      lastInboundFrame: this.lastInboundFrame,
    };
    const prev = this.lastSyncStatus;
    if (prev !== null && prev.peerCount === next.peerCount && prev.lastInboundFrame === next.lastInboundFrame) {
      return; // set-on-change: nothing moved → no setResource → no stamp → no re-render (006 C7)
    }
    this.lastSyncStatus = next;
    this.world.setResource(EphemeralSyncStatus, next); // runtime-local — never transmitted (006 C7)
  }

  /**
   * Distinct remote peer prefixes with ≥1 live projected entity (006 C7). Derived from the blob-diff cache's
   * keys (its keyset IS the live remote projection — own keys never enter it). Uses the ONE shared parser
   * {@link parseMintedKey}, anchored to the minted shape `${peerId}-<int>`, so a forged key that does not
   * match the shape (no hyphen, trailing hyphen, non-integer suffix) buckets under its whole string rather
   * than skewing the count with a fabricated sub-prefix (fix 5). Cheap at presence scale (a few peers).
   */
  private countRemotePeers(): number {
    const prefixes = new Set<string>();
    for (const key of this.lastSeenBlobByKey.keys()) prefixes.add(parseMintedKey(key).peer);
    return prefixes.size;
  }

  /**
   * Whether `key` is one of OUR partition's keys, anchored to the minted shape (fix 5): it must parse to
   * `${peerId}-<int>` AND its peer prefix must EQUAL this peer's id exactly. A prefix `startsWith` test
   * (the prior router) wrongly claimed a legitimate peer named `${myPeerId}-x` (its keys `${myPeerId}-x-0`
   * start with `${myPeerId}-`), silently suppressing it; the exact-match + integer-suffix anchor routes only
   * genuinely-own keys to {@link projectOwnPrefix}, and a forged `${myPeerId}-<int>` this session did not
   * mint still lands there and is refused as a reused-peerId ghost.
   */
  private isOwnKey(key: EntityKey): boolean {
    const parsed = parseMintedKey(key);
    return parsed.minted && parsed.peer === this.peerId;
  }

  // --- teardown: the four steps, IN ORDER (005 §5.6) ------------------------------------------------

  /**
   * Detach — the four-step teardown (§5.6), so no queued-but-undrained event projects into a torn-down
   * binding and the world holds NO ephemeral residue. Idempotent. Re-attaching the store afterward is a
   * FRESH projection with FRESH handles (the counter continues, so new keys never collide an in-flight prior
   * key — M1's clearRuntime contract).
   */
  teardown(): void {
    if (this.detached) return;
    this.detached = true;
    this.world.unregisterInboundSource(this); // 0. stop world.sync() from ever draining us again
    this.unsubscribe?.(); // 1. stop new source events arriving (per-listener unsubscribe — decision H)
    if (this.throttleTimer !== null) clearInterval(this.throttleTimer); // stop both outbound timers — no sends after
    if (this.keepaliveTimer !== null) clearInterval(this.keepaliveTimer);
    this.throttleTimer = null;
    this.keepaliveTimer = null;
    // Purge OUR own keys from the source WITHOUT broadcasting (fix 1) — detach ≠ leave. Left in place, the
    // adapter's `dirty`/`pendingDeletes` and the backing store's own keys survive; a same-store re-attach
    // then re-broadcasts a despawned entity as a phantom on every peer. `delete` removes each blob and
    // un-dirties it; draining `encodeDeletes` DISCARDS the just-captured tombstones so nothing ships on a
    // later re-attach. Remote-applied keys are NOT touched (they are not minted) — they TTL out on their own.
    for (const key of [...this.eph.mintedKeys]) this.source.delete(key);
    this.source.encodeDeletes(); // drain + discard: detach broadcasts nothing
    this.pending = []; // 2. discard queued-but-undrained events ...
    this.lastSeenBlobByKey.clear(); // ... and the blob-diff cache
    this.projector.teardown(); // 3. despawn EVERY projected entity — remote AND own — + clear the bijection
    this.eph.clearRuntime(); // clear the store's seam + partition state (mutators throw again; minted/ownEntities emptied)
    this.world.removeResource(EphemeralSyncStatus); // runtime-local status is gone once detached (useResource → undefined)
    ATTACHED.delete(this.eph); // mark re-attachable
  }

  // --- inbound fact validation (hostile-proof: NOTHING a peer sends escapes sync()) -----------------

  /**
   * Validate ONE inbound component fact against the schema (fixes 3a/3b/4). Returns the resolved component +
   * its canonical value, or null (skip, one-shot DEV warn) for: an unknown name; a value that is not a plain
   * object (which would throw `hasOwnProperty` inside tryCanon — fix 3a, checked BEFORE the eid ban/tryCanon);
   * a component declaring an `eid` field (a wire eid is a meaningless packed handle — SOFT-rejected inbound,
   * fix 4, unlike the store's own-mutation DEV-throw); or a per-field tryCanon reject. NEVER throws.
   */
  private canonInbound(name: string, raw: unknown): { comp: Component; value: ComponentValue } | null {
    const comp = componentByName(name);
    if (comp === undefined) {
      this.warnUnknownName("component", name);
      return null;
    }
    if (!isPlainObject(raw)) {
      this.warnCanonReject(`comp:${comp.id}`, name, "(value)", "not a plain object");
      return null;
    }
    if (!this.inboundComponentAllowed(comp)) return null; // eid field → soft reject (fix 4)
    const gate = tryCanon(comp, raw as ComponentValue);
    if (!gate.ok) {
      this.warnCanonReject(`comp:${comp.id}:${gate.field}`, name, gate.field, gate.reason);
      return null;
    }
    return { comp, value: gate.value };
  }

  /**
   * Resolve ONE inbound tag name to its handle, or null (skip). Skips an unknown tag (one-shot warn) and —
   * the reserved-tag FIREWALL (fix 2) — ANY framework-reserved tag (e.g. `Local`): a forged blob carrying
   * `tags:["Local"]` would apply Local to a REMOTE projection, silently breaking `Not(Local)` presence
   * queries cross-peer. Reserved tags are computed locally per peer and never wire-borne (§15.4), so any
   * reserved name is dropped, warned once. Never throws.
   */
  private resolveInboundTag(name: string): Tag | null {
    const tag = tagByName(name);
    if (tag === undefined) {
      this.warnUnknownName("tag", name);
      return null;
    }
    if (isReservedName(name)) {
      this.warnOnce(`reserved-tag:${name}`, () =>
        `inbound ephemeral blob carries the framework-reserved tag "${name}" — skipped; reserved tags are computed locally per peer, never transmitted (§15.4, 006 §B5).`,
      );
      return null;
    }
    return tag;
  }

  /**
   * Whether an inbound `comp` is safe to project — false (skip) if it declares an `eid` field (005 §7): a
   * wire eid is a packed runtime handle, meaningless in our runtime. INBOUND is a SOFT reject (fix 4): a
   * remote peer must never throw out of `world.sync()`, so — unlike the store's own-mutation ban, which
   * keeps its DEV throw — this warns once and skips, in ALL builds (never projecting a meaningless eid).
   * Memoized per ComponentId on BOTH sides (validated-clean / rejected), so the scan and the warn each
   * happen once.
   */
  private inboundComponentAllowed(comp: Component): boolean {
    if (this.validatedComponents.has(comp.id)) return true;
    if (this.rejectedComponents.has(comp.id)) return false;
    for (const f of comp.fields) {
      if (f.spec.type === "eid") {
        this.rejectedComponents.add(comp.id);
        this.warnOnce(`eid:${comp.id}`, () =>
          `inbound ephemeral component "${comp.name}" declares an eid field "${f.name}" — a packed runtime handle is meaningless across the wire; the component is skipped. Reference entities with a key field instead (005 §7).`,
        );
        return false;
      }
    }
    this.validatedComponents.add(comp.id);
    return true;
  }

  // --- diagnostics (DEV-only; the dedupe set is DEV-gated and keyed by a BOUNDED id, never per-remote-key) --

  /**
   * One-shot DEV warn per rejected inbound value (005 §2.3 / 006 B4): a malformed fact touched nothing. The
   * dedupe key is BOUNDED (a component/reason id or a constant, NOT the remote entity key — fix 6), and the
   * `.add` is DEV-gated, so production (which never warns) never grows the set.
   */
  private warnCanonReject(dedupe: string, name: string, field: string, reason: string): void {
    if (!DEV || this.warned.has(dedupe)) return;
    this.warned.add(dedupe);
    devWarn(
      `inbound ephemeral value for "${name}" field "${field}" rejected (${reason}) — dropped, leaving the prior projection standing.`,
    );
  }

  /**
   * One-shot DEV diagnostic per unresolved name kind (006 B3 R1) — skipped, never projected. Bucketed PER
   * KIND (not per name), so a hostile peer streaming distinct unknown names cannot grow the set (fix 6); the
   * `.add` is DEV-gated too. The first unknown component (and the first unknown tag) is named in the message.
   */
  private warnUnknownName(kind: string, name: string): void {
    const dedupe = `unknown:${kind}`;
    if (!DEV || this.warned.has(dedupe)) return;
    this.warned.add(dedupe);
    devWarn(`inbound ephemeral blob names an unknown ${kind} "${name}" — skipped (no schema object resolves it).`);
  }

  /**
   * A one-shot DEV warning keyed by `tag` (peerId-reuse, own-timeout, reserved-tag, eid) — the message is
   * lazy (DEV-only) and the `.add` is DEV-gated so production never grows the set (fix 6). Every `tag` key is
   * BOUNDED (a constant, or a schema/reserved id), never per-remote-key.
   */
  private warnOnce(tag: string, message: () => string): void {
    if (!DEV || this.warned.has(tag)) return;
    this.warned.add(tag);
    devWarn(message());
  }
}

/** A non-null plain object (not an array, not a typed array) — the shape a component value must have (fix 3a). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
}

/** The minted key shape — `${peerId}-<counter>`, counter a non-negative integer (greedy prefix, digits end). */
const MINTED_KEY = /^(.*)-(\d+)$/;

/**
 * The ONE parser both the own-partition router ({@link EphemeralBinding.isOwnKey}) and the peer-count
 * ({@link EphemeralBinding.countRemotePeers}) derive from (fix 5). Anchored to the minted shape
 * `${peerId}-<int>`: `peer` is the key minus a trailing `-<integer>`, `minted` says it matched. A key that
 * does NOT match (no hyphen, a trailing hyphen, a non-integer suffix) buckets under its WHOLE string with
 * `minted:false` — never misrouted into a partition, never a fabricated sub-prefix. Hostile strings pass
 * through safely: "nohyphen"/"peer-"/"alice-9-" → whole-string bucket; "mallory-9-0" → peer "mallory-9".
 */
function parseMintedKey(key: string): { peer: string; minted: boolean } {
  const m = MINTED_KEY.exec(key);
  return m === null ? { peer: key, minted: false } : { peer: m[1], minted: true };
}

/** Read a blob's `components` record defensively (a hostile peer value is not a plain object). */
function readBlobComponents(blob: EphemeralBlob): Record<string, ComponentValue> {
  const c = (blob as { components?: unknown }).components;
  return c !== null && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, ComponentValue>) : {};
}

/** Read a blob's `tags` list defensively (drop any non-string element). */
function readBlobTags(blob: EphemeralBlob): string[] {
  const t = (blob as { tags?: unknown }).tags;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

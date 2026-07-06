/**
 * `createEphemeralStore(source, opts)` + `EphemeralStore` — Part IV **M1** (docs/plan-part4.md).
 *
 * The `EphemeralStore` is the ephemeral layer's public object: the **writer-partitioned Mutator** app code
 * holds to spawn and mutate its OWN presence/transient entities (cursors, selections, live previews). It is
 * the sibling of `DurableStore` — the same flat-entity vocabulary (spawn/despawn, add/remove component,
 * value writes, tags) — with the two things that make durable hard simply ABSENT: no relations, no
 * resources (design §15.6), and no reconcile baseline (writer partitioning means no ephemeral cell is ever
 * contended, so there is nothing to reconcile — §15.1).
 *
 * M1 SCOPE (what this milestone ships; the rest is stubbed at its seam):
 *   - **Key minting** (§15.3): peer-prefixed `${peerId}-<counter>`, counter from 0 — ephemeral starts
 *     empty, so unlike durable there is NO resume (§14.2's reason — persisted keys — does not apply). A
 *     session-minted key set is kept for M2's keepalive + own-event filtering (006 B5).
 *   - **The Mutator** (§15.2): spawn/despawn/add/removeComponent/edit().set/add/removeTag, scoped to your
 *     partition. LOCAL mutation applies to the runtime IMMEDIATELY through the Part II {@link Projector}
 *     primitives (Option A — spawn-then-edit in one input handler works), plus the own-blob is re-encoded
 *     and staged on the source. NO relations, NO resources (design §15.6 — not even stubbed).
 *   - **The `Local` auto-tag** (§15.4): every entity you spawn is tagged `Local` on YOUR runtime so
 *     `Not(Local)` selects remote peers. `Local` is applied LOCALLY and is NEVER in the transmitted blob.
 *   - **The own-blob codec**: entity → `{ components: { Name: canonicalValue }, tags: [names] }`, canonical
 *     values (`canon()`), name-keyed, `Local` excluded, `key`-field references pass through as strings.
 *
 * NOT M1 (the seam this file installs for M2 to wire): `attachEphemeral` / inbound blob-diff projection /
 * the two outbound timers (change-throttle + keepalive) / `EphemeralSyncStatus` (M2, all in attach.ts); the
 * public `@vibecook/strata-ecs/ephemeral` barrel (M3 — `src/ephemeral/index.ts` keeps throwing until then). TWO M2
 * pieces are folded HERE, where they need this store's private partition state: the public `leave()`
 * (best-effort departure — deletes minted keys + flushes tombstones; needs `minted`/`ownEntities`/`send`)
 * and the `@internal restageMinted` (own-timeout recovery — re-stages a live blob; needs `ownEntities`).
 * This store only
 * QUEUES outbound: every mutation re-encodes the entity's blob and calls `source.set(key, blob)`, which
 * marks the key dirty and stamps LWW (M0 finding 4) — the THROTTLE (M2) decides when the bytes leave, so
 * set-per-mutation is correct and cheap. M2 reads the source, the minted-key set, and the timer config
 * through the `@internal` accessors below and drives the timers/subscription/projection.
 *
 * ============================================================================================
 * DECISIONS (load-bearing; see the task brief + design §15.2/§15.4 + the M0 findings block in
 * loro-ephemeral-snapshot.ts)
 * ============================================================================================
 *  A. **The runtime seam is installed at attach, never held pre-attach (durable's precedent).** Before
 *     `installRuntime`, every mutator throws ("attach before mutating"): a Mutator needs a runtime to mint
 *     identity/place entities and a projector for the bijection, neither of which exists until M2's attach.
 *     The seam bundles `{ runtime, projector, isIterating(), isInEmit() }` — the store keeps NO iteration
 *     mode of its own (§3 forbids a store-side "am I iterating?" flag); it READS the World facade's counter
 *     through `isIterating`, exactly as §15.2 promises.
 *  B. **Option-A timing: local mutation is IMMEDIATE.** `spawn` = allocateIdentity + `createPair` +
 *     `ensurePlaced` + `projectComponent`(s) + `applyTag`(s) + the auto-`Local` tag, all NOW — so a
 *     `spawn` then `edit().set` in one input handler sees the component in runtime columns by the second
 *     line. `despawn` = `projector.remove`. The store never delays local structure the way durable does,
 *     because the constraint that forces durable's delay (keeping the reconcile baseline in lockstep)
 *     is absent here (§15.2, §15.1).
 *  C. **The in-system rules (§15.2 / 006 §A4), read through the seam.** STRUCTURAL `eph.*`
 *     (spawn/despawn/add/removeComponent/add/removeTag) THROWS while `isIterating()` — in ALL builds,
 *     because a mid-iteration archetype migration is memory corruption, not a style violation. VALUE
 *     `edit().set` is EXEMPT (it reorders no columns — legal in-system on your own entities). Separately,
 *     ALL mutation is DEV-rejected inside an observer/reactive emit (`isInEmit`): the runtime's own
 *     in-emit guards are MIXED (`projectComponent` unguarded and applies; `addTag`/`removeComponent`/
 *     `destroy` DEV-swallowed) — so an unguarded ephemeral mutation mid-emit would HALF-apply (component
 *     lands, `Local` swallowed; or the runtime no-ops while the blob updates → divergence). This store
 *     forbids the whole situation once, at its own boundary, before touching any primitive. Both guards
 *     are the runtime's posture: iteration throws in all builds, emit is DEV-only.
 *  D. **Partition ownership is absolute.** Every mutator that names an entity checks
 *     `projector.keyFor(e)` against this peer's prefix; anything not in your live minted set throws,
 *     INCLUDING value writes (`edit(remote)` throws even inside a system, §15.2). Remote entities are
 *     read-only projections.
 *  E. **`Local` is applied to the runtime but NEVER to the blob** (§15.4). The store auto-tags on spawn
 *     via `projector.applyTag(key, Local)`; the tracked blob state never records it, so the codec cannot
 *     transmit it. `eph.addTag`/`removeTag` of `Local` throws — it is store-owned and query-only.
 *  F. **The eid-field ban (005 §7), memoized like durable's.** The first replicated use of a component
 *     carrying an `eid` field DEV-throws (a packed runtime handle is meaningless across the wire — use a
 *     `key` field). Validated once per `ComponentId`, then cached.
 */

import { DEV, devError, devWarn } from "../core/dev";
import { Local } from "../core/local";
import {
  type Component,
  type ComponentId,
  type Entity,
  type EntityEditor,
  type EntityKey,
  type FieldInput,
  type RuntimeStore,
  type SpawnInitOf,
  type Tag,
  entityKey,
} from "../core";
import { canon } from "../substrate";
import type { ComponentValue, Projector } from "../substrate";
import type { EphemeralBlob, EphemeralSource } from "./types";

/** Config defaults (design §15.2/§15.5). */
const DEFAULT_THROTTLE_MS = 16;
const DEFAULT_TTL_MS = 5000;
/**
 * The change-throttle floor. E5-load-bearing (M0 finding 2): Loro resolves per-key LWW on a coarse
 * MILLISECOND wall clock, so two distinct-value sends of ONE key must land ≥1ms apart to carry distinct
 * timestamps — otherwise the later value can be lost on in-order delivery. 8ms keeps a comfortable margin
 * above the 1ms floor while staying sub-frame, so the throttle can never violate the ordering contract the
 * blob-diff depends on.
 */
const THROTTLE_FLOOR_MS = 8;
/**
 * The TTL floor. The keepalive interval is ~ttlMs/3 (§15.3), which must stay well above the throttle floor
 * so a live-but-idle entity refreshes several times per TTL window (several-missed-beat headroom, §15.3) —
 * a too-small TTL flickers on ordinary packet loss. 100ms keeps ttlMs/3 (≈33ms) comfortably above the 8ms
 * throttle floor and is a sane minimum "transient" lifetime.
 */
const TTL_FLOOR_MS = 100;

/**
 * The runtime seam M2's `attachEphemeral` installs (decision A). The store keeps NO iteration mode of its
 * own — it reads the World facade's counters through the callbacks:
 *  - `runtime`     — mint identity + value-write (`writeComponent`) for `edit().set`.
 *  - `projector`   — the key↔handle bijection + the stamped cell-application primitives (§5).
 *  - `isIterating` — `world.inImmediateProjectionUnsafeContext` (mid query-walk or mid-tick); structural
 *                    `eph.*` throws while true, in ALL builds (006 §A4).
 *  - `isInEmit`    — `world.runtime.inObserverEmitActive`; ALL `eph.*` is DEV-rejected while true (§C2).
 * M2 constructs the `Projector` over `world.runtime` with this store's `mintKey`, then installs the seam.
 */
export interface EphemeralRuntime {
  readonly runtime: RuntimeStore;
  readonly projector: Projector;
  isIterating(): boolean;
  isInEmit(): boolean;
}

/** The construction options (design §15.2 API reference). `throttleMs`/`ttlMs` are validated + clamped. */
export interface EphemeralStoreOptions {
  /**
   * This peer's id — the prefix for the keys THIS store mints (its partition). MUST be SESSION-UNIQUE
   * (006 B5): use `crypto.randomUUID()` or `${userId}:${sessionNonce}`, NEVER a stable per-user id. A
   * stable id + a reload inside the TTL window makes a crashed session's ghost keys arrive back under your
   * own prefix, and (M2's) keepalive would refresh them forever — permanent ghosts. Display identity
   * (name, color) belongs in a component (`PresenceInfo`), never the key prefix.
   */
  peerId: string;
  /** OUTBOUND SINK (§15.5): where M2's throttle/keepalive timers hand their bytes (e.g. `ws.send`). */
  send: (bytes: Uint8Array) => void;
  /** Outbound change clock (M2), default 16ms; clamped to ≥ {@link THROTTLE_FLOOR_MS}. */
  throttleMs?: number;
  /** Per-entry TTL (M2 keepalive drives off it), default 5000ms; clamped to ≥ {@link TTL_FLOOR_MS}. */
  ttlMs?: number;
}

/**
 * The shape of `eph.debugDump()` — the tools observer's ephemeral-tab read (debug/observability ONLY, never
 * a sync seam). A snapshot COPY of every partition's current blob (this peer's own included) plus the three
 * scalars the tab shows; `entries` are sorted by key for a stable display.
 */
export interface EphemeralDebugDump {
  peerId: string;
  ttlMs: number;
  throttleMs: number;
  entries: Array<{ key: string; blob: EphemeralBlob }>;
}

/** Validate + clamp one duration option with a DEV warning, so a pathological value can't break the wire. */
function clampMs(v: number | undefined, def: number, floor: number, name: string, why: string): number {
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    devWarn(`createEphemeralStore: ${name} must be a finite number — got ${String(v)}; using the default ${def}ms.`);
    return def;
  }
  if (v < floor) {
    devWarn(`createEphemeralStore: ${name}=${v}ms is below the ${floor}ms floor — clamped to ${floor}ms. ${why}`);
    return floor;
  }
  return v;
}

/** The blob-tracking record for ONE owned entity — the exact material the codec transmits (decision E). */
interface OwnEntity {
  /** Component name → canonical value (`canon()`ed at mutation time, so it matches the projected column). */
  readonly components: Map<string, ComponentValue>;
  /** User tag names. `Local` is NEVER recorded here — the store applies it to the runtime only (decision E). */
  readonly tags: Set<string>;
}

/**
 * `EphemeralStore` — the writer-partitioned Mutator (design §15.2). App code obtains one from
 * {@link createEphemeralStore} and mutates ONLY entities in its own partition; every mutation applies to
 * the runtime immediately (Option A) and re-encodes the entity's outbound blob on the source. M2's
 * `attachEphemeral` installs the runtime seam and drives the timers/subscription/inbound projection.
 */
export class EphemeralStore {
  private readonly source: EphemeralSource;
  /** This peer's id (the partition, §15.1) — session-unique is the APP's obligation (006 B5). */
  readonly peerId: string;
  private readonly sendFn: (bytes: Uint8Array) => void;
  private readonly throttleMsValue: number;
  private readonly ttlMsValue: number;

  /** `${peerId}-` — the minted-key prefix, the partition boundary (§15.3). */
  private readonly prefix: string;
  /** Next counter suffix — from 0 (ephemeral starts empty, no resume). Only ever moves forward. */
  private counter = 0;
  /** The keys THIS session minted and has not despawned — M2's keepalive + own-event filter set (006 B5). */
  private readonly minted = new Set<EntityKey>();
  /** Per-owned-entity blob state (decision E), keyed by minted key. Deleted on despawn. */
  private readonly ownEntities = new Map<EntityKey, OwnEntity>();
  /** eid-ban memo (decision F): a ComponentId is here once validated clean; re-checks are skipped. */
  private readonly validatedComponents = new Set<ComponentId>();

  /** The runtime seam (decision A) — null until M2's `installRuntime`; every mutator throws while null. */
  private seam: EphemeralRuntime | null = null;

  constructor(source: EphemeralSource, opts: EphemeralStoreOptions) {
    if (typeof opts.peerId !== "string" || opts.peerId.length === 0) {
      throw new Error(
        "strata: createEphemeralStore requires a non-empty peerId — SESSION-unique (crypto.randomUUID()); display identity goes in a component, not the key prefix (006 B5).",
      );
    }
    if (typeof opts.send !== "function") {
      throw new Error("strata: createEphemeralStore requires a send(bytes) callback — the outbound transport sink (§15.5).");
    }
    this.source = source;
    this.peerId = opts.peerId;
    this.sendFn = opts.send;
    this.prefix = `${opts.peerId}-`;
    this.throttleMsValue = clampMs(
      opts.throttleMs,
      DEFAULT_THROTTLE_MS,
      THROTTLE_FLOOR_MS,
      "throttleMs",
      "Two distinct-value sends of one key must be ≥1ms apart for Loro's wall-clock LWW to order them (M0 finding 2).",
    );
    this.ttlMsValue = clampMs(
      opts.ttlMs,
      DEFAULT_TTL_MS,
      TTL_FLOOR_MS,
      "ttlMs",
      "The keepalive (~ttlMs/3) must stay well above the throttle so live-but-idle entities never flicker (§15.3).",
    );
  }

  // --- the Mutator surface (§15.2), scoped to YOUR partition ----------------------------------------

  /**
   * Spawn an ephemeral entity in YOUR partition (design §15.2, Option A — immediate). Mints identity + a
   * peer-prefixed key, places the entity, writes its components, applies its tags, and auto-applies
   * `Local` (runtime only, never transmitted — §15.4). The returned handle is usable NOW: `eph.spawn(...)`
   * then `eph.edit(that).set(...)` in one input handler works. Throws mid query-iteration/tick (structural,
   * all builds); DEV-throws inside an observer emit (both would corrupt/half-apply — decision C). A
   * malformed component value or a duplicate/eid-field component throws BEFORE any identity is allocated,
   * so a rejected spawn leaks nothing.
   */
  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity {
    const seam = this.requireSeam("spawn");
    this.rejectStructuralInSystem("spawn", seam);
    if (DEV && seam.isInEmit()) {
      // spawn cannot devError-and-no-op like the void mutators (it must yield a valid handle), and
      // proceeding would half-apply (`Local` swallowed by the runtime's in-emit addTag guard), so it
      // throws in DEV. Production has no in-emit guards, so it applies fully there (the runtime's posture).
      throw new Error(
        "strata: eph.spawn() cannot run from inside an observer or reactive callback — schedule presence updates for the next frame (002 §6, §C2).",
      );
    }

    // Pre-validate EVERYTHING before minting identity (mirrors runtime.spawn): a bad value must throw with
    // no identity allocated and no onSpawn fired.
    const seen = new Set<ComponentId>();
    const canonComponents: Array<readonly [Component, ComponentValue]> = [];
    for (const [comp, value] of (init?.components ?? []) as ReadonlyArray<readonly [Component, unknown]>) {
      if (seen.has(comp.id)) throw new Error(`strata: component "${comp.name}" supplied twice to eph.spawn.`);
      seen.add(comp.id);
      this.assertNoEidFields(comp);
      canonComponents.push([comp, canon(comp, value as ComponentValue)]); // throws on malformed, pre-mint
    }
    const tags = (init?.tags ?? []) as readonly Tag[];
    for (const t of tags) this.assertNotLocal(t, "spawn");

    // Apply — all immediate (Option A). createPair mints the key via this.mintKey (counter + minted set).
    const handle = seam.runtime.allocateIdentity();
    const key = seam.projector.createPair(handle);
    seam.projector.applySpawn(key); // place, so a componentless/tagless entity is still queryable (§10.3)
    const oe: OwnEntity = { components: new Map(), tags: new Set() };
    for (const [comp, cv] of canonComponents) {
      seam.projector.applyComponent(key, comp, cv); // cv is canonical; projectComponent re-encodes identically
      oe.components.set(comp.name, cv);
    }
    for (const t of tags) {
      seam.projector.applyTag(key, t);
      oe.tags.add(t.name);
    }
    seam.projector.applyTag(key, Local); // auto-tag: runtime ONLY, never recorded in oe → never transmitted (§15.4)
    this.ownEntities.set(key, oe);
    this.flush(key, oe);
    return handle;
  }

  /**
   * Despawn one of YOUR ephemeral entities (design §15.2/§15.3). Deletes the source key (best-effort leave
   * — captures a tombstone so peers can despawn IMMEDIATELY rather than waiting the TTL) and removes the
   * local runtime entity. Note: an explicit delete is best-effort only — a same-ms delete-vs-set can drop
   * (M0 finding 5), so it merely SHORTENS despawn latency; the GUARANTEED despawn on every receiver is
   * always the TTL `timeout` (§15.3). Throws mid-iteration/tick; DEV-rejected in an emit (decision C).
   */
  despawn(e: Entity): void {
    const seam = this.requireSeam("despawn");
    this.rejectStructuralInSystem("despawn", seam);
    if (this.rejectInEmit("despawn", seam)) return;
    const { key } = this.requireOwn(e, "despawn", seam);
    this.source.delete(key); // capture the tombstone (best-effort leave); TTL timeout is the real guarantee
    seam.projector.remove(key); // despawn the local runtime entity + unbind the key↔handle pair
    this.ownEntities.delete(key);
    this.minted.delete(key); // stop the keepalive refreshing a despawned key
  }

  /**
   * Add a component (a dynamic facet, §15.6) to one of YOUR entities — its PRESENCE is the signal (e.g.
   * `[PresenceInfo, Selection]` = "this peer is selecting"). Structural: throws mid-iteration/tick;
   * DEV-rejected in an emit. Re-encodes the blob → every remote peer's projection gains the component.
   */
  addComponent<S>(e: Entity, c: Component<S>, v: S): void {
    const seam = this.requireSeam("addComponent");
    this.rejectStructuralInSystem("addComponent", seam);
    if (this.rejectInEmit("addComponent", seam)) return;
    const { key, oe } = this.requireOwn(e, "addComponent", seam);
    this.assertNoEidFields(c);
    const cv = canon(c, v as ComponentValue); // canonical form for the blob (== what the projector stores)
    seam.projector.applyComponent(key, c, v); // apply raw v — projectComponent canonicalizes it identically
    oe.components.set(c.name, cv);
    this.flush(key, oe);
  }

  /**
   * Remove a component from one of YOUR entities — its absence propagates as a per-entity value diff, so
   * every remote peer removes it from their projection (§15.6). Structural: throws mid-iteration/tick;
   * DEV-rejected in an emit.
   */
  removeComponent(e: Entity, c: Component): void {
    const seam = this.requireSeam("removeComponent");
    this.rejectStructuralInSystem("removeComponent", seam);
    if (this.rejectInEmit("removeComponent", seam)) return;
    const { key, oe } = this.requireOwn(e, "removeComponent", seam);
    seam.projector.removeComponent(key, c);
    oe.components.delete(c.name);
    this.flush(key, oe);
  }

  /**
   * A value editor for one of YOUR entities (design §15.2). `edit(e).set(C, v)` is a PURE value write
   * (`writeComponent` — throws if the component is absent, exactly like `world.edit().set`): it reorders no
   * columns, so it is LEGAL inside a system (the one in-system allowance, §15.2) — but still ownership-
   * checked and DEV-rejected in an emit. `edit(remoteEntity)` throws even for a value write: writer
   * partitioning is absolute (§15.4). Ownership is checked HERE, at `edit()`, so a foreign editor is never
   * handed out.
   */
  edit(e: Entity): EntityEditor {
    const seam = this.requireSeam("edit");
    const { key, oe } = this.requireOwn(e, "edit", seam);
    const editor: EntityEditor = {
      set: (c, v) => {
        if (this.rejectInEmit("edit().set", seam)) return editor; // value writes are DEV-rejected in an emit
        this.assertNoEidFields(c);
        const cv = canon(c, v as ComponentValue); // validate + canonical form BEFORE the runtime write
        seam.runtime.writeComponent(e, c, v); // pure value write — throws if the component is absent (§5.2)
        oe.components.set(c.name, cv);
        this.flush(key, oe);
        return editor;
      },
    };
    return editor;
  }

  /**
   * Tag one of YOUR entities. `Local` is REJECTED — it is store-owned and query-only (§15.2/§15.4).
   * Structural: throws mid-iteration/tick; DEV-rejected in an emit. The tag rides the entity's blob.
   */
  addTag(e: Entity, t: Tag): void {
    const seam = this.requireSeam("addTag");
    this.rejectStructuralInSystem("addTag", seam);
    if (this.rejectInEmit("addTag", seam)) return;
    this.assertNotLocal(t, "addTag");
    const { key, oe } = this.requireOwn(e, "addTag", seam);
    seam.projector.applyTag(key, t);
    oe.tags.add(t.name);
    this.flush(key, oe);
  }

  /** Remove a tag from one of YOUR entities. `Local` is REJECTED (store-owned, §15.4). Structural. */
  removeTag(e: Entity, t: Tag): void {
    const seam = this.requireSeam("removeTag");
    this.rejectStructuralInSystem("removeTag", seam);
    if (this.rejectInEmit("removeTag", seam)) return;
    this.assertNotLocal(t, "removeTag");
    const { key, oe } = this.requireOwn(e, "removeTag", seam);
    seam.projector.removeTag(key, t);
    oe.tags.delete(t.name);
    this.flush(key, oe);
  }

  // --- explicit departure (M2, design §15.3) --------------------------------------------------------

  /**
   * Best-effort explicit departure — the app wires it to `pagehide`/`beforeunload` (design §15.3). Deletes
   * EVERY key this session minted on the source (capturing tombstones so peers despawn IMMEDIATELY rather
   * than waiting the TTL), despawns the local runtime entities, and flushes the tombstones through `send`
   * NOW (not on the throttle clock — the page is going away). Clearing the minted set also stops M2's
   * keepalive from refreshing anything.
   *
   * **TTL `timeout` remains the GUARANTEED despawn on every receiver** — a delete whose tombstone shares a
   * wall-clock ms with the key's last `set` LWW-ties and is DROPPED on receivers (M0 finding 5), so
   * `leave()` only SHORTENS despawn latency; it is never the sole despawn mechanism. A no-op when nothing
   * is minted (already departed, or detached — `clearRuntime` emptied the set). Runs OUTSIDE a tick by
   * construction (an unload handler); it is not an in-system mutator and takes no iteration guard.
   */
  leave(): void {
    if (this.minted.size === 0) return;
    const seam = this.seam; // null if detached → skip the runtime despawn, still flush the source deletes
    for (const key of [...this.minted]) {
      this.source.delete(key); // capture the tombstone + fire the (ignored) own `local` removed echo
      seam?.projector.remove(key); // despawn the local runtime entity + unbind its key↔handle pair
      this.ownEntities.delete(key);
    }
    this.minted.clear();
    for (const buf of this.source.encodeDeletes()) this.sendFn(buf); // ship the tombstones immediately (best-effort)
  }

  // --- debug / observability (the tools observer's ephemeral tab) ------------------------------------

  /**
   * The observer tab's ONE read (debug/observability, NEVER a sync path). Returns a snapshot COPY of every
   * partition's current blob — this peer's own included — through the source's OPTIONAL
   * {@link EphemeralSource.debugEntries} (a TTL-pruned point-in-time view), sorted by key for a stable
   * display, plus the three scalars the tab shows (peerId + the two clocks). The copy shares no state with
   * the source, so it is safe to hold across ticks. A source WITHOUT `debugEntries` (a test double or an
   * alternative backend) yields an empty `entries` list and NEVER throws.
   */
  debugDump(): EphemeralDebugDump {
    const raw = this.source.debugEntries?.() ?? {};
    const entries = Object.keys(raw)
      .sort()
      .map((key) => ({ key, blob: raw[key] }));
    return { peerId: this.peerId, ttlMs: this.ttlMsValue, throttleMs: this.throttleMsValue, entries };
  }

  // --- the own-blob codec (decision E) --------------------------------------------------------------

  /**
   * Re-encode `oe` and stage it on the source (design §15.6). `source.set` marks the key dirty + stamps
   * LWW (M0 finding 4); M2's THROTTLE decides when the bytes actually go out, so set-per-mutation is
   * correct and cheap (only the changed entity is re-encoded — each entity is its own Loro key, §15.5).
   */
  private flush(key: EntityKey, oe: OwnEntity): void {
    this.source.set(key, encodeBlob(oe));
  }

  // --- guards ---------------------------------------------------------------------------------------

  /** The installed seam, or throw the "attach before mutating" error (decision A — durable's precedent). */
  private requireSeam(op: string): EphemeralRuntime {
    if (this.seam === null) {
      throw new Error(
        `strata: eph.${op}() requires an attached store — call attachEphemeral(world, eph) first (§15.2).`,
      );
    }
    return this.seam;
  }

  /** Structural `eph.*` mid query-iteration/tick throws in ALL builds — memory safety, not style (§C). */
  private rejectStructuralInSystem(op: string, seam: EphemeralRuntime): void {
    if (seam.isIterating()) {
      throw new Error(
        `strata: structural eph.${op}() cannot run during query iteration or a tick — a mid-iteration archetype migration corrupts the walk (memory safety, not style). Ephemeral structural mutation is designed for input handlers, outside the tick; to derive ephemeral state from a system, stage the intent during the tick and apply it after tick() returns (§15.2, 006 §A4).`,
      );
    }
  }

  /**
   * DEV-reject a mutation issued from inside an observer/reactive emit (returns true → the caller no-ops).
   * The runtime's own in-emit guards are MIXED (some primitives apply, some swallow — §C2), so an
   * unguarded ephemeral mutation mid-emit would half-apply; forbidding it whole at this boundary keeps
   * runtime and blob consistent. DEV-only, mirroring the runtime (production has no in-emit guards).
   */
  private rejectInEmit(op: string, seam: EphemeralRuntime): boolean {
    if (DEV && seam.isInEmit()) {
      devError(
        `eph.${op}() from inside an observer or reactive callback is ignored — a mutation there half-applies through the runtime's mixed in-emit guards; schedule it for the next frame (002 §6, §C2).`,
      );
      return true;
    }
    return false;
  }

  /**
   * Resolve `e` to its key + blob state, or throw a partition violation (decision D). A handle not bound in
   * the projector (a `world.spawn` entity, or garbage), a foreign-prefix key (another peer's projected
   * entity — read-only, §15.4), or an own-prefix key this session did NOT spawn (a reused-peerId ghost,
   * reachable only once inbound exists — 006 B5) all throw. What remains is exactly your live minted set.
   */
  private requireOwn(e: Entity, op: string, seam: EphemeralRuntime): { key: EntityKey; oe: OwnEntity } {
    const key = seam.projector.keyFor(e);
    if (key === undefined || !key.startsWith(this.prefix)) {
      throw new Error(
        `strata: eph.${op}() on an entity outside your partition — remote peers' ephemeral entities are read-only projections; you may only mutate entities you spawned (§15.1/§15.4).`,
      );
    }
    const oe = this.ownEntities.get(key);
    if (oe === undefined) {
      throw new Error(
        `strata: eph.${op}() targets an own-prefix key this session did not spawn — not yours to mutate (peerId reuse? 006 B5).`,
      );
    }
    return { key, oe };
  }

  /** `Local` is store-owned and query-only — reject any attempt to add/remove it by hand (§15.2/§15.4). */
  private assertNotLocal(t: Tag, op: string): void {
    if (t === Local) {
      throw new Error(
        `strata: eph.${op}(Local) is not allowed — Local is applied automatically by the store to your own partition and is query-only; manually mutating it desynchronizes every Local/Not(Local) query (§15.4).`,
      );
    }
  }

  /**
   * DEV-throw if `c` declares any `eid` field (005 §7, decision F) — a replicated component must reference
   * entities with `key` fields, not packed runtime handles (meaningless across the wire). Memoized per
   * ComponentId: validated once at first replicated use, then skipped. A runtime-only component with `eid`
   * fields never reaches here, so it stays legal.
   */
  private assertNoEidFields(c: Component): void {
    if (this.validatedComponents.has(c.id)) return;
    if (DEV) {
      for (const f of c.fields) {
        if (f.spec.type === "eid") {
          throw new Error(
            `strata: ephemeral component "${c.name}" declares an eid field "${f.name}" — an eid is a packed runtime handle, meaningless across the wire. Reference entities with a key field instead (005 §7).`,
          );
        }
      }
    }
    this.validatedComponents.add(c.id);
  }

  // --- @internal seam for M2 (attachEphemeral wires the real world here) -----------------------------

  /**
   * @internal Install the runtime seam (M2's `attachEphemeral`, decision A). After this, mutators are
   * legal; before it (and after {@link clearRuntime}) they throw. Constructed by M2 as
   * `{ runtime: world.runtime, projector: new Projector(world.runtime, () => eph.mintKey()),
   *    isIterating: () => world.inImmediateProjectionUnsafeContext,
   *    isInEmit: () => world.runtime.inObserverEmitActive }`.
   */
  installRuntime(rt: EphemeralRuntime): void {
    this.seam = rt;
  }

  /**
   * @internal Clear the runtime seam + the store's own partition state (M2's detach). Mutators throw again
   * afterward. The projector teardown (despawning the entities) is M2's; this clears the blob-tracking maps
   * and the minted-key set. The counter is NOT reset — it only ever moves forward, so a re-attach mints
   * fresh keys with no risk of colliding a still-in-flight prior key.
   */
  clearRuntime(): void {
    this.seam = null;
    this.ownEntities.clear();
    this.minted.clear();
  }

  /**
   * @internal Mint the next peer-prefixed key and record it in the session-minted set (§15.3, 006 B5).
   * Called ONLY by the projector's `createPair` during a local spawn — every minted key is therefore an
   * own key this session spawned. M2 passes `() => eph.mintKey()` to the `Projector` constructor.
   */
  mintKey(): EntityKey {
    const key = entityKey(`${this.prefix}${this.counter++}`);
    this.minted.add(key);
    return key;
  }

  /**
   * @internal Re-stage a live minted key's current blob on the source — M2's own-timeout recovery (006 B5 /
   * M0 finding 4). Loro's `timeout` fires on the OWNER too: if the keepalive lapses, one of our OWN keys can
   * self-expire and vanish from the source while its entity is still ALIVE in our runtime (M2 never despawns
   * an own entity on timeout). Re-`set`ting the tracked blob revives + re-stamps the key on the real store
   * (marking it dirty), so the next change-throttle re-broadcasts it and receivers keep seeing our live
   * entity. A no-op for a key that is no longer a live own entity (already despawned).
   */
  restageMinted(key: EntityKey): void {
    const oe = this.ownEntities.get(key);
    if (oe === undefined) return; // not a live own entity → nothing to revive
    this.source.set(key, encodeBlob(oe)); // re-stamp on the real store: revives the key + marks it dirty
  }

  /** @internal The backing source — M2 subscribes, encodes (throttle/keepalive/deletes), and applies through it. */
  get ephemeralSource(): EphemeralSource {
    return this.source;
  }

  /**
   * @internal The keys THIS session minted and has not despawned (006 B5). M2's keepalive re-sends ONLY
   * these (`source.encodeKeys([...])`), never own-prefix keys learned from inbound, and filters own-prefix
   * `remote`/`timeout` events by membership. A read-only view over the live set.
   */
  get mintedKeys(): ReadonlySet<EntityKey> {
    return this.minted;
  }

  /** @internal The outbound sink M2's timers hand bytes to (§15.5). */
  get send(): (bytes: Uint8Array) => void {
    return this.sendFn;
  }

  /** @internal The change-throttle window (ms) — M2's throttle timer period (§15.5). */
  get throttleMs(): number {
    return this.throttleMsValue;
  }

  /** @internal The per-entry TTL (ms) — M2 sizes the keepalive at ~ttlMs/3 off it (§15.3/§15.5). */
  get ttlMs(): number {
    return this.ttlMsValue;
  }
}

/**
 * Encode an owned entity's blob (design §15.6): `{ components: { Name: canonicalValue }, tags: [names] }`.
 * Name-keyed and canonical (so the receiver projects the same cell the owner sees); `Local` is excluded by
 * construction (it is never recorded in `oe.tags` — decision E). `key`-field references are plain strings,
 * so they pass through the canonical value untouched (canon leaves string/key fields as-is).
 */
function encodeBlob(oe: OwnEntity): EphemeralBlob {
  const components: Record<string, ComponentValue> = {};
  for (const [name, value] of oe.components) components[name] = value;
  return { components, tags: [...oe.tags] };
}

/**
 * Wrap a caller-owned {@link EphemeralSource} in an {@link EphemeralStore} — the construction boundary
 * (design §15.2 API reference), the ephemeral twin of `createDurableStore`. The caller owns the source's
 * lifecycle (creating the backing Loro `EphemeralStore`, wiring its inbound `apply` to a transport) and
 * supplies the SESSION-UNIQUE `peerId` (006 B5) and the outbound `send` sink; the store adds partitioning,
 * the Mutator, and the `Local` auto-tag. Attach (M2) registers the inbound source and starts the timers.
 */
export function createEphemeralStore(source: EphemeralSource, opts: EphemeralStoreOptions): EphemeralStore {
  return new EphemeralStore(source, opts);
}

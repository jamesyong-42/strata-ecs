/**
 * The durable binding — Part III **M2** (attach/detach/drain skeleton) + **M4** (the reconcile matrix)
 * (docs/plan-part3.md; design.md §12.4, §13.1–§13.5; 006 B3, C5).
 *
 * `attachDurable(world, store)` creates the **binding**: the one object in the durable layer that holds
 * BOTH a runtime reference (through the {@link Projector}) and the {@link BaselineSnapshot}, because the
 * one piece of logic that needs both worlds — the reconcile compare (§13) — lives here at the seam,
 * owned by neither pure side (§12.4). The binding has two faces, and this file wires the DOWNWARD one:
 * it implements {@link InboundSource} (its `drain()` face — the sole face the world holds, registered at
 * attach), owns the projector, and enqueues the document's doc-facts for `world.sync()` to reconcile.
 * The UPWARD face — `doc.transaction` — lives on the {@link DurableStore} and reaches the doc + baseline
 * directly (M3); the binding never exposes it.
 *
 * ============================================================================================
 * DECISIONS (load-bearing; see the task brief + the cited spec)
 * ============================================================================================
 *  A. **`attachDurable` is a package-level FUNCTION, not `world.attachDurable`** — a deliberate deviation
 *     from design.md's `world.attachDurable(store)` sketch. The core must NEVER name a durable type; its
 *     only concession to the layers is `registerInboundSource(InboundSource)` (§12.1). So attach lives in
 *     the durable package and reaches the world through that single seam. (M5 doc pass: amend §14.2's
 *     sketch to the function form.)
 *  B. **The reconcile matrix (M4) — the origin×kind value semantics that make collaboration correct.**
 *     Structural facts (spawn / despawn / component add-or-remove / tag / relation) ALWAYS apply and
 *     advance the baseline — own is the runtime's only path to the change; remote has no in-flight
 *     divergence to protect (§13.3 row 1). VALUE facts are drag-protected against the pre-batch baseline:
 *     - **(own, value):** `cellEquals(runtime, baseline)` ⇒ apply the CONVERGED doc value + advance
 *       baseline; else (a local re-drag is in flight) advance the **baseline only**, runtime untouched
 *       (§13.3's one asymmetry — the echo is a value we authored, so it is banked truth).
 *     - **(remote, value):** `cellEquals` ⇒ apply converged + advance baseline (agreement); else DROP
 *       from the runtime, baseline UNTOUCHED, and record the converged value in the {@link held} ledger.
 *     Resources run the identical matrix at cardinality one (§13.4); `resource-remove` is structural.
 *  F. **CONVERGED-VALUE RE-READ, never the batch payload (§13.3; the M3 stale-echo finding).** An
 *     own-echo batch carries the value AS OF COMMIT TIME; if a concurrent remote won LWW between the
 *     commit and this sync, applying the payload would CLOBBER the converged value. So every value
 *     APPLY re-reads the doc's converged truth at drain time ({@link convergedComponent} /
 *     {@link convergedResource}, `tryCanon`-gated), and the batch payload drives only CLASSIFICATION
 *     (add-vs-value, malformed-reject). The re-read is R4-stripped to local schema, so all compares
 *     stay well-defined over local fields (006 B3 R4).
 *  G. **The held-cell ledger + end-of-drain sweep (006 C5).** The latest DROPPED remote value per cell.
 *     An entry is CLEARED by (a) any APPLIED value fact for the cell, (b) the local commit's synchronous
 *     agreement (the {@link txRuntime} `clearHeld` seam the executor calls — the held value LOST
 *     committer-wins), or (c) any STRUCTURAL fact on the cell (else the sweep resurrects a removed
 *     component). The {@link sweep} runs at the END of EVERY drain — including empty ones, because a
 *     drag reconverges BETWEEN drains — and applies a held value ONLY on the silent-reconverge case
 *     (`cellEquals(runtime, baseline)` NOW). Holds never stamp; sweep-applies stamp (they are projector
 *     writes), so reactivity observes a recovered value at the applying frame (006 C2).
 *  H. **The stranded-cell DEV counter (§13.5).** Per-cell consecutive-remote-drop count; one warning
 *     past the threshold, reset on agreement. DEV-only; rides the already-deferred drop path, off the
 *     hot path.
 *  C. **The eid-field ban is validated LAZILY, memoized per `ComponentId`** (005 §7; plan locked decision):
 *     a replicated component MUST NOT carry `eid` fields (a packed runtime handle is meaningless across
 *     sessions; references travel as `key` fields). Checked at a component's FIRST durable appearance —
 *     attach projection or a drained fact — and cached, so a runtime-only component with `eid` fields
 *     stays legal (it never appears here). DEV-throws naming the component and the `key`-field remedy.
 *  D. **Local-echo arrives by subscription; remote by `store.drainPending()`.** Loro fires `subscribe`
 *     for BOTH origins (local seal AND remote import — the M1 adapter emits remote to subscribers too),
 *     but `applyRemote` ALSO enqueues remote onto the store's own queue. To avoid double-delivering
 *     remote, the binding's subscription enqueues **local echoes ONLY** (`origin === "local"`) and pulls
 *     remote from `store.drainPending()` at drain time — matching the store's own outbound filter (§12.4,
 *     durable-store.ts). The subscription NEVER applies — it enqueues; `drain()` applies (§12.4 invariant).
 *  E. **Drain order is remote-then-local within one `sync()`.** The two arrival paths (store queue for
 *     remote, binding queue for local echoes) cannot reconstruct exact cross-path interleaving from two
 *     arrays, so M2 fixes a defined order: remote batches (in queue order) then local echoes (in queue
 *     order). Loro carries CONVERGED values on both paths. The order IS load-bearing (the M4R review
 *     proved it — an earlier note claimed the guards reach the same result either way; they do not):
 *     remote-first means a remote structural REMOVE can clear a cell's baseline BEFORE the own value-echo
 *     for that cell drains, reclassifying the echo as a structural ADD (§13.3 table) — so the echo's apply
 *     MUST re-read the CONVERGED doc (decision F, extended to the structural branches) or it resurrects a
 *     cell the doc deleted. Local-first would diverge differently (the echo would classify as a value
 *     write against the still-present baseline). Convergence holds for EITHER order ONLY because every echo
 *     apply — value AND structural — honors converged truth; the fixed order plus decision F is the
 *     contract, not order-independence. The §13.5 drag flow is remote-then-echo anyway (a remote value
 *     drops mid-drag, the local commit's echo then agrees).
 */

import { DEV, devWarn } from "../core/dev";
import type {
  Component,
  ComponentId,
  Entity,
  EntityKey,
  InboundSource,
  Relation,
  Resource,
  RuntimeStore,
  Tag,
  World,
} from "../core";
import {
  BaselineSnapshot,
  Projector,
  cellEquals,
  componentByName,
  normalizeBatch,
  relationByName,
  resourceByName,
  tagByName,
  tryCanon,
  tryCanonResource,
} from "../substrate";
import type { ChangeBatch, ChangeEvent, ComponentValue, EntityRecord, Snapshot, Unsubscribe } from "../substrate";
import type { DurableBijection, DurableStore } from "./durable-store";
import type { TxRuntime } from "./transaction";
import { DurableSyncStatus, type DurableSyncStatusValue } from "./sync-status";

/**
 * The detach handle `attachDurable` returns (§12.4). NOT another `DurableTarget` — attaching never
 * creates a second transaction surface; the store stays the one place `doc.transaction` is called.
 */
export interface Attachment {
  /** Tear the binding down — the four-step teardown (005 §5.6). Idempotent. */
  detach(): void;
  /**
   * @internal The converged-value baseline reconcile compares the runtime against (§13.3) — a read-only
   * inspection seam (mirrors `world.runtime`), used to assert the founding agreement `cellEquals(runtime,
   * baseline)` and, later, drag-protection. Not part of the public durable surface.
   */
  readonly baseline: Snapshot;
}

/**
 * One store ↔ at most one attachment (§13.1 hardened invariant). A `WeakSet` keyed by the store, so a
 * detached-then-GC'd store leaves no trace and a re-attach after `detach()` (which deletes the entry) is
 * a fresh, legal projection. Module-scoped because "is this store attached" is a property of the store,
 * not of any one binding.
 */
const ATTACHED = new WeakSet<DurableStore>();

/**
 * The stranded-cell DEV warning threshold (§13.5): after this many CONSECUTIVE remote-value drops on one
 * cell with no agreement, the binding warns once that the cell looks stranded (a runtime edit diverged it
 * and never committed). Tunable; compiled out of production with the rest of the DEV counter.
 */
const STRANDED_WARN_THRESHOLD = 100;

/**
 * One held-off remote COMPONENT drop (006 C5): the entry MARKS that a remote value is pending on this cell.
 * `value` is the converged value at drop time, retained for diagnostics (the C8 sync tab) — the {@link sweep}
 * re-reads converged truth at apply time (fix 3) rather than replaying this, so a stale hole cannot resurrect.
 */
interface HeldComponent {
  readonly key: EntityKey;
  readonly comp: Component;
  readonly value: ComponentValue;
}

/** One held-off remote RESOURCE drop — the cardinality-one sibling of {@link HeldComponent}. */
interface HeldResource {
  readonly res: Resource;
  readonly value: ComponentValue;
}

/** Deduplicated union of two name-keyed records' keys (the first may be undefined) — a cell-enumeration seam. */
function unionNames(a: Record<string, unknown> | undefined, b: Record<string, unknown>): Iterable<string> {
  const s = new Set<string>(a === undefined ? [] : Object.keys(a));
  for (const k of Object.keys(b)) s.add(k);
  return s;
}

/** Deduplicated union of two name lists (the first may be undefined) — the tag-enumeration sibling. */
function unionList(a: string[] | undefined, b: string[]): Iterable<string> {
  const s = new Set<string>(a ?? []);
  for (const k of b) s.add(k);
  return s;
}

/**
 * Attach `store` to `world`: project the document in (two-phase, seeding the baseline — the founding
 * agreement, §13.1), install the key↔handle bijection, register the binding as the world's inbound
 * source, and subscribe to local echoes. Returns an {@link Attachment} whose `detach()` reverses all of
 * it (§5.6). Guards at entry mirror `sync()`'s posture, because attach — like a drain — projects
 * structure IMMEDIATELY through the projector (§13.1):
 * - throws if the world is mid query-iteration or mid-tick (an immediate migration would corrupt a live
 *   walk / phase flush — the `world.sync()` iteration guard, 006 §A4);
 * - DEV-throws inside an observer / reactive emit (the projection primitives are unguarded and would
 *   half-apply — 005 §5.5);
 * - throws on DOUBLE attach.
 */
export function attachDurable(world: World, store: DurableStore): Attachment {
  if (ATTACHED.has(store)) {
    throw new Error("strata: this DurableStore is already attached — one store has at most one attachment (§13.1).");
  }
  if (world.inImmediateProjectionUnsafeContext) {
    throw new Error(
      "strata: attachDurable() cannot run during query iteration or a tick — attach projects the document immediately (like a drain), and a mid-iteration migration corrupts the walk; attach at the frame boundary (§13.1, 006 §A4).",
    );
  }
  if (DEV && world.runtime.inObserverEmitActive) {
    throw new Error(
      "strata: attachDurable() cannot run from inside an observer or reactive callback — attach's projection half-applies through the mixed in-emit guards; schedule it for the next frame boundary (005 §5.5, §13.1).",
    );
  }

  const binding = new DurableBinding(world, store);
  binding.seed(); // two-phase projection + baseline seeding (the founding agreement)

  // Install the bijection (a LIVE delegate over the projector's maps), register the downward face, and
  // start capturing local echoes. Order after seeding: no user code runs during the synchronous seed,
  // so nothing can commit or drain into a half-built binding.
  store.setBijection(binding.bijection);
  store.setTxRuntime(binding.txRuntime); // M3 upward face: the recorder reaches the projector + baseline here
  world.registerInboundSource(binding);
  binding.subscribeLocalEchoes();
  binding.wireSyncStatus(); // M5: install the enqueue listener + publish the initial DurableSyncStatus (006 C7)
  ATTACHED.add(store);

  return { detach: () => binding.teardown(), baseline: binding.baselineView };
}

/**
 * A {@link Projector} that counts the runtime mutations it applies (M5). The binding reads the per-drain
 * delta to drive `DurableSyncStatus.lastAppliedFrame`, which MUST advance only when a drain applied ≥1
 * fact (006 C7). So it wraps EXACTLY the cell-application primitives — the runtime writes — and NOT the
 * bijection peeks/mints (`resolveByKey`/`createPair`/`requireKey`/`handleFor`/`keyFor`), which touch no
 * runtime column. Resource facts bypass the projector (§5.2), so the binding counts those three sites
 * itself. `onApply` fires once per applied primitive; the binding only reads the delta across a drain, so
 * the calls seeding attach or tearing the projector down are never observed (they fall outside any drain).
 */
class CountingProjector extends Projector {
  constructor(
    runtime: RuntimeStore,
    mintKey: () => EntityKey,
    private readonly onApply: () => void,
  ) {
    super(runtime, mintKey);
  }
  override applyComponent<S>(key: EntityKey, c: Component<S>, v: S): void {
    super.applyComponent(key, c, v);
    this.onApply();
  }
  override removeComponent(key: EntityKey, c: Component): void {
    super.removeComponent(key, c);
    this.onApply();
  }
  override applySpawn(key: EntityKey): void {
    super.applySpawn(key);
    this.onApply();
  }
  override applyTag(key: EntityKey, t: Tag): void {
    super.applyTag(key, t);
    this.onApply();
  }
  override removeTag(key: EntityKey, t: Tag): void {
    super.removeTag(key, t);
    this.onApply();
  }
  override applyRelationSet(key: EntityKey, r: Relation, target: EntityKey): void {
    super.applyRelationSet(key, r, target);
    this.onApply();
  }
  override applyRelationAdd(key: EntityKey, r: Relation, target: EntityKey): void {
    super.applyRelationAdd(key, r, target);
    this.onApply();
  }
  override removeRelation(key: EntityKey, r: Relation, target?: EntityKey): void {
    super.removeRelation(key, r, target);
    this.onApply();
  }
  override remove(key: EntityKey): void {
    super.remove(key);
    this.onApply();
  }
}

/**
 * The binding proper — {@link InboundSource} to the world, reconcile engine to the durable layer. Holds
 * the projector (runtime side) and the baseline (converged-value mirror); `drain()` reconciles the
 * queued doc-facts into both at `sync()`.
 */
class DurableBinding implements InboundSource {
  private readonly projector: Projector;
  private readonly baseline = new BaselineSnapshot();
  /** Local-echo batches awaiting drain — filled by the subscription (decision D), emptied by `drain()`. */
  private pendingLocal: ChangeBatch[] = [];
  /** The local-echo subscription's unsubscribe (teardown step 1); null until `subscribeLocalEchoes`. */
  private unsubscribe: Unsubscribe | null = null;
  /** eid-ban memo (decision C): a ComponentId is here once validated clean; re-checks are skipped. */
  private readonly validatedComponents = new Set<ComponentId>();
  /** One-shot DEV-diagnostic dedupe: `key|comp` canon rejects, `res:<name>` resource rejects, `name`s. */
  private readonly warned = new Set<string>();
  /**
   * The held-cell ledger (006 C5, decision G): the latest DROPPED remote COMPONENT value per cell, keyed
   * by the injection-proof {@link cellKey} tuple (005 §10.4). The end-of-drain {@link sweep} applies a
   * held value once the cell reconverges to baseline without a commit (the silent-reconverge case).
   */
  private readonly held = new Map<string, HeldComponent>();
  /** The RESOURCE held-cell ledger, keyed by `res.name` (a registered, non-peer-controlled name). */
  private readonly heldRes = new Map<string, HeldResource>();
  /** DEV stranded counter (§13.5, decision H): cellKey/`res:<name>` → consecutive remote-value drops. */
  private readonly dropCount = new Map<string, number>();
  /** DEV: cells already warned as stranded — cleared on agreement so a later re-strand warns again. */
  private readonly strandedWarned = new Set<string>();
  /** True after teardown — makes `detach()` idempotent and a late `drain()` a no-op. */
  private detached = false;
  /**
   * Runtime mutations applied by the projector + the three resource sites, counted by {@link CountingProjector}
   * and this binding. Reset at the top of every `drain()` and read at its end: a NON-ZERO delta is a drain
   * that applied ≥1 fact, which is the ONLY thing that advances `lastAppliedFrame` (006 C7).
   */
  private applied = 0;
  /**
   * `DurableSyncStatus.lastAppliedFrame` (006 C7): a monotonic counter bumped once per drain that applied
   * ≥1 fact — NEVER per-drain, so an idle network (empty drains apply nothing) leaves it fixed and the
   * set-on-change gate suppresses the write. Tick-independent by design (a sync-only, never-ticked viewer
   * must still see it advance), so it counts applied drains rather than reading `world.tickCount`.
   */
  private lastAppliedFrame = 0;
  /** The last {@link DurableSyncStatus} value published — the producer-side set-on-change memo (006 C7). */
  private lastSyncStatus: DurableSyncStatusValue | null = null;

  constructor(
    private readonly world: World,
    private readonly store: DurableStore,
  ) {
    // A CountingProjector so `lastAppliedFrame` can advance only on real applies (006 C7): every cell
    // primitive it runs bumps `this.applied`, which drain() reads as a per-drain delta.
    this.projector = new CountingProjector(world.runtime, () => store.mintKey(), () => {
      this.applied++;
    });
  }

  /** @internal Read-only baseline view for the {@link Attachment} inspection seam (founding agreement). */
  get baselineView(): Snapshot {
    return this.baseline;
  }

  /** The store-facing bijection: NON-minting peeks over the projector's maps (pre-attach → undefined). */
  get bijection(): DurableBijection {
    return {
      keyOf: (e: Entity) => this.projector.keyFor(e),
      resolve: (key: EntityKey) => this.projector.handleFor(key),
    };
  }

  /**
   * @internal The transaction seam the store installs at attach (M3, §12.4). Bundles the three things
   * the recorder/executor need that live on the binding side of the seam: the runtime (identity mint +
   * synchronous value writes), the projector (bijection + the `requireKey` durability gate), and the
   * baseline (overlay seed + the value agreement point). The document is reached via the store's own
   * `snapshot`. The binding never exposes `transaction` itself — only the pieces the store's call needs.
   */
  get txRuntime(): TxRuntime {
    return {
      runtime: this.world.runtime,
      projector: this.projector,
      baseline: this.baseline,
      // 006 C5 (b): a synchronous committed value wins committer-wins, so its held remote value LOST —
      // drop it (and reset the cell's stranded counter: the commit restored agreement, §13.5).
      clearHeld: (key, comp) => {
        this.clearHeldComponent(key, comp);
        this.resetStranded(this.cellKey(key, comp));
      },
      clearHeldResource: (res) => {
        this.heldRes.delete(res.name);
        this.resetStranded(`res:${res.name}`);
      },
    };
  }

  // --- attach: two-phase projection seeding the baseline (§13.1) ------------------------------------

  /**
   * Project the whole document into the runtime AND the baseline, in two phases (a relation may point at
   * an entity that appears later in iteration, so every entity must be placed before any edge is wired —
   * the §8.2 reason). THE FOUNDING AGREEMENT (§13.1): after this returns, `cellEquals(runtime, baseline)`
   * holds for every cell — the document IS the agreed value, so `baseline := doc`. Skipping it would
   * leave the baseline empty and misread the first remote change to any projected cell as a local edit
   * in flight (§13.3). All writes are IMMEDIATE — attach runs outside any system (§10.3).
   */
  seed(): void {
    const snap = this.store.snapshot;
    const records = new Map<EntityKey, EntityRecord>();

    // Phase 1: entities / components / tags — build the bijection AND seed the baseline.
    for (const key of snap.entities()) {
      const rec = snap.readEntity(key);
      if (rec === undefined) continue;
      records.set(key, rec);
      // Place the entity even if it is componentless/tagless (a bare `exists` doc-entity), so it is
      // queryable and its existence cell agrees with the doc (§10.3, Option A).
      this.projector.applySpawn(key);
      this.baseline.spawn(key);
      for (const [name, value] of Object.entries(rec.components)) {
        const comp = componentByName(name);
        if (comp === undefined) {
          this.warnUnknownName("component", name);
          continue;
        }
        this.assertNoEidFields(comp);
        this.projector.applyComponent(key, comp, value);
        this.baseline.setComponent(key, comp, value); // canon()s it — the baseline receives canonical cells
      }
      for (const name of rec.tags) {
        const tag = tagByName(name);
        if (tag === undefined) {
          this.warnUnknownName("tag", name);
          continue;
        }
        this.projector.applyTag(key, tag);
        this.baseline.addTag(key, tag);
      }
    }

    // Phase 2: relations — every target key now has a bound handle.
    for (const [key, rec] of records) {
      for (const [name, target] of Object.entries(rec.relations)) {
        const rel = relationByName(name);
        if (rel === undefined) {
          this.warnUnknownName("relation", name);
          continue;
        }
        if (rel.arity === "one") {
          const t = target as EntityKey; // arity "one" → scalar target (types.ts EntityRecord)
          this.projector.applyRelationSet(key, rel, t);
          this.baseline.setRelation(key, rel, t);
        } else {
          for (const t of target as EntityKey[]) {
            this.projector.applyRelationAdd(key, rel, t);
            this.baseline.addRelation(key, rel, t);
          }
        }
      }
    }

    // Resources — a cold-loaded doc's pre-existing resources have no entity to hang off (no per-entity
    // record surfaces them), so seed them here from the §10.8-amendment enumerator. Runtime + baseline
    // together = the founding agreement for resources: without this pass a projected resource is invisible
    // until its next write, and its first remote change misreads as a local edit in flight (§13.1/§13.3).
    for (const name of this.store.snapshot.resourceNamesRaw()) {
      const res = resourceByName(name);
      if (res === undefined) {
        this.warnUnknownName("resource", name); // 006 B3 R1 — one-shot, never projected
        continue;
      }
      const raw = this.store.snapshot.getResource(res);
      if (raw === undefined) continue; // absent / poisoned (container) → skip (getResource already warned)
      const gate = tryCanonResource(res, raw);
      if (!gate.ok) {
        this.warnCanonReject(`res:${res.name}`, res.name, gate.field, gate.reason);
        continue; // malformed → seed neither side (§2.3)
      }
      this.world.runtime.setResource(res, gate.value); // resources bypass the kernel (§10.8)
      this.baseline.setResource(res, gate.value); // R4-stripped local-schema value, like the reconcile path
    }
  }

  /** Subscribe to the snapshot for LOCAL echoes only (decision D) — enqueue, never apply (§12.4). */
  subscribeLocalEchoes(): void {
    this.unsubscribe = this.store.snapshot.subscribe((batch) => {
      if (batch.origin === "local") {
        this.pendingLocal.push(batch);
        this.publishSyncStatus(); // enqueue boundary: pendingInbound just grew (006 C7)
      }
    });
  }

  // --- the sync-status resource (006 C7, M5) --------------------------------------------------------

  /**
   * Wire {@link DurableSyncStatus} at attach: install the store's inbound-enqueue listener (so a REMOTE
   * `applyRemote` republishes `pendingInbound` at the enqueue boundary — the local-echo boundary is our own
   * subscription) and publish the initial status. Called once from `attachDurable`, after the inbound source
   * is registered and the local-echo subscription is live.
   */
  wireSyncStatus(): void {
    this.store.setInboundListener(() => this.publishSyncStatus());
    this.publishSyncStatus();
  }

  /**
   * Publish {@link DurableSyncStatus} with PRODUCER-SIDE SET-ON-CHANGE (006 C7, mandatory): compute the
   * activity-driven fields, compare each against the last value set, and SKIP `setResource` when nothing
   * changed. This is what makes an IDLE network produce ZERO re-renders — `world.sync()` drains every frame,
   * but an empty drain moves no field, so no stamp is written and no `useResource` panel re-renders. Called
   * at the two enqueue boundaries (pendingInbound grew) and at the end of every drain (pendingInbound fell,
   * heldCells and lastAppliedFrame settled).
   */
  private publishSyncStatus(): void {
    const next: DurableSyncStatusValue = {
      pendingInbound: this.store.pendingCount + this.pendingLocal.length,
      heldCells: this.held.size + this.heldRes.size,
      lastAppliedFrame: this.lastAppliedFrame,
    };
    const prev = this.lastSyncStatus;
    if (
      prev !== null &&
      prev.pendingInbound === next.pendingInbound &&
      prev.heldCells === next.heldCells &&
      prev.lastAppliedFrame === next.lastAppliedFrame
    ) {
      return; // set-on-change: nothing moved → no setResource → no stamp → no re-render (006 C7)
    }
    this.lastSyncStatus = next;
    this.world.setResource(DurableSyncStatus, next); // runtime-local — never written to the doc (006 C7)
  }

  // --- the downward face: drain (§13.3) -------------------------------------------------------------

  /**
   * Reconcile the pending doc-facts into the runtime + baseline (§13.3). Pulls REMOTE batches from the
   * store's queue and LOCAL echoes from ours (decision D), then processes each batch atomically, in
   * order, single-origin (decision E). Runs from `world.sync()` at the frame boundary — outside
   * iteration, outside any emit — so its structural writes apply IMMEDIATELY (§10.3).
   */
  drain(): void {
    if (this.detached) return;
    if (DEV && this.world.runtime.inObserverEmitActive) {
      // The P2-R InboundSource.drain obligation (005 §5.5): a drain mid-`notify()` would HALF-apply a
      // batch (unguarded projection primitives land, guarded structural mutators are swallowed).
      // `world.sync()` already checks this on the sync path; a source drained by any other caller still
      // owes the assert at entry.
      throw new Error(
        "strata: durable drain() cannot run from inside an observer or reactive callback — it would half-apply a ChangeBatch; drain at the frame boundary (005 §5.5).",
      );
    }
    this.applied = 0; // per-drain apply tally (006 C7) — bumped by the CountingProjector + the resource sites
    const remote = this.store.drainPending();
    const local = this.pendingLocal;
    this.pendingLocal = [];
    for (const batch of remote) this.reconcileBatch(batch);
    for (const batch of local) this.reconcileBatch(batch);
    // The held-cell sweep runs at the END of EVERY drain — including drains with empty queues, because a
    // drag reconverges to baseline BETWEEN drains (during ticks), and `world.sync()` drains us every frame
    // (006 C5, decision G). It is the only path that catches the silent-reconverge case.
    this.sweep();
    // DurableSyncStatus (006 C7): advance lastAppliedFrame ONLY when this drain applied ≥1 fact (never
    // per-drain), then publish set-on-change. An empty/no-op drain leaves every field fixed, so the
    // set-on-change gate writes nothing and no useResource panel re-renders (the idle guarantee).
    if (this.applied > 0) this.lastAppliedFrame++;
    this.publishSyncStatus();
  }

  /**
   * Reconcile one commit's batch. NORMALIZE first (collapse to the final fact per cell, spawn-first /
   * despawn-last preserved) so each cell reconciles once, classified against the PRE-batch baseline
   * (§13.3). ATOMIC: the loop runs to completion with no user code between facts, so within-batch
   * transient states (a spawn placed empty before its components migrate it) are never observable.
   */
  private reconcileBatch(batch: ChangeBatch): void {
    // Each normalized fact carries its origin (the batch is single-origin); the value matrix branches on
    // `ev.origin` (§13.3, decision B). Structure applies identically for own and remote.
    for (const ev of normalizeBatch(batch.events)) this.reconcile(ev);
  }

  /**
   * Apply one normalized doc-fact — the reconcile matrix (§13.3, decision B). Structural facts (spawn /
   * despawn / component add-or-remove / tag / relation) reach the runtime ONLY here (own is its only path
   * to the change; remote has no in-flight divergence to protect). `component-set` is CLASSIFIED against the
   * pre-batch baseline: baseline-absent ⇒ structural ADD, baseline-present ⇒ the drag-protected VALUE matrix
   * (§13.3 table). THE UNIFYING PRINCIPLE (M4R): an own-origin echo is COMMIT-TIME-STALE, so EVERY apply it
   * drives — value AND structural — honors the doc's CONVERGED state re-read at drain time (decision F,
   * {@link convergedComponent}), not the batch payload; the payload drives only classification + the
   * malformed reject. So a structural ADD re-reads converged (applies the LWW winner, or NOTHING if the doc
   * deleted the cell), an own component-REMOVE re-reads converged (keeps the cell if a concurrent set won),
   * and a DESPAWN reconciles the surviving entity per cell ({@link reconcileSurvivingDespawn}). A held-cell
   * entry is CLEARED by any structural fact on its cell (supersession (c)) and by any applied value fact
   * (supersession (a)); the local commit's agreement clears it via the `clearHeld` seam (rule (b)).
   */
  private reconcile(ev: ChangeEvent): void {
    switch (ev.kind) {
      case "spawn":
        this.projector.applySpawn(ev.key);
        this.baseline.spawn(ev.key);
        break;
      case "despawn":
        // A despawn is a WHOLE-ENTITY fact, but the doc converges PER CELL — a concurrent remote SET can win
        // an LWW against the despawn (loro-snapshot's partial-cell resurrection), leaving the entity ALIVE in
        // the converged doc even though its `exists` cell was removed (which is what SURFACED the despawn
        // fact). So a despawn is commit-time-stale for BOTH origins (the unifying principle): a blind
        // projector.remove would tear down a live entity + its bijection and diverge from the doc. Reconcile
        // per cell against converged truth and KEEP the entity when any cell survives.
        //
        // NB the M4R review scoped this to own-origin, reasoning remote structural facts converge from the
        // frontier diff — TRUE for component-remove (the fact simply does not fire when a set wins the cell)
        // but FALSE for despawn: `exists` has no concurrent writer, so the despawn fact fires and its
        // whole-entity removal nukes the surviving cells. A probe confirmed the remote-side divergence (a set
        // that won LWW is lost on the peer that drains the despawn in a LATER drain than its own set-echo).
        if (this.reconcileSurvivingDespawn(ev.key)) break;
        // Fully-gone (the doc agrees the entity has no surviving cell): structural on EVERY cell (§13.3 (c)).
        // Drop the entity's held entries FIRST, so the sweep can't resolve `key` to a fresh handle and
        // resurrect a despawned component (006 C5 (c)).
        this.clearHeldForEntity(ev.key);
        this.projector.remove(ev.key); // both-directions relation cleanup + unbind
        this.baseline.despawn(ev.key); // baseline analogue of the runtime's both-directions cleanup
        break;
      case "component-set": {
        this.assertNoEidFields(ev.comp);
        const gate = tryCanon(ev.comp, ev.value);
        if (!gate.ok) {
          this.warnCanonReject(`${ev.key}|${ev.comp.name}`, ev.comp.name, gate.field, gate.reason);
          break; // reject touches NEITHER runtime nor baseline (§2.3) — the prior cell stands
        }
        if (this.baseline.getComponent(ev.key, ev.comp) === undefined) {
          // baseline absent → structural ADD. THE UNIFYING PRINCIPLE (decision F, extended to structural
          // echoes): an own-origin echo is COMMIT-TIME-STALE, so the apply must honor the doc's CONVERGED
          // state re-read at drain time — NOT the batch payload. The load-bearing case: A commits a VALUE to
          // present C; B concurrently removeComponent(C) (or destroy) and WINS LWW; A drains remote-first
          // (decision E) — the remote-remove clears the baseline, so A's own value-echo now reclassifies
          // HERE as a structural ADD. Re-applying the stale payload would resurrect a zombie cell the doc
          // deleted (runtime==baseline self-conceals it — it survives a full re-sync). So apply the CONVERGED
          // re-read instead: if the doc still holds the cell, apply the LWW winner; if the doc deleted it
          // (converged undefined — we lost the race), apply NOTHING (runtime + baseline stay absent). A clean
          // first add re-reads the value we just committed (a no-op change); concurrent add-vs-add applies
          // the LWW winner. Drain ORDER is load-bearing here — see decision E.
          const converged = this.convergedComponent(ev.key, ev.comp);
          if (converged !== undefined) {
            this.projector.applyComponent(ev.key, ev.comp, converged);
            this.baseline.setComponent(ev.key, ev.comp, converged);
          }
          this.onStructuralCell(ev.key, ev.comp); // (c) clear a stale hold + reset the stranded counter
        } else {
          // baseline present → the drag-protected VALUE matrix (§13.3, decision B/F).
          this.reconcileComponentValue(ev);
        }
        break;
      }
      case "component-remove":
        this.assertNoEidFields(ev.comp);
        if (this.baseline.getComponent(ev.key, ev.comp) === undefined) break; // baseline absent → no-op
        if (ev.origin === "local") {
          // OWN remove echo is commit-time-stale (the unifying principle, fix 2): a concurrent remote SET
          // may have WON LWW between our removeComponent commit and this drain. Honor the CONVERGED doc — if
          // the cell is PRESENT (the set won), apply the converged value as a value write instead of
          // removing; else we remove a cell the doc keeps and diverge (runtime==baseline self-conceals it).
          // A remote remove echo needs no re-read — it arrives as a converged transition from the frontier
          // diff, already reflecting the winning LWW.
          const converged = this.convergedComponent(ev.key, ev.comp);
          if (converged !== undefined) {
            this.projector.applyComponent(ev.key, ev.comp, converged);
            this.baseline.setComponent(ev.key, ev.comp, converged);
            this.onStructuralCell(ev.key, ev.comp); // reconverged the cell — clear a stale hold + reset stranded
            break;
          }
        }
        this.projector.removeComponent(ev.key, ev.comp);
        this.baseline.removeComponent(ev.key, ev.comp);
        this.onStructuralCell(ev.key, ev.comp); // (c): else the sweep's add-if-absent resurrects the component
        break;
      case "tag-add":
        this.projector.applyTag(ev.key, ev.tag);
        this.baseline.addTag(ev.key, ev.tag);
        break;
      case "tag-remove":
        this.projector.removeTag(ev.key, ev.tag);
        this.baseline.removeTag(ev.key, ev.tag);
        break;
      case "relation-set":
        this.projector.applyRelationSet(ev.key, ev.rel, ev.target);
        this.baseline.setRelation(ev.key, ev.rel, ev.target);
        break;
      case "relation-add":
        this.projector.applyRelationAdd(ev.key, ev.rel, ev.target);
        this.baseline.addRelation(ev.key, ev.rel, ev.target);
        break;
      case "relation-remove":
        this.projector.removeRelation(ev.key, ev.rel, ev.target);
        this.baseline.removeRelation(ev.key, ev.rel, ev.target);
        break;
      case "resource-set": {
        const gate = tryCanonResource(ev.res, ev.value);
        if (!gate.ok) {
          this.warnCanonReject(`res:${ev.res.name}`, ev.res.name, gate.field, gate.reason);
          break;
        }
        // Every resource-set is a VALUE reconcile (§13.4: resources have no structure) — the cardinality-
        // one sibling of the component value matrix, including the drag-in-flight drop + hold.
        this.reconcileResourceValue(ev);
        break;
      }
      case "resource-remove":
        // §13.4's "one exception" — the structural-ish resource fact. Always apply; clear the hold (c).
        this.world.runtime.removeResource(ev.res); // resources bypass the kernel (§10.8 sibling note)
        this.baseline.removeResource(ev.res);
        this.applied++; // an applied resource fact (006 C7) — resources bypass the CountingProjector
        this.heldRes.delete(ev.res.name);
        this.resetStranded(`res:${ev.res.name}`);
        break;
    }
  }

  // --- the value matrix: drag-protection, converged re-read, the held-cell ledger (§13.3, 006 C5) ----

  /**
   * The `(own|remote, value)` matrix for a component cell whose baseline is present (§13.3, decision B/F).
   * The drag-in-flight detector is `cellEquals(runtime, baseline)` (005 §2.2) — no gesture flag, the
   * divergence IS the signal. The APPLIED value is always the doc's CONVERGED re-read (decision F), never
   * the batch payload:
   * - **(own, value):** agreed ⇒ apply converged + advance baseline (a no-op unless a concurrent remote
   *   won LWW between commit and this sync — then it corrects the runtime, the stale-echo fix); a local
   *   re-drag in flight ⇒ advance the **baseline only**, runtime left to the drag (the §13.3 asymmetry:
   *   an own echo is a value we authored, so it is banked baseline truth even mid-drag).
   * - **(remote, value):** agreed ⇒ apply converged + advance baseline (AGREEMENT); a local drag in
   *   flight ⇒ DROP from the runtime, baseline UNTOUCHED, and bank the converged value in the held-cell
   *   ledger (006 C5) so the silent-reconverge case can recover it. DROP is a real remote-change reject —
   *   it feeds the stranded counter.
   */
  private reconcileComponentValue(ev: Extract<ChangeEvent, { kind: "component-set" }>): void {
    const { key, comp, origin } = ev;
    const agreed = cellEquals(this.runtimeComponent(key, comp), this.baseline.getComponent(key, comp));
    const converged = this.convergedComponent(key, comp);

    if (agreed) {
      // No local drag in flight (own OR remote): apply the converged truth + advance the baseline. An
      // applied value fact supersedes any hold (006 C5 (a)) and reconverges the cell (stranded reset).
      if (converged !== undefined) {
        this.projector.applyComponent(key, comp, converged);
        this.baseline.setComponent(key, comp, converged);
      }
      this.clearHeldComponent(key, comp);
      this.resetStranded(this.cellKey(key, comp));
    } else if (origin === "local") {
      // A local re-drag is in flight — do NOT stomp it; advance the baseline to converged truth ONLY, so
      // the next remote compare is against the right value. Do NOT clear a hold: a newer remote value
      // banked during the re-drag must survive to be swept when the re-drag ends (§13.3).
      if (converged !== undefined) this.baseline.setComponent(key, comp, converged);
    } else {
      // (remote, value) with a local drag in flight → the one DROP. Runtime + baseline untouched; bank the
      // converged value so a drag that reconverges to baseline WITHOUT committing still recovers it (C5).
      const ck = this.cellKey(key, comp);
      const banked = converged !== undefined; // a malformed/absent converged value banks NOTHING
      if (banked) this.held.set(ck, { key, comp, value: converged });
      // Only a REAL banked drop feeds the stranded counter (a malformed converged value is an inbound-reject
      // concern (006 B4), not a stranded cell); pass the just-computed `banked` state, not a re-read held.has.
      if (DEV && banked) this.countDrop(ck, `${key}|${comp.name}`, banked);
    }
  }

  /** The resource value matrix — the cardinality-one sibling of {@link reconcileComponentValue} (§13.4). */
  private reconcileResourceValue(ev: Extract<ChangeEvent, { kind: "resource-set" }>): void {
    const { res, origin } = ev;
    const agreed = cellEquals(
      this.world.runtime.getResource(res) as ComponentValue | undefined,
      this.baseline.getResource(res),
    );
    const converged = this.convergedResource(res);

    if (agreed) {
      if (converged !== undefined) {
        this.world.runtime.setResource(res, converged); // resources bypass the kernel (§10.8)
        this.baseline.setResource(res, converged);
        this.applied++; // an applied resource fact (006 C7) — resources bypass the CountingProjector
      }
      this.heldRes.delete(res.name);
      this.resetStranded(`res:${res.name}`);
    } else if (origin === "local") {
      if (converged !== undefined) this.baseline.setResource(res, converged); // baseline-only (own asymmetry)
    } else {
      const banked = converged !== undefined;
      if (banked) this.heldRes.set(res.name, { res, value: converged });
      if (DEV && banked) this.countDrop(`res:${res.name}`, `resource "${res.name}"`, banked);
    }
  }

  /**
   * Reconcile an entity against the converged doc on a despawn fact whose entity SURVIVED a per-cell LWW
   * (fix 2 — the unifying principle: honor converged truth at drain time). The despawn may have LOST cells
   * to a concurrent remote (loro-snapshot's partial-cell resurrection: a set concurrent with a despawn
   * leaves that one cell alive), so the entity can still be ALIVE in the converged document. If the doc
   * holds NO cell for the key, return false and let the caller run the real despawn. Otherwise reconcile
   * each cell to converged truth (converged-present → value write; converged-absent → remove) and KEEP the
   * entity + its bijection, returning true. Applies to BOTH origins (see the despawn dispatch note — a
   * remote despawn diverges the same way). The entity's INCOMING edges ride their own relation-remove facts
   * (normalizeBatch folds only the entity's OWN cells into the despawn), so this reconciles the key's OWN
   * cells: components, tags, outgoing relations.
   */
  private reconcileSurvivingDespawn(key: EntityKey): boolean {
    const snap = this.store.snapshot;
    if (!snap.hasEntity(key)) return false; // the doc agrees the entity is fully gone → despawn it
    const docRec = snap.readEntity(key);
    if (docRec === undefined) return false; // defensive: hasEntity but no record → despawn
    const baseRec = this.baseline.readEntity(key);

    // Components: converged-present → apply the LWW value; converged-absent → remove (§13.3, per cell).
    for (const name of unionNames(baseRec?.components, docRec.components)) {
      const comp = componentByName(name);
      if (comp === undefined) continue; // unknown component — never projected (006 B3 R1)
      const converged = this.convergedComponent(key, comp);
      if (converged !== undefined) {
        this.projector.applyComponent(key, comp, converged);
        this.baseline.setComponent(key, comp, converged);
      } else if (this.baseline.getComponent(key, comp) !== undefined) {
        this.projector.removeComponent(key, comp);
        this.baseline.removeComponent(key, comp);
      }
      this.onStructuralCell(key, comp); // the cell reconverged/removed — clear a stale hold + reset stranded
    }

    // Tags: the doc holds it → add; else → remove.
    for (const name of unionList(baseRec?.tags, docRec.tags)) {
      const tag = tagByName(name);
      if (tag === undefined) continue;
      if (snap.hasTag(key, tag)) {
        this.projector.applyTag(key, tag);
        this.baseline.addTag(key, tag);
      } else {
        this.projector.removeTag(key, tag);
        this.baseline.removeTag(key, tag);
      }
    }

    // Outgoing relations: reconcile each slot to the doc, arity-split (setRelation/getRelationOne vs
    // addRelation/getRelationMany), converging targets present/absent in the doc.
    for (const name of unionNames(baseRec?.relations, docRec.relations)) {
      const rel = relationByName(name);
      if (rel === undefined) continue;
      if (rel.arity === "one") {
        const docTarget = snap.getRelationOne(key, rel);
        if (docTarget !== undefined) {
          this.projector.applyRelationSet(key, rel, docTarget);
          this.baseline.setRelation(key, rel, docTarget);
        } else {
          const baseTarget = this.baseline.getRelationOne(key, rel);
          if (baseTarget !== undefined) {
            this.projector.removeRelation(key, rel, baseTarget);
            this.baseline.removeRelation(key, rel, baseTarget);
          }
        }
      } else {
        const docTargets = new Set(snap.getRelationMany(key, rel));
        for (const t of this.baseline.getRelationMany(key, rel)) {
          if (!docTargets.has(t)) {
            this.projector.removeRelation(key, rel, t);
            this.baseline.removeRelation(key, rel, t);
          }
        }
        for (const t of docTargets) {
          this.projector.applyRelationAdd(key, rel, t);
          this.baseline.addRelation(key, rel, t);
        }
      }
    }
    return true;
  }

  /**
   * The end-of-drain sweep (006 C5, decision G). For each surviving held cell, the moment it reconverges
   * (`cellEquals(runtime, baseline)` NOW holds — the drag ended without a commit) apply the CONVERGED
   * re-read of the doc, NOT the banked value (fix 3, the unifying principle: honor converged truth at drain
   * time). A held entry now only MARKS "a remote value is pending on this cell"; between the drop and this
   * sweep a fact the supersession rules SHOULD have caught (the (b) hole was one) may have changed converged
   * truth — so re-reading is the safety net. If converged truth VANISHED (the doc no longer holds the cell),
   * drop the hold WITHOUT applying — never resurrect a value the document deleted. Sweep-applies STAMP
   * (projector writes), so reactivity observes the recovered value this frame (006 C2). A held cell whose
   * baseline vanished is dropped, not resurrected (structural facts already clear such entries).
   */
  private sweep(): void {
    for (const [ck, e] of this.held) {
      const baselineVal = this.baseline.getComponent(e.key, e.comp);
      if (baselineVal === undefined) {
        this.held.delete(ck); // the component is gone — nothing to reconverge onto (never resurrect)
        continue;
      }
      if (!cellEquals(this.runtimeComponent(e.key, e.comp), baselineVal)) continue; // still mid-drag → hold
      const converged = this.convergedComponent(e.key, e.comp); // re-read truth, not the banked value
      this.held.delete(ck);
      this.resetStranded(ck); // the cell reconverged → agreement, whether or not a value is applied
      if (converged === undefined) continue; // the doc dropped the cell — drop the hold, do NOT resurrect
      this.projector.applyComponent(e.key, e.comp, converged);
      this.baseline.setComponent(e.key, e.comp, converged);
    }
    for (const [name, e] of this.heldRes) {
      const baselineVal = this.baseline.getResource(e.res);
      if (baselineVal === undefined) {
        this.heldRes.delete(name);
        continue;
      }
      if (!cellEquals(this.world.runtime.getResource(e.res) as ComponentValue | undefined, baselineVal)) continue;
      const converged = this.convergedResource(e.res); // re-read truth, not the banked value
      this.heldRes.delete(name);
      this.resetStranded(`res:${name}`);
      if (converged === undefined) continue; // the doc dropped the resource — drop the hold
      this.world.runtime.setResource(e.res, converged);
      this.baseline.setResource(e.res, converged);
      this.applied++; // a swept-in resource fact (006 C7) — resources bypass the CountingProjector
    }
  }

  // --- value-matrix helpers (§13.3, decision F) -----------------------------------------------------

  /** The runtime's current value for a component cell, or undefined (unbound key / absent) — the compare LHS. */
  private runtimeComponent(key: EntityKey, comp: Component): ComponentValue | undefined {
    const h = this.projector.handleFor(key);
    return h === undefined ? undefined : (this.world.runtime.get(h, comp) as ComponentValue | undefined);
  }

  /**
   * The document's CONVERGED component value, canonicalized to LOCAL schema (R4-stripped), or undefined if
   * absent-or-unreadable. Re-read at DRAIN time (decision F): NEVER the batch payload, so a concurrent
   * remote that won LWW between an own commit and this sync is honored, not clobbered. A hostile/malformed
   * converged value reads as undefined (skip the apply) — it cannot strand, matching the inbound gate (§2.3).
   */
  private convergedComponent(key: EntityKey, comp: Component): ComponentValue | undefined {
    const raw = this.store.snapshot.getComponent(key, comp);
    if (raw === undefined) return undefined;
    const gate = tryCanon(comp, raw);
    return gate.ok ? gate.value : undefined;
  }

  /** The resource sibling of {@link convergedComponent} — object-backed, canonicalized via `tryCanonResource`. */
  private convergedResource(res: Resource): ComponentValue | undefined {
    const raw = this.store.snapshot.getResource(res);
    if (raw === undefined) return undefined;
    const gate = tryCanonResource(res, raw);
    return gate.ok ? gate.value : undefined;
  }

  // --- the held-cell ledger + stranded counter (006 C5, §13.5) --------------------------------------

  /** Injection-proof per-cell key (005 §10.4): a JSON tuple a hostile `EntityKey` cannot collide. */
  private cellKey(key: EntityKey, comp: Component): string {
    return JSON.stringify([key, comp.name]);
  }

  /** A structural fact on a cell (add/remove) clears any hold (006 C5 (c)) and resets its stranded counter. */
  private onStructuralCell(key: EntityKey, comp: Component): void {
    this.clearHeldComponent(key, comp);
    this.resetStranded(this.cellKey(key, comp));
  }

  private clearHeldComponent(key: EntityKey, comp: Component): void {
    this.held.delete(this.cellKey(key, comp));
  }

  /** Drop every held entry for `key` — the despawn case of supersession (c) (both-directions, like the runtime). */
  private clearHeldForEntity(key: EntityKey): void {
    for (const [ck, e] of this.held) {
      if (e.key === key) {
        this.held.delete(ck);
        this.resetStranded(ck); // also clear the cell's dropCount / strandedWarned — they track the hold
      }
    }
  }

  /**
   * The stranded-cell DEV counter (§13.5, decision H): count consecutive remote-value drops per cell, warn
   * ONCE past {@link STRANDED_WARN_THRESHOLD} with the spec's message shape (name the cell, explain
   * commit-or-write-back, note the held count and no-abort). Reset on agreement ({@link resetStranded}).
   * DEV-only — the whole counter compiles out of production.
   */
  private countDrop(ck: string, display: string, held: boolean): void {
    const n = (this.dropCount.get(ck) ?? 0) + 1;
    this.dropCount.set(ck, n);
    if (n >= STRANDED_WARN_THRESHOLD && !this.strandedWarned.has(ck)) {
      this.strandedWarned.add(ck);
      devWarn(
        `cell ${display} has dropped ${n} remote changes in a row — it looks stranded (${held ? 1 : 0} held ` +
          `value outstanding). A runtime edit diverged this cell from its baseline and never committed, so ` +
          `remote changes keep being skipped. Commit the edit, or if you meant to discard it, write the ` +
          `converged value back yourself (read it from the document, then commit). The framework does not ` +
          `abort/roll back (§13.5).`,
      );
    }
  }

  /** Reset a cell's stranded counter on agreement — and re-arm its one-shot warning (§13.5). */
  private resetStranded(ck: string): void {
    this.dropCount.delete(ck);
    this.strandedWarned.delete(ck);
  }

  // --- teardown: the four steps, IN ORDER (005 §5.6) ------------------------------------------------

  /**
   * Detach — the four-step teardown (§5.6), in order, so no queued-but-undrained batch can project into a
   * torn-down binding. Idempotent (a second `detach()` is a no-op). Re-attaching the store afterward is a
   * FRESH projection with FRESH handles (§13.1): the durable keys are the stable identity; a cached
   * handle is valid only within one attach lifetime.
   */
  teardown(): void {
    if (this.detached) return;
    this.detached = true;
    this.world.unregisterInboundSource(this); // 0. stop world.sync() from ever draining us again
    this.unsubscribe?.(); // 1. stop new local echoes arriving
    this.pendingLocal = []; // 2. discard queued-but-undrained echoes ...
    this.store.drainPending(); // ... and any queued-but-undrained remote batches on the store
    this.held.clear(); // drop the held-cell ledger + counters — a re-attach is a fresh founding agreement
    this.heldRes.clear();
    this.dropCount.clear();
    this.strandedWarned.clear();
    this.projector.teardown(); // 3. despawn every projected entity + clear the bijection
    this.store.setBijection(null); // handle-addressed reads return undefined between attachments (§14.3)
    this.store.setTxRuntime(null); // doc.transaction throws again once detached (no projector to mint)
    this.store.setInboundListener(null); // stop republishing sync status on remote enqueue (006 C7)
    this.world.removeResource(DurableSyncStatus); // runtime-local status is gone once detached (useResource → undefined)
    ATTACHED.delete(this.store); // mark re-attachable
  }

  // --- diagnostics ---------------------------------------------------------------------------------

  /**
   * DEV-throw if `comp` declares any `eid` field (005 §7) — a replicated component MUST reference entities
   * with `key` fields, not packed runtime handles. Memoized per ComponentId (decision C): validated once
   * at first durable appearance, then skipped. A runtime-only component with `eid` fields never reaches
   * here, so it stays legal.
   */
  private assertNoEidFields(comp: Component): void {
    if (this.validatedComponents.has(comp.id)) return;
    if (DEV) {
      for (const f of comp.fields) {
        if (f.spec.type === "eid") {
          throw new Error(
            `strata: durable component "${comp.name}" declares an eid field "${f.name}" — an eid is a packed runtime handle, meaningless across sessions. Reference entities with a key field instead (005 §7).`,
          );
        }
      }
    }
    this.validatedComponents.add(comp.id);
  }

  /** One-shot DEV warn per rejected cell (005 §2.3): a malformed inbound value touched neither side. */
  private warnCanonReject(dedupe: string, name: string, field: string, reason: string): void {
    if (this.warned.has(dedupe)) return;
    this.warned.add(dedupe);
    devWarn(
      `inbound value for "${name}" field "${field}" rejected (${reason}) — dropped, touching neither runtime nor baseline (005 §2.3).`,
    );
  }

  /** One-shot DEV diagnostic per unresolved durable name (006 B3 R1) — skipped, never misbound. */
  private warnUnknownName(kind: string, name: string): void {
    const dedupe = `name:${kind}:${name}`;
    if (this.warned.has(dedupe)) return;
    this.warned.add(dedupe);
    devWarn(`attach saw an unknown ${kind} name "${name}" — skipped (no schema object resolves it; 006 §B3).`);
  }
}

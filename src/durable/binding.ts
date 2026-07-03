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
 *     order). Loro carries CONVERGED values on both paths, so the final runtime state converges; the
 *     order becomes load-bearing only in M4, where the drag-protection §13.5 flow is remote-then-echo
 *     anyway (a remote value drops mid-drag, the local commit's echo then agrees).
 */

import { DEV, devWarn } from "../core/dev";
import type { Component, ComponentId, Entity, EntityKey, InboundSource, Resource, World } from "../core";
import {
  BaselineSnapshot,
  Projector,
  cellEquals,
  componentByName,
  normalizeBatch,
  relationByName,
  tagByName,
  tryCanon,
  tryCanonResource,
} from "../substrate";
import type { ChangeBatch, ChangeEvent, ComponentValue, EntityRecord, Snapshot, Unsubscribe } from "../substrate";
import type { DurableBijection, DurableStore } from "./durable-store";
import type { TxRuntime } from "./transaction";

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

/** One held-off remote COMPONENT value (006 C5): the cell + the converged value banked at drop time. */
interface HeldComponent {
  readonly key: EntityKey;
  readonly comp: Component;
  readonly value: ComponentValue;
}

/** One held-off remote RESOURCE value — the cardinality-one sibling of {@link HeldComponent}. */
interface HeldResource {
  readonly res: Resource;
  readonly value: ComponentValue;
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
  ATTACHED.add(store);

  return { detach: () => binding.teardown(), baseline: binding.baselineView };
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

  constructor(
    private readonly world: World,
    private readonly store: DurableStore,
  ) {
    this.projector = new Projector(world.runtime, () => store.mintKey());
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
  }

  /** Subscribe to the snapshot for LOCAL echoes only (decision D) — enqueue, never apply (§12.4). */
  subscribeLocalEchoes(): void {
    this.unsubscribe = this.store.snapshot.subscribe((batch) => {
      if (batch.origin === "local") this.pendingLocal.push(batch);
    });
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
    const remote = this.store.drainPending();
    const local = this.pendingLocal;
    this.pendingLocal = [];
    for (const batch of remote) this.reconcileBatch(batch);
    for (const batch of local) this.reconcileBatch(batch);
    // The held-cell sweep runs at the END of EVERY drain — including drains with empty queues, because a
    // drag reconverges to baseline BETWEEN drains (during ticks), and `world.sync()` drains us every frame
    // (006 C5, decision G). It is the only path that catches the silent-reconverge case.
    this.sweep();
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
   * despawn / component add-or-remove / tag / relation) always apply and advance the baseline (own is the
   * runtime's only path to the change; remote has no in-flight divergence to protect). `component-set` is
   * CLASSIFIED against the pre-batch baseline: baseline-absent ⇒ structural ADD, baseline-present ⇒ the
   * drag-protected VALUE matrix (§13.3 table). Every value APPLY re-reads the doc's CONVERGED value
   * (decision F); the batch payload drives only classification and the malformed reject. A held-cell
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
        // Structural on EVERY cell of the entity (§13.3 (c)): drop the entity's held entries FIRST, so the
        // sweep can't resolve `key` to a fresh handle and resurrect a despawned component (006 C5 (c)).
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
          // baseline absent → structural ADD (own or remote): always apply, advance baseline (§13.3 row 1),
          // UNCHANGED from the pre-matrix path. No converged re-read is needed here: a concurrent add of
          // the SAME component on another peer arrives with the cell baseline-PRESENT, so it classifies as
          // a value write and re-reads the converged (LWW) value on that path — convergence still holds.
          this.projector.applyComponent(ev.key, ev.comp, gate.value);
          this.baseline.setComponent(ev.key, ev.comp, gate.value);
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
      if (converged !== undefined) this.held.set(ck, { key, comp, value: converged });
      if (DEV) this.countDrop(ck, `${key}|${comp.name}`, this.held.has(ck));
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
      }
      this.heldRes.delete(res.name);
      this.resetStranded(`res:${res.name}`);
    } else if (origin === "local") {
      if (converged !== undefined) this.baseline.setResource(res, converged); // baseline-only (own asymmetry)
    } else {
      if (converged !== undefined) this.heldRes.set(res.name, { res, value: converged });
      if (DEV) this.countDrop(`res:${res.name}`, `resource "${res.name}"`, this.heldRes.has(res.name));
    }
  }

  /**
   * The end-of-drain sweep (006 C5, decision G). For each surviving held cell, apply the banked value the
   * moment it reconverges (`cellEquals(runtime, baseline)` NOW holds — the drag ended without a commit).
   * The applied value is the banked converged truth from drop time; nothing changed the cell since (any
   * applied fact, commit, or structural fact would have cleared the entry — supersession (a)/(b)/(c)), so
   * the bank IS the current converged value. Sweep-applies STAMP (projector writes), so reactivity
   * observes the recovered value this frame (006 C2). A held cell whose baseline vanished is dropped, not
   * resurrected (defensive; structural facts already clear such entries).
   */
  private sweep(): void {
    for (const [ck, e] of this.held) {
      const baselineVal = this.baseline.getComponent(e.key, e.comp);
      if (baselineVal === undefined) {
        this.held.delete(ck); // the component is gone — nothing to reconverge onto (never resurrect)
        continue;
      }
      if (!cellEquals(this.runtimeComponent(e.key, e.comp), baselineVal)) continue; // still mid-drag → hold
      this.projector.applyComponent(e.key, e.comp, e.value);
      this.baseline.setComponent(e.key, e.comp, e.value);
      this.held.delete(ck);
      this.resetStranded(ck);
    }
    for (const [name, e] of this.heldRes) {
      const baselineVal = this.baseline.getResource(e.res);
      if (baselineVal === undefined) {
        this.heldRes.delete(name);
        continue;
      }
      if (!cellEquals(this.world.runtime.getResource(e.res) as ComponentValue | undefined, baselineVal)) continue;
      this.world.runtime.setResource(e.res, e.value);
      this.baseline.setResource(e.res, e.value);
      this.heldRes.delete(name);
      this.resetStranded(`res:${name}`);
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
    for (const [ck, e] of this.held) if (e.key === key) this.held.delete(ck);
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

/**
 * The durable binding — Part III **M2** (docs/plan-part3.md; design.md §12.4, §13.1–§13.3).
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
 *  B. **The drain applies VALUE facts unconditionally in M2** — a provisional stand-in for M4's
 *     drag-protected `(own|remote, value)` matrix + held-cell ledger. Structural facts already apply
 *     unconditionally for good (own is the runtime's only path to the change; remote has no in-flight
 *     divergence to protect, §13.3). The value branch is isolated in {@link DurableBinding.applyInboundValue}
 *     behind one `TODO(M4)` so M4 swaps exactly that one branch.
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
  componentByName,
  normalizeBatch,
  relationByName,
  tagByName,
  tryCanon,
  tryCanonResource,
} from "../substrate";
import type { ChangeBatch, ChangeEvent, ComponentValue, EntityRecord, Snapshot, Unsubscribe } from "../substrate";
import type { DurableBijection, DurableStore } from "./durable-store";

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
  }

  /**
   * Reconcile one commit's batch. NORMALIZE first (collapse to the final fact per cell, spawn-first /
   * despawn-last preserved) so each cell reconciles once, classified against the PRE-batch baseline
   * (§13.3). ATOMIC: the loop runs to completion with no user code between facts, so within-batch
   * transient states (a spawn placed empty before its components migrate it) are never observable.
   */
  private reconcileBatch(batch: ChangeBatch): void {
    // M4 will branch the value path on `batch.origin`; M2 applies own and remote identically (decision B).
    for (const ev of normalizeBatch(batch.events)) this.reconcile(ev);
  }

  /**
   * Apply one normalized doc-fact. Structural facts (spawn / despawn / component add / remove / tag /
   * relation) always apply and advance the baseline. `component-set` is classified against the baseline:
   * baseline-absent ⇒ structural ADD, baseline-present ⇒ VALUE write (§13.3 table). `component-remove`
   * on a baseline-absent cell is a no-op (never existed). Inbound values pass the `tryCanon` gate BEFORE
   * any apply or baseline write (005 §2.3) — a reject touches neither side.
   */
  private reconcile(ev: ChangeEvent): void {
    switch (ev.kind) {
      case "spawn":
        this.projector.applySpawn(ev.key);
        this.baseline.spawn(ev.key);
        break;
      case "despawn":
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
          // baseline absent → structural ADD (own or remote): always apply, advance baseline (§13.3).
          this.projector.applyComponent(ev.key, ev.comp, gate.value);
          this.baseline.setComponent(ev.key, ev.comp, gate.value);
        } else {
          // baseline present → VALUE write. The one branch M4 swaps.
          this.applyInboundValue(ev.key, ev.comp, gate.value);
        }
        break;
      }
      case "component-remove":
        this.assertNoEidFields(ev.comp);
        if (this.baseline.getComponent(ev.key, ev.comp) === undefined) break; // baseline absent → no-op
        this.projector.removeComponent(ev.key, ev.comp);
        this.baseline.removeComponent(ev.key, ev.comp);
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
        // Resource value — the value-path sibling of applyInboundValue; M4 drag-protects it too.
        this.setResourceValue(ev.res, gate.value);
        break;
      }
      case "resource-remove":
        this.world.runtime.removeResource(ev.res); // resources bypass the kernel (§10.8 sibling note)
        this.baseline.removeResource(ev.res);
        break;
    }
  }

  /**
   * TODO(M4): drag-protected (own,value)/(remote,value) matrix + held-cell ledger replaces this
   * unconditional apply. M2 applies EVERY inbound value to runtime + baseline regardless of origin or an
   * in-flight local drag (§13.3's guard is not built yet). The value is already canonical (past the
   * `tryCanon` gate), so `applyComponent` (add-if-absent-else-write) writes it and the baseline banks it.
   */
  private applyInboundValue(key: EntityKey, comp: Component, value: ComponentValue): void {
    this.projector.applyComponent(key, comp, value);
    this.baseline.setComponent(key, comp, value);
  }

  /** The resource sibling of {@link applyInboundValue} — bypasses the kernel (§10.8). Same M4 TODO. */
  private setResourceValue(res: Resource, value: ComponentValue): void {
    this.world.runtime.setResource(res, value);
    this.baseline.setResource(res, value);
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
    this.projector.teardown(); // 3. despawn every projected entity + clear the bijection
    this.store.setBijection(null); // handle-addressed reads return undefined between attachments (§14.3)
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

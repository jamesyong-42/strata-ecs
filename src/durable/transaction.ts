/**
 * The transaction — Part III **M3** (docs/plan-part3.md; design.md §11.2, §12, §13.2).
 *
 * `doc.transaction(fn)` is the durable layer's UPWARD boundary — the ONE way app code changes the
 * document (design.md §12). It runs `fn` synchronously, letting it record a batch of mutations
 * through the `tx` {@link Mutator}, then seals that batch as ONE Loro commit and returns `fn`'s
 * result. `transaction` lives on the {@link DurableStore} (the `DurableTarget`), reached here through
 * the {@link TxRuntime} seam the binding installs at attach — never on the world (§12.1/§12.4).
 *
 * The split this file implements (design.md §12, the value/structure timing rule):
 *   - **identity** is minted at RECORD time — `tx.spawn` calls `runtime.allocateIdentity` + the
 *     projector's `createPair` and returns a real, usable handle immediately (§12.2);
 *   - **value writes to PRE-EXISTING components** apply to runtime + document + baseline
 *     SYNCHRONOUSLY at seal — this is the agreement point that erases in-flight local divergence
 *     (§13.2 rule 2), and it is the only tx effect the runtime learns without projection;
 *   - **all structure** (spawns, add/remove component, tags, relations, despawns) touches ONLY the
 *     document at seal; the runtime learns it — and the baseline advances — via projection at the
 *     next `world.sync()` (§12.3, §13.3). Writing the structural baseline here would push it AHEAD
 *     of the runtime and misreconcile a concurrent remote change (§12.3), so it is forbidden.
 *
 * ============================================================================================
 * DECISIONS (load-bearing; see the task brief + the cited spec)
 * ============================================================================================
 *  A. **ATOMIC-ABORT is THIS layer's job — the recorder buffers, the executor writes.** Loro's
 *     `commit(body)` seals whatever a throwing body staged (loro-snapshot.ts:606 finally-seal), so
 *     the transaction must NOT touch the document while `fn` runs. `tx.*` methods only RECORD (plus
 *     mint identity for `spawn` and check preconditions/durability, throwing at the offending call);
 *     the executor opens the single `snapshot.commit` ONLY after `fn` returns. If `fn` — or a `tx.*`
 *     precondition — throws, no commit is ever opened and rollback runs (decision D).
 *  B. **The overlay is seeded from the BASELINE, and provenance drives the fold (§12.2).** Each
 *     referenced entity gets a per-tx overlay of its present components, seeded from
 *     `baseline.readEntity` (empty for a `tx.spawn`'d entity). Every present component is marked
 *     *pre-existing* (in the baseline at tx-start) or *introduced-this-tx* (a spawn-initial or a
 *     prior `tx.addComponent`). Preconditions read the overlay, never the runtime/document — which
 *     don't yet reflect the tx's own earlier calls. `tx.edit(e).set(C,v)` FOLDS into the pending
 *     structural payload when C is introduced-this-tx (the runtime has no C column yet — a
 *     synchronous `writeComponent` would throw), and records a `WriteComponent` ONLY when C is
 *     pre-existing (the one case the runtime already has the column). v1 does NOT coalesce an
 *     add/remove pair — both record, both apply in order (§12.2).
 *  C. **Values are canonicalized AT RECORD time (006 A1).** Every recorded component payload holds
 *     `canon(C, v)` and every resource payload `canonResource(res, v)`; `canon` doubles as the
 *     record-time schema validator (it throws on a malformed value, so the error points at the
 *     offending `tx.*` line, not at seal). So the document, the baseline, and the synchronous
 *     runtime value write all receive the identical canonical cell — the own-echo at next `sync()`
 *     finds runtime == baseline and is a no-op in effect (§13.2/§13.3).
 *  D. **Rollback BURNS keys and invalidates leaked handles (§12.3 atomic-authoring).** On any throw,
 *     for each identity `tx.spawn` minted, `projector.remove(key)` destroys the handle (the runtime's
 *     `destroy` bumps the slot generation BEFORE freeing it, so a leaked handle captured before the
 *     throw goes stale — `isAlive` false, `read`/`get` fail) and unbinds the bijection. Minted keys
 *     are BURNED automatically — the store's peer counter never rolls back — so the next successful
 *     mint gets strictly-higher suffixes. Nothing was committed (no `snapshot.commit` call), so the
 *     document/baseline never moved; the original error is rethrown.
 *  E. **006 C4 — an in-system value commit rides 001 enforcement.** A `doc.transaction` INSIDE a
 *     system whose `WriteComponent` lands synchronously hits `runtime.writeComponent` with
 *     `currentSystem` set (§13.2), so the 001 write chokepoint fires — CORRECTLY. A system that
 *     commits a value write to a pre-existing component MUST declare it in `access.write`, exactly
 *     like any same-phase value write; otherwise it DEV-throws once an observer has armed enforcement
 *     (006 C4). The executor runs the synchronous `writeComponent`s BEFORE opening the Loro commit,
 *     so such a throw aborts with NOTHING staged to the document — a clean rollback.
 */

import type {
  Component,
  ComponentId,
  Entity,
  EntityKey,
  FieldInput,
  Relation,
  Resource,
  RuntimeStore,
  SpawnInitOf,
  Tag,
} from "../core";
import type { BaselineSnapshot, ComponentValue, CRDTSnapshot, Projector } from "../substrate";
import { canon, canonResource, componentByName } from "../substrate";

/**
 * The whole-component value-write surface on `tx`, mirroring the runtime's {@link EntityEditor}
 * (system.ts): `tx.edit(e).set(C, v)` chains. On a PRE-EXISTING component it records a synchronous
 * value write; on a component this transaction introduced it FOLDS into the structural payload
 * (§12.2, decision B).
 */
export interface TxEditor {
  set<S>(c: Component<S>, v: S): TxEditor;
}

/**
 * The `tx` mutation vocabulary (design.md §12.1 `Mutator`) — the SAME surface as `world`/`ctx`,
 * differing only in timing: the whole block seals at once. `tx`'s calls RECORD rather than apply
 * (decision A); identity is the one thing minted eagerly (`spawn`, §12.2).
 */
export interface Mutator {
  /** Mint a durable entity NOW (real handle, usable immediately); its placement rides projection (§12.2). */
  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity;
  /** Record a despawn — applied to the document last at seal, to the runtime + baseline via projection. */
  destroy(e: Entity): void;
  /** Record a SHAPE add (component must be absent in the overlay) — structure rides projection (§12.2). */
  addComponent<S>(e: Entity, c: Component<S>, v: S): void;
  /** Record a SHAPE remove (component must be present in the overlay) — structure rides projection. */
  removeComponent(e: Entity, c: Component): void;
  /** Whole-component value write / fold (§12.2, decision B). */
  edit(e: Entity): TxEditor;
  addTag(e: Entity, t: Tag): void;
  removeTag(e: Entity, t: Tag): void;
  setRelation(e: Entity, r: Relation, target: Entity): void; // arity "one"
  addRelation(e: Entity, r: Relation, target: Entity): void; // arity "many"
  removeRelation(e: Entity, r: Relation, target?: Entity): void;
  setResource<S>(res: Resource<S>, v: S): void;
  removeResource(res: Resource): void;
}

/**
 * @internal The seam the binding installs on the store at attach (decision from §12.4): the recorder
 * needs the runtime (identity mint + synchronous value writes), the projector (key↔handle bijection,
 * the `requireKey` durability gate), and the baseline (overlay seed + the value agreement point).
 * The document is reached through the store's own `snapshot`. Cleared to `null` at detach — so
 * `doc.transaction` on an unattached store throws (the recorder has no projector to mint identity).
 */
export interface TxRuntime {
  readonly runtime: RuntimeStore;
  readonly projector: Projector;
  readonly baseline: BaselineSnapshot;
  /**
   * Clear a held-cell ledger entry (006 C5 supersession rule **(b)**, M4). The executor calls this for
   * each SYNCHRONOUS pre-existing value write it applies (the §13.2 agreement point): our commit is the
   * later Loro op and WINS committer-wins, so any remote value the drag-in-flight guard had held off for
   * this cell **lost** and MUST be dropped — otherwise the end-of-drain sweep would resurrect a
   * conflict-losing value once the cell reconverges. A no-op on the binding when no entry is held.
   */
  clearHeld(key: EntityKey, comp: Component): void;
  /** The resource sibling of {@link clearHeld} — a committed (or removed) resource value supersedes a held one. */
  clearHeldResource(res: Resource): void;
}

// --- recorded ops (decision A: the buffered batch the executor seals) --------------------------------

type RecordedOp =
  | { kind: "spawn"; key: EntityKey; components: Map<Component, ComponentValue>; tags: Tag[] }
  | { kind: "write"; handle: Entity; key: EntityKey; comp: Component; value: ComponentValue } // pre-existing value
  | { kind: "addComponent"; key: EntityKey; comp: Component; value: ComponentValue } // shape; value may fold
  | { kind: "removeComponent"; key: EntityKey; comp: Component }
  | { kind: "addTag"; key: EntityKey; tag: Tag }
  | { kind: "removeTag"; key: EntityKey; tag: Tag }
  | { kind: "setRelation"; key: EntityKey; rel: Relation; targetKey: EntityKey }
  | { kind: "addRelation"; key: EntityKey; rel: Relation; targetKey: EntityKey }
  | { kind: "removeRelation"; key: EntityKey; rel: Relation; targetKey?: EntityKey }
  | { kind: "setResource"; res: Resource; value: ComponentValue }
  | { kind: "removeResource"; res: Resource }
  | { kind: "despawn"; key: EntityKey };

/** How a component came to be present in an entity's overlay — the fold decision turns on it (§12.2). */
interface OverlayComponent {
  provenance: "pre-existing" | "introduced";
  /** For an introduced component: redirect a later `edit().set` value into the structural payload that carries it. */
  fold?: (v: ComponentValue) => void;
}

/** A per-entity pending view (decision B): which components are present, and how each got there. */
interface EntityOverlay {
  /** True for a `tx.spawn`'d entity (its baseline record is empty by construction). */
  spawnedThisTx: boolean;
  /** Present components, keyed by ComponentId — the authoritative precondition oracle for this tx. */
  components: Map<ComponentId, OverlayComponent>;
}

/**
 * The recorder + executor. One instance per `doc.transaction` call. It IS the `tx` Mutator (its
 * methods record), and `seal()` / `rollback()` are the executor faces (design.md §12.3). Private to
 * this module — {@link runTransaction} is the only entry point.
 */
class Transaction implements Mutator {
  private readonly ops: RecordedOp[] = [];
  /** The overlay per referenced entity (keyed by the stable durable key). Seeded lazily on first touch. */
  private readonly overlays = new Map<EntityKey, EntityOverlay>();
  /** Keys `tx.spawn` minted this tx — the rollback set (decision D). Burned regardless of outcome. */
  private readonly minted: EntityKey[] = [];

  constructor(
    private readonly snapshot: CRDTSnapshot,
    private readonly tr: TxRuntime,
  ) {}

  // --- overlay bookkeeping (§12.2, decision B) ----------------------------------------------------

  /**
   * Resolve `e` to its durable key — the {@link Projector.requireKey} DURABILITY gate (§11.2): it
   * THROWS for a runtime-only (`world.spawn`) or other-store handle, so a `tx.*` op naming one fails
   * at the call site. Returns the entity's overlay, seeding it from the baseline on first touch (a
   * pre-existing entity's present components become the pre-existing precondition set; a
   * `tx.spawn`'d entity was seeded empty by `spawn`).
   */
  private touch(e: Entity): { key: EntityKey; overlay: EntityOverlay } {
    const key = this.tr.projector.requireKey(e); // throws for a handle not in this store (§11.2)
    let overlay = this.overlays.get(key);
    if (overlay === undefined) {
      overlay = { spawnedThisTx: false, components: new Map() };
      const rec = this.tr.baseline.readEntity(key);
      if (rec !== undefined) {
        for (const name of Object.keys(rec.components)) {
          const c = componentByName(name);
          if (c !== undefined) overlay.components.set(c.id, { provenance: "pre-existing" });
        }
      }
      this.overlays.set(key, overlay);
    }
    return { key, overlay };
  }

  // --- the Mutator recorder (§12.2) ---------------------------------------------------------------

  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity {
    // Validate + canonicalize EVERY initial value BEFORE minting identity (mirrors world.spawn): a
    // schema error must throw with no identity allocated, so a failed spawn leaks nothing to burn.
    const entries = (init?.components ?? []) as readonly (readonly [Component, ComponentValue])[];
    const seen = new Set<ComponentId>();
    const components = new Map<Component, ComponentValue>();
    for (const [comp, value] of entries) {
      if (seen.has(comp.id)) throw new Error(`strata: component "${comp.name}" supplied twice to tx.spawn.`);
      seen.add(comp.id);
      components.set(comp, canon(comp, value)); // 006 A1: canonical at record time (also validates)
    }
    const tags = [...(init?.tags ?? [])];

    // Identity NOW (§12.2): a real handle + its bound document key, both usable immediately.
    const handle = this.tr.runtime.allocateIdentity();
    const key = this.tr.projector.createPair(handle); // mints the key + binds the bijection
    this.minted.push(key);

    // Overlay: everything on a fresh entity is introduced-this-tx; a later edit().set FOLDS into the
    // spawn payload (the runtime has no column until this projects, §12.2).
    const overlay: EntityOverlay = { spawnedThisTx: true, components: new Map() };
    const op: RecordedOp = { kind: "spawn", key, components, tags };
    for (const comp of components.keys()) {
      overlay.components.set(comp.id, { provenance: "introduced", fold: (v) => components.set(comp, v) });
    }
    this.overlays.set(key, overlay);
    this.ops.push(op);
    return handle;
  }

  destroy(e: Entity): void {
    const { key } = this.touch(e);
    this.ops.push({ kind: "despawn", key });
  }

  addComponent<S>(e: Entity, c: Component<S>, v: S): void {
    const { key, overlay } = this.touch(e);
    if (overlay.components.has(c.id)) {
      throw new Error(`strata: tx.addComponent("${c.name}") — component already present; use tx.edit().set to overwrite.`);
    }
    const value = canon(c, v as ComponentValue); // 006 A1 + record-time validation
    const op = { kind: "addComponent" as const, key, comp: c as Component, value };
    // Introduced-this-tx: a later edit().set folds into THIS op's value, not a synchronous write.
    overlay.components.set(c.id, {
      provenance: "introduced",
      fold: (nv) => {
        op.value = nv;
      },
    });
    this.ops.push(op);
  }

  removeComponent(e: Entity, c: Component): void {
    const { key, overlay } = this.touch(e);
    if (!overlay.components.has(c.id)) {
      throw new Error(`strata: tx.removeComponent("${c.name}") — component is not present on this entity.`);
    }
    overlay.components.delete(c.id); // now absent → a later addComponent may re-introduce it (no coalesce)
    this.ops.push({ kind: "removeComponent", key, comp: c });
  }

  edit(e: Entity): TxEditor {
    const { key, overlay } = this.touch(e);
    const editor: TxEditor = {
      set: <S>(c: Component<S>, v: S) => {
        const state = overlay.components.get(c.id);
        if (state === undefined) {
          throw new Error(`strata: tx.edit().set("${c.name}") — component is not present; add it with tx.addComponent first.`);
        }
        const value = canon(c, v as ComponentValue); // 006 A1 + record-time validation
        if (state.provenance === "introduced") {
          state.fold!(value); // FOLD into the structural payload — no synchronous WriteComponent (§12.2)
        } else {
          // PRE-EXISTING → the value path: runtime + doc + baseline synchronously at seal (§13.2).
          this.ops.push({ kind: "write", handle: e, key, comp: c, value });
        }
        return editor;
      },
    };
    return editor;
  }

  addTag(e: Entity, t: Tag): void {
    const { key } = this.touch(e);
    this.ops.push({ kind: "addTag", key, tag: t });
  }

  removeTag(e: Entity, t: Tag): void {
    const { key } = this.touch(e);
    this.ops.push({ kind: "removeTag", key, tag: t });
  }

  setRelation(e: Entity, r: Relation, target: Entity): void {
    const { key } = this.touch(e);
    const targetKey = this.tr.projector.requireKey(target); // §11.2: BOTH endpoints must be in this store
    this.ops.push({ kind: "setRelation", key, rel: r, targetKey });
  }

  addRelation(e: Entity, r: Relation, target: Entity): void {
    const { key } = this.touch(e);
    const targetKey = this.tr.projector.requireKey(target);
    this.ops.push({ kind: "addRelation", key, rel: r, targetKey });
  }

  removeRelation(e: Entity, r: Relation, target?: Entity): void {
    const { key } = this.touch(e);
    const targetKey = target !== undefined ? this.tr.projector.requireKey(target) : undefined;
    this.ops.push({ kind: "removeRelation", key, rel: r, targetKey });
  }

  setResource<S>(res: Resource<S>, v: S): void {
    this.ops.push({ kind: "setResource", res, value: canonResource(res, v as ComponentValue) }); // 006 A1
  }

  removeResource(res: Resource): void {
    this.ops.push({ kind: "removeResource", res });
  }

  // --- the executor: seal (§12.3) -----------------------------------------------------------------

  /**
   * Apply the recorded batch. TWO stages so an in-system 001-enforcement throw (006 C4, decision E)
   * aborts before any document write:
   *   1. **Synchronous value writes** — for each PRE-EXISTING `WriteComponent`, `runtime.writeComponent`
   *      (the agreement point, may DEV-throw under 001 with `currentSystem` set) + `baseline.setComponent`.
   *      Run BEFORE the Loro commit so a throw leaves the document untouched.
   *   2. **ONE sealed Loro commit** — every DOCUMENT write, ordered spawns → cells/tags/relations →
   *      despawns-last (an entity must exist before it is referenced; no edge is orphaned). Structural
   *      facts touch ONLY the document here; the runtime + baseline advance via projection (§12.3).
   *      Resources are value-like — runtime + baseline advance here too (§12.3 "resources analogously").
   */
  seal(): void {
    // Stage 1 — synchronous pre-existing value writes (the §13.2 agreement point), before any doc write.
    for (const op of this.ops) {
      if (op.kind === "write") {
        this.tr.runtime.writeComponent(op.handle, op.comp, op.value); // 006 C4 chokepoint if in-system
        this.tr.baseline.setComponent(op.key, op.comp, op.value);
        this.tr.clearHeld(op.key, op.comp); // 006 C5 (b): our commit wins — a held remote value for this cell lost
      }
    }

    // Stage 2 — one sealed document commit. Nothing below can throw under normal operation (values are
    // already canonical/valid), so the commit is never a partial seal.
    this.snapshot.commit(() => {
      const despawns: EntityKey[] = [];
      for (const op of this.ops) {
        switch (op.kind) {
          case "spawn":
            this.snapshot.spawn(op.key);
            for (const [comp, value] of op.components) {
              this.tr.clearHeld(op.key, comp); // 006 C5 (b), defensive: a fresh key holds nothing, but symmetric
              this.snapshot.setComponent(op.key, comp, value);
            }
            for (const tag of op.tags) this.snapshot.addTag(op.key, tag);
            break;
          case "write": // doc side of the agreement point (runtime + baseline done in stage 1)
            this.snapshot.setComponent(op.key, op.comp, op.value);
            break;
          case "addComponent": // structure — document only; folded value included (§12.2)
            // 006 C5 (b): a single-tx removeComponent+addComponent surfaces as a NET component-SET in the
            // frontier diff (no remove fact), so supersession (c) never fires for the reconcile — clear the
            // held remote loser HERE. Our committed value wins committer-wins; the held value LOST. Mirrors
            // the `write` branch's clearHeld (stage 1); without it the end-of-drain sweep resurrects the loser.
            this.tr.clearHeld(op.key, op.comp);
            this.snapshot.setComponent(op.key, op.comp, op.value);
            break;
          case "removeComponent":
            this.snapshot.removeComponent(op.key, op.comp);
            break;
          case "addTag":
            this.snapshot.addTag(op.key, op.tag);
            break;
          case "removeTag":
            this.snapshot.removeTag(op.key, op.tag);
            break;
          case "setRelation":
            this.snapshot.setRelation(op.key, op.rel, op.targetKey);
            break;
          case "addRelation":
            this.snapshot.addRelation(op.key, op.rel, op.targetKey);
            break;
          case "removeRelation":
            this.snapshot.removeRelation(op.key, op.rel, op.targetKey);
            break;
          case "setResource": // value-like: runtime + baseline now, document here (§12.3)
            this.tr.runtime.setResource(op.res, op.value);
            this.tr.baseline.setResource(op.res, op.value);
            this.tr.clearHeldResource(op.res); // 006 C5 (b): our committed resource value supersedes a held one
            this.snapshot.setResource(op.res, op.value);
            break;
          case "removeResource":
            this.tr.runtime.removeResource(op.res);
            this.tr.baseline.removeResource(op.res);
            this.tr.clearHeldResource(op.res); // the structural-ish resource remove supersedes a held value too
            this.snapshot.removeResource(op.res);
            break;
          case "despawn":
            despawns.push(op.key); // deferred so edges aren't orphaned in the document (§12.3)
            break;
        }
      }
      for (const key of despawns) this.snapshot.despawn(key);
    });
  }

  /**
   * Rollback (decision D, §12.3). Nothing was committed (seal never opened the commit, or threw
   * before/at stage 1). For each identity `tx.spawn` minted, `projector.remove(key)` destroys the
   * handle (generation bumped → a leaked handle reads dead) and unbinds the bijection. Minted keys
   * are already burned (the store's counter never rolls back). `resolveByKey` for these keys is now
   * undefined; the next successful mint gets strictly-higher suffixes.
   */
  rollback(): void {
    for (const key of this.minted) this.tr.projector.remove(key);
  }
}

/**
 * Run one transaction (design.md §12): record via `fn(tx)`, then seal as ONE commit and return
 * `fn`'s result. On ANY throw — a `tx.*` precondition/durability violation, a user throw in `fn`, or
 * an in-system 006-C4 enforcement throw at seal's stage 1 — roll back (burn minted identities) and
 * rethrow the original error, having committed nothing (decision A/D). The caller
 * ({@link DurableStore.transaction}) owns the attached-only and one-open-transaction-per-store guards.
 */
export function runTransaction<R>(snapshot: CRDTSnapshot, tr: TxRuntime, fn: (tx: Mutator) => R): R {
  const tx = new Transaction(snapshot, tr);
  try {
    const result = fn(tx);
    tx.seal();
    return result;
  } catch (err) {
    tx.rollback();
    throw err;
  }
}

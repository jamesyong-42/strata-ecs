/**
 * The runtime store — the archetype / typed-array engine (design §3, §5.5).
 *
 * This is the one place that knows the in-memory data shape. It owns the entity table, the
 * archetype index, and the five physical primitives (place · unplace · migrate · cell write ·
 * — bit/map mutation arrives with tags/relations in M3). Every operation here is **immediate**;
 * deferral is the system context's concern, not the store's (§ Part I ref, ECSStore).
 *
 * M2 scope: components, placement, and immediate structural/value ops. Tags, relations, and the
 * despawn cascade land in M3; queries in M4; the deferring `ctx` and tick in M5.
 */

import { type Entity, genOf, slotOf } from "./entity";
import { EntityTable } from "./entity-table";
import { Archetype } from "./archetype";
import { TagStore } from "./tags";
import { RelationStore } from "./relations";
import {
  type Column,
  type ColumnsOf,
  clearCell,
  decodeField,
  moveCell,
  readCell,
  writeCell,
} from "./field";
import {
  type Component,
  type ComponentId,
  type FieldId,
  type FieldMeta,
  type Relation,
  type RelationId,
  type Resource,
  type ResourceId,
  type Tag,
  type TagId,
  componentById,
  componentCount,
  encodeComponentValue,
  relationById,
  relationCount,
  resourceById,
  tagById,
  tagCount,
} from "./schema";
import type { Batch, MemberCheck, Query, RowFilter } from "./query";
import type { CommandBuffer, StructuralCommand } from "./command";
import type { ECSStore } from "./ecs-store";
import { DEV, devError, devWarn } from "./dev";
import type { WorldObserver } from "./observe";
import type { System } from "./system";
import { effectiveRead } from "./access-diagnostics";

/** A component handle paired with a value of its field type — the typed spawn/init form. */
export type ComponentEntry<S = unknown> = readonly [Component<S>, S];

/** What `spawn` accepts. */
export interface SpawnInit {
  components?: readonly ComponentEntry[];
  tags?: readonly Tag[];
}

/**
 * The category a `world.devOnWrite` hook is told about (petition 4). Every internal mutation chokepoint
 * classifies itself into exactly one of these before it changes state:
 *
 *   - `"structural"` — identity mint, placement, migration, despawn, wholesale reset, snapshot import.
 *     add/removeComponent surface HERE (they migrate archetypes), never as `"component"`.
 *   - `"component"`  — a value overwrite of an already-present component's cells (`edit().set`, projection
 *     overwrite, a durable seal's pre-existing value write).
 *   - `"tag"`        — a tag membership add/remove.
 *   - `"relation"`   — a relation edge set/add/remove.
 *   - `"resource"`   — a resource set/remove (including strata's own sync/attach status-resource writes).
 *
 * A single logical write may fire MORE THAN ONCE and across MORE THAN ONE kind (a `ctx.spawn` fires a
 * structural at its eager identity mint and again when the flush places it; a tag-add on an identity-only
 * source fires `"tag"` and a `"structural"` for the placement it forces). The contract is
 * fire-at-least-once-pre-mutation-per-logical-write, may-over-fire, never-miss (petition 4).
 */
export type WriteKind = "structural" | "component" | "tag" | "relation" | "resource";

/** Stored per-field value: a number for typed columns, `string | null` for string columns. */
type Stored = number | string | null;

const EMPTY_FIELD_VALUES: ReadonlyMap<FieldId, Stored> = new Map();

export class RuntimeStore implements ECSStore {
  private readonly table = new EntityTable();
  private readonly tags = new TagStore();
  private readonly relations = new RelationStore((e) => this.table.isAlive(e));
  private readonly archetypeIndex = new Map<string, Archetype>();
  private readonly archetypesById: Archetype[] = [];
  private readonly emptyArchetype: Archetype;
  private readonly resources = new Map<number, Record<string, unknown>>();
  private readonly archetypeObservers: ((a: Archetype) => void)[] = [];
  private readonly queryMatches = new Map<Query, Archetype[]>();
  private readonly bufferPool: StructuralCommand[][] = [];
  private readonly freeBuffers: CommandBuffer[] = [];
  private nextArchetypeId = 0;
  /**
   * Soft cap on deferred ops in a single phase. The buffer is otherwise unbounded (§5.4), so a
   * system deferring per row over a huge query can grow it without limit → OOM with no clean error.
   * Crossing this emits a one-shot DEV back-pressure warning (never a throw — a flush must not fail
   * mid-drain). DEV-only; stripped in production.
   */
  private commandBufferWarnThreshold = 1_000_000;
  /**
   * Ascending identity `[0,1,2,…]`, grown to the largest archetype seen and shared by every dense
   * chunk as its `rows` (§6.2). Read-only content, so sharing across (even nested) queries is safe:
   * growing replaces the array, and an outer chunk keeps its still-correct older reference.
   */
  private identityRows = new Int32Array(0);
  /** Transient scratch for materializing a row-filtered chunk's matches, before the exact-size copy. */
  private rowScratch = new Int32Array(0);
  /**
   * Attached dev-tool observers (observe.ts) — `null` whenever none are attached, so the
   * spawn/destroy hot paths pay exactly one branch-on-null (docs/plan-tools-observer.md).
   */
  private observerList: WorldObserver[] | null = null;
  /**
   * DEV-only pre-mutation write hooks (petition 4; `world.devOnWrite`). `null` whenever none are
   * registered — the SAME branch-on-null discipline as {@link observerList}, so every mutation
   * chokepoint pays exactly one `writeHooks !== null` test where DEV holds. Where `DEV` is FALSE (a
   * runtime with `process` under `NODE_ENV=production`) the sites are dead and `devOnWrite` never
   * registers; an UN-SHIMMED browser production bundle retains the checks (DEV is runtime-true there —
   * see dev.ts's folding honesty note), costing one null test per op and firing nothing while
   * unregistered. COPY-ON-WRITE like the observer roster: register/dispose publish a new
   * array, never mutate one a fire loop may be iterating. Unlike {@link observerList}, a throwing hook is
   * NOT swallowed — see {@link fireWrite}.
   */
  private writeHooks: ReadonlyArray<(kind: WriteKind) => void> | null = null;
  /**
   * The reactive change-detection frame counter (Patch Note 002 §2.1). Every stamp — value writes,
   * structural bumps, tag/relation bumps — records this value; the reactive layer advances it at the
   * END of its notify pass (§4.1a), so an out-of-tick write between passes stamps a frame strictly
   * greater than any observer's `lastSeenFrame` and is never missed. Starts at 1 so a never-stamped
   * slot (0) always reads as older.
   */
  private frameCounter = 1;
  /**
   * Per-tag and per-relation membership versions (§4.2) — dense arrays indexed by `TagId` / `RelationId`
   * (both dense). A tag/relation mutation moves no archetype row yet CAN change a row-filtered query's
   * membership, so membership needs its own stamp; but only the ids a given observer actually watches
   * should wake it. Each op stamps ONLY its own id ({@link bumpTag}/{@link bumpRel}), and a row-filtered
   * Tier-1 observer consults the stamps of exactly the tags/relations its plan depends on (the query
   * plan's per-id membership dep lists, compiled in query.ts) — so unrelated tag/relation churn no
   * longer wakes it. Grown lazily like {@link resourceFrames} (copy-forward, zero-fill); a never-stamped
   * id (0) reads older than any observer.
   */
  private tagFrames = new Float64Array(0);
  private relFrames = new Float64Array(0);
  /**
   * Per-resource `lastWrittenFrame` (Patch Note 003 §1.2), a dense array indexed by `ResourceId`
   * (ids are dense). Bumped in `setResource` only — resources have no column/structural path — behind
   * the `reactiveOn` gate. Grown lazily on first stamp past the current length; a never-stamped id
   * (0) reads as older than any observer. NOT on the stored value object (replaced wholesale per set).
   */
  private resourceFrames = new Float64Array(0);
  /**
   * Per-component `lastWrittenFrame` MAX (Patch Note 002 §3.2 / review-part1 R5), a dense array
   * indexed by `ComponentId`. It is the reactive layer's quiescent fast-path gate: the Tier-2/3
   * `notify` pass reads `componentMaxFrame[cid]` with ONE compare to decide whether an ENTIRE
   * component's watch map can be skipped, instead of walking every watched cell each idle frame.
   *
   * SOUNDNESS — it MUST bump at every site that can change what a Tier-2/3 watch on `cid` observes,
   * or the skip drops a notification. The complete enumeration (all behind the `reactiveOn` gate):
   *
   *   1. {@link stampComponent} — the sole owner of column value stamps: edit/writeComponent,
   *      projection overwrite + initial, `stampWrites` blanket (001 §3.1 route 1), `invalidate`.
   *      Every value-write path funnels here, so bumping here once covers them all.
   *   2. {@link migrate} — bypasses stampComponent (it writes `lastWrittenFrame` slots directly), so
   *      it bumps EXPLICITLY: (a) ADDED columns — a gained component is a value write; (b) REMOVED
   *      components (in the source archetype, not the destination) — the fire-`undefined`-on-removal
   *      path has NO column to stamp, so without this bump the skip would swallow the removal fire.
   *   3. {@link reset} — bumps EVERY component id: reset bumps every entity's generation (all watched
   *      entities go dead at once) and does NOT queue the death hook, so the dead-entity fires ride
   *      `notifyWatches`' fallback path, which the skip gates. Covers watches on identity-only
   *      entities too (their component is in no cleared archetype).
   *
   * NOT a bump site — {@link destroy}: a destroyed watched entity is queued on the reactive death
   * hook and fired by `drainDeaths`, which runs BEFORE the Tier-2/3 pass and is never gated by this
   * array. So per-entity death is unskippable by construction, and needs no componentMaxFrame bump.
   *
   * Grown lazily (copy-forward, zero-fill); a never-stamped id (0) reads older than any observer.
   */
  private componentMaxFrame = new Float64Array(0);
  /**
   * Master gate for ALL reactive bookkeeping (value stamps, structural bumps, tag/relation bumps) —
   * false until the world's reactive layer is first touched, so a world that never uses reactivity
   * pays literally zero stores on the mutation paths (the same branch-on-null discipline as the T0
   * observer roster; the bench A/B gate measured the always-on variant at +17–28% on migrate-heavy
   * scenarios, which is what forced this gate).
   */
  private reactiveOn = false;

  /** @internal Arm reactive bookkeeping — one-way, flipped on the first `observe*` registration
   *  (reading `world.reactive` is side-effect-free; only registering an observer arms stamping). */
  enableReactive(): void {
    this.reactiveOn = true;
  }

  /** @internal Side-effect-free probe for `world.isReactiveEnabled` (review-part1 Tier-3). */
  get reactiveEnabled(): boolean {
    return this.reactiveOn;
  }

  /**
   * The reactive layer's eager-death hook (002 §3.4) — a single dedicated slot, deliberately NOT a
   * {@link WorldObserver}: routing it through `addObserver` would flip the T0 telemetry roster
   * non-null and tax every tick with per-system `performance.now` timing. `null` until the first
   * entity/value watch registers; called pre-teardown in {@link destroy} to QUEUE the dying entity
   * (queue-only — it must never fire callbacks or mutate).
   */
  private reactiveDeathHook: ((e: Entity) => void) | null = null;

  /** @internal Install/clear the reactive death hook (the reactive layer owns this seam, §3.4). */
  setReactiveDeathHook(hook: ((e: Entity) => void) | null): void {
    this.reactiveDeathHook = hook;
  }

  /**
   * Stamp tag `id`'s membership version at the current frame (§4.2) — no-op until reactivity is enabled.
   * Grows the dense array to fit `id` on first use (copy-forward, zero-fill). `frameCounter`, NOT
   * `stampFrame`: tag/relation ops are rejected mid-emit, so a notify-callback stamp (frame+1) is
   * unreachable here (parity with the retired `bumpTagRel`).
   */
  private bumpTag(id: TagId): void {
    if (!this.reactiveOn) return;
    if (id >= this.tagFrames.length) {
      const next = new Float64Array(id + 1);
      next.set(this.tagFrames);
      this.tagFrames = next;
    }
    this.tagFrames[id] = this.frameCounter;
  }

  /** Stamp relation `id`'s membership version at the current frame (§4.2) — no-op until reactivity is
   *  enabled. Grows the dense array to fit `id` (copy-forward, zero-fill). `frameCounter` for the same
   *  reason as {@link bumpTag}: a relation op cannot run from inside a notify callback. */
  private bumpRel(id: RelationId): void {
    if (!this.reactiveOn) return;
    if (id >= this.relFrames.length) {
      const next = new Float64Array(id + 1);
      next.set(this.relFrames);
      this.relFrames = next;
    }
    this.relFrames[id] = this.frameCounter;
  }

  /** {@link destroy}'s teardown report callbacks (§4.2 per-id), bound ONCE — a destroy-heavy frame with
   *  reactivity on must not allocate two fresh closures per entity (the R5 no-allocation discipline). */
  private readonly onTagTeardown = (id: TagId): void => this.bumpTag(id);
  private readonly onRelTeardown = (id: RelationId): void => this.bumpRel(id);

  /**
   * Access enforcement state (001 Rule 3, armed by the reactive layer §2.4). `accessArmed` flips on
   * when the first reactive observer registers and stays on for the world's life; `currentSystem` is
   * set by the tick around each system's run so the `col()`/`writeComponent` chokepoints can name it
   * in a throw. Both reads are DEV-only and short-circuit when disarmed or outside a system, so the
   * hot path pays at most one branch.
   */
  private accessArmed = false;
  private currentSystem: System | null = null;
  /** Per-system allowed component set (write ∪ effectiveRead) for the `col()` check, memoized (001 Rule 3). */
  private readonly allowedAccess = new WeakMap<System, Set<ComponentId>>();

  private ensureIdentity(n: number): Int32Array {
    if (this.identityRows.length < n) {
      const next = new Int32Array(n);
      for (let i = 0; i < n; i++) next[i] = i;
      this.identityRows = next;
    }
    return this.identityRows;
  }

  private ensureScratch(n: number): Int32Array {
    if (this.rowScratch.length < n) this.rowScratch = new Int32Array(n);
    return this.rowScratch;
  }

  constructor() {
    this.emptyArchetype = this.archetypeFor([]);
    // Keep every cached query's matching-archetype list current as new archetypes appear (§6.1).
    this.observeArchetypes((arch) => {
      for (const [q, list] of this.queryMatches) {
        if (this.archetypeMatchesQuery(q, arch)) list.push(arch);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Archetype index
  // ---------------------------------------------------------------------------

  /** Look up (or lazily create) the archetype for a sorted, unique list of component ids. */
  private archetypeFor(componentIds: readonly ComponentId[]): Archetype {
    const key = componentIds.join(",");
    const existing = this.archetypeIndex.get(key);
    if (existing) return existing;

    const fields: FieldMeta[] = [];
    for (const cid of componentIds) {
      const c = componentById(cid);
      if (!c) throw new Error(`strata: unknown component id ${cid}.`);
      for (const f of c.fields) fields.push(f);
    }
    const arch = new Archetype(this.nextArchetypeId++, key, componentIds.slice(), fields);
    this.archetypeIndex.set(key, arch);
    this.archetypesById[arch.id] = arch;
    for (const observe of this.archetypeObservers) observe(arch);
    return arch;
  }

  /** @internal Subscribe to archetype creation (queries cache matching-archetype lists this way, §3.1/§6). */
  observeArchetypes(fn: (a: Archetype) => void): void {
    this.archetypeObservers.push(fn);
  }

  // ---------------------------------------------------------------------------
  // Dev-tool observers (observe.ts; docs/plan-tools-observer.md)
  // ---------------------------------------------------------------------------

  /**
   * @internal Attach a dev-tool observer (use `world.observe`). Returns a detach function.
   * The roster is COPY-ON-WRITE: attach/detach publish a new array, never mutate one an emit
   * loop may be iterating — so detaching from inside a callback can never skip a sibling, and
   * roster changes take effect from the next event (next tick, for tick telemetry) on.
   */
  addObserver(obs: WorldObserver): () => void {
    this.observerList = this.observerList === null ? [obs] : [...this.observerList, obs];
    return () => {
      const list = this.observerList;
      if (list === null) return;
      const i = list.indexOf(obs);
      if (i === -1) return;
      const next = list.slice(0, i).concat(list.slice(i + 1));
      this.observerList = next.length > 0 ? next : null;
    };
  }

  /** @internal `null` when no observers are attached — `World.tick` branches on this. */
  get observers(): readonly WorldObserver[] | null {
    return this.observerList;
  }

  /** True while observer callbacks run — DEV mutation guards in spawn/destroy read it. */
  private inObserverEmit = false;

  /**
   * @internal Set the observer-emit reentrancy flag and return its prior value. `reactive.notify`
   * wraps its callback dispatch in this so the spawn/destroy DEV guards reject structural mutation
   * from a reactive callback (002 §6 — callbacks may SCHEDULE work instead).
   */
  setObserverEmit(active: boolean): boolean {
    const prev = this.inObserverEmit;
    this.inObserverEmit = active;
    return prev;
  }

  /**
   * @internal True while an observer / reactive callback is on the stack. `world.sync()` DEV-asserts
   * this is false at entry (005 §5.5): a drain from inside a notify would HALF-apply a `ChangeBatch`
   * — the projection primitives are unguarded (they must run mid-drain) while the structural mutators
   * reject in-emit — so adds/writes would land and removes/despawns vanish. Read-only accessor.
   */
  get inObserverEmitActive(): boolean {
    return this.inObserverEmit;
  }

  /**
   * True ONLY while `reactive.notify()` dispatches callbacks — NOT during the dev-tool
   * WorldObserver emits (onSpawn/onDestroy/onReset), which also set `inObserverEmit` for the
   * structural-rejection guards but have NO trailing `advanceFrame()` to consume a frame+1 stamp.
   * `stampFrame` keys off THIS flag: stamping ahead from a spawn-observer callback left the stamp
   * one frame in the future with nothing to consume it, and a Tier-1 watch (no equality check)
   * fired at TWO consecutive notifies for one write (triage-review confirmed finding).
   */
  private inNotifyStamping = false;

  /** @internal Set by `reactive.notify()` around its callback dispatch; returns the prior value. */
  setNotifyStamping(active: boolean): boolean {
    const prev = this.inNotifyStamping;
    this.inNotifyStamping = active;
    return prev;
  }

  /**
   * The frame VALUE writes stamp at. Outside notify callbacks: the current frame. Inside a
   * `reactive.notify()` callback: the NEXT frame — the current frame is already seen by every watch
   * processed this pass, so a current-frame stamp was nondeterministically lost (fired only if its
   * watch happened to be later in the walk). Stamping `frame + 1` makes a callback write
   * deterministic: `notify()`'s trailing `advanceFrame()` moves the world to exactly that frame,
   * and the NEXT notify delivers it (review-part1 Tier-3 fix). Dev-tool observer emits stamp the
   * CURRENT frame (see {@link inNotifyStamping}). Structural mutation stays rejected in callbacks —
   * only the value paths (stampComponent / bumpComponentMax / bumpResource) consult this.
   */
  private get stampFrame(): number {
    return this.inNotifyStamping ? this.frameCounter + 1 : this.frameCounter;
  }

  /**
   * DEV guard (002 §6): a STRUCTURAL mutation issued from inside an observer / reactive callback is
   * rejected — mid-flush it would corrupt the command-buffer drain, mid-notify it would re-enter
   * iteration; callbacks must SCHEDULE work instead. Returns true when blocked so the caller
   * early-returns. Value writes (`writeComponent`) are exempt — immediate and non-structural.
   */
  private rejectMutationInEmit(op: string): boolean {
    if (DEV && this.inObserverEmit) {
      devError(`observer callbacks must not mutate the world — ${op}() from inside a callback is ignored (observe.ts).`);
      return true;
    }
    return false;
  }

  /** Fan an entity birth out to observers. Callers guard `observerList !== null` (hot path). */
  private emitSpawn(e: Entity): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onSpawn?.(e);
        } catch (err) {
          devError(`observer onSpawn threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  /** Fan an imminent entity teardown out to observers. Callers guard `observerList !== null`. */
  private emitDestroy(e: Entity): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onDestroy?.(e);
        } catch (err) {
          devError(`observer onDestroy threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  /**
   * Fan a wholesale reset out to observers (observe.ts). Fired ONCE by {@link reset} AFTER teardown
   * — never a per-entity `onDestroy` (a 100k reset must not emit 100k callbacks). Callers guard
   * `observerList !== null`. Runs under the observer-emit flag so a callback cannot re-enter mutation.
   */
  private emitReset(): void {
    const obs = this.observerList as WorldObserver[];
    const prev = this.inObserverEmit;
    this.inObserverEmit = true;
    try {
      for (let i = 0; i < obs.length; i++) {
        try {
          obs[i].onReset?.();
        } catch (err) {
          devError(`observer onReset threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
        }
      }
    } finally {
      this.inObserverEmit = prev;
    }
  }

  // ---------------------------------------------------------------------------
  // DEV pre-mutation write hooks (petition 4; reached via `world.devOnWrite`)
  // ---------------------------------------------------------------------------

  /**
   * @internal Register a DEV-only, synchronous, PRE-mutation write hook (petition 4; use
   * `world.devOnWrite`). Returns a disposer. Where `DEV` is FALSE (node/SSR production, or any build
   * that folds it false — see dev.ts's folding honesty note for the un-shimmed-browser caveat) this
   * never registers, returns a no-op disposer, and the fire sites are dead.
   * The roster is COPY-ON-WRITE (the {@link addObserver} pattern): register
   * appends a fresh array, dispose removes and falls back to `null` at empty, and a dispose issued from
   * INSIDE a fire never skips a sibling because {@link fireWrite} iterates a captured list. The public
   * contract (throws propagate, every route it observes, the non-atomic windows) lives on `World.devOnWrite`.
   */
  devOnWrite(cb: (kind: WriteKind) => void): () => void {
    if (!DEV) return () => {}; // DEV=false (node prod / folded builds): never registers — dev.ts has the browser caveat
    this.writeHooks = this.writeHooks === null ? [cb] : [...this.writeHooks, cb];
    return () => {
      const list = this.writeHooks;
      if (list === null) return;
      const i = list.indexOf(cb);
      if (i === -1) return; // already disposed (idempotent)
      const next = list.slice(0, i).concat(list.slice(i + 1));
      this.writeHooks = next.length > 0 ? next : null; // back to null-when-empty for the branch-on-null fast path
    };
  }

  /**
   * Fan a pre-mutation write out to the registered hooks (petition 4). Captures the roster ONCE so a hook
   * that disposes a sibling (or itself) mid-fire cannot skip anyone this pass — the COW dispose swaps the
   * field, never the captured array. DELIBERATELY has NO try/catch: a throwing `devOnWrite` hook
   * PROPAGATES to the mutator's caller (the veto contract), unlike the {@link emitSpawn}/{@link emitDestroy}
   * observer emits, which swallow and `devError`. Reached only from the `DEV && writeHooks !== null` fire
   * sites, so the non-null assertion is sound.
   *
   * FIRE-SITE PLACEMENT RULE (bench-pinned): gates live ONLY in entry-level functions — spawn / destroy /
   * reset / world.import / allocateIdentity / addComponent / removeComponent / projectComponent's
   * structural branches / ensurePlaced's placing branch / applyCommand's structural arms / the do*
   * tag-relation primitives / doWriteCells / set-removeResource. The inner physical primitives (`place`,
   * `unplace`, `migrate`) are DELIBERATELY un-gated: they are tiny and inline-hot inside the migrate loop,
   * and gating them measured +6–8% on the structural bench (spawn+despawn / add+remove) — an inlining
   * cliff, not branch arithmetic. Relocating to entry level recovered most of it (residual +4.7%/+2.3%
   * vs base, at the edge of the harness's ±2–3% cross-build noise; commit c1a7719 records the honest
   * numbers). Every route still fires ≥1 pre-mutation because every path INTO place/unplace/migrate
   * crosses a gated entry first (the devwrite matrix pins route completeness).
   */
  private fireWrite(kind: WriteKind): void {
    const hooks = this.writeHooks!; // captured — a mid-fire dispose republishes the field, not this array
    for (let i = 0; i < hooks.length; i++) hooks[i](kind);
  }

  /**
   * @internal Fire the write-hook roster for a mutation that ORIGINATES in {@link World} rather than in a
   * store method — currently only `world.import`'s pre-reset veto point (petition 4). The `DEV` half of the
   * gate lives at the call site (`if (DEV) …`) so it is dead where DEV folds false; the branch-on-null lives here so the
   * roster field stays private to this class. Throws PROPAGATE, exactly like the in-store {@link fireWrite}.
   */
  fireWriteFromWorld(kind: WriteKind): void {
    if (this.writeHooks !== null) this.fireWrite(kind);
  }

  /** @internal All archetypes that currently exist (for queries to seed their caches; also the
   *  tools' reflection walk). Returns the internal {@link Archetype} type — not public API. */
  archetypes(): readonly Archetype[] {
    return this.archetypesById;
  }

  /** @internal The archetype an entity occupies — undefined for identity-only/dead handles
   *  (first-party tools use this for reflection; apps should stick to queries). */
  archetypeOf(e: Entity): Archetype | undefined {
    return this.table.isPlaced(e) ? this.archetypesById[this.table.archetypeOf(slotOf(e))] : undefined;
  }

  private archetypeOfEntity(e: Entity): Archetype {
    return this.archetypesById[this.table.archetypeOf(slotOf(e))];
  }

  // ---------------------------------------------------------------------------
  // Reactive change-detection stamps (Patch Note 002 §2)
  // ---------------------------------------------------------------------------

  /** @internal The current reactive frame; observers compare stamps against it (002 §2.1). */
  get frame(): number {
    return this.frameCounter;
  }

  /** @internal Advance the frame at the END of the reactive notify pass (002 §4.1a). */
  advanceFrame(): void {
    this.frameCounter++;
  }

  /** @internal The frame of tag `id`'s most recent membership mutation — 0 when never stamped/out of
   *  range (002 §4.2 per-id). A row-filtered Tier-1 observer polls this for each tag its plan depends on. */
  tagFrame(id: TagId): number {
    return id < this.tagFrames.length ? this.tagFrames[id] : 0;
  }

  /** @internal The frame of relation `id`'s most recent membership mutation — 0 when never stamped/out
   *  of range (002 §4.2 per-id). Covers rel row filters, demoted concrete targets, and a seed's relation. */
  relFrame(id: RelationId): number {
    return id < this.relFrames.length ? this.relFrames[id] : 0;
  }

  /**
   * Stamp resource `id` at the current frame (003 §1.2). Gated on `reactiveOn` like every other stamp
   * site, and grows the dense array to fit `id` on first use (copy-forward, zero-fill). Called from
   * `setResource` only — the resource's single write chokepoint.
   */
  private bumpResource(id: ResourceId): void {
    if (!this.reactiveOn) return;
    if (id >= this.resourceFrames.length) {
      const next = new Float64Array(id + 1);
      next.set(this.resourceFrames);
      this.resourceFrames = next;
    }
    this.resourceFrames[id] = this.stampFrame; // frame+1 inside a callback — deterministic next-notify delivery
  }

  /** @internal The frame of the most recent `setResource(id)` — 0 when never stamped/out of range (003 §1.2). */
  resourceFrame(id: ResourceId): number {
    return id < this.resourceFrames.length ? this.resourceFrames[id] : 0;
  }

  /**
   * Bump `cid`'s per-component MAX stamp to the current frame — the reactive fast-path gate (R5).
   * Callers are already inside the `reactiveOn` gate (see the enumeration on {@link componentMaxFrame}).
   * Grows the dense array to fit `cid` on first use (copy-forward, zero-fill).
   */
  private bumpComponentMax(cid: ComponentId): void {
    if (cid >= this.componentMaxFrame.length) {
      const next = new Float64Array(cid + 1);
      next.set(this.componentMaxFrame);
      this.componentMaxFrame = next;
    }
    // stampFrame, not frameCounter: a callback write stamps frame+1, and the R5 skip gate must not
    // eat it (max < the column stamp would skip the whole component map next notify).
    if (this.stampFrame > this.componentMaxFrame[cid]) this.componentMaxFrame[cid] = this.stampFrame;
  }

  /**
   * Bump EVERY component id's max stamp (reset's wholesale-death case, R5) — see the componentMaxFrame
   * enumeration §3. Grows to `componentCount()` so ids for components with no live column are covered
   * too (a watch on an identity-only entity's component). Caller is inside the `reactiveOn` gate.
   */
  private bumpAllComponentMax(): void {
    const n = componentCount();
    if (n > this.componentMaxFrame.length) {
      const next = new Float64Array(n);
      next.set(this.componentMaxFrame);
      this.componentMaxFrame = next;
    }
    this.componentMaxFrame.fill(this.frameCounter, 0, n);
  }

  /** @internal The per-component MAX stamp — 0 when never stamped/out of range. The Tier-2/3 skip gate (R5). */
  componentFrame(cid: ComponentId): number {
    return cid < this.componentMaxFrame.length ? this.componentMaxFrame[cid] : 0;
  }

  /**
   * Stamp `cid`'s column in `A` with the current frame (002 §2.1). No-op if `A` lacks the component,
   * so callers need not pre-check membership. A single integer store after a `componentSlot` scan.
   * Also bumps the per-component MAX (R5 skip gate) — this is the sole owner of column value stamps,
   * so every value-write path is covered by the one bump here (migrate stamps directly and bumps
   * the MAX itself; see the {@link componentMaxFrame} enumeration).
   */
  private stampComponent(A: Archetype, cid: ComponentId): void {
    if (!this.reactiveOn) return;
    const slot = A.componentSlot(cid);
    if (slot >= 0) {
      A.lastWrittenFrame[slot] = this.stampFrame; // frame+1 inside a callback (see stampFrame)
      this.bumpComponentMax(cid);
    }
  }

  /**
   * @internal 001 §3.1 route 1: after a system runs, stamp its `access.write` set across the
   * archetypes matching `q` (blanket, `hasComponent`-guarded — 002 §2.3). Seeds the query's
   * matching-archetype cache the same way {@link runQuery} does if it has never run.
   */
  stampWrites(q: Query, comps: readonly Component[]): void {
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    for (const arch of matches) {
      for (const c of comps) {
        if (arch.hasComponent(c.id)) this.stampComponent(arch, c.id);
      }
    }
  }

  /**
   * @internal 002 §2.2 escape hatch (`world.reactive.invalidate`): stamp `c`'s column in every
   * archetype that holds it — for writes no chokepoint can see (raw column pokes, future feeds).
   */
  invalidateComponent(c: Component): void {
    for (const arch of this.archetypesById) {
      if (arch !== undefined && arch.hasComponent(c.id)) this.stampComponent(arch, c.id);
    }
  }

  /**
   * @internal The cached matching-archetype list for `q`, seeded on first use exactly like
   * {@link stampWrites} / {@link runQuery} (Tier-1 observers read it directly, 002 §3.1). The
   * returned array is the store's live cache — the archetype-creation hook keeps appending
   * newly-matching archetypes to it, so a held reference stays current across spawns.
   */
  matchesFor(q: Query): readonly Archetype[] {
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    return matches;
  }

  // ---------------------------------------------------------------------------
  // Access enforcement (001 Rule 3 — accessor-level; armed by the reactive layer, §2.4)
  // ---------------------------------------------------------------------------

  /** @internal Turn on dev-mode access enforcement. The first reactive observer calls this once. */
  armAccessEnforcement(): void {
    this.accessArmed = true;
  }

  /** @internal Tick sets the running system so `col()`/`writeComponent` can enforce its access (DEV). */
  beginSystemAccess(system: System): void {
    this.currentSystem = system;
  }

  /** @internal Tick clears the running system after the phase (also the throw backstop). */
  endSystemAccess(): void {
    this.currentSystem = null;
  }

  /** The write ∪ effectiveRead id set the running system may `col()`, memoized per System (001 Rule 3). */
  private allowedFor(system: System): Set<ComponentId> {
    let set = this.allowedAccess.get(system);
    if (set === undefined) {
      set = new Set<ComponentId>();
      if (system.access?.write !== undefined) for (const c of system.access.write) set.add(c.id);
      for (const c of effectiveRead(system)) set.add(c.id);
      this.allowedAccess.set(system, set);
    }
    return set;
  }

  /**
   * @internal 001 Rule 3 accessor check — `batch.col(c)` for a `c` in neither `access.write` nor the
   * (default-or-declared) read set throws, naming the system + component. DEV + armed + in-a-system
   * only; out-of-tick `world.query().each` has `currentSystem === null` and is exempt.
   */
  enforceColAccess(c: Component<unknown, unknown>): void {
    if (!this.accessArmed) return;
    const system = this.currentSystem;
    if (system === null) return;
    if (!this.allowedFor(system).has(c.id)) {
      throw new Error(
        `strata: system "${system.name}" accessed component "${c.name}" via col() but did not declare it in access (add it to access.read or access.write).`,
      );
    }
  }

  /**
   * 001 Rule 3 edit chokepoint — a `ctx.edit(e).set(c, v)` write to a `c` outside `access.write`
   * throws exactly (checks Rule 2's write-outside-query case). Out-of-tick edits are exempt
   * (`currentSystem === null`). DEV + armed only.
   */
  private enforceWriteAccess(c: Component): void {
    if (!this.accessArmed) return;
    const system = this.currentSystem;
    if (system === null) return;
    const w = system.access?.write;
    if (w === undefined || !w.some((x) => x.id === c.id)) {
      throw new Error(
        `strata: system "${system.name}" wrote component "${c.name}" via edit().set but did not declare it in access.write.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Physical primitives (§5.5)
  // ---------------------------------------------------------------------------

  /** Append entity `e`'s row to archetype `A`, writing every field and the back-pointer. */
  private place(e: Entity, A: Archetype, fieldValues: ReadonlyMap<FieldId, Stored>): void {
    // petition 4: DELIBERATELY un-gated — inline-hot; every caller fires first (see fireWrite's placement rule).
    const row = A.count;
    A.ensureCapacity(row + 1);
    for (const f of A.fields) {
      writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, fieldValues.get(f.fieldId) as Stored);
    }
    A.entities[row] = e;
    this.table.setPlacement(slotOf(e), A.id, row);
    A.count++;
    if (this.reactiveOn) A.lastStructuralFrame = this.frameCounter; // rows-version bump (002 §4.2)
  }

  /**
   * Remove the row at `(A, row)` via swap-and-pop, fixing the moved entity's back-pointer and
   * nulling vacated string cells (§5.5). Takes `A`/`row` explicitly — never re-reads the table,
   * which the migrate caller may already have re-pointed.
   */
  private unplace(A: Archetype, row: number, _vacating: Entity): void {
    // petition 4: DELIBERATELY un-gated — inline-hot; every caller fires first (see fireWrite's placement rule).
    const last = A.count - 1;
    if (row !== last) {
      const moved = A.entities[last] as Entity;
      for (const f of A.fields) {
        moveCell(A.columns.get(f.fieldId) as Column, f.kind, last, row); // last → row (+ null source if string)
      }
      A.entities[row] = moved;
      this.table.setRow(slotOf(moved), row); // fix the MOVED entity, not the vacating one
    } else {
      for (const f of A.fields) {
        clearCell(A.columns.get(f.fieldId) as Column, f.kind, last); // null a bare-popped string cell
      }
    }
    A.count--;
    if (this.reactiveOn) A.lastStructuralFrame = this.frameCounter; // rows-version bump (002 §4.2)
  }

  /**
   * Move `e` to `newComponentIds`, carrying overlapping fields. Read-before-place-before-unplace:
   * carried values are read from the old row first, then `place` re-points the table, then the old
   * row is swap-popped by its captured location (§5.5).
   */
  private migrate(
    e: Entity,
    newComponentIds: readonly ComponentId[],
    addedFieldValues: ReadonlyMap<FieldId, Stored>,
  ): void {
    const slot = slotOf(e);
    const oldA = this.archetypesById[this.table.archetypeOf(slot)];
    const oldRow = this.table.rowOf(slot);
    const newA = this.archetypeFor(newComponentIds);

    const fieldValues = new Map<FieldId, Stored>();
    for (const f of newA.fields) {
      if (oldA.hasField(f.fieldId)) {
        fieldValues.set(f.fieldId, readCell(oldA.columns.get(f.fieldId) as Column, f.kind, oldRow));
      } else {
        fieldValues.set(f.fieldId, addedFieldValues.get(f.fieldId) as Stored);
      }
    }
    this.place(e, newA, fieldValues); // appends to newA, re-points table[slot] → newA
    this.unplace(oldA, oldRow, e); // swap-pop out of the captured old location
    // Reconcile the destination's per-column value stamps (002 §2.2(2)). One pass over the
    // destination's sorted componentIds (the loop index IS the stamp slot — no scans):
    //   - ADDED column (absent in the source) → a gained component is a value write → stamp now.
    //   - CARRIED column → carry the source's stamp FORWARD (max), so a value write made in the SAME
    //     frame as the migrate (its stamp lives in the OLD archetype) is not lost to a Tier-2/3 watch
    //     reading the entity's NEW archetype (adversarial-review fix). `max` never downgrades a
    //     destination column another entity stamped more recently.
    // Skipped wholesale until reactivity is enabled (the bench gate caught the always-on variant at
    // +28% on add_remove).
    if (this.reactiveOn) {
      const ids = newA.componentIds;
      const lwf = newA.lastWrittenFrame;
      for (let slot = 0; slot < ids.length; slot++) {
        const oldSlot = oldA.componentSlot(ids[slot]);
        if (oldSlot < 0) {
          lwf[slot] = this.frameCounter; // added column
          this.bumpComponentMax(ids[slot]); // R5: a gained component is a value write — un-skip it
        } else {
          const carried = oldA.lastWrittenFrame[oldSlot];
          if (carried > lwf[slot]) lwf[slot] = carried; // carry the pre-migrate value stamp forward
          // No MAX bump for carried columns: the original write already bumped componentMaxFrame at
          // its frame, and that frame is what the destination stamp now carries (§ enumeration §1).
        }
      }
      // R5: REMOVED components (present in the source, gone in the destination) have no column left to
      // stamp, but a Tier-2/3 watch must still fire `undefined` — bump the MAX so the skip can't eat it.
      const oldIds = oldA.componentIds;
      for (let i = 0; i < oldIds.length; i++) {
        if (newA.componentSlot(oldIds[i]) < 0) this.bumpComponentMax(oldIds[i]);
      }
    }
  }

  private static sortedInsert(ids: readonly ComponentId[], id: ComponentId): ComponentId[] {
    return [...ids, id].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  // Identity + placement seams (used by projection, Parts II–IV; §Part I ref)
  // ---------------------------------------------------------------------------

  /** Mint an identity with no placement (§5.2). */
  allocateIdentity(): Entity {
    if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — covers ctx/tx/eph spawn + projector resolves
    const e = this.table.allocate();
    // The entity exists from here (ctx.spawn's eager identity, §5.2) — this is its one onSpawn;
    // the flush-time placement of the same entity deliberately does not fire again.
    if (this.observerList !== null) this.emitSpawn(e);
    return e;
  }

  /** Idempotently place an identity-only entity into the empty archetype (§5.5). */
  ensurePlaced(e: Entity): void {
    if (this.table.isIdentityOnly(e)) {
      // petition 4 — the identity-only → placed transition (tag/relation on identity-only, projector
      // spawn resolves). Fires only when actually placing; the idempotent no-op is not a write.
      if (DEV && this.writeHooks !== null) this.fireWrite("structural");
      this.place(e, this.emptyArchetype, EMPTY_FIELD_VALUES);
    }
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  /** Place an already-allocated identity into its components' archetype and set its tags. */
  private placeComposed(
    e: Entity,
    componentIds: ComponentId[],
    fieldValues: ReadonlyMap<FieldId, Stored>,
    tagIds?: readonly number[],
  ): void {
    this.place(e, this.archetypeFor(componentIds), fieldValues);
    if (tagIds !== undefined && tagIds.length > 0) {
      const slot = slotOf(e);
      for (const t of tagIds) this.tags.set(t, slot);
    }
  }

  /** Create and immediately place a runtime entity (§5.2 — outside iteration, so immediate). */
  spawn(init?: SpawnInit): Entity {
    if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — spawn entry, before table.allocate (its own inline mint, not allocateIdentity)
    if (DEV && this.inObserverEmit) {
      devError("observer callbacks must not mutate the world — spawn() from inside an observer (observe.ts).");
    }
    // Validate + encode BEFORE minting the identity: a bad value must throw with no identity
    // allocated, or the failed spawn would leak a live unreachable entity (and one for which
    // onSpawn never fired, breaking the exactly-once contract).
    const seen = new Set<ComponentId>();
    const fieldValues = new Map<FieldId, Stored>();
    for (const [component, value] of init?.components ?? []) {
      if (seen.has(component.id)) {
        throw new Error(`strata: component "${component.name}" supplied twice to spawn.`);
      }
      seen.add(component.id);
      for (const [fid, v] of encodeComponentValue(component, value as Record<string, unknown>)) {
        fieldValues.set(fid, v);
      }
    }
    const e = this.table.allocate();
    this.placeComposed(
      e,
      [...seen].sort((a, b) => a - b),
      fieldValues,
      init?.tags?.map((t) => t.id),
    );
    if (this.observerList !== null) this.emitSpawn(e); // after placement — readable in the hook
    return e;
  }

  /** Destroy an entity: clear its tags/relations inline, unplace, then free identity (§5.5). */
  destroy(e: Entity): void {
    if (DEV && this.inObserverEmit) {
      devError("observer callbacks must not mutate the world — destroy() from inside an observer is ignored (observe.ts).");
      return;
    }
    if (!this.table.isAlive(e)) return;
    // petition 4 — fire AFTER the dead-handle early-return (a no-op destroy is not a write) and BEFORE any
    // teardown (the observer emit / reactive death hook / relation+tag cascade / unplace), so a throwing
    // hook is a clean veto: the entity is untouched and still alive when the throw propagates.
    if (DEV && this.writeHooks !== null) this.fireWrite("structural");
    // BEFORE teardown, so the dying entity is still fully readable inside the hook (observe.ts).
    // Covers both surfaces: immediate world.destroy and the flush's despawn command (§5.4).
    if (this.observerList !== null) this.emitDestroy(e);
    // The reactive layer's eager-death queue (002 §3.4) — a dedicated slot, not a WorldObserver, so it
    // never lights up the T0 tick-telemetry path. Pre-teardown + queue-only (fires undefined at notify).
    if (this.reactiveDeathHook !== null) this.reactiveDeathHook(e);
    const slot = slotOf(e);
    // Per-entity state living outside the archetype must be torn down for placed AND identity-only
    // entities so a reused slot starts clean (§5.5). Teardown moves no archetype row but DOES change
    // tag/relation-filtered membership, so it stamps every membership id it actually touched (§4.2
    // per-id) — the substores report each cleared id, and only when reactive (else the report callbacks
    // are undefined and the substores skip the bookkeeping, keeping the non-reactive path zero-cost).
    // This covers watches on a tag the entity carried, rel-filtered watches on its outgoing edges, and
    // seeded watches whose target was this entity (its incoming edges clear → that relation is reported).
    const onRel = this.reactiveOn ? this.onRelTeardown : undefined;
    const onTag = this.reactiveOn ? this.onTagTeardown : undefined;
    this.relations.clearEntity(e, onRel); // both directions, inline, terminal
    this.tags.clearAll(slot, onTag); // mandatory — bitsets are slot-indexed, not generation-indexed (§3.2)
    if (this.table.isPlaced(e)) {
      const A = this.archetypesById[this.table.archetypeOf(slot)];
      this.unplace(A, this.table.rowOf(slot), e);
    }
    this.table.free(e);
  }

  isAlive(e: Entity): boolean {
    return this.table.isAlive(e);
  }
  isPlaced(e: Entity): boolean {
    return this.table.isPlaced(e);
  }
  isIdentityOnly(e: Entity): boolean {
    return this.table.isIdentityOnly(e);
  }

  /**
   * @internal Clear the world IN PLACE (R3), keeping this store's identity and every attached
   * observer + reactive registration. Surfaced via `world.reset()` (World rejects the mid-tick
   * case); a `world.import(bytes, { replace: true })` is reset-then-import. Contract:
   *
   * - **No alias.** Every live slot is freed WITH a generation bump (entity-table.reset), so every
   *   pre-reset handle reads dead — never aliased to an entity later minted at the same slot. This
   *   is the point: a fresh-world swap re-mints identical slot/gen sequences, so a stale pre-swap
   *   handle silently aliased a restored entity; freeing in place is strictly safer.
   * - **Archetypes are KEPT but emptied.** Their object identity backs the Tier-1 query caches
   *   (`queryMatches` / a watch's `matches` reference), which must stay valid; only rows are dropped.
   *   Tags, relations, and resources are cleared wholesale (no per-entity cascade — reset IS the
   *   cascade). The command buffers are pooled-empty at rest (reset runs only outside a tick), so
   *   there is no pending deferred state to clear.
   * - **WorldObserver attachments SURVIVE.** Per-entity `onDestroy` is NOT fired; a single `onReset`
   *   fires AFTER teardown (observe.ts).
   * - **Reactive registrations SURVIVE and settle at the next `notify()`.** Tier-1 watches wake from
   *   the emptied archetypes' bumped `lastStructuralFrame` + the per-id tag/relation membership stamps
   *   (every known id is bumped before the clear); Tier-2/3 entity watches
   *   see their now-dead entity (generation bumped) via notifyWatches' dead-entity path and fire
   *   `undefined` once + self-remove; resource watches see the cleared value via bumped resource
   *   stamps. All stamps sit at the CURRENT frame — reset is a normal mutation burst and does NOT
   *   advance the frame (notify still owns that boundary, 002 §4.1a), so a watch subscribed AFTER a
   *   reset but before the next notify is correctly baselined and does not fire for the reset.
   *
   * Rejected from inside an observer/reactive callback (mid-emit): a wholesale teardown there would
   * corrupt an in-flight dispatch — the same posture as {@link rejectMutationInEmit}.
   */
  reset(): void {
    if (this.inObserverEmit) {
      throw new Error(
        "strata: world.reset() cannot run from inside an observer or reactive callback — reset only outside iteration (observe.ts).",
      );
    }
    if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — before arch.clear, so a veto leaves the world intact
    const frame = this.frameCounter; // reset stamps at the CURRENT frame — a normal mutation burst
    // Empty every archetype that holds rows (keep identity for the query caches). Bump the emptied
    // archetype's rows-version so surviving Tier-1 watches wake at the next notify (002 §4.2).
    for (const arch of this.archetypesById) {
      if (arch === undefined || arch.count === 0) continue;
      arch.clear();
      if (this.reactiveOn) arch.lastStructuralFrame = frame;
    }
    // Stamp every resource that HELD a value so its watch observes the transition to undefined at
    // the next notify — keyed off the live map (not resourceFrames' length) so a resource set BEFORE
    // reactivity armed, whose stamp is still 0, is covered too; grows resourceFrames as needed. Runs
    // BEFORE the clear so the ids are still known. A never-set resource stays at 0 and does not fire.
    if (this.reactiveOn) for (const id of this.resources.keys()) this.bumpResource(id as ResourceId);
    // Stamp EVERY known tag/relation id at the current frame so any row-filtered / relation-seeded
    // Tier-1 watch wakes at the next notify (§4.2 per-id). Runs BEFORE the substores are cleared, like
    // the resource loop above, so the ids are still enumerable; stamping an id whose membership was
    // already empty is a harmless over-fire (may-over-fire-never-miss).
    if (this.reactiveOn) {
      for (const id of this.tags.knownIds()) this.bumpTag(id);
      for (const id of this.relations.knownIds()) this.bumpRel(id);
    }
    // Clear tags / relations / resources wholesale.
    this.tags.reset();
    this.relations.reset();
    this.resources.clear();
    // Free every live slot with a generation bump — stale handles now read dead, never aliased.
    this.table.reset();
    // R5: every watched entity just went dead (generations bumped) but reset does NOT queue the death
    // hook, so the Tier-2/3 undefined-fires ride notifyWatches' fallback path — which the fast-path
    // skip gates on componentMaxFrame. Bump EVERY component id so no such fire can be skipped.
    if (this.reactiveOn) this.bumpAllComponentMax();
    // WorldObserver roster survives — one wholesale onReset AFTER teardown (never per-entity onDestroy).
    if (this.observerList !== null) this.emitReset();
  }

  // ---------------------------------------------------------------------------
  // Components — shape changes (immediate on this surface)
  // ---------------------------------------------------------------------------

  has(e: Entity, c: Component): boolean {
    return this.table.isPlaced(e) && this.archetypeOfEntity(e).hasComponent(c.id);
  }

  /**
   * Reject a dead/stale handle before a mutating op. Without this, `!isPlaced` is true for BOTH
   * identity-only (state 2) and dead (state 1) handles, so a stale handle would fall into the
   * place-first branch and stamp a reused slot's placement — silent corruption (RS-1).
   */
  private assertAlive(e: Entity, op: string): void {
    if (!this.table.isAlive(e)) {
      throw new Error(
        `strata: ${op} called on a dead or stale entity handle (slot ${slotOf(e)}, generation ${genOf(e)}) — the entity was destroyed, or the handle predates a world reset/reload. Re-fetch a live handle before mutating.`,
      );
    }
  }

  /** Attach a component the entity does not have (shape change). Throws if already present (§5.3). */
  addComponent<S>(e: Entity, c: Component<S>, value: S): void {
    if (this.rejectMutationInEmit("addComponent")) return; // 002 §6 — no structural mutation from a callback
    this.assertAlive(e, "addComponent");
    if (this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is already present — use edit().set / writeComponent to overwrite its value.`);
    }
    if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — entry gate, before the place/migrate branch
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    if (this.table.isIdentityOnly(e)) {
      // identity-only → placing its first component (state 2 → 3, §5.2)
      this.place(e, this.archetypeFor([c.id]), encoded);
    } else {
      const newIds = RuntimeStore.sortedInsert(this.archetypeOfEntity(e).componentIds, c.id);
      this.migrate(e, newIds, encoded);
    }
  }

  /** Detach a component (shape change). Throws if absent (§5.3). Empty result stays placed (∅). */
  removeComponent(e: Entity, c: Component): void {
    if (this.rejectMutationInEmit("removeComponent")) return; // 002 §6
    this.assertAlive(e, "removeComponent");
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present — cannot remove it.`);
    }
    if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — entry gate (also covers projectRemoveComponent's present-delegate)
    const newIds = this.archetypeOfEntity(e).componentIds.filter((id) => id !== c.id);
    this.migrate(e, newIds, EMPTY_FIELD_VALUES);
  }

  /**
   * The single cell-overwrite primitive (R6): write `c`'s already-encoded fields into `e`'s row and
   * stamp the column. Sole owner of the "overwrite an in-place component's cells + value stamp"
   * shape — both {@link writeComponent} (edit path) and {@link projectComponent}'s overwrite branch
   * call it, so the loop + stamp live once. Assumes `e` is placed and already holds `c` (callers
   * check). The `reactiveOn` gate lives inside {@link stampComponent}, so this is zero-cost when the
   * reactive layer is untouched.
   */
  private doWriteCells(e: Entity, c: Component, encoded: ReadonlyMap<FieldId, Stored>): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("component"); // petition 4 — before the cell overwrite, so a veto keeps the old value
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    for (const f of c.fields) {
      writeCell(A.columns.get(f.fieldId) as Column, f.kind, row, encoded.get(f.fieldId) as Stored);
    }
    this.stampComponent(A, c.id); // edit-path value write (002 §2.2(3), 001 §3.1 route 2)
  }

  /** Overwrite the value of a component the entity already has (value change). Throws if absent. */
  writeComponent<S>(e: Entity, c: Component<S>, value: S): void {
    this.assertAlive(e, "writeComponent");
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present — use addComponent to attach it first.`);
    }
    // A value write from inside a reactive callback is legal and DETERMINISTIC: it stamps the NEXT
    // frame (see stampFrame), so the next notify() delivers it. (The old behavior — current-frame
    // stamp, nondeterministically lost — carried a DEV warn here; the fix retires it.)
    if (DEV) this.enforceWriteAccess(c); // 001 Rule 3: undeclared edit-path write throws before mutating
    this.doWriteCells(e, c, encodeComponentValue(c, value as Record<string, unknown>));
  }

  // ---------------------------------------------------------------------------
  // Component projection primitives (key-facing wrappers live in the projector, §10.3)
  // ---------------------------------------------------------------------------

  /** Projection: add-if-absent-else-write; places an identity-only entity on its first component. */
  projectComponent<S>(e: Entity, c: Component<S>, value: S): void {
    this.assertAlive(e, "projectComponent");
    const encoded = encodeComponentValue(c, value as Record<string, unknown>);
    if (this.table.isIdentityOnly(e)) {
      if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — place branch
      this.place(e, this.archetypeFor([c.id]), encoded);
      this.stampComponent(this.archetypeOfEntity(e), c.id); // initial value of the projected column
    } else if (this.archetypeOfEntity(e).hasComponent(c.id)) {
      this.doWriteCells(e, c, encoded); // overwrite branch — fires "component" inside doWriteCells (R6)
    } else {
      if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — migrate branch
      const newIds = RuntimeStore.sortedInsert(this.archetypeOfEntity(e).componentIds, c.id);
      this.migrate(e, newIds, encoded); // migrate stamps the added column
    }
  }

  /** Projection: detach a component if present, else no-op. */
  projectRemoveComponent(e: Entity, c: Component): void {
    if (this.has(e, c)) this.removeComponent(e, c);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Whole-component read — throws if absent (hot-path reader, §Part I ref). */
  read<S>(e: Entity, c: Component<S>): S {
    if (!this.has(e, c)) {
      throw new Error(`strata: component "${c.name}" is not present on this entity.`);
    }
    return this.readPresent(e, c);
  }

  /** Safe read — `undefined` if absent or identity-only (§5.2). */
  get<S>(e: Entity, c: Component<S>): S | undefined {
    return this.has(e, c) ? this.readPresent(e, c) : undefined;
  }

  private readPresent<S>(e: Entity, c: Component<S>): S {
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    const out: Record<string, unknown> = {};
    for (const f of c.fields) {
      out[f.name] = decodeField(f.spec.type, readCell(A.columns.get(f.fieldId) as Column, f.kind, row));
    }
    return out as S;
  }

  /**
   * Read one field's decoded value with NO object allocation — the fast path for random access by
   * handle (whole-component {@link RuntimeStore.read} builds a value object per call). `undefined`
   * if the entity lacks `c` or `field` is not one of its fields. Generalizes {@link RuntimeStore.readEid}.
   */
  readField<S, K extends keyof S & string>(e: Entity, c: Component<S>, field: K): S[K] | undefined {
    if (!this.has(e, c)) return undefined;
    const meta = c.fieldByName.get(field);
    if (meta === undefined) return undefined;
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    return decodeField(meta.spec.type, readCell(A.columns.get(meta.fieldId) as Column, meta.kind, row)) as S[K];
  }

  /**
   * Read a validated `eid` field: the referenced entity, or `undefined` if the ref dangles (§2).
   * @internal Keyed by {@link FieldId} and liveness-validated — the store's own eid machinery. The
   * public read path is {@link RuntimeStore.readField} (keyed by name, decodes the raw handle).
   */
  readEid(e: Entity, c: Component, field: FieldId): Entity | undefined {
    if (!this.has(e, c)) return undefined;
    const A = this.archetypeOfEntity(e);
    const row = this.table.rowOf(slotOf(e));
    const ref = (readCell(A.columns.get(field) as Column, "u32", row) as number) as Entity;
    return this.table.isAlive(ref) ? ref : undefined;
  }

  // ---------------------------------------------------------------------------
  // Tag / relation stamp-owning primitives (R6) — the substore-write + membership bump, once
  // ---------------------------------------------------------------------------
  //
  // Each of the five (add/remove tag, set/add/remove relation) is the SOLE owner of its
  // "mutate the tag/relation substore + stamp the §4.2 per-id membership version" shape. Both the
  // guarded public ops below AND the flush arms in {@link applyCommand} call these — so the substore
  // call and the `bumpTag`/`bumpRel` are written once, not hand-copied per surface. Each stamps ONLY
  // its own tag/relation id, so a row-filtered Tier-1 watch wakes per-id (see {@link tagFrames}). The
  // public ops keep their own preconditions (rejectMutationInEmit / assertAlive / arity throws); the
  // flush arms keep theirs (validate-on-read at the top of applyCommand, drop-on-dead-target). The
  // `reactiveOn` gate lives inside {@link bumpTag}/{@link bumpRel}, so these are zero-cost when
  // reactivity is untouched.

  private doAddTag(e: Entity, tagId: number): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("tag"); // petition 4 — before ensurePlaced (which may over-fire "structural")
    this.ensurePlaced(e); // an identity-only source becomes queryable once tagged (§5.2)
    this.tags.set(tagId, slotOf(e));
    this.bumpTag(tagId); // this tag's filtered membership changed (002 §4.2)
  }

  private doRemoveTag(e: Entity, tagId: number): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("tag"); // petition 4
    this.tags.clear(tagId, slotOf(e)); // does not unplace the entity
    this.bumpTag(tagId);
  }

  private doSetRelation(e: Entity, rel: Relation, target: Entity): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("relation"); // petition 4 — before ensurePlaced (which may over-fire "structural")
    this.ensurePlaced(e); // places the source; the target is not placed (§5.2)
    this.relations.setOne(rel, e, target);
    this.bumpRel(rel.id); // this relation's filtered membership changed (002 §4.2)
  }

  private doAddRelation(e: Entity, rel: Relation, target: Entity): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("relation"); // petition 4
    this.ensurePlaced(e);
    this.relations.addMany(rel, e, target);
    this.bumpRel(rel.id);
  }

  private doRemoveRelation(e: Entity, rel: Relation, target?: Entity): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("relation"); // petition 4
    this.relations.remove(rel, e, target); // remove one edge (target given) or all; does not unplace
    this.bumpRel(rel.id);
  }

  // ---------------------------------------------------------------------------
  // Tags (slot-indexed bitsets, §3.2)
  // ---------------------------------------------------------------------------

  /** Add a tag; places an identity-only source so it becomes queryable (§5.2). */
  addTag(e: Entity, t: Tag): void {
    if (this.rejectMutationInEmit("addTag")) return; // 002 §6
    this.assertAlive(e, "addTag");
    this.doAddTag(e, t.id);
  }

  /** Remove a tag (does not unplace the entity). */
  removeTag(e: Entity, t: Tag): void {
    if (this.rejectMutationInEmit("removeTag")) return; // 002 §6
    this.assertAlive(e, "removeTag");
    this.doRemoveTag(e, t.id);
  }

  /** Generation-guarded tag read: a stale handle reads `false`, never the reused slot's bit (§3.2). */
  hasTag(e: Entity, t: Tag): boolean {
    if (!this.table.isAlive(e)) return false;
    return this.tags.has(t.id, slotOf(e));
  }

  /** @internal Raw tag bitset — for the query engine's row probes (§6). */
  tagBitset(t: Tag): Uint32Array | undefined {
    return this.tags.bitset(t.id);
  }

  // ---------------------------------------------------------------------------
  // Relations (bidirectional indices, §3.3)
  // ---------------------------------------------------------------------------

  /** Arity "one": set/replace the target. Places the source; the target is not placed (§5.2). */
  setRelation(e: Entity, rel: Relation, target: Entity): void {
    if (this.rejectMutationInEmit("setRelation")) return; // 002 §6
    this.assertAlive(e, "setRelation");
    if (rel.arity !== "one") {
      throw new Error(`strata: setRelation is for arity "one" relations — use addRelation for "${rel.name}".`);
    }
    this.doSetRelation(e, rel, target);
  }

  /** Arity "many": add an edge (idempotent). Places the source; the target is not placed. */
  addRelation(e: Entity, rel: Relation, target: Entity): void {
    if (this.rejectMutationInEmit("addRelation")) return; // 002 §6
    this.assertAlive(e, "addRelation");
    if (rel.arity !== "many") {
      throw new Error(`strata: addRelation is for arity "many" relations — use setRelation for "${rel.name}".`);
    }
    this.doAddRelation(e, rel, target);
  }

  /** Remove one edge (if `target` given) or all edges of `rel` from `e`. Does not unplace. */
  removeRelation(e: Entity, rel: Relation, target?: Entity): void {
    if (this.rejectMutationInEmit("removeRelation")) return; // 002 §6
    this.assertAlive(e, "removeRelation");
    this.doRemoveRelation(e, rel, target);
  }

  /** The single target of an arity-"one" relation, validated (§3.3). */
  getRelation(e: Entity, rel: Relation): Entity | undefined {
    return this.relations.getOne(rel, e);
  }

  /** The targets of an arity-"many" relation, validated. */
  getRelations(e: Entity, rel: Relation): Entity[] {
    return this.relations.getMany(rel, e);
  }

  /** The entities pointing at `e` via `rel` (reverse index), validated. */
  getReverse(e: Entity, rel: Relation): Entity[] {
    return this.relations.getReverse(rel, e);
  }

  // ---------------------------------------------------------------------------
  // Resources (world singletons, stored as plain objects, §1)
  // ---------------------------------------------------------------------------

  setResource<S>(res: Resource<S>, value: S): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("resource"); // petition 4 — before the store, so a veto keeps the prior value (covers strata's own sync/attach status writes)
    // A setResource from inside a reactive callback is legal and DETERMINISTIC: it stamps the NEXT
    // frame (see stampFrame), so the next notify() delivers it. (Previously it stamped the current,
    // already-seen frame and was silently unobservable — that behavior and its DEV warn are retired.)
    const obj: Record<string, unknown> = {};
    const v = value as Record<string, unknown>;
    for (const f of res.fields) {
      if (v !== undefined && Object.prototype.hasOwnProperty.call(v, f.name)) {
        obj[f.name] = v[f.name];
      } else if (f.spec.hasDefault) {
        obj[f.name] = f.spec.default;
      } else {
        throw new Error(`strata: missing required field "${f.name}" for resource "${res.name}".`);
      }
    }
    this.resources.set(res.id, obj);
    this.bumpResource(res.id); // resource-version stamp (003 §1.2) — gated on reactiveOn
  }

  /**
   * Remove a resource — the reconcile path's `resource-remove` lands here (005 §6.1). Mirrors
   * {@link setResource}: same `bumpResource` stamp — including its frame+1 stamp inside a reactive
   * callback, so a remove issued from a callback is legal and delivered at the next notify (see
   * stampFrame) — but stamps ONLY if the resource was present. Removing an ABSENT resource is a
   * stampless no-op (`Map.delete` returns false), which makes projection idempotent — replaying a
   * `resource-remove` for a resource already gone changes nothing and notifies no one (conformance P7).
   */
  removeResource<S>(res: Resource<S>): void {
    if (DEV && this.writeHooks !== null) this.fireWrite("resource"); // petition 4 — fires at entry (may over-fire on an absent-resource no-op; never misses a real remove)
    if (this.resources.delete(res.id)) this.bumpResource(res.id); // stamp ONLY if it was present
  }

  getResource<S>(res: Resource<S>): S | undefined {
    return this.resources.get(res.id) as S | undefined;
  }

  // ---------------------------------------------------------------------------
  // Command buffer — the system-iteration deferral facility (§5.4, §5.5)
  // ---------------------------------------------------------------------------

  /** @internal Hand out a cleared buffer from the pool (grows the pool only on demand, §5.4). */
  allocateCommandBuffer(): CommandBuffer {
    const reused = this.freeBuffers.pop();
    if (reused !== undefined) {
      this.bufferPool[reused].length = 0;
      return reused;
    }
    this.bufferPool.push([]);
    return this.bufferPool.length - 1;
  }

  /** @internal Append a command (producer-agnostic; only a system's `ctx` calls this, §5.4). */
  enqueue(buf: CommandBuffer, cmd: StructuralCommand): void {
    const arr = this.bufferPool[buf];
    arr.push(cmd);
    // Fires once as the buffer crosses the cap (length resets to 0 at flush, so each phase re-arms).
    if (DEV && arr.length === this.commandBufferWarnThreshold) {
      devWarn(
        `command buffer reached ${arr.length} deferred ops in one phase — this is unbounded and may exhaust memory. Split the work across phases/ticks, or apply changes immediately outside iteration.`,
      );
    }
  }

  /** @internal Test-only: lower the command-buffer soft cap to exercise the back-pressure warning. */
  setCommandBufferWarnThresholdForTesting(n: number): void {
    this.commandBufferWarnThreshold = n;
  }

  /** @internal Single-pass drain: apply every command, then clear. `apply` never enqueues, so no growth (§5.4). */
  flushCommandBuffer(buf: CommandBuffer): void {
    const cmds = this.bufferPool[buf];
    const n = cmds.length; // apply never appends to this buffer → n is stable
    for (let i = 0; i < n; i++) this.applyCommand(cmds[i]);
    cmds.length = 0;
  }

  /** @internal Return a buffer to the pool when its phase is done. */
  releaseCommandBuffer(buf: CommandBuffer): void {
    this.bufferPool[buf].length = 0;
    this.freeBuffers.push(buf);
  }

  /**
   * Apply one buffered shape change (§5.5). Validate-on-read first (a command targeting an
   * entity an earlier command this flush destroyed is skipped), then dispatch to the primitives
   * with the flush-time precondition policy (idempotent no-ops; dev warn/error + skip).
   */
  private applyCommand(cmd: StructuralCommand): void {
    if (!this.table.isAlive(cmd.entity)) return; // validate-on-read
    switch (cmd.kind) {
      case "spawn": {
        // petition 4 — flush structural arms fire here (place/unplace/migrate are deliberately un-gated).
        if (DEV && this.writeHooks !== null) this.fireWrite("structural");
        const seen = new Set<ComponentId>();
        const fieldValues = new Map<FieldId, Stored>();
        for (const init of cmd.components ?? []) {
          const c = componentById(init.component);
          if (c === undefined || seen.has(init.component)) continue;
          seen.add(init.component);
          for (const [fid, v] of encodeComponentValue(c, init.value as Record<string, unknown>)) {
            fieldValues.set(fid, v);
          }
        }
        this.placeComposed(cmd.entity, [...seen].sort((a, b) => a - b), fieldValues, cmd.tags);
        return;
      }
      case "despawn":
        this.destroy(cmd.entity); // cascade + free (§5.5)
        return;
      case "addComponent": {
        const c = componentById(cmd.component);
        if (c === undefined) return;
        if (this.has(cmd.entity, c)) {
          devError(
            `addComponent at flush: "${c.name}" is already present (two systems added it in one phase?) — skipped; use a value write to overwrite.`,
          );
          return;
        }
        if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — flush addComponent arm
        const encoded = encodeComponentValue(c, cmd.value as Record<string, unknown>);
        if (this.table.isIdentityOnly(cmd.entity)) {
          this.place(cmd.entity, this.archetypeFor([c.id]), encoded);
        } else {
          this.migrate(
            cmd.entity,
            RuntimeStore.sortedInsert(this.archetypeOfEntity(cmd.entity).componentIds, c.id),
            encoded,
          );
        }
        return;
      }
      case "removeComponent": {
        const c = componentById(cmd.component);
        if (c === undefined) return;
        if (!this.has(cmd.entity, c)) {
          devWarn(`removeComponent at flush: "${c.name}" is not present — skipped.`);
          return;
        }
        if (DEV && this.writeHooks !== null) this.fireWrite("structural"); // petition 4 — flush removeComponent arm
        this.migrate(
          cmd.entity,
          this.archetypeOfEntity(cmd.entity).componentIds.filter((id) => id !== c.id),
          EMPTY_FIELD_VALUES,
        );
        return;
      }
      case "addTag":
        this.doAddTag(cmd.entity, cmd.tag); // substore-write + §4.2 bump, shared with the public op (R6)
        return;
      case "removeTag":
        this.doRemoveTag(cmd.entity, cmd.tag);
        return;
      case "setRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return; // drop an edge to a dead target
        this.doSetRelation(cmd.entity, rel, cmd.target);
        return;
      }
      case "addRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined || !this.table.isAlive(cmd.target)) return;
        this.doAddRelation(cmd.entity, rel, cmd.target);
        return;
      }
      case "removeRelation": {
        const rel = relationById(cmd.relation);
        if (rel === undefined) return;
        this.doRemoveRelation(cmd.entity, rel, cmd.target);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queries — per-chunk dispatch (§6)
  // ---------------------------------------------------------------------------

  /** Run a compiled query, dispatching the body once per matching chunk (§6.2). */
  query(q: Query): { each(fn: (batch: Batch) => void): void } {
    return { each: (fn) => this.runQuery(q, fn) };
  }

  /** The first entity matching `q`, or `undefined` (§Part I ref). */
  firstOf(q: Query): Entity | undefined {
    let found: Entity | undefined;
    this.runQuery(q, (batch) => {
      if (found !== undefined) return;
      for (const r of batch) {
        found = batch.entity(r);
        break;
      }
    });
    return found;
  }

  private runQuery(q: Query, fn: (batch: Batch) => void): void {
    if (q.seed !== undefined) {
      this.runSeeded(q, fn);
      return;
    }
    let matches = this.queryMatches.get(q);
    if (matches === undefined) {
      matches = this.buildMatches(q);
      this.queryMatches.set(q, matches);
    }
    const dense = q.rowFilters.length === 0;
    for (const arch of matches) {
      if (arch.count === 0) continue; // an empty archetype matches nothing (cheap skip)
      let rows: Int32Array;
      let count: number;
      if (dense) {
        rows = this.ensureIdentity(arch.count); // shared ascending array; no per-chunk allocation
        count = arch.count;
      } else {
        // Materialize matched rows with ONE filter pass into shared scratch, then copy to an
        // exact-size buffer the chunk owns — so a query nested inside the body can safely reuse
        // scratch. Replaces the former per-row generator (see docs/perf-hotpath.md).
        const scratch = this.ensureScratch(arch.count);
        count = this.fillMatchedRows(arch, q.rowFilters, scratch);
        rows = scratch.slice(0, count);
      }
      fn(new ArchetypeChunk(this, arch, rows, count, dense));
    }
  }

  /** Concrete-target relation: start from the reverse-index hit set, then verify every other term (§6.4). */
  private runSeeded(q: Query, fn: (batch: Batch) => void): void {
    const seed = q.seed as NonNullable<Query["seed"]>;
    const sources = this.relations.reverseSet(seed.relation, seed.target);
    if (sources === undefined) return;
    for (const src of sources) {
      if (!this.table.isAlive(src)) continue; // validate-on-read
      if (!this.table.isPlaced(src)) continue; // needs a row to be readable
      const arch = this.archetypeOfEntity(src);
      if (!this.archetypeMatchesQuery(q, arch)) continue;
      if (!this.passesRowFilters(q.rowFilters, src, arch)) continue;
      fn(new ArchetypeChunk(this, arch, Int32Array.of(this.table.rowOf(slotOf(src))), 1, false));
    }
  }

  private buildMatches(q: Query): Archetype[] {
    const out: Archetype[] = [];
    for (const arch of this.archetypesById) {
      if (arch !== undefined && this.archetypeMatchesQuery(q, arch)) out.push(arch);
    }
    return out;
  }

  private archetypeMatchesQuery(q: Query, arch: Archetype): boolean {
    for (const id of q.required) if (!arch.hasComponent(id)) return false;
    for (const id of q.excluded) if (arch.hasComponent(id)) return false;
    for (const group of q.anyComponentGroups) {
      let ok = false;
      for (const id of group) {
        if (arch.hasComponent(id)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }
    return true;
  }

  /**
   * Fill `scratch[0..return)` with the rows of `arch` whose entity passes every row filter, and
   * return the match count (§6.1). Fast path for a single tag filter — the common `tag` / `Not(tag)`
   * case — hoists the tag's bitset once and inlines the bit test, so there is no per-row `Map`
   * lookup (the dominant cost of a naive per-row `tags.has`). Other shapes fall back to the general
   * per-row predicate.
   */
  private fillMatchedRows(arch: Archetype, rowFilters: readonly RowFilter[], scratch: Int32Array): number {
    let n = 0;
    if (rowFilters.length === 1 && rowFilters[0].kind === "tag") {
      const rf = rowFilters[0];
      const bs = this.tags.bitset(rf.tagId as number); // hoisted out of the row loop (was per-row Map.get)
      const neg = rf.negate;
      const ents = arch.entities;
      const cnt = arch.count;
      for (let r = 0; r < cnt; r++) {
        const slot = slotOf(ents[r] as Entity);
        const word = slot >>> 5;
        const has = bs !== undefined && word < bs.length && ((bs[word] >>> (slot & 31)) & 1) === 1;
        if (has !== neg) scratch[n++] = r; // pass iff (neg ? !has : has)
      }
      return n;
    }
    for (let r = 0; r < arch.count; r++) {
      const e = arch.entities[r] as Entity;
      if (this.passesRowFilters(rowFilters, e, arch)) scratch[n++] = r;
    }
    return n;
  }

  /** @internal Evaluate all per-row filters for an entity (used by the seeded path + fallback). */
  passesRowFilters(rowFilters: readonly RowFilter[], e: Entity, arch: Archetype): boolean {
    for (const rf of rowFilters) if (!this.passesRowFilter(rf, e, arch)) return false;
    return true;
  }

  private passesRowFilter(rf: RowFilter, e: Entity, arch: Archetype): boolean {
    switch (rf.kind) {
      case "tag": {
        const has = this.tags.has(rf.tagId as number, slotOf(e));
        return rf.negate ? !has : has;
      }
      case "rel": {
        const rel = rf.relation as Relation;
        const has =
          rf.target !== undefined
            ? this.relations.hasEdge(rel, e, rf.target)
            : this.relations.hasAny(rel, e);
        return rf.negate ? !has : has;
      }
      case "any": {
        let ok = false;
        for (const m of rf.members as readonly MemberCheck[]) {
          if (this.memberCheck(m, e, arch)) {
            ok = true;
            break;
          }
        }
        return rf.negate ? !ok : ok;
      }
    }
  }

  private memberCheck(m: MemberCheck, e: Entity, arch: Archetype): boolean {
    switch (m.kind) {
      case "component":
        return arch.hasComponent(m.componentId as number);
      case "tag":
        return this.tags.has(m.tagId as number, slotOf(e));
      case "rel": {
        const rel = m.relation as Relation;
        return m.target !== undefined
          ? this.relations.hasEdge(rel, e, m.target)
          : this.relations.hasAny(rel, e);
      }
      case "all": {
        for (const mm of m.members as readonly MemberCheck[]) {
          if (!this.memberCheck(mm, e, arch)) return false;
        }
        return true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection (for tests / tooling)
  // ---------------------------------------------------------------------------

  /** @internal The archetype an entity is currently placed in, or `undefined` if identity-only.
   *  Legacy alias for {@link RuntimeStore.archetypeOf}; returns the internal {@link Archetype} type. */
  debugArchetypeOf(e: Entity): Archetype | undefined {
    return this.archetypeOf(e); // legacy alias — archetypeOf is the sanctioned reflection seam
  }

  // ---------------------------------------------------------------------------
  // Snapshot support (§8) — read-only walks over the live state
  // ---------------------------------------------------------------------------

  /** Number of live entities (placed + identity-only). */
  liveCount(): number {
    return this.table.liveCount;
  }

  /** Every placed entity, archetype by archetype (the order a snapshot walk emits). */
  placedEntities(): Entity[] {
    const out: Entity[] = [];
    for (const arch of this.archetypesById) {
      for (let r = 0; r < arch.count; r++) out.push(arch.entities[r] as Entity);
    }
    return out;
  }

  /** The components present on a placed entity. */
  componentsOf(e: Entity): Component[] {
    const arch = this.archetypeOfEntity(e);
    const out: Component[] = [];
    for (const id of arch.componentIds) {
      const c = componentById(id);
      if (c !== undefined) out.push(c);
    }
    return out;
  }

  /** The tags set on an entity (walks every tag type — for serialization). */
  tagsOf(e: Entity): Tag[] {
    const slot = slotOf(e);
    const out: Tag[] = [];
    for (let id = 0; id < tagCount(); id++) {
      if (this.tags.has(id, slot)) {
        const t = tagById(id);
        if (t !== undefined) out.push(t);
      }
    }
    return out;
  }

  /** The outgoing relation edges of an entity, validated (for serialization). */
  relationsOf(e: Entity): Array<{ relation: Relation; targets: Entity[] }> {
    const out: Array<{ relation: Relation; targets: Entity[] }> = [];
    for (let id = 0; id < relationCount(); id++) {
      const rel = relationById(id);
      if (rel === undefined) continue;
      const targets = rel.arity === "one" ? boxed(this.getRelation(e, rel)) : this.getRelations(e, rel);
      if (targets.length > 0) out.push({ relation: rel, targets });
    }
    return out;
  }

  /** Every set resource, with its handle (for serialization). */
  resourceValues(): Array<{ resource: Resource; value: unknown }> {
    const out: Array<{ resource: Resource; value: unknown }> = [];
    for (const [id, value] of this.resources) {
      const res = resourceById(id);
      if (res !== undefined) out.push({ resource: res, value });
    }
    return out;
  }
}

function boxed(e: Entity | undefined): Entity[] {
  return e !== undefined ? [e] : [];
}

/**
 * The per-archetype chunk (§6.2). For the dense path the iterator yields rows passing the
 * plan's row filters; for the seeded path it yields the pre-verified seed rows directly.
 */
class ArchetypeChunk implements Batch {
  constructor(
    private readonly store: RuntimeStore,
    private readonly arch: Archetype,
    /** Matched row indices, `rows[0 .. count)`. Shared identity array (dense) or an owned copy. */
    readonly rows: Int32Array,
    readonly count: number,
    private readonly dense: boolean,
  ) {}

  get denseCount(): number {
    return this.arch.count;
  }

  get isDense(): boolean {
    return this.dense;
  }

  col<S, Sch>(c: Component<S, Sch>): ColumnsOf<Sch> {
    if (DEV) this.store.enforceColAccess(c); // 001 Rule 3 — undeclared access throws before any element (no-op unless armed + in a system)
    const out: Record<string, Column> = {};
    for (const f of c.fields) out[f.name] = this.arch.columns.get(f.fieldId) as Column;
    // The dynamic build is typed as a loose column bag; ColumnsOf<Sch> is the field-precise view of
    // the same object (each key routes to its declared column, verified by columnKindOf/allocColumn).
    return out as ColumnsOf<Sch>;
  }

  entity(r: number): Entity {
    return this.arch.entities[r] as Entity;
  }

  getRelated(r: number, rel: Relation): Entity | undefined {
    const e = this.entity(r);
    if (rel.arity === "one") return this.store.getRelation(e, rel);
    const all = this.store.getRelations(e, rel);
    return all.length > 0 ? all[0] : undefined;
  }

  getAllRelated(r: number, rel: Relation): Entity[] {
    const e = this.entity(r);
    if (rel.arity === "one") {
      const t = this.store.getRelation(e, rel);
      return t !== undefined ? [t] : [];
    }
    return this.store.getRelations(e, rel);
  }

  [Symbol.iterator](): Iterator<number> {
    // Non-generator iterator over the pre-materialized matched rows, reusing ONE result object (no
    // per-row allocation — a generator/naive iterator allocates `{value,done}` every `next()`). Still
    // pays the iterator-protocol call overhead; the raw `for (let i=0;i<b.count;i++) b.rows[i]` loop
    // is faster and is the documented hot path (§6.2).
    const rows = this.rows;
    const count = this.count;
    let i = 0;
    const result: { value: number; done: boolean } = { value: 0, done: false };
    return {
      next(): IteratorResult<number> {
        if (i < count) {
          result.value = rows[i++];
          result.done = false;
        } else {
          result.done = true;
        }
        return result as IteratorResult<number>;
      },
    };
  }
}

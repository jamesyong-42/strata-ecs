/**
 * The world — the application-facing handle over an {@link RuntimeStore} (design §7, §16).
 *
 * `world.*` mutations run OUTSIDE any system iteration, so shape changes apply immediately
 * (nothing is iterating, §5.2). `world.tick(pipeline)` runs systems — where `ctx.*` shape
 * changes defer to the phase boundary. `world.sync()` drains any attached inbound sources; in a
 * pure Part I world there are none, so it is a no-op (the hook Parts III–IV register into, §16).
 */

import type { Entity } from "./entity";
import type { Component, Relation, Resource, SpawnInitOf, Tag } from "./schema";
import type { FieldInput } from "./field";
import type { Batch, Query } from "./query";
import { DEV, devError } from "./dev";
import type { WorldObserver } from "./observe";
import { RuntimeStore, type WriteKind } from "./runtime-store";
import { type EntityEditor, type Pipeline, type System, type TickSystem, SystemCtx, makeEditor } from "./system";
import { Reactive } from "./reactive";
import { validatePipelineAccess } from "./access-diagnostics";
import { applySnapshot, exportSnapshot, importSnapshot, parseSnapshot } from "./snapshot";

/** What the world knows about a layer's inbound rhythm — the entire coupling (§16.1). */
export interface InboundSource {
  /**
   * Drain this source's pending inbound facts into the runtime (§16.1), once per `world.sync()` at the
   * frame boundary. IMPLEMENTATIONS MUST DEV-assert the store is NOT inside an observer / reactive emit
   * at drain() entry (read the `@internal` `RuntimeStore.inObserverEmitActive` hook, 005 §5.5): a drain
   * mid-`notify()` would HALF-apply a `ChangeBatch` — the projection primitives are unguarded (they must
   * run mid-drain) while the structural mutators reject in-emit, so adds/writes land and removes/despawns
   * vanish. `world.sync()`'s own in-emit check below is the SYNC-PATH defense, not a substitute — a source
   * drained by any other caller still owes this assert at entry.
   */
  drain(): void;
}

export class World {
  private readonly store = new RuntimeStore();
  private readonly inbound: InboundSource[] = [];
  private tickCounter = 0;
  /**
   * The reactive layer (Patch Note 002), created lazily on first `world.reactive` access and cached
   * for this World's life — `null` until then, so a pure Part I world that never observes pays
   * nothing (no per-system stamping, no dev-enforcement). Does NOT survive a world swap (002 §6).
   */
  private reactiveInstance: Reactive | null = null;
  /**
   * True for the duration of `tick()` — the guard `reset()` reads so an in-place teardown can never
   * run mid-tick / mid-flush (it would corrupt an in-flight command-buffer drain or system pass).
   */
  private ticking = false;
  /**
   * Depth of nested query dispatches the facade is currently inside (006 §A4). Incremented/decremented
   * (try/finally) around every `world.query(q).each` and both `store.query(...).each` walks in
   * `tick()`. A depth COUNTER, not a boolean, because query walks legitimately nest (a system iterating
   * a sub-query). Every World STRUCTURAL method throws while this is > 0, in ALL builds — a
   * mid-iteration archetype migration reorders the rows the walk is stepping over (memory corruption,
   * not a style violation), so the guard is unconditional. Value writes stay exempt (they reorder no
   * columns). Owned by the facade — the `RuntimeStore` never consults it (storage-ownership ≠
   * semantics-ownership, the §3 buffer-pool precedent).
   */
  private iterationDepth = 0;
  /**
   * The RUNNING system's declared write set while its body executes under an armed reactive layer —
   * `null` otherwise (out-of-tick, reactive off, or no declared writes). Read by every attributed
   * query walk ({@link World.walkAttributed}) to blanket-stamp the writes over the walked query's
   * matches at walk end (001 §3.1 route 1, generalized by petition 5 to inner walks — a raw
   * `batch.col()` write through an inner query must never be missed by reactivity). Deliberately NOT
   * the DEV `beginSystemAccess` window: stamping is a production mechanism, enforcement is not.
   * Cleared after each system and in the phase finally (a thrown body must not leak attribution into
   * out-of-tick walks).
   */
  private activeSystemWrites: readonly Component[] | null = null;
  readonly name: string;

  constructor(opts?: { name?: string }) {
    this.name = opts?.name ?? "world";
  }

  /** Ticks run so far — the tools' time axis (increments as each `tick()` enters, observe.ts). */
  get tickCount(): number {
    return this.tickCounter;
  }

  /**
   * The reactive observer layer (Patch Note 002). Lazily created + cached; READING this getter is
   * side-effect-free — the stamp/bump sites arm when the FIRST observe* call registers, not on
   * property access (review-part1 Tier-3 fix: a stray console.log of the world must not flip a
   * +17–28% profile switch). Each World has its own — it belongs to this world's store and dies
   * with it (002 §6).
   */
  get reactive(): Reactive {
    if (this.reactiveInstance === null) {
      this.reactiveInstance = new Reactive(this.store);
    }
    return this.reactiveInstance;
  }

  /** Whether reactive stamping is armed (side-effect-free probe; arms on the first observe* call). */
  get isReactiveEnabled(): boolean {
    return this.store.reactiveEnabled;
  }

  /**
   * Attach a dev-tool observer (observe.ts; docs/plan-tools-observer.md). Returns a detach
   * function. Zero cost when nothing is attached; observer callbacks must not mutate the world.
   */
  observe(obs: WorldObserver): () => void {
    return this.store.addObserver(obs);
  }

  /**
   * Register a DEV-only, synchronous, PRE-mutation **write hook** (petition 4). Returns a disposer. The
   * runtime half of the "law window" — {@link ReadonlyWorld} is the compile-time half (types erase, so a
   * cast back to `World` defeats it; this hook is what actually observes a write at runtime).
   *
   * WHERE IT FIRES — synchronously, BEFORE each mutation, at strata's internal chokepoints, DOWNSTREAM of
   * any bound method reference. So it observes EVERY route into the runtime, not just `world.*`:
   *   - `world.*` mutators, `world.edit(e).set(…)` editors, and the deferred `ctx.*` command-buffer flush;
   *   - a durable `doc.transaction`'s record-time identity mint + its seal's synchronous value/resource
   *     writes; `world.sync()` / `attachDurable` drain-and-project applies; `undo()`/`redo()` echoes;
   *   - the ephemeral mutators and inbound presence projection; snapshot `import`; `reset()`;
   *   - INCLUDING strata's OWN runtime-local status-resource writes during sync/attach (DurableSyncStatus,
   *     EphemeralSyncStatus, DurableUndoStatus) — those are `setResource`s and fire `"resource"`.
   * A compound op fires MORE THAN ONCE and may span kinds (a `ctx.spawn` fires `"structural"` at its eager
   * identity mint and again when the flush places it; a tag-add on an identity-only entity fires `"tag"`
   * then `"structural"`; an `import` fires once here then per imported entity). The guarantee is
   * fire-at-least-once-pre-mutation-per-logical-write, may-over-fire, NEVER-miss. Kinds:
   * add/removeComponent surface as `"structural"` (they migrate archetypes); value writes as `"component"`.
   *
   * THROWS PROPAGATE to the mutator's caller — DELIBERATELY unlike {@link WorldObserver} callbacks, which
   * are swallowed and reported. For a SINGLE-op mutation the fire precedes the first state change, so a
   * throwing hook is a CLEAN VETO: the op does not happen (`spawn` allocates nothing, `edit().set` keeps
   * the old value, `reset`/`import({replace:true})` leave the world untouched).
   *
   * NON-ATOMIC WINDOWS for THROWING hooks — a veto is clean only per single write. A throw partway through
   * a multi-write op leaves the earlier writes APPLIED:
   *   - `world.edit(e).set(A).set(B)` — a throw on B keeps A;
   *   - a throw during a `tick()` phase's command-buffer flush aborts the REST of the buffer (already-applied
   *     commands stand, and the phase does not re-flush);
   *   - a throw during a `doc.transaction` seal's value-write stage can leave the runtime ahead of the
   *     document (stage 1 runs before the Loro commit).
   * So ARM a throwing hook only in a window where no legitimate mutation runs — the render-pass law-window
   * use — never across `tick()` / `sync()`. Intended pattern: register ONCE, keep a caller-side `armed`
   * flag, and throw from the hook only while `armed` (flip it on around the read-only window, off otherwise).
   *
   * CARVE-OUT: raw column access is not a route — a `batch.col()` TypedArray write (the system hot path)
   * has no chokepoint by design, exactly the carve-out 002 §2.2 makes with `reactive.invalidate`; the hook
   * sees every OBJECT-level mutation route listed above.
   *
   * PRODUCTION: where `DEV` is false — a runtime with `process` under `NODE_ENV=production` (node/SSR, or
   * a browser build that shims/defines `process`) — this is a no-op returning a no-op disposer and every
   * fire site is dead. HONEST CAVEAT (review 2026-07-11; see dev.ts): in an UN-SHIMMED browser production
   * bundle `DEV` evaluates true at runtime, so registration is LIVE and each mutation pays one roster
   * null-check (~ns; nothing fires while nothing is registered). Until strata ships dev/prod conditional
   * builds, gate your registration behind your OWN production flag if you target un-shimmed browsers.
   */
  devOnWrite(cb: (kind: WriteKind) => void): () => void {
    return this.store.devOnWrite(cb);
  }

  /**
   * Reject a structural mutation issued mid query-iteration (006 §A4). UNCONDITIONAL (all builds): a
   * mid-iteration archetype migration corrupts the walk. Names the op and points at the deferred
   * `ctx.*` form. Value writes never call this — they reorder no columns, so they stay legal.
   */
  private assertNotIterating(op: string): void {
    if (this.iterationDepth > 0) {
      throw new Error(
        `strata: world.${op}() cannot run during query iteration — a mid-iteration structural change reorders archetype rows and corrupts the walk; use the deferred ctx.* form inside a system, or mutate outside the query body.`,
      );
    }
  }

  /**
   * Bracket a query dispatch with `iterationDepth` so a structural `world.*` call from inside the body
   * throws (006 §A4). The finally always restores the depth, so a throwing body never strands the
   * guard armed; nesting increments it (nested walks are legal).
   */
  private eachGuarded(source: { each(fn: (batch: Batch) => void): void }, fn: (batch: Batch) => void): void {
    this.iterationDepth++;
    try {
      source.each(fn);
    } finally {
      this.iterationDepth--;
    }
  }

  /**
   * The attributed query walk (petition 5): guarded exactly like {@link World.eachGuarded}, then — if
   * a system with declared writes is running under an armed reactive layer — blanket-stamps those
   * writes over `q`'s matches (001 §3.1 route 1, generalized to every system-attributed walk). Backs
   * both `world.query` and `ctx.query`, so the two surfaces can never diverge: an inner walk from a
   * system body stamps identically whichever handle the body used. Out-of-tick the field is `null`
   * and this is `eachGuarded` plus one null test. The stamp is a value-frame bump on cached match
   * lists — no structural effect — so firing mid-outer-walk (inner walks run inside a body) is safe.
   */
  private walkAttributed(q: Query, fn: (batch: Batch) => void): void {
    this.eachGuarded(this.store.query(q), fn);
    const w = this.activeSystemWrites;
    if (w !== null) this.store.stampWrites(q, w);
  }

  /**
   * Run one schedule entry (petition 5): a tick system's body exactly once, or a chunk system's body
   * once per matching chunk. BOTH forms run inside the iteration guard — the uniform law is that no
   * system body mutates structure immediately or drives the frame (`world.tick`/`sync`/`import`/
   * `reset` and structural `world.*` all throw at depth > 0); shape changes go through `ctx` and land
   * at the phase boundary (§5.2). Without the bracket a tick body would run at depth 0 with the full
   * immediate-mutation surface — a hole the per-chunk form never had.
   */
  private dispatchSystem(system: System | TickSystem, ctx: SystemCtx): void {
    if (system.query === undefined) {
      this.iterationDepth++;
      try {
        system.body(ctx);
      } finally {
        this.iterationDepth--;
      }
    } else {
      this.eachGuarded(this.store.query(system.query), (batch) => system.body(batch, ctx));
    }
  }

  // --- entities / lifecycle (immediate) ---
  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity {
    this.assertNotIterating("spawn");
    return this.store.spawn(init);
  }
  destroy(e: Entity): void {
    this.assertNotIterating("destroy");
    this.store.destroy(e);
  }
  isAlive(e: Entity): boolean {
    return this.store.isAlive(e);
  }
  isPlaced(e: Entity): boolean {
    return this.store.isPlaced(e);
  }
  isIdentityOnly(e: Entity): boolean {
    return this.store.isIdentityOnly(e);
  }

  // --- shape changes (immediate — outside iteration, §5.2) ---
  addComponent<S>(e: Entity, c: Component<S>, v: S): void {
    this.assertNotIterating("addComponent");
    this.store.addComponent(e, c, v);
  }
  removeComponent(e: Entity, c: Component): void {
    this.assertNotIterating("removeComponent");
    this.store.removeComponent(e, c);
  }
  addTag(e: Entity, t: Tag): void {
    this.assertNotIterating("addTag");
    this.store.addTag(e, t);
  }
  removeTag(e: Entity, t: Tag): void {
    this.assertNotIterating("removeTag");
    this.store.removeTag(e, t);
  }
  setRelation(e: Entity, r: Relation, target: Entity): void {
    this.assertNotIterating("setRelation");
    this.store.setRelation(e, r, target);
  }
  addRelation(e: Entity, r: Relation, target: Entity): void {
    this.assertNotIterating("addRelation");
    this.store.addRelation(e, r, target);
  }
  removeRelation(e: Entity, r: Relation, target?: Entity): void {
    this.assertNotIterating("removeRelation");
    this.store.removeRelation(e, r, target);
  }

  // --- value writes / reads (immediate) ---
  edit(e: Entity): EntityEditor {
    return makeEditor(this.store, e);
  }
  read<S>(e: Entity, c: Component<S>): S {
    return this.store.read(e, c);
  }
  get<S>(e: Entity, c: Component<S>): S | undefined {
    return this.store.get(e, c);
  }
  /** Read one field with no allocation — the fast path for random access by handle. Keyed by field
   *  NAME and typed from the component's schema (`world.readField(e, Position, "x")` is `number |
   *  undefined`), §Part I ref. */
  readField<S, K extends keyof S & string>(e: Entity, c: Component<S>, field: K): S[K] | undefined {
    return this.store.readField(e, c, field);
  }
  has(e: Entity, c: Component): boolean {
    return this.store.has(e, c);
  }
  hasTag(e: Entity, t: Tag): boolean {
    return this.store.hasTag(e, t);
  }
  getRelation(e: Entity, r: Relation): Entity | undefined {
    return this.store.getRelation(e, r);
  }
  getRelations(e: Entity, r: Relation): Entity[] {
    return this.store.getRelations(e, r);
  }
  getReverse(e: Entity, r: Relation): Entity[] {
    return this.store.getReverse(e, r);
  }
  firstOf(q: Query): Entity | undefined {
    return this.store.firstOf(q);
  }

  /**
   * Iterate a query outside a tick — e.g. to render after `tick()` returns (§16). The body runs
   * once per matching chunk, exactly as a system's does; it should only READ (there is no command
   * buffer here, so shape changes are not deferred — use a system for those).
   */
  query(q: Query): { each(fn: (batch: Batch) => void): void } {
    // Bracket the user's body with the iteration guard (006 §A4) so a structural world.* call from
    // inside it throws — an out-of-tick walk is exactly the memory-corruption case the tick loop's
    // dispatches also guard. Reads stay free. Attributed (petition 5): called from inside a system
    // body, the walk stamps the running system's declared writes at walk end, same as `ctx.query`.
    return { each: (fn) => this.walkAttributed(q, fn) };
  }

  /**
   * Count the entities matching `q` — the sum of matched rows across every chunk (§6.2). Reuses the
   * query machinery and is iteration-safe (brackets the walk with the same guard as {@link World.query});
   * a pure read, so it may run mid-iteration.
   */
  count(q: Query): number {
    let n = 0;
    this.eachGuarded(this.store.query(q), (batch) => {
      n += batch.count;
    });
    return n;
  }

  /**
   * Materialize the entity handles matching `q` into a fresh array (§6.2). Convenience over a manual
   * walk; iteration-safe (brackets the walk with the query guard). Prefer {@link World.query} on the
   * hot path — this allocates the array plus one handle per match.
   */
  entities(q: Query): Entity[] {
    const out: Entity[] = [];
    this.eachGuarded(this.store.query(q), (batch) => {
      for (let i = 0; i < batch.count; i++) out.push(batch.entity(batch.rows[i]));
    });
    return out;
  }
  setResource<S>(res: Resource<S>, value: S): void {
    this.store.setResource(res, value);
  }
  /** Remove a resource (005 §6.1). Value-shaped — EXEMPT from the iteration guard (it reorders no
   *  columns), so it is legal mid-iteration exactly like `edit().set` and `setResource`. */
  removeResource<S>(res: Resource<S>): void {
    this.store.removeResource(res);
  }
  getResource<S>(res: Resource<S>): S | undefined {
    return this.store.getResource(res);
  }
  /**
   * Read a resource, apply `fn` to its current value, and write the result back — the read-modify-write
   * in one call, replacing the `const v = getResource(R)!; setResource(R, { ...v, ... })` mirror pattern.
   * Value-shaped like {@link World.setResource} (it reorders no columns), so it is legal mid-iteration.
   * Throws if the resource is unset — there is no current value to update; call setResource first.
   */
  updateResource<S>(res: Resource<S>, fn: (v: S) => S): void {
    const current = this.store.getResource(res);
    if (current === undefined) {
      throw new Error(
        `strata: updateResource("${res.name}") requires the resource to be set first — there is no current value to update. Call setResource to initialize it.`,
      );
    }
    this.store.setResource(res, fn(current));
  }

  // --- the frame ---

  /**
   * Run a pipeline once: per phase, run gated systems then flush that phase's buffer (§7).
   * When observers are attached (observe.ts) the same loop also emits tick/system/flush
   * telemetry; with none attached the only added cost is a branch-on-null per step.
   */
  tick(pipeline: Pipeline): void {
    // Ticks are driven from the FRAME BOUNDARY (sync() → tick(s) → notify() → render, 006 §16.4) and
    // never nest — inside iteration, inside another tick, or inside an emit. Guard all three at entry,
    // BEFORE touching `tickCounter`/`ticking`, so a rejected tick leaves the counters untouched.
    if (this.iterationDepth > 0) {
      // ALL builds: a tick dispatched mid query-walk would run systems that migrate archetypes under
      // the walk — memory corruption, not a style violation (rides the §A4 guard).
      throw new Error(
        "strata: world.tick() cannot run during query iteration — ticks are driven from the frame boundary (sync() → tick() → notify() → render) and never nest inside a query walk or a system body.",
      );
    }
    if (this.ticking) {
      // ALL builds: a re-entrant tick (tick-from-within-tick). Also closes the latent bug where a
      // nested tick's finally would clear `ticking` while the outer tick still runs, letting reset()
      // slip its mid-tick guard.
      throw new Error(
        "strata: world.tick() cannot run inside another tick() — one tick per frame boundary; a system must not drive the frame.",
      );
    }
    if (DEV && this.store.inObserverEmitActive) {
      // Mirrors sync()'s in-emit defense (§5.5): a tick from inside an observer / reactive callback
      // would half-apply its phase flushes — the mixed in-emit guards swallow structural commands
      // while value writes land — so it is forbidden. Schedule it for the next frame boundary.
      throw new Error(
        "strata: world.tick() cannot run from inside an observer or reactive callback — schedule it for the next frame boundary.",
      );
    }
    const tick = ++this.tickCounter;
    this.ticking = true; // reset() is rejected while this holds; the finally clears it even on a throw
    try {
      const obs = this.store.observers; // captured once — the tick-telemetry roster (observe.ts)
      const reactive = this.reactiveInstance; // null unless world.reactive was ever accessed — pure Part I pays nothing
      if (DEV && reactive !== null) validatePipelineAccess(pipeline); // advisory access diagnostics (001 §3.3), self-dedupes per pipeline
      let tickStart = 0;
      if (obs !== null) {
        tickStart = performance.now();
        for (let i = 0; i < obs.length; i++) {
          try {
            obs[i].onTickStart?.(tick);
          } catch (err) {
            reportObserverThrow(err);
          }
        }
      }
      for (const phase of pipeline) {
        const buf = this.store.allocateCommandBuffer();
        try {
          const ctx = new SystemCtx(this.store, buf, (q, fn) => this.walkAttributed(q, fn));
          if (phase.runIf !== undefined && !phase.runIf(ctx)) {
            if (obs !== null) {
              // a gated-off phase never flushes; report its systems as skipped so idle% stays live
              for (const system of phase.systems) emitSystemRun(obs, phase.name, system.name, false, 0);
            }
            continue;
          }
          for (const system of phase.systems) {
            if (system.runIf !== undefined && !system.runIf(ctx)) {
              if (obs !== null) emitSystemRun(obs, phase.name, system.name, false, 0);
              continue;
            }
            if (DEV && reactive !== null) this.store.beginSystemAccess(system); // 001 Rule 3 enforcement window
            // Arm walk attribution for this run (petition 5): inner walks — `ctx.query` or
            // `world.query` from the body — stamp the declared writes over what they walked.
            if (reactive !== null) {
              const w = system.access?.write;
              this.activeSystemWrites = w !== undefined && w.length > 0 ? w : null;
            }
            if (obs !== null) {
              const t0 = performance.now();
              this.dispatchSystem(system, ctx);
              emitSystemRun(obs, phase.name, system.name, true, (performance.now() - t0) * 1000);
            } else {
              this.dispatchSystem(system, ctx);
            }
            // Reactive change detection: blanket-stamp the system's declared writes over its OWN query
            // (001 §3.1 route 1, 002 §2.3). Tick systems have no query to stamp — their writes ride
            // the precise per-write stamps plus the per-walk stamps above. A gated-off system never
            // reaches here, so it never stamps (001 §3.4).
            if (reactive !== null) {
              const w = this.activeSystemWrites;
              if (w !== null && system.query !== undefined) this.store.stampWrites(system.query, w);
              this.activeSystemWrites = null;
            }
          }
          if (obs !== null) {
            const f0 = performance.now();
            this.store.flushCommandBuffer(buf); // phase boundary: shape changes become visible (§7)
            const micros = (performance.now() - f0) * 1000;
            for (let i = 0; i < obs.length; i++) {
              try {
                obs[i].onPhaseFlush?.(phase.name, micros);
              } catch (err) {
                reportObserverThrow(err);
              }
            }
          } else {
            this.store.flushCommandBuffer(buf); // phase boundary: shape changes become visible (§7)
          }
        } finally {
          // Clear the 001-enforcement window after the phase — also the backstop if a system body threw
          // (a stuck currentSystem would spuriously check out-of-tick edits before the next tick resets it).
          if (DEV && reactive !== null) this.store.endSystemAccess();
          // Same backstop for walk attribution (petition 5): a thrown body must not leak its write
          // set into out-of-tick `world.query` walks (a spurious stamp is legal over-fire, but sloppy).
          this.activeSystemWrites = null;
          // Always return the buffer to the pool — even if a system body throws (the pool must not
          // leak, and a thrown phase is simply abandoned without flushing).
          this.store.releaseCommandBuffer(buf);
        }
      }
      if (obs !== null) {
        const micros = (performance.now() - tickStart) * 1000;
        for (let i = 0; i < obs.length; i++) {
          try {
            obs[i].onTickEnd?.(tick, micros);
          } catch (err) {
            reportObserverThrow(err);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Drain all attached inbound sources (§16). A no-op in a pure Part I world (no sources). The frame
   * contract is `sync() → tick(s) → notify() → render` (006 §C2), so sync() runs at the frame
   * boundary and never mid-iteration nor mid-emit:
   * - throws when `iterationDepth > 0` (ALL builds) — draining mid-iteration would migrate archetypes
   *   under a live query walk (rides the A4 guard);
   * - DEV-asserts the store is not inside an observer / reactive callback — a drain there would
   *   HALF-apply a `ChangeBatch` (unguarded projection primitives land, guarded structural mutators
   *   are swallowed), the worst-case batch-atomicity violation (005 §5.5).
   */
  sync(): void {
    if (this.iterationDepth > 0) {
      throw new Error(
        "strata: world.sync() cannot run during query iteration — draining inbound facts mid-iteration would migrate archetypes under the walk; call sync() at the frame boundary, before tick().",
      );
    }
    if (DEV && this.store.inObserverEmitActive) {
      throw new Error(
        "strata: world.sync() cannot run from inside an observer or reactive callback — a drain there would half-apply a ChangeBatch (adds land, removes are swallowed); schedule it for the next frame boundary.",
      );
    }
    // Iterate a SNAPSHOT and re-check registration: a source may unregister itself (or a peer) from
    // inside its own drain() — teardown step 0, §5.6. A live for..of over `this.inbound` would splice
    // under the iterator and skip the NEXT source; snapshot + a still-registered guard drains each
    // surviving source exactly once and never a torn-down one (§16.1).
    for (const source of [...this.inbound]) {
      if (this.inbound.includes(source)) source.drain();
    }
  }

  /** Register an inbound source (a durable/ephemeral binding registers here on attach, §16). */
  registerInboundSource(source: InboundSource): void {
    this.inbound.push(source);
  }

  /**
   * The symmetric removal of {@link registerInboundSource} (005 §6.2) — a binding's teardown step 0,
   * so `world.sync()` never drains a torn-down binding again. An unknown source is a no-op.
   */
  unregisterInboundSource(source: InboundSource): void {
    const i = this.inbound.indexOf(source);
    if (i !== -1) this.inbound.splice(i, 1);
  }

  // --- local snapshot (non-collaborative save/load, §8) ---

  /** Serialize the world to bytes (off the hot path — an explicit call, §8). */
  export(): Uint8Array {
    return exportSnapshot(this.store, this.name);
  }

  /**
   * Load a snapshot. Plain `import` requires an EMPTY world (§8.2). `import(bytes, { replace: true })`
   * resets this world in place FIRST — the one-call document-open path that keeps the World identity
   * and every observer / reactive registration instead of forcing a world swap (R3, §16). See
   * {@link reset} for the survival + no-alias contract the replace form inherits.
   */
  import(bytes: Uint8Array, opts?: { replace?: boolean }): void {
    this.assertNotIterating("import"); // wholesale structural load — never mid-iteration (006 §A4)
    if (DEV && this.store.inObserverEmitActive) {
      // Mirrors sync()'s in-emit defense (§5.5): a wholesale load from inside an observer / reactive
      // callback lands entities/components through the unguarded projection primitives but SILENTLY
      // SWALLOWS the structural relation-edge writes (the mixed in-emit guards reject them) — a
      // half-applied document. Reject before parsing, both arms; schedule for the next frame boundary.
      throw new Error(
        "strata: world.import() cannot run from inside an observer or reactive callback — a wholesale load there lands entities but silently swallows relation edges; schedule it for the next frame boundary.",
      );
    }
    // petition 4 — the World-level chokepoint. Fire BEFORE the replace-branch's internal reset(): a
    // throwing (vetoing) hook must leave the world UNTOUCHED, and were it downstream of `this.reset()`
    // a veto would strand the world EMPTY. `if (DEV)` is dead where DEV folds false (see dev.ts).
    if (DEV) this.store.fireWriteFromWorld("structural");
    if (opts?.replace) {
      // Validate BEFORE resetting: an incompatible snapshot (schema drift) throws here with the
      // world untouched, so a failed document-open never wipes the live board (§8.2 boot-safety).
      const snapshot = parseSnapshot(bytes);
      this.reset();
      applySnapshot(this.store, snapshot);
    } else {
      importSnapshot(this.store, bytes);
    }
  }

  /**
   * Clear the world IN PLACE, keeping this World's identity and every attached observer / reactive
   * registration (§16; R3). Every pre-reset entity handle reads dead afterward — never aliased to a
   * later entity at the same slot, the hazard a fresh-world swap silently invited. WorldObserver
   * attachments survive (a single `onReset` fires, never per-entity `onDestroy`); reactive watches
   * survive and settle at the next `notify()` (Tier-1 wakes on the wipe, entity watches fire
   * `undefined` once + self-remove, resource watches see the cleared value). Must be called OUTSIDE
   * `tick()` and OUTSIDE an observer / reactive callback — both throw rather than corrupt iteration.
   */
  reset(): void {
    if (this.ticking) {
      throw new Error("strata: world.reset() cannot run during tick() — reset only outside iteration.");
    }
    this.assertNotIterating("reset"); // also refuse a reset issued from inside world.query().each() (006 §A4)
    this.store.reset(); // throws if called from inside an observer / reactive callback
  }

  /** @internal The underlying store — the seam Parts II–IV drive projection through. */
  get runtime(): RuntimeStore {
    return this.store;
  }

  /**
   * @internal True while an IMMEDIATE structural projection would be unsafe — mid query-iteration
   * (`iterationDepth > 0`, a walk whose archetype rows a migration would reorder) or inside `tick()`
   * (a phase flush in progress). A durable/ephemeral `attachDurable` reads this to refuse attaching at
   * such a moment, mirroring `sync()`'s own iteration guard (Part III §13.1): attach projects the whole
   * document synchronously through the projector — the same posture as a drain — so it must be barred
   * exactly where a drain is. Read-only INTROSPECTION, not durable coupling — the core names no layer
   * type; the layer consults a plain boolean. (The mid-observer-emit case is caught separately via the
   * store's `inObserverEmitActive`, matching `sync()`'s DEV in-emit assert.)
   */
  get inImmediateProjectionUnsafeContext(): boolean {
    return this.iterationDepth > 0 || this.ticking;
  }
}

/**
 * The names of every MUTATING method on {@link World} — the keys {@link ReadonlyWorld} strips (petition 4).
 * These are the ECS-data + frame-advancing writes: entity/component/tag/relation/resource mutation, the
 * `edit()` value-write factory, wholesale `import`/`reset`, and `tick`/`sync` (which run systems / drain
 * remote ops and therefore mutate). `edit`, `sync`, and `tick` are included precisely because each is a
 * door to a write even though its own name reads neutral.
 *
 * DELIBERATELY EXCLUDED, though public and state-changing: `registerInboundSource` /
 * `unregisterInboundSource`. They mutate the world's BINDING lifecycle (the inbound-source list), not ECS
 * data, and a render-pass law window has no reason to bar attaching/detaching a layer — so a `ReadonlyWorld`
 * keeps them. (The devwrite matrix's reflective drift-check classifies them explicitly as binding seams, so
 * a future ECS mutator added without a `WriteKind` fire site still fails that test.)
 */
export type WorldMutatorName =
  | "spawn"
  | "destroy"
  | "addComponent"
  | "removeComponent"
  | "addTag"
  | "removeTag"
  | "setRelation"
  | "addRelation"
  | "removeRelation"
  | "setResource"
  | "updateResource"
  | "removeResource"
  | "edit"
  | "import"
  | "reset"
  | "sync"
  | "tick";

/**
 * A compile-time READ-ONLY view of a {@link World} (petition 4) — every {@link WorldMutatorName} method
 * removed, leaving the queries/reads (`read`/`get`/`query`/`count`/`firstOf`/…), `observe`, `devOnWrite`,
 * the `reactive` getter, `tickCount`, `export`, and the liveness probes. The COMPILE-TIME half of a "law
 * window": hand a system / render pass a `ReadonlyWorld` and a stray `world.spawn(…)` fails to typecheck.
 * Types ERASE, so a cast defeats it — pair it with a throwing `world.devOnWrite` hook (the runtime half)
 * when the window must be enforced at runtime, not merely documented.
 */
export type ReadonlyWorld = Omit<World, WorldMutatorName>;

/** Report a throwing observer callback — swallowed, never propagated into tick control flow. */
function reportObserverThrow(err: unknown): void {
  devError(`observer callback threw — swallowed; callbacks must not throw (observe.ts): ${String(err)}`);
}

/** Fan one system-slot visit out to observers (kept out of the tick loop for readability). */
function emitSystemRun(
  obs: readonly WorldObserver[],
  phase: string,
  system: string,
  ran: boolean,
  micros: number,
): void {
  for (let i = 0; i < obs.length; i++) {
    try {
      obs[i].onSystemRun?.(phase, system, ran, micros);
    } catch (err) {
      reportObserverThrow(err);
    }
  }
}

/** Create a world (instantiates a {@link RuntimeStore} as its ECS store, §3). */
export function createWorld(opts?: { name?: string }): World {
  return new World(opts);
}

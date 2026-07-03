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
import { RuntimeStore } from "./runtime-store";
import { type EntityEditor, type Pipeline, SystemCtx, makeEditor } from "./system";
import { Reactive } from "./reactive";
import { validatePipelineAccess } from "./access-diagnostics";
import { exportSnapshot, importSnapshot } from "./snapshot";

/** What the world knows about a layer's inbound rhythm — the entire coupling (§16.1). */
export interface InboundSource {
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
  readonly name: string;

  constructor(opts?: { name?: string }) {
    this.name = opts?.name ?? "world";
  }

  /** Ticks run so far — the tools' time axis (increments as each `tick()` enters, observe.ts). */
  get tickCount(): number {
    return this.tickCounter;
  }

  /**
   * The reactive observer layer (Patch Note 002). Lazily created + cached; accessing it is what
   * turns the feature on (its first observer arms 001's dev-enforcement, §2.4). Each World has its
   * own — it belongs to this world's store and dies with it (002 §6).
   */
  get reactive(): Reactive {
    if (this.reactiveInstance === null) {
      this.store.enableReactive(); // arms the store's stamp/bump sites — zero stores before this
      this.reactiveInstance = new Reactive(this.store);
    }
    return this.reactiveInstance;
  }

  /**
   * Attach a dev-tool observer (observe.ts; docs/plan-tools-observer.md). Returns a detach
   * function. Zero cost when nothing is attached; observer callbacks must not mutate the world.
   */
  observe(obs: WorldObserver): () => void {
    return this.store.addObserver(obs);
  }

  // --- entities / lifecycle (immediate) ---
  spawn<const T extends readonly Record<string, FieldInput>[]>(init?: SpawnInitOf<T>): Entity {
    return this.store.spawn(init);
  }
  destroy(e: Entity): void {
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
    this.store.addComponent(e, c, v);
  }
  removeComponent(e: Entity, c: Component): void {
    this.store.removeComponent(e, c);
  }
  addTag(e: Entity, t: Tag): void {
    this.store.addTag(e, t);
  }
  removeTag(e: Entity, t: Tag): void {
    this.store.removeTag(e, t);
  }
  setRelation(e: Entity, r: Relation, target: Entity): void {
    this.store.setRelation(e, r, target);
  }
  addRelation(e: Entity, r: Relation, target: Entity): void {
    this.store.addRelation(e, r, target);
  }
  removeRelation(e: Entity, r: Relation, target?: Entity): void {
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
    return this.store.query(q);
  }
  setResource<S>(res: Resource<S>, value: S): void {
    this.store.setResource(res, value);
  }
  getResource<S>(res: Resource<S>): S | undefined {
    return this.store.getResource(res);
  }

  // --- the frame ---

  /**
   * Run a pipeline once: per phase, run gated systems then flush that phase's buffer (§7).
   * When observers are attached (observe.ts) the same loop also emits tick/system/flush
   * telemetry; with none attached the only added cost is a branch-on-null per step.
   */
  tick(pipeline: Pipeline): void {
    const tick = ++this.tickCounter;
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
        const ctx = new SystemCtx(this.store, buf);
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
          if (obs !== null) {
            const t0 = performance.now();
            this.store.query(system.query).each((batch) => system.body(batch, ctx));
            emitSystemRun(obs, phase.name, system.name, true, (performance.now() - t0) * 1000);
          } else {
            this.store.query(system.query).each((batch) => system.body(batch, ctx));
          }
          // Reactive change detection: blanket-stamp the system's declared writes (001 §3.1 route 1,
          // 002 §2.3). A gated-off system never reaches here, so it never stamps (001 §3.4).
          if (reactive !== null) {
            const w = system.access?.write;
            if (w !== undefined && w.length > 0) this.store.stampWrites(system.query, w);
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
  }

  /** Drain all attached inbound sources (§16). A no-op in a pure Part I world (no sources). */
  sync(): void {
    for (const source of this.inbound) source.drain();
  }

  /** Register an inbound source (a durable/ephemeral binding registers here on attach, §16). */
  registerInboundSource(source: InboundSource): void {
    this.inbound.push(source);
  }

  // --- local snapshot (non-collaborative save/load, §8) ---

  /** Serialize the world to bytes (off the hot path — an explicit call, §8). */
  export(): Uint8Array {
    return exportSnapshot(this.store, this.name);
  }

  /** Load a snapshot into this world, which must be empty (§8.2). */
  import(bytes: Uint8Array): void {
    importSnapshot(this.store, bytes);
  }

  /** @internal The underlying store — the seam Parts II–IV drive projection through. */
  get runtime(): RuntimeStore {
    return this.store;
  }
}

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

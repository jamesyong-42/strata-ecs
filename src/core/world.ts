/**
 * The world — the application-facing handle over an {@link RuntimeStore} (design §7, §16).
 *
 * `world.*` mutations run OUTSIDE any system iteration, so shape changes apply immediately
 * (nothing is iterating, §5.2). `world.tick(pipeline)` runs systems — where `ctx.*` shape
 * changes defer to the phase boundary. `world.sync()` drains any attached inbound sources; in a
 * pure Part I world there are none, so it is a no-op (the hook Parts III–IV register into, §16).
 */

import type { Entity } from "./entity";
import type { Component, FieldId, Relation, Resource, Tag } from "./schema";
import type { Batch, Query } from "./query";
import { devError } from "./dev";
import type { WorldObserver } from "./observe";
import { RuntimeStore, type SpawnInit } from "./runtime-store";
import { type EntityEditor, type Pipeline, SystemCtx, makeEditor } from "./system";
import { exportSnapshot, importSnapshot } from "./snapshot";

/** What the world knows about a layer's inbound rhythm — the entire coupling (§16.1). */
export interface InboundSource {
  drain(): void;
}

export class World {
  private readonly store = new RuntimeStore();
  private readonly inbound: InboundSource[] = [];
  private tickCounter = 0;
  readonly name: string;

  constructor(opts?: { name?: string }) {
    this.name = opts?.name ?? "world";
  }

  /** Ticks run so far — the tools' time axis (increments as each `tick()` enters, observe.ts). */
  get tickCount(): number {
    return this.tickCounter;
  }

  /**
   * Attach a dev-tool observer (observe.ts; docs/plan-tools-observer.md). Returns a detach
   * function. Zero cost when nothing is attached; observer callbacks must not mutate the world.
   */
  observe(obs: WorldObserver): () => void {
    return this.store.addObserver(obs);
  }

  // --- entities / lifecycle (immediate) ---
  spawn(init?: SpawnInit): Entity {
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
  /** Read one field with no allocation — the fast path for random access by handle (§Part I ref). */
  readField<T = number>(e: Entity, c: Component, field: string): T | undefined {
    return this.store.readField<T>(e, c, field);
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
  readEid(e: Entity, c: Component, field: FieldId): Entity | undefined {
    return this.store.readEid(e, c, field);
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
          if (obs !== null) {
            const t0 = performance.now();
            this.store.query(system.query).each((batch) => system.body(batch, ctx));
            emitSystemRun(obs, phase.name, system.name, true, (performance.now() - t0) * 1000);
          } else {
            this.store.query(system.query).each((batch) => system.body(batch, ctx));
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

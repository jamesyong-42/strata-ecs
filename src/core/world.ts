/**
 * The world — the application-facing handle over an {@link RuntimeStore} (design §7, §16).
 *
 * `world.*` mutations run OUTSIDE any system iteration, so shape changes apply immediately
 * (nothing is iterating, §5.2). `world.tick(pipeline)` runs systems — where `ctx.*` shape
 * changes defer to the phase boundary. `world.sync()` drains any attached inbound sources; in a
 * pure Part I world there are none, so it is a no-op (the hook Parts III–IV register into, §16).
 */

import type { Entity } from "./entity";
import type { Component, Relation, Resource, Tag } from "./schema";
import type { Query } from "./query";
import { RuntimeStore, type SpawnInit } from "./runtime-store";
import { type EntityEditor, type Pipeline, SystemCtx, makeEditor } from "./system";

/** What the world knows about a layer's inbound rhythm — the entire coupling (§16.1). */
export interface InboundSource {
  drain(): void;
}

export class World {
  private readonly store = new RuntimeStore();
  private readonly inbound: InboundSource[] = [];
  readonly name: string;

  constructor(opts?: { name?: string }) {
    this.name = opts?.name ?? "world";
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
  setResource<S>(res: Resource<S>, value: S): void {
    this.store.setResource(res, value);
  }
  getResource<S>(res: Resource<S>): S | undefined {
    return this.store.getResource(res);
  }

  // --- the frame ---

  /** Run a pipeline once: per phase, run gated systems then flush that phase's buffer (§7). */
  tick(pipeline: Pipeline): void {
    for (const phase of pipeline) {
      const buf = this.store.allocateCommandBuffer();
      const ctx = new SystemCtx(this.store, buf);
      if (phase.runIf !== undefined && !phase.runIf(ctx)) {
        this.store.releaseCommandBuffer(buf);
        continue;
      }
      for (const system of phase.systems) {
        if (system.runIf !== undefined && !system.runIf(ctx)) continue;
        this.store.query(system.query).each((batch) => system.body(batch, ctx));
      }
      this.store.flushCommandBuffer(buf); // phase boundary: shape changes become visible (§7)
      this.store.releaseCommandBuffer(buf);
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

  /** @internal The underlying store — the seam Parts II–IV drive projection through. */
  get runtime(): RuntimeStore {
    return this.store;
  }
}

/** Create a world (instantiates a {@link RuntimeStore} as its ECS store, §3). */
export function createWorld(opts?: { name?: string }): World {
  return new World(opts);
}

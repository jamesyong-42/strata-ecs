/**
 * `ECSStore` — the complete, representation-agnostic operational contract over ECS state
 * (design §3, §ref ~1208-1237). General CRUD + query, saying nothing about *how* the data is
 * stored. `World` and `SystemCtx` hold an `ECSStore` and delegate to it; {@link RuntimeStore} is
 * the archetype / typed-array implementation strata ships. Parts II–IV are written against this
 * contract (plus the `RuntimeStore` projection primitives) — never the concrete columns.
 *
 * **Every operation here is IMMEDIATE.** Deferral is the `SystemCtx` wrapper's concern, not the
 * store's — the store has no "am I iterating?" mode (§ref). The one place the representation is
 * exposed is `query().each`, which hands the body a raw {@link Batch}, by design, for hot-loop
 * speed.
 */

import type { Entity } from "./entity";
import type { Component, Relation, Resource, Tag } from "./schema";
import type { Batch, Query } from "./query";
import type { SpawnInit } from "./runtime-store";

export interface ECSStore {
  // --- entities / lifecycle ---
  spawn(init?: SpawnInit): Entity;
  destroy(e: Entity): void;
  isAlive(e: Entity): boolean;
  isPlaced(e: Entity): boolean;
  isIdentityOnly(e: Entity): boolean;

  // --- components: shape (immediate on this surface — deferral is SystemCtx's job) ---
  addComponent<S>(e: Entity, c: Component<S>, value: S): void;
  removeComponent(e: Entity, c: Component): void;
  // --- components: value ---
  writeComponent<S>(e: Entity, c: Component<S>, value: S): void;
  // --- components: read ---
  read<S>(e: Entity, c: Component<S>): S;
  get<S>(e: Entity, c: Component<S>): S | undefined;
  /** Read ONE field's decoded value with no object allocation — the fast path for random access by
   *  handle (whole-component `read`/`get` build an object per call). Keyed by field NAME and typed
   *  from the component's schema: `readField(e, Position, "x")` is `number | undefined`. `undefined`
   *  if the entity lacks the component or (for a bare component) the field name is unknown. */
  readField<S, K extends keyof S & string>(e: Entity, c: Component<S>, field: K): S[K] | undefined;
  has(e: Entity, c: Component): boolean;

  // --- tags ---
  addTag(e: Entity, t: Tag): void;
  removeTag(e: Entity, t: Tag): void;
  hasTag(e: Entity, t: Tag): boolean;

  // --- relations ---
  setRelation(e: Entity, r: Relation, target: Entity): void;
  addRelation(e: Entity, r: Relation, target: Entity): void;
  removeRelation(e: Entity, r: Relation, target?: Entity): void;
  getRelation(e: Entity, r: Relation): Entity | undefined;
  getRelations(e: Entity, r: Relation): Entity[];
  getReverse(e: Entity, r: Relation): Entity[];

  // --- resources ---
  setResource<S>(res: Resource<S>, value: S): void;
  removeResource<S>(res: Resource<S>): void;
  getResource<S>(res: Resource<S>): S | undefined;

  // --- query (the one place the representation leaks — into the per-chunk callback, §6.2) ---
  query(q: Query): { each(fn: (batch: Batch) => void): void };
  firstOf(q: Query): Entity | undefined;
}

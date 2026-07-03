/**
 * The storage substrate's vocabulary (Patch Note 005 §1, §7) — types only, no behavior.
 *
 * This is the *vocabulary* half of Part II: the snapshot ladder interfaces, the doc-fact
 * (`ChangeEvent`) taxonomy, the batch boundary, and the wire value form. It is medium-agnostic and
 * policy-free — no reconcile rules, no transaction semantics, no Loro. `CRDTSnapshot` exists here
 * only as the frozen interface Part III's `LoroSnapshot` codes against (§9 scope cut: no
 * `loro-crdt` dependency lands in Part II).
 *
 * Everything is keyed by the SHIPPED `EntityKey` (field.ts:32) and typed on the schema-object
 * currency (`Component`/`Tag`/`Relation`/`Resource`), never on run-local numeric ids — the ids are
 * the in-process currency, names are the durable currency (§1.2).
 */

import type { EntityKey } from "../core/field";
import type { Component, Relation, Resource, Tag } from "../core/schema";
import type { Unsubscribe } from "../core/reactive";

/**
 * A decoded, field-name-keyed component (or resource) value — exactly what
 * `RuntimeStore.read`/`writeComponent`/`projectComponent` exchange (§7). Numbers for numeric
 * fields, booleans for `bool`, enum LABEL strings (not discriminants), plain strings for `string`,
 * and `EntityKey` strings for `key` fields. A replicated component MUST NOT carry `eid` fields
 * (§7): an `eid` is a packed runtime handle, meaningless across sessions; entity references on the
 * wire are `key` fields the projector resolves through its bijection.
 */
export type ComponentValue = Record<string, unknown>;

// The ladder is name-keyed at the durable boundary (§1.2). These aliases document intent; a
// component/tag/relation/resource is stored and looked up by its stable `.name`, resolved to the
// schema object via schema.ts's `*ByName` at the adapter READ boundary.
export type ComponentName = string;
export type TagName = string;
export type RelationName = string;

/**
 * The ladder's per-entity record — name-keyed, `EntityKey`-targeted (§1.2). Mirrors the shipped
 * local-snapshot record (snapshot.ts:28-34) at the collaborative key type. It is a DERIVED bulk
 * view: `Snapshot.readEntity` AGGREGATES an entity's cells into one record (serialization/debug
 * only). The direction is one-way — cells are the source of truth, the record is computed from
 * them, never stored as a blob and read back out of (§1.2 direction rule).
 */
export interface EntityRecord {
  key: EntityKey;
  components: Record<ComponentName, ComponentValue>;
  tags: TagName[];
  /** arity "one" → scalar target; arity "many" → array of targets (§8.1). */
  relations: Record<RelationName, EntityKey | EntityKey[]>;
}

/**
 * The base read interface — pure reads, cell-addressed, `EntityKey`-keyed, schema-object-typed
 * (§1.2). Both the baseline and the CRDT snapshot implement it; the local snapshot is NOT a member
 * (§1.1, it keeps its own numeric-keyed record). Relation reads are ARITY-SPLIT (D7): `getRelationOne`
 * for arity "one", `getRelationMany` for arity "many" — matching the already-split writes
 * (setRelation vs addRelation).
 */
export interface Snapshot {
  hasEntity(key: EntityKey): boolean;
  entities(): Iterable<EntityKey>;
  /** Decoded, name-keyed value, or `undefined` if the entity lacks the component (§7). */
  getComponent(key: EntityKey, c: Component): ComponentValue | undefined;
  hasTag(key: EntityKey, t: Tag): boolean;
  getRelationOne(key: EntityKey, r: Relation): EntityKey | undefined;
  getRelationMany(key: EntityKey, r: Relation): EntityKey[];
  getResource(res: Resource): ComponentValue | undefined;
  /** Aggregate an entity's cells into a bulk record — serialization/debug only (§1.2, §1.3). */
  readEntity(key: EntityKey): EntityRecord | undefined;
}

/**
 * The write extension — the baseline and the CRDT implement it (§1.2). Cell-addressed: every op
 * touches exactly one cell (§4.1). `despawn` is a THREE-PART contract (§1.3): it removes the record,
 * every OUTGOING edge, and every INCOMING edge to the key. Every component/resource write stores the
 * CANONICAL value (§2), never the raw literal.
 */
export interface MutableSnapshot extends Snapshot {
  spawn(key: EntityKey): void;
  /** THREE-PART: record + outgoing edges + incoming edges (§1.3). */
  despawn(key: EntityKey): void;
  setComponent(key: EntityKey, c: Component, v: ComponentValue): void;
  removeComponent(key: EntityKey, c: Component): void;
  addTag(key: EntityKey, t: Tag): void;
  removeTag(key: EntityKey, t: Tag): void;
  setRelation(key: EntityKey, r: Relation, target: EntityKey): void; // arity "one"
  addRelation(key: EntityKey, r: Relation, target: EntityKey): void; // arity "many"
  removeRelation(key: EntityKey, r: Relation, target?: EntityKey): void;
  setResource(res: Resource, v: ComponentValue): void;
  removeResource(res: Resource): void;
}

/**
 * The CRDT capability extension — ONLY the Loro-backed snapshot implements this (§1.2, §1.3). It is
 * frozen here as the interface Part III codes against; no implementation lands in Part II (§9).
 * `applyRemote` returns one {@link ChangeBatch} PER COMMIT (a received buffer may carry several).
 * `commit` is a SCOPE — the writes happen inside `body`, sealed on return (the caller cannot forget
 * to seal, and the batch is pinned to this one document). `undo`/`redo` are local-ops-only (§1.3).
 */
export interface CRDTSnapshot extends MutableSnapshot {
  applyRemote(bytes: Uint8Array): ChangeBatch[];
  commit(body: () => void): void;
  export(): Uint8Array;
  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe;
  undo(): void;
  redo(): void;
}

/**
 * The origin of a converged fact (§1.4). A whole {@link ChangeBatch} is ONE origin — a commit is
 * either the echo of our own transaction (`local`) or a peer's (`remote`); mixed-origin batches are
 * unrepresentable by construction (§1.3), which is what keeps a same-frame own-echo and a remote
 * fact for the same cell in SEPARATE batches (Part III §13.3 drag-protection).
 */
export type Origin =
  | "local" // echo of our own transaction — reconcile applies it (value already applied at commit; structure arrives here)
  | "remote"; // arrived via applyRemote — structure applies unconditionally; value only if the cell is not mid local-drag

/**
 * A doc-fact — a pure statement about the converged document ("the doc now says cell X = V"),
 * carrying an origin and NO apply/skip decision (§1.4). The vocabulary mirrors {@link MutableSnapshot}'s
 * cell-addressed writes, but it is distinct from Part III's *operation* vocabulary (ops are requests
 * carrying handles; doc-facts are facts carrying keys + origin).
 *
 * `component-set` is intentionally AMBIGUOUS — it may ADD a previously-absent component (structural)
 * or OVERWRITE a present one (value); the binding classifies it against the baseline at reconcile
 * (§1.4). `component-remove` is always structural.
 */
export type ChangeEvent =
  | { kind: "spawn"; key: EntityKey; origin: Origin }
  | { kind: "despawn"; key: EntityKey; origin: Origin }
  | { kind: "component-set"; key: EntityKey; comp: Component; value: ComponentValue; origin: Origin }
  | { kind: "component-remove"; key: EntityKey; comp: Component; origin: Origin }
  | { kind: "tag-add"; key: EntityKey; tag: Tag; origin: Origin }
  | { kind: "tag-remove"; key: EntityKey; tag: Tag; origin: Origin }
  | { kind: "relation-set"; key: EntityKey; rel: Relation; target: EntityKey; origin: Origin }
  | { kind: "relation-add"; key: EntityKey; rel: Relation; target: EntityKey; origin: Origin }
  | { kind: "relation-remove"; key: EntityKey; rel: Relation; target?: EntityKey; origin: Origin }
  | { kind: "resource-set"; res: Resource; value: ComponentValue; origin: Origin }
  | { kind: "resource-remove"; res: Resource; origin: Origin };

/**
 * The doc-facts of EXACTLY ONE commit (§1.3). Both `subscribe` and `applyRemote` deliver a batch,
 * never a bare `ChangeEvent[]`: "one array = one commit" is what lets reconcile normalize a batch
 * ({@link "./normalize".normalizeBatch}) to the final fact per cell and classify each against the
 * pre-commit baseline. Single-origin by construction.
 */
export interface ChangeBatch {
  /** The WHOLE batch is one origin — yours (local echo) or a peer's (remote). */
  origin: Origin;
  /** The cell-level facts of this one commit (§1.4). */
  events: ChangeEvent[];
  /** Optional adapter-provided commit identity (logging / dedup). */
  commitId?: string;
}

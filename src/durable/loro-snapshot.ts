/**
 * `LoroSnapshot` — the first Loro-aware adapter (Part III M0, docs/plan-part3.md).
 *
 * `LoroSnapshot implements CRDTSnapshot` (the frozen Part II interface, src/substrate/types.ts) over a
 * caller-supplied `LoroDoc`. It is THE ONLY file in the repo that may import `loro-crdt` (the other
 * Loro-aware class is Part IV's `LoroEphemeralSnapshot`); everything else speaks Part II interfaces.
 * The acceptance gate is `runConformance` (src/substrate/__conformance__), run against this adapter
 * unchanged.
 *
 * ============================================================================================
 * LORO-CRDT API FINDINGS (verified empirically against loro-crdt@1.13.6 in a throwaway spike;
 * training data was NOT trusted). This block is the knowledge Part IV's ephemeral adapter reuses.
 * ============================================================================================
 *
 *  1. EVENT TIMING IS SYNCHRONOUS. `doc.subscribe(fn)` fires DURING `doc.commit()` and DURING
 *     `doc.import(bytes)`, before those calls return (contrary to loro's historical microtask
 *     queueing). BUT: one `import()` of an N-commit buffer fires subscribe exactly ONCE with a single
 *     MERGED map-diff (final value per key) tagged `by:"import"`. So per-commit splitting CANNOT come
 *     from `subscribe`. This adapter therefore does NOT use `doc.subscribe` at all — it derives every
 *     batch synchronously from FRONTIER DIFFS (`doc.diff(from, to)`), which sidesteps event timing and
 *     yields exact per-commit granularity (see 3).
 *
 *  2. `map.set(key, plainObject)` stores the whole object as ONE atomic LWW register (005 §3.1):
 *     concurrent writes to the same component register by two peers converge to ONE committer's whole
 *     value — NEVER a field merge (verified: {x:5,y:0} vs {x:0,y:9} → one whole value on both peers).
 *     Per-entry keys (distinct tags) are independent registers, so concurrent adds of DIFFERENT tags
 *     both survive (005 §3.2). `map.set` is a no-op if the value already equals the current one (no op
 *     recorded) — harmless for us (P7 idempotence is asserted on STATE, not on op count).
 *
 *  3. PER-COMMIT SPLITTING (`applyRemote`). Consecutive same-peer commits COALESCE into ONE oplog
 *     `Change` by default (a 3-commit buffer → 1 change of length 3). Neither an incrementing
 *     `timestamp` nor a distinct `origin` prevents it; ONLY a distinct `commit({ message })` per commit
 *     keeps them separate (verified). So EVERY commit this adapter seals is tagged with a monotonic
 *     per-doc counter as its `message` — that is the sole reason for the message, and it is what lets a
 *     receiver recover commit boundaries. Split algorithm: record `beforeVV=doc.version()` +
 *     `beforeFrontiers=doc.frontiers()`; `doc.import(bytes)`; `doc.exportJsonUpdates(beforeVV, afterVV,
 *     withPeerCompression=false)` → `.changes` topologically ordered, each = ONE commit; walk them,
 *     computing the frontier after each change and `doc.diff(prev, cur)` → that one commit's map diffs.
 *     MUST pass `withPeerCompression=false` — otherwise change ids come back peer-compressed ("0@0").
 *     `JsonOpID` is a `"counter@peer"` STRING (parse by the last '@'). A change's counter-span is
 *     `change.ops.length` (our doc is map-only, so every op is exactly one counter); do NOT use
 *     `doc.getChangeAt(id).length` — it returns the COALESCED internal change (e.g. 2 across an
 *     undo+redo), overshooting the per-commit boundary.
 *     CAVEAT: `doc.vvToFrontiers(vv)` PANICS ("unreachable" in the wasm) when the version includes a
 *     REDO-generated op, so the per-change frontier is tracked by hand as a tip set (`frontierAfter`);
 *     `doc.diff` against that hand-built frontier is safe (both verified in the spike).
 *
 *  4. `doc.diff(from, to, false): [ContainerID, Diff][]` — the net map diffs between two frontiers, per
 *     affected container. The uniform batch-derivation primitive for BOTH local commits (diff around
 *     one `commit()`) and remote per-commit splitting. Findings on its shape:
 *       - A DELETED key (any removal: despawn, removeComponent, removeTag, removeRelation) appears in
 *         `MapDiff.updated` as `updated[key] === undefined`, an OWN property visible to `Object.keys`
 *         and `hasOwnProperty` — NOT omitted. (`JSON.stringify` hides undefined-valued keys, which is a
 *         debugging trap, not the data.) Enumerate with `Object.keys`.
 *       - A newly-created child container appears in the PARENT ("entities") diff as a container value
 *         (`updated[key] !== undefined`), and its keys appear in a SEPARATE child-container diff pair.
 *         So a spawn's `exists`/`comp:`/`tag:`/`rel:` facts come from the CHILD pair; the parent pair is
 *         used only to detect DESPAWN (`updated[key] === undefined`).
 *       - `doc.getPathToContainer(cid)` → the absolute path, e.g. a per-entity map → ["entities", key].
 *         Root maps have stable ids "cid:root-entities:Map" / "cid:root-resources:Map". A deleted
 *         container can't be path-resolved, but a deletion surfaces only on the PARENT diff, so every
 *         child pair that appears resolves.
 *
 *  5. VALUES: loro stores `NaN`, `Infinity`, `-Infinity` as JS numbers in map values (nested-in-object
 *     AND direct), preserved on readback — so this adapter has NO NaN/±Inf limitation (unlike world
 *     JSON export). `-0` normalizes to `+0` on readback; irrelevant, since `cellEquals`/`scalarEquals`
 *     already unify NaN and collapse ±0. Map value objects round-trip with keys possibly REORDERED;
 *     `cellEquals` is field-name-keyed, so order is immaterial. `map.get` returns a FRESH handle/value
 *     each call (never reference-equal to what was set) — never rely on identity, always re-fetch.
 *
 *  6. UNCOMMITTED reads: staged writes (before any `commit`) are immediately visible to `get`/`keys`.
 *     This is why the write methods stage directly and the conformance suite (which never commits) sees
 *     a consistent store. An emptied child map LINGERS in "entities" with `keys().length === 0`; that is
 *     why `hasEntity` / `entities()` gate on `keys().length > 0` (existence-cell + derived liveness).
 *
 *  7. `UndoManager` (005 §1.3, LOCAL-ops-only, verified): `undo()`/`redo()` self-commit (advance
 *     frontiers, no explicit `doc.commit`), return a boolean, and revert ONLY the local peer's own ops —
 *     undoing after a remote import never touches a peer's edit. Their inverse edits flow out through
 *     the same frontier-diff path as an ordinary `local` batch. (Undo groups edits inside its own merge
 *     interval — two rapid same-key sets can be one undo step; that is loro policy, faithfully surfaced.)
 *
 *  8. `export({ mode:"snapshot" })` = full converged state (imports into a fresh doc).
 *
 * ============================================================================================
 * DOCUMENT LAYOUT (plan-part3.md "Document layout", 005 §3 concretized)
 * ============================================================================================
 *  root LoroMap "entities":  <EntityKey> → a per-entity LoroMap (a container)
 *  per-entity LoroMap:
 *    "exists"                → true                      the existence cell (005 §4.1; spawn = this only)
 *    "comp:<Name>"           → canonical value object    ONE atomic register, assigned WHOLESALE (§3.1)
 *    "tag:<Name>"            → true                       per-entry register (§3.2)
 *    "rel1:<Name>"           → <targetKey> string         arity "one" — one register
 *    "relN:" + JSON([<Name>,<targetKey>]) → true          arity "many" — one register PER edge
 *  root LoroMap "resources": <ResourceName> → canonical value object (§3.1)
 *
 * REL-EDGE KEY ENCODING (collision-proof, per the task): relation names AND target keys are
 * peer-controlled and may contain ':' or '/'. Arity is discriminated by the DISTINCT prefixes
 * "rel1:" vs "relN:" (never by embedding the target in an arity-one key), and the arity-"many" edge
 * encodes [relName, targetKey] as a JSON array so no separator a hostile key embeds can forge a
 * collision — the same defense normalize.ts uses for its cell keys (005 §10.4). "comp:"/"tag:"/"exists"
 * are disjoint prefixes and each name is the whole suffix, so no cross-kind collision is possible.
 *
 * WHAT THIS FILE IS NOT: it is not the DurableStore, the binding, reconcile, or the transaction (M1–M5).
 * It is the medium adapter — it reports what the document says (origin-tagged doc-facts) and applies
 * cell writes; it makes NO apply/skip decision (005 §1.4). The `strata-ecs/durable` subpath keeps its
 * loud placeholder until M5.
 */

import { LoroDoc, LoroMap, UndoManager } from "loro-crdt";
import type { ContainerID, Diff, JsonChange, OpId } from "loro-crdt";
import { devWarn } from "../core/dev";
import { type EntityKey, entityKey } from "../core/field";
import type { Component, Relation, Resource, Tag } from "../core/schema";
import {
  type ChangeBatch,
  type ChangeEvent,
  type ComponentValue,
  type CRDTSnapshot,
  type EntityRecord,
  type Origin,
  type Unsubscribe,
  canon,
  canonResource,
  componentByName,
  relationByName,
  resourceByName,
  tagByName,
} from "../substrate";

// --- the per-entity map key scheme (see header: REL-EDGE KEY ENCODING) ----------------------------
const EXISTS = "exists";
const COMP = "comp:";
const TAG = "tag:";
const REL_ONE = "rel1:";
const REL_MANY = "relN:";

const compKey = (c: Component): string => COMP + c.name;
const tagKey = (t: Tag): string => TAG + t.name;
const relOneKey = (r: Relation): string => REL_ONE + r.name;
const relManyKey = (r: Relation, target: EntityKey): string =>
  REL_MANY + JSON.stringify([r.name, target]);
/** Parse a "relN:" edge key back to [relationName, targetKey] (the JSON-array segment). */
function parseRelManyKey(mapKey: string): [string, string] {
  const [name, target] = JSON.parse(mapKey.slice(REL_MANY.length)) as [string, string];
  return [name, target];
}

/** A `JsonOpID` is a `"counter@peer"` string (loro finding 3). Split on the LAST '@' (peer is numeric). */
function parseJsonOpId(id: string): { peer: `${number}`; counter: number } {
  const at = id.lastIndexOf("@");
  return { counter: Number(id.slice(0, at)), peer: id.slice(at + 1) as `${number}` };
}

/**
 * `LoroSnapshot` — a `CRDTSnapshot` over one `LoroDoc`.
 *
 * The write methods (spawn/despawn/setComponent/…) STAGE ops directly on the doc (immediately readable,
 * loro finding 6); `commit(body)` seals them into ONE loro commit and surfaces the sealed batch.
 * Batches are derived synchronously from frontier diffs (loro findings 1, 4), never from `doc.subscribe`,
 * so `subscribe`-per-commit and `applyRemote`-per-commit hold regardless of loro's event timing.
 */
export class LoroSnapshot implements CRDTSnapshot {
  private readonly doc: LoroDoc;
  /** root "entities" map: EntityKey → per-entity child LoroMap. */
  private readonly entitiesMap: LoroMap;
  /** root "resources" map: ResourceName → canonical value object. */
  private readonly resourcesMap: LoroMap;
  private readonly entitiesRootId: string;
  private readonly resourcesRootId: string;
  private readonly undoManager: UndoManager;

  /** Subscribers to sealed batches (local commits AND remote imports). We manage this list ourselves. */
  private readonly listeners = new Set<(batch: ChangeBatch) => void>();
  /** Monotonic per-doc commit counter — the `commit({ message })` that keeps commits un-coalesced (finding 3). */
  private commitSeq = 0;
  /** Reentrancy guard for `commit(body)` — nested commit throws (the pinned choice, plan-part3 M0). */
  private committing = false;
  /** One-shot DEV diagnostic dedupe for unresolved durable names (005 §1.4; plan-part3 unknown-name rule). */
  private readonly warnedNames = new Set<string>();

  constructor(doc: LoroDoc) {
    this.doc = doc;
    this.entitiesMap = doc.getMap("entities");
    this.resourcesMap = doc.getMap("resources");
    this.entitiesRootId = String(this.entitiesMap.id);
    this.resourcesRootId = String(this.resourcesMap.id);
    // Local-ops-only undo (finding 7). `mergeInterval: 0` makes ONE sealed commit ONE undo step — loro's
    // default TIME-merges rapid commits into a single step, but the transaction model (M3) is
    // one-transaction = one-commit = one-undo-step, so we opt out of time grouping. Constructed here so
    // it tracks only this session's commits (pre-existing history is not undoable — "before our session").
    this.undoManager = new UndoManager(doc, { mergeInterval: 0 });
  }

  // --- child-map access ----------------------------------------------------------------------------

  /** The per-entity child map, or undefined if the entity has no map yet. */
  private childMap(key: EntityKey): LoroMap | undefined {
    const v = this.entitiesMap.get(key);
    return v == null ? undefined : (v as LoroMap);
  }

  /** The per-entity child map, creating it (a fresh LoroMap container) if absent. */
  private ensureChild(key: EntityKey): LoroMap {
    return this.childMap(key) ?? this.entitiesMap.setContainer(key, new LoroMap());
  }

  // --- reads (Snapshot) ----------------------------------------------------------------------------

  /**
   * Derived liveness (005 §4.1, E5): live iff the child map holds ≥1 key — the existence cell (`exists`)
   * OR any comp/tag/rel cell. An emptied-but-lingering child map (`keys().length === 0`) reads absent,
   * matching the baseline's `spawned OR hasAnyCell` and the runtime oracle's model (finding 6).
   */
  hasEntity(key: EntityKey): boolean {
    const m = this.childMap(key);
    return m !== undefined && m.keys().length > 0;
  }

  entities(): Iterable<EntityKey> {
    const out: EntityKey[] = [];
    for (const k of this.entitiesMap.keys()) {
      const key = entityKey(String(k));
      if (this.hasEntity(key)) out.push(key);
    }
    return out;
  }

  getComponent(key: EntityKey, c: Component): ComponentValue | undefined {
    const v = this.childMap(key)?.get(compKey(c));
    return v === undefined ? undefined : (v as ComponentValue);
  }

  hasTag(key: EntityKey, t: Tag): boolean {
    return this.childMap(key)?.get(tagKey(t)) === true;
  }

  getRelationOne(key: EntityKey, r: Relation): EntityKey | undefined {
    const v = this.childMap(key)?.get(relOneKey(r));
    return v === undefined || v === null ? undefined : entityKey(String(v));
  }

  getRelationMany(key: EntityKey, r: Relation): EntityKey[] {
    const m = this.childMap(key);
    if (m === undefined) return [];
    const out: EntityKey[] = [];
    for (const mk of m.keys()) {
      const s = String(mk);
      if (s.startsWith(REL_MANY)) {
        const [name, target] = parseRelManyKey(s);
        if (name === r.name) out.push(entityKey(target));
      }
    }
    return out;
  }

  getResource(res: Resource): ComponentValue | undefined {
    const v = this.resourcesMap.get(res.name);
    return v === undefined ? undefined : (v as ComponentValue);
  }

  /** Aggregate the entity's cells into a record — the derived bulk view (005 §1.2 direction rule). */
  readEntity(key: EntityKey): EntityRecord | undefined {
    const m = this.childMap(key);
    if (m === undefined || m.keys().length === 0) return undefined;
    const components: Record<string, ComponentValue> = {};
    const tags: string[] = [];
    const relations: Record<string, EntityKey | EntityKey[]> = {};
    for (const rawKey of m.keys()) {
      const mk = String(rawKey);
      if (mk === EXISTS) continue;
      if (mk.startsWith(COMP)) components[mk.slice(COMP.length)] = m.get(mk) as ComponentValue;
      else if (mk.startsWith(TAG)) tags.push(mk.slice(TAG.length));
      else if (mk.startsWith(REL_ONE))
        relations[mk.slice(REL_ONE.length)] = entityKey(String(m.get(mk)));
      else if (mk.startsWith(REL_MANY)) {
        const [name, target] = parseRelManyKey(mk);
        const cur = relations[name];
        if (Array.isArray(cur)) cur.push(entityKey(target));
        else relations[name] = [entityKey(target)];
      }
    }
    return { key, components, tags, relations };
  }

  // --- writes (MutableSnapshot) — STAGE ops on the doc; commit() seals ------------------------------

  /** EXISTENCE-ONLY (005 §10.2): set the existence cell, clear nothing — erasure is despawn's alone. */
  spawn(key: EntityKey): void {
    this.ensureChild(key).set(EXISTS, true);
  }

  /** THREE-PART despawn (005 §1.3): record + outgoing edges (via whole-map delete) + incoming edges. */
  despawn(key: EntityKey): void {
    // Part 3: sever every INCOMING edge `* --rel--> key` on every other entity (correctness-first scan;
    // O(entities × edges-per-entity) per despawn — see COST note below). Do this BEFORE deleting the
    // child map so a self-edge on `key` is handled by the delete, not double-touched.
    this.removeIncoming(key);
    // Parts 1 + 2: delete the whole child map — removes `exists`, every comp/tag, and every outgoing edge
    // in one op. A lingering absent key is a no-op.
    if (this.childMap(key) !== undefined) this.entitiesMap.delete(key);
  }

  setComponent(key: EntityKey, c: Component, v: ComponentValue): void {
    this.ensureChild(key).set(compKey(c), canon(c, v)); // 005 §2: store the canonical value
  }

  removeComponent(key: EntityKey, c: Component): void {
    this.childMap(key)?.delete(compKey(c));
  }

  addTag(key: EntityKey, t: Tag): void {
    this.ensureChild(key).set(tagKey(t), true);
  }

  removeTag(key: EntityKey, t: Tag): void {
    this.childMap(key)?.delete(tagKey(t));
  }

  setRelation(key: EntityKey, r: Relation, target: EntityKey): void {
    if (r.arity !== "one") {
      throw new Error(
        `strata: setRelation is for arity "one" relations — use addRelation for "${r.name}".`,
      );
    }
    this.ensureChild(key).set(relOneKey(r), target);
  }

  addRelation(key: EntityKey, r: Relation, target: EntityKey): void {
    if (r.arity !== "many") {
      throw new Error(
        `strata: addRelation is for arity "many" relations — use setRelation for "${r.name}".`,
      );
    }
    this.ensureChild(key).set(relManyKey(r, target), true);
  }

  removeRelation(key: EntityKey, r: Relation, target?: EntityKey): void {
    const m = this.childMap(key);
    if (m === undefined) return;
    if (r.arity === "one") {
      const k = relOneKey(r);
      const cur = m.get(k);
      if (cur === undefined) return;
      if (target === undefined || String(cur) === target) m.delete(k);
    } else if (target === undefined) {
      // Target-less: drop every edge of this relation from `key`.
      for (const rawKey of m.keys()) {
        const mk = String(rawKey);
        if (mk.startsWith(REL_MANY) && parseRelManyKey(mk)[0] === r.name) m.delete(mk);
      }
    } else {
      m.delete(relManyKey(r, target));
    }
  }

  setResource(res: Resource, v: ComponentValue): void {
    this.resourcesMap.set(res.name, canonResource(res, v)); // 005 §2/§10.1: object-backed canonical
  }

  removeResource(res: Resource): void {
    this.resourcesMap.delete(res.name);
  }

  // --- CRDTSnapshot capabilities -------------------------------------------------------------------

  /**
   * `commit(body)` is a SCOPE sealing ONE loro commit (005 §1.3): open, run body, `doc.commit(...)`.
   * The commit is tagged with a monotonic message so it never coalesces with its neighbours (finding 3).
   * The sealed batch (origin "local") is derived from the frontier diff and delivered to subscribers.
   * Nested commit throws (the pinned choice). No-op body (no ops sealed) delivers nothing.
   */
  commit(body: () => void): void {
    if (this.committing) throw new Error("strata: nested commit() is not allowed.");
    this.committing = true;
    const before = this.doc.frontiers();
    try {
      body();
      this.doc.commit({ message: String(this.commitSeq++) });
    } finally {
      this.committing = false;
    }
    this.emitLocalSince(before);
  }

  /**
   * Import remote bytes and return one {@link ChangeBatch} PER remote commit, in order (005 §1.3 forbids
   * merging commits). loro merges a multi-commit import into a single event, so this SPLITS via the
   * oplog: `exportJsonUpdates` gives the new changes topologically ordered, and we diff between the
   * frontier BEFORE and AFTER each change (finding 3). The intermediate frontier is tracked by hand as a
   * TIP SET ({@link frontierAfter}) rather than via `doc.vvToFrontiers` — the latter PANICS ("unreachable"
   * in the wasm) on a redo-generated op, whereas `doc.diff` against a directly-built frontier is safe
   * (both verified in the spike). Each batch is single-origin "remote" by construction. Batches are also
   * delivered to `subscribe` (the frozen interface says subscribe sees local AND remote); Part III
   * consumes remote from exactly one path (see the M0 report / the M1/M2 risk note).
   */
  applyRemote(bytes: Uint8Array): ChangeBatch[] {
    const beforeVV = this.doc.version();
    const beforeFrontiers = this.doc.frontiers();
    this.doc.import(bytes);
    // No new ops (empty or fully-duplicate buffer) → no batches.
    if (this.doc.cmpFrontiers(beforeFrontiers, this.doc.frontiers()) === 0) return [];

    const schema = this.doc.exportJsonUpdates(beforeVV, this.doc.version(), false); // false: real peer ids
    const batches: ChangeBatch[] = [];
    let prev: OpId[] = beforeFrontiers;
    for (const change of schema.changes) {
      const cur = this.frontierAfter(prev, change);
      const batch = this.translatePairs(this.doc.diff(prev, cur, false), "remote", change.id);
      if (batch.events.length > 0) batches.push(batch);
      prev = cur;
    }
    for (const b of batches) this.emit(b);
    return batches;
  }

  /**
   * The document frontier after applying `change` on top of `prevTips` — the tip set that `doc.diff`
   * uses as its "to" version. A change's last op becomes a tip; a previous tip survives iff it is NOT
   * on the change's peer (same-peer ops are totally ordered, so the change supersedes them) AND not
   * reached by any of the change's deps (a dep at-or-past a tip's counter makes that tip an ancestor).
   * This reproduces `vvToFrontiers` for our append-only map history without tripping its redo panic.
   */
  private frontierAfter(prevTips: OpId[], change: JsonChange): OpId[] {
    const { peer, counter } = parseJsonOpId(change.id);
    // The change's op-span in COUNTERS. Our doc is map-only (set/delete/create-container are one counter
    // each), so `change.ops.length` is exactly the span. NB: `doc.getChangeAt(id).length` is WRONG here —
    // it returns the coalesced INTERNAL change (e.g. length 2 across an undo+redo), overshooting the
    // per-commit boundary this JsonChange represents (verified in the spike).
    const lastOp: OpId = { peer, counter: counter + change.ops.length - 1 };
    const deps = change.deps.map(parseJsonOpId);
    const survives = (t: OpId): boolean =>
      t.peer !== peer && !deps.some((d) => d.peer === t.peer && d.counter >= t.counter);
    return [lastOp, ...prevTips.filter(survives)];
  }

  export(): Uint8Array {
    return this.doc.export({ mode: "snapshot" });
  }

  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** LOCAL undo (finding 7): self-commits its inverse ops; the revert flows out as an ordinary batch. */
  undo(): void {
    const before = this.doc.frontiers();
    if (this.undoManager.undo()) this.emitLocalSince(before);
  }

  redo(): void {
    const before = this.doc.frontiers();
    if (this.undoManager.redo()) this.emitLocalSince(before);
  }

  // --- internals -----------------------------------------------------------------------------------

  /** Derive the local batch for whatever was sealed since `before` and deliver it (skip an empty seal). */
  private emitLocalSince(before: OpId[]): void {
    const after = this.doc.frontiers();
    if (this.doc.cmpFrontiers(before, after) === 0) return;
    const batch = this.translatePairs(this.doc.diff(before, after, false), "local", undefined);
    if (batch.events.length > 0) this.emit(batch);
  }

  private emit(batch: ChangeBatch): void {
    for (const fn of [...this.listeners]) fn(batch);
  }

  /**
   * Sever every incoming edge to `target` — the three-part despawn's part 3 (005 §1.3). Scans every
   * OTHER entity's child map for a `rel1:` whose value is `target` or a `relN:` edge to `target`.
   * COST: O(entities × keys-per-entity) per despawn (correctness-first; a reverse index kept in sync
   * with remote imports is the optimization deferred past M0).
   */
  private removeIncoming(target: EntityKey): void {
    for (const rawKey of this.entitiesMap.keys()) {
      const source = String(rawKey);
      if (source === target) continue; // the target's own outgoing edges go with the whole-map delete
      const m = this.childMap(entityKey(source));
      if (m === undefined) continue;
      for (const rawMapKey of m.keys()) {
        const mk = String(rawMapKey);
        if (mk.startsWith(REL_ONE)) {
          if (String(m.get(mk)) === target) m.delete(mk);
        } else if (mk.startsWith(REL_MANY)) {
          if (parseRelManyKey(mk)[1] === target) m.delete(mk);
        }
      }
    }
  }

  // --- diff → ChangeEvent translation (the read/event boundary, 005 §1.4) --------------------------

  /**
   * Translate a `doc.diff(from, to)` result into ONE single-origin {@link ChangeBatch}. Facts are
   * emitted in a WELL-FORMED order — spawns, then mutations/resources, then despawns — so the batch
   * satisfies normalizeBatch's spawn-first / despawn-last invariants (005 §4.2, §10.5). Name→schema
   * resolution happens here; an unresolved name surfaces NO event + one-shot DEV warn (005 §1.4).
   */
  private translatePairs(
    pairs: [ContainerID, Diff][],
    origin: Origin,
    commitId: string | undefined,
  ): ChangeBatch {
    const spawns: ChangeEvent[] = [];
    const mutations: ChangeEvent[] = [];
    const despawns: ChangeEvent[] = [];

    for (const [cid, diff] of pairs) {
      if (diff.type !== "map") continue; // our layout is all maps
      const updated = diff.updated;
      const cidStr = String(cid);

      if (cidStr === this.entitiesRootId) {
        // root "entities": a key→undefined is a DESPAWN; a key→container is a create (facts via child pair).
        for (const rawKey of Object.keys(updated)) {
          if (updated[rawKey] === undefined)
            despawns.push({ kind: "despawn", key: entityKey(rawKey), origin });
        }
      } else if (cidStr === this.resourcesRootId) {
        for (const name of Object.keys(updated)) {
          const res = resourceByName(name);
          if (res === undefined) {
            this.warnUnknown("resource", name);
            continue;
          }
          const val = updated[name];
          mutations.push(
            val === undefined
              ? { kind: "resource-remove", res, origin }
              : { kind: "resource-set", res, value: val as ComponentValue, origin },
          );
        }
      } else {
        // A per-entity child map: path is ["entities", <EntityKey>].
        const path = this.doc.getPathToContainer(cid);
        if (path === undefined || path.length !== 2 || path[0] !== "entities") continue;
        const key = entityKey(String(path[1]));
        for (const mapKey of Object.keys(updated)) {
          this.translateChildKey(key, mapKey, updated[mapKey], origin, spawns, mutations);
        }
      }
    }
    return { origin, commitId, events: [...spawns, ...mutations, ...despawns] };
  }

  /** Translate one child-map key change into its doc-fact, resolving the name (unknown → skip + warn). */
  private translateChildKey(
    key: EntityKey,
    mapKey: string,
    val: unknown,
    origin: Origin,
    spawns: ChangeEvent[],
    mutations: ChangeEvent[],
  ): void {
    if (mapKey === EXISTS) {
      // exists→true is spawn. exists→undefined never occurs standalone (we only clear it via whole-map
      // delete, which surfaces as a parent-level despawn), so nothing to emit for its removal.
      if (val !== undefined) spawns.push({ kind: "spawn", key, origin });
      return;
    }
    if (mapKey.startsWith(COMP)) {
      const c = componentByName(mapKey.slice(COMP.length));
      if (c === undefined) return this.warnUnknown("component", mapKey.slice(COMP.length));
      mutations.push(
        val === undefined
          ? { kind: "component-remove", key, comp: c, origin }
          : { kind: "component-set", key, comp: c, value: val as ComponentValue, origin },
      );
      return;
    }
    if (mapKey.startsWith(TAG)) {
      const t = tagByName(mapKey.slice(TAG.length));
      if (t === undefined) return this.warnUnknown("tag", mapKey.slice(TAG.length));
      mutations.push(
        val === undefined
          ? { kind: "tag-remove", key, tag: t, origin }
          : { kind: "tag-add", key, tag: t, origin },
      );
      return;
    }
    if (mapKey.startsWith(REL_ONE)) {
      const r = relationByName(mapKey.slice(REL_ONE.length));
      if (r === undefined) return this.warnUnknown("relation", mapKey.slice(REL_ONE.length));
      mutations.push(
        val === undefined
          ? { kind: "relation-remove", key, rel: r, target: undefined, origin }
          : { kind: "relation-set", key, rel: r, target: entityKey(String(val)), origin },
      );
      return;
    }
    if (mapKey.startsWith(REL_MANY)) {
      const [name, target] = parseRelManyKey(mapKey);
      const r = relationByName(name);
      if (r === undefined) return this.warnUnknown("relation", name);
      mutations.push(
        val === undefined
          ? { kind: "relation-remove", key, rel: r, target: entityKey(target), origin }
          : { kind: "relation-add", key, rel: r, target: entityKey(target), origin },
      );
    }
  }

  /** One-shot DEV diagnostic per unresolved durable name (005 §1.4: detect, never misbind, never throw). */
  private warnUnknown(kind: string, name: string): void {
    const tag = `${kind}:${name}`;
    if (this.warnedNames.has(tag)) return;
    this.warnedNames.add(tag);
    devWarn(
      `durable ${kind} "${name}" is not registered in this schema — skipping its changes (005 §1.4).`,
    );
  }
}

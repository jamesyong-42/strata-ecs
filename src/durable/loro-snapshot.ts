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
 *     keeps them separate (verified). So EVERY commit this adapter seals is tagged `strata:<n>` with a
 *     monotonic per-doc counter — that is the sole reason for the message, and it is what lets a receiver
 *     recover commit boundaries. The counter is namespaced (`strata:`) because the doc is CALLER-SUPPLIED:
 *     a bare "0"/"1" would squat the user-visible commit-message channel and be indistinguishable from app
 *     data. THE DURABLE LAYER RESERVES THE COMMIT-MESSAGE CHANNEL on any doc it is attached to. The counter
 *     is SEEDED IN THE CONSTRUCTOR from this peer's max existing `strata:<n>` (never lazily from 0): a
 *     session restart reusing the peer id would re-mint "strata:0" and loro would COALESCE the two commits
 *     in the sender's OWN oplog — a permanently unrecoverable boundary. An inbound change whose `msg` is not
 *     a strata tag is a FOREIGN writer (may have coalesced) — `applyRemote` DEV-warns once and treats its
 *     boundaries as best-effort. Split algorithm: record `beforeVV=doc.version()` +
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
 *  7. `UndoManager` (005 §1.3, LOCAL-ops-only): `undo()`/`redo()` self-commit (advance frontiers, no
 *     explicit `doc.commit`), return a boolean, and revert only ops the LOCAL peer authored. Their inverse
 *     edits flow out through the same frontier-diff path as an ordinary `local` batch. Undo groups edits
 *     inside its merge interval — we pass `mergeInterval: 0` so ONE sealed commit is ONE undo step.
 *     CORRECTION (the earlier "never touches a peer's edit" claim was FALSE — probe-verified): undo does
 *     NOT time-travel; it re-asserts the pre-op state as NEW lamport-latest ops. Two consequences:
 *       (a) undoing a cell CLOBBERS a causally-NEWER remote overwrite of that same cell — the undo's op is
 *           lamport-latest, so it wins LWW over the peer's newer value (not "leaves peer edits untouched");
 *       (b) undoing a SPAWN commit despawns the entity, and (with the three-part contract) drops the
 *           entity's cells — including components a peer added AFTER the spawn. So an undo can erase remote
 *           work. Whether to accept that or gate it is a Part III M3 decision (TODO(M3-design)); this
 *           adapter only surfaces faithful `UndoManager` behaviour. Both cases are pinned in the tests.
 *     COMMIT-BOUNDARY: `undo()`/`redo()` self-commit with NO message by default, so consecutive undos (or
 *     an undo+redo pair) COALESCE into one oplog change — the receiver then sees the wrong batch count (an
 *     undo+redo can net to ZERO batches). We call `doc.setNextCommitMessage(strata:<n>)` right before the
 *     `UndoManager` call so each self-commit is distinctly tagged (finding 3). If the call returns false no
 *     commit happens and the pending message lingers — harmless: the next explicit `commit({message})`
 *     overrides it.
 *
 *  8. `export({ mode:"snapshot" })` = full converged state (imports into a fresh doc). `doc.export`
 *     IMPLICITLY seals staged ops — with no message and no local batch (they'd coalesce on the receiver),
 *     so `export()` seals EXPLICITLY first (finding 10).
 *
 *  9. NEVER DELETE A PER-ENTITY CONTAINER. Containers are minted once per key (`ensureChild`) and never
 *     removed; despawn deletes the KEYS INSIDE (incl. `exists`), leaving an empty map that reads absent.
 *     A whole-container delete caused two probe-confirmed criticals: (a) two peers concurrently recreating
 *     the same key after a despawn (ordinary flow) LWW-pick ONE container and SILENTLY orphan the other's
 *     entire cell set — a purely-additive fact stream with no removal fact, so reconcile can NEVER learn of
 *     the loss; (b) per-commit replay dropped EVERY fact of a commit whose container a later buffered commit
 *     deleted (`getPathToContainer` resolves against the post-import head — `[spawn+set][set][despawn]` gave
 *     ONE batch, not three). With no-delete, every child pair resolves and (b) is impossible.
 *     POLICY FLIP (record for 006, TODO(006-amendment)): despawn-vs-concurrent-edit is now PER-CELL LWW, not
 *     container-delete-wins. A remote `set` concurrent with a local despawn leaves THAT ONE CELL alive — so
 *     an entity can converge RESURRECTED with only partial cells; reconcile classifies it as a structural
 *     add (absent baseline). First-creation races still mint two containers if two peers create the SAME key
 *     before any sync — impossible under peer-prefixed key minting; MutableSnapshot callers MUST use
 *     peer-unique keys (design.md §14.2). Empty-container = absent is an ADAPTER-INTERNAL representation; the
 *     ladder-visible semantics are unchanged, so the conformance suite passes untouched.
 *
 *  10. COMMIT SCOPE + REENTRANCY. A throwing `commit(body)` still SEALS what it staged (in `finally`, with a
 *     message) and emits that partial batch locally BEFORE rethrowing — otherwise the dangling staged ops
 *     get absorbed into the NEXT local batch while receivers already saw them (streams diverge). Atomic-abort
 *     is the M3 recorder's job (buffer ops, write after `fn` returns — design.md §12.2/§12.3). `applyRemote`,
 *     `undo`, `redo` THROW when a commit scope is open (a nested `applyRemote` double-delivers facts with the
 *     wrong origins). `export()` seals staged ops explicitly (finding 8). EMPTY-BATCH stance: a remote commit
 *     whose every fact lost LWW yields NO batch — so `commitId` MUST NOT be used for completeness accounting
 *     (batch count ≤ commit count).
 *     FRONTIER-VS-STAGING (verified): `doc.frontiers()` AND `doc.oplogFrontiers()` BOTH advance the instant an
 *     op is STAGED (before any commit), so a "before" frontier read at seal time already counts the staged
 *     ops and its diff to the post-commit head is EMPTY. The local-diff "from" is therefore tracked as
 *     instance state (`sealedTo`, advanced by every emit), NOT read fresh at seal time; `getPendingTxnLength()`
 *     is the reliable "are there staged ops?" gate. (Part IV's ephemeral adapter will hit the same.)
 *
 *  11. PENDING-IMPORT POISON (upstream loro-crdt@1.13.6 bug). An out-of-order MIXED-MODE import (a shuffled
 *     mix of snapshot+update buffers whose deps are missing) can panic the wasm ("unreachable",
 *     pending_changes.rs:146); after the panic EVERY import/export/commit throws (wasm lock poisoned) and
 *     unexported local work is lost. In-order per-peer delivery never trips it (0/30 in the spike). The
 *     precursor is detectable and deterministic: `doc.import(bytes)` returns `ImportStatus` whose `pending`
 *     is a `Map | null` (test `=== null`, NOT truthiness). On `pending !== null`, `applyRemote` QUARANTINES
 *     the adapter (this + every future call throws {@link PendingImportError}) BEFORE any panic — so
 *     `export()` still recovers local work and the caller resyncs via a fresh doc + snapshot. TRANSPORTS
 *     MUST guarantee per-peer causal in-order delivery, or exchange snapshots.
 *
 *  12. CONTAINER VALUES AT CELL KEYS. A hostile/buggy peer can `setContainer` at a `comp:`/`tag:`/`rel1:`/
 *     `relN:`/resource key, or set a non-`LoroMap` (plain value / `LoroText`) as an entities-map value.
 *     `map.get` and `doc.diff` both surface these as `isContainer(v) === true` (or a plain value). Reads
 *     (`getComponent`/`getResource`/`getRelationOne`/…) and event translation treat any such value as
 *     unresolvable — skip + one-shot warn — never leaking a live wasm handle into a `ChangeEvent` or read.
 *     A poisoned entity-map value HEALS on a local spawn (`setContainer` overwrites it).
 *
 * ============================================================================================
 * DOCUMENT LAYOUT (plan-part3.md "Document layout", 005 §3 concretized)
 * ============================================================================================
 *  root LoroMap "entities":  <EntityKey> → a per-entity LoroMap (a container, NEVER deleted — finding 9)
 *  per-entity LoroMap:
 *    "exists"                → true                      the existence cell (005 §4.1; spawn = this only)
 *    "comp:<Name>"           → canonical value object    ONE atomic register, assigned WHOLESALE (§3.1)
 *    "tag:<Name>"            → true                       per-entry register (§3.2)
 *    "rel1:<Name>"           → <targetKey> string         arity "one" — one register
 *    "relN:" + JSON([<Name>,<targetKey>]) → true          arity "many" — one register PER edge
 *  DESPAWN clears every key above (incl. `exists`) but KEEPS the empty container (finding 9). An empty
 *  (or `exists`-less + cell-less) map reads ABSENT (hasEntity/entities gate on `keys().length > 0`).
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

import { LoroDoc, LoroMap, UndoManager, isContainer } from "loro-crdt";
import type { ContainerID, Diff, JsonChange, OpId, VersionVector } from "loro-crdt";
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
/**
 * TOTAL parse of a "relN:" edge key back to `[relationName, targetKey]`, or `undefined` when the
 * segment is not a JSON array of exactly two strings. The `relN:` map keys are PEER-CONTROLLED: a
 * hostile/buggy peer can write `relN:junk` (JSON.parse throws) or `relN:123` (parses to a number).
 * A bare `JSON.parse` + destructure at every despawn scan / read would let ONE such key throw AFTER
 * `doc.import` already advanced the frontier (the batch is then lost forever — retry returns []),
 * and wedge `getRelationMany`/`readEntity`/despawn for the whole doc. So every caller uses this and
 * treats `undefined` as an unknown edge (skip + one-shot warn), never a throw. */
function tryParseRelManyKey(mapKey: string): [string, string] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(mapKey.slice(REL_MANY.length));
  } catch {
    return undefined;
  }
  return Array.isArray(parsed) &&
    parsed.length === 2 &&
    typeof parsed[0] === "string" &&
    typeof parsed[1] === "string"
    ? [parsed[0], parsed[1]]
    : undefined;
}

/** A `JsonOpID` is a `"counter@peer"` string (loro finding 3). Split on the LAST '@' (peer is numeric). */
function parseJsonOpId(id: string): { peer: `${number}`; counter: number } {
  const at = id.lastIndexOf("@");
  return { counter: Number(id.slice(0, at)), peer: id.slice(at + 1) as `${number}` };
}

/**
 * The reserved commit ORIGIN for the durable layer's meta writes (docId etc. — the `meta` root map,
 * TODO(005-§10-amendment)). It is passed to `commit({ origin })` on a meta write and matched by the
 * UndoManager's `excludeOriginPrefixes`, so a meta write is NEVER an undo step (a user's undo must not
 * roll back the document id). Distinct from the `strata:` MESSAGE channel (finding 3), which sequences
 * commits; origin and message are independent loro commit fields.
 */
const META_ORIGIN = "strata-meta";

/** The durable layer's reserved commit-message namespace (finding 3): `strata:<monotonic per-doc n>`. */
const MSG_PREFIX = "strata:";
const strataMsg = (n: number): string => MSG_PREFIX + n;
/** The `n` of a `strata:<n>` message, or `undefined` if the message is not a strata tag (foreign writer). */
function strataMsgSeq(msg: string | null | undefined): number | undefined {
  if (msg === null || msg === undefined || !msg.startsWith(MSG_PREFIX)) return undefined;
  const n = Number(msg.slice(MSG_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Thrown by {@link LoroSnapshot.applyRemote} once the doc has taken a PENDING import (loro-crdt@1.13.6
 * leaves changes with missing deps buffered as "pending"; a later out-of-order mixed-mode import can
 * then panic the wasm and POISON the doc — every subsequent import/export/commit throws, unexported
 * local work lost). The adapter quarantines itself the instant it sees `import().pending !== null`,
 * BEFORE any such panic — so `export()` still works and the caller can resync via a fresh doc +
 * snapshot. This and all FUTURE `applyRemote` calls throw this; the adapter is permanently quarantined.
 */
export class PendingImportError extends Error {
  constructor() {
    super(
      "strata: this LoroSnapshot took a pending (missing-deps) import and is quarantined — " +
        "resync via a fresh LoroDoc + snapshot; export() still works for local recovery.",
    );
    this.name = "PendingImportError";
  }
}

/**
 * An opaque OUTBOUND cursor — a Loro `VersionVector` a caller round-trips through {@link
 * LoroSnapshot.version} → {@link LoroSnapshot.exportUpdatesSince} without interpreting. Re-exported
 * from the adapter (not `loro-crdt`) so `DurableStore` can hold a "last sent" cursor while keeping its
 * only `loro-crdt` import the `LoroDoc` parameter type — Loro stays quarantined behind this file (§14.2).
 * TODO(005-§10-amendment): the orchestrator amends 005 §10 for this adapter-level outbound surface.
 */
export type OutboundCursor = VersionVector;

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
  /**
   * root "meta" map: the durable store's reserved out-of-band slots (docId, §14.1) — DISTINCT from
   * "entities"/"resources" so it never collides with an entity key or resource name, and TRANSPARENT to
   * batch translation: a `meta` diff resolves to the path `["meta"]` (length 1), which `translatePairs`'
   * child-map guard (`path.length !== 2`) skips, so a meta write surfaces NO ChangeEvent. Owned here
   * (not the store) to keep every loro handle inside this file. TODO(005-§10-amendment).
   */
  private readonly metaMap: LoroMap;
  private readonly entitiesRootId: string;
  private readonly resourcesRootId: string;
  private readonly undoManager: UndoManager;

  /** Subscribers to sealed batches (local commits AND remote imports). We manage this list ourselves. */
  private readonly listeners = new Set<(batch: ChangeBatch) => void>();
  /**
   * Monotonic per-doc commit counter — the `strata:<n>` `commit({ message })` that keeps commits
   * un-coalesced (finding 3). SEEDED IN THE CONSTRUCTOR from this peer's existing history (never lazily
   * from 0): a session restart that reuses the peer id would otherwise re-mint `strata:0`, and loro
   * COALESCES two same-message commits in the sender's OWN oplog — a permanently unrecoverable batch
   * boundary. Seeding past the max existing `strata:<n>` for this peer keeps the sequence strictly
   * monotonic across restarts (gaps are harmless — only reuse coalesces).
   */
  private commitSeq: number;
  /** Reentrancy guard for `commit(body)` — nested commit (and applyRemote/undo/redo mid-commit) throws. */
  private committing = false;
  /**
   * The committed frontier AS OF THE LAST EMITTED BATCH — the "from" of the next local diff. Tracked as
   * state because loro's `frontiers()`/`oplogFrontiers()` BOTH advance the instant an op is STAGED (before
   * any commit), so a "before" frontier read at seal time already includes the staged ops and the diff
   * comes back empty (verified). Advanced by every emit (local seal AND remote import).
   */
  private sealedTo: OpId[];
  /**
   * PERMANENT quarantine (finding: pending-import poison). Set the instant `applyRemote` sees
   * `import().pending !== null`; once set, every `applyRemote` throws {@link PendingImportError}. `export`
   * stays functional so the caller can recover local work before resyncing on a fresh doc.
   */
  private quarantined = false;
  /**
   * One-shot DEV diagnostic dedupe — PER INSTANCE (fine: the schema is process-global, so an unresolved
   * name / poisoned key is stable for the doc's life; a fresh adapter re-warns, which is the intent).
   * Covers unresolved durable names (005 §1.4), poisoned entity-map keys, and the untagged-writer notice.
   */
  private readonly warnedNames = new Set<string>();

  constructor(doc: LoroDoc) {
    this.doc = doc;
    this.entitiesMap = doc.getMap("entities");
    this.resourcesMap = doc.getMap("resources");
    this.metaMap = doc.getMap("meta");
    this.entitiesRootId = String(this.entitiesMap.id);
    this.resourcesRootId = String(this.resourcesMap.id);
    // Seed the commit counter from THIS peer's persisted strata-tagged history BEFORE the first seal.
    this.commitSeq = this.seedCommitSeq();
    // The last-emitted frontier starts at the committed head (imported history is already sealed; a fresh
    // doc is []). No pending ops at construction, so `frontiers()` is the committed head here.
    this.sealedTo = this.doc.frontiers();
    // Local-ops-only undo (finding 7). `mergeInterval: 0` makes ONE sealed commit ONE undo step — loro's
    // default TIME-merges rapid commits into a single step, but the transaction model (M3) is
    // one-transaction = one-commit = one-undo-step, so we opt out of time grouping. Constructed here so
    // it tracks only this session's commits (pre-existing history is not undoable — "before our session").
    // `excludeOriginPrefixes: [META_ORIGIN]` keeps out-of-band meta writes (docId, `ensureMeta`) OUT of
    // the undo stack — a user's undo must never roll back the document id.
    this.undoManager = new UndoManager(doc, {
      mergeInterval: 0,
      excludeOriginPrefixes: [META_ORIGIN],
    });
  }

  /** Max existing `strata:<n>` message across this peer's own changes, + 1 (0 on a fresh doc). */
  private seedCommitSeq(): number {
    const mine = this.doc.getAllChanges().get(this.doc.peerIdStr);
    if (mine === undefined) return 0;
    let max = -1;
    for (const ch of mine) {
      const n = strataMsgSeq(ch.message);
      if (n !== undefined && n > max) max = n;
    }
    return max + 1;
  }

  /** The next `strata:<n>` commit message; advances the monotonic counter (never reused → never coalesces). */
  private nextMsg(): string {
    return strataMsg(this.commitSeq++);
  }

  // --- child-map access ----------------------------------------------------------------------------

  /**
   * The per-entity child map, or `undefined` if the entity has no map yet OR the entity-map value at
   * `key` is NOT a `LoroMap`. The value is peer-controlled: a hostile/buggy peer can `entities.set(key,
   * 42)` or put a `LoroText` there. A blind `v as LoroMap` would then brick every read AND every despawn
   * (removeIncoming's full scan) and throw on any write to that key. Treating a non-map value as absent
   * makes reads/despawn total; a local `spawn` HEALS it — `ensureChild`'s `setContainer` overwrites the
   * poison with a fresh `LoroMap` (probe-verified). One-shot DEV warn names the poisoned key.
   */
  private childMap(key: EntityKey): LoroMap | undefined {
    const v = this.entitiesMap.get(key);
    if (v == null) return undefined;
    if (v instanceof LoroMap) return v;
    this.warnUnknown("entity-map value", key);
    return undefined;
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
    if (v === undefined) return undefined;
    // A hostile `setContainer` at a comp: key would otherwise leak a live LoroMap handle as a value.
    if (isContainer(v)) return void this.warnUnknown("component container", c.name);
    return v as ComponentValue;
  }

  hasTag(key: EntityKey, t: Tag): boolean {
    return this.childMap(key)?.get(tagKey(t)) === true; // a container/any non-`true` value reads absent
  }

  getRelationOne(key: EntityKey, r: Relation): EntityKey | undefined {
    const v = this.childMap(key)?.get(relOneKey(r));
    if (v === undefined || v === null) return undefined;
    if (isContainer(v)) return void this.warnUnknown("relation container", r.name);
    return entityKey(String(v));
  }

  getRelationMany(key: EntityKey, r: Relation): EntityKey[] {
    const m = this.childMap(key);
    if (m === undefined) return [];
    const out: EntityKey[] = [];
    for (const mk of m.keys()) {
      const s = String(mk);
      if (s.startsWith(REL_MANY)) {
        const parsed = tryParseRelManyKey(s);
        if (parsed === undefined) this.warnUnknown("relation edge key", s);
        else if (parsed[0] === r.name) out.push(entityKey(parsed[1]));
      }
    }
    return out;
  }

  getResource(res: Resource): ComponentValue | undefined {
    const v = this.resourcesMap.get(res.name);
    if (v === undefined) return undefined;
    if (isContainer(v)) return void this.warnUnknown("resource container", res.name);
    return v as ComponentValue;
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
      if (mk.startsWith(COMP)) {
        const v = m.get(mk);
        if (isContainer(v)) this.warnUnknown("component container", mk.slice(COMP.length));
        else components[mk.slice(COMP.length)] = v as ComponentValue;
      } else if (mk.startsWith(TAG)) tags.push(mk.slice(TAG.length));
      else if (mk.startsWith(REL_ONE)) {
        const v = m.get(mk);
        if (isContainer(v)) this.warnUnknown("relation container", mk.slice(REL_ONE.length));
        else relations[mk.slice(REL_ONE.length)] = entityKey(String(v));
      } else if (mk.startsWith(REL_MANY)) {
        const parsed = tryParseRelManyKey(mk);
        if (parsed === undefined) {
          this.warnUnknown("relation edge key", mk);
          continue;
        }
        const [name, target] = parsed;
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

  /**
   * THREE-PART despawn (005 §1.3): record + outgoing edges + incoming edges. NEVER deletes the per-entity
   * container — it deletes the KEYS INSIDE it (`exists` + every comp/tag/edge) and leaves the empty map in
   * place. Containers are created once per key (`ensureChild`) and never removed. This fixes two criticals
   * a whole-container delete caused: (a) two peers concurrently recreating the same key after a despawn
   * LWW-picked ONE container and SILENTLY orphaned the other's whole cell set with no removal fact reconcile
   * could ever see; (b) per-commit replay dropped every fact of a commit whose container a LATER buffered
   * commit deleted (`getPathToContainer` resolves against the post-import head). An empty map reads absent
   * (hasEntity/entities gate on `keys().length > 0`); the `exists` deletion surfaces on the CHILD diff and
   * `translateChildKey` maps it to the despawn fact. POLICY FLIP (see header): despawn-vs-concurrent-edit is
   * now PER-CELL LWW, so a remote set concurrent with a local despawn leaves that one cell alive — a legal
   * partial-cell resurrection. TODO(006-amendment): the orchestrator amends 006 for that reconcile case.
   */
  despawn(key: EntityKey): void {
    // Part 3: sever every INCOMING edge `* --rel--> key` on every other entity (correctness-first scan;
    // O(entities × edges-per-entity) per despawn — see COST note below). Do this BEFORE clearing `key`'s
    // own map so a self-edge on `key` is handled by the own-key clear, not double-touched.
    this.removeIncoming(key);
    // Parts 1 + 2: clear `exists`, every comp/tag, and every outgoing edge — but keep the container.
    const m = this.childMap(key);
    if (m !== undefined) for (const mk of m.keys()) m.delete(String(mk));
  }

  setComponent(key: EntityKey, c: Component, v: ComponentValue): void {
    const child = this.ensureChild(key);
    const canonical = canon(c, v); // 005 §2: canonical known-field values
    // 006 B3 R4 — OVERLAY the known-field canonical values onto the register's CURRENT raw value, so a
    // NEWER peer's unknown field (a `Position.z` this build lacks) SURVIVES this write instead of being
    // stripped by a wholesale assignment. Without this, an older-schema peer committing a known-field
    // change silently destroys the newer peer's extra field across the wire (cross-version data loss).
    // A fresh / absent / poisoned (container) register writes the canonical value as-is. All local-schema
    // compares stay well-defined because the baseline + surfaced ChangeEvent path strips extras via
    // canon/tryCanon (R4: "the raw value with the extra field lives in Loro, not the baseline").
    const cur = child.get(compKey(c));
    if (cur !== undefined && !isContainer(cur) && typeof cur === "object" && cur !== null) {
      child.set(compKey(c), { ...(cur as Record<string, unknown>), ...canonical });
    } else {
      child.set(compKey(c), canonical);
    }
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
        if (mk.startsWith(REL_MANY) && tryParseRelManyKey(mk)?.[0] === r.name) m.delete(mk);
      }
    } else {
      m.delete(relManyKey(r, target));
    }
  }

  setResource(res: Resource, v: ComponentValue): void {
    const canonical = canonResource(res, v); // 005 §2/§10.1: object-backed canonical
    // 006 B3 R4 — OVERLAY the known-field canonical values onto the register's CURRENT raw value, so a
    // NEWER peer's unknown resource field SURVIVES this write instead of being stripped by a wholesale
    // assignment (§13.4: a durable resource reconciles exactly like a single-cell component, so it gets the
    // identical overlay as setComponent). Without this, an older-schema peer's `setResource` silently
    // destroys the newer peer's extra field across the wire (the resource twin of the component R4 loss).
    // A fresh / absent / poisoned (container) register writes the canonical value as-is; the baseline +
    // surfaced ChangeEvent path strips extras via canonResource/tryCanonResource so local compares stay
    // well-defined (R4: the raw value with the extra field lives in Loro, not the baseline).
    const cur = this.resourcesMap.get(res.name);
    if (cur !== undefined && !isContainer(cur) && typeof cur === "object" && cur !== null) {
      this.resourcesMap.set(res.name, { ...(cur as Record<string, unknown>), ...canonical });
    } else {
      this.resourcesMap.set(res.name, canonical);
    }
  }

  removeResource(res: Resource): void {
    this.resourcesMap.delete(res.name);
  }

  // --- CRDTSnapshot capabilities -------------------------------------------------------------------

  /**
   * `commit(body)` is a SCOPE sealing ONE loro commit (005 §1.3): open, run body, seal. The commit is
   * tagged with a monotonic `strata:<n>` message so it never coalesces with its neighbours (finding 3).
   * The sealed batch (origin "local") is derived from the frontier diff and delivered to subscribers.
   * Nested commit throws (the pinned choice). A no-op body (no ops staged) delivers nothing.
   *
   * A THROWING body still SEALS whatever it staged, in `finally`, with a message, and emits that partial
   * batch to local subscribers BEFORE the error propagates — so the local echo and every receiver's stream
   * always agree on what the doc contains (a bare loro export/frontier read would otherwise absorb the
   * dangling staged ops into the NEXT batch locally while receivers already saw them: streams diverge).
   * ATOMIC-ABORT (discard-on-throw) is NOT this layer's job — it is the M3 transaction recorder's, which
   * buffers ops and only writes the doc after `fn` returns (design.md §12.2/§12.3); this adapter faithfully
   * surfaces whatever reached the doc.
   */
  commit(body: () => void): void {
    if (this.committing) throw new Error("strata: nested commit() is not allowed.");
    this.committing = true;
    try {
      body();
    } finally {
      this.doc.commit({ message: this.nextMsg() });
      this.committing = false;
      this.flushLocal(); // diff from `sealedTo` (the last-emitted head) → everything this commit sealed
    }
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
   *
   * THROWS on an open commit scope (a nested applyRemote double-delivers facts with the wrong origins).
   * QUARANTINE (finding: pending-import poison): if `import` leaves changes PENDING (`status.pending !==
   * null` — a Map, test for null, not truthiness), the doc is one out-of-order mixed-mode import away from
   * a wasm panic that poisons it permanently; the adapter quarantines itself and throws {@link
   * PendingImportError} here and on every future call — the caller must resync via a fresh doc + snapshot.
   * We quarantine BEFORE any panic, so `export()` still recovers local work. EMPTY-BATCH stance: a remote
   * commit whose every fact LOST LWW yields NO batch (dropped) — so batch count ≤ commit count and a
   * commitId must NOT be used for completeness accounting.
   */
  applyRemote(bytes: Uint8Array): ChangeBatch[] {
    if (this.committing) throw new Error("strata: applyRemote() during commit() is not allowed.");
    if (this.quarantined) throw new PendingImportError();
    const beforeVV = this.doc.version();
    const beforeFrontiers = this.doc.frontiers();
    const status = this.doc.import(bytes);
    if (status.pending !== null) {
      this.quarantined = true;
      throw new PendingImportError();
    }
    // No new ops (empty or fully-duplicate buffer) → no batches.
    if (this.doc.cmpFrontiers(beforeFrontiers, this.doc.frontiers()) === 0) return [];

    const schema = this.doc.exportJsonUpdates(beforeVV, this.doc.version(), false); // false: real peer ids
    const batches: ChangeBatch[] = [];
    let prev: OpId[] = beforeFrontiers;
    for (const change of schema.changes) {
      // A commit with no `strata:<n>` tag is a foreign writer whose commits may have COALESCED in their
      // oplog — our per-commit boundaries are best-effort for them. Warn ONCE (per instance).
      if (strataMsgSeq(change.msg) === undefined) {
        this.warnOnce(
          "untagged-writer",
          "durable adapter saw a commit with no strata tag — untagged commits may coalesce; " +
            "batch boundaries are best-effort for this peer (005 §1.3).",
        );
      }
      const cur = this.frontierAfter(prev, change);
      const batch = this.translatePairs(this.doc.diff(prev, cur, false), "remote", change.id);
      if (batch.events.length > 0) batches.push(batch);
      prev = cur;
    }
    // Advance the last-emitted head to include the imported ops, so the NEXT local seal diffs from here
    // (not re-emitting these remote ops as "local").
    this.sealedTo = this.doc.frontiers();
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

  /**
   * Full converged snapshot. SEALS any staged-but-uncommitted writes FIRST (as a tagged commit + local
   * batch), rather than letting loro's `export` implicitly seal them — an implicit seal ships them to
   * peers with NO local echo and NO `strata:<n>` message (so they'd coalesce on the receiver). After the
   * explicit seal, export the snapshot.
   */
  export(): Uint8Array {
    this.sealStaged();
    return this.doc.export({ mode: "snapshot" });
  }

  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * LOCAL undo (finding 7, LOCAL-ops-only): self-commits its inverse ops; the revert flows out as an
   * ordinary "local" batch. `setNextCommitMessage` tags the undo's self-commit with the next `strata:<n>`
   * so consecutive undos DON'T coalesce into one oplog change (finding 3 — without it two undos, or an
   * undo+redo pair, merge and the receiver sees the wrong batch count). If `undo()` returns false no
   * commit happens and the pending message lingers harmlessly — the next explicit `commit({message})`
   * overrides it. THROWS inside a commit scope (its inverse ops would corrupt the open batch).
   *
   * SEMANTICS (corrected, finding 7 — the earlier "never touches a peer's edit" claim was FALSE): undo
   * re-asserts the pre-op state as NEW lamport-latest ops. So undoing a cell CLOBBERS a causally-newer
   * REMOTE overwrite of that same cell, and undoing a spawn commit despawns the entity — taking peers'
   * later components with it (both probe-pinned in the tests). Whether to accept or gate that is the M3
   * design decision (TODO(M3-design)); at this layer undo is faithful loro `UndoManager` behaviour.
   */
  undo(): void {
    if (this.committing) throw new Error("strata: undo() during commit() is not allowed.");
    this.doc.setNextCommitMessage(this.nextMsg());
    if (this.undoManager.undo()) this.flushLocal();
  }

  redo(): void {
    if (this.committing) throw new Error("strata: redo() during commit() is not allowed.");
    this.doc.setNextCommitMessage(this.nextMsg());
    if (this.undoManager.redo()) this.flushLocal();
  }

  // --- Part III M1 store-support surface (adapter-level; NOT on the frozen CRDTSnapshot) ------------
  // These exist so `createDurableStore` (§14.2) can mint keys, hold a docId, and ship outbound
  // increments while keeping EVERY loro call inside this file — the store speaks only these plus the
  // frozen CRDTSnapshot. TODO(005-§10-amendment): the orchestrator amends 005 §10 for this surface.

  /** This doc's peer id string — the `${peerIdStr}-<counter>` key prefix the store mints from (§14.1). */
  peerIdStr(): string {
    return this.doc.peerIdStr;
  }

  /**
   * Every key in the "entities" root map — LIVE OR NOT. Despawned containers linger (finding 9), so this
   * is deliberately the RAW key set, not the liveness-filtered {@link entities}: the store's counter
   * resume (§14.2) must not re-mint a key this peer EVER used, including one whose entity was despawned.
   */
  entityKeysRaw(): string[] {
    return this.entitiesMap.keys().map(String);
  }

  /**
   * Every resource NAME in the "resources" root map (RAW keys — includes names this build's schema does not
   * resolve; the caller filters + gates). Attach uses this to SEED the baseline + runtime from a cold-loaded
   * doc's pre-existing resources (§13.1 founding agreement): a resource has no entity to hang off, so it has
   * no other enumerator on the frozen Snapshot interface — the resource sibling of {@link entityKeysRaw}.
   * TODO(005-§10.8-amendment): the orchestrator amends 005 §10.8 for this store-support surface.
   */
  resourceNamesRaw(): string[] {
    return this.resourcesMap.keys().map(String);
  }

  /** The current document version — the starting cursor for {@link exportUpdatesSince}. */
  version(): OutboundCursor {
    return this.doc.version();
  }

  /**
   * The update increment from `from` (a prior {@link version}) to now — the bytes of the commits sealed
   * since. A receiver that already holds `from`'s causal base imports this and converges; a receiver
   * MISSING that base takes a pending import (finding 11), so outbound increments presuppose the base was
   * shipped first (the app snapshots on join — 006 §A5.2). Equivalent in effect to a full-snapshot import.
   */
  exportUpdatesSince(from: OutboundCursor): Uint8Array {
    return this.doc.export({ mode: "update", from });
  }

  /** Read a string slot from the reserved "meta" root map (docId, §14.1), or `undefined` if absent/non-string. */
  readMeta(key: string): string | undefined {
    const v = this.metaMap.get(key);
    return typeof v === "string" ? v : undefined;
  }

  /**
   * Write `key = value` into the "meta" root map ONCE (first-writer-wins) and return the resolved value —
   * the existing one if already present, else `value` after sealing it. The write is ONE commit tagged
   * `origin: META_ORIGIN` (kept out of undo, see the constructor) and a `strata:` message (so it never
   * coalesces, finding 3); it surfaces NO ChangeEvent (meta is neither "entities" nor "resources").
   * Construction-time only (the store's docId ensure) — not guarded against a nested commit scope.
   */
  ensureMeta(key: string, value: string): string {
    const existing = this.readMeta(key);
    if (existing !== undefined) return existing;
    this.metaMap.set(key, value);
    this.doc.commit({ message: this.nextMsg(), origin: META_ORIGIN });
    this.flushLocal(); // advance sealedTo past the meta commit; emits nothing (no entities/resources facts)
    return value;
  }

  // --- internals -----------------------------------------------------------------------------------

  /**
   * Seal staged-but-uncommitted writes as one tagged commit + local batch (the `export()` path). A no-op
   * when nothing is staged (`getPendingTxnLength() === 0`) — so a bare `export()` neither commits nor
   * burns a sequence number.
   */
  private sealStaged(): void {
    if (this.doc.getPendingTxnLength() === 0) return;
    this.doc.commit({ message: this.nextMsg() });
    this.flushLocal();
  }

  /**
   * Emit the local batch for everything COMMITTED since the last emit (`sealedTo`), then advance `sealedTo`
   * to the new head. Skips an empty seal (no frontier movement) and a batch that translated to no events.
   * `sealedTo` — not a freshly-read frontier — is the "from": a fresh read already counts staged ops.
   */
  private flushLocal(): void {
    const before = this.sealedTo;
    const after = this.doc.frontiers();
    if (this.doc.cmpFrontiers(before, after) === 0) return;
    this.sealedTo = after;
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
      if (source === target) continue; // the target's own outgoing edges go with despawn's own-key clear
      const m = this.childMap(entityKey(source));
      if (m === undefined) continue;
      for (const rawMapKey of m.keys()) {
        const mk = String(rawMapKey);
        if (mk.startsWith(REL_ONE)) {
          const v = m.get(mk);
          if (!isContainer(v) && String(v) === target) m.delete(mk);
        } else if (mk.startsWith(REL_MANY)) {
          if (tryParseRelManyKey(mk)?.[1] === target) m.delete(mk);
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
        // root "entities": a key→undefined is a DESPAWN by a peer that DELETED the whole container (the
        // legacy layout — this adapter no longer does that, but honours an old/foreign peer that still
        // does). A key→container is a create (facts via the child pair). Our OWN despawns surface as an
        // `exists`→undefined on the child pair instead (translateChildKey → despawn).
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
          if (isContainer(val)) {
            this.warnUnknown("resource container", name); // a hostile setContainer at a resource key
            continue;
          }
          mutations.push(
            val === undefined
              ? { kind: "resource-remove", res, origin }
              : { kind: "resource-set", res, value: val as ComponentValue, origin },
          );
        }
      } else {
        // A per-entity child map: path is ["entities", <EntityKey>]. Containers are never deleted, so a
        // child pair ALWAYS resolves (the deleted-container / path-resolution hole is gone with no-delete).
        const path = this.doc.getPathToContainer(cid);
        if (path === undefined || path.length !== 2 || path[0] !== "entities") continue;
        const key = entityKey(String(path[1]));
        for (const mapKey of Object.keys(updated)) {
          this.translateChildKey(key, mapKey, updated[mapKey], origin, spawns, mutations, despawns);
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
    despawns: ChangeEvent[],
  ): void {
    if (mapKey === EXISTS) {
      // exists present → spawn. exists→undefined → DESPAWN: with the no-delete layout, despawn clears the
      // KEYS inside the entity map (incl. `exists`) and keeps the empty container, so a despawn surfaces
      // HERE as `exists`→undefined (plus each other key→undefined as its own remove — normalizeBatch's
      // despawn-dominance folds those into the surviving despawn). Ordered last via the `despawns` bucket.
      if (val === undefined) despawns.push({ kind: "despawn", key, origin });
      else spawns.push({ kind: "spawn", key, origin });
      return;
    }
    // A present value that is a CONTAINER (hostile setContainer at a cell key) is not decodable as a cell
    // value — treat the name as unknown (skip + one-shot warn), never leak the wasm handle into an event.
    const poisoned = val !== undefined && isContainer(val);
    if (mapKey.startsWith(COMP)) {
      const c = componentByName(mapKey.slice(COMP.length));
      if (c === undefined) return this.warnUnknown("component", mapKey.slice(COMP.length));
      if (poisoned) return this.warnUnknown("component container", c.name);
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
      if (poisoned) return this.warnUnknown("tag container", t.name);
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
      if (poisoned) return this.warnUnknown("relation container", r.name);
      mutations.push(
        val === undefined
          ? { kind: "relation-remove", key, rel: r, target: undefined, origin }
          : { kind: "relation-set", key, rel: r, target: entityKey(String(val)), origin },
      );
      return;
    }
    if (mapKey.startsWith(REL_MANY)) {
      const parsed = tryParseRelManyKey(mapKey);
      if (parsed === undefined) return this.warnUnknown("relation edge key", mapKey);
      const [name, target] = parsed;
      const r = relationByName(name);
      if (r === undefined) return this.warnUnknown("relation", name);
      // A relN: edge's value is the sentinel `true`; a container there is malformed — skip + warn.
      if (poisoned) return this.warnUnknown("relation container", name);
      mutations.push(
        val === undefined
          ? { kind: "relation-remove", key, rel: r, target: entityKey(target), origin }
          : { kind: "relation-add", key, rel: r, target: entityKey(target), origin },
      );
    }
  }

  /**
   * One-shot DEV diagnostic per unresolved durable name OR poisoned cell/key (005 §1.4: detect, never
   * misbind, never throw). Covers unregistered names, container values at cell keys, non-map entity-map
   * values, and malformed `relN:` keys — all "the doc says something we can't decode as a cell, so skip it".
   */
  private warnUnknown(kind: string, name: string): void {
    this.warnOnce(
      `${kind}:${name}`,
      `durable ${kind} "${name}" is unresolved or malformed — skipping its changes (005 §1.4).`,
    );
  }

  /** Emit `message` via `devWarn` at most once per `tag` for this instance's lifetime. */
  private warnOnce(tag: string, message: string): void {
    if (this.warnedNames.has(tag)) return;
    this.warnedNames.add(tag);
    devWarn(message);
  }
}

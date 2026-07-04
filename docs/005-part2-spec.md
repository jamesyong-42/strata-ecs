# Patch Note 005 — Part II, The Storage Substrate (normative)

**Status:** Normative — **IMPLEMENTED** (2026-07-03; commits 9aae91b M3a-runtime, a71e104 M1/M2, 81863bc M4, 3b665af review fixes; 414 ci + 140 stress tests green). §10 records the as-built amendments — read it before coding Part III against §2/§4/§5/§8. This note **supersedes** `design.md` §9 (the snapshot ladder), §10 (the projector kernel), and the Part II API reference. Where this note and the locked baseline disagree, this note governs Part II; the baseline's Part II prose is retained only as rationale that this note re-states in the shipped currency.
**Scope:** Part II (the storage substrate) — the snapshot ladder, canonical values, the layout contract, `normalizeBatch`, the projector kernel, two runtime additions, the wire form, and the conformance suite. No Loro dependency lands in this part (see §9, build plan).
**Baseline:** `design.md` (locked). **Sources folded in:** `004-part2-4-revision.md` §§A1–A2, B4, C1–C4, D1–D7, E (all post-red-team, settled); the as-built Part I (`src/core/*`); `002-reactivity.md` (the stamp model this part rides).
**Depends on:** Part I as shipped — `RuntimeStore` (identity/placement seams, projection primitives), `field.ts` (the `EntityKey` brand, the `"key"` field type), `schema.ts` (name lookups, `encodeComponentValue`), `world.ts` (`registerInboundSource`, `sync()`), and 001/002/003 reactivity (the stamps every projection primitive already carries).

This document is what Part II implementation agents code against. Signatures are anchored to real lines in the as-built code and are meant to compile against it.

---

## 0. Supersession map

| Superseded (design.md) | Replaced by (this note) | What changed |
|---|---|---|
| §9.1–§9.2 (ladder overview, keys vs. handles, `StorageKey`) | §1.1 | The ladder is **`EntityKey`-only**. `Snapshot<K>` genericity and `StorageKey` are cut; the local snapshot is formally **exempt** (a serialization pass, not a ladder member). |
| §9.3 (the interface in tiers) | §1.2, §1.3 | Retyped on **schema objects** (`Component`/`Tag`/`Relation`/`Resource`), not numeric ids. Relation reads **arity-split** (`getRelationOne`/`getRelationMany`). `EntityRecord` specced as the as-built §8 shape. Direction rule, three-part despawn, `MutableSnapshot`, `CRDTSnapshot`, commit-as-scope, `ChangeBatch` single-origin — carried forward. |
| §9.4 (`ChangeEvent`/`Origin`) | §1.4 | Doc-facts carry schema objects, resolved from stored names at the adapter boundary. `component-set` ambiguity and origin semantics carried forward. |
| — (unspecified) | §2 | **New.** Canonical values + cell equality (004 A1 / B4). The ship-blocking baseline-compare bug. |
| — (unspecified) | §3 | **New.** The layout contract: assignment unit = conflict unit (004 A2). |
| — (unspecified) | §4 | **New.** `normalizeBatch` — exported pure function, cell taxonomy, dominance (004 E / M1). |
| §10.1–§10.3 (the projector) | §5 | Rewritten against the **as-built** primitives (all exist). Mixed in-emit guards made honest; teardown is **four** steps; `unregisterInboundSource` added as step 0 (004 D6/D7, C2). |
| `MutableSnapshot.removeResource` (declared, unimplemented) | §6 | **New runtime addition** `RuntimeStore.removeResource` (004 D4) — the reconcile dead-end closed. |
| API ref `EntityKey = string & { __brand }` | §1.1, §7 | The API-reference brand **does not match shipped code**. This note enshrines the shipped brand (`field.ts:33`). |
| — | §8 | **New.** The conformance suite P1–P7 (004 E / M4), gating Part III. |
| — | §9 | **New.** The Part II build plan M1–M4, Loro deferred to Part III. |

Part II is the *vocabulary*; Parts III–IV are the *behavior*. Everything here is medium-agnostic and policy-free: no reconcile rules, no transaction semantics, no throttling. The headline discovery driving this revision (004 §12): **Part I already shipped every primitive the projector needs, each already carrying the 002/003 reactivity stamps.** Part II is therefore small — types, canonical-value rules, one pure function, the projector class, two runtime additions, and a conformance suite — and most of the work is making implicit truths normative.

---

## 1. The snapshot ladder, revised

### 1.1 One key type: the shipped `EntityKey`. No `Snapshot<K>`, no `StorageKey`.

The ladder is keyed by **`EntityKey`** — the branded `string` that Part I already ships (`field.ts:33`):

```ts
// src/core/field.ts:33 — the SHIPPED brand. This is THE key type for Parts II–IV.
export type EntityKey = string & { readonly __entityKey: unique symbol };
export function entityKey(s: string): EntityKey { return s as EntityKey; } // field.ts:36 — identity at runtime
```

Part II defines **no key type of its own.** It imports this one.

- **MUST:** Parts II–IV use `EntityKey` from `field.ts`. The `design.md` API reference declared a *second, incompatible* brand — `string & { readonly __brand: "EntityKey" }` — which never existed in code. That declaration is deleted; any doc or code referencing it is wrong. (This is the one place the baseline cited a type that the shipped runtime does not have.)
- **MUST NOT:** introduce `Snapshot<K extends StorageKey>` genericity or a `StorageKey = string | number` union. The `K = number` instantiation had **zero implementors**. The ladder is `EntityKey`-only.

An `EntityKey` is a stable, opaque, peer-prefixed string (`"${peerId}-${counter}"` for the collaborative layers). It survives detach/re-attach, serialization, and sync. It is **not** a runtime handle: an `Entity` (Part I §2) is a packed `u32`, runtime-local, disposable, re-minted on every attach. The projector (§5) owns the bijection between the two; the ladder never sees a handle.

**The local snapshot is exempt — it is not a ladder member.** As built, local save/load is two standalone functions (`exportSnapshot`/`importSnapshot`, `snapshot.ts:47,98`) that build a **temporary dense-integer map** (`handle ⇄ 0,1,2,…`, `snapshot.ts:49-51`) for the duration of one serialize/deserialize pass and throw it away. There is no persistent key↔handle bijection because a local file has a single writer and no reconcile. So the "three map-shaped representations" observation still holds *conceptually* — JSON save, baseline, Loro doc are all cell-addressed stores of the same logical entities — but only the **baseline** and the **CRDT** implement the `Snapshot` interface below. The local snapshot proves the shape is general without being forced to instantiate a generic that buys nothing. It keeps its own numeric-keyed `EntityRecord` (`snapshot.ts:28`); it never flows through the projector.

### 1.2 The interface, in capability tiers — keyed by schema objects

A single fat interface would force lies (JSON cannot take writes-during-merge; the baseline has no history; only the CRDT emits change-events), so the ladder is **a base read interface plus capability extensions**, and the type system enforces who can do what. Addressing is at **component-cell granularity**, matching the unit of commit/reconcile/undo (Part III).

The in-memory API is keyed by **schema objects** — `Component`, `Tag`, `Relation`, `Resource` — because that is the entire as-built currency (`RuntimeStore.projectComponent<S>(e, c: Component<S>, v)`, `schema.ts` handles). The `design.md` sketch keyed on `ComponentId`/`TagId`/`RelationId` numeric ids, which would not compile against the shipped primitives.

```ts
// Both the baseline and the CRDT snapshot implement Snapshot. Pure reads, cell-addressed,
// EntityKey-keyed, schema-object-typed. (The local snapshot is NOT a member — §1.1.)
//
// PERSISTENCE (normative): a PERSISTENT implementation (LoroSnapshot, and the baseline's own
// name-keyed cells) MUST store each component/tag/relation/resource by its stable `.name`
// (ComponentName = string, etc.), resolving name → object via componentByName/tagByName/
// relationByName/resourceByName (schema.ts:225-236) at the adapter READ boundary — never by the
// run-local numeric id, which is not stable across builds or schema versions (§3.4). Ids are the
// in-process currency; names are the durable currency.
interface Snapshot {
  hasEntity(key: EntityKey): boolean;
  entities(): Iterable<EntityKey>;
  getComponent(key: EntityKey, c: Component): ComponentValue | undefined;  // decoded, name-keyed, §7
  hasTag(key: EntityKey, t: Tag): boolean;
  // ARITY-SPLIT reads (D7): writes were already split (setRelation vs addRelation, runtime-store.ts:853/865);
  // reads now match. getRelationOne is for arity "one"; getRelationMany for arity "many".
  getRelationOne(key: EntityKey, r: Relation): EntityKey | undefined;
  getRelationMany(key: EntityKey, r: Relation): EntityKey[];
  getResource(res: Resource): ComponentValue | undefined;
  readEntity(key: EntityKey): EntityRecord | undefined; // derived bulk view (serialization only, §1.3)
}

// The baseline + the CRDT implement writes. Cell-addressed.
interface MutableSnapshot extends Snapshot {
  spawn(key: EntityKey): void;
  despawn(key: EntityKey): void; // THREE-PART contract — see §1.3
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

// ONLY the CRDT-backed snapshot implements this. The capabilities the baseline and JSON lack.
interface CRDTSnapshot extends MutableSnapshot {
  applyRemote(bytes: Uint8Array): ChangeBatch[]; // import remote bytes → one ChangeBatch PER COMMIT
  commit(body: () => void): void;                // seal a batch into ONE history entry (a SCOPE, §1.3)
  export(): Uint8Array;                          // serialize the converged doc
  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe; // one batch per local commit AND per remote commit
  undo(): void;
  redo(): void;
}
```

**Cells are canonical; `EntityRecord` is a view built from them, never the storage read out of them (direction rule, carried forward).** A `Snapshot` MAY *produce* an `EntityRecord` by **aggregating its cells** (`readEntity(key)` walks the entity's components/tags/relations and packs one record) — that direction is correct: cells are the source of truth, the record is a computed convenience for bulk export/import (§8 of the baseline) and debugging. The direction MUST NOT be reversed: an implementation MUST NOT store the baseline (or the CRDT projection) *as* whole-entity `EntityRecord` blobs and derive cell reads from them. Reconcile and commit operate at **cell granularity** (one `component-set`, one baseline cell compared, one Loro map key); a whole-entity representation would force every cell op to read-modify-write an entire blob, defeating the committer-wins-per-component model (§3, and Part III §13.4).

`EntityRecord` is specced as the **as-built §8 record shape** (`snapshot.ts:28-34`), name-keyed:

```ts
// The ladder's EntityRecord — name-keyed, EntityKey-targeted. Mirrors the shipped local-snapshot
// record (snapshot.ts:28-34), which is the same shape at K=number (id: number, numeric targets) and
// which — being the exempt local pass — keeps its numeric form.
interface EntityRecord {
  key: EntityKey;
  components: Record<ComponentName, ComponentValue>;               // name-keyed; values are the §7 wire form
  tags: TagName[];                                                 // names
  relations: Record<RelationName, EntityKey | EntityKey[]>;        // arity "one" → scalar; "many" → array (§8.1)
}
```

### 1.3 `CRDTSnapshot` — the batch boundary, commit-as-scope, three-part despawn

**The batch boundary is first-class (carried forward).** Both `subscribe` and `applyRemote` deliver a **`ChangeBatch`** — the doc-facts of *exactly one commit* — never a bare `ChangeEvent[]`:

```ts
interface ChangeBatch {
  origin: Origin;         // the WHOLE batch is one origin — a commit is either yours (local echo) or a peer's (remote)
  events: ChangeEvent[];  // the cell-level facts of THIS one commit (§1.4)
  commitId?: string;      // optional adapter-provided commit identity (logging / dedup)
}
```

A batch is **single-origin by construction**, and that is load-bearing beyond classification. It guarantees a same-frame own-echo and a remote fact **for the same cell** are always *separate* batches (different origins cannot merge into one `ChangeBatch`), so their relative order cannot corrupt the drag-protection compare (Part III §13.3): each is reconciled as its own batch, and the `(own,value)`/`(remote,value)` guards reach the same result regardless of drain order. Mixed-origin batches are **illegal**; the type makes them unrepresentable.

This matters because reconcile's baseline classification (Part III §13.3) depends on "one array = one commit": it normalizes a batch to the final fact per cell (§4) and classifies each against the *pre-commit* baseline. If two commits merged into one array, a later fact would classify against a baseline already advanced by the earlier commit; if one commit split across arrays, a multi-fact cell (`remove C` then `set C`) would be seen in pieces. Making `ChangeBatch` the unit — **one per `commit`, one per remote commit surfaced by `applyRemote`** — guarantees normalization sees each commit whole and nothing else. `applyRemote` returns an **array** because a single received byte-buffer may carry several remote commits; each becomes its own `ChangeBatch`, reconciled in order.

**`commit(body)` is a scope, not a bare call (carried forward).** The writes happen *inside* the callback; `commit` opens the batch, runs the body, seals on return. Two properties fall out, both load-bearing for Part III: the caller **cannot forget to seal** (no "write then maybe-commit" gap), and the batch is **pinned to this one document** (a single application-level commit can never fold writes from two documents into one history entry).

**`undo()`/`redo()` are local-ops-only (carried forward, 004 A5).** They MUST map to the CRDT's local-operation undo (Loro's `UndoManager`), **never** document checkout / time-travel — the classic collaborative-undo bug (undoing a peer's edit) is foreclosed here in one sentence.

**`despawn(key)` is a three-part contract, not a single record deletion (carried forward).** A cell-addressed baseline is tempting to build as forward-only maps (`key → its components/edges`), which leaves **dangling incoming references** after a despawn. So `despawn(key)` MUST:

1. remove the entity record for `key` (its components, tags, existence);
2. remove all **outgoing** relation cells **from** `key` (every edge `key --R--> *`);
3. remove all **incoming** references **to** `key` (every edge `* --R--> key`, in every relation index/cell).

Parts 2 and 3 are both-directions cleanup — the baseline analogue of the runtime's reverse-index cascade (Part I §5.5; `RuntimeStore.destroy` clears both directions inline at `runtime-store.ts:654`). Without part 3, a later reconcile could compare against a phantom edge pointing at a despawned key and think a deleted relation still exists (Part III §13.3). An implementation whose relation storage is forward-only MUST maintain a reverse index (or scan) to satisfy part 3. Conformance property **P2** (§8) tests exactly this: after a despawn, no incoming edge to the key survives anywhere.

The snapshot ladder covers the two cell-addressable collaborative representations (baseline, CRDT). The **ephemeral** store (Part IV) is the Part II citizen *outside* this ladder — per-key value blobs with coarse events, not cell-addressable — so it has its own lean `EphemeralSource` interface (defined with the ephemeral layer). Both the CRDT snapshot and the ephemeral source are Loro-backed and each quarantined behind one adapter class (`LoroSnapshot`, `LoroEphemeralSnapshot`), the only Loro-aware types anywhere — and **neither exists in Part II** (§9).

### 1.4 Doc-facts — the `ChangeEvent` vocabulary, in schema-object currency

`subscribe` and `applyRemote` emit **doc-facts**: pure statements about the converged document ("the doc now says cell X = V"), carrying an **origin** and **no apply/skip decision**. This is the boundary property of Part II: *the snapshot reports what the document now says; it does not decide what the runtime should do about it.* That policy lives upstream in the durable seam (Part III). The snapshot does not — and cannot — read the runtime.

Doc-facts carry **schema objects**, which the adapter has already resolved from the stored `.name` at its read boundary. This resolution is where the unknown-name policy attaches:

- **Local snapshot / baseline reads MUST throw on an unknown name** — exactly as §8 import does today (`snapshot.ts:109,121,134,160` each throw `"snapshot references unknown …"`). These are single-writer / same-schema paths; an unknown name is a corruption, not a version skew.
- **`applyRemote` unknown-name handling is a Part III policy (004 B3), not Part II's.** Part II requires only **detection** — the adapter MUST NOT surface a `ChangeEvent` bound to the wrong schema object, and MUST NOT silently misbind. Whether an unknown remote name is preserved-but-not-projected (B3 R1) is decided in Part III. Part II's contract is: *no event is ever emitted carrying a mis-resolved schema object.*

```ts
type Origin =
  | "local"  // the echo of our own transaction. For a VALUE the runtime already has it (applied
             //   synchronously at commit); for STRUCTURE this echo is how the runtime gets it
             //   (projection is the sole structural path). Either way reconcile applies it.
  | "remote"; // arrived via applyRemote. Structure applies unconditionally; a VALUE applies only if
              //   the cell isn't mid local-drag (cellEquals(runtime, baseline), §2), else held (Part III §13.3).

type ChangeEvent =
  | { kind: "spawn"; key: EntityKey; origin: Origin }
  | { kind: "despawn"; key: EntityKey; origin: Origin }
  | { kind: "component-set"; key: EntityKey; comp: Component; value: ComponentValue; origin: Origin }
    // NB: `component-set` is intentionally ambiguous — it may ADD a previously-absent component
    // (structural) or OVERWRITE a present one (value). The binding classifies it against the BASELINE
    // at reconcile (absent → structural add, present → value write, Part III §13.3); a raw CRDT
    // "map key changed" event cannot itself distinguish the two. `component-remove` is always structural.
  | { kind: "component-remove"; key: EntityKey; comp: Component; origin: Origin }
  | { kind: "tag-add"; key: EntityKey; tag: Tag; origin: Origin }
  | { kind: "tag-remove"; key: EntityKey; tag: Tag; origin: Origin }
  | { kind: "relation-set"; key: EntityKey; rel: Relation; target: EntityKey; origin: Origin }
  | { kind: "relation-add"; key: EntityKey; rel: Relation; target: EntityKey; origin: Origin }
  | { kind: "relation-remove"; key: EntityKey; rel: Relation; target?: EntityKey; origin: Origin }
  | { kind: "resource-set"; res: Resource; value: ComponentValue; origin: Origin }
  | { kind: "resource-remove"; res: Resource; origin: Origin };
```

The doc-fact vocabulary deliberately mirrors `MutableSnapshot`'s cell-addressed write methods. It is distinct from the **operation** vocabulary of Part III (`SpawnEntity`, `AddComponent`, `WriteComponent`, …): ops are *requests* carrying real handles (built by `tx.*`), doc-facts are *facts* carrying origin and fully-resolved keys. They describe the same cell-level changes from two sides — request and converged-result — but they are not the same type, and conflating them would blur the transaction/projection boundary.

---

## 2. Canonical values and cell equality (004 A1 / B4)

This is the ship-blocking bug the external review found (`design-comments.md` issue 1). It is normative and it precedes everything reconcile does.

### 2.1 The bug, stated once

Reconcile's entire conflict model rests on comparing `runtime(cell)` against `baseline(cell)` (Part III §13.3): equal ⇒ no drag in flight ⇒ apply the remote value; unequal ⇒ mid-drag ⇒ hold it off. But the two sides store values differently. The runtime **canonicalizes through typed arrays** — `Float32Array` frounds (`field.ts:255` keeps `eid` unsigned; f32 columns round on store), integer columns coerce, enums store discriminants — while a naive baseline holds the raw `ComponentValue` literal it was handed. Walk a remote `component-set` of `Position.x = 0.1`: the runtime stores `0.10000000149…`, the baseline advances to `0.1` exactly. The cell now reads `runtime != baseline` **with no edit in flight**, so every later remote value to that cell is dropped as "drag in flight," *permanently*, and the stranded-cell warning eventually fires on a cell nobody misused.

### 2.2 The rule: everything canonical, everywhere

Define, per component `C`:

```ts
// canon(C, v) = the value as it reads back through C's columns — decode ∘ encode.
// encode = encodeComponentValue (schema.ts:242) → per-field encodeField (field.ts:238)
// decode = the per-field decodeField (field.ts:306) that RuntimeStore.read already applies.
function canon(C: Component, v: ComponentValue): ComponentValue; // decode(C, encode(C, v))
```

- **MUST:** every value entering the document **or** the baseline is canonical. Transactions record canonical values; attach seeds canonical values into the baseline; reconcile canonicalizes an inbound value **before** it compares or writes. There is no path by which a raw literal reaches the baseline.
- **Cell equality is field-wise equality of canonical values:**

```ts
function scalarEquals(x: unknown, y: unknown): boolean {
  return x === y || (x !== x && y !== y); // NaN===NaN true (self-inequality trick); everything else is ===
}
function cellEquals(a: ComponentValue | undefined, b: ComponentValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;   // both-undefined equal; one-undefined not
  // for each field f of C: scalarEquals(a[f], b[f])
}
```

- **MUST:** replace every `runtime(cell) == baseline(cell)` in Part III §13.3/§13.4 with `cellEquals(...)`.

**Why `scalarEquals`, precisely.** `NaN` survives an f32 round-trip (`canon` produces `NaN` on both sides), but `NaN === NaN` is `false` — plain `===` would declare the cell forever-diverged and strand it. So `NaN` must compare equal to `NaN`; the `x !== x && y !== y` clause does exactly that. Conversely `Object.is` would distinguish `+0` from `−0` — but f32/f64 round-tripping and typical edits treat them as the same value, so `Object.is` would strand a cell that reconverged to `+0` against a baseline holding `−0`. `scalarEquals` is the unique choice that unifies `NaN` **and** collapses `±0`: `(x === y) || (x !== x && y !== y)`.

### 2.3 `canon` is total over well-formed values, partial over inbound — reconcile MUST NOT throw

`canon` is total over **well-formed** values (a complete, correctly-typed `ComponentValue`). It is **partial** over **inbound** values, which a buggy or malicious peer may malform. The shipped encoder throws on malformation: `encodeComponentValue` throws on a missing no-default field (`schema.ts:254`), `encodeField` throws on an unknown enum label (`field.ts:242`). Reconcile calling `canon` on such a value would throw mid-drain — unacceptable.

- **MUST:** reconcile **never throws** on an un-canonicalizable inbound value. It handles malformation per-field:
  - a field with a **declared default** (`FieldSpec.hasDefault`, `field.ts:57`) is **default-filled** — identical to what `encodeComponentValue` already does for local writes (`schema.ts:251`);
  - **any other malformation** (wrong JS type, non-finite where finite is required, a missing no-default field, an unknown enum discriminant) **rejects that single fact** — a per-cell quarantine, touching **neither** the runtime **nor** the baseline, with a DEV warning naming the offending key / component / field (mirrors Part III §13.5's quarantine counter).

**The rejection provably cannot strand the cell.** Reconcile's compare is `cellEquals(runtime, baseline)`. Rejecting a fact writes to neither side, so whatever relation held before still holds: if the cell was converged (`cellEquals` true) it stays converged; if it was mid-drag it stays mid-drag. No divergence is introduced, so the next *valid* fact for that cell reconciles normally. (Contrast a clamp-or-truncate policy, which would write a runtime value the peer never sent and *create* a phantom divergence.)

### 2.4 Range and representation: modular wrap, never clamp

A value that is well-typed but out of a column's range is **not** malformed — it is representable, and it MUST canonicalize **identically to a local write**, because inbound and local writes go through the same `encodeField`:

- **Integer columns: modular wrap (ToUint8/ToInt8/…), not truncation or clamping.** `300` into a `u8` column is `44` (`300 & 0xFF`), not `255`. This is what the typed array itself does on store, so it is what `canon` MUST produce. (004 B4's precision fix: "wrap," the ECMAScript `ToUintN`, not "truncate.")
- **`f32` columns: `Math.fround`.** The value the f32 array reads back.
- **`eid` fields: `u32 >>> 0`** (`field.ts:255`). But note §7: a **replicated** component MUST NOT contain `eid` fields at all — this rule exists only so `canon` is defined on the whole field taxonomy, not to bless `eid` on the wire.

There is **no separate inbound clamping policy.** Inbound and local writes canonicalize by the same function; the only inbound-specific behavior is the *reject* of §2.3 for genuinely malformed values.

### 2.5 Conformance properties

- `canon` is **idempotent**: `canon(C, canon(C, v))` field-wise-equals `canon(C, v)`.
- After any commit or attach, `cellEquals(runtime(cell), baseline(cell))` holds for **every non-diverged cell** (a cell not currently held off by a local drag). This is property **P1** (§8).

---

## 3. The layout contract: assignment unit = conflict unit (004 A2)

The external review's issue 2: §13.4's guarantee — committer-wins per *whole component*, no field merge — is only true if the CRDT stores each component value as **one atomic register**. If an implementer models a component as a nested map with per-field keys, the CRDT's per-key LWW merges "your `x` with their `y`," producing exactly the "position neither chose" the guarantee forbids. The document layout inside the CRDT is never specified in the baseline; this makes it normative.

### 3.1 Component value and resource value = one atomic register

- **MUST:** a component value is **one atomic register** — a plain `ComponentValue` object assigned **wholesale**. A resource value is likewise one atomic register.
- **MUST NOT:** decompose a component (or resource) value into **per-field container keys** (a nested map `{ x → …, y → … }`). Per-field keys would field-merge under LWW, breaking committer-wins-per-component.

This FORBIDDEN sentence is scoped **exactly to values.** It says nothing about how entities, tags, or edges are keyed — those are the opposite (§3.2).

### 3.2 Tags and relation edges = per-entry keys

- **MUST:** each **tag** is its own register (`tag:Name → true`), and each **relation edge** is its own register — **not** one tags-blob or edges-blob per entity.

**Why the opposite of §3.1.** A single "tags blob" register per entity would LWW-clobber concurrent adds of *different* tags: peer A adds `Selected`, peer B adds `Locked`, and one whole-blob write wins, silently dropping the other. Per-entry keys let both survive — `tag:Selected` and `tag:Locked` are independent registers, so concurrent adds of different tags **converge with both present.** An arity-"one" relation is one register (setting it *is* a replace, and last-writer-wins is the correct semantics for a single-valued edge); each arity-"many" edge is its own key.

### 3.3 Non-normative layout sketch

```
entity <key>:
  exists         : true                      // one register — entity existence is a cell (§4)
  comp:Position  : { x, y }                   // ONE atomic register — assigned wholesale (§3.1)
  comp:Label     : { text }                   // ONE atomic register
  tag:Selected   : true                       // per-entry key (§3.2)
  tag:Locked     : true                       // per-entry key
  rel:Parent     : <targetKey>                // arity "one" — one register
  rel:Children/<targetKeyA> : true            // arity "many" — one key PER edge
  rel:Children/<targetKeyB> : true
resource:Camera  : { x, y, zoom }             // ONE atomic register (§3.1)
```

### 3.4 Conformance

- Concurrent commits to **different fields of the same component** converge to **one committer's whole component value** on all peers (never a field merge). Property **P1** covers the runtime/baseline equivalence; the whole-value convergence is a Part III reconcile property tested against this layout.
- Concurrent adds of **different tags** to the same entity converge with **both tags present.**

---

## 4. `normalizeBatch` — the exported pure function (004 E / M1)

Reconcile classifies a `ChangeBatch` against the *pre-commit* baseline (Part III §13.3), which requires a **normalized** view: the final fact per cell, in a stable order. `normalizeBatch` is that normalization, factored out as a **pure, exported function** so it is unit-testable in isolation (table-driven tests) and reusable by Part III and the conformance suite.

```ts
export function normalizeBatch(events: readonly ChangeEvent[]): ChangeEvent[];
```

### 4.1 Cell taxonomy

Every fact addresses exactly one **cell**. The taxonomy (each is one cell):

- **entity existence** — one cell per `key` (spawn / despawn address it);
- **`(key, component)`** — one cell per component on the entity;
- **`(key, tag)`** — one cell per tag on the entity;
- **`(key, rel, target)`** for arity "many" (each edge is its own cell), or **`(key, rel, all)`** for arity "one" and for `relation-remove` with no target (the whole relation slot);
- **`(res)`** — one cell per resource.

### 4.2 Dominance and ordering (normative)

- **Despawn dominance:** `despawn(k)` **erases all earlier facts for `k`** in the batch. After normalization a batch that spawns, mutates, and then despawns `k` reduces to the single `despawn(k)` (plus incoming-edge removals implied by the three-part contract, which are their own cells on other keys).
- **Respawn:** a `spawn(k)` appearing **after** a `despawn(k)` begins a **fresh record** — facts before the despawn stay erased; facts after the spawn accumulate onto the new record.
- **Last-fact-wins per cell:** for a non-dominated cell, the **final** fact in the batch is the surviving one (a `remove C` then `set C` on the same cell normalizes to `set C`; the reverse to `remove C`).
- **Surviving facts preserve relative order.** Normalization removes dominated/superseded facts and MUST NOT reorder the survivors — their relative order is the batch's order.
- **Spawn-first / despawn-last invariants (carried from design §13.3):** within the normalized output, a `spawn(k)` orders before any other fact for `k`, and a `despawn(k)` orders after every surviving fact for `k`. This is what lets the projector apply a batch in one forward pass without a referenced entity being absent (spawn precedes its component-sets) or a despawn stranding a later write.

### 4.3 Acceptance oracle

`normalizeBatch` is correct iff applying its output to a `MutableSnapshot` yields the **identical** state as applying the raw `events` in order (idempotent facts fold, dominated facts vanish, order preserved). This is property **P5** (§8): `normalizeBatch ≡ raw apply`.

---

## 5. The projector kernel, against the as-built primitives (004 D6 / C1 / C2 / D7)

The projector is the one mechanism the durable and ephemeral layers share. Its job is narrow: **maintain the key↔handle bijection, and apply already-scheduled projection changes to the runtime.** It does **not** decide timing and owns no queue: the bindings call it only from `attach` (Part III §13.1) or from `sync()` (Part III §13.3, §16) — both **outside** any system iteration — so its writes apply **immediately** and never touch the command buffer (Part I §5.4). Everything hard (the baseline, the reconcile compare, sealing) lives in the durable wrapper, not here. Everything the ephemeral layer lacks (relations, the baseline) is simply never invoked. The kernel is policy-free.

### 5.1 The kernel owns both id-spaces; three operations by mint-policy (carried forward)

The projector maintains the bijection (`keyToHandle` / `handleToKey`) and owns **both** allocators — `runtime.allocateIdentity()` for handles (`runtime-store.ts:575`) and `mintKey()` for keys — so the only way to allocate is through an operation that also registers the pair. `bind` is private; there is no public "allocate but don't link."

```ts
class Projector {
  private keyToHandle = new Map<EntityKey, Entity>();
  private handleToKey = new Map<Entity, EntityKey>();

  constructor(
    private runtime: RuntimeStore,
    private mintKey: () => EntityKey, // kernel owns BOTH id-spaces (handles via runtime.allocateIdentity)
  ) {}

  private bind(key: EntityKey, handle: Entity) { // the ONLY place a pair is recorded
    this.keyToHandle.set(key, handle);
    this.handleToKey.set(handle, key);
  }

  /** PROJECTION: a remote/stored key arrived. Ensure it has a bound handle. Mints IDENTITY only
   *  (runtime.allocateIdentity — slot + generation, no placement, no key). Safe in any context (§5). */
  resolveByKey(key: EntityKey): Entity {
    let h = this.keyToHandle.get(key);
    if (h === undefined) { h = this.runtime.allocateIdentity(); this.bind(key, h); }
    return h;
  }

  /** LOCAL SPAWN into a store (tx.spawn / eph.spawn): a fresh handle exists; mint a key, bind the pair. */
  createPair(handle: Entity): EntityKey {
    if (this.handleToKey.has(handle)) throw new Error("handle already has a key");
    const key = this.mintKey();
    this.bind(key, handle);
    return key;
  }

  /** REFERENCING an existing store entity (tx.addComponent(rect, …) → keyOf): the handle MUST already
   *  belong to this store. No mint — a missing key means a runtime-only (or other-store) entity. THROWS. */
  requireKey(handle: Entity): EntityKey {
    const key = this.handleToKey.get(handle);
    if (key === undefined) throw new Error("op references an entity not in this store");
    return key;
  }
}
```

**Why three and not two.** The "two directions" framing (create-from-key, create-from-handle) would miss the third. `tx.addComponent(e, …)` where `e` is a handle from a plain `world.spawn()` — a runtime-only entity with no key — must **throw**, not silently mint a key and promote a runtime-only entity into document content. So `resolveByKey` (resolve-or-create), `createPair` (mint-a-key), and `requireKey` (resolve-or-throw) encode three distinct mint intents; merging any two loses a real failure mode. Property **P3** (§8) tests that `requireKey` throws exactly for unbound handles under random interleavings.

`allocateIdentity` mints **identity only** — slot + generation, no archetype placement (`runtime-store.ts:575`). The projector never *places*; placement happens through the cell-apply methods below, whose timing the caller supplies. This keeps the kernel policy-free: it owns identity and the bijection; it owns no placement-timing decision.

### 5.2 Cell application — typed on schema objects, over the real primitives

The kernel applies values the wrapper has already decided to apply (it never consults a baseline) and removes entities. Each method routes through a shipped `RuntimeStore` primitive:

```ts
// All apply IMMEDIATELY — projection only ever runs OUTSIDE iteration (attach between frames,
// Part III §13.1; inbound during world.sync(), §13.3/§16), so no column walk is ever in progress
// and projection never touches the command buffer (Part I §5.4).

applyComponent<S>(key: EntityKey, c: Component<S>, v: S): void {
  this.runtime.projectComponent(this.resolveByKey(key), c, v); // add-if-absent(→place)-else-write — runtime-store.ts:742
}
removeComponent(key: EntityKey, c: Component): void {
  this.runtime.projectRemoveComponent(this.resolveByKey(key), c); // remove-if-present, else no-op — runtime-store.ts:762
}
applySpawn(key: EntityKey): void {
  this.runtime.ensurePlaced(this.resolveByKey(key)); // place into empty archetype now — runtime-store.ts:584
}
applyTag(key: EntityKey, t: Tag): void {
  const h = this.resolveByKey(key); this.runtime.ensurePlaced(h); this.runtime.addTag(h, t); // :821
}
removeTag(key: EntityKey, t: Tag): void {
  this.runtime.removeTag(this.resolveByKey(key), t); // :830
}
applyRelationSet(key: EntityKey, r: Relation, tk: EntityKey): void { // arity "one"
  const h = this.resolveByKey(key); this.runtime.ensurePlaced(h);    // a relation makes key live + queryable
  this.runtime.setRelation(h, r, this.resolveByKey(tk));             // :853
}
applyRelationAdd(key: EntityKey, r: Relation, tk: EntityKey): void { // arity "many"
  const h = this.resolveByKey(key); this.runtime.ensurePlaced(h);
  this.runtime.addRelation(h, r, this.resolveByKey(tk));             // :865
}
removeRelation(key: EntityKey, r: Relation, tk?: EntityKey): void {
  this.runtime.removeRelation(this.resolveByKey(key), r, tk ? this.resolveByKey(tk) : undefined); // :877
}
remove(key: EntityKey): void { // entity despawn — reverse-index cascade is inline in runtime.destroy (§5.5, :639)
  const oldHandle = this.keyToHandle.get(key);
  if (oldHandle !== undefined) {
    // ORDER: runtime.destroy bumps the slot's generation, so the PACKED Entity that handleToKey was
    // stored under is `oldHandle` (pre-bump). Capture it, destroy, then delete BOTH directions using
    // the captured handle — never re-read after destroy, when its generation no longer matches.
    this.runtime.destroy(oldHandle);
    this.keyToHandle.delete(key);
    this.handleToKey.delete(oldHandle);
  }
}
```

Three primitive facts anchor these (verified against `runtime-store.ts`):

- `ensurePlaced(h)` is **idempotent** (`:584`): it places an identity-only handle into the **empty archetype** and no-ops if already placed. This is why a projected `spawn` doc-fact — which carries no components — still yields a **queryable** entity (Part I §5.2 Option A); later component doc-facts migrate it onward. `projectComponent` folds placement in for the common case (first component both places and fills its cell in one migration, `:745`); `ensurePlaced` covers the componentless and tag-first cases.
- `projectComponent` (`:742`) is **add-if-absent-else-write** across three branches (identity-only place, present-overwrite, migrate-add) — distinct from the systems-surface `edit().set`, which *throws* on an absent component.
- The kernel has **both** an additive side (attach is all-creation) **and** a removal side (`projectRemoveComponent`/`removeTag`/`removeRelation`/`remove`) — steady-state reconcile applies remote *and* own structural removals, not just additions.

Relation application takes the **target's** key, which may not have a handle yet; `resolveByKey(tk)` mints identity for it. The wrapper's two-phase projection (and reconcile) calls relation application only after referenced entities exist; the ephemeral layer (no relations) never calls it. Ordering is the wrapper's concern — the kernel just resolves identity and writes.

Under the transaction model, **a commit's structural effects reach the runtime through this same projection path**: the executor writes only the document + baseline, and the structural doc-facts it produces are projected here — so the kernel's apply/remove ops are the single point structure enters the runtime (own-origin and remote alike). A commit's **value** writes to existing entities are the one thing the executor applies to the runtime **directly** (`runtime.writeComponent`, `:722`), bypassing the kernel because it already holds the handle.

### 5.3 Reactivity is free — projection routes only through the stamped primitives (004 C1)

**MUST:** projection routes **only** through the stamped primitives listed above; raw-column projection is **forbidden**. (A future bulk-attach fast path may exist only if it stamps equivalently.)

Every primitive the projector calls already carries the 002/003 reactivity stamp, behind the `reactiveOn` gate (verified as-built):

| Primitive | Stamp site (`runtime-store.ts`) |
|---|---|
| `allocateIdentity` | fires `onSpawn` to WorldObservers (`:579`) |
| `place` / `unplace` (via `ensurePlaced`, `projectComponent`, migrate) | `A.lastStructuralFrame = frameCounter` (`:491`, `:514`) |
| `projectComponent` | `stampComponent` in all three branches (`:747`, `:754`, and migrate `:551`) |
| `projectRemoveComponent` → `removeComponent` → `migrate` | migrate stamps + `lastStructuralFrame` bump |
| `addTag`/`removeTag`/`setRelation`/`addRelation`/`removeRelation` | `bumpTagRel()` (`:826`, `:834`, `:861`, `:873`, `:881`) |
| `destroy` | `emitDestroy` (`:647`), `reactiveDeathHook` (`:650`), `bumpTagRel` (`:656`) |
| `writeComponent` (executor's direct value path) | `stampComponent` (`:734`) |
| `setResource` / `removeResource` (§6) | `bumpResource` (`:924` / §6) |

**Consequence, stated as a guarantee:** a change applied by reconcile — a remote edit, an own-echo, an attach, an undo — is **visible at the next `reactive.notify()` with zero additional wiring.** `observeQuery`/`observeEntity`/`observeValue` and `strata-ecs/react`'s `useComponent`/`useResource` light up on collaborative change for free (002 §2.2 already anticipated this: "so the future durable/ephemeral feeds aren't silently dark"). This **obsoletes** 002 §0/§6's "local-runtime only / remote feeds deferred" language — the feeds are not a future wiring job; they fall out of construction. Attaching a store does **not** flip `reactiveOn` (a collaborative world with no observers pays zero stamp stores; the gate flips only on first `world.reactive` access, `world.ts:54`). Property **P6** (§8) extends `stamps.test.ts` to prove every projector apply is visible at the next notify.

### 5.4 `onSpawn` fires at identity, for projected entities

A projected entity's `onSpawn` (the T0 `WorldObserver` hook) fires inside `allocateIdentity` (`:579`), **while the entity is still identity-only** (not yet placed). This **matches `ctx.spawn`** (which allocates identity eagerly and fires once, deferring placement) and **diverges from `world.spawn`** (which places first, then fires, `:634`).

- **Normative consequence:** `WorldObserver` consumers MUST tolerate an identity-only entity in `onSpawn` — `store.get(e, c)` returns `undefined`, `store.isPlaced(e)` is `false` — until subsequent component doc-facts migrate it. This is not a bug to fix; it is the eager-identity contract. A tools panel that assumes a placed entity in `onSpawn` is wrong for both `ctx.spawn` and projection.

### 5.5 In-emit guards are MIXED by design; the reliable guard is a drain-entry assert (004 C2)

The per-primitive observer-emit guards **do not uniformly cover** the projection primitives, and this is deliberate — `projectComponent`/`ensurePlaced` **must** run mid-drain, so they cannot be guarded. Verified against the code:

- **Unguarded** (no `rejectMutationInEmit`): `projectComponent` (`:742`), `writeComponent` (`:722`), `ensurePlaced` (`:584`), `allocateIdentity` (`:575`). These **land** even inside an observer emit.
- **Reject-and-skip** (`rejectMutationInEmit`, or `destroy`'s inline guard): `removeComponent` (`:712`, so `projectRemoveComponent` too), `addTag` (`:822`), `removeTag` (`:831`), `setRelation` (`:854`), `addRelation` (`:866`), `removeRelation` (`:878`), `destroy` (`:640`). These are **silently swallowed** inside an emit.

So a drain that ran mid-notify would **half-apply a batch**: adds/writes land, removes/structural vanish — batch atomicity violated in the worst possible way (a `despawn` swallowed while its component-sets applied). Per-primitive guards cannot fix this without breaking legitimate mid-drain projection.

- **MUST:** `drain()` DEV-asserts `!inObserverEmit` **at entry** (one check per drain, reading the store's existing `inObserverEmit` flag, `:243`). Reconcile/drain MUST NOT run inside `notify()`.
- **MUST:** `world.sync()` throws when called mid-tick — riding the `iterationDepth` guard specified in 006 (the mid-tick guard on the World facade, 004 A4). One settled boundary per frame: `sync() → tick(s) → notify() (exactly once) → render` (006 §16.4).
- **SHOULD:** extend the `setResource`-in-emit devWarn (`:908`) to `writeComponent` (a value write from inside a reactive callback stamps the current frame — already seen by every watch this pass — so it is silently unobservable; diagnose loudly).

Batch atomicity and poll-at-boundary compose: observers can never see a half-applied `ChangeBatch`, and **no "suppress observers during drain" mechanism exists or is needed** — the drain simply never runs inside a notify.

### 5.6 Teardown is FOUR steps (004 D7)

A binding holds a pending inbound queue (Part III §12.4) that `sync()` drains. If teardown despawned entities and dropped the bijection while a queued-but-undrained `ChangeBatch` or ephemeral event still pointed at this binding, a later `drain()` would project into a torn-down binding (writing through a dead projector / resolving keys that no longer bind). So teardown does, **in order**:

```ts
teardown() {
  // 0. World.unregisterInboundSource(this)  — NEW (§6): stop world.sync() from ever draining us again.
  // 1. unsubscribe from the document / EphemeralStore — stop new doc-facts from arriving.
  // 2. clear the binding's pending inbound queue — discard any queued-but-undrained batches/events.
  // 3. despawn all projected entities (this.remove per key) and clear the bijection.
}
```

Step 0 is new. The shipped registration is `World.registerInboundSource` (`world.ts:254`); the design.md teardown began at "unsubscribe" and cited no symmetric removal, so a torn-down binding would remain in `World.inbound` (`world.ts:28`) and `world.sync()` would call `drain()` on it forever. §6 specs the symmetric `World.unregisterInboundSource`; teardown MUST call it first. Steps 1–3 are carried forward unchanged: unsubscribe-and-clear before despawn guarantees no drain runs against a half-torn-down binding.

---

## 6. Runtime additions (004 D4 / D7)

Two methods the reconcile path needs that Part I did not ship. Both are small, both mirror an existing sibling exactly.

### 6.1 `removeResource` — closing the reconcile dead-end

`MutableSnapshot` (§1.2) and the `resource-remove` doc-fact (§1.4) both require removing a resource, but the runtime has only `setResource` (`:903`) and `getResource` (`:927`) — projecting a `resource-remove` had nowhere to land. Add it to `RuntimeStore`, and expose it on `World` and `ECSStore` for symmetry:

```ts
// RuntimeStore.removeResource — mirrors setResource (:903). The resource map is `resources: Map<ResourceId, …>` (:72).
removeResource<S>(res: Resource<S>): void {
  if (DEV && this.inObserverEmit) {
    // Mirrors setResource's in-emit devWarn (:904): a remove from inside a reactive callback stamps the
    // current frame, already seen this pass, so it would be silently unobservable — diagnose, schedule instead.
    devWarn(`removeResource("${res.name}") from inside a reactive callback ... (002 §6).`);
  }
  if (this.resources.delete(res.id)) this.bumpResource(res.id); // stamp ONLY if it was present (:345 bumpResource)
}
```

- **Stamps via `bumpResource`** behind the `reactiveOn` gate — a removal changes what `observeResource`/`useResource` should see, so it must stamp exactly like `setResource`.
- **Removing an ABSENT resource is a stampless no-op** (`Map.delete` returns `false` → no `bumpResource`). This makes projection **idempotent**: replaying a `resource-remove` for a resource already gone changes nothing and notifies no one. (Projection idempotence is property **P7**, §8.)
- Exposed on `World.removeResource` (delegates, like `world.ts:152`'s `setResource`) and added to the `ECSStore` contract (`ecs-store.ts:56`, alongside `setResource`/`getResource`).

### 6.2 `unregisterInboundSource` — the symmetric teardown seam

`World` ships `registerInboundSource` (`world.ts:254`) but no removal, which §5.6 step 0 needs:

```ts
// World.unregisterInboundSource — the symmetric removal (the shipped registration is world.ts:254).
unregisterInboundSource(source: InboundSource): void {
  const i = this.inbound.indexOf(source); // this.inbound: InboundSource[] (world.ts:28)
  if (i !== -1) this.inbound.splice(i, 1);
}
```

After removal, `world.sync()` (`world.ts:249`, iterating `this.inbound`) never drains the torn-down binding again.

---

## 7. `ComponentValue` — the wire form (004 D5)

`ComponentValue` is exactly what `RuntimeStore.read`/`writeComponent`/`projectComponent` exchange: the **decoded, field-name-keyed** object, with **enum labels** (not discriminants) and real strings.

```ts
type ComponentValue = Record<string, unknown>; // { fieldName: value } — the S in Component<S>
```

- Numbers for numeric fields; booleans for `bool`; **enum label strings** (`decodeField` maps discriminant → label, `field.ts:307`); plain strings for `string`; **`EntityKey` strings for `key` fields** (`field.ts:314`, storage-identical to `string`, the brand lives only at the type surface).
- **MUST NOT: a component replicated by the durable OR ephemeral layer contains `eid` fields.** An `eid` is a packed runtime handle (`u32`) — meaningless across sessions and un-remappable at the ladder boundary. Entity references on the wire use **`key` fields** (`EntityKey`), which the projector resolves through the bijection. Both attaches (durable and ephemeral) **MUST validate at registration and throw in DEV** if a replicated component declares any `eid` field (scan `component.fields` for `spec.type === "eid"`, `field.ts:22`). This kills the "remap handles at the boundary" problem class outright — there are no handles on the wire to remap.
- `projectComponent` applies `encodeComponentValue`'s validation to projected values (`runtime-store.ts:744` → `schema.ts:242`). A malformed projected value would throw there — but by §2.3 the wrapper's `canon` gate has already rejected any un-canonicalizable inbound fact **before** it reaches the projector, so a throw inside `projectComponent` during reconcile is a wrapper bug, not an expected path. (The projector assumes canonical, well-formed values; the durable seam's canon reject is what guarantees it.)

`ComponentValue` is also the type of a resource value on the wire (resources are field-shaped like components, `schema.ts:66`) and the value carried by `component-set` / `resource-set` doc-facts (§1.4).

---

## 8. The conformance suite (004 E / M4) — gating Part III

The spec is invariant-dense; the external review's closing recommendation was a companion conformance suite, because many invariants are directly property-testable and that is the only way a spec this size stays true through implementation. The suite is a **shared op interpreter**: a random op sequence is applied both to the store-under-test **through the ladder** and to a `RuntimeStore` **oracle** (via a `key ↔ handle` map), and the two are compared.

Written **generically over `MutableSnapshot`/`CRDTSnapshot`** so that `LoroSnapshot` runs the **identical** suite on day one of Part III — the suite is the acceptance gate for the Loro adapter, not just the in-memory baseline.

| # | Property | What it asserts |
|---|---|---|
| **P1** | Ladder–runtime cell equivalence | After every op, `cellEquals(ladder.getComponent(k,c), oracle.read(h,c))` for every cell (and tags/relations/resources correspondingly). The canonical-value law (§2) holds end-to-end. |
| **P2** | Despawn completeness | After `despawn(k)`, **no incoming edge to `k` survives anywhere** — the three-part contract (§1.3), tested by scanning every relation index/cell on every other key. |
| **P3** | Projector bijection under interleavings | Under random interleavings of `resolveByKey`/`createPair`/`requireKey`/`remove`, the two maps stay in lockstep and `requireKey` **throws exactly for unbound handles** (never for bound ones, always for unbound). |
| **P4** | `export → import` identity | `import(export())` reproduces the document **up to handle renaming**, including **dangling `eid`/`key`** references (a dangling reference round-trips as dangling, per `snapshot.ts:67`/`:153`, not as a crash). |
| **P5** | `normalizeBatch ≡ raw apply` | Applying `normalizeBatch(events)` yields the identical `MutableSnapshot` state as applying `events` in order (§4.3). |
| **P6** | Projection visible at next notify | Every projector apply is observable at the next `reactive.notify()` — extends `stamps.test.ts` to the projection path, proving §5.3's guarantee. |
| **P7** | Projection idempotence | Re-applying an already-applied fact (own-echo replay, duplicate remote, absent-resource remove) changes neither runtime nor baseline and notifies no one. |

**Generators:** bounded — ≤ 64 entities, ≤ 200 ops per sequence, with **fixed seeds in CI** (deterministic, fast) plus a **nightly randomized** run over a wider seed space. Bounds keep the interpreter's oracle comparison cheap enough to run on every commit; the nightly widens coverage without gating merges.

---

## 9. The Part II build plan (M1–M4; Loro deferred to Part III)

M0 (spec revision) **is this note** together with 006. The remaining milestones:

- **M1 — pure types + one pure function.** `Snapshot`/`MutableSnapshot`/`CRDTSnapshot`, `ChangeBatch`/`ChangeEvent`/`Origin` (schema-object currency, §1), and `normalizeBatch` (§4) as an exported pure function with table-driven tests (cell taxonomy, dominance, order preservation). Acceptance: **P5**.
- **M2 — the baseline.** The in-memory `MutableSnapshot`: nested `Map`s keyed by `EntityKey`, a **reverse relation index** satisfying the three-part despawn contract (§1.3), name-keyed cells (§1.2), and **canonical values (§2) enforced at every write** (the seal writes `canon(C, v)`, never a raw literal). Acceptance: **P1**, **P2**.
- **M3 — the projector + runtime additions.** The `Projector` class over the existing primitives (bijection, `resolveByKey`/`createPair`/`requireKey`, the cell-apply methods, four-step teardown, §5); `removeResource` (§6.1); `unregisterInboundSource` (§6.2); the drain-entry `!inObserverEmit` assert and the mid-tick `sync()` throw (§5.5, riding 006's iteration guard). Bench gate: the new DEV checks ride the existing suite; a per-structural-op check must not regress the migrate-heavy benchmarks (the `reactiveOn` lesson, 002 §2.2). Acceptance: **P3**, **P6**, **P7**.
- **M4 — the conformance suite (§8), gating Part III.** The shared op interpreter with `RuntimeStore` as oracle; P1–P7; written generically so `LoroSnapshot` runs it unchanged.

**Scope cut (normative):** **no `loro-crdt` dependency lands in Part II.** No `CRDTSnapshot`, no `LoroSnapshot`, no `LoroEphemeralSnapshot`, no ephemeral `EphemeralSource` implementation. `CRDTSnapshot` exists in Part II only as the **frozen interface** (§1.3) that Part III codes against. `LoroSnapshot` is **Part III M0**, written against that frozen interface plus the M4 suite — so the day the Loro adapter lands, the acceptance test already exists.

---

---

## 10. As-built amendments (2026-07-03, normative)

The implementation (M1–M4 + the adversarial review pass, commits a71e104/9aae91b/81863bc/3b665af) settled seven points this note either left open or got wrong. Each is normative and supersedes the section it names.

### 10.1 Resources are object-backed: `canonResource`, not `canon` (amends §2, §8 P1)

`RuntimeStore.setResource` stores the defaults-filled **raw value object** wholesale — there is **no typed-array round-trip** for resources, so a resource's canonical form (§2.2's "as it reads back") is **defaults-filled raw, with NO fround/wrap**. Applying column coercion to a resource would strand every float resource cell against the raw runtime value — the §2.1 bug inverted. Shipped as `canonResource` (trusted writes, throws on malformation) and **`tryCanonResource`** (the §2.3 inbound gate for `resource-set` facts: default-fills, per-field JS-type-validates, rejects — never throws, never coerces). **§8 P1's row is amended:** components compare under `canon`; resources under `canonResource`; the existence cell is asserted too.

### 10.2 Spawn is existence-only; fresh-record comes ONLY from the despawn barrier (amends §4.1/§4.2)

A `spawn(k)` addresses the existence cell and **nothing else** — `BaselineSnapshot.spawn` clears no components/tags/edges (erasure power belongs to `despawn` alone, per §4.1's own cell independence), matching `Projector.applySpawn` (= idempotent `ensurePlaced`). The review found the ladder had shipped respawn-fresh spawn — a both-sides-consistent divergence from the projector that the conformance generators had been fenced around; it is fixed and the fence is deleted (spawn-on-live is fuzzed, duplicate spawn is in the P7 replay set). In `normalizeBatch`, **duplicate spawns dedupe FIRST-spawn-wins per despawn-segment** (a later duplicate is dropped — last-wins would violate the spawn-first invariant; a surviving despawn resets the segment so a respawn survives). Respawn-fresh semantics arise exclusively from the despawn barrier.

### 10.3 A TARGETED relation-remove is a per-edge conditional fact in BOTH arities (amends §4.1)

§4.1's original taxonomy ("(key, rel, all) for arity one") was wrong for targeted removes: a targeted remove is **conditional on the current edge** (it removes only the matching target — it cannot LWW-collapse with `relation-set` without changing state). A normalized batch may therefore carry a `relation-set` **and** a targeted `relation-remove` for one arity-one slot, in order. Only the **target-less** remove addresses the whole slot cell. Pinned in normalize.test.ts.

### 10.4 Cell keys are injection-proof (amends §4)

`EntityKey`s are peer-controlled (§2.3's own threat model), so `normalizeBatch`'s cell identities must not be string-joins a hostile key can collide (verified collision with separator-bearing keys). Shipped: JSON-tuple cell keys (3-tuple slot vs 4-tuple edge — which also retires the `"*"` sentinel); the conformance key pool includes hostile keys.

### 10.5 spawn-first/despawn-last are scoped to well-formed producer batches (amends §4.2)

Order preservation and despawn-last genuinely conflict for an ill-formed batch (`[despawn k, component-set k]` with no respawn). The shipped resolution: **order preservation + the despawn barrier win**; the spawn-first/despawn-last invariants hold for well-formed producer batches (the adapter's obligation). Part III's projector loop MUST tolerate facts after a despawn (the current kernel already does).

### 10.6 The guard set is wider than §A4's list (amends §5.5; 006 §A4)

Beyond the structural `world.*` methods: **`world.tick()`** throws on `iterationDepth > 0` and on re-entrant tick (all builds — a mid-walk phase flush is the exact corruption §A4 exists to prevent; re-entrancy also broke the outer tick's `ticking` flag), and DEV-throws inside an observer/reactive emit; **`world.import()`** DEV-throws inside an emit (a mid-emit load half-applies: the mixed per-primitive guards swallow relation edges). `world.sync()` iterates a **snapshot** of the inbound list (a source tearing itself down mid-drain no longer skips its sibling's drain). The §5.5 drain-entry assert obligation is recorded on `InboundSource.drain`'s JSDoc — `world.sync()`'s check is the sync-path defense, not a substitute for Part III's own drain-entry assert.

### 10.7 P7's notify-silence is scoped; Tier-1 may over-fire on duplicate structural re-applies (amends §8 P7)

`addTag`/`setRelation`/`addRelation` bump the coarse global tag/relation version **unconditionally** as-built (002 §4.2's cheap membership signal), so a duplicate structural re-apply is state-idempotent on both sides but may re-fire a Tier-1 query — permitted by 002's "may over-fire, never miss" contract. P7 asserts state-idempotence for every duplicate fact, and notify-silence on the equality-suppressed (Tier-3/resource) and genuinely stampless channels. Part III's reconcile should expect the Tier-1 over-fire on structural own-echo re-applies and not treat it as a bug.

### 10.8 Adapter-level store-support surface (added by Part III M1; NOT on the frozen `CRDTSnapshot`)

`CRDTSnapshot` stays frozen as §1.2 defines it. The concrete `LoroSnapshot` additionally exposes an
adapter-level surface its owning `DurableStore` needs (bd665d2): `peerIdStr`, `entityKeysRaw()` (the
key-mint counter-resume scan), `resourceNamesRaw()` (the attach-time resource-seeding enumerator —
the frozen `Snapshot` deliberately has none), `version()` + `exportUpdatesSince(from)` (per-commit outbound
increments — an increment presupposes the receiver holds the causal base; a fresh receiver importing
one takes a **pending** import and quarantines, so joiners bootstrap from a snapshot first), and a
third reserved **`meta` root map** (`readMeta`/`ensureMeta` — holds `docId`; writes are tagged
`META_ORIGIN` and excluded from the UndoManager so bookkeeping is never an undo step; meta paths are
invisible to the batch translation). A future non-Loro adapter must ship equivalents; Part III's
store is written against this adapter-level contract, not raw loro.

---

*Sources: `004-part2-4-revision.md` (post-red-team, settled) §§A1–A2, B4, C1–C4, D1–D7, E; as-built `src/core/{field,schema,ecs-store,runtime-store,world,snapshot}.ts`; `002-reactivity.md`; `design-comments.md` (the external review driving issues 1–2). This note is the normative Part II; `design.md` §9–§10 + the Part II API reference are superseded per §0. §10's amendments were settled by the Part II adversarial review (17-agent workflow, findings verified with executed repros).*

# strata-ecs: A Collaborative ECS Framework in TypeScript

> **Amendments (non-normative front-matter — this document is the locked v0 baseline; its §
> numbering never changes).** The following notes supersede or extend it; where they conflict,
> the note wins. Read `docs/README.md` for the one-line map.
>
> - **001** system access declaration · **002** reactivity (`world.reactive`, stamps) · **003**
>   resource reactivity + `strata-ecs/react` — Part I additions, all IMPLEMENTED.
> - **review-part1** — the adversarially-verified Part I review (post-verification severities;
>   includes the claims that were refuted, recorded so they are not relitigated).
> - **004** — the Parts II–IV revision plan (adjudicates `design-comments.md`).
> - **005** — the normative Part II spec; **supersedes §9–§10 + the Part II API reference**.
> - **006** — normative Parts III–IV amendments (with two Part I addenda: the mid-tick guard
>   and the 002 §0/§6 rewording). New sections it introduces relative to this baseline:
>   §13.6 (text forward path), §13.7 (foreign schema), §14.4 (ordering), §15.7 (sync-status
>   resources), §16.4 (frame reactive boundary), §21 (v1 scope table).
> - Part I API drift vs this baseline (all deliberate, per review-part1): `defineComponent`
>   infers from the schema literal; `readEid` is deleted (subsumed by typed `readField`);
>   `defineRelation` has no `ordered` option (006 §B1's order-key pattern replaces it);
>   `world.reset()` + `world.import(bytes, {replace: true})` exist; the published package is
>   **`strata-ecs`** (the bare-`strata` name in code samples below reflects the baseline era).

**strata-ecs** is an ECS substrate aimed at **editors and infinite-canvas apps** (think Figma/Google-Docs-like documents), not games. The name is the architecture: a stack of **strata** differentiated by how fast they change and how long they last — a volatile runtime on top, a collaborative document and live presence layered underneath it, with data projecting up and down between them across a precisely-specified seam.

The framework is built in **four architectural parts** (below), followed by a fifth **reference section** (Part V — cross-cutting concerns, a worked example, build order, and the API at a glance). The four parts are meant to be read — and adopted — in order of increasing commitment:

- **Part I — The Runtime Core.** A complete, performant ECS in TypeScript: typed-array columns iterated with no per-row object allocation in the hot loop, first-class components/tags/relations, generational-index identity, a schema API, a **mutation layer** (the shape/value rule and the deferred command buffer), a query engine, a value-driven tick pipeline, and non-collaborative save/load. This part is a usable product on its own. If you want a fast local ECS and nothing else, you can stop after Part I.
- **Part II — The Storage Substrate.** The shared foundation the optional layers stand on: a **snapshot interface** unifying the three map-shaped representations of a document (JSON, in-memory baseline, CRDT), a lean **`EphemeralSource`** interface for the LWW/TTL ephemeral store, and a policy-free **projector kernel** that maps document keys to runtime entities. Medium-agnostic and behavior-free — it is the vocabulary Parts III and IV are written in, and it is where Loro is quarantined (two adapter classes, nothing else).
- **Part III — The Durable Layer.** Opt-in collaborative persistence and sync over a Loro CRDT: a document you commit to at explicit boundaries, projected into the runtime as live entities, with a lagging baseline that makes concurrent editing tractable. Built entirely on Part II.
- **Part IV — The Ephemeral Layer.** A writable **ephemeral entity store** over Loro's EphemeralStore — the same *flat entity* mutation vocabulary as Part III (spawn/despawn, add/remove component, value writes, tags), **minus relations and resources**, and transient (never persisted, never undoable, TTL'd) and **partitioned by writer** so it needs no conflict machinery. Presence (cursors, selections) is the common use, not the definition. A sibling of the durable layer, not a stripped-down child.

The guiding principle throughout: **the runtime is built for query speed — typed-array columns iterated with no per-row object allocation in the hot loop. Durability and sync are a separate concern, carried by the layers in Parts III–IV, which project to and from the runtime at explicit boundaries; nothing in the hot path pays for them.**

---

## 0. Layered overview

```
┌─────────────────────────────────────────────────────────────────┐
│ SYSTEMS (user code: queries + mutations, run every tick) │
│ iterate typed-array columns · no per-row alloc · monomorphic │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ read │ write
┌───────────────┴───────────────────────────────▼──────────────────┐
│ PART I — RUNTIME CORE │
│ ┌─────────────┐ ┌──────────┐ ┌─────────────┐ ┌────────────────┐ │
│ │ Archetypes │ │ Tag │ │ Relation │ │ Entity table │ │
│ │ (SoA typed │ │ bitsets │ │ indices │ │ (generational │ │
│ │ columns) │ │ │ │ (fwd+rev) │ │ index alloc) │ │
│ └─────────────┘ └──────────┘ └─────────────┘ └────────────────┘ │
│ Shared: Symbol Registry + per-cell strings · Local Snapshot │
│ Knows NOTHING of: keys, baselines, CRDTs, presence │
└──▲──────────────────────────────────────────────────────▲────────┘
   │ the core depends only on a thin InboundSource interface │
   │ (drain() at sync). It never names DurableTarget or the │
   │ layers. Transactions are called on the durable store. │
┌──┴──────────────────────────────────────────────────────────────┐
│ PART II — STORAGE SUBSTRATE │
│ Snapshot ladder: Snapshot → MutableSnapshot → CRDTSnapshot │
│ Projector kernel: key↔handle bijection, three mint-policy ops │
│ Medium-agnostic, policy-free. The vocabulary the layers share. │
└──▲───────────────────────────────────────────────▲───────────────┘
   │ built on │ built on
┌──┴──────────────────────────┐ ┌────────────────┴───────────────┐
│ PART III — DURABLE LAYER │ │ PART IV — EPHEMERAL LAYER │
│ document content │ │ transient shared state │
│ • binding = the seam │ │ • same projector kernel │
│ (holds runtime+baseline) │ │ • NO baseline, NO reconcile │
│ • transaction (a CALL) │ │ • NO relations, single-phase │
│ • projection (EVENTS) │ │ • writer-partitioned, LWW │
│ • lagging baseline │ │ • eager throttled outbound │
│ • committed, persisted, │ │ • Loro events → spawn/despawn│
│ undoable │ │ • never persisted/undoable │
│ owns one Loro doc │ │ owns one Loro EphemeralStore │
└──▲───────────────────────────┘ └────────────────▲───────────────┘
   │ LoroSnapshot (quarantines the │ LoroEphemeralSnapshot (quarantines
   │ Loro doc API) │ the Loro EphemeralStore API)
   ▼ ▼
┌──────────────────────┐ ┌──────────────────────┐
│ LORO DOC │ │ LORO EPHEMERAL │
│ (CRDT; sync+history)│ │ (LWW; TTL) │
└──────────────────────┘ └──────────────────────┘
```

**How to read this.** A user writing a system only ever touches the Runtime Core (Part I). The Storage Substrate (Part II) is internal plumbing — you rarely name it directly, but it is the reason Parts III and IV are small and share so much. The Durable layer (Part III) is the collaborative persistence/sync path; the Ephemeral layer (Part IV) carries transient shared state (presence being the common case). Both are off the hot path, both project into the one queryable runtime, and both are strictly optional.

**The dependency direction, stated once and enforced everywhere:**

```
CORE ──depends on──► ECSStore/RuntimeStore, and optionally an InboundSource interface
                           (drain() at sync). It NEVER names DurableTarget or the layers.
DURABLE ──depends on──► the Runtime Core (concretely; projection writes columns)
                           and CRDTSnapshot (an interface; never LoroSnapshot).
                           Its DurableBinding implements DurableTarget (upward: doc.transaction)
                           AND InboundSource (downward: drain at sync). Transactions are called
                           on the durable store directly, not through the World.
EPHEMERAL ──depends on──► the projector kernel + an EphemeralSource interface; nothing in durable.
                           Its binding also implements InboundSource.
Loro is quarantined to exactly TWO adapter classes: LoroSnapshot (the doc, behind CRDTSnapshot)
and LoroEphemeralSnapshot (the ephemeral store, behind EphemeralSource). Nothing else imports Loro.
```

The core knows only the *runtime store* and, optionally, `InboundSource` drains for `sync()` — it never names `DurableTarget` or anything it could "open a transaction on." The durable layer exposes `transaction` **directly to app code** (you call `doc.transaction`, not `world.something`), while its binding exposes only `InboundSource` *downward* to the world (§12.1). The layers know the *concretion* (the runtime's columns); the core knows nothing of them. That is layering, not a cycle: the arrows point inward to the core, and Loro is quarantined to two adapter classes at the very bottom.

**Normative timing rules — the single source of truth.** Almost every subtle bug in a design like this is a *timing* question: when does a given mutation become visible in the runtime (readable, queryable)? The rules are stated once here and referenced (not restated) elsewhere; where a later section appears to disagree with this table, **this table wins**.

| # | Mutation | When it reaches the runtime | §ref |
|---|---|---|---|
| 1 | **`world.*` structural** (spawn/despawn/add/remove component, tag, relation) — outside a tick | **immediately** (nothing is iterating) | §5.2 |
| 2 | **`ctx.*` structural** — inside a system | **phase-buffered**: applied at the phase boundary (flush) | §5.2, §5.4 |
| 3 | **Value write to an existing component** (`edit().set` / `writeComponent`), and **`setResource`** — any context | **immediately** (reorders no columns; safe mid-iteration) | §5.2, §5.3 |
| 4 | **Durable value write to an existing component** (`tx.edit().set`) | **immediately at transaction seal** (runtime + document + baseline together) | §12.3, §13.2 |
| 5 | **Durable structural** (`tx.spawn`/`addComponent`/tag/relation/despawn) | **at projection during the next `sync()`** (the handle is usable at once; placement/queryability wait) | §12.3, §13 |
| 6 | **Ephemeral *local* mutation** (`eph.spawn`/`edit`/`add`/`remove`) | **immediately** — designed for use outside a tick (input handlers). Inside a system: structural `eph.*` throws (**all builds** — mid-loop migration is a safety hazard), value `eph.edit().set` is allowed (§15.2) | §15.2 |
| 7 | **Ephemeral *remote* mutation** (another peer's changes) | **at projection during the next `sync()`** | §15.3 |
| 8 | **Inbound projection** (durable remote/own-echo, ephemeral remote) | **immediately during `sync()`** (which runs outside iteration) | §13, §16 |

Two cross-cutting facts fall out and are worth stating alongside: **(a)** the *identity handle* of any spawn (`world`/`ctx`/`tx`/`eph`) is usable the instant the call returns — only *placement* (hence readability/queryability) follows the table above (§5.2); and **(b)** the **command buffer has exactly one producer — system code via `ctx`** (rule 2) — every other row applies immediately or at its own boundary and never touches that buffer (§5.4). The single asymmetry to notice: rule 5 (durable structure) waits for projection because the reconcile baseline must advance with the runtime (§13.2), while rule 6 (ephemeral local structure) does *not* wait, because the ephemeral layer has no baseline to keep in step (§15.1) — that is the one place the durable and ephemeral timing models deliberately diverge.

---

# PART I — THE RUNTIME CORE

Everything in Part I exists with zero durability and zero sync. It is a complete ECS: you can build a fast, local, single-user application on it and never read another line of this document. Parts II–IV add optional capabilities *on top of* this core without changing it.

## 1. The data model

An entity has three kinds of attached state, each first-class and stored differently:

| Kind | What it is | Runtime storage |
|---|---|---|
| **Component** | Named struct of numbers/strings | Typed-array column in an archetype |
| **Tag** | Zero-sized marker (set semantics) | Bitset (`Uint32Array`), outside archetype identity |
| **Relation** | Typed directed link to entity(ies) | Bidirectional index (`Map`s) |

Plus **resources**: world-scoped singletons, not attached to any entity, stored as a plain object/struct.

**Component fields** are restricted (Option 1) to: `f32 f64 i8 i16 i32 u8 u16 u32`, `bool`, `eid` (entity reference), `enum(...)`, and `string`. Every one of these is stored as a number in a typed array. `string` means **freeform per-cell text**: the field's column owns the strings directly (a `(string|null)[]`, §3.4), written by direct assignment, not pooled. For *closed* sets of string-like values that want fast integer equality (a category, a status), use `enum` instead — it interns to a small integer. Every field except `string` is stored as a number in a typed array; `string` is the one column type that isn't, and it is still indexed by row exactly like the others. The hot path stays monomorphic because numeric fields — the ones iterated every frame — are all typed arrays; freeform text is read per-cell, not crunched in tight loops.

## 2. Entity identity — the generational index

An entity is a 32-bit packed `u32`: low bits = slot index, high bits = generation.

```
 31 12 11 0
┌───────────────────────┬──────────────────────┐
│ generation (12b) │ index (20b) │ ← a realistic editor split; see the note on widths
└───────────────────────┴──────────────────────┘
```

- The **index** is a direct row into entity-table arrays and into archetype columns → O(1) access.
- The **generation** bumps when a slot is recycled → a stale reference (a relation or `eid` field pointing at a freed-then-reused slot) is detected by a generation mismatch. This is the cheap referential-integrity check, and it's the reason a bare array index isn't enough on its own.

**On the split, concretely** (the numbers matter — an implementer will use them): the widths trade *live-entity capacity* against *reuse safety*. **20 index / 12 generation** gives ~1,048,576 concurrent slots and 4,096 generations per slot before wrap — a sensible editor default. Alternatives: **22 / 10** (~4M slots, 1,024 generations) if you expect very large documents; or, if 32 bits is too tight, pack the handle into a **53-bit-safe JS number** (a plain `number` is exact to 2^53) and widen both fields. Do **not** copy a tiny index like 10 bits (1,024 slots) — that overflows the first moderately large document. **Generation wrap:** when a slot has been recycled `2^genbits` times, its generation counter wraps to a value a very old handle could also hold, which would let that stale handle read as valid again. The spec's rule: **generation 0 is reserved as "never issued," so wrap skips 0** (a freshly wrapped counter is still distinguishable from an unallocated slot), and an implementation that cannot tolerate even the astronomically-unlikely full-wrap collision should widen to the 53-bit representation rather than rely on wrap not happening. For editor workloads — where slot churn is human-paced — 12 generation bits will not wrap in any realistic session; the rule is stated so the behavior is *defined*, not because it is expected to trigger.

The entity table is itself SoA:
```
generations: Uint32Array // current generation per slot
archetypeId: Uint32Array // which archetype each live entity is in — or NO_ARCHETYPE if identity-only
rowInArch: Uint32Array // row within that archetype's columns — or NO_ROW if identity-only
freeList: number[] // recycled slot indices
```

**Sentinels, because a `Uint32Array` cannot hold `undefined`.** An identity-only entity (§5.2) has *no* archetype and *no* row, but `archetypeId`/`rowInArch` are `Uint32Array`s that can only hold numbers — so "none" needs an explicit reserved value, not `undefined`:
```
const NO_ARCHETYPE = 0xFFFFFFFF; // "this slot has identity but no placement"
const NO_ROW = 0xFFFFFFFF;
```
Every placement-dependent operation checks the sentinel: a read does `if (archetypeId[slot] === NO_ARCHETYPE) return undefined` (the identity-only read rule, §5.2); `ensurePlaced` does `if (archetypeId[slot] === NO_ARCHETYPE) place(...)` (idempotent placement, §5.5); a freed slot is set back to `NO_ARCHETYPE`/`NO_ROW` on despawn. Reserving `0xFFFFFFFF` costs one archetype id and one row index out of ~4 billion — irrelevant, and it makes "no placement" a first-class representable state rather than something the code has to infer. (This is why the max index width is effectively 20–22 bits regardless of the 32-bit field: the top sentinel value is spent, and slot counts stay well under it.)

The whole handle is one machine word: cheap to pass, store in an `eid` column, and compare. There is no second ID space and no mapping table — the index *is* the identity, and the generation makes it safe to recycle slots without dangling-reference bugs.

The "handle" *is* the entity id — what other ECS frameworks call `Entity` (Bevy: index + generation) or `entity_t` (flecs). "Handle" only emphasizes it is an opaque value you *hold*, not a struct you dereference. Critically, it is a **name, not a pointer**: it does not contain the entity's data or point at it directly — it contains a *slot*, and the slot resolves through the entity table (`archetypeId[slot]`, `rowInArch[slot]`) to wherever the data currently lives. That indirection is the point: the slot — and therefore the handle — stays *constant* even as the entity's data migrates between archetypes (different archetype, different row), so a handle is a stable name for an entity whose physical location moves. The generation makes the name safe under slot reuse: a name is a slot plus a "which occupant" counter, so an expired name (old generation) can never accidentally resolve to the slot's new occupant.

> **A note that matters once you reach Part III.** The generational handle is **runtime-local and disposable**. It is allocated by the runtime, means nothing outside this process, and is *not* the identity a collaborative document uses. Part II introduces a separate, stable, document-scoped **key**, and the projector maintains a bijection between the two. Keep the distinction in mind: within Part I there is only the handle, and that is correct — the core has no notion of a document.

## 3. Runtime store

The runtime store is the one place that knows the **in-memory data shape** — and that shape is the source of essentially all of Part I's complexity. Archetypes-as-typed-array-columns is *why* mutation must defer (migration reorders columns, §5), *why* queries filter by archetype-then-row (§6), *why* identity is separable from placement (§5.2), *why* swap-and-pop needs a back-pointer (§5.5). Reads and writes are not two subsystems; they are two faces of one representation, sharing its invariants. So they belong behind one boundary, and everything above it should be representation-agnostic.

That boundary is **`ECSStore`** — the complete operational contract over an ECS's state, saying nothing about *how* the data is stored: create/destroy entities, add/remove/read components, tags, relations, and run queries. It is the general CRUD-plus-query any ECS exposes. `World` and the system `ctx` hold an `ECSStore` and **delegate** to it; they contain no representation knowledge. **`RuntimeStore`** — the archetype/typed-array engine specified in this section, §5, and §6 — is *one implementation* of `ECSStore`, the one strata ships. `createWorld` instantiates a `RuntimeStore` as its `ECSStore`.

```
World / ctx / queries ── representation-agnostic delegation (general ECS CRUD + query)
        │ delegates to
        ▼
   ECSStore (interface) ── the complete operational contract over ECS state
        │ implemented by
        ▼
   RuntimeStore ── archetypes, typed-array columns, the entity table, the command
                           buffer, swap-and-pop, query plans — ALL of §3/§5/§6, self-contained
```

The one place this abstraction is *deliberately* permeable is hot iteration: a query hands the system body **raw columns** (§6), because a fast ECS loop must touch the representation directly. That single leak is confined to the per-chunk callback — everything else (which archetypes match, how tags/relations filter, when mutations apply) stays sealed inside the implementation. The rest of this section specifies that implementation, bottom-up.

### 3.1 Archetypes (component storage)

An **archetype** is the set of entities sharing the exact same set of *component types* (tags do **not** participate — see 3.2). Per archetype:

```
Archetype:
  id: number
  componentSet: bitmask of component type IDs
  entities: Uint32Array // local entity id per row (packed) — the row→entity back-pointer
  count: number // live rows
  columns: { [compFieldId]: TypedArray | (string | null)[] } // one column per field
```

A component `Position { x: f32, y: f32 }` contributes two columns: `Position.x → Float32Array`, `Position.y → Float32Array`. Reading entity at row `r`: `Position.x[r]`, `Position.y[r]`. No per-entity object exists. **Field storage is a typed array for every field type except `string`**, which is backed by a `(string | null)[]` that owns the strings directly (§3.4); a `string` field is read/written as `column[r]` just like a numeric field, only the backing array differs.

The **empty archetype** (`componentSet` = ∅, no columns) is a valid archetype: a live entity with zero components has a row there. It is what makes a componentless or tag-only entity *queryable* rather than invisible (§5.2) — the entity is placed, has a row and a slot in the `entities` back-pointer array, and participates in tag/relation filters, it just has no component columns to read. Placing an entity into the empty archetype is what a `spawn` with no components does (`ensurePlaced`, §5.5), and adding the entity's first component migrates it out of the empty archetype into that component's archetype like any other structural change.

**Iteration** (the hot path) walks matching archetypes, and within each, loops rows by index over the typed arrays:
```ts
for (const arch of query.matchingArchetypes) {
  const px = arch.columns[Position_x], py = arch.columns[Position_y];
  const vx = arch.columns[Velocity_x], vy = arch.columns[Velocity_y];
  for (let r = 0; r < arch.count; r++) {
    px[r] += vx[r]; // contiguous, monomorphic, no allocation
    py[r] += vy[r];
  }
}
```

**Structural change** (add/remove a *component*) migrates the entity to the archetype with the new component set: append its row to the destination columns, copy overlapping field values (bulk typed-array writes), swap-and-pop from the source. Because columns are typed arrays, migration is cheap memory copying, which is exactly why archetypes (rather than sparse-sets-of-objects) are the right call in JS. (The full algorithm — including the swap-and-pop *back-pointer fixup* that keeps the entity table correct — is §5.5; it is the load-bearing detail this one-liner glosses.)

**Query matching** is precomputed: a query caches its list of matching archetypes and is notified when a new archetype is created (archetype creation is rare and amortized).

### 3.2 Tags (slot-indexed bitsets, outside archetype identity)

Each tag type owns one bitset over **entity slots** (the generational-index slot, §2):
```
tagBitsets: { [tagTypeId]: Uint32Array } // 1 bit per entity slot
```
- `has(tag, slot)` → `(bitset[slot>>5] >> (slot & 31)) & 1`
- `add` / `remove` → set/clear the bit at the entity's slot. **O(1), and migration-invariant**: an entity's slot never changes when it moves between archetypes, so its tag bits never move. This is also why tags are kept out of archetype identity — a `Hidden` tag toggling every frame would otherwise thrash archetypes; as a slot-bit it's a single write.

**A public `hasTag(e, T)` must validate the handle's generation *before* reading the bit.** The bitset is keyed by slot with no generation component, so a **stale** handle (one whose generation no longer matches the slot's current occupant, §2) would read the *new* occupant's tag bit and return a wrong answer. So the public accessor is generation-guarded:
```
hasTag(e, T):
  if !isAlive(e) return false // generation mismatch (or freed) → the bit is not THIS entity's
  return has(T, slot(e))
```
This is the same validate-on-read discipline `eid`/relation reads use (§2), and it applies to **every** operation keyed by a bare slot from a public handle — `hasTag`, and internally any slot-indexed lookup that starts from a caller-supplied `Entity`. Iteration-time tag probes (`arch.entities[r]`, above) don't need the guard: a row in a live archetype is by construction a live entity, so its slot is current — the guard is specifically for *handle-supplied* reads, where the handle may have gone stale. Despawn's `clearAllTags(slot)` (§5.5) is the write-side other half of this: cleared on destroy so the bit is `0` for the next occupant, generation-guarded on read so a stale handle can't observe a reused slot's bit either way.

**The cost honesty that matters:** the bitset is indexed by *slot*, but archetype iteration walks *rows* (`arch.entities[r]` is some entity whose slot is whatever it happens to be — archetype rows are **not** slot-ordered or contiguous). So a tag test during iteration is **per-row, not word-wise**:
```
const slot = unpackIndex(arch.entities[r]);
hasTag(tagId, slot); // a scattered probe per row
```
You cannot AND a contiguous bitset region against an archetype's rows, because the two domains aren't aligned. Tag filtering over `N` candidate rows is therefore **O(N · t)** for `t` tag terms — a probe per row, not `O(t·N/32)`. The constant is small (a shift and a mask) and `N` is editor-sized (thousands of shapes, not millions of particles), so this is cheap in absolute terms — but it is *linear*, the same order as a relation check, just with a smaller constant. (Aligning the bitset to iteration would require per-archetype, per-row tag bitsets that move bits on every migration and swap-pop; for editor-scale `N` the bookkeeping isn't worth it, so slot-indexed-and-honest wins.)

A query is generally: pick matching archetypes by component set, then **filter rows by per-row tag probes** (and relation checks). Tags are the cheap, high-selectivity filter that narrows the iteration — cheap per test and toggle-free of migration, just not sublinear.

### 3.3 Relations (bidirectional indices)

Relations are reference-shaped and irregular, so they live in `Map`-based indices, not typed arrays. Keys **and** values are packed `Entity` handles (slot + generation, §2), not bare slot indices. The collection types are precise, because dedup and removal cost depend on them:
```
// arity "one": forward is a single handle; arity "many": forward is a SET (unordered, deduped)
oneForward: Map<RelationTypeId, Map<Entity, Entity>>
manyForward: Map<RelationTypeId, Map<Entity, Set<Entity>>>
// reverse is ALWAYS a Set — dedup + O(1) add/remove, and order is never meaningful on the reverse side
reverse: Map<RelationTypeId, Map<Entity, Set<Entity>>>
```
- **forward** answers "what is e's `ChildOf` target / `Targets` set?" — `Entity` for arity "one", `Set<Entity>` for arity "many".
- **reverse** answers "who points at e via `ChildOf`?" — always a `Set<Entity>`, O(1) add/remove, the place you enforce integrity: when an entity is destroyed, the reverse index tells you exactly which relations to clear.
- **Dedup and order semantics** (arity "many"): a `Set` forward means **duplicate edges are not representable** (`addRelation(e, R, t)` twice is idempotent) and **edge order is not preserved**. This is the right default — relations are a graph, and "is there an edge" is the only question membership answers. If a specific relation genuinely needs *ordered* children (a layout z-order, say), that is the dedicated tree/ordered-list index from the hierarchy note below, kept alongside — not a property of the generic many-relation, which stays an unordered Set so `removeRelation` is O(1) rather than O(n) array splice.
- **Why packed `Entity`, not bare slot.** A relation is a long-lived cross-entity reference — exactly where a reused slot would cause a stale edge to silently re-point at a *different* entity. Storing the generation closes that:
  - *Keys/values carry generation* → when a destroyed entity's slot is reused, the new occupant has a different generation, so old edges never get **misattributed** to it (the keys simply don't match). This is the same number (`Entity` is a `u32`), so `Map<Entity,…>` costs no more than `Map<slot,…>`.
  - *Generation enables validate-on-read* → traversing an edge unpacks the stored `Entity` to a slot and checks its generation against the entity table; a mismatch means the target was destroyed (dangling edge) and is skipped/cleared.
  - *Reverse-index cleanup on destroy* still runs, so dead edges are removed **eagerly** rather than only detected lazily.
- Keying by `Entity` is also **migration-invariant**: an entity's packed handle doesn't change when it moves archetype (only its row does), so relation indices never need fixing up on migration.
- These two indices are exactly what the query layer consumes (§9.2): the **forward** index answers `Related(R, …)` and lets a concrete-target query *seed* from a point lookup; the **reverse** index powers `R.inverse` and the `getReverse` traversal.

> **Hierarchy note:** if you have *one* dominant parent/child hierarchy that needs ordered children or fast subtree traversal, you can keep a dedicated tree index for that relation alongside the generic forward/reverse maps. Don't model general relations as trees — they're a graph, not a hierarchy.

### 3.4 Strings — two kinds, two mechanisms

Strata has two genuinely different kinds of string, and the right design treats them differently rather than forcing both through one table:

1. **Identifier strings** — schema-level names: component type names, tag names, relation names, enum variant labels. Finite, known at definition time, never churn. These want dedup-to-integer (so query equality is a `u32 ===`).
2. **Value strings** — freeform mutable text in a component *field* (`Name.value`, `Label.text`). Per-cell, mutable, churning at the rate a user types. These want cheap direct writes and must not leak when overwritten.

**Identifier strings → the symbol registry (grow-only, by design).**
```
symbols: string[] // symbol id (index) → string
symbolLookup: Map<string, number> // string → symbol id
```
- `intern(s)`: return existing id or push a new one. `resolve(id)`: `symbols[id]`.
- Populated at schema-definition time (`defineComponent("Position", …)` registers `"Position"`, `enumOf(["Red","Blue"])` registers its variants). Bounded by the schema, so **grow-only is correct, not a limitation** — the set is finite and nothing ever needs reclaiming. Used for type/tag/relation/enum identity; equality is integer comparison. These never appear in component *value* columns — they are metadata.
- **Framework identifiers are reserved, and redefining one throws.** The registry pre-registers the names the framework itself exports — most importantly the ephemeral store's `Local` tag, and any future framework-owned tag/component — so user schema can't collide with them. (Why `Local` specifically: Part IV's ephemeral store *automatically* applies `Local` to the entities in each runtime's own partition, so queries can say `Not(Local)` to mean "remote peers" — §15.4. Because the store applies it, the framework must own the name; that is the whole reason it's reserved here, even though its purpose only becomes concrete in Part IV.) Calling `defineTag("Local")` (or `defineComponent`/`defineRelation` on a reserved name) **throws** — a clear, normative error directing you to import the symbol from the framework (`import { Local } from "strata"`) rather than silently returning the existing one. This is a deliberate spec choice, not left to the implementation: returning the framework symbol would be convenient but too magical (a user could believe they *defined* `Local` and rely on redefining it), and portability requires one predictable behavior. So the rule is flat: **reserved names are import-only; defining one is an error.** The registry is the single interning authority, so enforcing it there closes the collision at its only source — which is what makes "`Local` is framework-exported, don't define it yourself" (§15.4) an *enforced* rule rather than a convention.

> **The canonical identity stack — three names for a component's identity, used consistently.** The document refers to a component's identity three ways, and they are three *distinct* things, not loose synonyms:
> - **`Component<S>`** — the **public schema handle** returned by `defineComponent`, carrying the field-type `S`. This is what user code holds and passes (`edit(e).set(Position, …)`), and what the typed API keys on. It is opaque; you never inspect its internals.
> - **`ComponentId`** — the **internal numeric id** interned in the symbol registry above. This is what the runtime uses for fast identity/equality (archetype signatures, column indexing, `StructuralCommand`s) and what appears in the interface sketches (`getComponent(key, c: ComponentId)`). It is run-local and schema-derived — the *same* schema produces the *same* ids in one process, but the number itself is not stable across builds or versions.
> - **`ComponentName`** — the **string label** (`"Position"`) the component was defined with. Used for debugging, error messages, and **serialization**.
>
> `Component<S>` is the public face, `ComponentId` the internal fast path, `ComponentName` the durable/debug label — a lookup resolves any to the others (`Component<S>` ⟷ `ComponentId` via the handle's interned id; `ComponentId` ⟷ `ComponentName` via the registry).
>
> (A related type used throughout the sketches: **`ComponentValue`** is a component's *value* — the plain object of its declared fields, e.g. `{ x, y }` for a `Position`. It is the untyped/erased form that appears in id-keyed internal structures like `ComponentInit` and `ChangeEvent`, where the static field-type `S` isn't available; the *public* typed API recovers `S` through the `Component<S>` handle. So `ComponentId` + `ComponentValue` is the internal id-keyed pairing, `Component<S>` + `S` the public typed one.)
>
> **Closing the serialization loop: durable documents store components by NAME, change events carry the ID.** Because `ComponentId` is run-local (not stable across schema versions or builds), a **durable document stores components by `ComponentName`** — the string label — so a document written by one version loads correctly in another as long as the *name* is stable. This is **migration-friendly** (add/reorder components freely; ids can differ between the writer and reader, and it still resolves by name) but **rename-hostile** (renaming a component is a breaking change to the on-disk format — a persisted `"Transform"` won't match a redefined `"Transform2"` — so a rename must be treated as a migration, e.g. a document-upgrade step that rewrites the old name to the new). By contrast, **runtime-internal change events (`ChangeEvent`) carry `ComponentId`**, because they never leave the process — they flow from the CRDT adapter to reconcile within one run, where the interned id is both faster and unambiguous. The adapter is the boundary that translates: it reads/writes the document's name-keyed fields and surfaces id-keyed `ChangeEvent`s to the binding. (Tags and relations follow the same stack: `Tag`/`TagId`/`TagName`, `Relation`/`RelationId`/`RelationName`, durable-stored by name, id-keyed at runtime.)

**Value strings → per-cell ownership (no interning).** A `string` component field is **not** backed by a `Uint32Array` of handles. It is backed by a plain `(string | null)[]` — the column *owns the actual strings*, one per row, indexed by row exactly like a numeric column:
```
columns[Name_value]: (string | null)[] // the strings themselves, not handles
```
- **Write** is `column[row] = "bar"` — direct, O(1); the previous `"foo"` becomes unreferenced and the JS GC reclaims it. There is no lookup map to hash against on write, and **no reclamation logic at all** — overwrite, destroy, and migration all just drop a reference. The "rename every keystroke" case is steady-state memory: one allocation per keystroke, the prior value dropped. The churn-leak problem does not exist because value strings were never pooled.
- An unset string cell reads `null` (distinct from `""`, an explicitly-empty string).
- **Migration** moves the string *reference* between archetype arrays (a reference copy); **swap-and-pop** drops it. (Full algorithms in §5.5.)

**The capacity invariant, stated broadly (and testable):** *for every string column, all indices `r >= count` must be `null`* — and `null` specifically, never `undefined`. This is the general rule that swap-pop nulling (§5.5) is one instance of — but it also governs *capacity* changes, which are the easy-to-miss case. A `(string | null)[]` may keep backing capacity when the archetype shrinks (not shrinking the array avoids reallocation), so nulling on removal is **mandatory**: a live reference sitting at an index above `count` is a leak (the deleted label never GCs) *and* a correctness hazard (a later `place` into that row that forgets to write the field would read a stale string instead of `null`). Two consequences make it concrete: on **shrink**, every slot from the new `count` up to the old high-water mark must be nulled (swap-pop nulls the one vacated slot; a bulk clear nulls a range); on **grow**, newly-addressable slots must be **eagerly filled with `null`** — an implementation must not leave them `undefined` and rely on `undefined` reading like a missing value. This gives three *distinct* cell states with no ambiguity: **`null` = intentionally-unset string**, **`""` = an explicitly-empty string** (distinct from unset), and **`undefined` = a bug / uninitialized capacity that should never occur**. Because `undefined` is never a valid stored value, the invariant is literal and the test is exact — walk each string column from `count` to `.length` and assert every slot `=== null` — which is why it is one line rather than left implicit in the swap-pop step. (Numeric columns need no equivalent: a stale number above `count` is harmless, never read as a reference, and overwritten on the next `place` — the invariant is string-specific because only string slots hold GC-visible references.)

**Why not intern value strings (or refcount them)?** Interning pays off only for dedup and integer-equality — both of which matter for *identifiers*, not value strings (which are distinct by nature and rarely hot-queried for equality). Refcounting value strings would reimplement GC, badly, for strings the runtime already lets GC handle. For the genuine "few distinct, fast-compare string-like values" case (e.g. a category field), the schema already has the right tool: **`enum`** (`enumOf([...])`), which is interned to a small integer (§4). So freeform `string` fields are for genuinely-freeform text (per-cell, owned), and `enum` fields are for closed sets (interned, fast) — the two schema types map exactly onto the two string kinds.

> **Persistence note.** Value strings serialize as *themselves* — they are already real strings in the column, so the local snapshot (§8) and durable documents (Part III) carry the text directly, with nothing process-local to translate. The symbol registry is run-local, but it is *schema-derived*, so it re-populates from the schema on load, not from serialized data. (This is also why durable string values are natural across the wire: a CRDT stores the real string a peer can read, never a process-local handle — see Part III.)

## 4. Schema — declaring the data

The schema API is the framework's primary public surface: it declares what data exists and routes each field to its storage. It is *declaration* — separate from mutation (§5), reading (§6), and execution (§7).

```ts
const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Health = defineComponent("Health", { current: "u16", max: "u16" });
const Name = defineComponent("Name", { value: "string" }); // freeform text → (string|null)[] column, owned per-cell
const Target = defineComponent("Target", { entity: "eid" }); // entity ref → u32, validate-on-read
const Team = defineComponent("Team", { side: enumOf(["Red", "Blue", "Neutral"]) });

const Enemy = defineTag("Enemy");
const Frozen = defineTag("Frozen");

const ChildOf = defineRelation("ChildOf", { arity: "one" });
const Targets = defineRelation("Targets", { arity: "many", ordered: false });

const Score = defineResource("Score", { value: "u32" });
```

Each field type deterministically picks a typed array: `f64→Float64`, `f32→Float32`, `i32→Int32`, `u32/eid→Uint32`, `i16→Int16`, `u16→Uint16`, `i8→Int8`, `u8/bool→Uint8`, `enum→` smallest int that fits (interned via the symbol registry, §3.4). The sole non-typed-array field is `string`, backed by a `(string|null)[]` that owns its text directly (§3.4).

**Field rule to enforce:** a component field is a *number, an enum, an entity reference, or a freeform `string`*. No arrays, no nested objects. `string` fields are owned per-cell (§3.4), so they are genuinely freeform — but keep them to reasonably-sized text (labels, names, short content), not megabyte blobs, since a column holds one per row.

**Complete values, or a declared default — no silent zero-fill.** A component write must supply **every** field, *unless* the schema declares a default for that field. Partial values without a default are a **schema error** (thrown at the write), not silently zero-filled — because a silent 0 for an omitted `x` is a bug that reads as valid data. Defaults are declared per field:
```ts
const Position = defineComponent("Position", {
  x: field("f32", { default: 0 }),
  y: field("f32", { default: 0 }),
});
const Label = defineComponent("Label", { text: field("string", { default: "" }) });
```
With a default, an omitted field takes it; without one, the field is required. (The bare `"f32"` form in the other examples is shorthand for `field("f32")` — a required field with no default.) There is deliberately **no global "numbers default 0, strings default null, enums default first-variant" rule**: implicit type-based defaults are exactly what lets a forgotten field slip through, so the schema must opt in per field. This keeps "what's in this cell" always either explicitly written or explicitly defaulted, never accidental.

**Enum storage: stable discriminants, especially for durable data.** An `enum` field interns to a small integer (§3.4). The **danger** is storing the *positional* integer (0 = first variant, 1 = second, …) in anything persisted or synced: if a later schema version reorders the variants, every old integer silently changes meaning — a red rectangle becomes a blue one on load, with no error. So `enumOf` accepts **explicit discriminants**, and durable/collaborative schemas should use them:
```ts
const Team = defineComponent("Team", { side: enumOf({ Red: 1, Blue: 2, Neutral: 3 }) });
```
Now the wire/disk value is the *stable* discriminant, not the array position, so reordering the declaration is harmless and inserting a new variant just means picking an unused number. For a purely **local** snapshot (§8) that is always loaded by the exact code that wrote it, positional integers (`enumOf(["Red","Blue"])`) are acceptable — the schema round-trips in one process — but the moment the data is durable, synced, or versioned, use explicit discriminants. (An implementation may also store enums by string label in durable docs; that is the most migration-proof but costs space. Explicit integer discriminants are the recommended middle.)

**The typed API reads and writes enum *labels*; the discriminant is an internal encoding.** You write `edit(e).set(Kind, { shape: "rect" })` and read back `"rect"` — the label is the value at the API boundary, in either the positional or explicit-discriminant form. The schema knows the label↔discriminant mapping (that *is* what `enumOf` declares), so a write encodes the label to its stored number (`"rect" → 1`) and a read decodes it back. This is why every example writes `Kind: { shape: "rect" }` rather than `{ shape: 1 }`: the discriminant is storage, the label is the interface. (TypeScript can type the field as the literal union `"rect" | "ellipse" | "text" | "frame"`, so a typo is a compile error, not a silent bad write.) The stable-discriminant guidance above is therefore purely about what gets *stored*; it changes nothing about the ergonomic label-valued surface you code against.

> **A note on the `{ ComponentName: { …fields } }` init shape used throughout.** Examples write `spawn({ components: { Position: { x, y } } })` for readability, but this string-keyed object is **illustrative pseudocode, not the literal typed API** — a TypeScript object key is a string, so it can't carry the `Component`'s field types, and `Record<string, object>` (as written in the interface sketches) is deliberately loose for legibility. A real implementation carries the types by keying on the component *handle*, e.g. a tuple array `spawn({ components: [[Position, { x, y }], [Size, { w, h }]] })` or a builder `spawn(withComponents(Position({ x, y }), Size({ w, h })))`, either of which type-checks each value against its component's schema. The examples keep the object form because it reads far more cleanly than nested tuples; when you build against the framework, expect the component-keyed shape (which the `defineComponent` handles make possible) rather than string keys. This applies uniformly to every `components: { … }` in this document.

> **Schema design for collaboration: the component is the conflict unit, so field granularity is a concurrency decision.** This belongs here, at schema-definition time, because it shapes your components more than almost anything else — even though the mechanism that enforces it lives in the durable layer (§13.4). In strata's durable model, two concurrent editors converging on the same entity resolve conflicts **per whole component** (committer-wins on the component as a unit, §13.4): the *last commit to touch a component* wins that component entirely, and there is no field-level merge. That makes the **grouping of fields into components** a decision about what can be edited *independently* versus what clobbers:
> - A fat `Transform { x, y, rotation, scale }` means a collaborator who commits a *rotation* change overwrites your concurrent *position* change — because they committed the whole `Transform`, and yours was the earlier op. The fields ride together, so they conflict together.
> - Splitting into `Position { x, y }`, `Rotation { angle }`, `Scale { x, y }` lets one person rotate while another moves the *same* shape, both edits surviving — they're different components, so they reconcile on independent baseline cells (§13.4).
>
> The rule of thumb: **put fields in the same component when they genuinely change together and should conflict together; split them when they can be edited independently and both edits should survive.** For an editor, that usually means position, rotation, and scale are *separate* components, not one transform — the opposite of what a single-writer engine would do for cache locality. (If you only ever use the local runtime, Parts I–II, this doesn't bite — it's purely a collaboration concern — but designing components this way from the start costs nothing and saves a migration later.) This is the single most consequential way the collaborative target should change how you draw component boundaries; §13.4 is where the reconcile mechanism that makes it true is specified.

## 5. The mutation layer — changing runtime state

This section is the hinge of the whole architecture. It defines *how runtime state changes* — and the central fact is that there are **two kinds of mutation with different mechanics**, divided by the **shape/value rule**:

- A **value change** alters a *value an entity already has* — a number in a column it already owns. These are **immediate, direct column writes**: `Position.x[r] += Velocity.x[r]` in a hot loop, or `ctx.edit(e).set(Component, v)`. They do **not** go through any buffer or op vocabulary — they are just array writes. This is the architecture's whole performance thesis: the most frequent mutation is the cheapest, a direct write with zero indirection.
- A **shape change**, also called a **structural change** — the two terms are **synonymous throughout this document** — alters an entity's *shape*: which components, tags, or relations it has, or whether it exists at all (spawn, despawn, add/remove component, add/remove tag, add/remove relation). Precisely: **a structural (shape) mutation is any change that affects query membership** — entity existence, component membership, tag membership, or relation membership. These are what the rest of this section is about, because they are the ones that **cannot happen mid-iteration** and so are routed through a command buffer.

> **Terminology, fixed once.** "Shape change" and "structural change" mean exactly the same thing — a change to query membership, per the definition above — and this document uses them interchangeably (the memorable name for the split stays the **shape/value rule**). One place the word "structure" means something *different*: in the durable layer, "document **structure**" and "**projection** of structure" refer to how changes flow from the document into the runtime (§12–13), not to the ECS-membership sense. Where that ambiguity could arise, the durable sections say "document structure" or "projection" explicitly; unqualified "structural"/"shape" always means the ECS-membership sense defined here.

So "the mutation layer" is really **the structural-mutation layer**: value writes are a separate, immediate, direct path that deliberately bypasses everything here. Hold that split — it is the section's spine.

### 5.1 Why shape changes must defer — first principles

The deferral of shape changes is *forced*, not chosen. The chain:

1. The runtime iterates **packed typed-array columns** (the performance requirement — the whole design).
2. A **shape change** migrates an entity between archetypes, which **reorders the packed columns** (swap-and-pop on removal, append on insertion).
3. ⟹ A shape change *during* iteration corrupts iteration — the same reason `for (x of list) list.remove(x)` is a bug, deterministically: rows get skipped or double-visited, cached column references go stale, the loop bound moves.
4. But systems must be able to *request* shape changes *while* iterating — that is when they are discovered ("this entity should be destroyed", mid-loop).
5. ⟹ Requests must be **recorded** during iteration, not applied.
6. ⟹ Recorded requests must be **applied at a point where no iteration is running** — a *safe point*.

That safe point is **flush** (§5.4). Value writes have no such problem (they touch no archetype structure, only a value already in place), which is exactly why they stay immediate. The whole machinery below exists for shape changes only.

**Why tags and relations defer too, though they never migrate an archetype.** A tag is a slot-bitset flip (§3.2) and a relation is a map update (§3.3) — neither reorders a packed column, so by the corruption argument alone they could be immediate. They defer anyway, for a *different* but equally principled reason: **queries observe tags and relations as membership filters** (a `rowFilter`, §6.1). A query like `[Position, Frozen]` decides per row whether `Frozen` is set; toggling `Frozen` immediately, mid-iteration, would change that query's membership *while it is being walked* — some rows already visited under the old membership, later rows under the new — the same skipped/double-counted hazard as column reordering, one level up. So the dividing line is not "does it reorder columns" but the broader **"does it change what a query would match"**: component add/remove changes archetype membership, tag/relation changes change row-filter membership, and *both* must be stable across a phase. Value writes don't change membership (the entity matches the same queries before and after), so they stay immediate. This is why the rule is uniform over all shape changes (§5.3) rather than special-casing tags.

> This is the same split the major ECS frameworks make: Bevy reserves an entity id immediately and defers archetype insertion to command application (`Commands`); flecs mints ids live and defers structural ops inside `defer_begin/end`. Identity-immediate, placement-deferred is the standard, well-trodden design.

### 5.2 Identity vs. placement — the general rule

A shape change to an entity has two separable facts, and only one is the dangerous part:

- **Identity** — the entity's *id and existence* (§2): its slot + generation in the entity table. Allocating identity is *pop a slot, bump its generation* — O(1), touching **only** the `generations` array and the freeList, which **no query iterates**. So identity allocation is always safe, in or out of iteration.
- **Placement** — the entity's *data storage*: a row in the appropriate archetype's columns, plus the entity-table pointers (`archetypeId[slot]`, `rowInArch[slot]`) that bind the id to that row. Allocating placement appends to *archetype columns* — exactly what queries iterate — so it is the iteration-corrupting part. (Add/remove-component and destroy are *also* placement operations: they move or remove archetype rows. So every shape change is fundamentally a placement change.)

This yields the rule that governs **every** spawn-like operation in the framework:

> **Minting identity touches no archetype columns, so it is always eager and always safe.** **Placement reorders packed arrays, so its timing depends on whether a system is iterating:**
> - **inside a system's iteration** (`ctx.*`) → **defer placement** into the phase's command buffer (§5.4), applied at the phase boundary;
> - **everywhere else** — `world.*` setup, and the layers' projection paths (Parts III–IV), which run outside iteration — there is no iteration to corrupt, so placement applies **immediately**.

The dividing line is precisely *"is a system iterating right now?"* — which is true only inside a system body. So `ctx.spawn` defers (identity returned eagerly), while `world.spawn` is immediate; `ctx.destroy` defers, `world.destroy` is immediate. That is the whole of the runtime-core rule. (The layers apply it too — attach and projection apply immediately because they run outside iteration, and a durable `doc.transaction` routes its structural effects through projection rather than the runtime directly, §12 — but those are layer concerns, specified where they live in Parts III–IV. The core needs no knowledge of them to state its rule.) Because placement timing is the caller's, the projector's `resolveByKey` (§10.2) does **identity only** and the *only* producer of deferred commands is system code via `ctx`.

#### How `ctx.spawn` returns a usable handle while deferring

A system can spawn and immediately use the returned handle — store it, put it in an `eid` field, wire it into later commands this same tick — even though placement is deferred, *because* identity is allocated eagerly. Concretely, `ctx.spawn({...})` pops a slot, bumps the generation, builds the real `Entity` handle, **returns it**, and enqueues `SpawnEntity(thatRealHandle, {...})` into the buffer (the op carries the *real handle*, not an alias). The instant it returns:

- the handle is a **real, unique, valid `Entity`** — storable, comparable, writable into an `eid` column, valid across frames;
- `ctx.isAlive(handle)` is **true** (identity exists);
- the entity has **no placement yet**, so it is **not queryable** and its components are **not readable** this phase — you set them, they are queued, you read them next phase.

The handle is a **forward reference**: it names an entity that exists *in identity now* and *in data at the next phase boundary*. Use the name immediately; use the data next phase.

**The three entity states, made explicit.** A handle is always in exactly one of:

1. **dead / invalid** — never allocated, or freed and its generation moved on. Any read fails the generational check.
2. **identity-only** — slot + generation allocated, but not yet placed in an archetype (a `ctx.spawn` before flush, or a `tx.spawn`'d durable entity before projection). The handle is real and valid; the entity has no row, so no component data and no archetype membership.
3. **placed** — has a row in an archetype; queryable, components readable. **Placement does not require components:** an entity with zero components is placed in the **empty archetype** (signature ∅) — it has a row, so it is live and *queryable*, it simply has no component columns. This is the design's answer to "what about componentless or tag-only entities" (Option A): every live entity that has been placed is queryable, and "placed" is a property distinct from "has any component."

`isAlive(e)` means **states 2 or 3** — "identity is allocated and not freed." It deliberately does *not* distinguish identity-only from placed, because for *handle validity* (can I store this, compare it, will it not alias a different entity) the distinction is irrelevant — both are live names. What the distinction governs is **data access**, and the rule is uniform: **operations that need a row see an identity-only entity as having nothing.**

| operation on an identity-only entity | behavior |
|---|---|
| store / compare the handle, write to an `eid` column | fine — it is a valid name |
| `isAlive(e)` | `true` |
| `read(e, C)` / `get(e, C)` (component value) | `read` **throws** (component not present on an unplaced entity); `get` returns **`undefined`** — the safe read for possibly-unplaced entities (§ Part I reference) |
| `hasTag(e, T)` | works — tags are slot-indexed bitsets (§3.2), independent of placement; a tag *set* on an identity-only entity is really recorded. (Note: the runtime `addTag` op *places* the entity into the empty archetype as it sets the bit, so a tagged entity is queryable — §3.1, Option A; the bitset itself is placement-independent, but tag-add promotes state 2 → 3.) |
| `addRelation(e, R, placed)` / as a relation target | works — relations are `Entity`-keyed maps (§3.3), independent of placement. (As with tags, the runtime `setRelation`/`addRelation` op *places* `e` into the empty archetype as it records the edge, so a related entity is queryable — Option A; a relation *target* is not auto-placed, since being pointed at is not the target's own membership.) |
| query membership | **excluded** — queries match archetypes, and an identity-only entity is in none (§3.2) |
| `ctx.destroy(e)` of an entity `ctx.spawn`'d the same phase | safe — both are commands in the buffer; at flush the spawn places it and the despawn removes it, and validate-on-read guards any stale reference (§5.4) |

**Empty archetype vs. identity-only — and where tag-only entities land.** These are different states and the difference is exactly "does it have a row." A `world.spawn({})` or `world.spawn({tags:[X]})` **places immediately into the empty archetype** — it is a *placed* entity (state 3) with no components, so `defineQuery([X])` finds it (a tag filter over the empty-archetype rows, §3.2). By contrast, a `ctx.spawn` before flush, or a `tx.spawn`'d durable entity before projection, is *identity-only* (state 2) — no row yet, so excluded from queries until it is placed (at flush / at the next `sync()`, respectively).

**Test placement with `isPlaced`, not `isAlive` — this is the trap the three states exist to expose.** `isAlive(e)` is true for *both* identity-only (state 2) and placed (state 3); it means "not dead," not "queryable" or "readable." The check that answers "will a query see this? can I read its components?" is **`isPlaced(e)`** (state 3 only), with `isIdentityOnly(e)` (`isAlive && !isPlaced`) available as a dev/diagnostic. The failure mode this prevents: code that spawns a durable entity, checks `isAlive` (true immediately, because the handle is real), and then tries to `read` a component — which fails, because the entity is identity-only until projection (§12). Reaching for `isAlive` when you mean "ready to read/query" is the single easiest way to trip over the identity/placement split, so the API exposes `isPlaced` precisely to make the correct check the easy one.

The clean placement rule, stated once: **adding a tag or an *outgoing* relation to the source entity places it (into the empty archetype), making it queryable; being the *target* of a relation does not place the target.** So membership an entity gives *itself* (a component, a tag, a relation it points out) is what makes it queryable; being pointed *at* is not its own membership. In one table:

| operation | places the source? | places the target? |
|---|---|---|
| `spawn({})` / `spawn({tags})` | **yes** — empty archetype | n/a |
| `addTag(e, T)` | **yes** — empty archetype (if not already placed) | n/a |
| first component write (add / projection) | **yes** — that component's archetype | n/a |
| `setRelation(e, R, target)` / `addRelation(e, R, target)` | **yes** — `e` placed | **no** — target unchanged |
| being referenced as a relation target | — | **no** |

This matches the kernel exactly: `applyTag`, `applyRelationSet`, and `applySpawn` all call `ensurePlaced` on the source, `projectComponent` places on first component, and none place a relation target (§10.3). So a tag-only or relation-source entity is queryable; a target you merely point at is not dragged into placement by being pointed at.

The one surprising-but-consistent corner: a tag or relation *can* be attached to an identity-only entity (those structures don't need a row), but a **component read** cannot see anything until placement. So `read` is the only operation that returns "nothing" for a live handle; everything else either works or correctly excludes it. This is why a `tx.spawn`'d durable entity (identity-only until projection, §12) can be wired into later durable relations immediately but is not queryable until the next `sync()` — at which point projection places it (into the empty archetype if it has no components yet, §10.3) and it becomes queryable.

**Dev-mode guard: `world.*` structural mutation on an identity-only handle warns/throws.** There is a loophole to close here. A `tx.spawn`'d durable handle is identity-only until projection — but `world.addTag(e, T)` (or any `world.*` structural op) would *place* it into the empty archetype immediately (Option A), making it queryable as a **half-projected** entity: queryable and tagged, but with none of its durable components yet (they project at the next `sync()`). Observing that intermediate state contradicts the mental model ("a `tx.spawn` handle is usable as a value immediately, but not queryable until projection"). So in dev mode, **applying a `world.*` structural change to an *identity-only* handle warns or throws**, pointing the user to `sync()` first. Crucially this guard is phrased in pure **runtime-state** terms — "is this handle identity-only?" (`archetypeId[slot] == NO_ARCHETYPE`) — *not* "is this a durable handle awaiting projection?", so the core needs no knowledge of durability to enforce it (preserving the §12.1 layering). It happens to fire almost exclusively on the durable case, because that is the only way to hold an identity-only handle *at rest*: a `world.spawn` places immediately (never identity-only after the call), and a `ctx.spawn`'s handle is already deferred inside a system. The fix in practice is always the same — `world.sync()` to project, *then* mutate — which is why the worked example (§18) syncs before its local `addTag`.

**`ctx.destroy` is the mirror, and defers everything.** Destroy does *not* free identity eagerly: if it bumped the generation immediately, a handle held elsewhere would read as stale *this* phase while the entity is still placed and still in other systems' queries. So `ctx.destroy(e)` defers *both* placement removal and identity-freeing to flush, applied together — until the phase boundary the entity stays fully alive and queryable; at flush it vanishes atomically (placement removed, generation bumped, slot freed, all relation edges cleared inline — both incoming and outgoing, §5.4). The asymmetry is correct: spawn front-loads identity (the only way to hand back a usable handle without aliases); destroy front-loads nothing (the entity must stay consistent until it is gone).

### 5.3 `StructuralCommand` — the reified shape change

§5.1 forced a conclusion: a shape change discovered while iterating must be *recorded* and applied later. "Recorded" means represented as a value — and that value is a **`StructuralCommand`**: a tagged union over the runtime's shape-change operations, with all refs as real `Entity` handles (the runtime path has no aliases — `ctx.spawn` returns the real handle eagerly, §5.2).

**This is the *internal* format, so it is keyed by ids, not by strings.** Unlike the `{ Position: {...} }` object form the *examples* use (illustrative pseudocode, §4), `StructuralCommand` is the real recorded representation — so its component/tag/relation references are the interned **numeric ids** (`ComponentId`/`TagId`/`RelationId`, §3.4), never string names or loose objects. Initial components are carried as a **`ComponentInit`** — an explicit list of id+value pairs — which the public ergonomic API (`spawn({ components: {...} })` or the handle-keyed builder) *lowers into* at the call site:
```ts
type ComponentInit = Array<{ component: ComponentId; value: ComponentValue }>;   // internal, id-keyed — NOT string-keyed

type StructuralCommand =
  | { kind: "spawn"; entity: Entity; components?: ComponentInit; tags?: TagId[] } // entity = eagerly-minted handle
  | { kind: "despawn"; entity: Entity }
  | { kind: "addComponent"; entity: Entity; component: ComponentId; value: ComponentValue } // attach — entity must NOT have it
  | { kind: "removeComponent"; entity: Entity; component: ComponentId } // detach — entity must have it
  | { kind: "addTag"; entity: Entity; tag: TagId }
  | { kind: "removeTag"; entity: Entity; tag: TagId }
  | { kind: "setRelation"; entity: Entity; relation: RelationId; target: Entity } // arity "one"
  | { kind: "addRelation"; entity: Entity; relation: RelationId; target: Entity }
  | { kind: "removeRelation"; entity: Entity; relation: RelationId; target?: Entity };
```
The `ComponentId` here is the *runtime-internal* id (§3.4) — correct for this format, because a `StructuralCommand` never leaves the process (it is buffered, applied, and discarded within one tick). This is the runtime-side counterpart to the durable side's name-keyed storage: **runtime-internal formats (this command, `ChangeEvent`) carry `ComponentId`; durable documents carry `ComponentName`** (§3.4). Keeping the command id-keyed is what makes apply a fast integer dispatch with no string lookups.

Every member is a genuine **shape** change — one that adds/removes a component (archetype migration), toggles a tag (membership filter), or edits a relation (membership filter). **Value writes are deliberately absent**: writing a value into a component the entity already has is the *immediate* path (§5), never a buffered command, so it has no place in this union. This is what keeps `StructuralCommand` honestly structural — there is no member whose value-or-shape nature has to be decided at apply time.

The value/shape line is drawn at **authoring time by which method you call**, not at apply time by inspecting entity state:
- **`addComponent(e, C, v)`** — attach a component the entity does *not* have, with an initial value. A **shape** change → deferred inside a system. Throws if `C` is already present ("use `edit().set`").
- **`edit(e).set(C, v)`** (equivalently `writeComponent`) — overwrite the value of a component the entity *does* have. A **value** change → immediate, never buffered. Throws if `C` is absent ("use `addComponent`").
- **`removeComponent(e, C)`** — detach. A **shape** change → deferred. Throws if `C` is absent.

Each method asserts its precondition and does exactly one thing, so a command's timing is knowable from its `kind` alone. (Generic/data-driven code that genuinely doesn't know whether a component is present writes the one-line branch itself: `has(e, C) ? edit(e).set(C, v) : addComponent(e, C, v)` — the framework does not hide that distinction, because the value/structure split is load-bearing for the durable layer, §12.)

It is reified as plain data for one runtime reason: the gap between *deciding* a shape change (mid-iteration) and *applying* it (at the safe point) needs the decision to outlive the loop iteration that produced it, and a value is how you carry a decision forward in time. Applying a command is a single function — `apply(command)` — that switches on `kind` and performs the archetype migration / id op / map update. **Within the runtime, two producers create these commands:** system code (through the `ctx` facade — `ctx.spawn`, `ctx.addComponent`, … each build the matching command and enqueue it, §5.4), and that is the whole of the runtime's concern. `world.*` setup *outside* a tick does **not** produce commands — it applies shape changes immediately (no iteration to defer past, §5.2).

> **This vocabulary is deliberately reusable, but that is an upward fact, not a runtime concern.** Because `StructuralCommand` is plain serializable data keyed by runtime concepts, the durable (§12) and ephemeral (§15) layers *choose* to express their changes in the same shape so they can reuse this `apply`. The runtime core neither knows nor depends on that — it defines the command for its own deferral need. The reuse is described where it happens, in the layers above; here it is enough that the command is a value the runtime can record and replay.

### 5.4 The command buffer — a system-execution facility

The command buffer exists **only** because of in-system iteration. It is not a runtime-wide deferral queue; it is the mechanism by which *system code defers its own shape changes past its own column walk* (§5.1). This scoping is the whole of its design:

- `world.*` setup, outside a tick, applies immediately and **never allocates or touches a buffer** (§5.2).
- Inbound/durable changes apply at tick boundaries through the tick's own structure (§16), **not** through this buffer — they are a different layer's concern and the runtime core has no buffer shared with them.

So the buffer is a facility of *system execution*, surfaced through `ctx`.

**A buffer is allocated explicitly and referenced by a handle.** The runtime exposes a small surface:

```ts
type CommandBuffer = number; // an opaque handle to one buffer (not the storage itself)

allocateCommandBuffer(): CommandBuffer; // create a fresh empty buffer, return its handle
enqueue(buf: CommandBuffer, cmd: StructuralCommand): void; // append (producer-agnostic)
flushCommandBuffer(buf: CommandBuffer): void; // single-pass drain + clear (see below)
releaseCommandBuffer(buf: CommandBuffer): void; // return it to the pool when the phase is done
```

The handle-based shape — *allocate → get a handle → flush that handle later* — is deliberate: it is what permits **more than one live buffer at a time.** A single shared buffer would not need handles; the indirection exists so the design extends to multiple simultaneous buffers without changing the contract.

**Storage and allocation.** The backing storage (a growable array of command objects, Option A from §5.3's note) lives in a **pool on the runtime store**, allocated lazily and **reused across frames** — `allocateCommandBuffer` hands out a cleared buffer from the pool (growing the pool only when more concurrent buffers are needed than exist), and `releaseCommandBuffer` returns it. A buffer's array is `clear()`'d (length reset, not freed) on flush/release, so capacities stabilize after warmup and per-frame allocation is zero. Handles are indices into the pool; the storage is never exposed directly. This matches the runtime's other scratch-buffer discipline (allocate once, reuse, grow-on-demand).

**The tick owns the lifecycle; `ctx` carries the handle.** Buffers are allocated and flushed by the tick (§7), per phase:

```
for phase of pipeline:
  buf = allocateCommandBuffer() // this phase's buffer
  for system of phase:
    run system with a ctx bound to buf // ctx.spawn/addComponent/… → enqueue(buf, cmd)
  flushCommandBuffer(buf) // phase boundary: apply this phase's deferred changes
  releaseCommandBuffer(buf)
```

A system's `ctx` is **bound to the buffer it should enqueue into** — the system never sees the handle; `ctx.spawn(...)` calls `enqueue(buf, …)` under the hood with the `buf` its `ctx` carries. So `ctx`'s shape-change methods (§5.2) are a typed, ergonomic facade over `enqueue` against a pre-bound handle. This is *why* each phase clears its own buffer: the tick allocates one per phase, binds the phase's systems' `ctx` to it, and flushes-and-releases it at the boundary. (Sequential v1 uses exactly one buffer per phase. The handle API is what lets a future parallel scheduler allocate **one buffer per worker per phase** — each parallel system enqueueing into its own buffer with zero contention — and flush them in deterministic order at the boundary, with no change to the enqueue side. See §17.)

**Flush is a single pass.**

```
flushCommandBuffer(buf): // called ONLY at a phase boundary, never re-entrantly from a system
  for cmd in buf: apply(cmd)
  buf.clear()
```

No drain-until-empty, no wave structure, no cycle guard — because **apply never enqueues**. The only command with a cascade is `despawn`, which must clear **every relation edge touching the entity — both directions** — and that cleanup is applied **inline** (despawn's apply mutates the relation maps synchronously within its own call). Both directions, spelled out because each uses a different index (§3.3):

- **Incoming edges** (others → `e`, i.e. `e` as a *target*): the **reverse index** `reverse[R].get(e)` lists exactly the sources pointing at `e`; for each, remove `e` from that source's forward entry, then drop `reverse[R].get(e)` itself. This is the reverse-index cascade.
- **Outgoing edges** (`e` → others, i.e. `e` as a *source*): walk `e`'s own forward entries (`oneForward[R].get(e)` / `manyForward[R].get(e)` across every relation `R`), and for each target, remove `e` from that **target's reverse set**, then drop `e`'s forward entry. Without this, a destroyed source would leave stale reverse edges that a `getReverse(target, R)` would still return.

Both are `Set`/map deletions keyed by packed `Entity` handles, so both are O(edges) and **terminal** — relations aren't archetype-affecting, so clearing an edge triggers no further cascade, and inline application is finite. The buffer never grows during its own drain, which is what makes single-pass flush provably terminating. (The **identity-only** case is covered for free: an entity destroyed before it was ever placed — a `ctx.spawn` then `ctx.destroy` same phase, or a `tx.spawn`'d entity torn down before projection — may still have had tags or relations attached, §5.2, so despawn runs this same cleanup regardless of placement; the relation maps are `Entity`-keyed and never depended on a row, and the placement step itself is guarded by an `archetypeId[slot] != NO_ARCHETYPE` check, §5.5.)

**Despawn must also clear the slot's tag bits, and this is a correctness requirement, not housekeeping.** Tag bitsets are indexed by **slot**, not by generation (§3.2) — a bit is set at `bitset[T].set(slot)`, with no generation component. So when a slot is freed and later reused by a new entity, any tag bit left set from the *previous* occupant would be silently inherited by the *new* one, and because the bit carries no generation, no validate-on-read could catch it. Therefore despawn clears every tag bitset at the freed slot (`clearAllTags(slot)`, §5.5) as part of the same inline cleanup as relation edges — for placed *and* identity-only entities alike (an identity-only entity can carry tags, §5.2). This is the tag analogue of relation-edge cleanup: both are per-entity state living outside the archetype, and both must be torn down on despawn so a reused slot starts clean.

**Ordering is pure insertion order.** Commands apply in the order enqueued; a buffer is a strict FIFO. Bad orderings (e.g. relating to a just-destroyed entity) self-heal via the generational validate-on-read (§2, §3.3) — a reference to a freed slot is a generation mismatch and is skipped. Cheaper and more robust than replicating spawn-first/despawn-last discipline. The only cost: an entity receiving several shape changes in one phase migrates once per change rather than once total — editor-scale-negligible. (Under future parallel per-worker buffers, the merge order at the phase boundary is deterministic — buffers concatenated in worker index order — so the result is reproducible.)

**v1 does no coalescing — this is a spec decision, and it makes two same-phase sequences observable.** The buffer applies each command; it never cancels a pair or folds a spawn+despawn away. So, within one phase:
- `ctx.spawn(e)` then `ctx.destroy(e)` → at flush the spawn *places* `e` (into the empty archetype or its components' archetype) and the despawn *removes* it. `e` briefly exists during the flush and is gone by the phase boundary; no system ever observed it (systems ran before flush), so the only effect is a transient placement. Defined behavior, not a bug.
- `ctx.destroy(e)` then `ctx.addRelation(e, R, t)` → the despawn frees `e`'s generation; the later `addRelation` hits validate-on-read (`e`'s generation no longer matches) and is **skipped**. So the relation is silently not created. This is the intended, defined outcome — validate-on-read is what makes the out-of-order pair safe — and it is spec, not implementation detail: *a shape change enqueued after the entity's despawn in the same phase is dropped.*

Choosing "no coalescing" keeps the flush a single honest pass with no special-case pair detection; per-entity coalescing (fold an entity's multiple shape changes into one migration) is a marked optimization deferred until measured (below), and if added it must preserve exactly these observable outcomes.

**The load-bearing invariant:** a buffer is flushed only at a phase boundary, never re-entrantly from within a system. This guarantees nothing is iterating during flush, so nothing `apply` does (including the inline cascade) needs further deferral, and single-pass holds.

> **Two marked optimizations, deferred until measured.** (1) **SoA representation** — replace each buffer's array of command objects with parallel typed-array columns, eliminating per-command allocation; chosen against now because editor-scale structural volume is dozens per frame, not particle-scale. (2) **Per-entity coalescing** — at flush, group an entity's multiple shape changes into one migration. Both are pure optimizations of a locked design.

#### What deferral costs vs. direct mutation

Worth stating plainly, since the buffer wraps every in-iteration shape change. A buffered shape change differs from a direct one by exactly: **one small command-object allocation + one dispatch at flush.** The *migration itself* — the archetype column copy — is identical work whether applied now or at flush; the buffer only *delays* it, it does not make it more expensive. So the overhead is a cheap wrapper on an inherently more expensive, **rare** operation (shape changes are dozens/frame; value writes, which bypass the buffer entirely, are the hot path). And inside iteration the comparison is moot anyway: the alternative to the buffer is not "faster direct mutation" but a *corrupted iteration* (§5.1) — direct mid-iteration migration is incorrect, not merely slower. Outside iteration, where direct mutation *is* safe, the design already takes it (the immediate path, §5.2). So the buffer is paid only where it is mandatory, and where it is paid its cost is dominated by the migration it defers.

### 5.5 The execution layer — applying a command

Everything above produces commands and schedules flushes; this is where a command actually changes the typed arrays. `apply(command)` is the single entry point, but the twelve command kinds collapse into **five physical primitives** over the §3 structures — so `apply` is a thin dispatcher and the weight lives in the primitives, specified once here:

1. **place** — append an entity's row to an archetype's columns
2. **unplace** — remove an entity's row (swap-and-pop)
3. **migrate** — unplace from old archetype + place into new, copying overlapping fields (= add/remove component)
4. **bit/map mutation** — tag bitset flip (§3.2) or relation map update
5. **cell write** — write a value into an existing column slot (numeric or string)

`migrate` is literally `place + unplace` with a field-copy between, so the genuinely load-bearing code is **place** and **unplace** — and unplace is where the subtlety lives.

#### place — append a row

Putting entity `e` (whose identity already exists, §5.2) into archetype `A`. Columns are keyed by *field*, so the loop is over fields, not components (a `Position` write is two column writes, `Position.x` and `Position.y`):

```
place(e, A, fieldValues):
  row = A.count // next densely-packed row at the end
  for each field F in A.signature:
    A.columns[F][row] = fieldValues[F] // typed-array store, or string store for a string field (§3.4)
  A.entities[row] = e // row → entity back-pointer (§3.1)
  archetypeId[slot(e)] = A // entity table: where e's data now lives
  rowInArch[slot(e)] = row
  A.count++
```

After this the entity table resolves `e → A, row → data`, and the *bidirectional* link is intact: the table says where `e`'s row is, `A.entities[]` says which entity each row belongs to. Both directions are needed — which is exactly what unplace shows.

`place` works unchanged for the **empty archetype**: if `A.signature` is ∅ the field loop runs zero times, so `place(e, emptyArchetype, {})` just claims a row and sets the back-pointer — a componentless-but-live, queryable entity (§3.1, §5.2). Two thin helpers build on `place`:

```
ensurePlaced(e): // idempotent: place an identity-only entity into the empty archetype
  if archetypeId[slot(e)] is unset: // state 2 (identity-only) → state 3 (placed)
    place(e, emptyArchetype, {})
  // else already placed (any archetype) → no-op

spawnPlace(e, components, tags): // what a spawn does: place into the components' archetype (∅ if none)
  place(e, archetypeFor(components), components) // archetypeFor({}) IS the empty archetype
  for t in tags: tagBitset[t].set(slot(e))
```

`ensurePlaced` is the primitive a bare `spawn({})`/`spawn({tags})` and all *projection* (§10.3) use to make an entity queryable without waiting for a component; `archetypeFor({})` resolving to the empty archetype is what lets `spawnPlace` treat "no components" as just another archetype rather than a special case.

#### unplace — swap-and-pop, with the back-pointer fixup

Removing the row at `(A, row)` from archetype `A`. Shifting every later row down would be O(n); archetypes instead move the *last* row into the hole — **swap-and-pop**, O(1) — and this is where `A.entities[]` earns its existence. **`unplace` takes the archetype and row explicitly** — it does *not* re-read them from the entity table — because the caller (migration) may have already re-pointed the table elsewhere:

```
unplace(A, row, vacatingEntity): // explicit A + row; vacatingEntity = whose row this was
  last = A.count - 1
  if row != last:
    moved = A.entities[last] // which entity occupied the last row
    for each field F in A.signature:
      A.columns[F][row] = A.columns[F][last] // move last row's fields into the hole
      if F is a string field: A.columns[F][last] = null // INVARIANT: null the vacated source (§3.4, HRA below)
    A.entities[row] = moved
    rowInArch[slot(moved)] = row // **fix the MOVED entity's table pointer** (not vacatingEntity's)
  else:
    for each string field F in A.signature: A.columns[F][last] = null // INVARIANT: null the popped slot
  A.count--
  // NOTE: unplace NEVER writes archetypeId/rowInArch for `vacatingEntity` — by the time unplace
  // runs, that entity is either gone (despawn) or already re-pointed to its new archetype (migrate).
```

Two things are load-bearing here. First, the starred line: after swap-and-pop, the entity that *was* at `last` now lives at `row`, so **its** `rowInArch` must be corrected — found via the back-pointer `A.entities[last]`. This is *only* the moved entity; `unplace` deliberately leaves `vacatingEntity`'s table entry alone (the despawn path frees it separately; the migrate path already set it to the new archetype). Omit the fixup and the moved entity's handle silently resolves to the wrong row. Second, the **string-null invariant** (HRA): on every swap-pop, after copying `last → row`, the source string slot at `last` is set to `null`, and on a bare pop (`row == last`) the popped slot is nulled — otherwise the dead string above `count` stays referenced and never GCs. For typed-array columns this is unnecessary (a stale number is harmless and overwritten on next place); for **string columns it is mandatory**, especially in text-heavy editor documents where un-nulled slots would leak every deleted label. This swap-and-pop is precisely what §3.1 named in passing and what §5.1 means by "reorders the packed columns": a running loop that already passed `row`, or hasn't reached it, now sees the moved entity twice or not at all — which is *why* shape changes must defer out of iteration.

#### migrate — add / remove a component

`addComponent(e, C, v)` moves `e` from its archetype `A` to `B = A ∪ {C}`. The ordering is exact and not interchangeable — **capture the old location and read the carried values *before* anything writes the table, place into B (which re-points the table to B), then unplace from the *captured* old location**:

```
migrate(e, +C, v):
  oldA = archetypeId[slot(e)] // capture BEFORE place re-points the table
  oldRow = rowInArch[slot(e)]
  B = archetypeFor(oldA.signature ∪ {C}) // created lazily if new — see below
  carried = { F: oldA.columns[F][oldRow] for F in (oldA.signature ∩ B.signature) } // read old values now
  carried[fields of C] = v
  place(e, B, carried) // appends e's row to B AND sets archetypeId/rowInArch[slot(e)] = B,newRow
  unplace(oldA, oldRow, e) // swap-pop out of the OLD archetype, by captured location
```

The bug this ordering avoids: `place` updates `e`'s table entry to point at `B`. If `unplace` then re-derived the archetype/row from the table (`archetypeId[slot(e)]`), it would find `B` and wrongly swap-pop `e` out of the archetype it was just placed into. Passing the **captured `(oldA, oldRow)`** — and having `unplace` never touch `e`'s table entry — is what keeps `e` in `B` while correctly removing its abandoned row from `oldA`. `removeComponent` is the mirror with `B = oldA.signature − {C}` and no new values. **Read-before-place-before-unplace** is the whole correctness story.

**Lazy archetype creation:** when `B` doesn't exist, allocate its per-field columns (typed arrays, or a `(string|null)[]` for string fields), register it in the archetype index, and notify queries of the new archetype (§3.1, §6) — the only allocation on this path, amortized because signatures are finite.

#### cell write — value mutation, including strings

A value change (the immediate path, §5 — `edit(e).set(C, v)` / `writeComponent`, on a component the entity already has, §5.3) writes into an existing slot. For a **numeric/eid/enum** field it is a typed-array store: `A.columns[F][row] = n`. For a **string** field it is a direct assignment into the owning `(string|null)[]` (§3.4):

```
cellWrite(e, F, value):
  A = archetypeId[slot(e)]; row = rowInArch[slot(e)]
  A.columns[F][row] = value // numeric: typed-array store. string: column[row] = value, old string GC'd.
```

There is **no intern step** for value strings — the column owns the string, so a write is one assignment and the previous string becomes garbage (§3.4). (Enum fields go through the symbol registry at *schema* time, not per write; at write time an enum is already a small integer.)

#### relation update — keeping both maps in sync

Relations live in forward + reverse indices (§3.3); an update must touch both, and `setRelation` (arity "one") must drop the *old* target's reverse entry before installing the new one. Forward is a single handle for arity "one" and a `Set` for arity "many"; reverse is always a `Set`:

```
setRelation(e, R, t): // arity "one" — replace
  ensurePlaced(e) // the SOURCE gains membership → queryable (Option A, §5.2); target is NOT placed
  old = oneForward[R].get(e)
  if old !== undefined: reverse[R].get(old).delete(e) // unlink the previous target's reverse edge
  oneForward[R].set(e, t)
  reverse[R].get(t) ??= new Set(); reverse[R].get(t).add(e)
addRelation(e, R, t): // arity "many" — add an edge (idempotent: Set dedup)
  ensurePlaced(e) // source placed; target untouched
  manyForward[R].get(e) ??= new Set(); manyForward[R].get(e).add(t)
  reverse[R].get(t) ??= new Set(); reverse[R].get(t).add(e)
removeRelation(e, R, t?): // one edge if t given, else ALL of R from e
  targets = t ? [t] : [...(manyForward[R].get(e) ?? [oneForward[R].get(e)])]
  for target in targets:
    (arity "many" ? manyForward[R].get(e).delete(target) : oneForward[R].delete(e))
    reverse[R].get(target)?.delete(e)
```

All adds/removes are O(1) `Set` operations (no array splice), and `addRelation` is idempotent because a `Set` cannot hold a duplicate edge (§3.3). Keys and values are packed `Entity` handles, so these are migration-invariant (§3.3) — no fixup when endpoints move archetype.

#### `apply` — the dispatch

With the primitives, `apply` is a flat switch, each arm one or two primitive calls:

```
apply(cmd): // cmd is a StructuralCommand — the buffer's flush calls this
  if cmd has an entity ref and generation(cmd.entity) != generations[slot(cmd.entity)]:
    return // VALIDATE-ON-READ: entity was destroyed earlier this flush → no-op (§5.4)
  switch cmd.kind:
    spawn: spawnPlace(cmd.entity, cmd.components, cmd.tags) // place into components' archetype (∅ if none), set tags
    despawn: clearAllRelationEdges(cmd.entity) // inline, both directions (incoming + outgoing), terminal (§5.4)
                     clearAllTags(slot(cmd.entity)) // clear THIS SLOT's bit in every tag bitset — MANDATORY: tag
                                                         // bitsets are slot-indexed (§3.2), NOT generation-indexed, so a
                                                         // reused slot would otherwise inherit the dead entity's tags
                     if archetypeId[slot(cmd.entity)] != NO_ARCHETYPE: // PLACED → has a row to vacate
                       A = archetypeId[slot(cmd.entity)]; row = rowInArch[slot(cmd.entity)]
                       unplace(A, row, cmd.entity) // swap-pop out of its archetype
                     // else IDENTITY-ONLY (NO_ARCHETYPE/NO_ROW) → no row to unplace; tags/relations were still cleared above
                     freeIdentity(cmd.entity) // gen bump + freeList push (runs for both placed and identity-only)
    addComponent: migrate(cmd.entity, +cmd.component, cmd.value) // attach (precondition: absent — checked at ctx.addComponent)
    removeComponent: migrate(cmd.entity, −cmd.component) // detach (precondition: present)
    addTag: ensurePlaced(cmd.entity); tagBitset[cmd.tag].set(slot(cmd.entity)) // placed → tag-queryable (§5.2)
    removeTag: tagBitset[cmd.tag].clear(slot(cmd.entity))
    setRelation/addRelation/removeRelation: (the relation-update procedure above)
```

Every arm is a **shape** change — `apply` handles exactly the `StructuralCommand` kinds (§5.3), nothing else. **Value writes never reach `apply`**: `edit().set` (component value) and `setResource` (world-singleton value) are the immediate path (§5.2) — they write their cell directly (`cellWrite`, the resource cell) the instant they are called, buffered by nothing, because they reorder no columns. So the dispatch has no `setComponent` arm and no `setResource` arm: those are not commands, they are immediate writes.

**Structural preconditions are re-checked at *flush*, not trusted from enqueue.** `ctx.addComponent` validates "component absent" when you *call* it, which catches the common mistake immediately — but that check can go stale before flush, because another system in the same phase may enqueue a command that changes the same fact. Two systems both `ctx.addComponent(e, C)` in one phase each see `C` absent at enqueue (neither has flushed); at flush the first attaches `C` and the second's precondition is now false. So `apply` cannot assume enqueue-time validity; each arm re-checks at flush and follows a defined policy (this is the counterpart, for *preconditions*, of what validate-on-read is for *generations*):

| arm at flush | if precondition already satisfied | if not |
|---|---|---|
| `addTag` / `removeTag` | apply | **idempotent no-op** (bit already set / already clear) |
| `addRelation` (many) / `removeRelation` | apply | **idempotent no-op** (Set dedup / edge already gone) |
| `setRelation` (one) | apply | replaces — always well-defined |
| `removeComponent` | migrate to smaller archetype | component absent → **dev-mode warning, skip** |
| `addComponent` | migrate to larger archetype | component **present** → **dev-mode error, skip** (two systems added the same component; the value is ambiguous, so the framework refuses to silently pick one — use a value write if you meant to overwrite) |

The asymmetry is principled: tag/relation ops are *set membership* (idempotent by nature — applying twice is the same as once), so a stale precondition is harmless and silently absorbed; `addComponent` carries a *value*, so two conflicting adds have no safe merge and the second is surfaced as a bug rather than silently dropping or overwriting. `removeComponent`-when-absent is a no-op but likely a logic slip, so it warns. All of these are *skips that keep the flush a single honest pass* — none re-enqueue, none throw mid-flush (a throw during flush would strand the rest of the buffer), and the dev-mode diagnostics compile out of production builds. (`addComponent`/`removeComponent` still validate at the `ctx` surface too — that catches the *single-system* mistake at the call site, where the stack trace is useful; the flush-time check is only for the *cross-system same-phase* case the call-site check cannot see.)

**Validate-on-read sits at the top of every entity-taking arm.** It is what makes a bad ordering safe (§5.4): `addComponent(e, …)` enqueued after `despawn(e)` reads `e`'s now-bumped generation, sees the mismatch, and skips. And it cannot misfire on a *reused* slot mid-flush, because identity is minted **eagerly at enqueue time** (§5.2) — nothing pops the freeList *during* a flush (despawn pushes to it, but no spawn pops from it while draining), so within one flush a freed slot is never re-occupied. The guard therefore only ever catches "referenced an entity an earlier command this flush destroyed" — a bounded, well-defined case, which is what lets the single-pass flush (§5.4) and the guard compose correctly. (Generation-guard and stale-precondition policy compose: the generation check runs first — a command targeting a despawned entity is skipped outright — and only if the entity is still live does the precondition policy above apply.)

### 5.6 The four mutation paths, in one place

The command buffer is easy to over-read as "the mutation mechanism." It is not. It is **one** of four paths by which state changes, and it is specifically the *system-iteration safety* mechanism — the only path that buffers, and the only one a system-execution context produces. Spelling out all four at once prevents the confusion (they differ by *caller* and *timing*, sharing the same low-level `apply` primitives underneath):

| Path | Caller | When it applies | Uses the command buffer? | Writes runtime? |
|---|---|---|---|---|
| **Runtime setup** | `world.*` (outside a tick) | immediately | no | yes |
| **System shape change** | `ctx.*` (inside a system) | at the **phase boundary** (flush) | **yes** | yes |
| **Durable value commit** | `tx.edit().set` on an existing component (§12) | at **transaction seal** | no | yes (synchronously) |
| **Durable / ephemeral projection** | `world.sync()` draining a binding (§13, §15) | at the **sync boundary** | no | yes |

Two things this table makes unmissable. First: **the command buffer is not the general mutation mechanism; it is only the system-iteration safety mechanism** — three of the four paths never touch it, because they don't run inside iteration. (`world.*` setup, transaction commits, and projection all run outside any system walk, so they apply immediately or at their own boundary, §5.2.) Second: every path ultimately calls the *same* §5.5 primitives (`place`/`unplace`/`migrate`/cell write/relation update) — the buffer only governs *when* the system-path's primitives fire, never *what* they do. Value writes (`edit().set` on a present component, `setResource`) are immediate on every path because they reorder nothing; only **shape** changes are buffered, and only on the `ctx` path.

A note on the ephemeral store (Part IV): **`eph.*` *local* mutation is not a fifth *mutation* path** — it is ordinary immediate runtime mutation (row 1's timing), because your own ephemeral entities are ordinary runtime entities you mutate directly (§15.2). It is designed for use *outside* a tick (input handlers); inside a system, structural `eph.*` throws in **all builds** (there is no `ctx`-bound ephemeral mutator in v1, so it cannot defer, and mid-loop migration would corrupt iteration, §15.2) while a value `eph.edit().set` is allowed (reorders nothing, like row 3). What is otherwise distinct is *outbound* — the throttled/self-flushed send (§15.5) — a network concern, not a runtime-write path. Separately, *remote* ephemeral changes arrive by **projection at `sync()`** (row 4's timing), like all inbound. So the ephemeral store adds an outbound consequence on local writes and uses the projection path for remote ones; it introduces no new *local* runtime-write timing.

## 6. The query API — `defineQuery`

A `defineQuery` compiles **once** into a cached **`QueryPlan`** and is iterated every tick with no per-row object allocation in the hot loop (the plan itself is reused; the one allocation is a per-chunk iterator object, §6.2 — not per row, and per-query/per-chunk scratch is fine). It is *reading* — the consumer of the schema (§4), and one half of the `ECSStore` contract (§3). The key structural decision is **how iteration is exposed**: not as a row iterator (a per-row `.next()` across *all* rows would cost a call + result-object allocation per row, and would lose raw column access), but as **per-chunk dispatch** — the store calls the body *once per matching archetype*, handing it the raw columns and the row count; the body runs a plain inner loop. The abstraction boundary sits at the *chunk* level (dispatch is the store's job), the raw loop at the *row* level (full speed). This is the same shape the fast archetype ECSs use (Bevy `for_each`, flecs per-table `iter`, DOTS `IJobChunk`).

### 6.1 The plan — terms sorted by how they evaluate

Compilation sorts a query's terms by *where* they can be checked, because components, tags, and relations live in different structures (§3):

```
QueryPlan {
  componentMask: bits // required components → ARCHETYPE-level filter (coarse, once per archetype)
  excludeMask: bits // Not(component) → archetypes to skip
  rowFilters: Filter[] // tag / relation terms → ROW-level, evaluated per row (fine)
  seed?: () => Entity[] // set if a relation term has a CONCRETE target — flips iteration
  reads: Component[] // columns the body will touch
  matchingArchetypes: Archetype[] // cached; rebuilt when a new archetype is created
}
```

The split is the whole engine: **component terms become an archetype mask** (one bitmask superset test per archetype — an archetype matches if `(sig & componentMask) == componentMask && (sig & excludeMask) == 0`), while **tag and relation terms become `rowFilters`** (checked per row, because they vary row-to-row *within* an archetype — a tag is a slot bit, a relation a map entry, neither in the signature). A consequence worth naming for Option A (§5.2): a query with **no component terms** has an empty `componentMask`, so `(sig & 0) == 0` holds for *every* archetype **including the empty one** — which is exactly why `defineQuery([SomeTag])` finds a tag-only entity living in the empty archetype. The tag `rowFilter` then selects the matching rows; the empty archetype is not special-cased, it simply satisfies the empty mask like any other.

### 6.2 The dispatch — `each` over chunks

The store drives iteration; the body is a callback per matching archetype:

```
query(plan).each(fn):
  if plan.seed: // concrete-target relation → start from the index
    for e in plan.seed(): // (sublinear — only candidates, not all rows)
      A = archetypeOf(e); row = rowOf(e)
      if (A.sig & componentMask) != componentMask: continue // verify components
      if (A.sig & excludeMask) != 0: continue // verify Not(component)
      if not passesRowFilters(e, row, plan.rowFilters): continue // verify tags/other relation terms
      fn(singleRowChunk(A, row)) // body runs per matched entity in the seed case
    return
  for A in plan.matchingArchetypes: // OUTER loop: few iterations (dozens of archetypes)
    fn(chunk(A, plan.rowFilters)) // hand raw columns + count; rowFilters fuse into the row walk
```

A seeded query starts from the reverse-index hit set, but it still must satisfy *every other* term — so the seed branch re-checks the component masks **and the remaining `rowFilters`** (a query like `[Position, Frozen, Related(Targets, e6)]` seeds on `Targets→e6` but must still drop non-`Frozen` rows). Note the seed branch invokes the body **once per matched entity** (a single-row chunk each), versus once per archetype on the dense path; this is fine because seed sets are small, but a body that hoists per-chunk setup will run that setup per matched entity here.

> **v1 uses single-row seeded chunks; the design leaves room to group them.** Calling the body once per matched entity is the simple v1 behavior and is fine at editor scale (a seed set is usually a handful). But it does weaken the chunk-dispatch story at the extreme — if 500 entities all target one frame, that is 500 callback invocations where a grouped design would make one per archetype. The `Batch` contract is written so this can be optimized later **without changing bodies**: a future `SeededBatch` could carry `rows: Uint32Array` (the seed hits in one archetype) and dispatch once per archetype, with `for (const r of batch)` yielding those sparse rows and `count` their number — exactly the contract bodies already rely on (§6.2). So the grouping is a contained future optimization, not a v1 obligation; the interface already hides which form is in use.

A **`Chunk`** (`batch`) is the per-archetype handle the body receives: `count` (the number of **matched** rows — what `for…of` yields), `denseCount` (the raw dense row count, for the advanced loop), `col(Component)` → the raw typed-array column for that component (the typed, robust accessor), `entity(row)` → the handle at a row, and tag/relation accessors used when the plan filters or captures. There are **two ways to walk a chunk**, and the difference is the one performance subtlety worth being exact about:

- **`for (const r of batch)`** — the **filter-correct** form. The chunk's iterator yields only the rows that pass the plan's `rowFilters` (it fuses the filters as a `continue` internally: `for r: if (!filtersPass(r)) continue; yield r`), yielding exactly the matching rows — however many that is, discovered as it goes (there is no eager matched-count). This is what `defineSystem` bodies use, and it is the right default. Honest cost note: a `for…of` over the chunk's `[Symbol.iterator]` may allocate **one iterator object per chunk** (not per row) — so iteration is **no per-row *object* allocation in the hot loop**, not literally zero allocation, and it leaves room for per-query/per-chunk scratch. For the chunk *counts* typical of archetype ECS (dozens of archetypes per query), one small iterator object per chunk is negligible, and the inner work is still a tight numeric walk over raw columns.
- **`for (let r = 0; r < batch.denseCount; r++)`** — the **raw** form, genuinely zero-allocation. But `denseCount` is the archetype's *dense* row count, so this visits **every** row regardless of `rowFilters`. It is therefore valid **only for a dense, UNSEEDED, pure-component chunk** (`batch.isDense` true and no `rowFilters` — every row in a matching archetype matches, so every dense row is a matched row). Using it on a *filtered* query processes rows the filter should have excluded; using it on a *seeded* chunk (§6.4) iterates the whole backing archetype instead of the seed rows — both footguns, which is why `isDense` exists to gate it. Its name (`denseCount`, not `count`) is chosen so this form *reads* as the advanced/raw path it is.

The rule of thumb: **`for (const r of batch)` always; drop to the raw `for` loop over `denseCount` only for a query with no tag/relation filters, when profiling shows the per-chunk iterator object matters.** Pure-component queries pay nothing either way (their iterator is a bare `0..denseCount` walk with no filter predicate, and `count === denseCount`); filtered queries must use the `for…of` form (or check the filters by hand) to stay correct.

### 6.3 Worked example — components, tags, relations, operators together

Take a world with archetypes `A0:{Pos,Vel}`, `A1:{Pos,Vel,Health}`, `A2:{Pos,Health}`; `Frozen` set on some entities; `Targets` a relation.

**Pure component** — `defineQuery([Pos, Vel])`: `componentMask={Pos,Vel}`, no row filters. `each` calls the body for **A0 and A1** (both supersets; A2 lacks Vel). Each chunk's body walks `0..count` raw. Cost: one mask test per archetype, zero per-row overhead.

**Tag term** — `defineQuery([Pos, Vel, Frozen])`: `Frozen` isn't a component, so it can't narrow archetypes — it's a `rowFilter`. Matching archetypes are still A0, A1, but the chunk's row-walk skips rows whose `Frozen` bit is clear: `for r: if (!frozenBitset.has(slot(entity(r)))) continue; <body>`. Per-row bit test, `O(rows)`, fused, no allocation.

**Relation, abstract target** — `defineQuery([Pos, Related(Targets)])` (no target = "has some Targets edge"). A `rowFilter` probing the forward map per row, and the chunk *captures* the matched target so the body reads it via `batch.getRelated(r, Targets)` (an O(1) read of what the filter already looked up). `O(rows)` map lookups.

**Relation, concrete target** — `defineQuery([Pos, Related(Targets, e6)])`: "targets e6 specifically." Now the plan sets `seed = () => reverse[Targets].get(e6)` — the iteration **inverts**: start from the reverse-index hit set (just the entities pointing at e6), verify each has `Pos`, hand a single-row chunk. Instead of scanning every Pos-archetype row, it visits only the handful that point at e6 — sublinear. *The store picks this strategy when compiling the plan; the body is identical.* This strategy flip is a payoff of chunk-dispatch owning iteration — a row-iterator interface couldn't choose it.

### 6.4 Operators — where each lands

The principle: **component-shaped terms fold into the archetype masks; tag/relation-shaped terms become row filters; a concrete relation target flips to index-seeding.**

- **bare terms** → AND into `componentMask`.
- **`Not(X)`** → `Not(component)` into `excludeMask` (archetype-level skip); `Not(tag)` / `Not(Related)` into a *negative* `rowFilter` (skip rows where present).
- **`Any(...)`** → over tags, a `rowFilter` passing if any member bit is set (per-row OR); over components it expands to a union of archetype-sets (no single mask superset test fits).
- **`All(...)`** → explicit grouping; members fold into whichever level they belong to.
- **`Related(R, target?)`** → the single relation term; **omitted** target (`Related(R)`) → per-row presence filter + capture; **concrete** target (`Related(R, e)`) → reverse-index `seed`; `R.inverse` queries the reverse edge.
- no **`Or`** (use `Any`).

**Normalization — how the terms compose (so a mixed query has one unambiguous meaning).** A query is an **array of top-level terms that are AND-ed together**; each term is either a bare atom, a `Not(...)`, an `Any(...)`, an `All(...)`, or a relation term. The rules:
- **The top-level array is a conjunction.** `defineQuery([A, B, C])` means `A ∧ B ∧ C`. Order does not affect the result (only the plan's evaluation strategy, §6.1).
- **`Any(x, y, …)` is a disjunction *within that one term*** — it matches if *any* member holds — and it participates in the top-level AND as a single term. So `defineQuery([Any(A, B), C, Not(D)])` means exactly `C ∧ (A ∨ B) ∧ ¬D` — **not** `A ∨ (B ∧ C ∧ ¬D)`. `Any` never "captures" the terms after it; its scope is precisely its own arguments.
- **`Not(x)` negates its single argument** and AND-s in: `[A, Not(B)]` = `A ∧ ¬B`. `Not` wraps one atom (or one relation term); to exclude a disjunction, negate each: `A ∧ ¬B ∧ ¬C` is `[A, Not(B), Not(C)]`.
- **`All(x, y, …)` is an explicit conjunction group** — mostly sugar, since the top level is already AND, but useful *inside* an `Any` to express "this combination OR that one": `Any(All(A, B), C)` = `(A ∧ B) ∨ C`. This is the only way to get an AND-group inside an OR; the top-level array can't express it because the array itself is the outer AND.
- **Mixed atom kinds compose by their level, not their kind.** Whether a member is a component, tag, or relation changes *where it evaluates* (archetype mask vs. row filter vs. seed, per the folding rules above), **not** how it combines logically — `Any(SomeComponent, SomeTag)` is still "component-present OR tag-present," evaluated as a per-row OR that reads the archetype's component membership and the tag bitset together. So you can freely mix kinds inside `Any`/`All`/`Not`; the boolean structure is independent of the storage each atom lives in.
  - **Cost note: a mixed `Any` is cheaper-to-reason-about but not cheaper-to-run than a pure-component filter.** A pure-component `All(Position, Velocity)` is the fast case — it's an **archetype-mask** test, evaluated *once per archetype*, and non-matching archetypes are skipped wholesale without touching a single row. But `Any(Position, Selected)` **cannot be a simple component mask**: because `Selected` is a slot-indexed tag (§3.2), not part of archetype identity, the whole `Any` drops to a **per-row predicate** — for each row it must check component membership *and* probe the tag bitset, on every candidate row, since an archetype that lacks `Position` might still contain rows that have `Selected`. So mixing a component into an `Any` with a tag pulls that component *down* from archetype-level to row-level evaluation. It's still correct and still O(rows), just not the O(archetypes) fast path. The takeaway for query authors: **a pure-component `All` is the cheapest filter (archetype-level); mixing tags/relations into `Any` is row-level and costs a probe per candidate row.** Where it matters, prefer keeping the cheap component AND as the query's *spine* and adding tag/relation conditions as narrowing terms, rather than putting a component inside an `Any` alongside a tag.

The one nesting limit worth stating: nesting is supported to the depth these rules imply (`Any` of `All`s, `Not` of an atom), but there is deliberately **no arbitrary boolean-expression parser** — no `Not(Any(...))` De Morgan expansion, no `Any` of `Any`. Those are expressible by flattening (`Not(Any(A,B))` → `[Not(A), Not(B)]`; nested `Any` → one flat `Any`), and requiring the flat form keeps the planner's fold-to-level step simple and the query's cost transparent.

### 6.5 Costs and the one-hop boundary

Summarizing the cost model the machinery produces:
- **Components** → once per archetype (mask test). Dozens of tests per frame. Free per row.
- **Tags** → per row, slot-bitset probe, `O(N·t)`, fused, no allocation.
- **Relations** → `Related(R)` (any target) is a per-row map probe `O(N·r)` (+ capture); `Related(R, concrete)` seeds from the reverse index, sublinear (visits only entities pointing at the target).
- **Iteration** → per-chunk dispatch (few callback calls) + inner row walk; no per-row *object* allocation in the hot loop, no index array. (`for…of batch` may allocate one iterator object *per chunk*; the raw `for r<batch.denseCount` loop is zero-alloc but unfiltered-only, §6.2.)

The deliberate boundary: `Related` expresses **one-hop** relational constraints. **Multi-hop graph walks** (ancestors, descendants, transitive closure) stay **imperative** (`getReverse`, `getRelation`, a `traverse(R, root)` helper) — an unbounded-depth walk is genuinely not a flat columnar loop. The full operator semantics, the `Chunk`/`batch` surface, and the cost matrix are in the Part I API reference.

## 7. Systems and the tick pipeline

A **system** pairs a query (§6) with a body. The body **is the per-chunk callback** of §6.2: the system runner does `store.query(plan).each(batch => body(batch, ctx))`, so the body runs *once per matching archetype*, and `batch` is the `Chunk` — the query's components as raw typed-array columns. The primary accessor is `batch.col(C)` (typed against the component, robust to renames) — the recommended API in real code; `const { Position } = batch.columns` is an equivalent destructuring **convenience** (dev/demo sugar, loosely typed). Plus a row count, iterable over matching rows. `ctx` is world access (the mutation surface of §5, plus reads):

```ts
const movers = defineQuery([Position, Velocity]);
const Movement = defineSystem(movers, (batch) => {
  const Position = batch.col(Pos), Velocity = batch.col(Vel); // typed accessor (primary). Or destructure { Position, Velocity } for convenience
  for (const r of batch) { // r = each MATCHING row in this chunk (filters fused, §6.2)
    Position.x[r] += Velocity.x[r]; // raw typed-array indexing — value writes, immediate (§5)
    Position.y[r] += Velocity.y[r];
  }
});
```

The body never names archetypes or chunks explicitly — `defineSystem` runs it inside the dispatch. `for (const r of batch)` walks the chunk's matching rows (filters fused as `continue`, §6.2; one iterator object per chunk, no per-row *object* allocation in the hot loop). So a system iterating five entities across two matching archetypes invokes the body twice (once per archetype), each time over that archetype's matching rows. This is the abstraction paying off: the store drove *which* chunks via the `ECSStore.query` contract; the body owns the raw hot loop.

### 7.1 Pipelines are values

**The schedule is a value, not framework state.** Systems are grouped into **phases**, phases are composed into a **pipeline** (a plain array), and the pipeline is *handed to `tick`* — the world does not own "the schedule." A phase is a named, ordered group; the pipeline is a positional array; **array order is execution order** (no constraint solver, no `before`/`after`). A custom phase is just an array element, so there is no separate "add phase" API: composing the array *is* declaring the phases.

```ts
const pipeline = [
  phase("input", [GestureRecognition]),
  phase("simulate", [DragSystem]),
  phase("layout", [SnapToGrid, GroupBounds], { runIf: (ctx) => ctx.getResource(Grid).snap }),
];

world.tick(pipeline); // run this pipeline once
```

Because the pipeline is an argument, you can `tick` **different pipelines at different cadences** — a responsive sim pipeline every frame, a layout pipeline only when geometry changed, a housekeeping pipeline once a second — and a fixed-timestep loop is just ticking the sim pipeline N times before rendering.

**Run conditions** (`runIf`, a pure `(ctx) => boolean`) gate a system or a whole phase. A run condition is for gating on **non-query state** — a resource flag (`ctx.getResource(Grid).snap`), a mode, a timer, a frame counter — state the system's own query *can't* express. It is **not** for gating on whether a query is empty: a system over an empty query already iterates zero rows and does nothing, for free (sequential execution has no per-system scheduling overhead to skip). So there is no `hasAny(query)`-style condition — it would re-check, at a cost, something iteration already handles at no cost. (A parallel scheduler *would* want such a condition — §17. If a system does expensive setup *before* its loop, guard it with `if (batch.denseCount === 0) return` — an empty archetype matches nothing, and denseCount is the cheap exact check, §6.2.) For "skip this whole subsystem when nothing changed," gate at the pipeline level — don't `tick` the pipeline (the `if (geometryDirty) world.tick(layoutPipeline)` idiom).

### 7.2 The tick

`world.tick(pipeline)` runs the pipeline, allocating one command buffer per phase (§5.4) and flushing it at the phase boundary:

```
tick(pipeline):
  for phase of pipeline:
    if phase.runIf is false: continue
    buf = allocateCommandBuffer() // this phase's buffer (§5.4)
    for system of phase:
      if system.runIf is false: continue
      run system with ctx bound to buf // iterates packed columns; shape changes → enqueue(buf, cmd)
    flushCommandBuffer(buf) // BOUNDARY: this phase's shape output becomes visible to the next
    releaseCommandBuffer(buf)
```

The tick does not *implement* the buffer or flush — it allocates a buffer per phase, binds the phase's systems' `ctx` to it, and flushes-then-releases it at the boundary. The mechanism is §5.4's; the tick only decides the *cadence* (one buffer per phase, flushed at each phase boundary).

**There is no leading flush, and no inbound is applied here.** Inbound remote changes are *not* routed through the system command buffer (§5.4) — that buffer is system-execution-only. Inbound changes are applied by `world.sync()` (§16), which runs *outside* any tick and therefore outside iteration; per the placement rule (§5.2), changes applied outside iteration are applied **immediately**, with no buffer. So by the time a tick's first phase runs, `sync()` has already applied the frame's inbound changes directly to the runtime. The tick concerns itself only with system-produced shape changes, each phase's buffer flushed at its boundary.

The guaranteed invariant: **shape changes are visible at the next phase boundary.** Two consequences, both intended:
- A later phase sees what an earlier phase structurally did. (This is *why* phases are ordered.)
- A system does **not** see its own shape changes within the same phase — producer and consumer must be in *different* phases. This makes the phase boundary mean something.

**The complementary rule, for value writes: they are visible immediately — including to later rows and later systems in the same phase.** A value write (`edit().set` on a present component, a hot-loop `Position.x[r] += …`) is a direct column store with no buffering (§5.2, §5.3), so the new value is in the array the instant it is written. Two things follow, and they are the value-side mirror of the shape rule above:
- A system that writes `Position` on row `r` and *also* reads `Position` on a later row `r'` in the same walk sees the value it just wrote to `r` (it is the same array). Likewise a later *system* in the same phase reads the updated value — no boundary is needed for values to propagate.
- This makes value-write systems **order-dependent within a phase**: if system A writes a component that system B reads later in the same phase, B sees A's write; swap their order and it doesn't. This is ordinary ECS behavior (the schedule is the contract), but it is worth stating because it is *the opposite* of the shape rule — shapes wait for the boundary, values do not. It also applies to **durable value commits**: `tx.edit().set` writes the runtime synchronously (§13.2), so a value it commits mid-phase is visible to later rows/systems in that same phase, exactly like a plain value write.

Put together: **within a phase, values flow immediately and are order-sensitive; shapes are withheld until the boundary and so are order-*insensitive* across the phase** (every system in the phase sees the same pre-flush archetype layout). The two rules are why a system may freely read-modify-write component values in its loop, but must not assume its structural changes are visible until the next phase.

There are **no built-in phases** — phases are entirely user-defined. `tick` is network-free: draining inbound remote changes is a separate once-per-frame operation (`world.sync()`), and there is no `RENDER` stage — rendering is the user's concern, done after `tick` returns. The layers (Parts III–IV) contribute their inbound drain through an interface the world calls inside `sync`; the full frame loop, with layers, is in §16.

## 8. Local snapshot — non-collaborative save/load

Persistence, in the core, is an **on-demand** concern fully outside the tick. The runtime is the source of truth; a snapshot is a serialization of it; loading rebuilds the runtime from a snapshot. Nothing in the hot path touches this. This is the **non-collaborative** path — for multi-user documents that sync and merge, use the Durable layer (Part III).

> **Why local snapshot lives in Part I.** It is core-only: it serializes the runtime and nothing else, has a single writer, and never merges. It shares the *representation* and the *runtime-walk* with the durable layer (both build the same entity-record shape from the same column traversal — see Part II), but it deliberately does **not** share *identity*: a single-writer file needs no collision-free keys. Local snapshots key entities by a **dense integer assigned at export time**, not a document key. Pretending otherwise would imply a sync capability the file does not have.

### 8.1 Snapshot shape

A snapshot is a plain, compact serialization of the three buckets plus resources. There is **no string table to carry** — value strings are owned per-cell (§3.4), so they serialize as themselves, and the symbol registry (identifier strings) is schema-derived, repopulated from the schema on load rather than from the snapshot:

```
Snapshot:
  meta: { name, format_version }
  resources: { ResourceName: value, ... }
  entities: [
    {
      id: integer, // dense index, stable within the snapshot
      components: { CompName: { ...fields } } // string fields stored as their actual strings
      tags: [ TagName, ... ]
      relations: { RelName: id | [id, ...] }
    },
    ...
  ]
```

Serialization is mechanical because components are flat numeric/string records: walk each archetype's columns row by row, emit per-entity records (or, more compactly, **per-archetype columnar** blocks that match the in-memory layout and compress well). A `string` field's column already holds the actual string (no handle to resolve, §3.4), so the snapshot is portable across runs with no string-table translation. Numeric fields serialize as their values; **enum fields serialize as their discriminant** — which is safe across schema changes *only if* the schema used explicit discriminants (`enumOf({...})`, §4). A local snapshot loaded by the same code that wrote it can use positional enums (the variant order round-trips in one process), but a snapshot that might outlive a schema edit — or a durable document — must use explicit discriminants, or a reordered enum silently changes the meaning of stored data (§4).

### 8.2 Loading — two phases

Loading rebuilds the runtime from empty in **two passes**, because relations reference entities that may not exist yet when first encountered:

1. **Create all entities.** Allocate a slot per snapshot entity, write component columns (string fields written directly into their `(string|null)[]` column — no interning, §3.4), set tag bits. Build a map from snapshot `id` → freshly allocated runtime handle.
2. **Resolve relations.** Walk the relations again, translating each snapshot `id` to its runtime handle via the map, and populate the forward + reverse indices.

The two-phase split guarantees every reference target exists before references are wired, so there are no ordering constraints on the entity list. (This same two-phase shape recurs in Part III's projection, for the same reason.)

### 8.3 Where snapshots come from / go

Snapshots are just bytes — write them to disk, IndexedDB, or a server; read them back the same way. Save/load is an explicit call (`world.export()` / `world.import()`), not a per-frame cost. Autosave, if wanted, is a timer that calls `export` off the hot path.

---

## Part I — API reference

The public surface for this part. Signatures are TypeScript sketches. **Note on `spawn` init:** the reference uses the *real typed* component-init shape, not the `{ Position: {...} }` object form the prose examples use for readability (that form is illustrative pseudocode, §4). The typed shape is handle-keyed tuple pairs, so each value is checked against its component's field type:
```ts
type ComponentEntry<S = unknown> = readonly [Component<S>, S]; // a component handle + a value of ITS field type S
type SpawnInit = { components?: ComponentEntry[]; tags?: Tag[] }; // what spawn() actually takes
// Example (typed): world.spawn({ components: [[Position, { x, y }], [Size, { w, h }]] })
// or via a builder:  world.spawn(withComponents(Position({ x, y }), Size({ w, h })))
// The prose's world.spawn({ components: { Position: { x, y } } }) is the SAME call shown ergonomically (§4).
```

### API — field types (component schema values)

Every one stores as a number in a typed array (§4).

| Type | Storage | Notes |
|---|---|---|
| `"f32"` / `"f64"` | `Float32Array` / `Float64Array` | Floating point. |
| `"i8"`/`"i16"`/`"i32"` | `Int8/16/32Array` | Signed integer. |
| `"u8"`/`"u16"`/`"u32"` | `Uint8/16/32Array` | Unsigned integer. |
| `"bool"` | `Uint8Array` | 0/1. |
| `"eid"` | `Uint32Array` | Entity reference (generational, validate-on-read, §2). |
| `"string"` | `(string\|null)[]` | Freeform text owned per-cell (§3.4). For closed fast-compare sets use `enum`. |
| `"key"` | `(string\|null)[]` | **Storage-identical to `string`**, but **type-branded as `EntityKey`** at the API surface. The Part I runtime stores it as a plain string column and knows nothing of durable keys — but the *typed* read/write surface presents the field as `EntityKey \| null`, not plain `string`, so TypeScript catches passing an arbitrary string where a key is expected (`EntityKey` is a branded `string` type, §14.3). This is pure type-level intent: at runtime it is still `(string\|null)[]`, the runtime stays key-ignorant, and higher layers (Part III) / tooling read the brand for validation. For persisted/cross-store references, not graph edges (use a relation for those). See §14.3. |
| `enumOf([...])` / `enumOf({...})` | smallest int array | Enum. Array = positional discriminants (local only); object = **explicit stable discriminants** (durable, §4). |

```ts
// Positional (local-only): stored value is the array index — DO NOT persist/sync (reorder = silent corruption, §4).
function enumOf(variants: string[]): FieldType;
// Explicit discriminants (durable-safe): stored value is the number you assign — reorder-proof.
function enumOf(variants: Record<string, number>): FieldType;

// A field with an optional default (§4). Bare "f32" is shorthand for field("f32") — required, no default.
function field(type: ScalarType | ReturnType<typeof enumOf>, opts?: { default?: unknown }): FieldSpec;
```

### API — definition functions

```ts
function defineComponent<S extends Schema>(name: string, schema: S): Component<S>; // fields restricted to the field-types table above
function defineTag(name: string): Tag; // zero-sized; always a bitset
function defineRelation(name: string, opts?: {
  arity?: "one" | "many"; // default "one"
  ordered?: boolean; // default false; "many" only
}): Relation; // typed directed link; fwd+rev indices
function defineResource<S extends Schema>(name: string, schema: S): Resource<S>; // world singleton
```

### API — query API

```ts
function defineQuery(terms: QueryTerm[]): Query; // compiles ONCE to a cached QueryPlan (§6.1)

function Not(x: Component | Tag | RelTerm): QueryTerm; // exclusion
function Any(...xs: (Component | Tag | RelTerm)[]): QueryTerm; // at-least-one-of
function All(...xs: (Component | Tag | RelTerm)[]): QueryTerm; // explicit all-of / nesting

function Related(r: Relation | RelInverse, target?: Entity): RelTerm; // omit target = ANY edge; give one = that specific target
// `r.inverse` matches the reverse edge; a concrete target SEEDS from reverse(target, R)
// (sublinear); OMITTING the target (Related(R)) is a per-row presence check that also captures
// the matched target for batch.getRelated (§6.2). No named variables. Bare terms AND; no Or (use Any).
```

A query compiles to a **`QueryPlan`** (§6.1): a `componentMask` + `excludeMask` (archetype-level), a list of `rowFilters` (tag/relation terms, per-row), an optional `seed` (set when a relation term has a concrete target, flipping to reverse-index iteration), and the cached matching-archetype list. The plan is consumed only by `defineSystem`; it is not iterated directly. A system may supply a concrete target per run via `defineSystem(…, { target })`.

### API — system API, the batch (chunk), and ctx

```ts
function defineSystem(query: Query, body: (batch: Batch, ctx: SystemCtx) => void): System;
```

The body **is the per-chunk callback** (§6.2): the runner does `store.query(plan).each(batch => body(batch, ctx))`, so it runs **once per matching archetype**. `Batch` is the `Chunk` — the query's components as raw typed-array columns, iterable over matching rows (with `rowFilters` fused as `continue`). `SystemCtx` is world access.

```ts
interface Batch extends Iterable<number> { // the per-archetype Chunk (§6.2)
  denseCount: number; // RAW archetype row count — the ONE cheap, always-exact number.
                                                   // 0 … denseCount-1 are all live rows in this archetype (unfiltered).
                                                   // For a SEEDED chunk (§6.4), denseCount reflects the BACKING
                                                   // archetype, NOT the seed count — so the raw 0..denseCount loop is
                                                   // WRONG on a seeded chunk (it would iterate the whole archetype
                                                   // instead of the seed rows). Guard with isDense (below).
  isDense: boolean; // TRUE only for a dense, UNSEEDED chunk. The raw `for r<denseCount` loop is valid ONLY when
                    // isDense && the query is pure-component (no rowFilters). It is NEVER valid on a seeded chunk,
                    // even if the body reads only components (§6.4). When in doubt, iterate — `for…of` is always right.
  // NOTE: there is deliberately NO eager `count` of *matched* rows. On a filtered query, matched rows are
  // discovered only by evaluating the rowFilters, so an exact matched-count before the loop would require a
  // PRE-SCAN (doubling filter work) or a materialized match list (allocation) — both break §6.2's no-pre-scan,
  // no-per-row-object-allocation promise. If you need the matched count, COUNT DURING for…of. If you need
  // "is anything matched?", check inside the loop or use denseCount==0 as a fast pre-filter (an empty archetype
  // matches nothing). Seeded chunks are the one place a cardinality is cheap and exact: the seed set size.
  col<S>(c: Component<S>): ColumnsOf<S>; // THE primary, fully-typed column accessor: batch.col(Pos).x is a Float32Array.
                                         //   This is the only recommended API for column access in real code.
  columns: Record<string, ColumnsOf<any>>; // name-keyed convenience ONLY (`const { Position } = batch.columns`) —
                                           //   dev/demo sugar, loosely typed (ColumnsOf<any>). Prefer col() in real code.
                                           //   (A proper Record, not a string index signature on Batch — the latter
                                           //   would force denseCount/col/entity to be ColumnsOf<any> and break typing.)
  entity(r: number): Entity; // packed handle for row r (r is an archetype row index)
  getRelated(r: number, rel: Relation | RelInverse): Entity; // target captured by a Related(R) (any-target) term
  getAllRelated(r: number, rel: Relation | RelInverse): Entity[];
  [Symbol.iterator](): Iterator<number>; // `for (const r of batch)` → the matched rows (filters fused, §6.2)
}
```

**The iteration contract, with the cost honesty made explicit.** `r` is always a **real archetype row index** — `batch.col(Position).x[r]` and `batch.entity(r)` are valid for any `r` the batch yields, on both the dense and the seeded path. There is exactly one count, `denseCount`, and one way to get matched rows, the iterator:
- **`denseCount` is the raw archetype row count** — cheap and always exact (it's just the archetype's live-row count). `0 … denseCount-1` walks *every* row unfiltered; the raw `for (let r = 0; r < batch.denseCount; r++)` loop is the zero-allocation form, valid **only when `batch.isDense` and the query is pure-component** (no `rowFilters`, so every dense row matches). It is **never valid on a seeded chunk** (§6.4), *even if the body reads only components and has no row filters in the ordinary sense* — because a seeded chunk's `denseCount` is the *backing archetype's* size, not the seed count, so the raw loop would silently iterate the whole archetype instead of the seed rows. This is the sharp footgun: "no row filters" is *not* sufficient license for the raw loop; "dense **and** unseeded" is. When unsure, iterate with `for…of`, which is correct on every chunk kind.
- **Matched rows come only from `for (const r of batch)`**, which fuses the `rowFilters` as a `continue` and yields exactly the matching rows. There is **no eager `count` of matched rows**, and that omission is deliberate: knowing the matched count *before* the loop would force the runtime to either **pre-scan** the archetype (evaluating every `rowFilter` twice) or **materialize a match list** (an allocation) — both of which would silently break the §6.2 promise of no pre-scan and no per-row object allocation. So the rule is: **if you need "how many matched," count inside the `for…of`; if you need "is anything matched," test in the loop (or use `denseCount === 0` as a fast pre-filter, since an empty archetype matches nothing).** A `defineSystem` body that just iterates and does per-row work never needs a matched count at all — it does the work as it goes.
- **Seeded chunks are the one exact cardinality.** A concrete `Related(R, e)` query (§6.4) starts from the reverse-index hit set, whose size is *known without scanning*, and the body runs once per hit — so a seeded chunk legitimately has a known small cardinality. This is the only place a matched count is cheap, because it comes from an index lookup, not a filter scan.

The hard API rule that falls out: **never assume matched rows are `0 … denseCount-1` on a filtered query, and never assume a cheap matched-count exists.** `denseCount` is a raw archetype size; the iterator is the only portable source of matched row indices. A body written this way is also drop-in for a future archetype-grouped seeded dispatch (§6.4), because it never depended on an eager cardinality.

```ts
interface SystemCtx {
  // (row→entity is `batch.entity(r)`, on the Batch — the row belongs to the chunk, not to ctx)
  getResource<S>(res: Resource<S>): S | undefined; // world singleton; undefined if unset (no throwing twin — §13.4)

  // --- READS (immediate) ---
  read<S>(e: Entity, c: Component<S>): S; // whole-component read — THROWS if absent (hot-path)
  get<S>(e: Entity, c: Component<S>): S | undefined; // safe read — undefined if absent/identity-only (§5.2)
  readEid(e: Entity, c: Component, field: FieldId): Entity | undefined; // validated eid-field read
  hasTag(e: Entity, t: Tag): boolean;
  getRelation(e: Entity, r: Relation): Entity | undefined; // by entity — arity "one"
  getRelations(e: Entity, r: Relation): Entity[]; // by entity — arity "many"
  getReverse(e: Entity, r: Relation): Entity[]; // by entity — who points at e
  firstOf(q: Query): Entity | undefined;
  // NOTE: the row-captured accessors getRelated(row)/getAllRelated(row) live ONLY on Batch (§6.2) —
  // they take a batch ROW, which is in scope only inside the chunk body. From ctx you have an ENTITY
  // handle, so use getRelation(e)/getRelations(e). Keeping getRelated off ctx prevents passing an
  // entity where a row is expected (the footgun).

  // --- VALUE WRITES (immediate — §5) ---
  edit(e: Entity): EntityEditor; // editor.set(C, {...}) — value write; throws if C absent (use addComponent)

  // --- SHAPE CHANGES (all deferred to the next phase boundary — §5) ---
  // Enqueued as StructuralCommands; none apply immediately; none are visible to queries/reads
  // until the next phase.
  spawn(init?: SpawnInit): Entity; // mints the real handle NOW (identity eager, placement deferred — §5).
                                   //   SpawnInit = handle-keyed ComponentEntry[] (typed, above); lowers to the
                                   //   id-keyed ComponentInit of the StructuralCommand internally (§5.3).
                                                    // (identity eager, placement deferred — §5);
                                                    // the returned handle is usable immediately as a value
  destroy(e: Entity): void; // defers placement AND identity-freeing together
  addComponent(e: Entity, c: Component, v: object): void;
  removeComponent(e: Entity, c: Component): void;
  addTag(e: Entity, t: Tag): void; // deferred too (uniform shape-change rule, §5)
  removeTag(e: Entity, t: Tag): void;
  addRelation(e: Entity, r: Relation, target: Entity): void;
  removeRelation(e: Entity, r: Relation, target?: Entity): void;
}

interface EntityEditor { set<S>(c: Component<S>, v: S): this; } // whole-component IMMEDIATE value write
```

**`read` vs `get` — choose by whether the entity's lifetime is yours to guarantee.** These are the two component readers, and picking the right one is a correctness matter, not a style preference, so the rule belongs here where you first meet them (not buried in a cross-cutting section):
- **`read(e, C)` throws if `C` is absent** (including on an identity-only entity, §5.2). It is the **hot-path** reader — use it when the entity's presence and component are *guaranteed by context*: a row your own query yielded this frame (the query matched `C`, so it's there), or an entity your system owns and controls the lifetime of. In a `defineSystem` body iterating `[Position, Velocity]`, `ctx.read(e, Position)` is correct and fast — the query guarantees `Position`.
- **`get(e, C)` returns `S | undefined`** — the **safe** reader. Use it for any handle whose liveness you *cannot* guarantee at the moment of the read: a handle you **stored** across frames or cached, a **gesture/interaction target**, a durable or ephemeral **projection** of a shared entity, or anything **another peer may despawn** (a remote despawn lands at a `sync()` boundary and invalidates the handle, §13.3/§13.5). `get` returns `undefined` instead of throwing, so the caller can branch (end the gesture, drop the cache entry) cleanly.

The single sentence: **`read` for entities a query or local ownership guarantees this frame; `get` for stored handles, gesture targets, projections, and anything a collaborator might delete.** The collaboration case is the sharp one — §13.5 revisits it — but the rule is the same everywhere: if you're not certain the entity is placed and present *right now*, use `get`.

### API — the mutation layer (§5)

`ctx`'s shape-change methods above are an ergonomic facade; underneath, a shape change is a **`StructuralCommand`** recorded in a **command buffer** and applied by **`apply`**. This surface is mostly internal (the tick and `ctx` drive it), but it is core Part I machinery, specified in §5.

```ts
// The reified shape change — a tagged union over the runtime's shape ops, refs as real Entity (§5.3).
// INTERNAL format: id-keyed (ComponentId/TagId/RelationId), NOT string-keyed — the { Position: {...} }
// object form is illustrative pseudocode only (§4). Initial components are a ComponentInit list, into
// which the public ergonomic spawn() form is lowered at the call site.
// STRUCTURAL kinds only: no setComponent (that split into addComponent (shape) + edit().set (value)),
// no setResource (an immediate world-singleton value write). Value writes never enter the buffer.
type ComponentInit = Array<{ component: ComponentId; value: ComponentValue }>;  // id-keyed
type StructuralCommand =
  | { kind: "spawn"; entity: Entity; components?: ComponentInit; tags?: TagId[] }
  | { kind: "despawn"; entity: Entity }
  | { kind: "addComponent"; entity: Entity; component: ComponentId; value: ComponentValue } // attach — precond: absent
  | { kind: "removeComponent"; entity: Entity; component: ComponentId } // detach — precondition: present
  | { kind: "addTag"; entity: Entity; tag: TagId } | { kind: "removeTag"; entity: Entity; tag: TagId }
  | { kind: "setRelation"; entity: Entity; relation: RelationId; target: Entity }
  | { kind: "addRelation"; entity: Entity; relation: RelationId; target: Entity }
  | { kind: "removeRelation"; entity: Entity; relation: RelationId; target?: Entity };

// The command buffer — a system-execution facility, referenced by an opaque handle (§5.4).
// Handles permit MULTIPLE live buffers (one per phase now; one per worker per phase under
// future parallelism — §17). Storage is a pool on the runtime store, reused across frames.
type CommandBuffer = number; // opaque handle, not the storage

allocateCommandBuffer(): CommandBuffer; // hand out a cleared buffer from the pool
enqueue(buf: CommandBuffer, cmd: StructuralCommand): void; // append (producer-agnostic — only ctx calls it)
flushCommandBuffer(buf: CommandBuffer): void; // single-pass: for cmd in buf: apply(cmd); clear
releaseCommandBuffer(buf: CommandBuffer): void; // return to the pool when the phase is done

// apply — the execution layer (§5.5). Internal; flush calls it per command. Validates the
// entity's generation first (no-op on a stale handle), then dispatches to one of five primitives:
// place · unplace · migrate · bit/map mutation · cell write.
// Not public surface — listed so the buffer's behavior is traceable end to end.
apply(cmd: StructuralCommand): void;
```

The discipline (§5): **only system code (via `ctx`) enqueues**; `world.*` setup, projection, and inbound all apply immediately and never touch a buffer. A buffer is flushed *only* at a phase boundary, never re-entrantly from a system. `apply` never enqueues (the despawn cascade is inline), so flush is a single pass. Value writes (`edit().set` on a present component; `setResource`) bypass the buffer entirely — they are immediate (they reorder no columns, §5.3).

### API — world (core surface)

```ts
function createWorld(opts?: { name?: string }): World; // instantiates a RuntimeStore as its ECSStore (§3)

interface World {
  // RUNTIME entities/components/tags/relations — DELEGATED to the held ECSStore (§3). World adds
  // no representation knowledge; it forwards. Outside the tick, shape changes are IMMEDIATE
  // (nothing is iterating, so it is safe — §5); the store applies them directly.
  spawn(init?: SpawnInit): Entity; // placed immediately (SpawnInit = ComponentEntry[], typed — §ref intro)
  destroy(e: Entity): void;
  isAlive(e: Entity): boolean; // TRUE for states 2 (identity-only) AND 3 (placed) — "not dead," NOT "queryable"
  isPlaced(e: Entity): boolean; // TRUE only for state 3 — placed in an archetype ⇒ queryable AND component-readable.
                                       // THIS is the check that answers "can I read its components / will queries see it?"
                                       // (public: interaction code should prefer this over isAlive when it means "ready")
  isIdentityOnly(e: Entity): boolean; // TRUE only for state 2 — alive but not yet placed (e.g. a tx.spawn handle before
                                       // projection, §12). Mostly a dev/diagnostic check; equals isAlive && !isPlaced.
  addComponent<S>(e: Entity, c: Component<S>, v: S): void; // attach (shape) — throws if already present
  removeComponent(e: Entity, c: Component): void; // detach (shape) — throws if absent
  addTag(e: Entity, t: Tag): void;
  removeTag(e: Entity, t: Tag): void;
  // setRelation/addRelation are STRUCTURAL, not mere map writes: each calls ensurePlaced(e) on the SOURCE,
  // placing an identity-only source into the empty archetype so it becomes queryable (§5.2). The TARGET is
  // NOT placed by being pointed at. Implementers must do the placement, not just update the relation maps —
  // forgetting ensurePlaced would leave a relation-source-only entity unqueryable, violating §5.2.
  setRelation(e: Entity, r: Relation, target: Entity): void; // arity "one" — set/replace; ensurePlaced(e) (structural)
  addRelation(e: Entity, r: Relation, target: Entity): void; // arity "many" — add edge; ensurePlaced(e) (structural)
  removeRelation(e: Entity, r: Relation, target?: Entity): void; // remove edge(s); does NOT unplace the source
  edit(e: Entity): EntityEditor; // edit(e).set(C, v) = value write (throws if C absent)
  setResource<S>(res: Resource<S>, value: S): void;
  getResource<S>(res: Resource<S>): S | undefined; // undefined if absent (§13.4)

  // Pipelines + the frame (§7, §16). The schedule is a VALUE passed to tick, not world state.
  tick(pipeline: Pipeline): void; // for each phase: run gated systems, flush that phase's buffer. Any cadence.
  sync(): void; // drain all attached InboundSources → apply immediately. Once per frame. In a PURE Part I
                //   world (no durable/ephemeral layer attached) there are no sources, so sync() is a NO-OP —
                //   its presence here does not make Part I depend on Parts III-IV; it is the hook those
                //   optional layers register into (§16). Safe (and free) to call in the frame loop regardless.

  // Local snapshot (Part I §8) — non-collaborative, explicit
  export(): Uint8Array;
  import(bytes: Uint8Array): void;
}

// What the world knows about a layer's inbound rhythm — the ENTIRE coupling (§16.1).
interface InboundSource { drain(): void; } // apply pending remote changes immediately (sync is outside iteration)
```

### API — the schedule (pipelines + phases)

The schedule is a value passed to `tick`, not world state (§7). A `Pipeline` is a positional array of phases; **array order is run order** (no solver). A phase groups systems (also positional); a custom phase is just an array element, so there is no "add phase" API.

```ts
type Pipeline = Phase[];

function phase(name: string, systems: System[], opts?: { runIf?: Condition }): Phase;
// `name` is a debug/profiling label (there is no lookup-by-name — systems enter only via the array).
// systems run in array order; a phase whose runIf is false is skipped wholesale.

type Condition = (ctx: SystemCtx) => boolean; // pure gate for a system or a phase (runIf)

// per-system gating is on defineSystem's options or at composition:
function defineSystem(query: Query, body: SystemBody, opts?: { runIf?: Condition }): System;

// Conditions gate on NON-QUERY state — resources, mode, time, frame counters. There is
// deliberately no hasAny(query)-style condition: a system over an empty query is already a
// free no-op under sequential execution, so gating on query-emptiness would re-check, at a
// cost, what iteration handles at no cost (§7). Helpers are resource/time-shaped, e.g.:
// resourceEquals(res, value) · everyNFrames(n) · afterDelay(ms)
```

`tick(pipeline)` runs: for each phase (skip if `runIf` false) each system (skip if `runIf` false), with that phase's command buffer flushed at the phase boundary (§7). To change the schedule you build a new array and pass it — pipelines are plain values, composable by array spread, so modules can export phases/systems and the app assembles them.

### API — the entity handle

There is no entity builder. Both `world.spawn(init?)` and `ctx.spawn(init?)` take an optional `{ components, tags }` object and return a real `Entity` handle directly (see the system/`ctx` and world surfaces above); `ctx.spawn`'s handle is usable immediately as a value though the entity is placed at the next phase boundary (§5). `EntityEditor` (from `edit(e)`) is the immediate whole-component value-write surface.

```ts
type Entity = number; // packed u32: generation (high) + index (low) (§2). Runtime-local, disposable.
```

`Entity` is opaque to user code: pass it, store it in `eid` fields, hand it to `Batch`/`World`/`ctx` methods. Generation makes stale handles detectable. **Valid only within one attach lifetime** when used as a projected durable entity (§13.1).

### API — `ECSStore` (the representation-agnostic contract)

The complete operational contract over ECS state (§3) — general CRUD plus query, saying nothing about storage. `World` and `ctx` hold an `ECSStore` and delegate to it; `createWorld` instantiates a `RuntimeStore` (below) as the concrete `ECSStore`.

```ts
interface ECSStore {
  // entities / components / tags / relations — general CRUD. Every op is IMMEDIATE (§3); deferral
  // is the SystemCtx wrapper's concern, not the store's — the store has no "am I iterating?" mode.
  spawn(init?: SpawnInit): Entity;
  destroy(e: Entity): void;
  addComponent<S>(e: Entity, c: Component<S>, v: S): void; // attach (shape) — throws if present
  removeComponent(e: Entity, c: Component): void; // detach (shape) — throws if absent
  writeComponent<S>(e: Entity, c: Component<S>, v: S): void; // value write — throws if absent (edit().set uses this)
  addTag(e: Entity, t: Tag): void; removeTag(e: Entity, t: Tag): void;
  setRelation(e: Entity, r: Relation, target: Entity): void;
  addRelation(e: Entity, r: Relation, target: Entity): void;
  removeRelation(e: Entity, r: Relation, target?: Entity): void;
  // reads
  read<S>(e: Entity, c: Component<S>): S; // asserts present — THROWS if the entity lacks c (hot-path read)
  get<S>(e: Entity, c: Component<S>): S | undefined; // safe read — undefined if absent or identity-only (§5.2)
  has(e: Entity, c: Component): boolean; hasTag(e: Entity, t: Tag): boolean;
  readEid(e: Entity, c: Component, field: FieldId): Entity | undefined; // eid FIELD read, validated: returns the
                                                 // referenced entity, or undefined if the ref dangles (stale generation, §2)
  getRelation(e: Entity, r: Relation): Entity | undefined; getReverse(e: Entity, r: Relation): Entity[];
  // QUERY — per-chunk dispatch (§6.2). The store drives iteration; `fn` runs once per matching
  // archetype with raw columns. This is the ONE place the representation is exposed (the Chunk),
  // confined to the callback — by design, for hot-loop speed.
  query(plan: QueryPlan): { each(fn: (batch: Batch) => void): void };
}
```

**`ECSStore` exposes *immediate* operations** — every method applies now. It has **no hidden "am I iterating?" mode.** Deferral is not a property of the store; it is a property of the **system-execution context**:

- **`World`** delegates straight to the store → its mutations are immediate (`world.addComponent` applies now).
- **`SystemCtx`** *wraps* the store: inside a system, `ctx.addComponent` does **not** call the store's immediate method — it records a `StructuralCommand` into the phase's command buffer (§5.4), which the tick drains at the phase boundary by calling the store's immediate ops then. So the buffer lives in `ctx`, not in the store.

This is the §5.2 rule located precisely: the *same operation name* on two different surfaces (`world.addComponent` vs `ctx.addComponent`) has two timings *because they are two surfaces*, not because one method secretly checks global state. The store stays simple and stateless-about-iteration; `ctx` owns the deferral. (Value writes — `edit().set` on a present component — are immediate on *both* surfaces, since they reorder nothing; only shape changes are buffered, and only by `ctx`.)

> **Normative separation of buffer *memory* from op *semantics*.** The command buffer's backing storage is a pool physically owned by the `RuntimeStore` (a reused-across-frames allocation, §5.4) — but that is an *implementation detail of where the bytes live*, and it must not leak into behavior. **The runtime store may own the memory backing command buffers, but it must never change the semantics of its ECS operations based on whether a buffer exists or is "active"; `RuntimeStore.addComponent` (and every immediate op) always applies immediately, with no "am I iterating?" check. Only `SystemCtx` decides to enqueue a `StructuralCommand` instead of calling the immediate store operation.** This is the line that keeps the store non-modeful even though it holds the buffer pool: storage-ownership is not semantics-ownership. An implementation that made a store op consult buffer state would reintroduce exactly the hidden-mode fragility the two-surface design exists to prevent.

### API — `RuntimeStore` (the archetype implementation; the surface the substrate builds on)

**`RuntimeStore` is the `ECSStore` implementation strata ships** — the archetype/typed-array engine of §3/§5/§6. It also exposes the lower-level operations the storage substrate (Part II) and layers (Parts III–IV) are written against, so the projector kernel and the durable/ephemeral bindings drive the runtime through *published* operations rather than reaching into the entity table or columns directly. Every method here is specified in §5.5; this just names the surface.

```ts
interface RuntimeStore extends ECSStore {
  allocateIdentity(): Entity; // mint slot+generation only, no placement (§5.2)
  ensurePlaced(e: Entity): void; // idempotent: place an identity-only entity into the empty
                                                       // archetype; no-op if already placed (§5.5). The projection
                                                       // primitive for spawn/tag-first/relation-source placement (§10.3).
  // writeComponent (inherited from ECSStore) is VALUE-ONLY: throws if the component is absent (§5.3).
  // Projection needs a DIFFERENT primitive — one that PLACES an identity-only entity on first write:
  projectComponent<S>(key_handle: Entity, c: Component<S>, v: S): void; // add-if-absent-else-write; migrates
                                                       // identity-only → placed on the FIRST component (§5.5, §10.3)
  projectRemoveComponent(e: Entity, c: Component): void; // projection detach (migrate to smaller archetype)
  // (addTag/setRelation/destroy/read surface inherited from ECSStore; used by the bindings to apply + compare)
}
```

**Naming convention, fixed:** the `RuntimeStore` **projection primitives** are prefixed `project`/`ensure` (`ensurePlaced`, `projectComponent`, `projectRemoveComponent`) to distinguish them from the value-only `ECSStore` surface (`writeComponent`, which throws if absent). The **projector** (§10) wraps these with key-resolving methods under shorter, un-prefixed names (`applyComponent`, `removeComponent`, `applySpawn`, `applyTag`, `applyRelationSet`, `remove`) — a projector method takes a *key*, resolves it to a handle, and calls the matching runtime primitive. So `projector.removeComponent(key, c)` resolves `key` and calls `runtime.projectRemoveComponent(handle, c)`; the two names are intentional (projector = key-facing wrapper, runtime = handle-facing primitive), and the applyStructural dispatch (§13.3) names the **projector** methods.

The distinction is the crux of issue-class "two contracts, one name": **`writeComponent` (value) and `projectComponent` (projection) are different operations and must not share a method.** `writeComponent` is the systems-facing value write — it asserts the component is present and only overwrites its cell (it is what `edit().set` calls, §5.3). `projectComponent` is the *projection* primitive the kernel uses (§10.3): it adds the component if absent — **placing an identity-only entity into an archetype on its first component** — and writes the cell if present. Only the projector/binding calls `projectComponent`; systems never see it. This is why the kernel can say "the first component write places the entity" without contradicting "`writeComponent` throws if absent": those are two methods, and only the projection one places.

This is the only runtime surface Parts II–IV touch. They never index `archetypeId`/`rowInArch`/`freeList`/tag bitsets/columns directly — those are §3's internals, reached *only* through `RuntimeStore`. (Placement *timing* is the caller's, but placement *mechanism* is always one of these calls, §5.5.)


# PART II — THE STORAGE SUBSTRATE

Part II is the shared foundation the optional layers stand on. It introduces two things, both medium-agnostic and behavior-free:

1. **The snapshot ladder** — one interface (in capability tiers) that unifies the three map-shaped representations of a document.
2. **The projector kernel** — the policy-free mechanism that maps document keys to runtime entities and back.

Neither contains any sync *policy*. The reconcile rules, the transaction semantics, the ephemeral throttling — none of that is here. Part II is the *vocabulary*; Parts III and IV are the *behavior*. Keeping the vocabulary separate is what lets the two layers share so much while remaining genuinely independent.

## 9. The snapshot ladder

### 9.1 The observation that unifies three things

Across the design there are three things that all "store ECS data in a map structure":

- the **local snapshot** (§8) serializes entities into plain objects → bytes;
- the **durable baseline** (Part III) holds the last-agreed document state in in-memory maps;
- the **Loro document** (Part III) holds the converged state in Loro's nested maps.

They look alike because they *are* alike: each is a **storage-optimized representation of the same logical thing** — a set of entities with components, tags, and relations, addressed by a stable key. What differs is purely the *backing medium* and the *capabilities that medium offers*:

| Representation | Backing | Capabilities |
|---|---|---|
| JSON snapshot | plain objects → bytes | read, build, serialize |
| Baseline | in-memory nested Map | read, **write** |
| Loro snapshot | Loro nested map | read, write, **merge, history, change-events** |

The runtime store (Part I) is the fourth representation — the *query-optimized* one — and it is deliberately **not** part of this ladder, because its access pattern (columnar, by handle) is different in kind. The ladder is for *storage* representations, all keyed by document key, all cell-addressable.

### 9.2 Keys vs. handles

The ladder is keyed by a **storage key** (`StorageKey = string | number`), not a runtime handle. This is the lingua franca of Parts II–IV, and the single most important distinction to hold onto:

- A **runtime handle** (`Entity`, §2) is a packed `u32`, runtime-local, disposable, allocated by the runtime. It means nothing outside the process and changes on every re-attach.
- A **storage key** identifies an entity *within a stored representation*. It is opaque to the ladder (stored and handed back, never interpreted) and **stable** — it survives detach/re-attach, serialization, and sync. Its concrete type depends on the member: the two collaborative members (durable/ephemeral) narrow it to a **string** `EntityKey` (peer-prefixed), while the local snapshot uses a **number**.

Three flavors fill the key slot, and they differ exactly where their identity requirements differ — which is also why the ladder type is the `string | number` union while the *layer-facing* `EntityKey` is `string`:

- **Local save** (§8): a dense **integer** `0, 1, 2, …` assigned at export time (a `number` `StorageKey`). Single writer, no merge → cheapest possible identity is correct. This is the one member that isn't a string, which is exactly why `StorageKey` is a union and `EntityKey` (the durable/ephemeral type) is not.
- **Durable** (Part III): a peer-prefixed **string** key `"${peerId}-${counter}"`, minted from the document's Loro peer id. Multiple concurrent writers → identity must be collision-free with no coordination.
- **Ephemeral** (Part IV): a peer-prefixed **string** key like durable (`"${peerId}-${counter}"`), one per ephemeral *entity*. The prefix doubles as the **writer partition** (§15.1) — its peer id says who owns and may write it — and, as in durable, guarantees collision-free minting across concurrent peers.

The projector (§10) owns the bijection between keys and handles; the ladder never sees a handle. (Because the projector's keyspace for the collaborative layers is `EntityKey` — a branded `string`, §9.4 — `mintKey`/`resolveByKey`/`createPair` are typed on `EntityKey`; a minter constructs the `"${peerId}-${counter}"` string and casts it to the brand at the one construction site, so the brand is opaque everywhere else. The local snapshot's numeric keys live only in the §8 export/import path, which does its own handle↔integer mapping and never flows through the durable projector.)

> **Callout — the local snapshot conforms to `Snapshot<number>` conceptually, but does *not* use the `Projector`.** It's easy to read "the ladder unifies JSON, baseline, and CRDT" (this section) and conclude that saving a local file runs through the same projector/key machinery as the collaborative layers. It does not, and the distinction matters for implementers. The local save/load (§8) is a **`Snapshot<number>`** in the type sense — it satisfies the same cell-addressed read/write shape, keyed by a dense integer — but it has **no `EntityKey`, no peer prefix, no projector, and no baseline**. Import/export builds a **temporary dense-id map** (handle ⇄ `0,1,2,…`) that exists only for the duration of the serialize/deserialize pass and is thrown away afterward; there is no persistent key↔handle bijection to maintain because a local file has a single writer and no reconcile. So the ladder unifies the three at the level of the *`Snapshot` interface* (cell-addressed access, generic over the key type — §9.3), not at the level of the *projector*: only the durable and ephemeral layers instantiate the projector, precisely because only they need stable cross-session keys and handle re-resolution. The local snapshot is the ladder member that proves the interface is genuinely general — it fits `Snapshot<K>` with `K = number` and reuses none of the collaboration plumbing.

### 9.3 The interface, in capability tiers

A single fat interface would force lies — JSON cannot take writes-during-merge, the baseline has no history, and only the CRDT can emit change-events. So the ladder is **a small base interface plus capability extensions**, and the type system enforces who can do what. Addressing is at **component-cell granularity** (`getComponent(key, c)`), matching the unit of commit/reconcile/undo (Part III); the whole-entity `EntityRecord` is a derived bulk view for serialization, not the fundamental access pattern.

**`EntityRecord` is a serialization view, and the direction of that relationship matters for implementers.** A `Snapshot` may *produce* an `EntityRecord` by **aggregating its cells** (`readEntity(key)` walks the entity's components/tags/relations and packs them into one record) — that is the right direction: cells are the source of truth, the record is a computed convenience for bulk export/import (§8) and debugging. The direction must **not** be reversed: an implementation must not store the baseline (or the CRDT projection) *as* whole-entity `EntityRecord` blobs and derive cell reads from them. Reconcile and commit operate at **cell granularity** (a single `component-set`, one baseline cell compared, one Loro map key), so a whole-entity representation would force every cell operation to read-modify-write an entire entity blob — making component-granular conflict resolution (§13.4: different components edited concurrently both succeed) awkward and defeating the whole committer-wins-per-component model. The rule: **cells are canonical; `EntityRecord` is a view you build from them, never the storage you read them out of.**

```ts
// Everyone implements this. Pure reads, cell-addressed. Generic over the key type K (the StorageKey the
// member uses): the local JSON snapshot instantiates K = number, baseline/CRDT instantiate K = EntityKey.
// This is what lets the SAME ladder cover numeric-keyed local saves AND string-keyed collaborative stores
// without excluding either (resolves the §9.2-vs-interface mismatch).
//
// IMPORTANT (persistence): this interface is keyed by ComponentId/TagId/RelationId for a uniform in-memory
// API, but a PERSISTENT implementation (LoroSnapshot, on-disk local save) MUST translate those run-local
// numeric ids to stable ComponentName/TagName/RelationName at the adapter boundary before storing, and back
// on read (§3.4). It must NOT write run-local ids into the document/file — they are not stable across builds
// or schema versions, so a persisted numeric id would silently misbind after any schema change. Ids are the
// in-process currency; names are the durable currency.
interface Snapshot<K extends StorageKey = EntityKey> {
  hasEntity(key: K): boolean;
  entities(): Iterable<K>;
  getComponent(key: K, c: ComponentId): ComponentValue | undefined;  // id-keyed API; adapter maps id⇄name for storage
  hasTag(key: K, t: TagId): boolean;
  getRelation(key: K, r: RelationId): K | K[] | undefined;
  getResource(res: ResourceId): ComponentValue | undefined;
  readEntity(key: K): EntityRecord | undefined; // derived bulk view (serialization only, §9.3)
}

// Baseline + CRDT implement this. Cell-addressed writes. (Local JSON is read-mostly at K=number; the
// collaborative members instantiate K=EntityKey.)
interface MutableSnapshot<K extends StorageKey = EntityKey> extends Snapshot<K> {
  spawn(key: K): void;
  // despawn is a THREE-PART contract, not a single record deletion. A cell-addressed baseline is
  // tempting to build as forward-only maps (key → its components/edges), which would leave DANGLING
  // INCOMING references after a despawn. So despawn(key) MUST:
  // 1. remove the entity record for `key` (its components, tags, existence)
  // 2. remove all OUTGOING relation cells FROM `key` (every edge `key --R--> *`)
  // 3. remove all INCOMING references TO `key` (every edge `* --R--> key`, in every relation index/cell)
  // Parts 2 and 3 are both-directions cleanup — the baseline analogue of the runtime's reverse-index
  // cascade (§5.5). Without part 3, a later reconcile could compare against a phantom edge pointing at a
  // despawned key and think a deleted relation still exists (§13.3). Implementers whose relation storage
  // is forward-only must maintain a reverse index (or scan) to satisfy part 3 efficiently.
  despawn(key: K): void;
  setComponent(key: K, c: ComponentId, v: ComponentValue): void;
  removeComponent(key: K, c: ComponentId): void;
  addTag(key: K, t: TagId): void;
  removeTag(key: K, t: TagId): void;
  setRelation(key: K, r: RelationId, target: K): void; // arity "one"
  addRelation(key: K, r: RelationId, target: K): void; // arity "many"
  removeRelation(key: K, r: RelationId, target?: K): void;
  setResource(res: ResourceId, v: ComponentValue): void;
  removeResource(res: ResourceId): void;
}

// ONLY the CRDT-backed snapshot implements this — the capabilities the baseline
// and JSON snapshots genuinely don't have. Fixed at K = EntityKey (collaboration is string-keyed).
interface CRDTSnapshot extends MutableSnapshot<EntityKey> {
  applyRemote(bytes: Uint8Array): ChangeBatch[]; // import remote bytes → one ChangeBatch PER COMMIT (with origin)
  commit(body: () => void): void; // seal a batch into ONE history entry (see below)
  export(): Uint8Array; // serialize the converged doc
  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe; // ONE batch per local commit AND per remote commit
  undo(): void;
  redo(): void;
}
```

**The batch boundary is first-class.** Both `subscribe` and `applyRemote` deliver a **`ChangeBatch`** — the doc-facts of *exactly one commit* — not a bare `ChangeEvent[]`:
```ts
interface ChangeBatch {
  origin: Origin; // whole batch is one origin — a commit is either yours (local echo) or a peer's (remote)
  events: ChangeEvent[]; // the cell-level facts of THIS one commit
  commitId?: string; // optional adapter-provided commit identity (for logging/dedup)
}
```
A batch is **single-origin by construction**, and that is load-bearing beyond classification: it guarantees a same-frame own-echo and a remote fact **for the same cell** are always *separate* batches (they have different origins, so they can never merge into one `ChangeBatch`). That in turn means their relative order can't corrupt the drag-protection compare in §13.3 — each is reconciled as its own batch, and the `(own,value)`/`(remote,value)` guards reach the same result regardless of which drains first (dynamics-trace D3). Mixed-origin batches are illegal; the type makes them unrepresentable.
This matters because reconcile's baseline classification (§13.3) depends on "one array = one commit": it normalizes a batch to the final fact per cell and classifies each against the *pre-commit* baseline. If two commits were merged into one array, a later commit's fact would classify against a baseline already advanced by the earlier commit; if one commit were split across arrays, a multi-fact cell (`remove C` then `set C`) would be seen in pieces. Making `ChangeBatch` the unit — one per `commit`, one per remote commit surfaced by `applyRemote` — guarantees the normalization sees each commit whole and nothing else. `applyRemote` returns an *array* of batches because a single received byte-buffer may carry several remote commits; each becomes its own `ChangeBatch`, reconciled in order.

The snapshot ladder covers the three *cell-addressable* representations (JSON, baseline, CRDT). The ephemeral store (Part IV) is the one Part II citizen *outside* this ladder: it is per-key value blobs with three coarse events, not cell-addressable, so it has its own lean interface — **`EphemeralSource`** (defined with the ephemeral layer, Part IV) — rather than extending `Snapshot`. Both the CRDT snapshot and the ephemeral source are Loro-backed, and each is quarantined behind its interface by exactly one adapter class (`LoroSnapshot`, `LoroEphemeralSnapshot`) — the only two Loro-aware types anywhere (§0).

**`commit(body)` is a scope, not a bare call.** The writes happen *inside* the callback; `commit` opens the batch, runs the body, and seals on return. Two properties fall out, both load-bearing for Part III:

- the caller **cannot forget to seal** — there is no "write then maybe-commit" gap;
- the batch is **pinned to this one document**, so a single application-level commit can never fold writes from two different documents into one history entry.

### 9.4 Doc-facts — the `ChangeEvent` vocabulary

`CRDTSnapshot.subscribe` and `applyRemote` emit **doc-facts**: pure statements about the converged document ("the doc now says cell X = V"), carrying an **origin** but carrying **no apply/skip decision**. This is the crucial boundary property of Part II: *the snapshot reports what the document now says; it does not decide what the runtime should do about it.* All such policy lives upstream in the durable layer's seam (Part III). The snapshot does not — and cannot — read the runtime, so it could not make that decision even if it wanted to.

```ts
type Origin =
  | "local" // the echo of our own transaction (§12). For a VALUE the runtime already has it
               // (applied synchronously at commit); for STRUCTURE this echo is how the runtime
               // gets it (projection is the sole structural path). Either way reconcile applies it.
  | "remote"; // arrived via applyRemote. Structure applies unconditionally; a VALUE applies only
               // if the cell isn't mid local-drag (runtime == baseline), else it is held off (§13.3)

type ChangeEvent =
  | { kind: "spawn"; key: EntityKey; origin: Origin }
  | { kind: "despawn"; key: EntityKey; origin: Origin }
  | { kind: "component-set"; key: EntityKey; comp: ComponentId; value: ComponentValue; origin: Origin }
    // NB: `component-set` is intentionally ambiguous — it may ADD a previously-absent component (structural)
    // or OVERWRITE a present one (value). The binding classifies it against the BASELINE at reconcile
    // (absent → structural add, present → value write, §13.3), because a raw CRDT "map key changed" event
    // cannot itself distinguish the two. `component-remove` is always structural.
  | { kind: "component-remove"; key: EntityKey; comp: ComponentId; origin: Origin }
  | { kind: "tag-add"; key: EntityKey; tag: TagId; origin: Origin }
  | { kind: "tag-remove"; key: EntityKey; tag: TagId; origin: Origin }
  | { kind: "relation-set"; key: EntityKey; rel: RelationId; target: EntityKey; origin: Origin }
  | { kind: "relation-add"; key: EntityKey; rel: RelationId; target: EntityKey; origin: Origin }
  | { kind: "relation-remove"; key: EntityKey; rel: RelationId; target?: EntityKey; origin: Origin }
  | { kind: "resource-set"; res: ResourceId; value: ComponentValue; origin: Origin }
  | { kind: "resource-remove"; res: ResourceId; origin: Origin };
```

The doc-fact vocabulary deliberately mirrors the cell-addressed write methods of `MutableSnapshot`. It is distinct from the **operation** vocabulary of Part III (`SpawnEntity`, `AddComponent`, `WriteComponent`, …): ops are *requests* carrying real handles (built by `tx.*`, §12.2), doc-facts are *facts* carrying origin and fully-resolved keys. They look parallel because they describe the same cell-level changes from two sides — the request side and the converged-result side — but they are not the same type, and conflating them would blur the transaction/projection boundary.

## 10. The projector kernel

The projector is the one mechanism the durable and ephemeral layers genuinely share. Its job is narrow: **maintain the key↔handle bijection, and apply already-scheduled projection changes to the runtime — mapping keys (or handles) to live runtime entities.** It does **not** decide timing and owns no queue: the durable and ephemeral bindings call it *only* from `attach` (§13.1) or from `sync()` (§13.3, §16), both of which run **outside** any system iteration, so its writes apply **immediately** and never touch the command buffer (§5.4). (This is the opposite of "the projector defers to a boundary": there is no hidden projector queue — the *caller* already picked a safe, non-iterating moment, and the projector just applies.) Everything that makes the durable layer *hard* — the baseline, the reconcile compare, the two-phase relation pass, sealing — lives in the durable layer's wrapper, not here. Everything the ephemeral layer *lacks* — relations, the baseline — is simply never invoked. The kernel is policy-free.

### 10.1 The kernel owns both id-spaces

The projector maintains a bijection (`keyToHandle` / `handleToKey`). The single invariant it exists to protect is: **every pair is registered atomically with the allocation of whichever id was missing.** The bug this guards against is the two maps drifting out of sync, or one id-space being allocated by code that forgets to register the pair.

The earlier design split the two allocators — the runtime allocated handles, but the *binding* held the key minter and reached into the projector to register pairs. That split is exactly what made the invariant convention-dependent and bug-prone. The fix: **the kernel owns both allocators** — `runtime.allocateIdentity()` for handles and `mintKey()` for keys — so the only way to allocate is through an operation that also registers. The `bind` method is private; there is no public "allocate but don't link."

The handle allocator is `allocateIdentity`, **not** full placement: it mints a slot + generation and nothing else (§5's identity-vs-placement rule). The projector never *places* an entity into an archetype — placement happens through the cell-apply methods (§10.3), whose timing the *caller* supplies (immediate for attach, deferred for inbound). This keeps the kernel policy-free: it owns identity and the bijection; it owns no placement-timing decision.

```ts
class Projector {
  private keyToHandle = new Map<EntityKey, Entity>();
  private handleToKey = new Map<Entity, EntityKey>();

  constructor(
    private runtime: RuntimeStore,
    private mintKey: () => EntityKey, // the kernel owns BOTH id-spaces (handles via
                                        // runtime.allocateIdentity — identity only, no placement)
  ) {}

  private bind(key: EntityKey, handle: Entity) { // the ONLY place a pair is recorded
    this.keyToHandle.set(key, handle);
    this.handleToKey.set(handle, key);
  }
  // ...
}
```

### 10.2 Three operations, distinguished by mint-policy

The kernel exposes three create/resolve operations. The axis that distinguishes them is **mint-policy**, *not* "direction" — which is the subtle point. It is tempting to think of two operations, "create from a key" and "create from a handle," but that framing conflates three genuinely-different situations and would hide a real bug.

```ts
/** PROJECTION: a remote key arrived (durable doc, or a remote ephemeral entity). Ensure it has
 * a bound handle. Mints IDENTITY only (slot + generation) — never placement, never a key.
 * Identity is safe to mint in any context (§5); the caller decides placement timing. */
resolveByKey(key: EntityKey): Entity {
  let h = this.keyToHandle.get(key);
  if (h === undefined) { h = this.runtime.allocateIdentity(); this.bind(key, h); }
  return h;
}

/** LOCAL SPAWN into a store (tx.spawn §12.2, or eph.spawn §15.2): a fresh runtime handle was just
 * created; mint a store key for it and bind the pair. Mints a KEY, never a handle. */
createPair(handle: Entity): EntityKey {
  if (this.handleToKey.has(handle)) throw new Error("handle already has a key");
  const key = this.mintKey(); // durable: peer-prefixed doc key; ephemeral: peer-prefixed entity key (§9.2)
  this.bind(key, handle);
  return key;
}

/** REFERENCING an existing store entity (e.g. tx.addComponent(rect, …) → the executor's keyOf):
 * the handle MUST already belong to this store. No mint — a missing key means the op referenced
 * a runtime-only (or other-store) entity. Throws so the violation is loud, not a silent promotion. */
requireKey(handle: Entity): EntityKey {
  const key = this.handleToKey.get(handle);
  if (key === undefined) throw new Error("op references an entity not in this store");
  return key;
}
```

| Situation | Operation | Mints? | If the entry is absent |
|---|---|---|---|
| Projection: incoming key (durable doc / remote ephemeral) → runtime | `resolveByKey` | identity (a handle) | creates the pair |
| `tx.spawn` / `eph.spawn`: a new entity in the store (§12.2, §15.2) | `createPair` | a key | creates the pair |
| Referencing an existing store entity | `requireKey` | nothing | **throws** |

**Why three and not two.** The third operation is the one the "two directions" framing would miss. Consider `tx.addComponent(e, …)` where `e` is a handle from a plain `world.spawn()` — a runtime-only entity, never in a transaction, with no key. A merged "resolve-or-create from a handle" would *mint a key for it*, silently turning a runtime-only entity into document content as a side effect of merely referencing it. That is forbidden by the durable layer's rules (an op may not reference a non-durable entity). So "resolve or create" and "resolve or throw" are different *failure semantics* encoding different *intents* — minting a new durable entity vs. requiring an existing one — and must not be merged. The number of operations equals the number of distinct (mint-policy) intents, which is three, and each is honest about what it does when the entry is missing.

### 10.3 Cell application and structural removal

Beyond the three resolve operations, the kernel applies values the wrapper has *already decided* to apply (it never consults a baseline — that is the wrapper's job), and removes entities. It uses the runtime's **projection primitives** (`projectComponent`, `ensurePlaced`, …), which are distinct from the value-only systems surface (§5.5): projection *places* an identity-only entity, whereas `edit().set` throws on an absent component. Placement happens when the entity first acquires membership — its first component migrates it into that component's archetype; a spawn or a first tag with no components places it into the **empty archetype** (the signature-∅ archetype where componentless-but-live entities live, so they are still queryable — §5.2, Option A). All of this applies **immediately** — projection always runs *outside* iteration (attach between frames, §13.1; inbound durable and ephemeral projection during `world.sync()`, §13.3/§16), so there is never an in-progress column walk to corrupt, and projection therefore never touches the system command buffer (§5.4):

```ts
applyComponent(key, c, v) { this.runtime.projectComponent(this.resolveByKey(key), c, v); } // add-if-absent(→place)-else-write
removeComponent(key, c) { this.runtime.projectRemoveComponent(this.resolveByKey(key), c); }
applySpawn(key) { this.runtime.ensurePlaced(this.resolveByKey(key)); } // place into empty archetype now
applyTag(key, t) { const h = this.resolveByKey(key); this.runtime.ensurePlaced(h); this.runtime.addTag(h, t); }
removeTag(key, t) { this.runtime.removeTag(this.resolveByKey(key), t); }
applyRelationSet(key, r, tk) {
  const h = this.resolveByKey(key); this.runtime.ensurePlaced(h); // a relation makes key a live, queryable entity
  this.runtime.setRelation(h, r, this.resolveByKey(tk));
}
removeRelation(key, r, tk) { // tk optional — remove one edge, or all of r from key
  this.runtime.removeRelation(this.resolveByKey(key), r, tk ? this.resolveByKey(tk) : undefined);
}
remove(key) { // entity despawn: reverse-index cascade in the runtime (inline, §5.4)
  const oldHandle = this.keyToHandle.get(key);
  if (oldHandle !== undefined) {
    // ORDER MATTERS: runtime.destroy bumps the slot's generation (§2), so the PACKED Entity value that
    // handleToHandle-keyed maps were stored under is `oldHandle` (pre-bump). Capture it first, destroy,
    // then delete BOTH directions of the bijection using the captured handle — never re-read it after
    // destroy, when its generation no longer matches.
    this.runtime.destroy(oldHandle);
    this.keyToHandle.delete(key);
    this.handleToKey.delete(oldHandle);
  }
}
// Detach ORDER matters (#14): a binding holds a pending inbound queue (§12.4) that sync() drains. If
// teardown despawned entities and dropped the bijection while a queued (not-yet-drained) ChangeBatch or
// ephemeral event still pointed at this binding, a later drain() would try to project into a torn-down
// binding (writing through a dead projector / resolving keys that no longer bind). So detach does, IN ORDER:
//   1. UNSUBSCRIBE from the document/EphemeralStore — stop new doc-facts from arriving.
//   2. CLEAR the binding's pending inbound queue — discard any queued-but-undrained batches/events.
//   3. THEN despawn all projected entities and clear the bijection.
// Unsubscribe-and-drain-clear before teardown guarantees no drain runs against a half-torn-down binding.
teardown() { /* 1. unsubscribe  2. clear pending inbound queue  3. despawn projected entities + clear bijection */ }
```

`ensurePlaced(h)` is idempotent: it places an identity-only handle into the empty archetype and is a no-op if the handle is already placed (in any archetype). It is why a projected `spawn` doc-fact — which carries no components — still yields a **queryable** entity (Option A, §5.2): the spawn places it into the empty archetype immediately, and later component doc-facts migrate it onward. `projectComponent` folds placement in for the common case (first component both places and fills its cell in one migration); `ensurePlaced` covers the componentless and tag-first cases where there is no component to trigger the migration.

The kernel has both an *additive* side (used by attach, which is all-creation, §13.1) **and** a *removal* side (`projectRemoveComponent`/`removeTag`/`removeRelation`/`remove`) — steady-state reconcile (§13.3) applies remote *and* own structural removals, not just additions, so both sides are needed. Placement is handled by the additive side as described above (`projectComponent`/`ensurePlaced` place an identity-only entity on its first membership); a removal migrates toward the smaller archetype, and removing an entity's last component leaves it in the empty archetype (still live and queryable, Option A), not identity-only. These all apply **immediately** — projection always runs *outside* iteration (attach between frames, §13.1; inbound durable and ephemeral projection during `world.sync()`, §13.3/§16), so there is never an in-progress column walk to corrupt, and projection therefore never touches the system command buffer (§5.4).

There is **no placement-timing parameter**, because projection has only one timing: immediate. This is structural, not a simplification of convenience — projection is the runtime *receiving* external state (from disk on attach, from the network on sync), and the framework deliberately schedules that receiving at points where no system iterates (the whole reason `sync()` is separate from `tick()`, §16). So projection cannot collide with iteration and never needs the buffer. The command buffer thus has exactly **one** kind of producer: system code via `ctx` (§5.4). Projection, `world.*` setup, and inbound all stay off it.

`resolveByKey` (identity only) just works for the key-first projection path, and under the transaction model (§12) **a commit's structural effects reach the runtime through this same projection path** — the executor writes only the document + baseline, and the structural doc-facts it produces are projected here, so the kernel's apply/remove ops are the single point structure enters the runtime (own-origin and remote alike). A commit's *value* writes to existing entities are the one thing the executor applies to the runtime directly (`runtime.writeComponent`, §12.3), bypassing the kernel because it already holds the handle. Relation application takes the *target's* key, which may not have a handle yet; that is why the durable layer's two-phase projection (and reconcile) call relation application only after the referenced entities exist, and why the ephemeral layer (no relations) never calls it at all. Ordering is the wrapper's concern; the kernel just resolves identity and writes.

---

## Part II — API reference

The public surface for this part. Signatures are TypeScript sketches.

### API — the storage substrate

Mostly internal, but the interfaces are the contract the layers are written against (§9–7).

```ts
interface Snapshot { /* reads, cell-addressed (§9.3) */ }
interface MutableSnapshot extends Snapshot { /* + writes */ }
interface CRDTSnapshot extends MutableSnapshot {
  applyRemote(bytes: Uint8Array): ChangeBatch[]; // one ChangeBatch PER COMMIT (§9.3)
  commit(body: () => void): void; // a SCOPE — seals one history entry, pinned to this doc (§9.3)
  export(): Uint8Array;
  subscribe(fn: (batch: ChangeBatch) => void): Unsubscribe; // one batch per commit (local + remote)
  undo(): void; redo(): void;
}

// The snapshot ladder (§9) is keyed by StorageKey; the DURABLE/EPHEMERAL layers narrow that to string
// keys (peer-prefixed, §9.2/§14.1). The local snapshot (§8) is the one ladder member that uses numeric
// keys (dense export-time ids), which is why the ladder type is the union and the layer type is the string.
type StorageKey = string | number; // what the snapshot ladder addresses (JSON=number, baseline/CRDT=string)
type EntityKey = string & { readonly __brand: "EntityKey" }; // BRANDED string: a durable/ephemeral key. Stable,
                                     // opaque, peer-prefixed. NOT a handle. The brand makes TS reject an arbitrary
                                     // string where a key is required (keyOf/resolve, "key" fields, §10/§14.3); at
                                     // runtime it is an ordinary string.
type ChangeEvent = /* doc-facts with origin; cell-granular (§9.4) */;

class Projector { // the shared kernel (§10) — owns the key↔handle bijection AND both allocators
  constructor(runtime: RuntimeStore, mintKey: () => EntityKey);
  resolveByKey(key: EntityKey): Entity; // key-first; mints IDENTITY only (no placement, §10.2)
  createPair(handle: Entity): EntityKey; // handle-first; mints a KEY
  requireKey(handle: Entity): EntityKey; // handle must already be bound, else THROWS (§10.2)
  // cell application applies IMMEDIATELY — projection only ever runs outside iteration (§10.3)
  applyComponent(key, c, v): void; applyTag(key, t): void; applyRelationSet(key, r, tk): void;
  remove(key: EntityKey): void; teardown(): void;
}
// runtime.allocateIdentity(): mints slot+generation only (no archetype placement) — always safe (§5).
// The system command buffer (§5.4) has ONE producer: ctx (system code). Projection/world-setup/inbound never use it.
```


# PART III — THE DURABLE LAYER

The durable layer is opt-in collaborative persistence and sync, aimed at editor / infinite-canvas documents where many people edit one shared document. It is built entirely on Part II: it owns a `CRDTSnapshot` (the document) and a `MutableSnapshot` (the baseline), and it uses the projector kernel to bridge to the runtime.

The model is **three layers of state**, and the whole design follows from keeping them straight:

```
   Loro doc ◄──► durable baseline ◄──► runtime world
   (truth+history) (last-agreed value) (live, columns)
    always converged advances at agreement may diverge
                           points; lags during edits during an edit
```

- **Loro is the truth.** The converged document and its full history; the authority; the only place intermediate remote values live.
- **The baseline is the reconcile anchor.** It equals the last value the runtime and the document *agreed on*. It advances only at agreement points and deliberately lags during a local edit. This lagging is the mechanism, not a bug (§13).
- **The runtime is the live view.** It may diverge from the baseline during an edit (a drag writing every frame); that divergence, measured against the baseline, is exactly how the framework detects an active local edit.

"Durable" is a **location** — which store a thing lives in — not a flag checked on every runtime change.

## 11. What durable means

### 11.1 Opt-in, static, location-based

Durability is **opt-in and static** — an entity is durable or it isn't, decided by the path that created it, never promoted or demoted at runtime:

- **Durable content is created by `tx.spawn` inside a `doc.transaction`.** The transaction targets a store, so the new entity is that document's content; all later changes to it are likewise `tx.*` operations. There is no per-mutation "mark this durable" flag.
- **Runtime-only content is created by a plain `world.spawn()`.** It lives only in the runtime — selection, hover, drag previews, gesture entities — and never reaches a document.

```ts
const doc = createDurableStore(loroDoc); // wraps a user-supplied Loro doc (§14)
world.attachDurable(doc);

// durable: created inside a transaction → becomes document content
const { shape } = doc.transaction(tx => {
  const shape = tx.spawn({ components: { Position: { x, y }, Rotation: { angle: 0 } } });
  return { shape };
});

// runtime-only: a plain spawn, never in a transaction → never durable
const gesture = world.spawn({ components: { DragGesture: { /* … */ } } });
```

Static location fits the editor domain: the durable/runtime line is stable and obvious (*is it part of the document, or part of the interaction?*) and never moves. Because an entity's store is fixed at creation, the durability checks (§11.2) are static membership tests — which is exactly what makes the projector's `requireKey` (§10.2) a correct, throwing guard rather than a silent promotion.

### 11.2 Durability rules

A local change becomes durable only via a **transaction** (§12), and only when the touched data is durable. Every rule reduces to *"every entity the change touches is durable, the specific thing is durable, and everything is in the same store"*:

- **component field change** → component durable **and** entity durable
- **structural change** (add/remove component) → component durable **and** entity durable
- **tag change** → tag durable **and** entity durable
- **relation change** → **all** involved entities durable **and in the same store**
- **resource change** → that resource durable
- **entity creation** → entity durable (committed before its components, mirroring two-phase load in reverse)
- **entity deletion** → entity durable

Because each durable entity's key encodes its store, the **same-store** requirement on relations is a static creation-time check. A relation whose endpoints are in different stores (or one endpoint ephemeral) is **not durable** — it stays runtime-only, silently.

> **Edge to document:** a relation from a durable entity to an ephemeral one (or across two stores) never persists. Correct per the rules, but surprising — "I saved A but its link to B vanished on reload." Consider a dev-mode warning.

**A durable change is an explicit operation, not an inferred diff.** Hot-path systems write runtime columns freely (a drag moving a `Transform` every frame); the durable layer never observes those writes and never tries to infer what changed. To change the document you call `doc.transaction` and issue explicit `tx.*` operations (§12); the recorded batch *is* the change set — there is nothing to diff, no access to track, no "did the closure touch this." The rules above are checked per recorded operation at seal time; operations that pass are applied, the rest is a programming error.

## 12. The transaction — the upward boundary (a call)

Changing the document is the **core → durable** flow, and it is a **call**, not an event — `doc.transaction(fn)` runs `fn`, seals everything it records as one document change, and returns `fn`'s result. The whole block is **one transaction**: one Loro commit, one undo entry, one sync message. It is the only way to change the document.

```ts
const { frame } = doc.transaction(tx => {
  const frame = tx.spawn({ components: { Size: { w: 400, h: 300 } } }); // returns a REAL handle
  tx.setRelation(shape1, ChildOf, frame); // `frame` is a real Entity — no alias
  tx.addTag(shape2, Selected); // Selected is a TAG → addTag, not addComponent
  return { frame };
});
```

`tx` carries the **same mutation vocabulary as `world` and `ctx`** (`spawn`, `destroy`, `addComponent`, `setRelation`, `edit().set`, …) — so there is one mutation language across the three contexts, differing only in *timing*, which the held object determines: `world` (runtime, immediate), `ctx` (runtime, deferred to phase boundary), `tx` (durable, transactional — the whole block seals at once).

**How a transaction reaches the runtime — the split.** A transaction's effect on the runtime follows the §5 identity/value/shape lines, and the result is that **the runtime learns about structural document changes exactly one way: projection** (§13), uniform for local and remote origin. Concretely, at the moment the block seals:

- **identity** is minted synchronously — `tx.spawn` returns a real `Entity` immediately (slot allocation touches no columns, §5.2), and binds its document key, so the handle is usable right away;
- **value writes to existing entities** are applied to the runtime synchronously (a value op reorders nothing, so it is safe and immediate — and this is *load-bearing*: it erases any in-flight local divergence at commit, §13.2);
- **structural changes** (placement of new entities, add/remove component, relations) are **not** written to the runtime at the call; they flow through **projection** — the sealed Loro commit fires its change subscription, the next `world.sync()` drains it, and reconcile applies the structure (§13.3).

So after `doc.transaction` returns: the **document and baseline are updated**, the **handle is usable**, committed **values to existing entities are live**, but newly-created entities and structural changes become **queryable only after projection runs**. The split matches where divergence happens: values diverge continuously (drags) so they are synchronous; structure changes discretely so it rides projection — and routing structure through projection means there is no second runtime-write path to reconcile against, and no `ctx.transaction` special case (identity-mint and value-writes are iteration-safe, structure goes through `sync` which runs outside iteration, so `doc.transaction` works identically inside or outside a system).

> **The visibility rule, stated precisely (for the public docs).** `tx.spawn` returns a real handle *immediately* — you may store it, compare it, and use it in **later durable operations** (relations, components) right away. But the entity is **not queryable and its components are not runtime-readable until projection runs** — i.e. the next time `world.sync()` drains this binding (§13.3, §16). "Next sync" is exact: in the recommended frame loop (`sync` at frame top, then `tick`), a transaction issued **between frames** is visible on the **upcoming** frame's tick; a transaction issued **inside a system during `tick`** is visible on the **following** frame (this frame's `sync` already ran). So a just-spawned durable entity is queryable next-frame at the latest. Do not expect a runtime component read of a freshly-spawned durable entity to succeed in the same synchronous flow — it is identity-only until projection (§5.2 three-state model). This is the same one-frame structural latency whether the change is local (your transaction) or remote (a peer's), which is the point: the runtime learns structure exactly one way.

> **Caution for mixed `doc.transaction` + `ctx.*` in the same system.** The handle from `tx.spawn` is a real, usable `Entity` *as a value* the instant it returns — so you can immediately wire it into a **runtime** relation or `eid` field from `ctx`:
> ```
> doc.transaction(tx => { e = tx.spawn({ components: { Size: s } }); });
> ctx.addRelation(someRuntimeEntity, R, e); // legal: e is a valid handle; source is placed, TARGET (e) is not (§5.2)
> ```
> This is consistent with the placement rule — adding an *outgoing* relation places the *source*; a relation *target* is not placed by being pointed at (§5.2) — but it is worth calling out because it *looks* like it should make `e` live. It does not: `e` remains identity-only until the transaction projects (next `sync()`), so a `defineQuery` will not match `e` this frame even though a runtime relation already points at it, and a `readEid`/relation traversal to `e` will validate its generation and find it live-but-unplaced. The rule to hold: **a `tx.spawn` handle may be used as a value immediately (relations, `eid` fields, comparisons), but do not expect it to participate in *queries* or component *reads* until after `sync()`.** Mixing the durable and runtime mutation surfaces in one system is allowed; just don't conflate "the handle is valid" with "the entity is queryable."

> **A durable *value* commit inside a system is immediate and order-sensitive — not deferred to a phase boundary.** `doc.transaction` *sounds* external and async, so it is easy to assume a value it commits waits for the next frame. It does not: `tx.edit(existing).set(C, v)` on a pre-existing component is a synchronous runtime value write (plus document + baseline, §13.2) — exactly like `ctx.edit().set` — so it is **visible to later systems in the same phase**, and the write order within the phase matters (a later system reading `C` sees the committed value; reorder the systems and it wouldn't). This is the value half of the timing model (§7.2): values flow immediately and are order-sensitive within a phase; only *structure* waits for the boundary/projection. So a durable value commit is not a phase-boundary event — treat it as a value write that also happens to persist and sync.
>
> Concretely — a commit that writes the very `Position` column the loop is iterating:
> ```ts
> const CommitOnSettle = defineSystem(query([Position, Settling]), (batch, ctx) => {
> for (const r of batch) {
> const e = batch.entity(r);
> const p = batch.col(Position); // reading the Position column for this chunk
> if (isSettled(p.x[r], p.y[r])) {
> doc.transaction(tx => tx.edit(e).set(Position, { x: p.x[r], y: p.y[r] }));
> // ↑ this WRITES Position[r] synchronously — runtime + doc + baseline — RIGHT NOW, mid-loop.
> // It does NOT wait for the phase boundary. The column cell you just read is now the committed
> // value; a later system in this phase that reads Position sees it. Structurally nothing changed
> // (Position was already present — a value write, not a shape change), so iteration is safe and
> // no migration occurs. But the ORDER matters: a system scheduled after this one observes the
> // commit; one scheduled before does not. Feels external because it's `doc.transaction`; behaves
> // like `ctx.edit().set` because it's a value write to a present component.
> }
> }
> });
> ```
> The trap is purely perceptual: the `doc.transaction` wrapper reads as "hand off to the durable layer, come back later," but for a value write to a present component there is no later — it lands in the same synchronous flow as any other value write, columns included. (A `tx.spawn` or `tx.addComponent` in the same spot *would* defer its structural effect to projection, §12; only the *value* part is synchronous. Don't mix the two mental models — check whether the tx op is a value write or a shape change to know when it's visible.)

**Ops survive as the internal format.** `tx`'s calls do not mutate the document incrementally — they accumulate, and the block seals them as one batch. Internally each *structural* `tx` method records a `StructuralCommand` (the §5.3 vocabulary) and each *value* method (`tx.edit().set`, `setResource`) records a value op, so a transaction *produces a `DurableOp[]` batch* — `DurableOp` being `StructuralCommand` plus the value ops (§ Part III reference). The executor (§12.3), the sync wire, and replay/fixtures all operate on this op-batch. `transaction` is the ergonomic authoring surface; ops are the substrate where serializability earns its keep (the same executor applies a local op-batch and an inbound remote one). Because authoring is imperative with real handles, **aliases are gone from the user surface** — `tx.spawn` hands back the handle; later lines reference it directly. (Ops may still carry the runtime handle + document key they were built with; there is no `"$alias"` placeholder.)

### 12.1 What the core knows: `InboundSource`, not `DurableTarget`

The runtime core is a pure ECS world: `DurableTarget` is **not** in its type graph. A `World` compiles and runs with no durable concept at all — its only concession to the layers is that `world.sync()` can drain some registered inbound sources:

```ts
// This — and ONLY this — is what the core knows about the layers. A pure ECS world holds zero or more.
interface InboundSource {
  drain(): void; // apply this source's pending inbound changes to the runtime (called from world.sync(), §16)
}
```

`DurableTarget` is the **durable package's** contract — *what a durable store is*, not something the core holds:

```ts
// Lives in the durable package. The core never names this type.
interface DurableTarget {
  transaction<R>(fn: (tx: Mutator) => R): R; // run a block; seal it as one document change
}
```

The relationship, stated so the arrows are unambiguous: the **`DurableStore`** (`doc`) *is* the `DurableTarget` — what you call `doc.transaction` on — and the **`DurableBinding`** implements **only** `InboundSource` (its drain face — what `world.sync()` calls). The user opens transactions **directly on the durable store** (`doc.transaction(fn)`), *not* through the world or the binding — so the world never needs a reference to a `DurableTarget`, and there is exactly one transaction surface. Attaching a store registers its binding in the world's `InboundSource[]`; from then on the world knows it only as something to `drain()` at sync (§16). This is the layering the whole document promises: **Part I depends on `ECSStore`/`RuntimeStore` and, optionally, `InboundSource` drains — nothing durable.** `DurableTarget`, the baseline, the projector, Loro: all live in Part III, reached through the store and its binding, named nowhere in the core.

`Mutator` is the shared mutation vocabulary (§5 / the Part I reference); `tx` is a `Mutator` whose writes are recorded and sealed at block exit.

### 12.2 The `tx` recorder

`tx` is a `Mutator` (§5 vocabulary) whose calls **record** rather than apply. Each *structural* method appends a `StructuralCommand`, and each *value* method appends a value op, to the transaction's `DurableOp[]` batch; the block seals the batch at exit (§12.3). The recorder is what lets the block be one atomic commit — the calls accumulate, then seal once, instead of each becoming its own document change.

The crucial mechanic is `tx.spawn`, which returns a usable handle while the entity's placement is still pending — the §5.2 identity/placement split:

```
tx.spawn({components, tags}):
  e = runtime.allocateIdentity() // real runtime handle NOW (slot+gen, touches no columns)
  key = projector.createPair(e) // mint the document key NOW; bind the bijection key↔e
  record SpawnEntity(e, key, {components, tags})
  return e // usable immediately; placement arrives via projection (§13)

tx.edit(e).set(C, v): // VALUE write on an EXISTING durable entity (C must be present)
  record WriteComponent(e, C, v) // applied to runtime + baseline synchronously at seal (§13.2)

tx.addComponent(e, C, v): // SHAPE change — attach a component e does NOT have
  record AddComponent(e, C, v) // runtime effect + baseline advance via projection only (§13)
```

(The value/shape split is the same one the runtime draws, §5.3 — `tx.edit().set` is the value op, `tx.addComponent` the shape op — so a transaction's ops carry their nature in their kind, and the executor (§12.3) routes on kind, not on an entity-state check.)

**Preconditions are checked against a transaction-local overlay, not the runtime.** A `tx` method's precondition (`addComponent` needs the component *absent*, `edit().set` needs it *present*) must be evaluated against the state *as the transaction has built it so far*, because the runtime and document don't yet reflect the transaction's own earlier calls. So the recorder maintains a lightweight **overlay** — a pending view of the components/tags/relations each entity in the batch has — seeded from the entity's current durable state (empty for a `tx.spawn`'d entity) and updated by each recorded op. Crucially, the overlay records for each present component **how it got there**: *pre-existing* (present in the baseline when the transaction began) or *introduced-this-tx* (added by a `tx.spawn({components})` or an earlier `tx.addComponent` in this same block). That distinction is what lets the executor route a value write correctly (§12.3):

```
doc.transaction(tx => {
  const e = tx.spawn({ components: { Size: s } }); // overlay: e has {Size: introduced-this-tx}
  tx.addComponent(e, Position, p); // overlay now adds {Position: introduced-this-tx}; precondition (absent) → OK
  tx.edit(e).set(Position, p2); // precondition (present) checks overlay → OK. Position is INTRODUCED-THIS-TX,
                                        // so this write FOLDS into the pending AddComponent(Position) payload —
                                        // it does NOT record a synchronous WriteComponent (the runtime has no
                                        // Position column yet; structure projects later, §12.3).
  tx.edit(existing).set(Fill, red); // Fill is PRE-EXISTING on `existing` → records a WriteComponent (value path)
});
```

This is what makes "the transaction is the authoring surface" true: you write the entity's construction top-to-bottom as if it existed, and each line is validated against the lines above it. Three rules pin the behavior:
- **A value write folds if its component is introduced-this-tx; it records a `WriteComponent` only if the component is pre-existing.** `tx.edit(e).set(C, v)` where `C` was introduced earlier in this same transaction (spawn-initial or a prior `tx.addComponent`) **updates the pending structural payload** for `C` (the value that op will write to the document), rather than recording a separate value op. So the entity's `C` reaches the *document* now (as part of the structural add) and the *runtime/baseline* via projection — never through a synchronous `runtime.writeComponent`, which would throw because the runtime has no `C` column until the structural add projects (§12.3). A `WriteComponent` op is recorded **only** when `C` pre-existed the transaction (present in the baseline at tx-start), which is exactly the case where the runtime *does* have the column and the synchronous value write is valid. This keeps the value/structure split honest: the synchronous-value path is used only for components that were already real.
- **v1 does not coalesce.** `tx.addComponent(e, Fill, red)` then `tx.removeComponent(e, Fill)` records **both** ops (the overlay goes `{Fill}` → `{}`, so both preconditions pass); at seal they apply in order and Loro converges to "no Fill," with both edits in the oplog. The framework does not fold the pair away. (This mirrors the runtime's no-coalescing rule, §5.4 — same reasoning, one honest pass. Note the value-write *fold* above is a different thing: it is not cancelling a pair, it is directing a value into the structural op that introduces the component, which is required for correctness, not an optimization.)
- **A precondition violation throws at record time**, synchronously, from the `tx.*` call that violates it — *before* the block seals — so the error points at the offending line, not at some deferred flush. On throw the whole transaction is discarded (nothing commits, minted identities released, §12.3's atomic-authoring rule).

Because `createPair(e) → key` is bound *at record time*, when the spawn later projects, `resolveByKey(key)` finds the **same** `e` (§10.2) — it does not mint a second identity. So the handle the user holds and the entity projection places are one and the same: identity now, placement later, same entity.

**No aliases.** A static op list needed `"$frame"` placeholders because it referenced entities before they existed, in data. Imperative `tx` has no such gap — `tx.spawn` returns the real handle, the next line uses it. References are always real `Entity` values. (The recorded ops carry those real handles + keys; the wire/replay format has no alias variant either, since every ref was resolved at authoring time.)

The earlier op-list form — `world.commit([SpawnEntity({as:"$frame"}), SetRelation(shape, ChildOf, "$frame")])` — is replaced by the block above: same effect, real handles, one undo unit, no placeholders.

### 12.3 The executor — sealing the batch

At block exit the executor applies the recorded batch as **one sealed Loro commit**. The document and baseline are written synchronously; the *runtime* effect follows the split (§12): value-ops to existing entities apply now, structural effects do not (projection applies them). Identity and keys were already minted by `tx` at record time (§12.2), so the executor just resolves real handles — no aliases.

```
seal(batch):
  loroDoc.commit(() => { // ONE sealed commit — undo unit, sync message
    deferredDespawns = [] // despawns last, so edges aren't orphaned in the doc
    for op of batch:
      SpawnEntity: // identity/key already minted by tx.spawn; e, key are real
        doc.spawn(key) // DOCUMENT only — runtime placement + baseline advance at projection (§13)
        for (C,v) of op.components: doc.setComponent(key,C,v) // includes any values FOLDED in by a later tx.edit().set (§12.2)
        for t of op.tags: doc.addTag(key,t)
        // NOT applied to runtime or baseline here — the spawn projects (§13), creating e's row + advancing baseline then
      WriteComponent: // from tx.edit(e).set(C,v) — ONLY for a component that PRE-EXISTED
        runtime.writeComponent(e, C, v) // the tx (present in baseline at tx-start). The runtime therefore
        doc.setComponent(keyOf(e),C,v); baseline.setComponent(keyOf(e),C,v) // HAS the column → value write is valid; this
                                                        // IS the agreement point (§13.2), erasing in-flight divergence.
                                                        // (A write to an INTRODUCED-this-tx component never reaches here —
                                                        // it was folded into the AddComponent/SpawnEntity payload, §12.2.)
      AddComponent / RemoveComponent: // from tx.addComponent / tx.removeComponent — a SHAPE change
        doc.setComponent(keyOf(e),C,v) | doc.removeComponent(keyOf(e),C) // DOCUMENT only — runtime + baseline at projection (§13)
                                                        // (setComponent value here includes any folded tx.edit().set value)
      SetRelation / AddRelation / tag changes: // STRUCTURAL → DOCUMENT only, runtime + baseline at projection
        // §11.2 same-store, both-durable check on keyOf(e), keyOf(target)
        doc.setRelation(keyOf(e),rel,keyOf(t))
      DespawnEntity: deferredDespawns.push(op)
      ...resources analogously (setResource is value-like: runtime + baseline now)...
    for op of deferredDespawns:
      doc.despawn(keyOf(e)) // DOCUMENT only; runtime removal + baseline at projection (§13)
  })
```

The split in one line: **value writes to existing entities touch runtime, document, AND baseline synchronously (commit *is* the agreement point for them, §13.2); everything structural (spawns, despawns, component add/remove, relations, tags) touches *only the document* here, and reaches the runtime — and advances the baseline — through projection (§13).** Writing the structural baseline here too would be a bug: it would push the baseline *ahead* of the runtime (which hasn't placed the entity yet), so a concurrent remote structural change arriving before projection would compare against an already-advanced baseline and misreconcile. The baseline must advance *with* the runtime, which for structure is at projection. Identity is already real (minted at record time), so `tx.spawn`'s handle is valid immediately even though its placement waits for projection.

**Visibility of a durable operation — the table to hold in mind.** The split above has a directly observable consequence: what you can *do* with the result of a `tx.*` call, and *when*. "Queryable" means "matches `defineQuery` in a system"; "runtime-readable" means `world.read(e, C)` returns the value. For a transaction run *outside* a system, "after `sync()`" means the next `world.sync()` (top of the next frame); for one run *inside* a system, the frame's `sync()` has already passed, so it is the frame after that.

| Operation inside `doc.transaction` | Handle usable immediately (store, compare, pass to later `tx.*`)? | Runtime-readable immediately? | Queryable immediately? |
|---|---|---|---|
| `tx.spawn(...)` | **yes** (real handle, minted at record time) | no — placed at projection | no — after `sync()` |
| `tx.edit(e).set(C, v)` (C present) | yes | **yes** (value applies synchronously, §13.2) | already was (C present ⇒ already placed) |
| `tx.addComponent(e, C, v)` | yes | no — applies at projection | after `sync()` (migrates into C's archetype then) |
| `tx.removeComponent(e, C)` | yes | reads stop after projection | membership changes after `sync()` |
| `tx.addTag(e, T)` / `setRelation` / `addRelation` | yes | n/a (tags/relations, not component reads) | after `sync()` (tag/relation-filtered queries see it then) |

The single rule under the table: **durable *value* writes to existing entities are visible synchronously; every durable *structural* effect is visible after the next `sync()`.** The handle itself is always usable the instant `tx.spawn` returns — you can store it, compare it, and pass it to later operations *in the same transaction* — because identity is minted at record time (§12.2); only its *placement* (hence readability and queryability) waits for projection.

> **The central trap, stated bluntly: initial components are structure, not values.** The components passed to `tx.spawn({ components })`, and any component introduced by `tx.addComponent`, are **structural payloads — not synchronous value writes — even when followed by `tx.edit().set` on that same component in the same transaction.** They reach the runtime *only* through projection at the next `sync()`, never as an eager column write. This catches implementers and users alike, because the values *look* like values: it is tempting to think "a component's value is a value write, so it should apply now." It does not — the component doesn't exist in the runtime yet (the entity is identity-only until projection), so there is no column to write. A `tx.edit().set` on a component introduced earlier in the same transaction **folds into that component's structural payload** (§12.2); it does not become a separate synchronous runtime write. The dividing line is *not* "is this a value or a shape op" but "does the runtime already have this component": a value write to a **pre-existing** component (present in the baseline before this transaction) applies synchronously; a value written to a component the transaction itself is **introducing** rides projection with the rest of the structure.

Four properties are load-bearing:

- **The change set is explicit.** No diffing, no access tracking — "what changed" is the batch `tx` recorded.
- **One sealed `loroDoc.commit(body)` per transaction** keeps undo granularity: one user action is exactly one history entry, reversed as a unit. Scoped to *this* doc, so two docs never fold into one entry.
- **Ordering is spawns → cells/tags/relations → despawns** in the *document* (an entity must exist before anything references it; despawns last so no edge is orphaned).
- **Atomic authoring, and leaked handles are invalidated immediately.** If `fn` throws before sealing, nothing is committed — the batch is discarded, no `loroDoc.commit`, no document/baseline/runtime mutation. Rollback undoes everything the transaction built optimistically, and it does so **the same way `despawn` does**, which is the safety-critical part: for each identity `tx.spawn` minted, rollback **bumps the slot's generation *before* returning it to the freeList** (§2), removes the **key↔handle binding** from the projector bijection, and clears any **tags or relations** the transaction's overlay attached to that identity. Bumping the generation first is what makes a *leaked* handle safe: because `tx.spawn` returns a real `Entity` that app code may have captured before the throw, that handle must go stale the instant rollback runs — and a generation bump does exactly that. After rollback: `isAlive(e)` is `false`, `read`/`get` fail (generation mismatch, §5.5), and a later allocation that reuses the slot gets a *new* generation, so the leaked handle can never be resurrected into validity. (Returning the slot to the freeList without the bump would leave the leaked handle valid and let a future spawn alias it — precisely the gap this rule closes.) **Minted keys are additionally *burned*, not reused: the peer key counter does not roll back.** If the transaction minted `alice-41` and then threw, the next successful mint is `alice-42`. A returned handle's *key* (via `keyOf`) may also have leaked, so reusing that key later would risk colliding with a reference the app still holds; burning keeps key uniqueness monotonic and unconditional, and the counter is cheap and unbounded (§14.1). So rollback is all-or-nothing in *effects*, and in *identity* it moves strictly forward: the runtime slot is invalidated-then-reusable (with a fresh generation), the key is retired for good.

The whole access-registration / commit-dirty / baseline-diff apparatus of earlier drafts is **gone** — it existed only to reverse-engineer a change set from imperative writes, which the recorded batch states outright.

### 12.4 The seam: the binding

The durable layer is inert until **attached** to the runtime. Attach creates the **binding** — the seam — and projects the document's contents in. The binding lives *inside* the durable layer and is the only object in the layer that holds **both** a runtime reference (via the projector) and the baseline. That is deliberate: the one piece of logic that fundamentally needs both worlds is the reconcile compare (§13), and it lives here, at the seam, owned by neither pure side.

The binding has two faces, and the split is what keeps the layering direction unambiguous:

- **downward face (the *only* face the world holds)** — the binding implements **`InboundSource`**, and that is the sole face registered with the world at attach. It owns the projector, subscribes to the document's doc-facts, and runs the reconcile policy that reads the runtime (§13). The world knows the binding *only* as something to `drain()` at `sync()`.
- **the transaction surface lives on the `DurableStore` (`doc`), which app code calls directly** — `doc.transaction(fn)`. This is **not** a face the core or world holds: the core never has a reference to a `DurableTarget`, and there is exactly **one** transaction-capable object (the store), never two. The binding does not publicly expose `transaction`; internally it records the transaction's sealed batch and applies it to the document + baseline (and committed values straight to the runtime), but that is the *store's* transaction call reaching the binding, not the world opening a transaction. `attachDurable(store)` returns a **detach handle** (an `Attachment`), *not* another `DurableTarget` — so attaching never creates a second transaction surface.

```
APP CODE ──doc.transaction (a CALL on the STORE, returns fn's result)──► doc + baseline (+ runtime values)
WORLD    ◄──projection (EVENTS, drained at sync)── BINDING.reconcile ◄── doc-facts (own + remote, subscribe)
                                                   ▲ world holds ONLY the binding's InboundSource face
```

This is the redrawn boundary in one line: **app → durable is a typed call on the store (a transaction block that seals and returns); durable → world is an event stream (every doc-fact, own-origin included, drained once per frame at `sync` and applied immediately because `sync` is outside iteration).** The world's only tie to the durable layer is the `InboundSource` it drains — it never names `DurableTarget` (§12.1). Structure flows *only* on the downward arrow (§13.3); the transaction call writes the document and baseline (and committed values straight to the runtime). The only place a runtime value and a baseline value meet is `reconcile`.

> **Invariant — CRDT subscriptions enqueue, they never apply.** Loro fires its `subscribe` callback **synchronously during the `commit` call and during `applyRemote`** (v1.8+). If the binding applied doc-facts to the runtime *inside* that callback, projection could run in the middle of a `doc.transaction` issued from within a system — i.e. mid-iteration — breaking the "projection only runs outside iteration" guarantee that lets it skip the command buffer (§5.4, §16). So the binding's subscription callback does exactly one thing: **append the doc-facts to the binding's pending queue.** Nothing is applied there. `world.sync()` — called once per frame at a point where no system iterates (§16) — is what drains that queue and runs reconcile against the runtime. The rule stated plainly: *a CRDT subscription never mutates the runtime; it enqueues `ChangeEvent`s, and `sync()` drains them.* This is what makes "sync applies outside iteration" true even though Loro's events fire at commit time. (The ephemeral store follows the same discipline — its three EphemeralStore events enqueue, and its `drain()` projects at `sync`, §15.3.)

## 13. Projection and the reconcile model

Projection is the **durable → core** flow, and it is event-driven for three reasons the commit direction is not: it is triggered by something *outside the core's control* (a remote update arriving), it is *fan-out* (one remote change may touch many entities and any attached binding may care), and it must land at *tick boundaries*, not synchronously when Loro fires.

### 13.1 Attach — two-phase projection that seeds the baseline

On attach, the binding projects the document in two phases (a relation may reference an entity that appears later in iteration — the same reason as §8.2):

1. **entities / components / tags, building the bijection AND seeding the baseline.** For each durable entity, `resolveByKey` allocates a runtime handle (identity) and binds it, and the entity is **placed** — its components written via `projectComponent` (which places it into their archetype), or, if it has no components, `ensurePlaced` puts it in the empty archetype so it is still queryable (§10.3, Option A); tags are applied (also placing the entity). All values are written to the runtime **immediately** (§10.3 — attach runs outside iteration) **and** to the baseline.
2. **relations**, now that every target key has a handle; written to the runtime (immediately) and the baseline.

Attach applies immediately because it is two-phase bulk creation *outside* any system: every entity must be fully placed after phase 1 so phase-2 relations can wire them. Steady-state projection (§13.3) is the same — it runs during `sync()`, also outside iteration, also immediate — but unlike attach it carries *both* own-origin and remote doc-facts (a committed transaction's structure reaches the runtime here too, §12). Projection never defers; only system code (via `ctx`) does (§5.4).

The baseline-seeding in phase 1 is not optional bookkeeping — it is **the founding agreement**. At attach time the document *is* the agreed value, so `baseline := doc`. (If this were skipped, the baseline would be empty, and the first remote change to any projected entity would compare the runtime value against `undefined`, misread it as a local edit in flight, and wrongly skip it — see §13.3.)

**Hardened invariants:**
- A durable entity can **never** pre-exist in the runtime before its store is attached. Durable entities enter the runtime *only* via attach or inbound remote propagation. (Attach is therefore always pure creation, never reconciliation.)
- **No double attach.** One store ↔ at most one attachment; attaching an attached store throws.
- **Re-attach uses fresh handles.** Detach despawns the projected runtime entities and tears down the bijection; the document and its Loro doc are untouched. Re-attaching re-projects from scratch with *fresh* runtime handles. The durable keys are the stable identity; **handles are valid only within one attach lifetime.** An app that caches a handle across a detach must re-resolve — the generational check (§2) makes a stale handle fail loudly rather than silently.

### 13.2 The baseline-writer rule

The baseline equals the last value the runtime and the document agreed on, so it must be correct at every moment the runtime could be compared against it. It advances at **agreement points**:

1. **SEED** — at attach (§13.1), runtime and baseline written together from the document. The founding agreement.
2. **LOCAL VALUE AGREEMENT** — at `doc.transaction` (§12.3), a **value write to an existing entity** writes the runtime, the document, *and the baseline* synchronously inside the sealed batch. This is load-bearing: it erases any in-flight local divergence (a drag's runtime writes) at the moment of commit, so runtime and baseline agree again immediately. The own-origin echo of that value (arriving next `sync()`) then finds runtime == baseline and is a no-op in effect (see §13.3).
3. **PROJECTION AGREEMENT** — at `reconcile` (§13.3), the baseline advances to whatever is applied, for **both** structural changes (which reach the runtime *only* via projection — own or remote) and agreed remote values. A transaction's *structural* effects therefore advance the baseline when they project, not at the call — there is no synchronous runtime structural write to keep the baseline ahead of.

The asymmetry between (2) and (3) is exactly the value/structure split (§12): **values are applied — and their baseline advanced — synchronously at commit** (so a value-drag's divergence is resolved the instant you commit); **structure is applied — and its baseline advanced — at projection** (so the runtime learns structural facts one way, §13.3). Neither opens a stale-baseline window: the only reader of the baseline-vs-runtime comparison is `reconcile`, which runs only at `sync()` (§16), and by then committed values have already written the baseline synchronously, while structural facts advance the baseline in the same `reconcile` step that applies them.

This is why the earlier "ignore the own-origin echo" rule no longer holds, and is *replaced* by processing it (§13.3): a transaction no longer writes the runtime's *structure* synchronously, so the structural echo is the mechanism that applies it; and the value echo is applied as converged truth when no drag is in flight, because a concurrent remote may have changed the converged value between commit and sync. Own-origin is **processed, not discarded**. What a value echo (own *or* remote) yields to is an in-flight local drag on that cell (§13.3's guard) — the difference between own and remote there is only bookkeeping: a held-off own-echo still advances the baseline (a value we authored), a held-off remote value does not.

### 13.3 Reconcile — apply converged truth, hold a value echo off mid-drag

`reconcile` is the only place a runtime value and a baseline value meet, and it is now the **sole path by which structural document changes reach the runtime** (own or remote, §12). It runs from `world.sync()` (§16), outside any tick and therefore outside iteration, so its effects (including structural placement/migration) apply **immediately** (§10.3), never through a system command buffer.

The rule, derived by exhausting the origin × kind matrix, reduces to one sentence: **apply the document's converged value, except hold its runtime write off while a local value-drag is in flight on that cell — for an own-origin echo, the baseline still advances; for a remote value, nothing does.** One classification has to happen first, though: a `component-set` doc-fact is ambiguous — it can mean *add a previously-absent component* (structural) or *overwrite an existing component's value* (value), and those obey different rules (a remote structural add must apply even while an unrelated cell is mid-drag; a remote value overwrite may be dropped). The binding disambiguates against the **baseline**, which is the authoritative record of what this cell last was: **`component-set` on a key/comp the baseline does *not* have is a structural add; on one it *does* have, it is a value write.** (This is why classification lives in the binding, not the adapter: the CRDT adapter may only observe "map key changed" and cannot itself know add-vs-overwrite; the baseline can. If a future adapter *can* emit the distinction natively — as `component-add` vs `component-write` doc-facts — the binding uses that directly and skips the baseline check; the semantics are identical either way.)

**Batch normalization makes the baseline classification well-defined.** The classification compares against the baseline *as it stood before this commit* — which requires that a cell be reconciled **once per commit**, not once per raw doc-fact. If a single commit emitted two `component-set`s for the same cell (`Position ← p1`, then `Position ← p2`), naively processing them in order would apply the first, advance the baseline, and then misclassify the second as a value write (baseline now present) when both were part of one structural intent. So a commit's doc-facts are **normalized before reconcile**: collapse to the **final fact per cell** (per key/component, per key/tag, per key/relation-edge), preserving only the ordering that carries meaning — spawns before any fact that references the entity, despawns last. Each cell then reconciles exactly once, classified against the pre-commit baseline, and the mental model holds: *one transaction produces one final document state, and reconcile applies that state.* (This matches how a value-drag already collapses — many per-frame writes, one committed value; normalization is the same principle at the doc-fact layer. Loro may already coalesce same-cell writes within a commit, in which case normalization is a no-op; the binding does it regardless so the guarantee doesn't depend on adapter behavior.)

**Reconcile is final-state based, not op-history based — the full classification, per key/component.** Because normalization keeps only the final fact per cell, a same-commit sequence like `component-remove C` then `component-set C = v` reconciles as its *net effect*, judged against the pre-commit baseline — not as a remove-then-add pair. The complete table:

| baseline (pre-commit) | final state (post-normalize) | classified as | reconcile action |
|---|---|---|---|
| absent | present | **structural add** | `applyStructural` (place/migrate into C's archetype), baseline advances |
| present | present | **value write** | the (own/remote, value) drag-protected path — the cell's archetype membership is unchanged |
| present | absent | **structural remove** | `applyStructural` (migrate to smaller archetype), baseline advances |
| absent | absent | **no-op** | nothing (the component never existed and still doesn't) |

The rule reads off the two-by-two directly: **membership change (absent↔present) is structural; presence unchanged is a value write.** The `remove C` then `set C` case lands in row two (baseline present, final present) → value write, because the *net* archetype membership didn't change — which is correct, since the entity was and remains in C's archetype, and only C's value differs. This is the same final-state principle applied uniformly to components, tags, and relation edges (a tag or edge added-then-removed in one commit is, net, absent; removed-then-added is, net, present).

**Entity existence is part of classification (the spawn-batch case).** The table's "baseline" column means *the baseline as a whole*, and that includes whether the **entity/key exists** at all — not just whether a given component is present on an existing entity. For a fresh own-origin spawn batch —
```
spawn key
component-set key Position
component-set key Size
```
— the key is **absent from baseline entirely**, so *every* final-present component classifies as a **structural add under a newly-created entity**, never a value write. Stated as a rule: **if the key is absent from the pre-commit baseline, all its final-present components are structural creation payload for a new entity** (and the batch also carries the entity's creation itself). This resolves a question an implementer will hit: `baseline.getComponent(key, C)` returns `undefined` in two distinct situations — "the entity exists but lacks `C`" and "the entity doesn't exist at all" — and both correctly lead to *structural add*, but they are not the same fact. Classification checks entity existence first (`baseline.hasEntity(key)`): an absent entity means the whole batch is creation; a present entity with an absent component means that one component is an add onto an existing entity. Despawn/spawn normalization cares about the distinction (a despawn-then-respawn of the same key in one commit must net to "entity exists, freshly created," not to a stale-component value write), which is why existence is classified explicitly rather than inferred from per-component `undefined`.

**"No coalescing" and final-state normalization are two different layers — they do not conflict.** It is worth stating plainly, because "v1 does not coalesce" (§12.2) and "reconcile classifies `remove C` then `set C` as one value write" can *look* contradictory. They operate at different layers: **"no coalescing" governs the transaction/document operation stream** — the oplog faithfully records both `remove C` and `set C` (both edits are in Loro history, both are undoable, nothing is folded away). **Normalization governs projection into the runtime** — before touching the runtime, the binding collapses one commit to its final per-cell state and applies *that*, so the runtime performs one migration (or none), not the physical remove-then-add. So the document keeps every op; the runtime sees the net effect. A reader must not conclude that reconcile replays both physical migrations against the runtime — it does not; it applies the normalized final state exactly once per cell (which is what makes the batch-atomicity and single-migration guarantees hold).

```
reconcileBatch(facts): // one commit's doc-facts (own or remote), drained at sync()
  // ATOMIC: this loop runs synchronously to completion — no user system or callback runs between
  // facts of one batch. So the transient states WITHIN a batch (e.g. a spawn placed into the empty
  // archetype before its component facts migrate it out, §10.3) are never externally observable.
  for ev of normalize(facts): // NORMALIZE first: collapse to the final fact per cell
    reconcile(ev) // (key/comp, key/tag, key/edge), keep spawn-first + despawn-last
  // normalize() guarantees each cell appears once, so reconcile's baseline classification below compares
  // against the PRE-commit baseline, never a baseline already advanced by an earlier fact for the same cell.

reconcile(ev): // runs from sync(), outside iteration → applies immediately
  // Classify against the PRE-commit baseline, final-state semantics (§13.3 table). Well-defined
  // because normalize() left one final fact per cell:
  if ev.kind == "component-set":
    if baseline.getComponent(ev.key, ev.comp) == undefined:
      ev = { ...ev, kind: "structural" } // baseline absent, final present → structural ADD
    // else baseline present, final present → stays a value write (drag-protected path below)
  if ev.kind == "component-remove":
    if baseline.getComponent(ev.key, ev.comp) == undefined:
      return // baseline absent, final absent → NO-OP (never existed)
    // else baseline present, final absent → structural REMOVE (kind already "structural"/component-remove)

  switch (ev.origin, ev.kind):

    (own | remote, structural): // spawn / despawn / component ADD / component-remove / relation / tag
      applyStructural(ev); baseline.advance(ev) // dispatch to the projector kernel (§10.3) — see mapping below
      // structural facts have no in-flight divergence to protect, so own and remote both apply.
      // A remote component-ADD applies even while some other cell is mid-drag — placement is not drag-protected.

    (own, value): // own committed value — commit already wrote runtime+baseline (§13.2)
      if runtime(ev.key,ev.comp) == baseline(ev.key,ev.comp):
        // no local drag in flight on this cell → safe to apply Loro's CONVERGED value (§9.4).
        // Common case: ev.value == what we committed → a no-op. If a concurrent remote changed the
        // converged value, this corrects the runtime to truth.
        projector.applyComponent(ev.key, ev.comp, ev.value); baseline.setComponent(ev.key, ev.comp, ev.value)
      else:
        // a local re-drag is already in flight on this cell (runtime moved past baseline). DON'T stomp
        // the live drag with the echo — but DO advance the baseline to converged truth, so the next
        // remote-value comparison is against the right value. (This is the ONE asymmetry vs. the remote
        // branch below: remote-drop touches NEITHER runtime nor baseline; own-skip advances the baseline.
        // The echo carries a value we authored, so it is legitimate baseline truth even while the drag runs.)
        baseline.setComponent(ev.key, ev.comp, ev.value)

    (remote, value): // the one case with a drop — an OVERWRITE of a present component
      if runtime(ev.key,ev.comp) == baseline(ev.key,ev.comp):
        projector.applyComponent(ev.key,ev.comp,ev.value); baseline.setComponent(ev.key,ev.comp,ev.value) // AGREEMENT
      else:
        drop // local value-drag in flight: keep the drag; Loro keeps ev.value;
                                                 // the local commit wins as the later op, or remote wins on next
                                                 // sync once the drag commits (§13.5 — no abort). Baseline UNTOUCHED
                                                 // (unlike own-skip above): the remote value is not ours to bank.

// applyStructural(ev) dispatches a structural doc-fact to the kernel ops of §10.3:
// spawn → projector.applySpawn(ev.key) (resolves the handle AND places it —
// ensurePlaced, into the empty archetype if
// no components yet, so it is queryable, §10.3)
// despawn → projector.remove(ev.key) (both-directions relation cleanup + unbind)
// component-set classified as ADD → projector.applyComponent(ev.key, comp, v) (projectComponent PLACES it, §10.3)
// component-remove → projector.removeComponent(ev.key, comp) (resolves key → runtime.projectRemoveComponent; migrate down)
// tag-add/remove → projector.applyTag / removeTag(ev.key, tag) (applyTag places the entity too, §10.3)
// relation-* → projector.applyRelationSet / removeRelation(ev.key, rel, ev.target?)
// baseline.advance(ev) mirrors the same fact into the baseline snapshot. For a DESPAWN this means
// baseline.despawn(key), which must remove the entity record AND every relation edge whose source OR
// target is `key` — the baseline analogue of the runtime's both-directions cleanup (§5.5). If the
// baseline only dropped the entity record and left reverse edges, a later reconcile could compare against
// a phantom edge and think a deleted relation still exists. Baseline despawn is both-directions, like the
// runtime's.
```

Why each row is right (the matrix, condensed):

- **Structural (own or remote) → always apply.** Structure changes discretely; there is no continuous "structural drag" leaving the runtime diverged, so there is nothing to protect and no drop-case. Own-origin structural *must* apply — it is the runtime's only path to the change (the executor wrote only the document, §12.3). A spawn's projection finds the pre-bound handle (`tx.spawn` called `createPair` at record time, §12.2) and **places** it — into the empty archetype if it has no components yet (§10.3), so a componentless durable entity is queryable the moment its spawn projects — so identity-now and placement-now-via-projection are the same entity.
- **Own value → apply converged when no drag is in flight; otherwise advance the baseline only.** Commit already wrote runtime+baseline synchronously (§13.2). If nothing has moved the cell since (`runtime == baseline`), the echo's **converged** value is applied — usually a no-op (`ev.value == committed`), but a correction if a *concurrent remote* changed the converged value (ignoring the echo, as an earlier draft did, would miss that). If instead a **local re-drag is already in flight** (`runtime != baseline` — you committed, then grabbed the same cell again before this echo arrived), the echo does **not** overwrite the live drag; it advances the baseline to converged truth and leaves the runtime to the drag. This is the fix for what used to be a one-frame re-drag flicker (below). The asymmetry vs. the remote branch is deliberate and load-bearing: on skip, own-value **advances the baseline** (the echo is a value *we* authored, so it is legitimate banked truth), whereas remote-drop **touches neither** (a held-off remote value is not ours to bank until it wins ordering).
- **Remote value → apply if agreed, else drop.** If the runtime differs from the baseline, a local drag is mid-flight on that cell, so the remote write is held off (dropped from the runtime; Loro still holds it as truth) **and the baseline is left untouched**. When the drag commits, the local value is written synchronously (erasing the divergence) and wins or loses by Loro ordering on the next sync.

So the whole conflict model is: **converged truth flows to the runtime through `reconcile`; the single exception is that an in-flight local value-drag holds off *any* value write to that cell — own-echo or remote — until the drag commits** (the own-echo still advances the baseline; the remote value does not). Because projection carries Loro's *converged* values (never a raw local write), local and remote merge consistently even for own-origin echoes — a local edit during a concurrent remote resolves to the same converged value on every peer.

**Why the own-value guard, and what it does and doesn't cost.** Without it — applying every own-echo unconditionally — committing a value and then **re-dragging the same cell before the echo arrives** (pointerup commits, a fast pointerdown starts a new drag) would let the echo write the just-committed value over the new drag's first frame: a one-frame flicker on *every* fast re-drag. The guard removes it for free by reusing the drag detector the design already trusts (`runtime != baseline`, below): a live re-drag means the echo skips the runtime and only banks the baseline. Nothing is lost — the convergence-correction case (concurrent remote, *no* drag) still has `runtime == baseline` and still applies the corrected value.

The guard leaves exactly **one** residual, much smaller edge, and it is a property of the detector, not of this branch: because "is a drag in flight?" is *inferred* from `runtime != baseline` rather than read from a gesture flag, a drag that momentarily writes a value **exactly equal** to the last-agreed baseline is, for that one frame, seen as "no edit in flight" — so a concurrent remote (or remote-influenced own-echo) can be applied that frame. This is bounded (one frame; only when the dragged value coincides *exactly* with baseline; only under concurrent remote activity) and self-corrects on the next drag frame — and it is **not new**: the remote-value branch has always had it, since it uses the same detector. The own-value guard simply makes own-value share the property rather than differ from it. An app that needs gesture-exact protection instead of value-inferred can upgrade the detector without changing the framework: stamp each local write with a **per-cell edit sequence number** (or set a gesture-active flag on the cell) and treat "edit in flight" as that flag rather than `runtime != baseline`, so a drag onto a baseline-equal value is still recognized as in-flight. That is extra per-cell bookkeeping the default omits on purpose; it is the escape hatch for the detector-coincidence edge, no longer needed for the flicker (which the guard already handles).

The comparison `runtime != baseline` **is** the active-edit detection — there is no separate signal, marker, or gesture flag. "Has this component been edited locally since the last agreement?" is answered by comparing the runtime against the baseline's single current value.

**A batch applies atomically — no user code runs between its facts.** `drain()` applies each normalized batch (§13.3) **synchronously to completion**: no user system, callback, or render runs between the facts of one commit's batch. This is a stated invariant, not an incidental property, and it is what makes the *within-batch transient states* safe to ignore. The clearest example: under Option A (§5.2), a `spawn` doc-fact calls `ensurePlaced`, so the entity is briefly placed in the **empty archetype** before the same batch's component facts migrate it into its real archetype. If a query could run at that instant it would observe a componentless version of the entity — but none can, because `drain()` does not yield mid-batch, and it runs at `sync()` (top of frame, before any system, §16). So the entity becomes observable only in its *final* batch state, fully assembled. The same guarantee covers a component removed-then-re-added within a batch, a relation rewired within a batch, and every other multi-fact cell: implementers must apply a batch as one uninterruptible unit, because half-applied batch state would otherwise leak into a query or a render.

### 13.4 What the model buys (component-granular, committer-wins)

- **Concurrent edits to the same component don't merge.** While runtime ≠ baseline, remote changes are dropped; on commit your whole component is the later Loro op and wins. A merged `Transform` with your `x` and their `y` is a position neither chose — the committer owns the whole component.
- **Different components are independent.** Each has its own baseline cell and reconciles separately, so two people editing different aspects of one shape both succeed. (A drag diverging `Transform` does not block a remote `Fill` change — they are different cells.)
- **Bursts of remote changes during an edit are free.** The baseline does not chase Loro; it stays the anchor. One remote op or a hundred during a drag cost the same — a series of cheap compares, the runtime untouched. This is the entire reason the baseline *lags* rather than mirrors.
- **In-progress edits are invisible to collaborators until commit.** Intermediate values never enter Loro (commit is the only thing that writes the doc), keeping the oplog compact. Live "watch someone drag" is a *separate ephemeral channel* (Part IV).

**Durable resources reconcile exactly like a single-cell component.** A resource (a world singleton, §5) is durable when it lives in the document, and its reconcile rule is the component rule with a cardinality of one — there is no separate resource-reconcile machinery, and that symmetry is deliberate. Concretely, treating the whole resource value as one cell:
- **Whole-resource, committer-wins.** The conflict unit is the entire resource value (there is no field-level merge, exactly as for components). A `doc.transaction` that `setResource`s commits the whole value as one Loro op; the last committer to write the resource wins it entirely.
- **A resource *can* diverge locally during an edit, and remote writes drop while it does.** If a system or interaction drives repeated `setResource` runtime writes (a value being scrubbed), the resource's `runtimeResource != baselineResource` is the same drag-in-flight signal as for a component cell — so a concurrent *remote* resource write is **dropped** while the local edit is in flight, and applied (as converged truth) once runtime and baseline agree again. The own-commit writes runtime + doc + baseline synchronously (§13.2), collapsing the divergence at commit.
- **Reconcile is value-only for resources.** A resource has no structure — it always exists as a singleton — so there is no add/remove/place dimension: every resource reconcile is a value reconcile (the `(own,value)` / `(remote,value)` branches of §13.3), never a structural one. `removeResource` is the one exception (a rare structural-ish "the singleton is gone"), handled as its own fact.
- **Resources are durable-or-local only — never ephemeral.** The ephemeral layer has no resources (§15); transient shared singletons aren't a thing, because ephemeral state is per-entity and writer-partitioned (a "resource" has no single writer). Confirmed absent by design, not omission.

**Resource runtime semantics, made precise (the questions components already answer, stated for resources).** Resources are simpler than entity components — no identity, no placement, no archetype — so their rules are a short list rather than a subsystem:
- **`getResource(res)` returns `S | undefined`** — it does **not** throw when the resource is absent. A resource can be genuinely unset (never written, or `removeResource`d), and unlike a component read on a matched query row, there is no context that *guarantees* a resource exists, so the safe `undefined`-returning form is the only reader (there is no throwing `readResource` twin). Callers branch on `undefined`.
- **No "identity-only" analog.** A resource either has a value or does not; there is no allocated-but-unplaced middle state (placement is an entity/archetype concept, and resources have neither). So the three-state model (§5.2) does not apply — a resource is binary: present or absent.
- **`setResource(res, v)` requires a *complete* value, with the same defaults rule as components.** The value must supply every field the schema declares without a default; fields with a `field(..., { default })` may be omitted and take the default (§4). There is no partial resource write — `setResource` sets the whole singleton, exactly as a component value write sets the whole component (which is also why durable resources reconcile whole-value, committer-wins, above).
- **`removeResource(res)` is always allowed.** There is no notion of a "required" resource the runtime enforces — requiredness, if an app wants it, is app-level. After `removeResource`, `getResource` returns `undefined` until the next `setResource`. (Durably, `removeResource` is the one structural-ish resource fact; §13.4.)
- **A local snapshot serializes only *present* resources.** An absent resource is simply not written to the snapshot; on load, resources not in the snapshot are absent (so `getResource` returns `undefined`) until set. There is no "null resource" placeholder — absence is represented by omission, symmetric with how the runtime holds it.

> **A schema-design rule falls out of committer-wins** (stated in full at §4's "schema design for collaboration" box). Because the conflict unit is the whole component, fields that genuinely need independent concurrent editing must be *separate components*. If two collaborators must be able to change an element's position and its rotation at the same time without one clobbering the other, do not put `x/y` and `rotation` in one `Transform` — split them. The component boundary *is* the concurrency boundary.

### 13.5 Edit-in-flight: diverge, then commit. No abort.

An edit in flight has exactly two states and exactly one ending:

```
diverge — runtime writes (a drag) move a cell away from its baseline;
            remote changes to that cell are dropped while diverged (§13.3)
commit — the local value goes to the document; it wins as the later op,
            the baseline advances to it (§13.2 rule 2), agreement is restored
```

**The framework does not abort, does not roll back, does not re-sync a diverged cell from the document.** Commit is the only sanctioned ending. This is a deliberate scope decision: rolling an edit back to a chosen value is *interaction UX*, which the framework leaves to the app (consistent with the collaboration boundary, §16). The framework provides divergence as a tool and commit as the way to resolve it.

The consequence the user must hold in mind: **a runtime write to a durable cell is a promise to commit that cell.** An edit that diverges a cell and ends *without* committing it — a gesture torn down without a commit, say — strands the cell: it stays diverged forever, every future remote change to it is dropped, and the entity goes silently deaf to that collaborator's edits on that cell. This is **misuse**, in the same category as mutating React state directly instead of via `setState`: the framework does not prevent it and does not clean it up — it is a use pattern you bear.

What the framework *does* do is refuse to let the misuse be silent where it can notice cheaply. The place a stranded cell *manifests* is `reconcile`, dropping a remote change — which already has both values in hand and runs off the hot path. So in **dev mode** the binding counts consecutive drops per cell, and warns when a cell has been rejecting remote changes across many ticks:

> `[strata] cell alice-1|Transform has dropped 600 remote changes in a row — it looks stranded. A runtime edit diverged this cell from its baseline and never committed, so remote changes will keep being skipped. Commit the edit, or if you meant to discard it, write the converged value back yourself (read it from the document, then commit). The framework does not abort/roll back.`

The warning is **gesture-agnostic** — it knows nothing about gestures, edit sessions, or lifecycles; it only knows the pure sync fact "I keep dropping changes to this cell." That is what keeps it off the hot path (it rides the already-deferred reconcile) and keeps the boundary clean (no gesture concept leaks into the sync layer). The agreement branch clears the counter when a cell reconverges, so only genuinely-stranded cells trip it; the threshold is tunable and the whole mechanism compiles out of production builds.

An app that *wants* abort builds it: the framework keeps the converged-value **read** (`doc.getComponent(key, c)`), so the app reads what the document converged to and writes it back via its own commit — whatever abort semantics it likes. The framework supplies the primitive; it does not supply the policy.

**Undo/redo flow through the same reconcile path as any other change — nothing special.** `CRDTSnapshot` exposes `undo()`/`redo()` (§9.3), but they have *no* dedicated runtime path: calling `doc.undo()` produces the inverse edits **as ordinary doc-facts**, which Loro emits through the same `subscribe` callback as a commit (§12.4) — so they land in the binding's pending queue and are **reconciled at the next `sync()`**, exactly like a local commit's own-echo or a remote peer's change. The runtime learns of an undo the one way it learns of anything: a drained `ChangeBatch`. Two consequences worth stating: **(1)** undo/redo are **not synchronous** to the runtime — `doc.undo()` does not immediately mutate columns; the effect appears at the next frame's `sync()`, the same one-frame structural latency as every other doc-originated change (§12 timing table). **(2)** undoing a local *structural* commit (a spawn, an add/remove component) projects as the corresponding structural **removal/addition** at that `sync()` — an undone spawn despawns the entity, an undone `addComponent` removes it — routed through projection (§13.3), never as a synchronous structural edit mid-frame. So "undo" is not a special operation the runtime implements; it is a source of normal doc-facts, and the whole reconcile machinery (normalization, final-state classification, batch-atomicity) applies to it unchanged. (Undo of a *value* commit reconciles as a value write to the converged prior value, drag-protected like any inbound value — §13.3.)

## 14. Identity, construction, and the Loro boundary

### 14.1 Two ids, never conflated

- **Document id** — one stable GUID per durable store / Loro doc, created once, shared by all collaborators. Identifies *the document*.
- **Entity key** — identifies an entity *within* a document, **locally mintable and collision-free across concurrent editors**. When Alice and Bob both create an element offline, their keys must not collide on sync, with no coordination. The scheme is a **peer-prefixed counter** (`${peerId}-${counter}`), minted by the store from its Loro doc's peer id; UUIDv4 is the foolproof fallback if peer-id hygiene is hard to guarantee.

The multi-user case is precisely *why* the key must be peer-scoped: a doc-scoped counter would have Alice and Bob both mint `5` and collide; peer-prefixing makes `alice-5` ≠ `bob-5`. Peer-prefixing handles *cross-peer* collision; the counter must additionally **resume across sessions** (a reloaded document already holds this peer's prior keys, so the counter starts past them, not at 0 — §14.2). Local mintability is what enables offline edits with no server round-trip per element. The runtime never sees keys — it knows only its generational handles — and the projector's bijection (§10) translates at the boundary.

### 14.2 `createDurableStore(doc)` — the one place Loro enters

The user owns the Loro document's lifecycle: constructing it, loading bytes into it, and wiring it to a network transport. `createDurableStore` takes that document and does all the wrapping:

```ts
function createDurableStore(doc: LoroDoc): DurableStore {
  const prefix = `${doc.peerIdStr}-`;
  // RESUME the counter past any keys THIS peer already minted in a prior session — otherwise a
  // reload of a document we previously wrote to would restart at 0 and re-mint colliding keys.
  let counter = 1 + maxExistingSuffix(doc, prefix); // scan doc keys with our prefix; -1 → start at 0
  const mintKey = () => `${prefix}${counter++}`; // §14.1, derived from the doc's own peer id
  return new DurableStore({
    doc: new LoroSnapshot(doc), // Loro quarantined behind CRDTSnapshot
    baseline: createBaselineSnapshot(), // a fresh in-memory MutableSnapshot
    mintKey,
    docId: /* stable GUID */,
  });
}
```

**The counter resumes from the document, it does not reset.** A peer that reloads a document it previously contributed to must not restart its key counter at 0 — the document already contains `alice-0 … alice-40` from last session, and minting `alice-0` again would collide with its own prior entity. So construction **scans the loaded document for keys carrying this peer's prefix and resumes at `max + 1`** (`maxExistingSuffix` returns the largest integer suffix among keys starting with `prefix`, or −1 if none). This is a correctness requirement for offline/editor workflows, where reopening a saved document is the normal case, not an edge case. (Alternatives — persisting the counter in the doc, or UUID/ULID keys — also work; scanning is chosen because it needs no extra stored state and keeps keys short and human-legible for debugging. Peer-prefixing already guarantees *cross-peer* non-collision, §14.1; the scan guarantees *cross-session* non-collision for one peer.)

`LoroDoc` appears as exactly one parameter on exactly one function, and `LoroSnapshot` — one of the two Loro-aware adapter classes (the other is `LoroEphemeralSnapshot`, §15/Part IV) — is constructed in exactly one place. Everything downstream (the store, the binding, the projector, reconcile) speaks only the Part II interfaces. Taking the document as input also makes the key scheme *honest*: the peer-prefix is derived from the very document the user hands in, which is exactly what §14.1 requires.

> **Transport is the host app's job — but the wiring is explicit.** The durable layer *converges* a document; it does not move bytes between peers. The user constructs the `LoroDoc`, wraps it with `createDurableStore`, and wires two directions to their transport (WebSocket, WebRTC, whatever). The official surface is on the `DurableStore` — you do **not** reach past it to `loroDoc.import`/`export`; the store's methods are the boundary (so Loro stays quarantined, §14.2):
> ```ts
> const doc = createDurableStore(loroDoc);
> world.attachDurable(doc);
>
> // INBOUND durable bytes: remote → store. The store imports them and surfaces ChangeBatches to its
> // binding's pending queue; world.sync() drains and reconciles them (§12.2, §13.3). This is the exact
> // durable parallel to ephemeral's `source.apply(bytes)` (§15.5).
> transport.onMessage(bytes => doc.applyRemote(bytes));
>
> // OUTBOUND durable bytes: store → remote. subscribeOutbound fires with the encoded bytes of each
> // sealed commit (the transaction seal, §12.3), which you forward to the wire. As with ephemeral's
> // `send`, the app provides the sink once; there is no per-frame flush call.
> doc.subscribeOutbound(bytes => transport.send(bytes));
> ```
> The exact boundary matters because reconcile depends on receiving `ChangeBatch`es *with origin* (§9.4): routing inbound bytes through `doc.applyRemote` is what produces origin-tagged, per-commit batches. Feeding bytes directly into the raw `LoroDoc` behind the store's back would bypass the batch/origin machinery the binding relies on, so `doc.applyRemote` is the one official inbound API. (Symmetry with ephemeral, for the mental model: durable inbound is `doc.applyRemote(bytes)` ↔ ephemeral inbound is `source.apply(bytes)`; durable outbound is `doc.subscribeOutbound(send)` ↔ ephemeral outbound is the `send` callback given at construction. Both layers: app owns the socket, framework owns the encode/decode and the convergence.)
>
> **Two `applyRemote`s, two layers — not a contradiction.** The public `DurableStore.applyRemote(bytes)` returns **`void`**, while the low-level `CRDTSnapshot.applyRemote(bytes)` (implemented by `LoroSnapshot`, §9.3) returns **`ChangeBatch[]`**. These are deliberately different methods at different layers, not an inconsistency: the store's public method is a **fire-and-forget wire entry point** — it *delegates* to the snapshot's `applyRemote`, takes the `ChangeBatch[]` that comes back, and **routes those batches into the binding's pending queue** (drained at the next `sync()`, §13.3), returning nothing to the caller. The caller (the app's transport handler) has no use for the batches — they belong to the binding, which reconciles them — so surfacing them would be a leak of internal plumbing. The snapshot's method returns the batches precisely because *its* caller (the store) is the one that needs them to enqueue. So the flow is: `transport → doc.applyRemote(bytes) → [delegates] loroSnapshot.applyRemote(bytes): ChangeBatch[] → [enqueue] binding.pendingQueue → sync() drains`. Public API hides the batches; the internal adapter produces them.

---

## Part III — API reference

The public surface for this part. Signatures are TypeScript sketches.

### API — durable layer

```ts
function createDurableStore(doc: LoroDoc): DurableStore; // the ONE place a LoroDoc enters (§14.2)

interface DurableStore extends DurableTarget {
  readonly docId: string; // stable, shared by all collaborators (§14.1)
  transaction<R>(fn: (tx: Mutator) => R): R; // the one way to change the document (§12)
  getComponent<S>(e: Entity, c: Component<S>): S | undefined; // converged document value (read); undefined if absent
  // Handle ⇄ durable-key translation — the public boundary for PERSISTING references (§14).
  // A runtime handle is valid only within one attach lifetime (§2/§9.2); to keep a reference across
  // detach/reattach, a document reload, or a UI-state rebuild, persist the KEY and re-resolve after attach.
  keyOf(e: Entity): EntityKey | undefined; // the durable key bound to this handle, or undefined if e isn't durable
  resolve(key: EntityKey): Entity | undefined; // the current handle for this key, or undefined if not present/attached
  applyRemote(bytes: Uint8Array): void; // INBOUND wire (§12.2/§14.2): import remote bytes → origin-tagged ChangeBatches
                                        //   to the binding's pending queue, drained at sync(). The ONE official inbound API.
  subscribeOutbound(fn: (bytes: Uint8Array) => void): Unsubscribe; // OUTBOUND wire: sealed-commit bytes for transport
  // internals (LoroSnapshot, baseline, key minter) are not public surface
}

interface DurableTarget { // the durable STORE's contract (§12.1) — what `doc` IS. App code calls
  transaction<R>(fn: (tx: Mutator) => R): R; // this DIRECTLY (doc.transaction). The CORE/WORLD never names it.
}
// (DurableStore extends DurableTarget — full surface above. It is the ONE transaction-capable object;
//  createDurableStore returns it and app code calls doc.transaction on it, never on the binding.)

interface DurableBinding extends InboundSource { // the SEAM (§12.4). Implements ONLY InboundSource publicly.
  // The world holds ONLY this InboundSource face: drain() reconciles pending doc changes (own + remote)
  // into the runtime IMMEDIATELY; the world calls drain() from world.sync() (§16/§13.3). The binding does
  // NOT expose transaction — that lives on the DurableStore, which app code calls directly. So there are
  // never two transaction surfaces. Internally the binding holds BOTH runtime (via projector) and baseline
  // — the only object that does — and receives the store's sealed transaction batches to apply.
}

interface Attachment { detach(): void; } // what attachDurable/attachEphemeral RETURN — a detach handle, NOT a
                                          // DurableTarget. Attaching never creates a second transaction surface.

// `tx` is a Mutator (§5 vocabulary, identical to world/ctx). Its calls RECORD into the
// transaction's batch and seal at block exit (§12.2-12.3): tx.spawn returns a REAL handle
// (eager identity + bound key), so there are no aliases. Internally the batch is a list of
// StructuralCommands (§5.3) — the serializable format the executor, wire, and replay share.
// Op CONSTRUCTORS below are that internal/wire format; authors use tx.* methods, not these.
// Op is a SUPERSET of StructuralCommand: it adds the VALUE ops (WriteComponent, SetResource) that
// a transaction records but the runtime buffer never carries (value writes are immediate, §5.3).
function SpawnEntity(spec: { entity: Entity; key: EntityKey; components?: ComponentInit; tags?: TagId[] }): Op;
function DespawnEntity(e: Entity): Op;
function AddComponent(e: Entity, c: ComponentId, value: ComponentValue): Op; // SHAPE: attach (precondition: absent)
function RemoveComponent(e: Entity, c: ComponentId): Op; // SHAPE: detach (precondition: present)
function WriteComponent(e: Entity, c: ComponentId, value: ComponentValue): Op; // VALUE: overwrite (precond: present) — tx.edit().set
function AddTag(e: Entity, t: TagId): Op;
function RemoveTag(e: Entity, t: TagId): Op;
function SetRelation(e: Entity, r: RelationId, target: Entity): Op; // arity "one": set/replace
function AddRelation(e: Entity, r: RelationId, target: Entity): Op; // arity "many": add edge
function RemoveRelation(e: Entity, r: RelationId, target?: Entity): Op;
function SetResource(res: ResourceId, value: ComponentValue): Op; // VALUE: world-singleton write (immediate)
function RemoveResource(res: ResourceId): Op;
// These op constructors are id-keyed (the in-process recorded/replay format, §5.3). When the executor
// WRITES the batch to the Loro document, the adapter (LoroSnapshot) translates each ComponentId/TagId/
// RelationId to its stable ComponentName/TagName/RelationName (§3.4) — the document stores NAMES, never
// run-local ids. Inbound reverses it: the adapter reads names and surfaces id-keyed ChangeEvents.

// StructuralCommand (§5.3) is the buffer's element type: the STRUCTURAL subset of Op — spawn/despawn,
// add/remove component, tag ops, relation ops. It EXCLUDES the value ops (WriteComponent, SetResource),
// because value writes are immediate and never buffered. Only SYSTEM code (via ctx) enqueues
// StructuralCommands; durable projection and inbound remote apply immediately (sync is outside
// iteration, §10.3), so they never use the buffer. (This is the clean version of the old overlap:
// the buffer type is structural-only; the durable Op type adds value ops. No single type straddles.)
type StructuralCommand = /* the structural subset of Op — ref: Entity, no value ops */;

// --- The layer surface added to World (methods on the Part I objects) ---

// On World:
// attachDurable(store: DurableStore): Attachment; // project doc content; register binding's InboundSource;
//                                                  // returns a DETACH HANDLE (not a DurableTarget — §12.4/#9)
// detach(store: DurableStore | EphemeralStore): void; // despawn projection, stop sync (or call attachment.detach())
// Attaching registers the binding as an InboundSource, so world.sync() drains it (§16).
//
// Changing the document is `doc.transaction(fn)` on the DurableStore (above), NOT a World/ctx
// method — and it works identically inside or outside a system (§12), so there is no
// ctx.transaction: identity-mint and value-writes are iteration-safe, and structure flows
// through projection (which runs at sync, outside iteration).
```

Durable content is created and changed by `doc.transaction(fn)` — `tx.*` calls recorded and sealed as one Loro commit (one undo unit, one sync message); committed values reach the runtime synchronously, structure via projection (§12–13). There is **no abort/rollback** in the framework (§13.5); a transaction is the only way an edit ends, and the converged-value read (`doc.getComponent`) lets an app build its own discard if it wants one.

### 14.3 Persisting references — keys, not handles

A runtime handle is valid **only within one attach lifetime** (§2, §9.2): it is a slot+generation the runtime allocated, meaningless after detach/reattach or a document reload, and it will not survive being stored in `localStorage` and read back next session. But apps constantly need to *persist a reference* — "the last-selected shape," a bookmark, a piece of serialized UI state, an undo-stack entry that names an entity. The rule: **persist the durable *key*, re-resolve to a handle after attach.** The `DurableStore` exposes exactly this boundary — `keyOf(e)` to get the stable key for a handle you hold now, `resolve(key)` to get the current handle for a key after (re)attach:

```ts
const savedKey = doc.keyOf(selected); // stable string — safe to persist / serialize / send
// … detach, reload, reattach, or just rebuild UI state …
const selected = doc.resolve(savedKey); // Entity | undefined — undefined if that entity is gone or not yet attached
```

Without this, cached handles silently rot across detach and there is no supported way to re-anchor them; with it, the pattern is "keys are the durable currency of identity, handles are the ephemeral runtime currency, and the projector's bijection (§10) translates at the boundary" — the same principle the internals already run on, now exposed for app-level references.

**Storing a reference *inside* a component — use a key, and say so.** The runtime's first-class way to link entities is a **relation** (§3.3), and that is what you should reach for when the link is part of the ECS graph (queryable, cascade-cleaned on despawn). But apps also carry references that are *not* graph edges — a durable key mentioned in serialized metadata, a cross-document pointer, an ephemeral entity referencing a durable one (§15.6). For those, store the **key**, not a runtime handle (which would be meaningless once reloaded) and not a bare `eid` (which is a *runtime* reference, wrong for anything persisted). The clean way to express this in a schema is a dedicated field type:

```ts
const EditingRef = defineComponent("EditingRef", { target: "key" }); // stores an EntityKey string, intent explicit
```

A `"key"` field is stored like a `string` (§3.4) but *names* its contents as "a durable entity key," which documents intent and lets tooling validate it (is this a well-formed key? does it resolve?) — strictly better than a raw `"string"`, which works but loses the meaning. (This is guidance rather than a hard runtime-core requirement: `"string"` + discipline is functionally equivalent; `"key"` just makes the intent first-class. The ephemeral layer already leans on this pattern for cross-store references, §15.6.)


# PART IV — THE EPHEMERAL LAYER

Where the durable layer carries *document content* (synced, persisted, undoable, committed at explicit boundaries), the ephemeral layer carries **transient synced state that is never kept** — the tier for anything you want other peers to see live but never write to the document: cursors, selections, viewports, "who's here," live drag previews, "I'm typing." The most common use is **presence**, but the layer is not *defined* as a presence system — it is a second, general **ephemeral entity store** with the same *flat entity* mutation vocabulary as the durable layer — spawn/despawn, add/remove component, value writes, tags, but **deliberately no relations and no resources** (§15.6) — distinguished only by what it is (transient, LWW, TTL'd) rather than by a baked-in presence policy. Presence is then just the natural thing you build with it.

```
Runtime (local-only) ── your own in-flight state; never synced
Durable ── document content; committed, persisted, undoable
Ephemeral ── transient shared state; eager-synced, never persisted, never undoable, TTL'd
```

The ephemeral layer is a true **sibling** of the durable layer — same projector kernel (Part II), same `Mutator` surface (spawn/despawn/add/remove/write, §5) — with the two pieces that make durable *hard* simply **absent**: the reconcile baseline and the two-phase relation pass don't exist here. What makes that possible is one structural choice, spelled out below: **the ephemeral keyspace is partitioned by writer**, so no entity is ever concurrently written, so there is nothing to reconcile.

## 15. The ephemeral entity store — a writable sibling, partitioned by writer

### 15.1 The model: writer-partitioned, so conflict-free by construction

The ephemeral store lets each peer **spawn and mutate its own ephemeral entities freely**, syncs them to all peers, projects remote peers' entities into your runtime as read-only queryable entities, and expires them by TTL. The entire simplification rests on one rule:

> **Every ephemeral entity is owned by the peer that spawned it. Only its owner mutates it. Remote peers see it read-only.**

This is **writer partitioning**: Alice's ephemeral entities and Bob's are disjoint sets, each keyed under its owner's peer id (§15.3), and no peer ever writes across the partition. The payoff is that the ephemeral layer keeps its *single genuine advantage* over the durable layer — **no conflict machinery** — because a conflict requires two writers on one cell, and partitioning makes that impossible. (If you want *shared* mutable state that multiple peers change, that is what the durable layer is for; it has a real CRDT merge and committer-wins conflict resolution. The ephemeral layer deliberately does **not** compete there — Loro's `EphemeralStore` is LWW-per-key, which is correct precisely *because* keys are never concurrently written under partitioning.)

| | Durable | Ephemeral |
|---|---|---|
| Purpose | document content | transient shared state (presence, previews, …) |
| Mutator surface (spawn/add/remove/write) | ✅ `tx.*` | ✅ `eph.*` — **but only on your own partition** |
| Projector kernel (key↔handle, project to runtime) | ✅ | ✅ **same kernel** |
| Identity / keyspace | per-document, peer-prefixed | **partitioned by writer**, peer-prefixed (§15.3) |
| Who writes an entity | anyone (shared) | **only its owning peer** |
| Baseline + reconcile compare | ✅ | ❌ **deleted** (writer-partitioned → never contended) |
| Two-phase relation projection | ✅ | ❌ **dropped** (no relations, §15.6) |
| Upward path | `doc.transaction(fn)` → result | **eager, throttled, self-flushed** (no transaction, §15.5) |
| Persisted / Undo | yes / yes | **never / never** |
| Conflicts | committer-wins, component-granular | **none** (writer partition) |
| Lifecycle | explicit create/delete | **Loro's three EphemeralStore events → spawn/update/despawn** (§15.3) |
| Backed by | Loro doc (history + persistence) | **Loro EphemeralStore** (LWW key-value, per-entry TTL, no history) |

Two removals deserve a word, because they are the whole simplification:

**No baseline → no apply/skip.** The baseline exists for exactly one purpose: to answer "has the runtime edited this cell since the last agreement?" so projection can avoid clobbering a local edit (§13.3). Under writer partitioning **no ephemeral cell is ever contended** — you write only entities in your own partition, and a remote entity is written only by its owner. So the question the baseline answers *cannot arise*, and the entire reconcile apparatus is deleted, not configured to "always apply." Remote ephemeral projection is unconditional: a remote change arrives, it is applied to the runtime with no baseline compare and no drop-case (there is no drag-protection to enforce — that is the durable layer's concern, §13.3). Your *own* changes never travel this path at all: you applied them to your runtime synchronously when you called `eph.*` (Option A, §15.2), and their echoed-back `local` event is a runtime no-op (§15.3).

**No relations → single-phase projection.** Ephemeral entities are flat (components and tags only — §15.6). So phase 2 of projection, which exists only because a relation may reference an entity that appears later, is dropped. Ephemeral projection spawns/updates a remote entity and writes its flat components; there is no ordering dance.

### 15.2 The surface: the `Mutator` vocabulary, scoped to your partition

The ephemeral store exposes the **same mutation vocabulary as the durable layer and the runtime** (§5) — `spawn`, `despawn`, `addComponent`, `removeComponent`, `edit().set`, tags — with one scoping rule: **you may only mutate entities you spawned** (your partition). There is no transaction wrapper (ephemeral has no undo and no atomic-seal need, §15.5); you just mutate, and the store syncs.

```ts
const eph = createEphemeralStore(myLoroEphemeralStore, {
  peerId: myPeerId, send: bytes => transport.broadcast(bytes), throttleMs: 16, ttlMs: 5000, // §15.3, §15.5
});
world.attachEphemeral(eph);

// spawn ephemeral entities in MY partition — real handles, usable immediately (§5.2 identity rule)
// (the store auto-tags entities you spawn with the framework tag `Local`, so queries exclude your own — §15.4)
const cursor = eph.spawn({ components: { CursorPos: { x: mx, y: my }, PresenceInfo: { name: "Alice", color: 0xff0000 } } });
eph.edit(cursor).set(CursorPos, { x: mx2, y: my2 }); // value write on my own entity
eph.addComponent(cursor, Selection, { targetKey }); // add a facet when I start selecting
eph.removeComponent(cursor, Selection); // drop it when I stop — component PRESENCE is the signal (§15.6)
eph.despawn(cursor); // remove my entity → remote despawn
```

Dynamic components are the point of exposing add/remove: "is this peer selecting?" becomes a query for `[PresenceInfo, Selection]` — the component's *membership* answers it, no sentinel value needed (§15.6).

**Timing: your own ephemeral mutation is immediate; remote ephemeral changes project at `sync()`.** This is the split that makes presence work — you must be able to `eph.spawn` your cursor entity and `eph.edit` it in the same handler, so a locally-spawned entity has to be placed *now*, not one frame later. Concretely:
- **Local mutation applies to the runtime immediately, and is designed for use *outside* a tick** — an input handler (pointer move, selection change), which is where presence updates come from. `eph.spawn` places your entity now; `eph.edit(e).set(C, v)` writes now; `eph.addComponent`/`removeComponent` migrate now. So `eph.spawn(...)` then `eph.edit(me).set(CursorPos, ...)` in one handler works — the component exists in runtime columns by the second line. In parallel, the mutation is queued for outbound (throttled/self-flushed, §15.5).
- **Inside a system body, structural `eph.*` throws in *all* builds; value `eph.edit().set` is allowed.** The runtime's deferral mechanism is the `ctx` binding (§5.4) — a store never has a hidden "am I iterating?" mode (§3) — and there is deliberately **no** `ctx`-bound ephemeral mutator in v1. Rather than let `eph.spawn`/`addComponent`/`removeComponent` corrupt an in-progress iteration by placing immediately (an archetype migration mid-loop is a memory-safety hazard, not a style issue), v1 **rejects** structural ephemeral mutation from within a system — and this rejection is **unconditional, not a dev-only assertion**. If the check were compiled out in production, a structural `eph.*` mid-iteration would silently migrate archetypes under the running query and corrupt it; given the rest of the spec's safety posture, that is unacceptable, so the throw stays in every build. **Dev mode adds a detailed diagnostic** (pointing at the input-handler pattern, or "stage it and apply after the tick"); production still throws, just with a terser message. The check is cheap enough to keep everywhere: the framework tracks a single `isIterating` boolean set only around system execution (§16), so the guard is one boolean read, not a per-call cost worth optimizing away. (This is the general rule for the whole framework, not just ephemeral: **any mutation path that would corrupt active iteration throws in all builds** — the runtime command-buffer discipline enforces the same thing for `world.*` structural ops issued mid-tick.) A *value* write to an already-placed ephemeral entity (`eph.edit(e).set(C, v)`) is fine inside a system — it reorders no columns, exactly like `world.edit().set` (§5.2). Three caveats apply to it, though, so it isn't a free-for-all: **(1) it is still subject to the outbound throttle** — writing a value every tick doesn't send a packet every tick; the store coalesces and self-flushes on its own clock (§15.5), so a per-tick `eph.edit` produces throttled, not per-tick, network traffic. **(2) It is still ownership-checked** — you may only write entities in your own partition (§15.1), the same rule as outside a tick. **(3) `eph.edit(remoteEntity)` throws even for a value write, even inside a system** — a remote entity is another peer's, read-only to you (§15.4), and writer-partitioning is absolute: there is no context in which you write a cell you don't own. So the inside-a-system allowance is narrow: value writes to *your own* already-placed ephemeral entities, throttled outbound, never to a remote one. This is a scope decision, not a permanent limit: presence is overwhelmingly input-driven, so the rare "a system publishes ephemeral state" case doesn't justify a `ctx.ephemeral(eph)` surface in v1; if it proves needed, that mutator (shape deferred to the phase boundary, value immediate — mirroring `ctx.*`) is the forward-compatible way to add it without a hidden store mode.

  **The pattern for "derive ephemeral state from a system," since you will hit the throw.** Stage the intent during the tick and apply it after `tick` returns, when you are outside iteration:
  ```ts
  const afterTick: Array<() => void> = [];
  const PublishPresence = defineSystem(myQuery, (batch, ctx) => {
    for (const r of batch) {
      const derived = /* compute from runtime state */;
      afterTick.push(() => eph.addComponent(myPresence, DerivedFacet, derived)); // STAGE, don't call now
    }
  });
  // ... in the frame loop, after world.tick(pipeline):
  for (const f of afterTick) f(); // now outside iteration → structural eph.* is safe
  afterTick.length = 0;
  ```
  This keeps the structural mutation outside the iteration that produced it, with no hidden store mode and no framework change. (If v1's boundary proves too restrictive in practice, the future `ctx.ephemeral(eph)` mutator subsumes this pattern — you would enqueue through it instead of a manual array, and it would defer to the phase boundary like any other `ctx` structural op.)
- **Remote mutation projects at `sync()`.** Another peer's changes arrive as EphemeralStore events and are applied by the store's `drain()` during `world.sync()` (§15.3), exactly as durable/inbound projection is — outside iteration, so immediate at that point.

**Why local is immediate here, though durable structure is not.** The durable layer routes *its* structure through projection for one specific reason: to keep the reconcile **baseline** advancing in lockstep with the runtime (§12.3, §13.2), so a concurrent remote structural change reconciles correctly. The ephemeral layer **has no baseline and no reconcile** — it is writer-partitioned, so no ephemeral cell is ever contended (§15.1). With the entire reason for "structure through projection" absent, there is nothing to gain by delaying local structure and a concrete UX cost to paying it (the self-referential spawn-then-edit above). So ephemeral takes the simpler, correct-for-its-constraints path: **local writes are ordinary runtime mutation** — immediate outside a tick; inside a system, only *value* writes to already-placed *local* ephemeral entities are allowed in v1, while structural `eph.*` throws (there is no `ctx`-bound ephemeral mutator, §15.2) — **plus an outbound send**; only *remote* writes project. This is the one place ephemeral deliberately does *not* mirror durable's timing — and it is deliberate, because the constraint that forced durable's rule doesn't exist here.

There is **no presence-specific accessor** — presence is just the pattern of spawning one entity in your partition and writing your cursor to it, exactly like the `cursor` above. The store does **auto-tag every entity you spawn with `Local`** (it knows they're in your partition), so `Local` reliably means "mine" for queries (`Not(Local)` = remote peers, §15.4) without you having to remember to add it. `Local` is a **framework-exported tag** (`import { Local } from "strata"`), not one you define — it has to be, since the store is the one applying it (§20). That auto-tagging is the only thing the store does *for* you; everything else is the plain `Mutator` surface. **`Local` is query-only: read it (`Local` / `Not(Local)`), but never `addTag`/`removeTag` it yourself.** The store owns it as the marker of partition ownership; manually removing `Local` from your own entity (or adding it to a projected remote one) would desynchronize the tag from the actual partition and silently corrupt every `Local`/`Not(Local)` query. It is applied on spawn and cleared on despawn by the store, and that is the only lifecycle it has.

**`Local` is projection-local and is *never* transmitted in the ephemeral blob.** This is the invariant that makes it work across peers, and it must be stated explicitly: each store applies `Local` **locally**, only to entities in **that runtime's own partition** — it is *not* part of the value blob a peer encodes and sends. So on peer A's runtime, A's own entities carry `Local`; when A's entities project onto peer B, B applies **no** `Local` to them (they are remote to B), while B's *own* entities carry `Local` on B's runtime. The tag is thus always "mine, from the perspective of this runtime," computed independently on each peer from partition ownership — never shipped. Encoding `Local` into the blob would be a bug: it would arrive on every peer and mark A's entities as `Local` on B's runtime too, so B's `Not(Local)` would wrongly exclude the remote peers it's meant to select. The blob carries the peer's real components (cursor position, selection, etc.); `Local` is added *after* projection, by the receiving store, based on whose partition the key belongs to — which for a remote key is never yours. (This is also why the inbound blob-diff runs against the last-seen-blob cache, not the runtime projection: the runtime carries the locally-applied `Local` that was never in any blob, §15.6.)

**Write authority is enforced structurally.** `eph.edit`/`addComponent`/`despawn` on an entity *not* in your partition throws — the store checks the entity's key prefix against your peer id. There is no API to mutate a remote peer's entity; remote entities are read-only projections (§15.4). This is the writer-partition rule (§15.1) made mechanical.

### 15.3 Identity and lifecycle — partitioned keys, and Loro's three events

**Identity: peer-partitioned keys, remote entities mint fresh local handles.** This is what makes a *writable* ephemeral store tractable. Two facts:

- **Keys are peer-prefixed, so they never collide across peers.** When Alice spawns an ephemeral entity, its key is minted under her peer id (`alice-<n>`); Bob's are `bob-<n>`. Alice and Bob independently minting their `n`th entity produce different keys — the same collision-free scheme the durable layer uses (§14.1), now doing double duty as the *partition boundary*: a key's prefix says which peer owns (and may write) it.
- **Each remote entity mints a fresh *local* runtime handle.** An ephemeral key is globally meaningful (`alice-3`), but a runtime `Entity` handle is a local slot+generation (§2). So when Bob's runtime receives `alice-3`, the projector's `resolveByKey` mints **Bob's own** local handle for it and binds `alice-3 ↔ thatHandle` in Bob's bijection — exactly as durable projection does (§10.2). Bob's handle for Alice's cursor and Alice's own handle for it are *different numbers naming the same logical entity across the wire*; the key is the shared identity, the handle is per-runtime. This is why remote ephemeral entities can't collide with local ones (they occupy freshly-minted local slots) and why they're safe to despawn locally (removing the binding frees only the local handle).

The wire granularity follows from this: **each ephemeral entity is one Loro `EphemeralStore` key**, value = that entity's components (+ tags). Per-key TTL then expires *entities* independently, LWW resolves per entity (never contended under partitioning), and add/remove-component is a diff within one key's value (§15.6). Despawn is deleting the key (or letting it TTL out).

**Lifecycle: a flat projection of Loro's three EphemeralStore events.** Loro's `EphemeralStore` fires `subscribe` on exactly three event kinds — `local` (your own set, echoed), `remote` (another peer's set arrived via `apply`), `timeout` (a key's TTL lapsed). Loro owns the *mechanism* (expiry timer, per-key LWW, granular encoding) but **not** the entity model — it has keys, no notion of "entity" or "peer." Strata's convention (key = peer-prefixed entity key, value = that entity's components) turns those three events into runtime entity lifecycle:

| Loro EphemeralStore event | strata runtime effect |
|---|---|
| `local` (our own set, echoed back) | **ignore** — we already applied the change to our runtime when we called `eph.*` (Option A, §15.2); the echo is only the wire copy going out |
| `remote` set, key **unseen** | **spawn** a local entity for that key: `resolveByKey` mints the handle and `ensurePlaced` places it (§10.3), then write its components from the value blob (which migrate it into their archetype) |
| `remote` set, key **seen** | **update** — write changed components, and **remove** components that vanished from the value (the diff, §15.6) |
| `timeout` (key's TTL lapsed) | **despawn** that entity (`projector.remove`, §10.3) |

The `local` row is a genuine no-op on the runtime side, and this is where Option A pays off cleanly: because your own `eph.*` call already mutated your runtime *synchronously* (§15.2), the echoed-back `local` event has nothing left to do to the runtime — it is purely the outbound wire copy. So there is no "own-origin echo processing" subtlety here the way there is in the durable layer (§13.3); a `remote` event on a *seen* key runs the blob-diff (write present components, remove vanished ones, §15.6), and that path is used *only* for other peers, never for yourself.

This lifecycle works at **entity** granularity (any number per peer), not one-slot-per-peer. There is no join/leave protocol: an entity **appears** on its first `remote` `set` for a key and **vanishes** when its key times out. For the presence special case this reads intuitively — a *peer* joins when its (one) presence entity first appears and leaves when that entity times out — but the mechanism is general. The "liveness machinery" is not something strata builds; it is Loro's `timeout`, projected to a despawn.

**A peer's entities appear and disappear atomically — the ephemeral `drain()` applies all pending events to completion before yielding.** This is the ephemeral analogue of the durable batch-atomicity invariant (§13.3): a `drain()` at `sync()` processes *all* of the source's currently-pending events (`remote` sets, `timeout`s) as one uninterruptible unit — **no user system or render runs between them.** It matters most when a peer leaves. A peer with several ephemeral entities (a cursor plus two selection markers, say) crashes; because keepalive re-sends the whole partition in one `encodePartition` message (§15.3), all of that peer's keys share a refresh timestamp and therefore **time out in the same Loro tick** — and the resulting burst of `timeout` events is drained together, so the peer disappears **all at once**. Without this invariant, a render could land between despawning the cursor and despawning the markers, briefly showing a half-gone peer (cursor vanished, selection still floating) — a glitch on the common "someone left" event. So: keepalive batches the partition (making the TTLs expire together) *and* `drain()` applies the timeout burst atomically (making the despawns land together). State both; either alone leaves the "peer left" transition visibly torn.

Two refinements make this robust in practice:

- **Explicit leave is a best-effort optimization, not a separate path.** Clean departure (tab close) can delete a peer's keys so others despawn *immediately* rather than waiting out the TTL. Wire it on `beforeunload`/`pagehide` (delete your partition's keys, flush). But `beforeunload` is unreliable, so the **correct** path is always timeout; explicit-leave only shortens despawn latency when it fires. The despawn logic is identical either way (`timeout` and a `remote`-delete both resolve to `projector.remove`).

- **Self-heartbeat keeps idle-but-live entities visible.** TTL expiry only works because live owners refresh their entries — but an entity whose value isn't *changing* (a still cursor, a peer reading) produces no outbound *change*, so the change-driven send (§15.5) would stop refreshing it and it would wrongly self-expire. So the store runs a **keepalive decoupled from the change-throttle**: on a low-frequency clock it re-sends your partition's current entries regardless of change — via `source.encodePartition(myPrefix)`, which encodes *all* current entries under your peer prefix, not just dirtied ones (`encodeChanged()` would miss idle entities, §15.5) — purely to refresh timestamps. This is the one piece of lifecycle the store itself must run; everything else is Loro's. (Keepalive and change-throttle are independent timers: the throttle bounds how often *changes* go out; the keepalive guarantees a floor refresh rate so live-but-idle entities never time out.)

  **Keepalive interval: ≈ `ttlMs/3` to `ttlMs/4`, not `ttlMs/2` — and the headroom is the point.** A naive `ttlMs/2` gives only **one** missed heartbeat of tolerance: the TTL window fits exactly two keepalive intervals, so a *single* dropped keepalive packet at the wrong moment lets the entry expire, and the entity **despawns then respawns** on the receiver when the next keepalive lands — a visible flicker on ordinary, transient packet loss. Sizing the interval at `ttlMs/3` or `ttlMs/4` means it takes **two or three consecutive** losses to cross the TTL, which is standard liveness-heartbeat headroom and makes spurious expiry vanishingly unlikely on a normally-lossy network. The rule: **pick the keepalive period so that several consecutive keepalives must be lost before an entry expires; `ttlMs/2` is too tight, `ttlMs/3`–`ttlMs/4` is the safe range.** (This is a pure tuning choice with no correctness consequence for the *converged* state — a wrongly-expired entity is re-created on the next keepalive — but the flicker is a real UX defect, so the headroom matters.)

### 15.4 Remote ephemeral entities are ordinary queryable entities

Remote peers' ephemeral entities — spawned and updated by the §15.3 projection — live in your runtime as **normal entities**, which you query like anything else. The presence case:

```ts
const remoteCursors = defineQuery([CursorPos, PresenceInfo, Not(Local)]);
const RenderCursors = defineSystem(remoteCursors, (batch) => {
  const { CursorPos } = batch.columns;
  for (const r of batch) { /* draw each remote cursor at (CursorPos.x[r], CursorPos.y[r]) */ }
});
```

Ephemeral state is not a special side-channel — it is queryable ECS data, so rendering and UI systems treat remote cursors (or any transient remote entity) with the same machinery as everything else. The `Local` tag — a **framework-exported tag** (`import { Local } from "strata"`) applied automatically by the store to entities you spawn (§15.2) — distinguishes entities *you* own (in your partition) from remote ones, so a query includes or excludes yourself with `Local` / `Not(Local)`. And because dynamic components are exposed (§15.2), component *membership* carries meaning: `[PresenceInfo, Selection, Not(Local)]` matches exactly the remote peers currently selecting — the query is the presence logic, no per-row sentinel check.

### 15.5 Eager sync, throttled, self-refreshing — owned by the store

The upward path is the inverse of durable's transaction. There are no ops, no explicit commit, no return value. You mutate your ephemeral entities, and the store sends the changes — **eagerly, but throttled.** The *source* (mouse movement, selection changes) fires far faster than you should broadcast, so writes are coalesced to the latest value per entity and sent at most once per `throttleMs`.

Crucially, **the store owns this outbound rhythm itself** — there is no per-frame `flush()` the user calls. The whole point of throttling is that the *send rate* is decoupled from the *write rate*, and therefore from the *frame rate*; asking the user to pump a send every frame would be making them fire the store's own throttle. So the store self-flushes: mutating an entity in your partition marks it dirty, and the store — on its own `throttleMs` clock, independent of the frame — encodes the latest dirty state and hands the bytes to the **`send` callback** you supplied at construction (§15.2), which forwards them to your transport. Because the store owns the *rhythm*, it must own the *handoff* too: `send` is the sink the self-flush writes to. Outbound is otherwise invisible plumbing (exactly as durable's outbound rides the transaction seal). The user mutates ephemeral entities and provides `send` once; getting the bytes onto the wire on the right clock is the store's job — which is why the user's frame loop has *no* outbound network operation (§16).

The store runs **two independent outbound timers**, and keeping them separate is the point:
- the **change-throttle** (`throttleMs`, ≈ one frame) bounds how often *changed* entities go out — it fires only when something in your partition is dirty, coalescing rapid writes to the latest per entity;
- the **keepalive** (≈ `ttlMs/3`–`ttlMs/4`, §15.3 — sized for several missed-beat headroom, not `ttlMs/2`) re-sends your partition's current entries even when nothing changed, so a live-but-idle entity never times out and a dropped packet doesn't flicker it.

In the common case (cursor moving) the change-throttle does all the work and the keepalive is redundant; in the idle case (cursor still) the change-throttle is silent and the keepalive carries the liveness. Keep payloads small (a few flat components per entity) so each send stays cheap; because each entity is its own Loro key (§15.3), only the entities that actually changed are encoded, not your whole partition.

### 15.6 Conflict-free by partition, dynamic components, references-as-values

**No write-write conflicts, by construction.** Because every entity is written only by its owning peer (§15.1), no ephemeral cell is ever concurrently written — §13's entire conflict model is moot. Inbound is always another peer's data for entities in *their* partition, which your local writes never touch. LWW-per-key (Loro's resolution) is sufficient precisely because it is never actually exercised on a contended key. (Attaching starts receiving live peers' entities and broadcasting yours; detaching stops both and despawns all remote ephemeral entities. Ephemeral stores start empty and fill from live peers — there is no load-from-disk.)

**Dynamic components sync as a per-entity value diff.** Because each entity is one Loro key whose value carries its current components (§15.3), adding or removing a component changes what that value contains, and remote projection **diffs**: on a `remote` `seen` event, the projector writes components present in the new value and **removes components that were there before but are now absent** (§15.3 table). So `eph.removeComponent(cursor, Selection)` propagates as "the `Selection` field is gone from `cursor`'s value" → every remote peer removes `Selection` from their projection of `cursor`. This is what lets component *membership* be the signal (a peer "is selecting" iff its entity currently has `Selection`), and it is the one piece of projection logic the writable-and-dynamic model adds over a fixed-shape presence store. It is contained — a value diff in the `remote` handler — and it composes with the migration primitives (§5.5): a removed component migrates the local projection to the smaller archetype, exactly as any structural change does.

**The diff runs against a dedicated last-seen-blob cache, not against runtime state.** "What was there before" must come from an explicit per-key cache of the previous blob — **not** from reading back the entity's current runtime components — and this matters for correctness, not just tidiness:
```ts
lastSeenBlobByKey: Map<EntityKey, EphemeralBlob> // the last value blob projected for each remote key
```
- **`remote` unseen key** → spawn a local entity for the key, write its components from the blob, and **store the blob** in `lastSeenBlobByKey`.
- **`remote` seen key** → diff `lastSeenBlobByKey.get(key)` against the new blob: write changed/added components, remove components present in the cached blob but absent from the new one; then **overwrite the cache** with the new blob.
- **`timeout` / `delete`** → despawn the local entity and **evict** the key from `lastSeenBlobByKey`.

Diffing against the cached blob rather than the runtime projection avoids a real contamination bug: the runtime entity may carry state that is **not** part of the peer's transmitted value — most importantly the framework-applied `Local`/marker tags (§15.4) and anything a local system attached — so diffing "new blob vs. current runtime components" could see those extra components as "removed" (they're not in the incoming blob) and strip them, or otherwise confuse framework state with peer state. The cache holds exactly and only what the peer last sent, so the diff is blob-against-blob and clean. (This cache is independent of, and in addition to, Loro's own per-key state; it is the *projector's* memory of what it last applied.)

**References are values, not relations.** Ephemeral entities have **components and tags but no relations** (§15.1) — presence and transient state are flat. If an ephemeral entity needs to *reference* a durable element ("Alice is editing rectangle X," "this preview belongs to shape Y"), store the durable entity's **key** as an opaque value in a component (e.g. `EditingRef { key }`), not as a first-class ECS relation. This keeps ephemeral state small, avoids cross-store relation machinery, and sidesteps the cross-store-relation hazard the durable layer warns about (§11.2) — which never arises here because ephemeral holds no relations at all. The reference is just data the consuming app resolves against the durable store when it needs the target.

---

## Part IV — API reference

The public surface for this part. Signatures are TypeScript sketches.

### API — ephemeral layer

```ts
// The construction boundary — mirrors createDurableStore(doc). The caller owns the Loro
// EphemeralStore's lifecycle (creating it, wiring its encode/apply to a transport) and supplies
// the peer id; the store wraps it behind EphemeralSource (§9.3) and adds partitioning + timers.
function createEphemeralStore(
  source: LoroEphemeralStore, // the backing medium (like `doc` for durable)
  opts: {
    peerId: string;
    send: (bytes: Uint8Array) => void; // OUTBOUND SINK — the transport handoff (§15.5)
    throttleMs?: number;
    ttlMs?: number;
  },
): EphemeralStore;
// peerId: this peer's id — the prefix for keys THIS store mints (its partition, §15.1/§15.3).
// send: where the store hands its throttled/keepalive output. Because the store owns the outbound
// RHYTHM (it self-flushes on throttleMs + keepalive, §15.5), it must be given somewhere to put the
// bytes — it calls send(source.encodeChanged()) on its throttle clock, and send(source.encodePartition(
// myPrefix)) on its keepalive clock (encodeChanged can't refresh idle entries, §15.5); the app forwards to its
// transport: e.g. send: bytes => ws.send(bytes). Without this sink the self-flush has no output.
// (Durable needs no equivalent: its outbound rides Loro's own commit→subscribe wiring, which the
// app sets up on the LoroDoc; ephemeral's send is strata's own clock, so strata needs the handoff.)
// throttleMs: outbound CHANGE clock — self-flushes the latest dirty entities at most once per
// window, independent of the frame. NOT a per-frame call the user makes (§15.5).
// ttlMs: the Loro EphemeralStore per-entry TTL (idle expiry). Drives the KEEPALIVE — the store
// re-sends your partition's entries every ~ttlMs/3-ttlMs/4 (headroom for lost packets, not ttlMs/2)
// even with no change, so live-but-idle
// entities never self-expire.
// INBOUND is the mirror: the app feeds remote bytes to source.apply(bytes) from its transport; the
// store's subscription turns those into projection at sync(). So the app wires two directions —
// send (out) here, and apply (in) on the LoroEphemeralStore — and the store owns everything between.

interface EphemeralStore {
  // The Mutator vocabulary (§5), scoped to YOUR partition — mutating another peer's entity throws.
  // Timing (§15.2, Option A): LOCAL mutation (structure + value) is immediate, like world.*/ctx.*;
  // only REMOTE ephemeral changes project at sync(). So spawn-then-edit in one handler works.
  spawn(init?: SpawnInit): Entity; // spawn in my partition (SpawnInit = ComponentEntry[], typed — §ref intro)
  despawn(e: Entity): void;
  addComponent<S>(e: Entity, c: Component<S>, v: S): void; // add a facet (dynamic components, §15.6)
  removeComponent(e: Entity, c: Component): void; // drop a facet → remote projections remove it
  edit(e: Entity): EntityEditor; // edit(e).set(C, v) — value write on my entity
  addTag(e: Entity, t: Tag): void; removeTag(e: Entity, t: Tag): void;
  // internals (the EphemeralSource adapter, peer-partitioned keys, the two outbound timers) are not public surface
}

// `Local` is a FRAMEWORK-EXPORTED tag, not user-defined — the store applies it to entities you
// spawn, so it must be a tag the store already knows. Import it; do not `defineTag("Local")`:
import { Local } from "strata"; // the tag the ephemeral store auto-applies to your own entities (§15.4)
// Queries use it to include/exclude yourself: defineQuery([CursorPos, Not(Local)]) = remote peers.

// The Part II interface that quarantines the Loro EphemeralStore — the ephemeral analogue of
// CRDTSnapshot (§9.3). It is DELIBERATELY NOT a snapshot: the ephemeral store is per-key value
// blobs with three coarse events, not a cell-addressable CRDTSnapshot emitting per-cell ChangeEvents.
interface EphemeralSource {
  set(key: EntityKey, value: object): void; // upsert this entity's whole value blob (its components + tags)
  delete(key: EntityKey): void; // explicit removal (best-effort leave, §15.3)
  encodeChanged(): Uint8Array; // granular: only keys DIRTIED since last encode → the THROTTLE path
  encodePartition(prefix: string): Uint8Array; // ALL current entries under a prefix, changed or not → the KEEPALIVE
                                               // path (§15.3). encodeChanged() alone can't serve keepalive: an idle
                                               // entity produces no dirty key, so refreshing its TTL needs a way to
                                               // re-encode UNCHANGED current entries — this is it. The store
                                               // passes its OWN peer prefix, re-sending only its partition's entries.
  apply(bytes: Uint8Array): void; // inbound from a peer
  subscribe(fn: (ev: { kind: "local" | "remote" | "timeout"; key: EntityKey; value?: object }) => void): Unsubscribe;
  // CONTRACT — per-key last-writer-wins ordering (REQUIRED). A `remote` event is emitted for a key only
  // when its value is at least as new as the last one surfaced for that key; a stale, out-of-order update
  // (an older blob arriving after a newer one) is DROPPED by the source, never surfaced. The blob-diff
  // model (§15.6) depends on this: it computes "what changed" against the last-seen blob, so if an older
  // blob could arrive after a newer one, the diff would resurrect stale state (e.g. re-add a component the
  // owner already removed). Loro's EphemeralStore provides this per-key LWW ordering natively; a non-Loro
  // EphemeralSource MUST guarantee it too, or the diff model breaks silently (dynamics-trace E5).
}
// LoroEphemeralSnapshot implements EphemeralSource over Loro's EphemeralStore — the SECOND (and last)
// Loro-aware adapter class (§0). createEphemeralStore constructs it. The peer prefix comes from the
// EXPLICIT `peerId` option (§15.2's constructor), NOT derived from Loro: unlike LoroDoc (whose stable
// peer id createDurableStore reuses, §14.2), a LoroEphemeralStore does not expose a stable peer id, so
// the ephemeral store requires peerId to be supplied. All ephemeral PROJECTION logic (blob →
// spawn/update-with-diff/despawn) lives in the store, above this interface — the adapter only moves
// blobs and reports the three events.
```

The ephemeral store is a **writable ephemeral entity store**, sibling to the durable layer: the same *flat entity* mutation vocabulary (spawn/despawn, add/remove component, value writes, tags) — but **no relations and no resources** (§15.6), so readers should not expect `eph.addRelation`. Scoped so you may only mutate entities in your own peer partition (§15.1). There is **no transaction** and **no per-frame send call** — writes sync eagerly, throttled, and self-flushed (§15.5). Timing (§15.2, Option A/B): your *own* ephemeral mutation applies to the runtime immediately and is designed for use *outside* a tick (input handlers), so `eph.spawn` then `eph.edit` in one handler works; inside a system, structural `eph.*` throws in **all builds** (value `eph.edit().set` is allowed), §15.2. Only *remote* ephemeral changes project at `sync()`. This differs from durable (which routes structure through projection) because ephemeral has no baseline/reconcile to keep in step — the constraint that forces durable's rule is absent (§15.1). On attach the store registers an `InboundSource` so `world.sync()` drains inbound; the lifecycle projects Loro's EphemeralStore events — a `remote` `set` runs a blob-diff that spawns/updates the entity and removes vanished components, a `local` echo is a runtime no-op (already applied), and `timeout` despawns (§15.3). Remote entities are projected as ordinary read-only entities (tag `Local` marks yours), queried like anything else (§15.4). Identity is peer-partitioned and each remote entity mints a fresh local handle (§15.3). Ephemeral entities have components and tags but **no relations** — cross-entity references are stored as key values, not relations (§15.6). Presence is the common use (spawn one entity, write your cursor to it); the store itself is general. Loro is quarantined behind `EphemeralSource` (`LoroEphemeralSnapshot`), the ephemeral twin of `LoroSnapshot` — the only two Loro-aware classes in the codebase (§0).


# PART V — CROSS-CUTTING, EXAMPLE, AND REFERENCE

## 16. The frame — composed from small operations

There is no single hardcoded "tick" that bundles everything. The frame is **composed by the user** from a few operations, each owned by exactly one place. This is the tick design's endpoint: the work rhythm and the network rhythm are separate, so multi-cadence pipelines and fixed timesteps fall out for free.

### 16.1 The operations

- **`world.tick(pipeline)`** (Part I §7) — the *work* rhythm. Runs a pipeline: each phase's systems (gated by `runIf`), with that phase's command buffer flushed at the phase boundary. Self-contained, network-free, callable at **any** cadence with **any** pipeline. Guarantees a system's shape changes are visible at the next phase boundary.

- **`world.sync()`** — the *inbound network* rhythm. Called **once at the top of the frame**. It drains every attached **`InboundSource`**, which applies its remote changes to the runtime **immediately** (sync runs outside iteration, §5.2 — no command buffer). `World` knows only the `InboundSource` interface — not durable, not ephemeral, not Loro:

  ```ts
  interface InboundSource { drain(): void; } // apply pending remote changes to the runtime (immediately — sync is outside iteration)
  ```

  Attaching a durable or ephemeral store registers its binding as an `InboundSource`; from then on every `world.sync()` drains it. The user never wires this — *attachment is what wires it*. This keeps `World` layer-agnostic even at frame time (the core names only `InboundSource`, never `DurableTarget` — §12.1), while putting the *ordering* (sync before tick) inside the framework so it cannot be got wrong. A drain applies its changes immediately (sync runs outside iteration, so no command buffer is involved — §5.2, §5.4).

- **Outbound is not a frame operation.** Durable sends when a transaction seals (§12); ephemeral self-throttles on `throttleMs` plus a keepalive (§15.5). Neither has a per-frame "send" call. The user's frame loop therefore has **no** outbound network operation.

### 16.2 The frame loop is the user's

```ts
function frame(dt) {
  world.sync(); // frame start: drain InboundSources → apply remote changes immediately
  world.tick(simPipeline); // phases, each with its own command buffer flushed at its boundary
  if (geometryDirty) world.tick(layoutPipeline); // a second pipeline, only when needed
  render(world); // the user's concern — read runtime columns directly
}
requestAnimationFrame(function loop() { frame(performance.now()); requestAnimationFrame(loop); });
```

- **A pure local ECS** (no stores attached) drops `sync` entirely — nothing contributes an `InboundSource`. The frame is just `tick → render`.
- **Multi-cadence**: many `tick`s per frame, but `sync` once. (Draining once per frame is required — running reconcile multiple times per frame against a runtime the earlier ticks just mutated would apply inbound changes at ill-defined points; `sync` separate from `tick` is what guarantees one drain per frame, at a defined point before the ticks.)
- **Fixed timestep**: `sync()` once, `world.tick(simPipeline)` N times to catch up the accumulator, then `world.tick(renderPrepPipeline)` once.

### 16.3 Why this shape

The discipline is uniform and forced: **a system's shape changes are deferred and applied only at its phase boundary** (so archetype arrays stay stable during iteration, Part I §7), while **inbound network changes are applied immediately at `sync()`, which runs outside iteration** (Part I §5.2). Everything else is composition:

- `tick(pipeline)` is a value-driven operation, not framework state — the schedule is an argument, so you can run any pipeline at any cadence.
- `sync` is the once-per-frame inbound drain, separated from `tick` because the network rhythm (once per frame) differs from the work rhythm (any cadence).
- Outbound is owned by the stores (commit-driven / throttle-driven), so it too is decoupled from the frame.

A durable `doc.transaction` is not a frame operation — it is user-driven, fired at gesture boundaries (§12). Local snapshot `export`/`import` are not frame operations — they are explicit, on-demand calls (§8).

## 17. Cross-cutting concerns

**The five change-representations, disambiguated.** State changes are described by five different types across the layers, and the boundaries between them are the kind of thing that blurs over a long document (and a blurred boundary is how contradictions creep in, §0). Each exists because it lives at a different seam, carries different information, and answers to a different consumer. In one table:

| Type | Where it lives | Carries handles? | Carries keys? | Value or structure? | Its one job |
|---|---|---|---|---|---|
| **`StructuralCommand`** | runtime command buffer (§5.3–5.4) | **yes** (`Entity`) | no | **structure only** (spawn/despawn/add/remove/tag/relation) | defer a *system's* shape change to the phase boundary |
| **`DurableOp`** | inside a `doc.transaction` (§12) | **yes** (`Entity`, resolved at record time) | sometimes (the key bound to a spawn) | **value + structure** (superset of `StructuralCommand` — adds value ops) | record one transaction's edits, seal them as a Loro commit |
| **`ChangeEvent`** | the projection boundary (§9.4, §13.3) | **no** | **yes** (`EntityKey`) | facts — *classified* into value vs structure at reconcile (§13.3) | carry a converged document fact inward to be reconciled |
| **`EphemeralBlob`** | one Loro EphemeralStore key's value (§15.3) | **no** | **yes** (the entity's `EntityKey`) | flat **current state** (all of one entity's components at once) | be the whole present value of one ephemeral entity, diffed on receipt |
| **`ProjectorOp`** | inside the projector kernel (§10.3) | **yes** (via key→handle resolution) | **yes** (key in) | **value + structure** | the actual apply-to-runtime primitive (`applyComponent`/`ensurePlaced`/`remove`/…) |

The through-line: **handles are the *runtime's* currency, keys are the *stored/wire* currency, and the projector is the one place they meet** (§10, §14.3). So the two types that reach the runtime buffer or kernel carry handles (`StructuralCommand`, `ProjectorOp`); the two that cross the persistence/wire boundary carry keys (`ChangeEvent`, `EphemeralBlob`); and `DurableOp` sits at the authoring seam holding a handle *plus* the key it was bound to at record time. The one that looks different — `EphemeralBlob` — is different on purpose: it is not an *op* at all but a *snapshot of one entity's whole state*, because the ephemeral layer is single-writer and last-writer-wins per key (§15.1), so "here is the entity's current value" is a complete and conflict-free message where a durable op-stream would be overkill. Reconcile is where `ChangeEvent`'s deliberate value/structure ambiguity is resolved against the baseline (§13.3); everywhere else, each type's value/structure nature is fixed by construction.

**Schema versioning / migration.** `format_version` lives in the snapshot `meta`. Component-layout changes are a separate axis: keep a per-component schema version in a registry and run migrations on load. Because every component is a flat set of typed fields, migrations are mechanical (add column with default, drop column, widen type). (Enum fields are the migration trap — reordering variants silently remaps stored data unless the schema used explicit discriminants, §4.)

**Referential integrity.** Nothing automatically maintains your foreign keys. The reverse relation index is the single enforcement point: on entity destroy (local *or* inbound-remote), clear/tombstone incoming relations; on relation read (or `eid` read), validate target generation (dangling → skip/clear). A periodic GC pass can sweep tombstones.

For **`eid` component fields** specifically, the sanctioned read is **`readEid(e, C, field)`** (§ Part I reference), which unpacks the stored `u32`, checks its generation against the entity table, and returns the referenced `Entity` **or `undefined` if the reference dangles**. Reading the raw `eid` column directly (`batch.col(Target).entity[r]` as a bare number) is possible on the hot path but is a footgun — a raw `u32` may name a freed-then-reused slot, and using it without the generation check reads the wrong entity. So generated `eid` accessors validate by default; drop to the raw column only in a tight loop where you have *just* validated, or where a stale ref is provably impossible. The rule mirrors the component read split: `readEid` is the safe accessor, the raw column is the advanced/unchecked path.

**Determinism.** Systems must be deterministic given the same runtime state if you want replay or reproducible simulation. Iterate archetypes in a stable order, and seed and order any RNG.

**Threading / workers.** The typed-array runtime is worker-friendly: column arrays can be moved/shared (`SharedArrayBuffer`) for parallel systems. Persistence and sync stay off the hot path, so they don't interact with the worker split. One design consequence to note if systems are ever parallelized: a query-emptiness run condition (a `hasAny(query)`-style gate) — deliberately absent under sequential execution because an empty query is already a free no-op (§7) — *would* begin to earn its place, because a parallel executor has per-system scheduling cost (acquiring data access, sync points) that a cheap pre-check could skip. The condition's value is proportional to per-system scheduling overhead, which is near-zero sequentially and real in parallel; this is the same reason Bevy and Unity DOTS ship such a gate and a sequential, query-expressive design (flecs) largely does not.

**The collaboration boundary — the line that makes this a substrate.** The framework *converges data and reports disruptions*: deferred inbound apply at tick boundaries, the reverse-index cascade on remote delete, the dev-mode stranded-cell warning (§13.5). The consuming app *owns interaction UX*: whether a remote delete of an edited entity raises a toast, whether an interrupted gesture snaps or holds, what (if anything) "abort" means. The framework gives no abort and no rollback (§13.5) precisely because that is interaction policy. Keeping this line is what makes strata a substrate rather than one specific editor. Live in-progress presence (seeing a collaborator drag in real time) is the *ephemeral channel* (Part IV), never the commit path.

**Interaction code must read shared entities with `get`, not `read` — a collaborator can despawn your gesture target mid-gesture.** The `read`/`get` split (§ Part I reference) makes `read` the throwing hot-path accessor and `get` the safe `S | undefined` one — and that distinction becomes load-bearing under collaboration. Any entity a *local gesture* is manipulating can be **despawned by a remote peer at a `sync()` boundary** (a remote despawn is structural, so it always applies — §13.3). After that, the local handle is stale: a subsequent `ctx.edit(target).set(…)` harmlessly no-ops via validate-on-read (§5.5), but a `ctx.read(target, C)` — which the docs otherwise encourage in tight loops — **throws**, because the component is gone. So the rule for interaction/gesture systems: **use `get` (or re-validate liveness at the top of the frame and cancel the gesture if the target vanished), and reserve `read` for entities whose lifetime the system itself controls.** A drag loop that does `ctx.read(target, Position)` every frame will throw the frame a collaborator deletes `target`; the same loop with `ctx.get(target, Position)` sees `undefined` and can end the gesture cleanly. This is the one place the performance-oriented `read` and the collaborative-despawn path interact badly, and the fix is a read-accessor choice, not a framework change. (Each individual rule is correct — `read` throws on absent, remote despawn applies unconditionally, validate-on-read skips stale writes; the hazard is only in their *interaction during a gesture*, which is why it belongs here at the boundary, not in any single rule.)

## 18. Worked example — a collaborative canvas editor

A sketch (illustrative, not a runnable build) of a Figma-like infinite-canvas editor that touches every part of this document. The document holds **shapes** with transform/size/fill/z-order; shapes can be **grouped** and **connected** by arrows; the canvas is collaborative (durable) and remote **cursors** show up live (ephemeral). The centerpiece is a **drag pipeline** — raw pointer input → a gesture system spawns a `DragGesture` entity targeting a shape → a drag system moves the shape's `Position` live every frame → a single `doc.transaction` at gesture end — which is the architecture in miniature: continuous manipulation in the runtime, one explicit transaction at the boundary, and the runtime's divergence from its baseline auto-dropping inbound changes mid-drag.

### 18.1 Schema

```ts
import {
  defineComponent, defineTag, defineRelation, defineResource,
  defineQuery, defineSystem, enumOf, Not, Any, All, Related,
  createWorld, createDurableStore, createEphemeralStore,
  Local, // framework-exported tag the ephemeral store auto-applies to your own entities (§15.4)
} from "strata";

// Components — fields are numbers, enums, entity refs, or freeform strings (Part I §4)
const Position = defineComponent("Position", { x: "f32", y: "f32" }); // split from Rotation (§13.4) so a drag (moves x/y)
const Rotation = defineComponent("Rotation", { angle: "f32" }); // and a rotate gesture (changes angle) never clobber each other
const Size = defineComponent("Size", { w: "f32", h: "f32" });
const Fill = defineComponent("Fill", { r: "u8", g: "u8", b: "u8", a: "u8" });
const ZIndex = defineComponent("ZIndex", { z: "i32" });
const Kind = defineComponent("Kind", { shape: enumOf({ rect: 1, ellipse: 2, text: 3, frame: 4 }) }); // durable → explicit discriminants (§4)
const Label = defineComponent("Label", { text: "string" });

// Presence components (live on ephemeral entities in my partition, Part IV)
const CursorPos = defineComponent("CursorPos", { x: "f32", y: "f32" });
const PresenceInfo = defineComponent("PresenceInfo", { name: "string", color: "u32" });
// A presence FACET carried as a component so its membership is the signal: a peer "is selecting"
// iff its ephemeral entity currently has Selection (§15.6). Added/removed as selection starts/stops.
const Selection = defineComponent("Selection", { targetKey: "string" }); // the durable key it points at (§15.6)

// Input + gesture components (local-only runtime; never durable, never synced)
const Pointer = defineComponent("Pointer", { x: "f32", y: "f32", down: "bool" });
const DragGesture = defineComponent("DragGesture", {
  startX: "f32", startY: "f32", // pointer position at drag start
  originX: "f32", originY: "f32", // target's Position at drag start (the anchor)
});

const Selected = defineTag("Selected"); // LOCAL selection state on durable shapes (my own UI), distinct from
                                          // the ephemeral Selection facet above (what REMOTE peers are selecting)
const Locked = defineTag("Locked");
const Hidden = defineTag("Hidden");
// NOTE: `Local` is NOT defined here — it is imported from "strata" (the store applies it).

const ChildOf = defineRelation("ChildOf", { arity: "one" });
const ConnectedTo = defineRelation("ConnectedTo", { arity: "many", ordered: false });
const Targeting = defineRelation("Targeting", { arity: "many", ordered: false }); // gesture → target

const Viewport = defineResource("Viewport", { panX: "f32", panY: "f32", zoom: "f32" });
const Grid = defineResource("Grid", { size: "u16", snap: "bool" });
```

### 18.2 Queries

```ts
const visible = defineQuery([Position, Size, Fill, Not(Hidden)]); // renderer iterates
const selectable = defineQuery([Position, Size, Not(Locked), Not(Hidden)]); // marquee pickup
const highlighted = defineQuery([Position, Any(Selected, Related(ConnectedTo))]); // selected OR an arrow endpoint
const groupFrames = defineQuery([Position, All(Size, Label), Related(ChildOf.inverse), Not(Hidden)]); // frames with children (captured)

const pointers = defineQuery([Pointer]); // the local input entity
const activeDrags = defineQuery([DragGesture, Related(Targeting)]); // gestures + captured target
```

### 18.3 Systems and the drag pipeline

```ts
// Filtered query: iterating the batch yields only matching rows — no per-row check to forget.
const SnapToGrid = defineSystem(visible, (batch, ctx) => {
  const { Position } = batch.columns;
  const grid = ctx.getResource(Grid);
  if (!grid.snap) return;
  const g = grid.size;
  for (const r of batch) {
    Position.x[r] = Math.round(Position.x[r] / g) * g;
    Position.y[r] = Math.round(Position.y[r] / g) * g;
  }
});

// --- gesture pipeline: Pointer → recognize → DragGesture(entity) → drag → commit ---

// 1. Recognize: read the Pointer, start/end a drag gesture (its own entity, related to its target).
// Pointer and DragGesture are local-only runtime state — never durable, never synced.
const GestureRecognition = defineSystem(pointers, (batch, ctx) => {
  const input = ctx.firstOf(pointers);
  const p = ctx.read(input, Pointer);
  const active = ctx.firstOf(activeDrags);

  if (p.down && active === undefined) {
    const hit = pickShapeAt(p.x, p.y); // app hit-test → a shape entity or undefined
    if (hit !== undefined) {
      const t = ctx.read(hit, Position); // shape's current position = the anchor
      const g = ctx.spawn({ components: { DragGesture: { startX: p.x, startY: p.y, originX: t.x, originY: t.y } } });
      ctx.addRelation(g, Targeting, hit); // `g` is a real handle now — wire it to the target
      // both the spawn and the relation are deferred (visible next phase); `g` is usable as a value now.
      // `hit`'s Position now diverges from its durable baseline as the drag writes it,
      // so inbound remote Position changes to it are auto-dropped until commit (§13.3).
    }
  } else if (!p.down && active !== undefined) {
    const target = ctx.getRelation(active, Targeting); // `active` is an ENTITY → entity lookup (§6). NOT getRelated,
                                                        // which is the row-captured accessor on Batch (a row, not a handle)
    const finalPos = ctx.read(target, Position); // the value the drag already wrote (runtime)
    // ONE transaction → ONE sealed Loro commit → ONE undo entry. doc.transaction works INSIDE a
    // system: this is a value write to an existing entity, so it applies to the runtime synchronously
    // (§12) — no ctx.transaction needed. The drag's ~120 runtime writes were runtime-only and never
    // touched the doc; this seals the final value once.
    doc.transaction(tx => { tx.edit(target).set(Position, finalPos); }); // commits x/y only — a concurrent rotate is untouched
    ctx.destroy(active); // gesture ends; divergence resolves, baseline = committed value
  }
});

// 2. Drag: every frame, move each gesture's target by (pointer - start) from the anchor.
// Durability-agnostic — it just writes runtime Position columns. No transaction here.
const DragSystem = defineSystem(activeDrags, (batch, ctx) => {
  const { DragGesture } = batch.columns;
  const ptr = ctx.read(ctx.firstOf(pointers), Pointer);
  for (const r of batch) {
    const target = batch.getRelated(r, Targeting); // row-captured target — getRelated is on Batch (r is a row, §6.2)
    ctx.edit(target).set(Position, { // live runtime write — never touches the document
      x: DragGesture.originX[r] + (ptr.x - DragGesture.startX[r]),
      y: DragGesture.originY[r] + (ptr.y - DragGesture.startY[r]),
    });
  }
});
```

### 18.4 World, document, presence, save

```ts
const world = createWorld({ name: "canvas" }); // runtime built internally
world.setResource(Viewport, { panX: 0, panY: 0, zoom: 1 });
world.setResource(Grid, { size: 8, snap: true });

// local input entity — fed from DOM events (local-only, never synced)
const input = world.spawn({ components: { Pointer: { x: 0, y: 0, down: false } } });
canvas.addEventListener("pointermove", e => world.edit(input).set(Pointer, { x: e.offsetX, y: e.offsetY, down: e.buttons > 0 }));
canvas.addEventListener("pointerdown", e => world.edit(input).set(Pointer, { x: e.offsetX, y: e.offsetY, down: true }));
canvas.addEventListener("pointerup", e => world.edit(input).set(Pointer, { x: e.offsetX, y: e.offsetY, down: false }));

// the collaborative document — the USER owns the LoroDoc; createDurableStore wraps it (§14.2)
const doc = createDurableStore(myLoroDoc); // myLoroDoc: constructed + transport-wired by the app
world.attachDurable(doc); // registers an InboundSource on the world (§16.1)

// durable content — a transaction returns fn's result (real handles, no aliases)
const { rect } = doc.transaction(tx => {
  const rect = tx.spawn({ components: {
    Position: { x: 40, y: 40 }, Rotation: { angle: 0 }, Size: { w: 120, h: 80 },
    Fill: { r: 80, g: 140, b: 255, a: 255 }, ZIndex: { z: 1 }, Kind: { shape: "rect" }, Label: { text: "Button" },
  }});
  return { rect };
});

// a structural edit — ONE undo unit, ONE transaction (the frame handle is a real value)
const { frame } = doc.transaction(tx => {
  const frame = tx.spawn({ components: { Position: { x: 0, y: 0 }, Size: { w: 400, h: 300 }, Label: { text: "Card" }, Kind: { shape: "frame" } } });
  tx.setRelation(rect, ChildOf, frame); // existing entity → real handle from this block
  tx.addRelation(rect, ConnectedTo, frame);
  return { frame };
});

// select locally — ephemeral UI state, NOT durable, no transaction. Just a runtime tag bit.
// sync() FIRST so rect's durable spawn has projected (it was identity-only until now, §5.2/§12): tagging
// an identity-only durable handle would place it half-projected (queryable, but no durable components yet),
// which dev mode rejects. After sync, rect is a fully-placed runtime entity and the tag is clean.
world.sync();
world.addTag(rect, Selected);

// transient shared state — sibling layer, no transaction, eager throttled + keepalive (§15.5)
// the USER owns the Loro EphemeralStore + transport, exactly like the durable doc (§14.2)
const eph = createEphemeralStore(myLoroEphemeralStore, {
  peerId: myPeerId, send: bytes => transport.broadcast(bytes), throttleMs: 16, ttlMs: 5000, // send = outbound sink
});
world.attachEphemeral(eph); // also registers an InboundSource
// spawn my presence entity WITH its components (no-upsert: set needs them present, §5.3)
const me = eph.spawn({ components: { PresenceInfo: { name: "Alice", color: 0xff3366 }, CursorPos: { x: 0, y: 0 } } }); // auto-tagged Local
// mutate `me` through the EPHEMERAL store — NOT world.edit — or the change is never marked dirty/sent
canvas.addEventListener("pointermove", ev => eph.edit(me).set(CursorPos, { x: ev.offsetX, y: ev.offsetY }));
// component membership as a signal: add Selection while selecting, remove when done (§15.6)
// on select: eph.addComponent(me, Selection, { targetKey });
// on deselect: eph.removeComponent(me, Selection);
// (mutating `me` via eph.* self-throttles outbound — no per-frame send call)

const remoteCursors = defineQuery([CursorPos, PresenceInfo, Not(Local)]);
const RenderCursors = defineSystem(remoteCursors, (batch) => {
  const { CursorPos, PresenceInfo } = batch.columns;
  for (const r of batch) { /* draw a labeled cursor at (CursorPos.x[r], CursorPos.y[r]) */ }
});

// the pipeline — a VALUE; array order is run order; flush happens at each phase boundary (§7)
const pipeline = [
  phase("input", [GestureRecognition]),
  phase("drag", [DragSystem]), // self-skips when no active drags (empty query = free no-op)
  phase("layout", [SnapToGrid], { runIf: (ctx) => ctx.getResource(Grid).snap }), // runIf gates on a RESOURCE flag
  phase("render", [RenderCursors]), // a "render" PHASE that prepares draw data; actual
]; // pixel output is outside tick (see frame loop)

// the frame loop — composed by the user from small operations (§16.2)
function frame() {
  world.sync(); // frame start: drain InboundSources (durable + ephemeral) → apply immediately
  world.tick(pipeline); // phases, each with its own command buffer flushed at its boundary
  drawCanvas(world); // pixel output — the user's concern, reads runtime columns directly
}
requestAnimationFrame(function loop() { frame(); requestAnimationFrame(loop); });

// local, non-collaborative save — integer keys, reuses the runtime walk (Part I §8)
const bytes = world.export();
// world.import(bytes) on another run → two-phase load

// closing down
world.detach(eph); // stop broadcasting; despawn all remote ephemeral entities
world.detach(doc); // close the document; despawn its projected shapes (doc & Loro untouched)
```

### 18.5 How a drag flows — the architecture in miniature

1. DOM events write `Pointer` on the input entity — *local-only runtime* state.
2. `GestureRecognition` reads `Pointer`; on press over `rect` it spawns a **DragGesture entity** related to `rect` via `Targeting`. Both `Pointer` and `DragGesture` are local-only; nothing is synced or saved yet.
3. `DragSystem` runs every frame, writing `rect`'s `Position` **live to the runtime column** from the pointer delta. The shape moves on screen in real time. **No transaction** — intermediate positions never enter Loro. Because the runtime `Position` now diverges from its baseline, inbound remote `Position` changes to `rect` are **auto-dropped** by reconcile's compare (§13.3) — no active-edit flag, the divergence *is* the signal.
4. On release, `GestureRecognition` opens **one** transaction — `doc.transaction(tx => tx.edit(target).set(Position, finalPos))` — committing **only** `Position` (a concurrent rotate's `Rotation` is never touched, §13.4). The final position becomes **one Loro commit → one undo step**; it is a value write to an existing entity, so it applies to the runtime synchronously and the baseline advances to it (§13.2), runtime and baseline agree again, and inbound `Position` changes resume. (No `ctx.transaction`: `doc.transaction` is safe inside a system, §12.)

A 2-second drag at 60fps is ~120 runtime writes and exactly **one** transaction — the literal reason the explicit transaction boundary exists. If a collaborator drags `rect` concurrently, the baseline divergence holds your value mid-gesture and your committed final `Position` wins as the later op (committer-wins, §13.4). And if your gesture were torn down *without* committing, `rect.Position` would strand — which the dev-mode warning (§13.5) would flag.

## 19. Build order

1. **Part I — Schema API + typed-array archetype core + entity table** (generational indices). The keystone and hardest to retrofit; lock the field-type vocabulary now.
2. **Part I — Tag bitsets + relation indices + the symbol registry** (and per-cell string columns, §3.4). Additive to the core; completes the three-bucket runtime.
3. **Part I — Query engine** (`defineQuery` with `Not`/`Any`/`All`, no `Or`; archetype-mask + per-row probes; cached matching-archetype lists) **and the command buffer / flush** (§5): structural changes buffered as op-typed `StructuralCommand`s, a single-pass flush at each phase boundary, inline both-directions despawn cascade, insertion-order with validate-on-read. The op-typed element is what later lets durable projection and inbound remote changes reuse the same structural `apply` primitives (place/unplace/migrate, §5.5) — without the system command buffer, whose one producer is system code via `ctx` (§5.4).
4. **Part I — Local snapshot** (columnar-per-archetype serialization, two-phase load, integer keys). Non-collaborative save/load; mechanical once the runtime shape is fixed.
5. **Part II — The storage substrate.** The snapshot ladder (`Snapshot`/`MutableSnapshot`/`CRDTSnapshot`) and the projector kernel (the three mint-policy operations, the bijection). This is the foundation the next two stand on; build it before either layer.
6. **Part III — The durable layer.** The binding (the seam), `DurableTarget`, the transaction executor (`doc.transaction` → recorded ops, real handles, pre-bound keys, one sealed batch — no aliases), projection (two-phase attach, baseline seeding), the reconcile model (apply-converged-truth, the remote-value drag-drop, structure via projection), no-abort + the dev-mode stranded-cell warning, `createDurableStore(doc)`. `LoroSnapshot` — one of the two Loro-aware adapters (the ephemeral store's `LoroEphemeralSnapshot` is the other) — is written here.
7. **Part IV — The ephemeral layer.** Reuse the projector kernel and projection; expose the `Mutator` vocabulary scoped to the writer's own partition (peer-prefixed keys, §15.3), unconditional apply (no baseline — writer-partitioned), single-phase (no relations), dynamic-component value diff on inbound, self-throttled outbound + keepalive (the store sends on its own clocks — no per-frame call), Loro-`timeout`→despawn lifecycle; entities you spawn are auto-tagged `Local`. The store registers an `InboundSource` on attach so `world.sync()` drains inbound. Backed by Loro's EphemeralStore. Smaller than durable — build it after, as the conflict-free sibling.

The throughline once more: **typed arrays for fixed-size numbers iterated every frame; identifier strings interned to numbers and value strings owned per-cell; tags as bitsets; relations as bidirectional maps; entities as generational handles** (Part I); **one snapshot interface and one projector kernel** unifying every storage representation (Part II); **a durable layer that is a lagging-baseline reconcile seam over a Loro doc, committed at explicit boundaries** (Part III); **an ephemeral layer that is the same projection minus the baseline and relations, eager-synced and never kept** (Part IV). Three tiers of state — local-only runtime, durable document, ephemeral presence — projected into one queryable runtime; the runtime is built for the frame, and neither sync tier ever intrudes on the hot path.

## 20. API at a glance

| You want to… | Use | Part |
|---|---|---|
| Declare data on entities | `defineComponent` (+ field types, `enumOf`) | I |
| Declare a marker/flag | `defineTag` | I |
| Declare a link between entities | `defineRelation` | I |
| Declare a world singleton | `defineResource` | I |
| Select entities | `defineQuery` + `Not`/`Any`/`All`/`Related` | I |
| Run logic over a selection | `defineSystem` → `(batch, ctx)` | I |
| Read/mutate inside a system | `ctx.*` (deferred structural, immediate reads) | I |
| Create the world | `createWorld` (runtime built internally) | I |
| Spawn a runtime-only entity | `world.spawn({components, tags})` → `Entity` | I |
| Compose systems into a schedule | `phase(...)` in a `Pipeline` array (order = run order) | I |
| Gate a system or phase | `runIf` (a `(ctx) => boolean`) | I |
| Run systems | `world.tick(pipeline)` (any cadence; flush at phase boundaries) | I |
| Drive a frame | `world.sync()` (once) → `world.tick(pipeline)` → render | I, III, IV |
| Save/load locally (non-collaborative) | `world.export()` / `world.import()` | I |
| Create a collaborative document | `createDurableStore(loroDoc)` → `DurableStore` | III |
| Create durable content | `doc.transaction(tx => tx.spawn(...))` | III |
| Open/close a document on the canvas | `world.attachDurable(store)` / `world.detach(store)` | III |
| Commit durable changes as one undo unit | `doc.transaction(tx => { ... })` | III |
| Transient shared state (presence, previews) | `createEphemeralStore()` → `EphemeralStore` (spawn entities in your partition) | IV |
| Broadcast my presence | `eph.spawn` one entity in my partition; write components, eager sync, no transaction | IV |
| Render others' ephemeral state | query remote entities (e.g. `[CursorPos, Not(Local)]`) | IV |

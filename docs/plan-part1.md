# Part I — The Runtime Core: Build Plan

> **Status: ✅ COMPLETE (2026-07-01).** All milestones M0–M7 landed and committed, each
> adversarially reviewed (multi-agent) with confirmed findings fixed. 147 tests green; the
> movement hot loop runs 10k entities in ~0.23 ms. Part I is a usable standalone product.
>
> **Deferred follow-ups (type-level / ergonomic only — runtime is complete and tested):**
> - **Typed `col<S>`** — precise per-field column typing (`batch.col(Position).x` as `Float32Array`
>   without a cast). Needs `defineComponent` to infer the field-type map into the handle; a
>   contained TS-types refactor.
> - **`Relation.inverse`** — reverse-edge queries (`Related(rel.inverse, …)`).
> - **Import into a non-empty world** — `world.import` currently requires a fresh world.
> - **Snapshot compaction** — columnar/binary format instead of JSON (an optimization).

This is the working plan for **Part I** of strata (the local, non-collaborative ECS).
It follows the design's own build order (`docs/design.md` §19) but expands it into
milestones with scope, deliverables, tests, and the design decisions we lock in now.

**Goal of Part I:** a complete, fast, single-user ECS — typed-array archetype columns
iterated with *no per-row object allocation in the hot loop*, first-class
components/tags/relations, generational-index identity, the schema API, the mutation
layer (shape/value split + command buffer), a query engine, a value-driven tick
pipeline, and non-collaborative save/load. Zero durability, zero sync, zero runtime
dependencies.

---

## Locked design decisions (v1)

Resolving the under-specified points the design flags, so the build is unambiguous.
All follow the doc's recommended defaults.

| Area | Decision |
|---|---|
| **Entity handle** | Packed `u32`: **20-bit index / 12-bit generation** (editor default, §2). ~1.05M concurrent slots, 4096 generations/slot. Constants centralized in one module, not per-call-configurable in v1. |
| **Generation** | Fresh slots start at generation **1**. `generation 0` is reserved = "never issued". Bump happens at **free** (despawn: `freeIdentity` = gen-bump + freeList push, §5.5); wrap skips 0. |
| **Sentinels** | `NO_ARCHETYPE = NO_ROW = 0xFFFFFFFF`. Semantically independent, both checked; despawn resets a slot to both (§2). |
| **Free list** | `number[]`, **LIFO** (pop/push) — recycles recently-freed slots first (cache-warmer). Nothing pops the freeList during a flush, so a freed slot is never re-occupied mid-flush (§5.5 guarantee). |
| **Empty archetype** | A normal archetype with signature `∅`, created at store init with a fixed id. `place` into it runs a zero-length field loop (§5.5). |
| **Tag bitsets** | `Uint32Array`, 1 bit/**slot**. Length in words = `ceil(slotCapacity / 32)`. Grows with entity-table slot capacity; new words zero-filled. |
| **Column growth** | Geometric **doubling** on overflow. Typed arrays: allocate larger + copy. String columns `(string｜null)[]`: grow with **null-fill** (never `undefined`); on shrink, **null** vacated slots but keep backing capacity (§3.4 invariant). |
| **Enum storage** | Smallest unsigned int fitting the max discriminant (`Uint8` < 256, else `Uint16`, else `Uint32`). Durable safety = explicit discriminants (`enumOf({...})`); positional is local-only (§4). API surface is label-valued; discriminant is storage. |
| **`noUncheckedIndexedAccess`** | **Off** — keeps hot-path typed-array indexing clean; the "never `undefined`" column invariants are enforced by runtime asserts + a dedicated invariant test, not the type system. |
| **Dev-mode diagnostics** | A single `DEV` constant (`process.env.NODE_ENV !== "production"`, `define`-replaced by tsup) gating `devWarn`/`devError`; compiles out of production builds (§5.5). |
| **Value/shape split** | Drawn at **authoring time** by which method is called (`addComponent` vs `edit().set` vs `removeComponent`), asserted at the `ctx`/`world` surface *and* re-checked at flush (§5.3, §5.5). |

---

## Milestones

Each milestone is independently testable and lands with green `pnpm ci`.

### M0 — Scaffold + toolchain ✅ (done)
Single package, layered `src/` (`core`/`storage`/`durable`/`ephemeral`), subpath
exports, Node 24 + pnpm + Vitest + tsup + ESLint. Smoke test green.

### M1 — Identity substrate: symbol registry + entity table
*Design: §2, §3.4 (registry).* The keystone; nothing else compiles without it.
- **Symbol registry** — `intern`/`resolve`, grow-only, reserved framework names (`Local`) throw on redefine.
- **Entity packing** — `pack(slot, gen)`, `slotOf`, `genOf`, constants (`INDEX_BITS=20`, `GEN_BITS=12`, masks).
- **Entity table (SoA)** — `generations`, `archetypeId`, `rowInArch` (`Uint32Array` + sentinels), `freeList`.
- `allocateIdentity()`, `freeIdentity(e)` (gen-bump skipping 0 + push), `isAlive(e)`.
- **Tests:** pack/unpack round-trips across the full range; reuse bumps generation; stale handle fails `isAlive`; gen-0 reservation + wrap-skip; reserved-name throw.

### M2 — Schema API + archetype store + immediate structural mutation
*Design: §3.1, §4, §5.5.* The typed-array engine and the five physical primitives.
- **Schema** — field-type→typed-array routing table; `field(type, {default})`; `enumOf` (positional + explicit); `defineComponent`/`defineTag`/`defineRelation`/`defineResource`. Complete-values-or-declared-default enforcement (throw on missing non-defaulted field).
- **Archetype** — per-field columns, `entities` back-pointer, `count`; `archetypeFor(signature)` with lazy creation + query-notification hook; the empty archetype.
- **Primitives** — `place`, `unplace` (swap-and-pop + **moved-entity back-pointer fixup** + **string-null invariant**), `migrate` (**read-before-place-before-unplace**), `ensurePlaced`, `spawnPlace`, `cellWrite`.
- **`RuntimeStore` (immediate ops)** — `spawn`/`destroy`(partial: no cascade yet)/`addComponent`/`removeComponent`/`writeComponent`/`has`/`read`/`get`.
- **Tests:** column layout (2 columns for `Position{x,y}`); migration copies overlapping fields + fixes back-pointers; the **string-null capacity invariant** (walk each string column `count..length`, assert `=== null`); `read` throws vs `get` undefined on identity-only; default-fill vs missing-field throw.

### M3 — Tags + relations (the other two buckets) + despawn cascade
*Design: §3.2, §3.3, §5.5.* Completes the three-bucket runtime.
- **Tag bitsets** — slot-indexed, growth policy; `addTag` (calls `ensurePlaced` on source), `removeTag`, **generation-guarded** `hasTag`, `clearAllTags(slot)`.
- **Relations** — `oneForward`/`manyForward`/`reverse` (Entity-keyed); `setRelation`/`addRelation`/`removeRelation` (each `ensurePlaced`s the source, never the target); `getRelation`/`getRelations`/`getReverse`; `readEid` (validated).
- **Despawn cascade** — inline, both directions (incoming via reverse, outgoing via forward) + `clearAllTags`, terminal; `destroy` completed.
- **Tests:** stale-handle `hasTag` returns false; tag survives archetype migration (slot-invariant); `addRelation` idempotent (Set dedup); despawn clears both directions + reverse of `getReverse`; reused slot starts tag-clean.

### M4 — Query engine
*Design: §6.* Reading — the consumer of the schema.
- **Operators + normalization** — `Not`/`Any`/`All`/`Related`; top-level AND; `Any` disjunction scope; no `Or`; fold-to-level (component→mask, tag/relation→rowFilter, concrete target→seed).
- **`QueryPlan`** — `componentMask`/`excludeMask`/`rowFilters`/`seed`/`matchingArchetypes` (cached, rebuilt on new-archetype notification).
- **`Chunk`/`batch`** — `col(C)`, `denseCount`, `isDense`, `entity(r)`, `getRelated`, `[Symbol.iterator]` (fuses `rowFilters` as `continue`; one iterator/chunk, no per-row object alloc).
- **Dispatch** — `query(plan).each(fn)`: dense archetype path + seeded (reverse-index) path.
- **Tests:** the four §6.3 worked cases (pure component; tag rowFilter; abstract `Related` + capture; concrete `Related` seeding); empty-mask query finds tag-only entity in empty archetype; `for…of` filtered correctness vs raw `denseCount` (dense-only).

### M5 — Command buffer + systems + the tick
*Design: §5.1–5.6, §7, §16 (sync hook).* The mutation layer's deferral machinery + execution.
- **`StructuralCommand`** union (id-keyed) + `ComponentInit` lowering from the ergonomic spawn form.
- **Command buffer** — pooled, handle-based (`allocate`/`enqueue`/`flush`/`release`); `apply` dispatch onto the five primitives; **validate-on-read** guard; **flush-time precondition policy** (idempotent no-ops; dev add/remove diagnostics).
- **`SystemCtx`** — deferred `ctx.*` structural (enqueue), immediate reads + `edit().set` value writes; `getResource`.
- **`World`** — delegates immediate ops to `RuntimeStore`; `isPlaced`/`isIdentityOnly`; dev-mode identity-only structural guard; `setResource`/`getResource`; `sync()` (no-op in pure Part I — the layer hook).
- **Schedule** — `defineSystem`, `phase`, `Pipeline`, `runIf`, `world.tick(pipeline)` (one buffer/phase, flush at boundary).
- **Tests:** `ctx.spawn` handle usable immediately but not queryable until next phase; shape changes visible at phase boundary (not within); value writes visible immediately + order-sensitive; **no-coalescing observable outcomes** (spawn+destroy transient; destroy+addRelation dropped via validate-on-read); cross-system same-phase precondition policy; empty pure Part I `sync()` is a no-op.

### M6 — Local snapshot (save/load)
*Design: §8.* Mechanical once the runtime shape is fixed.
- `world.export()` / `world.import()` — columnar per-archetype serialization, dense integer keys, enum-as-discriminant; value strings serialize as themselves; registry re-derived from schema.
- Two-phase load (create all entities → resolve relations).
- **Tests:** full round-trip (components/tags/relations/resources) equality; relation targets resolve regardless of entity order; string cells (`null` vs `""`) preserved.

### M7 — Cross-cutting: benchmarks + hardening
*Design: performance thesis, §17 (parallel-ready seams).*
- **Benchmarks** (`vitest bench`): movement system over N entities (hot-loop throughput, alloc-free); migration throughput; query dispatch overhead; seeded vs dense.
- Property/fuzz tests for the entity table + swap-and-pop invariants.
- Public API surface review + `strata` entry wiring (export `Local`, the field-type helpers, all `define*`, query operators, `createWorld`).

---

## Testing & quality strategy

- **Colocated unit tests** (`src/**/*.test.ts`) per module; **invariant tests** for the
  load-bearing guarantees (string-null capacity, generation safety, back-pointer
  integrity, single-pass flush termination).
- **`pnpm ci`** (typecheck + lint + test) green at every milestone boundary.
- **Benchmarks** guard the performance thesis — the hot loop must stay monomorphic and
  free of per-row object allocation.

## Sequencing notes

- M1→M2→M3 build the store bottom-up; **M4 (query) and M5 (mutation/tick) both depend on
  M2–M3** but are independent of each other and could be parallelized.
- The `RuntimeStore` **projection primitives** (`ensurePlaced`, `projectComponent`,
  `projectRemoveComponent`, `allocateIdentity`) are implemented in M2–M3 even though
  their *consumers* are Part II/III — they are the published seam the substrate builds
  on, so getting their shape right now avoids a retrofit later (§ Part I ref).

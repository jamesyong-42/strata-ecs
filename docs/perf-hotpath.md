# Design note — hot-path optimizations (query iteration + random-access reads)

**Status:** IMPLEMENTED (2026-07-01) — with a corrected attribution; see the addendum at the bottom.
Surfaced by the comparative benchmark (`BENCHMARKS.md`, `bench/compare/`). Additive,
backward-compatible changes to the Part I runtime. No change to timing (§0), placement/migration
(§5.5), or query semantics (§6) — only how rows and field values are *handed to* the caller.

> ⚠️ The attribution in the "Profiling" section below is the ORIGINAL (approved) analysis and is
> partly WRONG — the V3 experiment removed the row filter as well as the generator, so it over-credited
> the generator. The corrected, evidence-based breakdown is in the **addendum** at the end. The
> optimizations still landed; their real impact just differs from the first estimate.

## Motivation

The realistic-frame benchmark (`sim_frame`: 4 systems over a mixed 10k-entity world) put strata at
392µs vs bitecs 56µs / koota 98µs. The `random_access` extension (read one field for 10k random
entities) put strata at 989µs vs bitecs 481µs. Both looked like "archetype ECS tax." Profiling shows
otherwise: both are cheap, self-inflicted allocation/iterator costs that violate the project's own
hot-path thesis ("typed-array columns iterated with no per-row object allocation").

## Profiling attribution (measured, Apple M1 Max, Node 24)

`sim_frame`, isolating each suspected cost (`scratch` harness, 2000 iters, warmed):

| variant | µs/op | conclusion |
|---|---:|---|
| V0 — current: `world.tick` + `Not(Frozen)` tag + `for (const r of b)` | 325 | baseline |
| V1 — bare query, **no tick/ctx/command-buffer** | 326 | scheduler overhead ≈ **0%** |
| V2 — `Frozen` as component (archetype-level exclusion), still `for..of` | 323 | tag-filter vs archetype exclusion ≈ **0%** |
| V3 — same as V2 but `Movement` uses raw `for (r < denseCount)` | **20** | **the generator is the entire cost (16×)** |

The two things I originally proposed to fix — a read-only-phase command-buffer fast-path, and
archetype-level exclusion — are each worth ~2% and are **dropped**. The real cost is that
`for (const r of b)` iterates through a generator.

---

## Optimization A — generator-free `Batch` iteration

### Problem

`ArchetypeChunk[Symbol.iterator]()` returns `denseIterator()`, a `function*`
(`src/core/runtime-store.ts`, `denseIterator`), for **every** `for (const r of b)` loop — including
dense batches, where it simply yields every row. V8 generator resumption costs ~15–20ns per `yield`;
the raw index loop is ~1ns/row. So:

- `packed_5` is fast only because its body hand-writes `for (let r = 0; r < b.denseCount; r++)`.
- The moment a system uses the ergonomic `for..of`, or **must** (any tag / relation / `Not` term
  produces a per-row filter, so the batch is not `isDense` and the raw loop is invalid), it pays 16×.

Filtered iteration has *no* fast option today. That is the gap on `sim_frame`.

### Design

Add a materialized matched-row view to the `Batch` protocol and make one raw-loop idiom valid for
**all** batch kinds (dense, filtered, seeded):

```ts
export interface Batch extends Iterable<number> {
  readonly count: number;      // NEW — number of MATCHED rows (row filters applied)
  readonly rows: Int32Array;   // NEW — matched row indices; valid for rows[0 .. count)
  // unchanged: denseCount, isDense, col, columns, entity, getRelated, getAllRelated, [Symbol.iterator]
}
```

Canonical fast idiom (replaces both the raw-`denseCount` loop *and* `for..of`):

```ts
const px = b.col(Position).x as Float64Array;
for (let i = 0; i < b.count; i++) { const r = b.rows[i]; px[r] += 1; }
```

Producing `rows`/`count` per chunk, **allocation-free**:

- **Dense batch** (`rowFilters.length === 0`, unseeded): `rows` is a process-wide **identity array**
  `[0, 1, 2, …]` — a single `Int32Array` grown once to the largest archetype ever seen and shared by
  every dense chunk; `count = arch.count`. Zero per-chunk work.
- **Filtered batch**: fill a single **reused scratch `Int32Array`** (owned by `RuntimeStore`, grown
  as needed) with one pass applying `passesRowFilters` (`src/core/runtime-store.ts`); `count` =
  matches. This replaces N generator-yields with N array writes + N array reads; the filter predicate
  runs exactly once per row, as it does today.
- **Seeded batch** (concrete relation target): `rows = seededRows` (already a plain array),
  `count = seededRows.length`.

Backward compatibility: `for (const r of b)` keeps working, re-backed by `rows[0..count)` via a
**reused, non-generator** iterator object held on the chunk (reset per `[Symbol.iterator]()` call).
It is still ~5× faster than today but a touch slower than the explicit `count` loop, which becomes
the documented hot path (examples, `bench/`, and the system bodies move to it).

### Allocation-free chunk reuse (A′, folds in here)

`runQuery` currently does `new ArchetypeChunk(this, arch, q.rowFilters)` per matching archetype
(`src/core/runtime-store.ts`, `runQuery`/`runSeeded`) — a per-chunk heap allocation. Because chunks
are processed strictly one-at-a-time (each `each` callback runs to completion before the next), a
**single reusable `ArchetypeChunk`** can be re-pointed (`arch`, `rowFilters`, `rows`, `count`,
`seededRows`) across archetypes. This removes the last per-tick allocation on the query path. It
composes with A (same lifetime rules) and is the natural place to own the reused row iterator.

### Fit with the design

- **§6.2 (the chunk protocol).** The design already distinguishes "raw `for (r < denseCount)` is
  valid only when `isDense`" from "`for (const r of b)` otherwise." This *unifies* them into one
  always-valid, always-fast idiom — it removes a footgun rather than adding one. `denseCount`/
  `isDense` stay for compatibility.
- **Hot-path thesis (§3, `CLAUDE.md`).** A generator that resumes per row is per-row work the thesis
  exists to avoid; this is arguably a conformance fix, not just a speedup.
- **Chunk-scoped validity.** `rows` inherits the exact rule already stated for `col()`/`entity()`:
  **valid only inside the current `each` callback.** It is a shared scratch buffer refilled per chunk,
  same lifetime as the columns. Single-threaded, chunk-synchronous ⇒ no aliasing hazard.
- **Invariants.** No change to placement, migration, filter semantics, validate-on-read, or the
  §5.5 flush policy. Purely presentation of rows to the body.

### Expected impact

- Dense `for..of`/`count` bodies: **325µs → ~20µs** on `sim_frame` (measured V3). Moves strata from
  5th to ~2nd on that frame, near bitecs.
- Filtered bodies: keep the one-time filter pass, drop the generator ⇒ estimated **~60–80µs**
  (competitive with koota's 98µs).
- Every real system that iterates with `for..of` benefits with no code change; opting into the
  `count` loop gets the full win.

---

## Optimization B — field-level read `readField`

### Problem

`random_access` reads one field for 10k random entities by handle, but `read(e,c)` / `get(e,c)` build
a fresh `{ field: value }` object per call (`src/core/runtime-store.ts`, `readPresent`). 10k object
allocations per op ⇒ GC pressure; that is the whole 989µs vs 481µs gap.

### Design

Add an allocation-free single-field read to the `ECSStore` contract, next to `read`/`get`/`readEid`:

```ts
// src/core/ecs-store.ts (contract) + runtime-store.ts (impl) + world.ts / system.ts (surface)
readField<T = number>(e: Entity, c: Component, field: string): T | undefined;
```

Implementation is `read` minus the object:

```ts
readField(e, c, field) {
  if (!this.has(e, c)) return undefined;               // `get`-style: undefined, not throw
  const meta = c.fieldByName.get(field);
  if (meta === undefined) return undefined;
  const A = this.archetypeOfEntity(e);
  const row = this.table.rowOf(slotOf(e));
  return decodeField(meta.spec.type, readCell(A.columns.get(meta.fieldId) as Column, meta.kind, row)) as T;
}
```

### Fit with the design

- **Generalizes an existing precedent.** The store already has the single-field `readEid(e, c, field)`
  (§2). `readField` is its non-eid generalization (and `readEid` could later be expressed on top).
- **§5.2 (value reads are immediate).** Unchanged — this is an immediate read on the value surface.
- **The ergonomic/fast split, mirrored.** Just as `col()` (raw column) is the fast counterpart to
  `read()` in iteration, `readField()` is the fast counterpart to `read()` for random access. `read`/
  `get` remain the ergonomic default.
- **Seam-correct.** It lives on `ECSStore`, so `World`, `SystemCtx`, and Parts II–IV inherit it.

### Expected impact

`random_access` **989µs → ~500µs** (estimated; allocation removed), matching bitecs/miniplex. To be
**validated on implementation**, not asserted.

---

## Dropped

- **Read-only-phase command-buffer fast-path** — measured ~2% (V0 vs V1). Not worth the special case.
- **Archetype-level `Frozen` exclusion** — a wash vs the tag row filter (V1 vs V2). Modeling choice
  for users, not a runtime fix.

---

## Rollout & verification

1. Land **A + A′** (touch `query.ts` interface, `runtime-store.ts` `ArchetypeChunk`/`runQuery`/
   `runSeeded` + a reused scratch/identity buffer). Update the existing query tests to also exercise
   `rows`/`count`; keep the `for..of` tests green. Re-run `pnpm run ci` and `pnpm test:stress`.
2. Move `bench/compare/scenarios/strata.ts` and `src` examples to the `count` idiom; re-run
   `node run.mjs`; record the new `sim_frame`/iteration numbers in `BENCHMARKS.md`.
3. Land **B** (add to `ecs-store.ts`, `runtime-store.ts`, `world.ts`, `system.ts`; a focused test
   incl. missing-component ⇒ `undefined`, enum/string/eid field decoding). Add a `random_access`
   variant using `readField` and re-benchmark.
4. Update `docs/plan-part1.md` deferred-list to mark these done, and note any residual per-chunk
   `col()` object cost (a possible C follow-up: a cached/scalar column accessor) if it still shows.

## Addendum — corrected attribution & what actually landed (2026-07-01)

Deeper profiling (decomposing `sim_frame` piece by piece rather than swapping tag→component, which
conflated two costs) gave the real breakdown of the original 392µs:

| cost | µs | fixed by |
|---|---:|---|
| checksum reduction into a callback-**captured accumulator** (heap Context write per row) | ~120 | benchmark fix: chunk-local accumulate, add once |
| per-row `Map.get` in the filtered row-check (`tags.has` per row) | ~50 | **filter hoist** (this work) |
| generator per-`yield` on `for (const r of b)` | ~35 | **generator removal / A** (this work) |
| actual 4-system frame work | ~77 | — |

So the single largest factor was **not** a runtime cost at all — it was our benchmark accumulating the
checksum into a scalar captured by the `.each` callback (~7ns/row heap write). That penalized the
callback-based libraries (strata, koota) and not the in-scope-loop libraries (bitecs, miniplex). It is
now fixed for all libraries (`BENCHMARKS.md` › Methodology). **Recommended strata idiom for a reduction:
accumulate per-chunk into a local, add to the outer total once per chunk.**

What actually landed:

- **A — generator-free iteration:** DONE. Real win for `for (const r of b)` (removes the per-`yield`
  cost); also the substrate the filter hoist needed. `for..of` now reuses one result object (no
  per-row allocation). Materialized `rows`/`count` added to `Batch`.
- **Filter hoist (unplanned, discovered):** DONE. `fillMatchedRows` resolves a single `tag`/`Not(tag)`
  filter's bitset once and inlines the bit test — no per-row `Map.get`. The dominant *runtime* win for
  filtered queries (`Movement` on `sim_frame`).
- **B — `readField`:** DONE, but a **smaller win than estimated** (989→816µs on `random_access`, not
  ~500µs). Profiling showed the object allocation was only ~7ns/read; the real cost is the archetype
  handle→slot→archetype→row→column indirection, which is inherent to the model. `readField` is still
  worth it (allocation-free, useful API) but does not close the gap to bitecs's flat eid array.
- **A′ — reuse `ArchetypeChunk` across archetypes:** DEFERRED. Measurement showed per-chunk allocation
  is negligible (a mixed 8-archetype dense frame runs in ~20µs), so the win doesn't justify the
  nesting-safe chunk-pool complexity. Revisit only if a future workload shows chunk-alloc pressure.
- **Read-only-phase tick fast-path:** DROPPED (measured ~2%, as originally noted).

Net effect on the fair benchmark: strata moved to top-tier on dense iteration (ties/beats bitecs on
`packed_5`/`simple_iter`/`frag_iter`) — mostly from the benchmark reduction fix, with the generator +
filter-hoist runtime wins contributing on the filtered/`for..of` paths.

## Open decisions (for review)

- **`readField` addressing:** by field **name** (string, ergonomic — a `Map.get`) as proposed, vs by
  `FieldId` (slightly faster, clunkier). Proposal: name; revisit if the `Map.get` shows up.
- **`readField` missing-component semantics:** `undefined` (like `get`) as proposed, vs throw (like
  `read`). Proposal: `undefined`.
- **Symmetric `writeField`** for hot random-access writes: out of scope here; note as a future
  follow-up if a workload needs it (value writes already have the immediate `edit().set` path).
- **`for (const r of b)` fate:** keep it (non-generator, ergonomic) as proposed, vs deprecate in
  favor of the `count` loop. Proposal: keep — it's the readable idiom and now cheap enough.

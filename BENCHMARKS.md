# strata — comparative benchmarks

strata vs the four most-used TypeScript/JS ECS libraries, across three families: **realistic frames**
(a full frame through each library's real system pipeline), the canonical `ecs_bench_suite`
**micro-scenarios**, and editor-centric **extensions**. Suite, per-library implementations, and runner
live in [`bench/compare/`](bench/compare/); the raw generated table is
[`bench/compare/RESULTS.md`](bench/compare/RESULTS.md). Reproduce: `pnpm build`, then
`cd bench/compare && node run.mjs`.

## Read this first — honesty about what changed

An earlier cut of this suite showed strata trailing on iteration. Profiling found the cause was **our
own benchmark instrumentation, not strata**: the checksum reductions accumulated into a
callback-captured scalar (`sum += col[r]` inside `.each(...)`), which V8 stores in a heap Context slot
and writes **every row** (~7ns/row) — a penalty the callback-based libraries (strata, koota) paid but
the in-scope-loop libraries (bitecs, miniplex) did not. Fixing it (accumulate per-chunk into a local,
add once — the correct idiom for all libraries) is the bulk of strata's improvement below. On top of
that sit three genuine **runtime** optimizations (see `docs/perf-hotpath.md`):

- **generator-free query iteration** — `for (const r of b)` no longer routes through a `function*`;
- **row-filter hoisting** — a `tag`/`Not(tag)` filter resolves its bitset once, not per row;
- **`readField`** — an allocation-free single-field read for random access by handle.

Separating the two matters: most of the headline movement is a **measurement correction** that
un-penalized callback iteration; the runtime changes are real but smaller. Both are disclosed.

**Positioning.** strata targets editor/collaboration workloads: structural change through a scheduled
pipeline, save/load, undo-redo. Expect it to **win entity-lifecycle churn**, be **top-tier on dense
iteration**, **uniquely ship serialization**, and **pay real cost on component add/remove and
random-access-by-handle** (the archetype-migration and handle→row-indirection tradeoffs). Every
scenario is published, including strata's losses. **All ten agree on a per-scenario checksum across
all five libraries** — equal work proven.

## Environment

Apple M1 Max · arm64-darwin · **Node 24.14.1** · **mitata 1.0.34** (`--expose-gc
--allow-natives-syntax`), one process per library. Pinned: **bitecs 0.4.0**, **becsy 0.16.0** (perf
build), **miniplex 2.0.0**, **koota 0.6.6**. Machine-specific, ±few-percent run-to-run — within a few
percent is a tie. All libraries now use efficient in-idiom reduction accumulators.

## 1. Realistic frames — µs/op (lower is better; **bold** = fastest)

| frame | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| sim_frame | 101.3 | **47.5** | 1193 | 630 | 85.8 |
| spawn_reap_frame | **2616** | 3651 | 5447 | 4589 | 13640 |
| toggle_frame | 12462 | 11271 | **5390** | 24412 | 39191 |

- **`sim_frame`** — 4 systems over a mixed 10k-entity world: `Movement` (excludes `Frozen`), `Regen`,
  `ApplyDamage` (join `[Health,Damage]`), `Render` (join `[Renderable,Position]`, reads Position after
  Movement). strata is 3rd: the filtered `Movement` materializes matched rows each frame (its ~68µs is
  most of strata's number); bitecs's flat bitmask iteration and koota's plain-array `useStores` edge it.
- **`spawn_reap_frame`** — systems **spawn then destroy** 5k entities in-frame. **strata wins** —
  deferring in-system entity churn through the command buffer and applying it in a batch at the phase
  boundary is its command-buffer design's home turf.
- **`toggle_frame`** — a system **adds then removes** a component on 10k entities in-frame (20k
  archetype migrations for strata). becsy's defer-to-frame-boundary model wins; strata ≈ bitecs.

## 2. Canonical micro-scenarios — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| packed_5 | **8.99** | 9.07 | 75.95 | 52.58 | 18.79 |
| simple_iter | **12.64** | 16.08 | 210.39 | 90.14 | 29.15 |
| frag_iter | 7.43 | **7.42** | 76.08 | 53.10 | 22.21 |
| entity_cycle | **255.1** | 297.9 | 477.3 | 613.3 | 2212 |
| add_remove | 473.1 | **217.9** | 225.6 | 1035 | 717.4 |

- **Iteration** (`packed_5`/`simple_iter`/`frag_iter`): strata is now **top-tier** — a tie with bitecs
  on `packed_5`/`frag_iter` and a clear lead on `simple_iter`. strata's contiguous per-archetype column
  loop (`b.rows[0..count)` over a typed array) has no eid-gather indirection, so it matches or beats
  bitecs's flat-array-by-eid on these dense workloads. koota (plain `number[]`) trails; miniplex (AoS)
  and becsy (proxy accessors + async) trail further.
- **`entity_cycle`**: strata **fastest** — its generational free-list + swap-and-pop lead on entity
  construction/teardown (koota's per-entity spawn/destroy is ~9× slower).
- **`add_remove`**: bitecs (bitmask flip, no data move) and becsy (deferred) win; strata pays a real
  **archetype migration** — relocating the row on each add and remove. The archetype tradeoff.

(Throughput and p99 tables: `bench/compare/RESULTS.md`.)

## 3. Extensions — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| serialize | **11345** | N/A | N/A | N/A | N/A |
| random_access | 816 | **466** | N/A | 540 | 1020 |

- **`serialize`** — whole-world save+load round-trip (5k entities, components/tags/relations). A strata
  built-in; rivals ship none → N/A.
- **`random_access`** — read one component for 10k random entities by handle. `readField` (this work)
  removed the per-read object allocation (989→816µs), but strata still trails bitecs/miniplex: the
  bottleneck is the archetype **handle→slot→archetype→row→column** indirection per read, inherent to
  the model — a flat eid-indexed array (bitecs) is fundamentally faster for scattered by-id reads. An
  honest, structural tradeoff (readField helps, but doesn't close it).

## Methodology & fairness

- **Same work, proven.** Every scenario returns a checksum (a summed value or processed count); the
  runner asserts all libraries produce the identical checksum from a fresh setup. mitata's
  `do_not_optimize` consumes it to defeat dead-code elimination.
- **Efficient in-idiom reductions everywhere.** After the finding above, all libraries accumulate the
  checksum without a per-row captured write — chunk-local then add-once for the callback libs (strata,
  koota), in-scope for the loop libs (bitecs, miniplex), a system-local for becsy. This measures the
  workload, not accumulator-capture quirks.
- **Real pipeline per library.** Frames run through each library's actual system model: strata
  `world.tick` with deferred `ctx`; becsy `world.execute` (native scheduler, structural change at frame
  boundaries → two `execute()`s for its structural frames); bitecs/miniplex/koota compose system
  functions with immediate structural ops.
- **Each library in its idiomatic fastest form**; **one process per library** (no inline-cache
  contamination, no koota `Number.prototype` bleed); warmup to steady state; `--expose-gc`; p99 shown.
- **One adaptation:** iteration ops are additive/swap-based (not the canonical `*= 2`) so values stay
  finite over mitata's iterations. All fields are f64.

## Bottom line

On a fair measurement, strata is **top-tier for dense iteration** (ties/beats the flat-array
specialist bitecs), **fastest on entity-lifecycle churn** (`entity_cycle`, `spawn_reap_frame`) — its
target editor workload — **uniquely ships serialization**, and pays honest, structural cost on
component add/remove, in-system toggling, and random-access-by-handle. The single biggest lesson was a
benchmarking one: a captured-accumulator in the checksum had been masking strata's real iteration
speed. Measured correctly, strata is exactly where its archetype-SoA design says it should be.

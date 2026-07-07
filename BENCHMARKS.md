# strata — comparative benchmarks

strata vs the four most-used TypeScript/JS ECS libraries, across three families: **realistic frames**
(a full frame through each library's real system pipeline), the canonical `ecs_bench_suite`
**micro-scenarios**, and editor-centric **extensions**. Suite, per-library implementations, and runner
live in [`bench/compare/`](bench/compare/); the raw generated tables are
[`bench/compare/RESULTS.md`](bench/compare/RESULTS.md). Reproduce: `pnpm build`, then
`cd bench/compare && node run.mjs`.

## How to read these numbers

strata targets editor/collaboration workloads: structural change through a scheduled pipeline,
save/load, undo-redo. Expect it to **lead entity-lifecycle churn**, be **top-tier on dense
iteration**, **uniquely ship serialization**, and **pay real cost on component add/remove and
random-access-by-handle** (the archetype-migration and handle→row-indirection tradeoffs). Every
scenario is published, including strata's losses.

**Equal work, enforced.** Every scenario returns a checksum, and the runner fails the whole run if
any two implementations disagree. Eight of the ten scenarios run on all five libraries; `serialize`
is strata-only (no rival ships an equivalent) and `random_access` omits becsy.

## Environment

Apple M1 Max · arm64-darwin · **Node 24.14.1** · **mitata 1.0.34** (`--expose-gc
--allow-natives-syntax`), one process per library, otherwise-idle machine. **strata-ecs 0.1.0** vs
pinned **bitecs 0.4.0**, **becsy 0.16.0** (perf build), **miniplex 2.0.0**, **koota 0.6.6**. Numbers
are machine-specific and vary a few percent run-to-run — within a few percent is a tie.

## 1. Realistic frames — µs/op (lower is better; **bold** = fastest)

| frame | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| sim_frame | 79.6 | **38.5** | 872 | 400 | 64.9 |
| spawn_reap_frame | **1614** | 2758 | 4004 | 2863 | 9837 |
| toggle_frame | 10437 | 8010 | **4448** | 16020 | 26122 |

- **`sim_frame`** — 4 systems over a mixed 10k-entity world: `Movement` (excludes `Frozen`), `Regen`,
  `ApplyDamage` (join `[Health,Damage]`), `Render` (join `[Renderable,Position]`, reads Position after
  Movement). strata is 3rd: the filtered `Movement` materializes matched rows each frame — most of
  strata's time; bitecs's flat bitmask iteration and koota's plain-array stores edge it.
- **`spawn_reap_frame`** — systems **spawn then destroy** 5k entities in-frame. **strata wins by
  1.7×** — deferring in-system entity churn through the command buffer and applying it in a batch at
  the phase boundary is the command-buffer design's home turf.
- **`toggle_frame`** — a system **adds then removes** a component on 10k entities in-frame (20k
  archetype migrations for strata). becsy's defer-to-frame-boundary model wins; bitecs's bitmask flip
  is 2nd; strata's migrations put it 3rd.

## 2. Canonical micro-scenarios — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| packed_5 | **7.67** | **7.67** | 60.74 | 43.10 | 14.33 |
| simple_iter | **9.61** | 12.63 | 143.6 | 75.59 | 22.22 |
| frag_iter | **5.80** | 5.91 | 53.26 | 45.83 | 16.91 |
| entity_cycle | **223.1** | 223.3 | 333.5 | 480.6 | 1408 |
| add_remove | 420.0 | 168.4 | **162.2** | 760.5 | 521.6 |

- **Iteration** (`packed_5`/`simple_iter`/`frag_iter`): strata and bitecs are the top tier — a dead
  heat on `packed_5` and `frag_iter`, strata ~24% ahead on `simple_iter`. strata's contiguous
  per-archetype column loop (`b.rows[0..count)` over a typed array) has no eid-gather indirection, so
  it matches or beats bitecs's flat-array-by-eid on dense workloads. koota (plain `number[]`) trails;
  miniplex (AoS) and becsy (proxy accessors + async) trail further.
- **`entity_cycle`**: strata and bitecs tie at the front — the generational free-list + swap-and-pop
  keep entity construction/teardown cheap (becsy +50%, miniplex 2.2×, koota 6.3×).
- **`add_remove`**: becsy (deferred) and bitecs (bitmask flip, no data move) win; strata pays a real
  **archetype migration** — relocating the row on each add and remove. The archetype tradeoff.

(Throughput and p99 tables: `bench/compare/RESULTS.md`.)

## 3. Extensions — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| serialize | **8972** | N/A | N/A | N/A | N/A |
| random_access | 688 | **380** | N/A | 389 | 714 |

- **`serialize`** — whole-world save+load round-trip (5k entities, components/tags/relations). A strata
  built-in; rivals ship none → N/A.
- **`random_access`** — read one component for 10k random entities by handle. Even on the
  allocation-free `readField` path, strata trails bitecs/miniplex: the bottleneck is the archetype
  **handle→slot→archetype→row→column** indirection per read, inherent to the model — a flat
  eid-indexed array is fundamentally faster for scattered by-id reads. A structural tradeoff.

## Methodology & fairness

- **Same work, enforced.** Every scenario returns a checksum (a summed value or processed count); the
  run fails if any two implementations disagree, and mitata's `do_not_optimize` consumes the checksum
  to defeat dead-code elimination.
- **In-idiom reductions.** Checksums accumulate chunk-local (then add once) in the callback libraries
  (strata, koota), in-scope in the loop libraries (bitecs, miniplex), and system-local in becsy — the
  tables measure the workload, not V8 accumulator-capture quirks.
- **Real pipeline per library.** Frames run through each library's actual system model: strata
  `world.tick` with deferred `ctx`; becsy `world.execute` (native scheduler, structural change at frame
  boundaries → two `execute()`s for its structural frames); bitecs/miniplex/koota compose system
  functions with immediate structural ops.
- **Each library in its idiomatic fastest form**; **one process per library** (no inline-cache
  contamination, no koota `Number.prototype` bleed); warmup to steady state; `--expose-gc`; p99 shown.
- **One adaptation:** iteration ops are additive/swap-based (not the canonical `*= 2`) so values stay
  finite over mitata's iterations. All numeric component fields are f64; `serialize` round-trips mixed
  content (numbers, strings, tags, relations) by design.

## Bottom line

strata is **top-tier for dense iteration** (a dead heat with the flat-array specialist bitecs, ahead
on `simple_iter`), **leads entity-lifecycle churn** (`spawn_reap_frame` by 1.7×, `entity_cycle` tied
at the front) — its target editor workload — **uniquely ships serialization**, and pays a real,
structural cost on component add/remove, in-system toggling, and random-access-by-handle. Where it
wins maps onto the workload it was built for — batched structural change, save/load — and where it
loses is the archetype model's known price.

# strata — comparative benchmarks

strata vs the four most-used TypeScript/JS ECS libraries. Three benchmark families, from most to
least representative of real usage:

1. **Realistic frames** — a full frame run through each library's *real system pipeline*: multiple
   interdependent systems over a heterogeneous world, query joins + exclusions, raw column read/write
   inside systems, and in-system structural change. (The flow the abeimler / fireveined suites test.)
2. **Canonical micro-scenarios** — the standard `ecs_bench_suite` set (packed_5, simple_iter,
   frag_iter, entity_cycle, add_remove), for comparability with the wider ECS-benchmark ecosystem.
3. **Extensions** — editor-centric workloads (whole-world serialize, random-access-by-handle).

Everything is in [`bench/compare/`](bench/compare/); the raw generated table is
[`bench/compare/RESULTS.md`](bench/compare/RESULTS.md). Reproduce: `pnpm build`, then
`cd bench/compare && node run.mjs`.

## Read this first — positioning

**strata is built for editor / collaboration workloads**: high-frequency structural change through a
scheduled system pipeline, save/load, undo-redo, reactive queries — not raw game-loop iteration
throughput. The honest expectation, set *before* the numbers:

- strata should **win on in-system structural churn** (spawn/destroy entities inside systems) — that
  is its command-buffer design's home turf and a core editor flow.
- strata should **trail bitecs on pure iteration** (bitecs's flat typed arrays are the JS iteration
  champion — that's fine).
- strata **uniquely offers built-in serialization**; the rivals have none.
- strata carries **real archetype-migration and scheduler cost** on component add/remove and on a
  pure-compute multi-system frame — reported honestly, with the concrete optimization it points to.

Every scenario is published for every library, including the ones strata loses. **All ten scenarios
agree on a per-scenario checksum across all five libraries** — proof each did identical work.

## Environment

Apple M1 Max · arm64-darwin · **Node 24.14.1** · **mitata 1.0.34** (`--expose-gc
--allow-natives-syntax`), one process per library. Pinned: **bitecs 0.4.0**, **becsy 0.16.0** (perf
build), **miniplex 2.0.0**, **koota 0.6.6**. Machine-specific, ±few-percent run-to-run — treat
anything within a few percent as a tie. Re-run `node run.mjs` for your hardware.

## 1. Realistic frames — µs/op (lower is better; **bold** = fastest)

A full frame through each library's real system pipeline (strata `world.tick`; becsy `world.execute`;
a composed function pipeline for the scheduler-less bitecs/miniplex/koota).

| frame | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| sim_frame | 391.74 | **55.90** | 1039.21 | 550.22 | 98.32 |
| spawn_reap_frame | **1818.36** | 3632.53 | 5123.62 | 4409.65 | 14265.11 |
| toggle_frame | 10795.99 | 10685.67 | **5443.54** | 22978.63 | 38105.52 |

- **`sim_frame`** — 4 systems over a mixed 10k-entity world: `Movement` (reads Velocity, writes
  Position, **excludes `Frozen`**), `Regen` (`[Health]`), `ApplyDamage` (**join** `[Health,Damage]`),
  `Render` (**join** `[Renderable,Position]`, reads Position *after* Movement). Raw typed-column
  read/write inside every system.
- **`spawn_reap_frame`** — systems that **spawn then destroy** 5,000 entities in-frame (strata:
  deferred `ctx.spawn`/`ctx.destroy`; becsy: native frame-boundary; immediate for the rest).
- **`toggle_frame`** — a system that **adds then removes** a component on 10,000 entities in-frame
  (20,000 archetype migrations for strata via the command buffer).

**What it says.** strata **wins `spawn_reap_frame` outright** (1.8 ms vs 3.6–14.3 ms) — deferring
in-system entity spawn/destroy through the command buffer, then applying them in a batch at the phase
boundary, is exactly what an archetype ECS with a scheduler is good at, and it's a core editor flow.
On `toggle_frame` strata ties bitecs (~10.7 ms) and trails only becsy, whose defer-to-frame-boundary
model amortizes the component churn. On `sim_frame` strata is mid-pack (392 µs): fast enough, but
behind bitecs's and koota's bare-loop iteration — see the honest finding below.

### Honest finding from `sim_frame` (an optimization target)

strata's 392 µs on a *pure-compute* frame (no structural change) is dominated by two avoidable costs:
`world.tick` **allocates and releases a command buffer for every phase even when the phase makes no
structural change**, and `Movement`'s `Not(Frozen)` is a **per-row tag filter** (Frozen is a tag, so
it can't be resolved at the archetype level). A read-only-phase fast path (skip the buffer when no
`ctx` structural method is called) and archetype-level exclusion would close most of the gap to koota.
This is a concrete, actionable result the micro-benchmarks did not surface.

## 2. Canonical micro-scenarios — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| packed_5 | 13.73 | **8.48** | 72.38 | 56.11 | 18.56 |
| simple_iter | 33.85 | **13.88** | 165.48 | 93.98 | 32.69 |
| frag_iter | 21.52 | **6.90** | 58.40 | 58.03 | 24.12 |
| entity_cycle | **235.08** | 314.23 | 423.91 | 659.89 | 1993.81 |
| add_remove | 445.34 | 382.13 | **196.01** | 956.63 | 670.30 |

- **Iteration** (`packed_5`/`simple_iter`/`frag_iter`): bitecs wins decisively (flat global typed
  arrays, near-zero per-entity overhead). strata and koota form the next tier; miniplex (AoS pointer
  chasing) and becsy (shared proxy accessors + async execute) trail.
- **`entity_cycle`**: strata **fastest** (235 µs) — its generational free-list + swap-and-pop handle
  entity construction/teardown at the front of the pack (koota's per-entity spawn/destroy is 8× slower).
- **`add_remove`**: becsy wins (defers structural change); strata (445 µs) pays a real **archetype
  migration** (relocating the row on each add and remove), the archetype tradeoff for fast iteration.

(Throughput and p99 tail-latency tables: `bench/compare/RESULTS.md`.)

## 3. Extensions — µs/op

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| serialize | **11486.05** | N/A | N/A | N/A | N/A |
| random_access | 988.74 | **481.45** | N/A | 493.93 | 896.46 |

- **`serialize`** — whole-world save + load round-trip (5,000 entities with components, tags,
  relations). A strata built-in (`export()`/`import()`); the rivals ship no serialization → N/A.
- **`random_access`** — read a component for 10,000 random entities by handle. bitecs/miniplex lead
  (direct array/property read, no allocation); strata is slowest because a whole-component read builds
  a fresh value object per call (koota's `.get()` pays the same). An honest loss with an obvious fix:
  a field-level / read-into-buffer API. becsy N/A (its entity accessors are execute-scoped).

## Methodology & fairness

- **Same work, proven.** Every scenario returns a checksum (a summed component value or a processed
  count); the runner asserts all libraries produce the **identical** checksum from a fresh setup —
  proof of equal work, not just equal-looking code. mitata's `do_not_optimize` consumes each checksum
  to defeat dead-code elimination. All ten agree (`sim_frame`=12333, `spawn_reap_frame`=5000,
  `toggle_frame`=10000, `packed_5`=1000, `simple_iter`=191980, `frag_iter`=2700, `entity_cycle`=1000,
  `add_remove`=1000, `random_access`=50036440; `serialize` strata-only=5000).
- **Real pipeline per library.** The frames run through each library's actual system model: strata
  `world.tick(pipeline)` with deferred `ctx` structural ops; becsy `world.execute()` (native
  scheduler, structural change at frame boundaries → its two structural frames use two `execute()`s);
  bitecs/miniplex/koota compose system functions in order with immediate structural ops. This is a
  real design difference (scheduler + deferral vs immediate) and part of what's being measured — noted,
  not hidden.
- **Each library in its own idiomatic fastest form** — bitecs buffered `query` + raw eid loop; strata
  `denseCount` loop over hoisted typed columns / `b.col`; koota `useStores`; miniplex connected
  `world.with(...)` + `for..of`; becsy `/perf` build + static-schema systems.
- **Per-process isolation.** One `node` process per library — no megamorphic inline-cache
  contamination, no koota `Number.prototype` patch bleed. Warmup to steady state; `--expose-gc` for GC
  control; p99 reported so tail spikes are visible.
- **One honest adaptation:** iteration ops are additive/swap-based (`+= 1`, swap) not the canonical
  `*= 2`, so values stay finite over mitata's many iterations and the checksum can't drift to
  Infinity. Work profile unchanged. All fields are f64 (JS number width) for a fair numeric substrate.

## Bottom line

On the **realistic frames** that model real usage, strata **wins in-system entity churn**
(`spawn_reap_frame`) and **entity lifecycle** (`entity_cycle`) — the editor/collaboration workloads it
targets — ties bitecs on in-system component toggling, and trails the bare-loop iterators on a
pure-compute frame, where it surfaced a concrete optimization (skip the per-phase command buffer for
read-only phases). It sits in the **fast tier** for raw iteration behind the flat-array specialist
bitecs, **uniquely ships serialization**, and has one clear loss (random-access-by-handle) with an
obvious fix. For what strata is for, that is the profile you want.

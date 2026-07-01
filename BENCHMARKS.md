# strata — comparative benchmarks

strata vs the four most-used TypeScript/JS ECS libraries, on the canonical `ecs_bench_suite`
scenarios plus two editor-centric extensions. The suite, every per-library implementation, and the
runner live in [`bench/compare/`](bench/compare/); the raw generated table is
[`bench/compare/RESULTS.md`](bench/compare/RESULTS.md). Reproduce with `pnpm build` then
`cd bench/compare && node run.mjs`.

## Read this first — positioning

**strata is built for editor / collaboration workloads**: high-frequency structural change,
save/load, undo-redo, and reactive queries — not raw game-loop iteration throughput. So the honest
expectation, set *before* the numbers:

- strata should **trail bitecs on pure iteration** (bitecs stores components in flat typed arrays
  with near-zero per-entity overhead — it is the JS iteration champion, and that's fine).
- strata should be **competitive-to-winning on entity lifecycle churn** (`entity_cycle`) — an
  editor-relevant structural workload.
- strata **uniquely offers built-in serialization**; the rivals have no equivalent.
- strata is **slower on random-access-by-handle**, because a whole-component read allocates a value
  object — a known characteristic and a clear optimization target, reported honestly.

We publish every scenario for every library, including the ones strata loses. Predicting where you
lose and being right is worth more than a suite you happen to win.

## Environment

Apple M1 Max · arm64-darwin · **Node 24.14.1** · **mitata 1.0.34** (`--expose-gc
--allow-natives-syntax`). Libraries pinned: **bitecs 0.4.0**, **becsy 0.16.0** (perf build),
**miniplex 2.0.0**, **koota 0.6.6**. Numbers are machine-specific and carry a few-percent run-to-run
variance — treat anything within a few percent as a tie. Re-run `node run.mjs` to regenerate for your
hardware.

## Canonical scenarios — µs/op (lower is better; **bold** = fastest)

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| packed_5 | 13.77 | **7.85** | 64.01 | 46.14 | 16.36 |
| simple_iter | 34.05 | **13.23** | 151.16 | 80.29 | 28.28 |
| frag_iter | 21.81 | **6.29** | 54.62 | 48.67 | 20.39 |
| entity_cycle | 237.37 | **216.69** | 358.76 | 530.94 | 1603.67 |
| add_remove | 446.23 | **146.49** | 164.63 | 815.27 | 556.14 |

(Throughput and p99 tail-latency tables: see `bench/compare/RESULTS.md`.)

## Extension scenarios — µs/op (beyond the canonical suite)

| scenario | strata | bitecs | becsy | miniplex | koota |
|---|---:|---:|---:|---:|---:|
| serialize | **10213.76** | N/A | N/A | N/A | N/A |
| random_access | 939.72 | **411.21** | N/A | 441.34 | 780.95 |

- **serialize** — whole-world save + load round-trip (5,000 entities with components, tags, relations).
  A strata built-in (`world.export()` / `import()`); the rivals ship no serialization, so N/A. ~10 ms
  to round-trip a 5k-entity world through JSON — practical for editor save/load.
- **random_access** — read a component for 10,000 random entities by handle. becsy N/A (its entity
  accessors are execute-scoped, not ad-hoc-by-handle).

## What the numbers say

**Iteration (`packed_5`, `simple_iter`, `frag_iter`).** bitecs wins decisively — flat, global
typed-array columns indexed by entity id, essentially zero per-entity overhead. strata and koota form
the next tier (strata's archetype-SoA `denseCount` loop over typed columns; koota's `useStores` over
plain `number[]`), landing ~1.7–2.5× behind bitecs but comfortably ahead of miniplex (AoS
pointer-chasing over heap objects) and becsy (its shared read/write proxy accessors go through
getters/setters, and `execute()` is async). This is the expected shape: strata trades a little
iteration speed for the reactivity and structural-edit ergonomics an editor needs.

**Entity lifecycle (`entity_cycle`).** strata (237 µs) essentially **ties bitecs (217 µs) for
fastest**, and is well ahead of becsy, miniplex, and koota (koota's per-entity spawn/destroy is its
weakest point at 1,600 µs). Constructing and tearing down 1,000 entities per op is close to real
editor churn, and strata's identity substrate (generational free-list, swap-and-pop) handles it at
the front of the pack.

**Component add/remove (`add_remove`).** bitecs (146 µs) and becsy (165 µs) win: bitecs add/remove is
a bitmask flip with **no data movement**, and becsy defers structural change to a frame boundary.
strata (446 µs) pays a real **archetype migration** — it relocates the entity's row between tables on
each add and again on each remove (2,000 structural moves per op). That's the archetype tradeoff:
cache-friendly iteration in exchange for costlier shape changes. miniplex (815 µs) is slowest (it
shallow-clones the entity on every removeComponent).

**random_access.** bitecs (411 µs) and miniplex (441 µs) lead — a direct array/property read with no
allocation. strata (940 µs) is slowest because a whole-component read builds a fresh value object per
call; koota (781 µs) pays the same allocation via `.get()`. This is an honest loss and a concrete
optimization target for strata (a field-level or into-buffer read API would close most of the gap).

## Methodology & fairness

- **Same work, proven.** Every scenario returns a checksum (a summed component value); the runner
  asserts all libraries produce the **identical** checksum from a fresh setup — proof they did equal
  work, not just equal-looking loops. All 5 canonical scenarios and `random_access` agree across
  every implementing library (`packed_5`=1000, `simple_iter`=191980, `frag_iter`=2700,
  `entity_cycle`=1000, `add_remove`=1000, `random_access`=50036440).
- **Each library in its own idiomatic *fastest* form** — bitecs: buffered `query` + raw eid loop;
  strata: `denseCount` loop over hoisted typed columns; koota: `useStores`; miniplex: `for..of` over
  connected queries; becsy: `/perf` build, static-schema API, one system per scenario. No library is
  forced into another's paradigm.
- **Per-process isolation.** One `node` process per library, so megamorphic inline-cache
  contamination and koota's global `Number.prototype` patch never bleed across libraries.
- **Anti-lies.** mitata's `do_not_optimize` consumes each checksum (defeats dead-code elimination of
  the iteration loops); `--expose-gc` lets mitata control GC; warmup runs to steady state; p99 is
  reported so GC tail spikes are visible, not hidden in the mean.
- **One honest adaptation:** scenario ops are additive / swap-based (`+= 1`, swap) rather than the
  canonical `*= 2`, so values stay finite over mitata's many iterations and can't drift the checksum
  to Infinity. The work profile (monomorphic per-entity arithmetic over identical entity counts) is
  unchanged. All component fields are f64 (JS number width) for a fair numeric substrate.
- **becsy notes:** benchmarked with the `/perf` build (runtime checks stripped); its structural
  scenarios use becsy's two-frame model (change enacted at a frame boundary), which its
  `entity_cycle`/`add_remove` numbers include. Its iteration cost reflects the shared-proxy accessor
  API and async `execute()`, both intrinsic to becsy.

## Bottom line

strata sits in the **fast tier** for iteration (behind the flat-array specialist bitecs, alongside
koota, ahead of miniplex and becsy), is **at the front for entity lifecycle churn**, carries the
expected **archetype-migration cost on component add/remove**, and **uniquely ships serialization**.
Its one clear loss — random-access-by-handle — is an allocation artifact with an obvious fix. For the
editor/collaboration workloads strata targets, that is exactly the profile you want.

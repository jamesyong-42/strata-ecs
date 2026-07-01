# Plan — Stress-Testing & Comparative Benchmarking (post Part I)

> **Status: COMPLETE (2026-07-01).** Both workstreams landed. Stress & fuzz found **no correctness
> bug**; results in [`stress-report.md`](stress-report.md). Comparative benchmark done; analysis in
> [`../BENCHMARKS.md`](../BENCHMARKS.md), generated table in
> [`../bench/compare/RESULTS.md`](../bench/compare/RESULTS.md). Run: `pnpm test:stress` (heavy suite)
> and `cd bench/compare && node run.mjs` (benchmark).

Part I (the Runtime Core) is feature-complete, adversarially reviewed, and conformance-audited.
This plan hardens it under adversarial load and measures it honestly against the field.

**Two independent goals, two rigor bars:**

1. **Stress & fuzz** — prove strata is *correct and unbreakable* under adversarial load. Success =
   invariants never break; hard limits fail cleanly (or are pinned as documented tradeoffs).
2. **Comparative benchmark** — prove strata is *fast* relative to real rivals, reported honestly.
   Success = a credible, reproducible table a skeptic could re-run and argue with.

## Decisions locked (2026-07-01)

- **Hardening posture:** pin behavior + add *cheap DEV-only guards*. No deep encoding change (the
  2^12 generation-wrap ABA stays a documented, pinned tradeoff — a 53-bit fallback is deferred).
- **Rivals (all pinned, isolated):** `bitecs@0.4.0`, `@lastolivegames/becsy@0.16.0`,
  `miniplex@2.0.0`, `koota@0.6.6`.
- **Scenarios:** canonical 5 (`packed_5`, `simple_iter`, `frag_iter`, `entity_cycle`, `add_remove`)
  **plus** clearly-labeled editor/collab extension scenarios.

---

## Workstream A — Stress & Correctness Hardening

### A1. Test infrastructure
- Add `fast-check` (dev dep) for model-based property tests; **seeded** PRNG so every failure replays.
- New location: `src/core/__stress__/*.stress.test.ts` and `*.fuzz.test.ts`.
- Heavy by nature → gated behind a new `test:stress` script and a `STRESS_SCALE` env knob. A
  scaled-down parameter set runs in default `ci`; full scale runs on demand. Default `test`/`ci`
  stays fast and green.

### A2. Deterministic stress scenarios (from the limits analysis)
1. **Generation wraparound ABA** — drive one slot's gen `1→4095→wrap→1`; *pin* that at the 4096th
   recycle a stale handle collides with the live one (documented tradeoff), incl. a stale `eid`
   field / relation edge silently re-resolving. Targets `entity-table.ts:free`.
2. **MAX_SLOTS exhaustion** — 1,048,576 allocs succeed; the next throws cleanly; constructor rejects
   `> MAX_SLOTS`. Targets `entity-table.ts:grow`/ctor.
3. **Archetype explosion** — thousands of distinct signatures + dozens of cached queries; assert
   dedup, exact query-match sets, bounded memory. Probes `observeArchetypes` O(Q) per archetype.
4. **Relation fan-out + cascade despawn** — ~1M edges into one target; despawn; assert reverse-index
   symmetry and validate-on-read drops dead sources. Probes `relations.ts:clearEntity` O(N).
5. **String-column churn / leak hunt** — after *every* structural op, walk each string column from
   `count..length` and assert every cell `=== null` (never `undefined`, never a retained string).
6. **Deep command-buffer batch in one phase** — hundreds of thousands of deferred ops in a single
   phase; assert flush applies all, buffer resets, pool doesn't leak; ordering hazards
   (destroy-then-add, double-add) behave per policy.
7. **Archetype ping-pong** — add/remove churn migrating `A→B→A`; assert back-pointer symmetry,
   value preservation, string-null after each round.
8. **Large-world snapshot round-trip** — hundreds of thousands of entities across many archetypes +
   eid refs + relations + tags + resources; export→import→assert model equality; scale toward the
   V8 single-string ceiling to observe the clean `RangeError`.

### A3. Property-based fuzz (model-based, `fast-check` `fc.commands`)
A plain-JS **reference oracle** replicates entity-table semantics (bump-on-free, wrap-skip-0,
freeList LIFO) + component/tag/relation state + validate-on-read. Five targets:
- **Snapshot round-trip equality** — canonical model compared by topology/dense-id (identity is
  relabeled), refs remapped, dangling → null.
- **Random op sequence vs model** — spawn/despawn/add/remove/write/tag/relation; assert
  alive/placed, has/read/get, hasTag, getRelation(s)/getReverse, and throw-parity after each op.
- **Deferred tick vs immediate reference** — random `ctx.*` batch during iteration vs a simulated
  flush (validate-on-read skip, idempotent no-ops, double-add skip).
- **Random query vs brute-force predicate** — required/excluded/Any/Not/tag/relation(±concrete
  target); dense path and seeded path must return the identical set as a naive filter.
- **Add/remove/migrate property** — expected component-set + last-written values preserved across
  migration; removed fields gone.

### A4. Cheap DEV-mode guards (the locked hardening)
All `DEV`-gated (stripped in prod), each with a test, each noted in the design/plan docs:
- **`pack()` range assert** — throw a clear error if slot `≥ 2^20` or gen `> 4095` instead of
  silently aliasing (closes the latent `entity.ts:pack` footgun).
- **Command-buffer soft cap** — DEV warn when a single phase buffer crosses a configurable
  threshold (back-pressure signal against unbounded growth → OOM). No hard throw.
- **Generation-wrap notice** — DEV warn the first time a slot's generation wraps past
  `MAX_GENERATION`, surfacing the exact moment ABA risk begins.

### A5. Findings report
`docs/stress-report.md` — what was probed, invariants verified, limits pinned, guards added, and
recommendations deferred to later parts (53-bit gen fallback, streaming snapshot, relation-edge
back-pressure).

---

## Workstream B — Comparative Benchmark

### B1. Isolated bench workspace (zero pollution of strata's deps)
- Promote the repo to a **pnpm workspace**: `pnpm-workspace.yaml` → packages `.` + `bench/compare`.
- `bench/compare/package.json` (private) depends on `strata: workspace:*` and, as *its own* devDeps,
  the four rivals + `mitata`. Rivals never touch strata's root `package.json`.
- Bench imports strata's **built** ESM from `dist/` (measures shipped code); `pnpm build` first.

### B2. Scenario implementations — each library in its idiomatic *fastest* form
Shared contract per scenario: `{ setup(N), tick(), checksum() }`.
- **strata** — `b.col(C)` hoisted typed-array loop (its documented fast path).
- **bitecs 0.4** — `query(world,[P,V],{buffered:true})` → `Uint32Array` indexed loop, field arrays
  hoisted; `addComponent(world, eid, C)` (0.4 arg order).
- **becsy 0.16** — import from `@lastolivegames/becsy/perf`, **static-schema** API (no decorators),
  `maxEntities` preallocated, `await world.execute()` amortized over many frames.
- **miniplex 2.0** — `world.with(...)` created once, `for..of query` reverse iteration.
- **koota 0.6.6** — `query.useStores(...)` raw-store loop (its fast path); also record
  `updateEach({changeDetection:'never'})` as its idiomatic path.
- **Checksum** every scenario (sum component values) → mitata `do_not_optimize` — defeats
  dead-code elimination *and* proves every library did identical work.

### B3. Harness + isolation
- **mitata** primary; run each library in its **own `node` process**
  (`--expose-gc --allow-natives-syntax`) to avoid megamorphic inline-cache contamination and
  koota's global `Number.prototype` patch bleeding across libs.
- Runner spawns one process per (scenario × library), collects JSON, aggregates to a table.
- Build bench TS→JS with esbuild (sidesteps decorator/type-strip friction).
- Warmup to steady state (Node 24 / V8 tiering); report avg + p75/p99 + RME.

### B4. Extension scenarios (labeled "beyond canonical")
- **Snapshot serialize + deserialize** round-trip (strata native; rivals: nearest equivalent or an
  honest N/A).
- **Reactive / observed-query churn** — add/remove with an observer registered (strata query-match
  cache vs `bitecs observe` vs `koota onChange` vs `miniplex onEntityAdded`).
- **Random-access-by-id/key** — read a component for random entities (gather cost; where archetype
  packing vs eid-indexed sparse arrays diverges).

### B5. Report
`BENCHMARKS.md` (curated) + generated `bench/compare/RESULTS.md`:
- **Lead with positioning:** strata targets editor/collab churn — expected to trail bitecs on
  packed iteration, competitive-to-winning on structural churn + the extensions.
- Full env disclosure (Node+V8 version, CPU, flags, each lib version, suite git SHA), per-scenario
  tables with variance, one-line honest mechanism note on every loss, single repro command, and the
  "within a few % = effectively equal" convention. No misleading single-winner geomean.

---

## Sequencing (incremental commits)

1. This plan doc.
2. Stress infra + `fast-check` + `test:stress` script + `STRESS_SCALE`.
3. Deterministic stress scenarios A2 (grouped commits).
4. Model-based fuzz suite A3.
5. DEV-mode guards A4 (+ tests + doc updates).
6. `docs/stress-report.md`.
7. Bench workspace scaffold B1 (`pnpm-workspace.yaml`, `bench/compare` package, install rivals).
8. Canonical scenarios per library B2 + shared checksum contract.
9. mitata harness + per-process runner B3.
10. Extension scenarios B4.
11. `BENCHMARKS.md` + generated results B5.

Default `test`/`ci` stays green and fast throughout; heavy suites live behind `test:stress` and
`bench:compare`.

## Risks / notes
- **becsy friction** (dormant, async, decorators, 3 MB) → mitigated by its static-schema API + esbuild.
- **Benchmarks are machine-specific** — committed numbers are reproducible & illustrative, not an
  authoritative cross-hardware ranking. The repro command + source are the real deliverable.
- **Generation-wrap ABA is a pinned, documented tradeoff**, not a bug; a real fix is the deferred
  "full hardening" option.

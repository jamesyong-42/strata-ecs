# bench/compare — cross-library ECS benchmark

Isolated pnpm workspace member. Benchmarks **strata** against **bitecs**, **becsy**, **miniplex**,
and **koota** across three families: **realistic frames** (a full frame through each library's real
system pipeline — multiple systems, mixed world, in-system structural change), the canonical
`ecs_bench_suite` **micro-scenarios**, and editor-centric **extensions**. The rival libraries live
only in this package's `devDependencies`, so strata's own dependency graph stays clean.

## Run

```sh
pnpm build                    # from repo root — bench imports strata's built dist
cd bench/compare
node run.mjs                  # spawns one process per library; writes RESULTS.md, results.json, report.html
open report.html              # a self-contained visual report (charts) — no build, no CDN
```

`node run.mjs` emits three artifacts: `RESULTS.md` (the raw table), `results.json` (structured data),
and **`report.html`** — a dependency-free page with per-scenario bar charts. Regenerate just the page
from existing data with `node report.mjs`.

Requires Node ≥ 24 (native TS type-stripping; mitata needs `--expose-gc --allow-natives-syntax`,
which `run.mjs` passes).

## Layout

- `contract.ts` — the `Scenario` / `LibraryBench` interface, canonical entity counts, and the shared
  `random_access` access pattern (so every library reads the same sequence → checksum parity).
- `scenarios/<lib>.ts` — each library's implementation, in its own idiomatic *fastest* form.
- `harness.ts` — one library per `node` process; runs mitata; emits a `BENCH_JSON:` line.
- `run.mjs` — spawns a process per library, checks checksum parity, writes `RESULTS.md`.

## Trust

Every scenario returns a checksum (a summed component value). The runner asserts all libraries
produce the **identical** checksum from a fresh setup — proof of equal work, and mitata's
`do_not_optimize` consumes it to defeat dead-code elimination. Curated analysis and full methodology:
[`../../BENCHMARKS.md`](../../BENCHMARKS.md).

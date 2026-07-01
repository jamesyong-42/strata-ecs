# bench/compare — cross-library ECS benchmark

Isolated pnpm workspace member. Benchmarks **strata** against **bitecs**, **becsy**, **miniplex**,
and **koota** on the canonical `ecs_bench_suite` scenarios plus two editor-centric extensions. The
rival libraries live only in this package's `devDependencies`, so strata's own dependency graph
stays clean.

## Run

```sh
pnpm build                    # from repo root — bench imports strata's built dist
cd bench/compare
node run.mjs                  # spawns one process per library; writes RESULTS.md
```

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

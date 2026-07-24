# bench/sync — the sync-path benchmark

What a peer pays to **apply a remote edit**, as the document grows.

The cross-library suite (`../compare`) measures the ECS hot loop — iteration, spawn, migration. This
one measures the **durable sync seam**, where the question is not "how fast" but a growth law:

> When another peer edits one cell, does the receiving peer's cost depend on the size of the
> **edit**, or on the size of the **whole document**?

A collaborative app dies on the second answer, not on a constant factor. The delta under test is a
fixed ~115 bytes regardless of document size, so an O(delta) implementation costs the same at 25,000
entities as at 1,000. Anything that tracks document size means every keystroke from every other peer
gets more expensive as the document grows.

```sh
pnpm bench:sync                          # from the repo root
node run.mjs                             # from here
node run.mjs --sizes 1000,10000 --reps 3 # quicker sweep
```

Outputs `RESULTS.md` (tables) and `results.json` (structured). Both are **committed**, matching
`../compare` — a results file records the loro version and the machine load that produced it, so it
is evidence, not just output. The curated narrative belongs in `../../BENCHMARKS.md`.

## One process per cell — and why that is not optional

Each `(variant × n)` pair runs in a **fresh node process** (`cell.mjs`), spawned by `run.mjs`.

This is not tidiness. An earlier ad-hoc probe of this exact workload reported **4 ms or 128 ms for
the same scenario at the same document size** — reproducibly, several runs each — depending only on
whether a *smaller* document had been processed earlier in the same process. Warming loro's wasm
heap on a 4,000-entity document made a subsequent 10,000-entity measurement look ~30x faster than
the same measurement taken cold.

A harness that sweeps sizes in one process therefore measures its own iteration order rather than
the workload. Every cell gets its own process, and within a cell the **cold rep is reported
separately from the warm ones** instead of being averaged together — process-state dependence
becomes a reported dimension instead of a silent bias.

This repo has twice published numbers later found to be measurement artifacts (a stale `yes` busy
loop inflating every library ~3-6x; per-ingredient attribution splits that moved by 10x across
runs). The `cold`/`warm`/`spread` columns exist so that class of error is visible in the output.

## Variants

| variant | what it measures |
|---|---|
| `bootstrap` | a fresh joiner importing the whole room — the one-time join cost. **Expected** to scale with document size. |
| `steady_pristine` | a receiver holding the room, with no local edits, applying one small remote edit. |
| `steady_local` | …and which has made **its own** edit first — the real collaborative case, where both peers are editing. |
| `bare_loro` | floor: plain `LoroDoc.import` of the same delta, no strata in the path. Separates "loro applying ops" from "strata reconstructing what changed". |

`steady_local` is the one that matters for production. Two peers editing the same board is the
normal case, not an edge case — `steady_pristine` describes a passive viewer.

## Reading the output

The **growth law** table is the verdict. For `steady_*`, the cost ratio between two sizes should be
**1.00x** (the edit is the same size at both). A cost ratio tracking the size ratio means O(document).

`bootstrap` is exempt — it genuinely does more work on a bigger document, so linear is correct there
and *super*-linear is the failure mode.

## Comparing loro versions

Change the **root** pin, not this package's:

```sh
pnpm add -w -D loro-crdt@<version>   # from the repo root
pnpm bench:sync
```

This package deliberately declares **no** `loro-crdt` dependency of its own. `loro-crdt` is a wasm
module with instance-identity checks, and strata's `dist` resolves its optional peer import from the
package's own location — so a second copy installed here would produce a *different* `LoroDoc` class,
and every call handing a doc across the seam dies with `expected instance of LoroDoc`. (That is not
hypothetical: the first version of this harness did exactly that, and every cell failed.)

`cell.mjs` therefore resolves loro **through strata's own resolution**, which guarantees one instance
and makes the version reported in `RESULTS.md` the one genuinely under test rather than the one this
directory happens to have. In a real consumer install the peer resolves to the consumer's copy, which
is the behaviour this mirrors.

## Machine hygiene

`run.mjs` records the 1-minute load average and flags the run when load exceeds half the core count.
**Absolute milliseconds from a loaded machine are indicative only.** The growth law survives load far
better than absolutes do — uniform slowdown cancels in a ratio — but before any number here goes into
published docs, re-run it on a quiet machine and check `ps aux` first.

## Convergence check

Every rep asserts the remote edit is actually readable from the receiver's document afterwards,
reading the raw LoroDoc rather than the code under test. A benchmark that silently timed a dropped
import would be worse than no benchmark; a failed check exits non-zero.

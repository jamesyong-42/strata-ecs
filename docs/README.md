# docs/ — the map

`design.md` is the **locked v0 baseline** (its § numbering never changes). Everything else is a
numbered amendment note or a working document layered on top; where a note conflicts with the
baseline, the note wins.

## The spec chain

| Doc | What it is | Status |
|---|---|---|
| [design.md](design.md) | The full four-part specification (Runtime Core · Storage Substrate · Durable · Ephemeral) — locked baseline | LOCKED |
| [001-system-access-declaration.md](001-system-access-declaration.md) | `SystemAccess {write, read}` on `defineSystem`, accessor-level DEV enforcement, pipeline diagnostics | IMPLEMENTED |
| [002-reactivity.md](002-reactivity.md) | `world.reactive` — poll-at-boundary stamps, the three observer tiers, `notify()`, the `reactiveOn` gate | IMPLEMENTED |
| [003-resource-reactivity-and-react.md](003-resource-reactivity-and-react.md) | Per-resource stamps, `observeResource`, the `strata-ecs/react` binding (`useComponent`/`useResource`) | IMPLEMENTED |
| [004-part2-4-revision.md](004-part2-4-revision.md) | The Parts II–IV revision plan — adjudicates [design-comments.md](design-comments.md), red-teamed | PLAN (executed by 005/006) |
| [005-part2-spec.md](005-part2-spec.md) | The normative Part II spec — **supersedes design.md §9–§10 + Part II API reference** | NORMATIVE, **IMPLEMENTED** (M1–M4 + review fixes; as-built amendments in its §10) |
| [006-part3-4-amendments.md](006-part3-4-amendments.md) | Normative Parts III–IV amendments + two Part I addenda (mid-tick guard; 002 §0/§6 rewording) | NORMATIVE; the §A4 guard + Part II pieces are IMPLEMENTED (as-built addendum in §A4), Parts III–IV pending |

## Reviews, plans, reports

| Doc | What it is |
|---|---|
| [review-part1.md](review-part1.md) | The adversarially-verified honest Part I review — post-verification severities, R1–R4 fixed on main, refuted claims recorded |
| [design-comments.md](design-comments.md) | The external design review of Parts II–IV that 004 adjudicates |
| [plan-part1.md](plan-part1.md) | Part I build plan (M0–M7, complete) + deferred type-level follow-ups |
| [plan-part3.md](plan-part3.md) | Part III build plan (M0–M5, **IMPLEMENTED** — the durable layer ships; as-built amendments in 005 §10 + 006 addenda) |
| [plan-example-canvas.md](plan-example-canvas.md) | The canvas-editor example plan (implemented) |
| [plan-tools-observer.md](plan-tools-observer.md) | The `strata-ecs/tools` observer panel plan (implemented; T0 observability spec lives here) |
| [plan-stress-bench.md](plan-stress-bench.md) | Stress/fuzz + benchmark plan |
| [stress-report.md](stress-report.md) | Stress & fuzz findings (no correctness bug; pinned limits) |
| [perf-hotpath.md](perf-hotpath.md) | The hot-path perf pass — corrected attributions, landed changes, the chunk-local reduction idiom |
| [../BENCHMARKS.md](../BENCHMARKS.md) | Comparative benchmark vs bitecs/koota/becsy/miniplex |

## Where Part I's API has moved past the baseline

All deliberate, per review-part1.md: schema-literal type inference (`defineComponent` infers from
the literal; typed `col()`; typed `spawn`), `readEid` deleted (typed name-keyed `readField`
subsumes it), `defineRelation`'s dead `ordered` option removed (006 §B1 order keys replace it),
`world.reset()` / `world.import(bytes, {replace: true})` added (the world-swap pattern is dead),
and the published name is **`strata-ecs`**.

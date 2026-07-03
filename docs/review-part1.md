# Part I — Honest Design Review (2026-07-03)

**Method.** 7 review dimensions (API surface, internal architecture, reactivity model, types/DX,
tests, packaging, example-as-mirror), each reviewed independently, then every critical/high finding
adversarially verified (criticals by two independent refuters). Severities below are
**post-verification** — several headline claims were killed or downgraded, and that is recorded here
so we never relitigate them.

**Verdict.** The core is genuinely strong: the immediate `world.*` vs deferred `ctx.*` split, the
reactive tier ladder with its `reactiveOn` gate, the docs-per-decision discipline, and the physical
primitives all survived adversarial review untouched. The debt is concentrated in exactly one place:
**the type system stops at the schema boundary.** Everything else is medium-grade polish. The three
structural items (type inference, export-seam narrowing, world lifecycle) share one property — they
are cheap now and near-impossible after the first external user — which is what makes them the
pre-Part-II work.

---

## Tier 1 — fix before Part II (structural, breaking-change-shaped)

### R1. Schema-literal type inference (the dominant finding — flagged independently by 3 dimensions)

`defineComponent<S>(name, schema)` never links `S` to the schema literal. Verified by independent
tsc probes (twice): `defineComponent<{x: number}>("Lying", { totallyDifferent: "string" })` compiles
clean; with no explicit `S`, reads are `unknown`; wrong-typed spawn values silently become `NaN`
(`value as number`, field.ts:257). Consequences as shipped:

- every component's type is declared **twice** (example: ecs/schema.ts:30–88), free to drift;
- `col()` returns `Record<string, Column>` — the flagship example carries **42** `as Float32Array`
  casts; field typos compile;
- `SpawnInit` erases the Component↔value pairing — `spawn` is the *least* checked write path;
- `readField<T>(e, c, "name")` is a blind cast beside `readEid(e, c, FieldId)` — two keying
  conventions for one concept.

design.md **already specs the inferred form** (`col<S>: ColumnsOf<S>`, "each value is checked
against its component's field type") — this is spec-conformance, not redesign.

**Fix (one coordinated pass, before Part II so `strata-ecs/durable`'s define surface inherits it):**
- `defineComponent<const Sch>(name, schema: Sch): Component<ValueOf<Sch>>` — Component must carry
  the **schema literal** (the value type alone cannot distinguish f32/f64/string columns);
- `ColumnsOf<Sch>` so `col()` needs zero casts; `enumOf`/`field()` become generic over their
  literals (both overloads of enumOf); decide `"string"` nullability deliberately;
- spawn tuples via `readonly [Component<T[K]>, NoInfer<T[K]>]` (verified: the naive mapped-variadic
  form does NOT work — it unions both positions; `NoInfer` requires consumers on TS ≥ 5.4) or an
  `entry(c, v)` helper as fallback;
- `readField` keyed by `keyof S`, return type from schema; delete public `readEid` (subsumed).

### R2. The export seam is wider than the design (before first publish)

`index.ts` exports the concrete `RuntimeStore` class (~40 methods incl. `enableReactive`,
`stampWrites`, `beginSystemAccess`…), the concrete `SystemCtx` class, and `Query`'s compiled plan
fields. design.md specs the seam as ECSStore + four projection primitives. Internals are already
JSDoc-`@internal` — the gap is enforcement: **tsup lacks `stripInternal`**, so dist ships them all.

**Fix:** `stripInternal: true` (one line), export `SystemCtx` as type-only, narrow the exported
store type to the spec'd interface, brand `Query` (only reactive.ts + access-diagnostics.ts read
plan fields outside core). Verified: nothing in-repo imports the concrete classes from the barrel.

### R3. World lifecycle: the worldRef swap is the framework's biggest missing affordance

`world.import()` requires an empty world, so every restore forces a world **swap**: the example
needed a worldRef indirection (50 refs across 13 files), an onRestore re-subscription registry, and
it documents the nastiest hazard itself — both worlds mint the same slot/gen sequence, so a stale
pre-swap handle **silently aliases** a restored entity (not detectably dead — aliased). Verified
against entity-table.ts: fresh worlds deterministically mint identical handles.

**Fix:** `world.reset()` (or `import(bytes, { replace: true })`) that clears in place **keeping the
world identity**: free every slot with a generation bump (stale handles then read dead — strictly
safer than the alias), keep observer attachments, fire an explicit reset signal for re-subscription.
This is also a **consistency** argument: design.md Part III already commits to attach/detach on a
persistent world with in-place teardown (§13.1, §2811) — Part I's import-into-empty is the odd
second mechanism. Decide before Part III so document-open has one answer, not two.

### R4. `strata` is taken on npm

`strata@0.20.1` (abandoned 2012 HTTP server) blocks publish; disputes for legitimate historical
packages essentially never succeed — don't bother. `strata-ecs` is free and design.md's own title.
Rename cost is one grep-commit today (package name, README, docs 001–003, example imports +
workspace dep + `example:canvas` filter, vite alias regexes) and compounds with every doc written.

## Tier 2 — high-value, non-breaking

### R5. Reactivity scalability (both verified, downgraded high→medium — constant-factor, not asymptotic)

- **Stamp amplification:** the finest stamp is (archetype, component); `stampWrites` blanket-stamps
  a declared writer's whole write set across matching archetypes every tick it runs, wrote or not.
  Tier-3 pays decode+eq per watched cell per dirty frame (equality suppresses the *fire*, not the
  *read*). Realistic exposure: `useComponent`-per-shape at 10k scale. Fixes: chunk-granular stamps
  belong in **Part II's storage layout** (the natural moment); the deferred `colW` accessor stops
  blanket-stamping; state the amplification honestly in 002 §3.2.
- **No quiescent fast path in notify():** `[...keys]`/`[...m]`/`[...arr]` spreads run before the
  stamp compare can skip. Fix: per-component max-frame array for a one-compare skip (**must also
  bump on removal/migrate** or removal notifications are dropped — verifier catch), and
  allocation-free clean paths. The example calls notify() every rAF, so idle cost is real.

### R6. Stamp-site duplication (verified, scoped down by verifier)

Five `applyCommand` tag/relation arms hand-copy substore-write + `bumpTagRel`, and
`projectComponent`'s overwrite branch duplicates `writeComponent`'s cell loop + stamp (~25–30
lines). 4 of the 5 flush arms' bumps are untested. Collapse into private stamp-owning primitives
(`doAddTag`, `doSetRelation`, `doWriteCells`); leave component ops and migrate alone — they already
ARE single stamp-owning primitives. Zero perf cost (gates live inside the bump fns).

### R7. Test-suite gaps (verified)

- **The fuzz oracle predates reactivity entirely** — and because of the `reactiveOn` gate, the
  existing fuzz never even *executes* stamp-maintenance code (zero execution, not just zero
  assertions). Extend the op alphabet with {notify, observeValue, observeQuery, unobserve} + an
  armed-from-op-0 variant; oracle = recompute watched values from the reference model
  (reuse the layer's own shallowEqual, compare against last-FIRED value).
- **strata-ecs/tools is ~90% untested** (only recorder.ts). dispose() looks leak-free on inspection but
  nothing pins the 5-part teardown. happy-dom smoke suite: attach → tick → render → dispose →
  assert interval cleared + BOTH roster entries detached + DOM removed → re-attach to second world.
- Also worth adding: 001 enforcement matrix (accessor × declared × armed × in-system — pins the
  read-path exemption as intended), StrictMode double-mount + removeComponent-non-death for
  strata-ecs/react, `STRESS_SCALE=0.1` smoke in ci so the fuzz tier can't rot unrun.

### R8. Docs/packaging coherence

- **Spec fragmentation** (verified): design.md contains zero pointers to 001–003/T0. Fix without
  breaking the "locked" contract: non-normative amendments front-matter + a docs index; promote the
  T0/tools spec to a numbered note; Part II ships as a numbered spec stating what it supersedes.
- **Vacuous-typecheck trap** (verified): structural fix is `tsconfig.base.json` holding ONLY
  compilerOptions; sub-projects extend the base, never the root. (Verifier nuance: the failure mode
  is sneakier than "empty program" — the program stays non-empty via ../core while the project's own
  files vanish; any tripwire must assert own-directory files.)
- Publish hygiene: no LICENSE file despite MIT declaration; no repository/keywords; drop
  `engines.node>=24` from the published manifest (dev-only requirement — .nvmrc covers it); make the
  empty `strata-ecs/durable`/`strata-ecs/ephemeral` placeholders throw a loud "ships in Part III" instead of
  silently exporting nothing; README drift pass (147→256 tests, missing reactivity/react/tools from
  quick start); CI workflow running `ci && build && attw && publint` + `prepublishOnly`.

## Tier 3 — API refinements (opportunistic, before 0.1 freezes them)

- `world.reactive` getter **irreversibly arms stamping** as a property-read side effect (a stray
  console.log flips a +17–28% profile switch). Move `enableReactive()` into observe* registration;
  add a side-effect-free `isReactiveEnabled` probe.
- `observeQuery` cols should default to the query's own components (silent-drift hazard — the
  example hand-lists six and drifts on the seventh); add `{ immediate: true }` to fire once at next
  notify (deletes both of the example's first-paint hacks).
- **Tier 2 `observeEntity` is an attractive nuisance** — archetype-granular stamps mean it fires on
  co-resident writes with unchanged values; zero real consumers (editor uses Tier 1 + resources,
  react uses Tier 3). Delete or rename to something honest before the API hardens.
- Callback-write loss: writes from inside notify() callbacks are nondeterministically lost
  (setResource devWarns; writeComponent doesn't). Cheapest sound fix: while `inObserverEmit`, stamp
  at `frameCounter + 1` — turns "silently lost sometimes" into deterministic next-frame delivery.
- Batch idiom pruning: bless `rows`/`count`; demote `denseCount`/`isDense` to @internal (a footgun
  needing a page of warnings for ~2%); delete loosely-typed `columns` (or move to tools).
- Missing editor affordances (each hand-rolled in the example): `world.count(q)`,
  `world.entities(q)`, `world.clone(e, overrides?)`, `world.updateResource(res, fn)` (kills the
  cam-mirror pattern), per-tag/relation stamp arrays (kills global tagRelFrame wakeups + enables
  `observeTag` for selection).
- `world.observe` naming: the best verb is spent on telemetry; rename toward `inspect`/dev-observer
  and standardize all teardowns on `Unsubscribe`.
- Error messages cite repo-internal coordinates ("001 Rule 3") that mean nothing on npm; include
  slot/gen in dead-handle throws.
- Example self-consistency: convert `cullFlags`/`lodFlags` to resources (deletes 3 of the 4
  remaining `dirty.doc` sites; the last is boot/restore first-paint, which `{immediate}` deletes).

## Claims killed by verification (do not relitigate)

| Claim | Why it died |
|---|---|
| "HMR breaks the global schema registry in the user's first hour" | The example ships the two-layer guard and labels it the reference pattern; vanilla Vite full-reloads by default. The registry-idempotence idea remains a nice-to-have, not a fire. |
| "ECSStore is a dead abstraction — delete it" | Truncated quote. The documented seam is ECSStore **plus** the RuntimeStore projection primitives (design.md:1250); retyping World to ECSStore is infeasible (9 non-contract methods). Only fix: reword the "World holds an ECSStore" comment. |
| "Part III lives on the world.import path — zero coverage" | Part III's inbound is **projection via sync()**, not import. The armed-world import test is still worth one low-priority case. |
| "Autosave funnel is leaky; add observeWorld" | Spawns DO wake the Tier-1 observer (rows-version bump); the four wiring sites are belt-and-braces, not holes. World-level "document changed" is Part III's `doc.transaction`, by design. |

---

*Sources: multi-agent review run wf_82519e6e-f40 (37 agents, findings verified adversarially).
Companion doc: `004-part2-4-revision.md` (the Parts II–IV spec-revision plan).*

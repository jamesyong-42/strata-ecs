# Changelog

All notable changes to strata-ecs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) (pre-1.0: minor versions may break APIs).

## [Unreleased]

### Added

- **`DurableStore.exportSnapshot({ mode: "shallow" })` — an at-rest, history-compacted snapshot.** The
  no-argument call is unchanged (a full snapshot, byte-identical to before); the new `shallow` mode
  exports the complete live state with the oplog below the current frontier garbage-collected, so an
  autosave / disk file stays smaller as history accumulates. Two laws bind the bytes: restore them via
  the RELOAD RECIPE — import into a bare `LoroDoc` *before* `createDurableStore`, never through
  `applyRemote` on a constructed store (a shallow snapshot imports clean only into a pristine doc); and a
  shallow-restored document cannot exchange increments across the truncation boundary with a full-history
  peer (mixing bases forces a re-bootstrap), though peers restored from the same shallow base delta-sync
  and undo normally. It does not reclaim despawned entities' empty containers (the no-delete layout
  floor).

### Fixed

- **A cross-boundary import into a shallow-restored document is now quarantined, not thrown raw.** When a
  full-history peer's increment references history a shallow snapshot has truncated, Loro throws a bare
  (non-`Error`) string that previously escaped `applyRemote` uncaught; it now maps to `PendingImportError`
  like any other unrecoverable import, so the transport's existing quarantine-and-re-bootstrap contract
  covers it. Genuinely undecodable bytes still pass through untouched (the transport owns that total
  catch) — only the shallow-history boundary case is remapped.

### Performance

- **A joiner's bootstrap import no longer builds the undo machinery.** The document adapter used to
  attach a Loro `UndoManager` the moment a store was constructed — so every peer paid the manager's
  cost while importing the opening snapshot, even a fresh joiner that has nothing to undo. The
  manager is now constructed LAZILY, at the first UNDOABLE local edit (or the first `undoGroup`), so a
  pristine joiner imports with a manager-free document. Undo/redo semantics are unchanged: everything
  before the first undoable edit was never undoable anyway (the manager only ever tracked commits
  sealed after it existed), and every history reader/writer is a no-op until that first edit. The
  measured gain varies with document size and heap state — larger documents benefit most — so no
  single speedup number is promised here; the profiling record lives in the internal plan notes.

## [0.9.0] — 2026-07-19

### Added

- **`world.componentsOf(e)` / `world.tagsOf(e)` — exhaustive entity introspection (born as
  infinite-canvas-engine petition 6).** Two pure, iteration-safe readers that return EVERY component
  / tag actually present on an entity — beyond any declared or prefab-eligible set, so a cell
  attached after the fact still lists (the devtools-inspector case). Both allocate a fresh array; a
  dead, stale, or identity-only handle reads `[]`. Neither is reactive (they read and write no
  stamps — pair with `world.reactive` for a wake on a shape change). Promoting them out of the
  engine's internal use HARDENED the handle semantics: the pre-promotion internal readers threw or
  misread on a stale handle rather than returning `[]`.
- **Headless / Node hosting, blessed as a first-class mode.** A new guide section documents running
  strata server-side with no DOM and no `requestAnimationFrame`: the core depends on neither, and
  the document layer's wire is plain bytes (`subscribeOutbound` / `applyRemote` / `exportSnapshot`),
  transport-agnostic. The document-host pattern — many rooms = many Worlds in one process over a
  process-global schema — drives its frame from a plain `setInterval`. No API change: the tick
  driver is deliberately NOT an API, because the three lines (`world.sync()` then
  `world.tick(pipeline)`) already ARE the driver. A complete, runnable `examples/headless-host`
  document host lands alongside.

## [0.8.0] — 2026-07-19

### Added

- **Ordered relations — sibling order as a first-class, collaborative primitive.**
  `defineRelation(name, { arity: "one", ordered: true })` makes each target's reverse set an
  ordered SEQUENCE: `getReverse(parent, R)` returns children in sibling order (that order IS the
  API), `setRelation(child, R, parent, place?)` takes a placement (`"first" | "last" |
  { before } | { after }`), and the new `world.moveRelation(child, R, place)` reorders in place.
  Anchors that lose a race (the sibling vanished or reparented) degrade to `"last"` with a dev
  warning — placement never throws. The new `world.orderStamp(parent, R)` is a monotonic
  per-parent order version (armed on first read, pull-only) for render-ordinal caches; reorders
  wake `observeQuery` watches naming the relation. The JSON snapshot round-trips order through an
  additive section; legacy snapshots import with a deterministic completion order. This is the
  tree shape canvas z-stacking, child-order, and layers UIs need — membership stays exactly
  where it was (the child's single edge), order is a subordinate sequence per parent.
- **Order syncs through the document layer.** Transactions gain the same surface
  (`tx.setRelation(…, place?)`, `tx.moveRelation`) — one gesture = one undo step, moves
  included; reorders reach other peers as compact order updates backed by a CRDT movable list,
  so concurrent reorders converge like Figma-style sibling lists (native move semantics: a
  concurrently moved-and-deleted entry survives as a move; a move never duplicates). Undo of a
  reparent restores the edge and both sequences atomically. Ordered relations are runtime-free
  when unused and pay one dormant branch when unordered relations mutate — comparative
  structural benchmarks against 0.7.0 are flat.

### Compatibility

- **Documents that use ordered relations require every collaborator on 0.8.0+.** Older builds
  neither read nor write sibling order; worse, their despawn path deletes the order container
  outright (re-opening a convergence hole this layout closed) and they silently drop incoming
  order updates. Gate mixed-version rooms at your document-open layer (an envelope/schema
  version, as in the reference apps) before adopting ordered relations in shared docs.
  Unordered relations and all existing docs are unaffected — the wire format is additive.

## [0.7.0] — 2026-07-14

### Added

- **`world.changes` — opt-in, pull-based ChangeCollectors (Patch Note 004; born as
  infinite-canvas-engine petition 7).** The missing layer between stamps ("might anything have
  changed?") and value observers ("did this decoded value differ?"): a collector journals WHICH
  entities were touched. `world.changes.collect({ components, tags })` returns a
  `ChangeCollector` whose `drain()` is callable **inside the pipeline** (between systems/phases)
  — same-frame, unlike the notify-boundary reactive layer — yielding `{ changed, removed,
  coarse, reset }`. Exact records at every sparse chokepoint (edit/set, add/remove component,
  spawn, destroy, tag flips — immediate AND ctx-flush paths); component removal reports as
  `changed` (the entity is alive and re-checkable), `removed` is reserved for destroys (packed
  handles remain valid as removal keys); raw `batch.col()` writers degrade HONESTLY to
  component-granular `coarse` records via the declared `access.write` blanket — never a miss,
  over-reporting is the escape valve. Per-collector dedup; drain-cursor semantics with REUSED
  buffers (a per-frame drain allocates nothing; returned arrays are valid until the next
  drain); `reset` marker on `world.reset()`. `coarse: false` is a per-collector ATTESTATION
  ("all writers of my components are store-visible — no raw column pokes"): the blanket is
  conservative by construction (it cannot tell a declared writer that wrote through the exact
  chokepoints from one that wrote raw), so exact-path pipelines whose declared writers run
  every frame opt out rather than drown in permanent full-rescan records; the explicit
  `touch()` row operation remains the planned precision upgrade for mixed pipelines. **Gate
  independence**: collectors have their own
  attachment gate — they neither arm nor require `reactiveOn` (a value observer must not tax
  writes with journal checks; a collector must not flip the +17–28% stamping profile). A world
  that never collects pays one dormant null test per chokepoint.

## [0.6.0] — 2026-07-13

### Added

- **`attachProfiler` — a frame-profiler overlay in `@vibecook/strata-ecs/tools`.** The inspector
  panel's sibling: a compact always-on meter (fps, tick cost, frame-time sparkline against a
  budget line) that expands into frame/tick **percentiles** (p50/p95/p99/max), host-reported
  per-**lane** costs (`prof.lane("paint", ms)` — the tick read in context of the whole frame),
  the hottest systems, and a **worst-frame capture**: the full per-system µs breakdown of the
  worst frame since attach/reset. A "frame" is one tick-to-tick interval, so in the canonical
  one-tick-per-rAF loop attaching is a single line with no loop rewiring; `stats()` exposes the
  same snapshot programmatically (budget assertions in tests, custom telemetry). Rides the
  existing `WorldObserver` contract — worlds still pay nothing while no tool is attached. The
  canvas-editor example now uses it in place of its hand-rolled HUD readout.

## [0.5.1] — 2026-07-12

Hardening release — packaging, artifact honesty, and consumer-facing guarantees. No API
changes (now provable: the public surface is pinned by test).

> Publishing note: the npm artifact for 0.5.1 was built from `d69bf31` (a day past this
> section), so it already contains `attachProfiler` — the feature documented under 0.6.0
> above. Fully tested code, wrong label; 0.6.0 is the properly documented release.

### Changed

- **Dev diagnostics are truly eliminated from production artifacts.** Every entry now ships
  two builds behind export conditions: a `development` build with all dev-mode warnings live,
  and a production build (the default) with `if (DEV)` branches — message strings included —
  constant-folded away. Previously an unshimmed browser production bundle not only retained
  the diagnostics but RAN them (`DEV` evaluated true wherever `process` was absent). Bundlers
  pick the right artifact automatically (Vite/webpack apply the `development` condition in dev
  mode); no `process.env` define is needed anymore. **Behavior note:** plain `node` now
  resolves the production build — run `node --conditions=development` to get diagnostics
  outside a bundler. Running from source (vitest, live-src aliases) keeps the old NODE_ENV
  fallback.
- Fixed a doubled `strata: strata:` prefix in the `defineTickSystem` arity warning.
- `VERSION` now reports the real package version — it had shipped as a stale `"0.0.0"` since
  0.1.0. Pinned to package.json by test so it cannot drift again.
- Comparative benchmarks refreshed against the 0.5.1 **production artifact** (they previously
  ran the runtime DEV check with `NODE_ENV` unset — dev mode). Absolute numbers moved ~10% up
  across ALL five libraries (same machine, newer OS); every relative standing is unchanged and
  [BENCHMARKS.md](BENCHMARKS.md) now records the benchmark date and commit.

### Added

- **Consumer smoke in CI** (`scripts/consumer-smoke.mjs`, `consumer` matrix job on
  ubuntu/windows/macos × Node 24 + a Node 20 engines-floor leg): installs the packed tarball
  into a fresh npm project and verifies what consumers actually get — every exports-map target
  exists, core + `/tools` work with zero optional peers, `/durable`/`/ephemeral`/`/react` fail
  with a clear module-not-found naming their absent peer (and work once installed), the
  dev/prod condition contract is observed at runtime, DEV code is grep-provably absent from
  the production artifact, and a Vite production build runs and fits a 32 KB gzip core budget.
- **Public API surface pins** (`src/api-surface.test.ts` + per-project halves): every runtime
  export of the five entries and the exports-map subpaths, as literal arrays — removing or
  renaming a public name can no longer happen by accident, and adding one is an explicit
  release decision.
- README: a "When not to use strata-ecs" section, and a Package exports note documenting the
  two-build export conditions.
- Access metadata is now explicitly documented as diagnostic + scheduling metadata, **not** a
  capability or security boundary (guide + `SystemAccess` API notes).

## [0.5.0] — 2026-07-11

System execution semantics: the scheduler owns system cardinality, queries own data cardinality.
Born from a field finding in the heaviest consumer — a system body anchored on a tag ran once per
matched archetype (not once per frame), silently multiplying camera math as the world's shape
diversity grew.

### Added

- **Tick systems** (`defineTickSystem(body, { name, access, runIf })`, types `TickSystem` /
  `TickSystemBody`) — a queryless schedule entry whose body runs **exactly once per dispatch**,
  independent of archetype count. The home for whole-frame effects and coordination (camera
  integration, input-queue drains, cross-archetype algorithms) that a per-chunk body multiplies.
  `runIf` composes identically (a skipped dispatch stamps nothing); telemetry and access
  enforcement are form-agnostic; `phase()` accepts both forms mixed. With no query there is no
  default read set — declare `access` explicitly.
- **`ctx.query(q).each(batch => …)`** — the sanctioned in-body walk, for both system forms.
  Identical to `world.query` (same guard, same non-empty batches), and *attributed*: `col()` reads
  are charged to the running system's declared access, and the system's declared writes are
  stamped over each walked query's matches at walk end — raw `col()` writes through an inner query
  can no longer be missed by reactivity.

### Changed

- **Zero-match chunks are never delivered.** A row-filtered chunk whose tag/relation filters match
  no rows is skipped before the body runs; every `Batch` a system body or `world.query` callback
  observes now has `count ≥ 1`. Empty invocations were never a sanctioned signal — nothing in this
  repo or the known consumers relied on them — but strictly this narrows the old "once per
  matching archetype" delivery, hence the minor bump.
- **Typed breaking change:** `Phase.systems` (and `phase()`'s parameter) widened from
  `readonly System[]` to `readonly (System | TickSystem)[]`. The `System` type itself is unchanged;
  code that *reads* `phase.systems` into `System`-typed variables must narrow on
  `query !== undefined` or widen its own types (see migration checklist).

### Migration checklist

1. Does any system body rely on being invoked for a chunk with zero matching rows? (No known code
   does; the instrumentation never modeled it either.) If yes, that logic belongs in a tick system.
2. Does any system use a query purely as a once-per-frame anchor (a singleton tag, a `count === 0`
   early-return guard)? Convert it to `defineTickSystem`, delete the guard, and iterate real data
   inside via `ctx.query`.
3. Helpers typed against `readonly System[]` that should accept both forms widen to
   `readonly (System | TickSystem)[]` (the `System` type itself is unchanged).

## [0.4.0] — 2026-07-11

Three additive dev-experience and embedding features, all born from editor-integration reviews
(no breaking changes).

### Added

- **Writer-pair attestation** (`SystemAccess.orderIndependent`) — systems that deliberately
  co-write a column in one phase (row-disjoint by construction, commutative, or
  last-write-wins-safe) can each attest it. The same-phase double-writer advisory for that column
  goes quiet only when **every** co-writer attests, so an un-attested newcomer re-arms it — the
  channel stays trustworthy instead of training you to ignore it. Attested columns must be a
  subset of `write` (dev hygiene warning otherwise); attestation is advisory-only metadata —
  access enforcement and read defaults are untouched.
- **Sanctioned document metadata** (`DurableStore.metaTransaction(fn)` + `MetaEditor`, durable
  subpath) — write app markers (schema versions, feature stamps) into the document's reserved
  metadata map through a small `get`/`set` editor. The commit is properly tagged — importing peers
  no longer warn about an untagged foreign writer — excluded from undo/redo, invisible to
  observers (no entity/component change), persists and travels with the document, and converges
  per key last-writer-wins. Values are `string | number | boolean`; use a dotted key namespace
  (e.g. `"engine.schema"`); the reserved document-id key is refused; callable before attach.
  Importers also stop warning about **metadata-only** foreign commits from before this API (they
  carry no ECS facts, so their commit boundaries never mattered).
- **Dev write hook + read-only view** (`world.devOnWrite(cb)`, `WriteKind`, `ReadonlyWorld`,
  `WorldMutatorName`) — a dev-only, synchronous, **pre-mutation** hook whose throws propagate to
  the mutator's caller. Fired from internal chokepoints downstream of any bound method reference,
  it observes every mutation route — world methods, editors, the deferred command flush, document
  transactions, sync/attach drains, undo echoes, presence, snapshot import, reset — and a
  single-op fire precedes the first state change, so a throwing hook is a clean veto that names
  the offender in its stack. Built for law windows ("nothing writes to the ECS during the render
  pass"): register once, keep an app-side `armed` flag, throw only while armed. `ReadonlyWorld`
  (`World` minus its seventeen mutators) is the compile-time half of the same law. Raw
  `batch.col()` column writes are the documented carve-out (no chokepoint exists by design — the
  same carve-out `reactive.invalidate` covers).
  - *Honest dev-mode note:* where `DEV` is false (a runtime with `process` under
    `NODE_ENV=production` — node/SSR, or a browser build that defines/shims `process`),
    registration no-ops and every fire site is dead. In an **un-shimmed browser production
    bundle** `DEV` evaluates true at runtime: registration stays live and each mutation pays a
    tiny roster null-check — gate your registration behind your own production flag there.
    Dev/prod conditional builds that eliminate this entirely are planned.

### Fixed

- The same-phase double-writer advisory now counts **distinct systems** — a duplicated
  `access.write` entry (`[R, R]`) or the same system placed twice in a phase no longer warns a
  system against itself, and repeated names dedupe in the message.

Adopters of the previous integration workarounds can now: (1) add `orderIndependent` to
deliberately co-located writers; (2) replace raw pre-attach metadata stamping with
`createDurableStore(doc)` **first**, then `store.metaTransaction(...)`; (3) replace world-method
monkey-patch write traps with one persistent `devOnWrite` + an armed flag — which also covers the
routes such traps miss (document transactions, sync drains) and every mutator added later.

## [0.3.0] — 2026-07-09

Two additive quality features, both born from editor-integration reviews (no breaking changes).

### Added

- **Non-undoable transactions** (`@vibecook/strata-ecs/durable`) —
  `doc.transaction(fn, { undoable: false })` runs a transaction whose commit is excluded from the
  **local** undo stack: document migrations, format upgrades, and read-repair at open no longer have
  to wipe the user's history with `clearHistory()`. The commit is otherwise ordinary — peers receive
  it as a normal remote batch, history hooks don't fire for it, and a pending redo survives it.
- **Per-tag/relation observer precision** — a row-filtered `observeQuery` (tag / relation filters,
  `Not`, mixed `Any`, concrete-target `Related` seeds) now wakes only when a tag or relation **its
  own plan depends on** changes membership, instead of on any tag/relation churn anywhere in the
  world. Interaction-rate state (hover targets, drop targets, gesture claims) no longer needs
  change-only write discipline to keep selection/render observers quiet. The Tier-1 contract is
  unchanged: may over-fire, never miss.

## [0.2.0] — 2026-07-08

Pre-1.0, so this minor carries breaking API changes; each one below has a one-line migration.

### Added

- **Undo & redo on the durable store** (`@vibecook/strata-ecs/durable`) — `undo()` / `redo()`
  with `canUndo()` / `canRedo()`, `undoGroup(fn)` to collapse a gesture's several commits into one
  step, `clearHistory()`, and `setHistoryHooks({ capture, restore })` for selection metadata that
  rides the stacks. Undo is **local-only** — each peer undoes only its own changes — and one
  transaction is one undoable step. `createDurableStore` takes `{ maxUndoSteps }` (default 100), and
  a runtime-local `DurableUndoStatus` resource (`{ canUndo, canRedo }`) drives toolbar enablement
  reactively. See [Undo & history](https://jamesyong-42.github.io/strata-ecs/#undo).
- **`world.count(q)` / `world.entities(q)`** — iteration-safe query reads: the matched-entity total,
  and the matching handles materialized into a fresh array.
- **`world.updateResource(res, fn)`** — read-modify-write a resource in one call; throws if the
  resource was never set.
- **`world.isReactiveEnabled`** — a side-effect-free probe of whether reactive stamping has armed.
- **`observeQuery` options** — a third `opts` argument: `cols` (the columns to watch, defaulting to
  the query's own components) and `immediate` (fire the callback once at the first `notify()` for a
  first paint).
- **WebTransport transport & relay for the collab example** — one QUIC connection carrying two
  delivery classes (reliable document ops, unreliable presence) alongside the existing WebSocket
  relay, plus a measured WebSocket-vs-WebTransport benchmark under `netem`. See [BENCHMARKS](BENCHMARKS.md).

### Changed

- **Bootstrap import is dramatically faster** — a fresh joiner's initial snapshot import now
  coalesces into a single batch instead of one per entity; a 10k-entity join drops from 14.4 s to
  0.53 s.
- **Reactivity arms at registration, not on property access** — reading `world.reactive` is now
  side-effect-free; the first `observe*` call is what turns stamping (and dev-enforcement) on, so a
  stray read or log of the world can no longer flip the reactive cost profile.
- **Value writes from reactive callbacks are now legal and deterministic** — an `edit().set` /
  `setResource` / `removeResource` from inside a `notify()` callback is delivered at the next
  `notify()`, exactly once. Structural mutation from a callback is still rejected — schedule it for
  the next frame boundary.
- **Thrown and dev messages are self-contained** — error text no longer cites internal document
  sections; each message stands on its own.
- **BREAKING — `observeQuery(q, cb, opts?)`** — the callback moved to the second argument and the
  watched columns moved into `opts.cols`. *Migration:* `observeQuery(q, cols, cb)` →
  `observeQuery(q, cb, { cols })`, or drop `cols` to watch the query's own components.

### Removed

- **BREAKING — `observeEntity` removed** — its stamp was archetype-wide, so it fired on any
  co-resident component's write, not only the watched one. *Migration:* watch the value, not the
  stamp — use `observeValue`.
- **BREAKING — `Batch.columns` removed; `Batch.denseCount` / `Batch.isDense` are now internal.**
  *Migration:* iterate `rows` up to `count` and read typed columns with `col(C)`.

### Fixed

- **WebTransport read-loop resilience** in the collab relay — per-frame isolation so one malformed
  frame no longer tears the stream down, and a fail-fast launcher on a bad endpoint.

## [0.1.0] — 2026-07-06

Initial public release:

- **Core ECS** — archetype storage over typed-array columns; entities as generational
  handles; components, tags, relations (inverse-indexed, cascade-on-despawn), and
  resources; compiled queries (`Not` / `Any` / `Related`); systems with phases,
  `runIf` gates, and access declarations; deferred structural mutation at phase
  boundaries; `world.export()` / `world.import({ replace })` persistence.
- **Reactivity** — `observeQuery` / `observeValue` / `observeResource` at one settled
  `notify()` boundary per frame; dormant until the first observer registers.
- **React binding** (`@vibecook/strata-ecs/react`) — `useComponent` / `useResource` over
  `useSyncExternalStore`.
- **Document layer** (`@vibecook/strata-ecs/durable`) — CRDT-backed (Loro) persistent document
  projected into the runtime; transactions as commit/undo units; committer-wins
  per-component conflict resolution with drag protection; `DurableSyncStatus`.
- **Presence layer** (`@vibecook/strata-ecs/ephemeral`) — writer-partitioned, TTL-self-expiring
  presence projected as `Not(Local)` entities; throttled broadcast + keepalive;
  `EphemeralSyncStatus`.
- **Devtools** (`@vibecook/strata-ecs/tools`) — drop-in inspector panel: entities, systems,
  timeline, plus document/presence inspection tabs with a collapsible live tree view.
- **Example** — an infinite-canvas whiteboard (`examples/canvas-editor`) with
  multiplayer over BroadcastChannel or a WebSocket relay (`examples/collab-server`),
  and an in-page collab acceptance suite (`?script=collab-smoke`).

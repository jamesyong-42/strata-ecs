# Changelog

All notable changes to strata-ecs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) (pre-1.0: minor versions may break APIs).

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

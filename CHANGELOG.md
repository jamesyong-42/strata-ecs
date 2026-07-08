# Changelog

All notable changes to strata-ecs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) (pre-1.0: minor versions may break APIs).

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

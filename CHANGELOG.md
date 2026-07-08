# Changelog

All notable changes to strata-ecs are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org) (pre-1.0: minor versions may break APIs).

## [Unreleased]

### Added

- **Undo & redo on the document layer** — `doc.undo()` / `doc.redo()` with
  `doc.canUndo()` / `doc.canRedo()`, `doc.undoGroup(fn)` (collapse a gesture into one
  step), `doc.clearHistory()`, and `doc.setHistoryHooks({ capture, restore })` for
  selection metadata that rides the stacks. Undo is **local-only** — each peer undoes
  only its own changes — and one transaction is one undoable step. `createDurableStore`
  takes `{ maxUndoSteps }` (default 100), and a new runtime-local `DurableUndoStatus`
  resource (`{ canUndo, canRedo }`) drives toolbar enablement reactively. See
  [Undo & history](https://jamesyong-42.github.io/strata-ecs/#undo).

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

# strata-ecs

**A collaborative entity-component-system for editors and infinite-canvas apps.**

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![license](https://img.shields.io/badge/license-MIT-green)
![status](https://img.shields.io/badge/status-pre--release-orange)
![collab](https://img.shields.io/badge/CRDT-Loro-0f766e)
[![ci](https://github.com/jamesyong-42/strata-ecs/actions/workflows/ci.yml/badge.svg)](https://github.com/jamesyong-42/strata-ecs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40vibecook%2Fstrata-ecs)](https://www.npmjs.com/package/@vibecook/strata-ecs)

strata-ecs is an entity-component-system for TypeScript apps that edit documents —
whiteboards, node graphs, design tools. Model the document as entities and components,
query it at typed-array speed, and add CRDT-backed multiplayer later as a layer — not a
rewrite.

It is built for the editor workload, **not games**: tens of thousands of live objects,
undo, autosave, live cursors, and a render loop that must never pay for features you
haven't turned on.

- **Typed-array fast** — components live in struct-of-arrays columns grouped by
  archetype; a system is a contiguous loop over a `Float32Array`. Ties or beats
  [bitecs](https://github.com/NateTheGreatt/bitECS) on the canonical iteration
  benchmarks, leads on entity-lifecycle churn ([BENCHMARKS.md](BENCHMARKS.md)).
- **Schema-first types** — field types flow from one schema literal into both the
  storage and the TypeScript types. `batch.col(Position).x` *is* a `Float32Array` at
  compile time; a typo in a field name is a type error.
- **Reactivity built in, free until used** — subscribe to queries, values, or
  resources instead of scattering dirty flags. Dormant until the first observer;
  an idle check over 10,000 watches costs ~39 ns.
- **CRDT-backed multiplayer as opt-in layers** — a durable **Document** layer
  (permanently stored, merges without conflicts) and an ephemeral **Presence** layer
  (cursors and selections that reset on disconnect), both projecting into the same
  runtime your systems already read. Convergence comes from [Loro](https://loro.dev),
  not from code you write — and the hot path never imports it. Undo and redo ship
  built in and multiplayer-correct: each peer undoes only its own changes.
- **Transport-agnostic** — the framework converges documents; your app moves bytes.
  Any channel that carries a `Uint8Array` works: WebSocket, `BroadcastChannel`, WebRTC.
- **First-party devtools and React binding** — a drop-in inspector panel
  (`@vibecook/strata-ecs/tools`) and two `useSyncExternalStore` hooks (`@vibecook/strata-ecs/react`).

**Documentation:** [the guide](https://jamesyong-42.github.io/strata-ecs/) ·
[API reference](https://jamesyong-42.github.io/strata-ecs/api.html) ·
[live demo](https://jamesyong-42.github.io/strata-ecs/demo/) ·
[benchmarks](https://jamesyong-42.github.io/strata-ecs/benchmarks.html)

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The five words](#the-five-words)
- [Architecture](#architecture)
- [Reactivity](#reactivity)
- [Save & load](#save--load)
- [Going multiplayer](#going-multiplayer)
- [Devtools](#devtools)
- [The example app](#the-example-app)
- [Performance](#performance)
- [Package exports](#package-exports)
- [Development](#development)
- [Status](#status)
- [License](#license)

## Install

```sh
npm install @vibecook/strata-ecs
```

> **Pre-1.0:** the API may still move between minor versions — pin your version and read
> the [changelog](CHANGELOG.md) when bumping.

`loro-crdt` and `react` are **optional** peer dependencies — you install them only if
you use the collaboration layers or the React binding. The core has zero dependencies.

## Quick start

Components hold typed data. Entities carry components. Systems run over queries. The
world ticks:

```ts
import { createWorld, defineComponent, defineQuery, defineSystem, phase } from "@vibecook/strata-ecs";

const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });

const Movement = defineSystem(defineQuery([Position, Velocity]), (batch) => {
  const px = batch.col(Position).x;   // Float32Array — typed from the schema, no cast
  const py = batch.col(Position).y;
  const vx = batch.col(Velocity).x;
  const vy = batch.col(Velocity).y;
  for (const r of batch) {            // matched rows; filters fused
    px[r] += vx[r];
    py[r] += vy[r];
  }
});

const world = createWorld();
const e = world.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 2 }]] });

world.tick([phase("sim", [Movement])]);
world.read(e, Position); // { x: 1, y: 2 }
```

A real app runs one frame loop — and writes it the same way from day one, so the
collaboration layers attach later with zero rewrite:

```ts
function frame() {
  requestAnimationFrame(frame);
  world.sync();               // drain inbound layers (no-op until a collab layer attaches)
  world.tick(pipeline());     // run systems; shape changes flush at phase boundaries
  world.reactive.notify();    // THE settled point — fire dirty observers, once per frame
  paint();                    // render reads the finished state
}
requestAnimationFrame(frame);
```

## The five words

| Term | One line | Guide |
|---|---|---|
| **Entity** | a stable handle naming one thing in the world — a shape, a node, an edge | [Entities](https://jamesyong-42.github.io/strata-ecs/#entities) |
| **Component** | typed fields attached to an entity; entities with the same set share storage | [Components](https://jamesyong-42.github.io/strata-ecs/#components) |
| **System** | a function that runs over every entity matching a query, once per tick | [Systems](https://jamesyong-42.github.io/strata-ecs/#systems) |
| **Query** | a compiled description of "entities with these components" — define once, reuse | [Queries](https://jamesyong-42.github.io/strata-ecs/#queries) |
| **World** | the container that holds it all; `world.tick()` runs your systems over it | [The frame loop](https://jamesyong-42.github.io/strata-ecs/#frame) |

Tags (zero-data markers), relations (indexed edges with cascade-on-despawn), and
resources (world singletons) round out the data model.

## Architecture

The name is the map: a stack of independent layers — strata — over one queryable
runtime. The core ECS is a complete product on its own; everything above it is opt-in.

```
   ┌────────────────┐   ┌─────────────────┐   ┌─────────────────┐
   │ REACTIVITY     │   │ DOCUMENT        │   │ PRESENCE        │
   │ built in       │   │ durable         │   │ ephemeral       │  ← optional
   │ watch queries  │   │ stored · synced │   │ cursors · TTL   │    layers
   │ & values       │   │ conflict-free   │   │ self-expiring   │
   └───────┬────────┘   └────────┬────────┘   └────────┬────────┘
           │ observes            │ projects ↕          │ projects ↕
           │            ┌────────┴─────────────────────┴────────┐
           │            │   RECONCILE SUBSTRATE (internal)      │
           │            │   converges concurrent edits —        │
           │            │   you never import this               │
           │            └────────┬──────────────────────────────┘
   ┌───────▼─────────────────────▼──────────────────────────────┐
   │ CORE ECS (strata-ecs)                                      │
   │ entities · components · tags · relations · queries ·       │
   │ systems · resources — typed-array archetype columns        │
   │ the hot path: a tick touches only this layer               │
   └────────────────────────────────────────────────────────────┘
```

Layers you haven't attached cost nothing; layers you have do their work at the frame's
`sync()`/`notify()` boundaries, never inside your systems' loops. The CRDT is confined
to two adapter classes; the core never imports it.

Two rules carry most of the mental model:

- **Mutation timing** — values flow immediately; structure (spawn, destroy, add/remove
  component) lands at phase boundaries.
- **One settled boundary per frame** — call `world.reactive.notify()` exactly once,
  after all ticks, before you render.

## Reactivity

The world is the change detector. Three tiers, from coarse-and-cheap to precise:

```ts
// did anything matching this query move? (may over-fire, never misses)
// the watched columns default to the query's own components; pass { cols } to narrow or widen
world.reactive.observeQuery(renderable, () => { repaint = true; });

// this exact value changed (equal-value writes are suppressed)
world.reactive.observeValue(e, Position, (pos) => { /* { x, y } | undefined */ });

// a world singleton changed
world.reactive.observeResource(Camera, () => { repaint = true; });
```

React components subscribe with two hooks — re-rendering exactly once per real change:

```tsx
import { useComponent, useResource } from "@vibecook/strata-ecs/react";

function ShapeInspector({ world, entity }: { world: World; entity: Entity }) {
  const pos = useComponent(world, entity, Position);
  const cam = useResource(world, Camera);
  return <span>{pos ? `${pos.x}, ${pos.y}` : "—"}</span>;
}
```

## Save & load

The runtime serializes itself — no collaboration required:

```ts
const bytes = world.export();               // readable UTF-8 JSON
world.import(bytes, { replace: true });     // validates, then resets the SAME world in
                                            // place — observers and subscriptions survive
```

## Going multiplayer

Everything above runs entirely local. When you want other people in the same document,
two layers attach:

|  | **Document** (`@vibecook/strata-ecs/durable`) | **Presence** (`@vibecook/strata-ecs/ephemeral`) |
|---|---|---|
| Holds | the board itself — shapes, edges, styles | the people on it — cursors, selections |
| Lifetime | permanently stored, merges without conflicts | self-expiring; resets when a peer disconnects |
| Backed by | Loro's CRDT document | Loro's ephemeral store |

```ts
import { LoroDoc } from "loro-crdt";
import { createDurableStore, attachDurable } from "@vibecook/strata-ecs/durable";

const doc = createDurableStore(new LoroDoc());   // the ONE place the CRDT enters
attachDurable(world, doc);                       // project it into the runtime

doc.subscribeOutbound((bytes) => transport.send(bytes));  // outbound wire
transport.onMessage((bytes) => doc.applyRemote(bytes));   // inbound wire

// Change the document only inside a transaction — one commit, one undo unit.
doc.transaction((tx) => {
  const shape = tx.spawn({ components: [[Position, { x: 0, y: 0 }], [Size, { w: 100, h: 60 }]] });
});
```

Convergence is not code you write: concurrent edits merge automatically on every peer,
offline peers catch up from increments, and no server has to arbitrate — a relay that
moves bytes is enough. Conflict resolution is **committer-wins, per component**: a drag
writes the runtime every frame and commits once at gesture end; the framework holds
conflicting remote edits off while your gesture is in flight, then everyone converges.

Presence is the same idea for people: each peer owns a partition, writes it immediately,
and every other peer projects in as a live `Not(Local)` entity that self-expires on TTL.

Undo and redo are built in and local-only — `doc.undo()` / `doc.redo()`, one transaction
per step, `doc.undoGroup(fn)` to collapse a gesture, and a `DurableUndoStatus` resource to
drive toolbar enablement. See [Undo & history](https://jamesyong-42.github.io/strata-ecs/#undo).

See [Going multiplayer](https://jamesyong-42.github.io/strata-ecs/#collab) in the guide for
the full story — the visibility rules, entity keys vs. handles, and the transport
bootstrap protocol.

## Devtools

```ts
import { attachObserver } from "@vibecook/strata-ecs/tools";
const obs = attachObserver(world, { describe });
```

A zero-dependency inspector panel: live entity list, per-system timings, a birth-to-death
timeline — and, when collaboration is attached, a **durable** tab (baseline vs. converged
document side by side; highlighted rows are the un-reconciled sync delta) and an
**ephemeral** tab (every peer's live presence, grouped by writer).

## The example app

[`examples/canvas-editor`](examples/canvas-editor) — an infinite-canvas whiteboard in
vanilla TypeScript + Canvas2D whose only runtime dependency is strata-ecs. **Try it live:
[the hosted demo](https://jamesyong-42.github.io/strata-ecs/demo/)** — open two tabs at
[`?collab=demo`](https://jamesyong-42.github.io/strata-ecs/demo/?collab=demo) for multiplayer. 10k+ shapes
with brute-force culling, reactive repaint and autosave from one `observeQuery`, and the
full collaboration stack:

```sh
pnpm install
pnpm example:canvas          # → http://localhost:5173

# multiplayer between two tabs (no server):
#   http://localhost:5173/?collab=demo

# across machines over a WebSocket relay:
pnpm collab:server           # dumb byte relay — ws://localhost:8787
#   http://localhost:5173/?collab=demo&ws
```

## Performance

On the canonical ECS micro-benchmarks (Node 24), strata-ecs ties or beats bitecs — the
flat-array specialist — on dense iteration, and leads on entity-lifecycle churn.
A movement tick over 10,000 entities runs in ~0.2 ms with zero per-row allocation.
The archetype trade-off is real and documented: adding or removing a component migrates
the row between tables.

Full cross-library tables, methodology, and the losses included:
[BENCHMARKS.md](BENCHMARKS.md).

## Package exports

| Import | What | Requires |
|---|---|---|
| `@vibecook/strata-ecs` | the core ECS + reactivity | nothing |
| `@vibecook/strata-ecs/durable` | the Document (durable) layer | `loro-crdt` |
| `@vibecook/strata-ecs/ephemeral` | the Presence (ephemeral) layer | `loro-crdt` |
| `@vibecook/strata-ecs/react` | `useComponent` / `useResource` hooks | `react >= 18` |
| `@vibecook/strata-ecs/tools` | the inspector panel | nothing |

ESM-only. `loro-crdt` and `react` are optional peer dependencies — never bundled, only
needed for the entry points that use them.

## Development

Requires **Node 24+** (see [`.nvmrc`](.nvmrc)) and **pnpm**.

```sh
pnpm install
pnpm typecheck        # tsc, all sub-projects
pnpm test             # vitest unit suites
pnpm test:stress      # property/fuzz suites (longer)
pnpm bench            # microbenchmarks
pnpm build            # bundle to dist/ (tsup → ESM + .d.ts)
pnpm run ci           # typecheck + lint + tests + stress smoke — the merge gate
pnpm example:canvas   # the flagship example, live-reloading against src/
```

Repository layout: [`src/core`](src/core) (the runtime), [`src/substrate`](src/substrate)
(the internal reconcile layer), [`src/durable`](src/durable) + [`src/ephemeral`](src/ephemeral)
(the collaboration layers), [`src/tools`](src/tools) + [`src/react`](src/react) (devtools,
React binding), [`examples/canvas-editor`](examples/canvas-editor) (the flagship demo),
[`docs/`](docs) (the docs site: the guide + the API reference).

## Status

**Pre-1.0.** The core, the reactivity tier, both collaboration layers, the devtools,
and the example app are complete, benchmarked, and green under the full test suite —
this README describes what is built, not what is planned. Published to npm as
[`@vibecook/strata-ecs`](https://www.npmjs.com/package/@vibecook/strata-ecs); minor
versions may still break APIs before 1.0.

## License

[MIT](LICENSE)

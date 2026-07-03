# Plan — `strata-ecs/tools`: first-party dev tools, starting with the Observer

**Status: IMPLEMENTED** (T0 core observability `e14a1bc` — bench-gated within noise; T1
panel `c6b35f4` — 15 adversarial-review findings fixed pre-commit. Companion to
`plan-example-canvas.md`.)

James's direction: profilers/inspectors are **out-of-the-box framework tools**, not app code.
They live in a `src/tools/` folder shipped as the **`strata-ecs/tools`** subpath export
(mirroring the planned `strata-ecs/durable` / `strata-ecs/ephemeral` entries). First tool: a port of
the ECS Observer he built for `@jamesyong42/reactive-ecs`
(`infinite-canvas/apps/playground/src/prototype/ObserverPanel.tsx` + `EntityTimeline.tsx` +
`lifecycle.ts` + `engine.ts` stats).

## 1. What the original tool is

A draggable, resizable, layout-persisted inspector window with three surfaces:

1. **Entities tab** — every live entity as an expandable row: id, composition-derived label,
   tag chips, and each component's real-time field values (polled ~16 Hz).
2. **Loop readout** — systems grouped by phase, a "ran this tick" dot, run/skip counters and
   idle% for gated systems.
3. **Timeline tab** — a Chrome-network-style waterfall: one bar per entity from birth to
   death (or the live "now" edge), canvas-rendered so thousands of rows pan/zoom at 60fps,
   with an ms ↔ ticks axis switch, live-tail, pinch-zoom, drag-pan, hover tooltips, and
   outcome end-caps. Its data layer is a `LifecycleRecorder` fed by **synchronous**
   `onEntityCreated` / `onEntityDestroyed` events — a poll would miss entities born and
   killed within 1–2 ticks; the destroy event fires **before teardown**, so the recorder can
   freeze the dying entity's final identity.

## 2. Gap analysis — original API → strata

| Original (`reactive-ecs`) | strata today | Verdict |
|---|---|---|
| `world.getAllEntities()` | `world.runtime.archetypes()` → `arch.entities[0..count)` (`RuntimeStore` is already exported; `Archetype` exposes `entities`, `count`, `componentIds`) | ✅ tools-side walk |
| `world.getComponentsOf(e)` | `runtime.archetypeOf(e)?.componentIds` + component registry (one small `@internal` accessor added alongside the three core gaps) | ✅ tools-side |
| `world.getTagsOf(e)` | iterate registered tags + `world.hasTag(e, t)` (registries `componentByName`/`tagByName`/`relationByName` exist in `schema.ts`, unexported from the public entry — first-party tools import them in-repo) | ✅ tools-side |
| `world.getComponent(e, type)` | `world.get(e, C)` (16 Hz on expanded rows only — allocation acceptable) | ✅ exists |
| `world.currentTick` | — | ❌ **core gap 1**: `world.tickCount` |
| `world.onEntityCreated/onEntityDestroyed` (sync, destroy pre-teardown) | nothing — Part I has zero events | ❌ **core gap 2**: lifecycle observer |
| `getSystemStats()` (name · phase · ran · runs/skips) | `Phase` has a name; `System` has **no name**; `tick()` has no instrumentation | ❌ **core gap 3**: system names + tick observer |
| `describeEntity` (identity off composition) | app-specific by nature | ✅ tools option: `describe?: (world, e) => { label, color?, phase? }`, default = component-set names |
| relations (original had none) | `getRelations` / `getReverse` | ✅ **better than original** — inspector shows edges |
| per-system µs (original had none) | from the tick observer | ✅ **better than original** |

Conclusion: the panel is ~90 % portable; reflection needs zero core changes; **events,
tick counting, and system naming are the three genuine core additions.**

## 3. Core additions (small, zero-cost when unattached)

```ts
// src/core/observe.ts (new)
export interface WorldObserver {
  // lifecycle. onSpawn fires exactly once per entity: after placement for immediate
  // world.spawn (and per-entity during snapshot import, where eid fields/relations only
  // land in the load's second phase); at the eager identity mint for a deferred ctx.spawn
  // (placement follows at that phase's flush, with no second event). onDestroy fires
  // BEFORE teardown (entity fully readable) and covers both surfaces — immediate
  // world.destroy and the flush's despawn command both funnel through RuntimeStore.destroy.
  onSpawn?(e: Entity): void;
  onDestroy?(e: Entity): void;
  // tick instrumentation — fired from World.tick
  onTickStart?(tick: number): void;
  onSystemRun?(phase: string, system: string, ran: boolean, micros: number): void; // ran=false ⇒ runIf-gated (micros 0)
  onPhaseFlush?(phase: string, micros: number): void;
  onTickEnd?(tick: number, micros: number): void;
}

world.observe(obs: WorldObserver): () => void; // attach; returns detach
world.tickCount: number;                       // increments per tick()
defineSystem(query, body, { name?, runIf? })   // System.name = opts.name ?? body.name ?? "system"
```

Rules:

- **One nullable slot semantics**: internally an array, but the hot paths guard on a single
  `if (this.observers !== null)`. With nothing attached, `spawn`/`destroy` pay one branch and
  `tick()` pays one branch per phase — no `performance.now()` calls, no allocation.
- `performance.now()` timing happens **only while attached** (Node and browsers both have it;
  the bench harness already relies on it).
- Destroy ordering is contractual: observer fires before column/tag/relation teardown —
  documented, tested (mirrors what the original recorder verified about reactive-ecs).
- **Perf gate**: re-run `bench/compare` after landing; `entity_cycle`, `spawn_reap_frame`,
  and `sim_frame` must be unchanged within noise (they are our measured wins — the observer
  branch must be invisible).

## 4. The tool itself — `src/tools/` → `strata-ecs/tools`

**Zero-dependency vanilla DOM + canvas** (no React — usable from any host app, including the
vanilla canvas-editor example; a React wrapper is a 10-line `useEffect` if ever wanted).
`attachObserver(world, opts?)` mounts the panel into `document.body` (or `opts.container`)
and returns `{ dispose }`.

```
src/tools/
  index.ts            // attachObserver(world, opts), createLifecycleRecorder, types
  observer/
    panel.ts          // draggable/resizable window, localStorage layout, tabs (port of ObserverPanel shell)
    entities.ts       // entities tab: archetype walk, windowed rows, expandable component values, tag/relation chips, filter box
    loop.ts           // per-phase system table: ran-dot · runs/skips/idle% · real µs bars · flush row (from WorldObserver)
    recorder.ts       // LifecycleRecorder port: records() / nowMs() / clear() / dispose(), dead-first eviction cap
    timeline.ts       // canvas waterfall port: ms↔ticks axis, live-tail, pinch-zoom, drag-pan, tooltip, now-line
    describe.ts       // default descriptor (component-set label) + DescribeFn type
    style.ts          // injected CSS, `strata-obs-` class prefix
```

Port adaptations (beyond React→vanilla):

- **Windowed entity list.** The original rendered every entity as DOM — fine at dozens,
  dead at 100 k (the example's stress range). The entities tab renders only visible rows
  (same virtualization the timeline already does) and gets a name filter.
- **Loop readout upgrade.** The original showed run/skip only; ours shows real per-system
  µs (ring-buffer averaged), per-phase flush µs, and idle% for `runIf`-gated systems —
  strata's analog of the original's eager/lazy roles.
- **Entity display**: packed u32 handles render as `slot·gen` (unpack helpers are public).
- **Timeline kinds/colors** come from the `describe` callback; the canvas-editor example
  supplies one mapping `Kind`/gesture components to labels + colors, like the original's
  `lifecycle.ts` did for recognizers.
- **Recorder caveats documented**: cap evicts dead-first (default 4000); a 100 k stress
  spawn with the observer open holds 100 k live records — acceptable for a dev tool, noted.

## 5. Repo integration

- **tsup**: add entry `src/tools/index.ts` → `dist/tools/`; package.json `exports` gains
  `"./tools": { types, import }`.
- **Typecheck split**: root tsconfig has `lib: ["ES2023"]` with **no DOM** — that absence is
  what enforces "core never touches the browser". Keep it: root tsconfig excludes
  `src/tools`; `src/tools/tsconfig.json` extends root flags + `DOM`/`DOM.Iterable`; root
  `typecheck` script becomes `tsc --noEmit && tsc -p src/tools --noEmit`. Core stays
  DOM-free by construction, tools typecheck with DOM.
- **Tests**: core additions get unit tests (observer firing order, destroy-pre-teardown
  readability, tickCount, system naming, detach); tools logic that's testable headless
  (recorder eviction, describe fallback) gets vitest coverage; the panel itself is exercised
  by the example.

## 6. Relationship to the canvas-editor example

`plan-example-canvas.md` §6's HUD splits in two:

- **From the framework** (`strata-ecs/tools`): the Observer panel — per-system µs table, flush
  rows, entity/tag inspection, lifecycle timeline. The example just calls
  `attachObserver(world, { describe })`.
- **Stays app-side**: stress controls (`+10k`, `?count=`), simulate/culling/LOD toggles,
  pipeline-rebuild checkboxes, ECS-vs-paint frame split (paint isn't the world's to know).

This is also the positioning win: the demo moment "click any shape, watch `Selected` blink
in its component list; open the timeline and see 10,000 births land as one wall" now
belongs to the **framework**, Flecs-Explorer style — no JS ECS ships anything like it.

## 7. Sequencing (interleaved with the example milestones)

1. **T0 — core observability**: `WorldObserver` + `world.observe` + `tickCount` + system
   `name` opt; unit tests; **bench/compare re-run gate**.
2. **E0–E1** (example skeleton + editor verbs) — the host app the tool is developed against.
3. **T1 — `strata-ecs/tools` observer**: panel shell + entities tab + loop readout (recorder +
   timeline included; developed live against the example).
4. **E2–E3** as planned, with the example mounting the observer instead of hand-rolling a
   per-system HUD table.

## 8. Risks

- **Hot-path regression** from the observer branch — gated by the bench re-run (T0 exit
  criterion).
- **Observer reads during flush**: `onDestroy` fires mid-flush; the observer must treat it
  as read-only (documented contract; the recorder only reads).
- **Panel overhead polluting timings**: the 16 Hz poll and canvas timeline are outside the
  tick, so system µs stay clean; the panel throttles DOM writes and draws the timeline on
  its own rAF (as the original did).
- **Registry coupling**: tools import `schema.ts` registries directly (in-package). If tools
  are ever split into a separate package, promote a minimal public introspection API first.

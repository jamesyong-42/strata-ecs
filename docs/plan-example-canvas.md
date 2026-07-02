# Plan — `examples/canvas-editor`: the flagship infinite-canvas example

**Status: IMPLEMENTED** (MVP: T0 `e14a1bc` · E0 `aeae407` · E1 `3c0d03b` + review sweep
`08f69af` · T1 `c6b35f4` · E2 `707cff1` · E3 — each milestone adversarially reviewed and
headless-Chrome verified. §11 extensions remain open; the separate app inspector was
dropped as redundant — the `strata/tools` observer's detail pane covers it.)

An infinite-canvas whiteboard built on strata Part I, in **vanilla TypeScript** (no UI
framework), rendered with **Canvas2D**, at **MVP scope first**. It exists to answer one
question convincingly: *what does building a real editor on strata feel like, and where does
the speed show up?* It is simultaneously the demo, the reference architecture, and the
living testbed that Part III (durable/Loro) will later attach to.

Scoping decisions (locked with James, 2026-07-02): vanilla TS chrome · Canvas2D + perf
HUD · MVP first, extend later.

---

## 1. Positioning — why this example, aimed where

Every popular JS ECS presents as a game library: koota's flagship demo is a boids sim,
bitecs and becsy ship no visual demo at all, miniplex has scattered particle sandboxes.
strata's stated purpose (design.md line 3) is *editors and infinite-canvas apps, not games* —
and no ECS occupies that niche visually. Meanwhile the incumbent editors publish their own
ceilings: Excalidraw has documented unusable lag around ~5k elements (issues #7280/#628),
tldraw caps pages at 4,000 shapes and needs an R-tree to cull. Those numbers are the foil.

The spec already contains this app: **design.md §18** ("a collaborative canvas editor") is
the doc's own worked example — shapes with `Position/Size/Fill/ZIndex/Kind/Label`,
`Selected/Locked/Hidden` tags, `ConnectedTo` edges, `Camera/Grid` resources, a drag
pipeline. Everything in §18 except the `doc.transaction` and presence lines is pure Part I.
The example reuses that vocabulary verbatim: *the example is the spec made real.*

**The pitch line:** the example's only runtime dependency is `strata` itself. No React, no
state library, no renderer library. The ECS is the state manager; the frame is the
subscription.

## 2. The 60-second demo (MVP narrative)

The page loads in ~2s onto a seeded brainstorm board: ~10,000 clustered mixed shapes —
rects, ellipses, sticky notes with labels, a sprinkling of connector arrows — looking like a
product screenshot, not a benchmark grid. Top-right, always visible: the **perf HUD** — a
frame-time sparkline plus a per-system microsecond table, live.

1. **Pan/zoom** (wheel-zoom around cursor, space-drag): butter; labels greek into gray bars
   below ~35% zoom.
2. **Marquee ~5,000 shapes and drag them.** The `DragMove` HUD row stays flat under a
   millisecond. This is the exact interaction where Excalidraw-class editors visibly die.
3. **Hit SIMULATE**: all 10k shapes drift and bounce (`Integrate` row lights up, sub-ms)
   while you *keep editing* — marquee, drag, delete mid-storm. The simulate phase costs
   exactly zero when off (`runIf` gate, visible on the HUD).
4. **Click "+10k"** a few times — a toast prints "spawned 10,000 shapes in N ms"
   (strata's measured lifecycle win). The `Cull` row scales linearly but stays sub-ms,
   captioned: *full-world AABB scan, no spatial index — it's just a column sweep.*
5. **Delete a sticky note with arrows** — every arrow touching it vanishes with zero
   cleanup code (relation cascade).
6. **Click one shape**: the inspector shows its actual components live — `Position` digits
   spinning during simulate, the `Selected` tag blinking as you click (the Flecs-Explorer
   moment no JS ECS ships).
7. **Refresh the tab.** The whole board returns via `world.export()`/`import()` autosave —
   the built-in serialization no rival ECS has at all.

Every claim has a number on screen next to it.

## 3. Schema (design.md §18 vocabulary, split at the future Part-III line)

One module, `src/ecs/schema.ts`, containing **every** `define*` call, visibly split into two
halves. The split is load-bearing: *document content* is what Part III will make durable
(created only through the command funnel); *interaction state* stays runtime-only forever.
Durability is a creation path, not a flag (§11.1) — this file draws the line on day one.

**Document content** (future-durable):

| Item | Definition | Notes |
|---|---|---|
| `Position` | `{x:f32, y:f32}` | split at conflict granularity (§4/§13.4) — no fat Transform |
| `Size` | `{w:f32, h:f32}` | |
| `Fill` | `{r:u8, g:u8, b:u8, a:u8 default 255}` | |
| `ZIndex` | `{z:i32}` | row order is unstable (swap-and-pop); z is explicit app data |
| `Kind` | `{shape: enumOf({rect:1, ellipse:2, note:3})}` | explicit discriminants — durable (§8.1) |
| `Label` | `{text:string}` | notes only |
| `Velocity` | `{vx:f32 default 0, vy:f32 default 0}` | **on every shape from birth** — simulate toggles cost zero migrations (add/remove churn is our measured weak path; dense iteration over a few extra columns is our measured strength) |
| `ConnectedTo` | relation, arity `"many"` | seeded arrows; cascade-clean on destroy |

**Interaction state** (runtime-only forever):

| Item | Definition | Notes |
|---|---|---|
| `Selected` | tag | committed in bulk at gesture end, never per frame |
| `Gesture` | resource `{mode: enumOf(["idle","drag","marquee","draw"]), dx:f32, dy:f32}` | positional enum — deliberately contrasted with `Kind`'s explicit discriminants |
| `Camera` | resource `{x:f32, y:f32, zoom:f32}` | |
| `SimMode` | resource `{on:bool}` | gates the simulate phase via `runIf` |

Hover state and the marquee preview set are **plain app state** (not ECS) — flat scalar
resources can't hold them naturally, and tag-churning hover at 60Hz would demo our weak
path. MVP deliberately has no `DocKey`/`entityKey`: relations remap automatically through
snapshots, and keys become motivated only when undo/Part III arrive (per §14.3).

HMR safety (process-global registry): `schema.ts` uses a define-once `globalThis` cache
**and** `import.meta.hot.decline()` so any edit is a full page reload (autosave makes that
painless). A loud comment explains why. This is the reference pattern for all strata + Vite
apps.

## 4. Frame anatomy — pipeline and boundaries

```
DOM events (between frames)          rAF frame
──────────────────────────          ─────────────────────────────────────────
pointer/keyboard → tool state       world.sync()        ← Part I no-op, kept as the
machines → immediate world.* /                             Part III/IV attach point
setResource(Gesture/Camera),        world.tick(pipeline)
all doc mutations through           paint content canvas (dirty-gated)
app/commands.ts                     paint overlay canvas (every frame)
                                    HUD publish (~10Hz DOM text, sparkline every frame)
```

Pipeline (a plain value; HUD checkboxes rebuild it — schedule-as-data on display):

| Phase | System | Query | Showcases |
|---|---|---|---|
| `gesture` | `DragMove` (`runIf` mode=drag) | `[Position, Selected]` | tag-filtered dense column writes — the drag-5k headline |
| `simulate` (phase `runIf` SimMode.on) | `Integrate` | `[Position, Velocity]` | top-tier dense iteration; whole phase is free when off |
| `simulate` | `Bounce` | `[Position, Velocity]` | same-phase system order on value writes is load-bearing (§7.2) |
| `renderPrep` | `Cull` | `[Position, Size, Fill, Kind, ZIndex]` | brute-force full-world AABB cull into a packed draw buffer — the thesis in one HUD row |

MVP is deliberately **four small systems**. Selection commits (marquee/click), shape
creation, deletion, and duplication all happen *outside* the tick through the immediate
`world.*` surface — showcasing that half of the mutation table (§5.6) — funneled through
`app/commands.ts` (raises dirty flags; the documented spot where undo checkpoints and,
later, Part III `doc.transaction` land).

Boundaries (stated in the README as three rules):

1. All document mutation goes through `app/commands.ts` → immediate `world.*` outside the
   tick. Nothing else mutates. (This is also how content-canvas dirtiness works — there are
   no change events; the funnel is the change detector.)
2. Systems are the only users of `ctx`; per-frame math lives in systems; `Batch`
   rows/columns are consumed inside `each()` and never retained.
3. Rendering is imperative, after `tick()` returns, from the draw buffer — never a per-shape
   DOM node (that is tldraw's 4,000-shape ceiling).

MVP drag uses incremental per-frame deltas (`Position += Gesture.dxy`) — zero migrations at
gesture start. The §18 origin-stamping pattern (`DragOrigin`) arrives with the grid-snap
extension, where it becomes necessary.

## 5. Rendering — Canvas2D, dual layer, honest at scale

- **Cull → draw buffer**: `Cull` packs visible shapes into an app-side `Float32Array`
  (x, y, w, h, packed rgba, kind, z, entity) inside `each()`. Never a `Visible`/`Culled`
  tag — bulk per-frame tag toggling is our measured weak path and the buffer is our strong
  one. Survivors are z-sorted at paint (counting sort by z-bucket if profiling demands).
- **Content canvas** redraws only when camera moved ∥ doc mutated ∥ gesture active ∥
  simulate on. **Overlay canvas** (selection outlines, hover ring, marquee rect) redraws
  every frame — the Excalidraw dual-canvas / tldraw indicator-canvas pattern.
- **LOD by zoom** (tldraw's thresholds): below ~35% zoom, greek `Label` text into gray
  bars, drop strokes/shadows to solid fills. Label text for visible notes is fetched via
  `readField` at paint time — an honest, small-count use of the random-access path.
- **The HUD attributes ECS time and paint time separately.** Canvas2D will be the
  bottleneck at extreme zoom-out; the ledger must show "ECS 0.9ms / paint 8ms" so slow
  paint can never be misread as framework cost. Stress controls cap at 100k entities
  (well under the 2^20 slot ceiling).

## 6. Perf HUD (vanilla DOM + one tiny sparkline canvas)

The HUD is the credibility centerpiece and the marketing asset (designed to look good in a
screenshot crop). **Per James's direction, the profiler half is a first-party framework
tool, not app code** — see `plan-tools-observer.md`: the per-system µs table, per-phase
flush rows, entity/component inspection, and the lifecycle timeline come from
**`strata/tools`** (`attachObserver(world, { describe })`). What stays app-side in the
example's own HUD:

- Frame-time sparkline with the **ECS-vs-paint split** (ms history — a wandering line is
  more credible than a pinned 60; paint cost isn't the world's to know).
- Live query badges: `entities / visible / selected`.
- Stress controls: `+1k`, `+10k`, `clear`, `?count=` URL param (shareable links), capped.
- Toggles: SIMULATE, culling on/off, LOD on/off, per-system checkboxes (rebuild the
  pipeline value live — self-inflicted jank is the most convincing benchmark format).
- Timer honesty: µs figures come from ring-buffer averages; dev/preview server sets
  COOP/COEP headers so `performance.now()` is high-resolution.

## 7. Persistence

`world.export()` → debounced localStorage autosave (idle-scheduled, never during a
gesture) + Save/Load `.json` file buttons. Restore builds a **fresh** `World`
(import-requires-empty), swaps the single `worldRef`, and drops all transient state; the
selection survives because `Selected` tags live in the snapshot. Rule stated in README:
never cache an `Entity` handle across a restore.

## 8. Workspace integration (bench/compare precedent, hand-written — no scaffolder)

- `examples/canvas-editor/` as a pnpm workspace member `@strata/example-canvas-editor`
  (private, `type: module`). Deps: `strata: workspace:*` only. DevDeps: `vite`,
  `typescript`. **No other runtime dependency.**
- Vite consumes strata via **live source** (exact-match regex alias `/^strata$/` →
  `../../src/index.ts`, subpath aliases first, matching tsconfig `paths`) so framework
  edits hot-reload the example instantly — this example exists to drive strata's
  development. `STRATA_DIST=1` env drops the alias to verify the built dist/exports path.
- Standalone `tsconfig.json` (root has no DOM lib): ES2022, `lib: [ES2023, DOM,
  DOM.Iterable]`, `moduleResolution: Bundler`, root's strictness flags kept identical.
- **Same-commit root guards** (or root CI breaks): add `"examples"` to root tsconfig
  `exclude` (its `**/*.config.ts` include would typecheck `vite.config.ts`), add
  `"examples/"` to eslint ignores, add `examples/canvas-editor` to `pnpm-workspace.yaml`,
  add `pnpm.onlyBuiltDependencies: ["esbuild"]` (pnpm 10 blocks postinstall).
- Example gets its own `typecheck` script; root `ci` untouched. Convenience root script
  `example:canvas` → `pnpm --filter @strata/example-canvas-editor dev`.

Folder layout (~20 small files, each one lesson):

```
examples/canvas-editor/
  index.html · package.json · tsconfig.json · vite.config.ts · README.md
  src/
    main.ts               entry: build chrome, seed board, start frame loop
    ecs/
      schema.ts           ALL define* calls, doc/interaction split, HMR guard
      queries.ts          module-scope compiled queries
      pipeline.ts         buildPipeline(toggles) → plain phase() array + timing wrapper
      systems/            dragMove.ts · integrate.ts · bounce.ts · cull.ts
    app/
      worldRef.ts         createWorld + the single swappable ref
      frameLoop.ts        rAF: sync() → tick() → paint → HUD publish
      commands.ts         THE mutation funnel (dirty flags; future undo/doc.transaction seam)
      camera.ts           screen↔world math, zoom-around-cursor, zoom-to-fit
      input.ts            DOM listeners → tool machines → Gesture/Camera/commands
      tools/              select.ts · draw.ts (rect/ellipse/note) — plain state machines
      hitTest.ts          topmost-by-z point scan (collect-then-mutate rule documented)
      persistence.ts      export/import, autosave, file IO
      seed.ts             deterministic clustered board generator (?count=)
    render/
      drawBuffer.ts       packed Float32Array draw commands
      contentLayer.ts     dirty-gated Canvas2D content pass + LOD
      overlayLayer.ts     every-frame outlines/hover/marquee
    ui/
      toolbar.ts · hud.ts · inspector.ts   hand-rolled DOM, updated ~10Hz
      style.css
```

## 9. Showcase moments → named, measured strengths

| Moment | Strength it proves |
|---|---|
| Marquee 5k shapes, drag at 60fps, flat HUD row | top-tier dense/SoA iteration (ties/beats bitecs in `bench/compare`) — vs Excalidraw's documented ~5k collapse |
| "+10k in N ms" toast | entity lifecycle / in-frame spawn-reap — our measured **win** scenario |
| Sub-ms brute-force cull at 100k, no spatial index | dense column sweep as user-land code — what tldraw needs an R-tree for |
| Edit inside the simulate storm; phase costs 0 when off | pipeline-as-value + `runIf` gating |
| Delete a note, arrows bury themselves | first-class relations, cascade cleanup, generation-validated handles |
| Refresh-proof board | built-in whole-world serialization — **unique** among JS ECS |
| Inspector: Position digits spin, Selected blinks | allocation-free `readField` + introspectable model, no change-event machinery |
| System checkboxes crater/heal the sparkline | schedule-as-data; architecture as a demo control |

Anti-patterns deliberately absent (README says so): per-frame tag churn, spatial index,
per-shape DOM nodes, a second state library, uniform-grid benchmark boards.

## 10. Milestones (each lands green + committed; interleaved with `plan-tools-observer.md`)

- **T0 — core observability** (framework): `WorldObserver` hooks + `world.observe` +
  `tickCount` + system `name` opt · unit tests · **bench/compare re-run gate** (entity_cycle
  / spawn_reap / sim_frame unchanged).
- **E0 — skeleton on screen**: workspace member + root guards (same commit) · schema/
  queries/pipeline · frame loop · camera pan/zoom/zoom-to-fit · seeded clustered board ·
  `Cull` + content renderer + LOD · HUD skeleton (fps, counts).
- **E1 — it's an editor**: hit-test, click/shift/marquee selection + overlay layer ·
  `DragMove` gesture · create tools (R/O/N drag-to-size) · delete · Cmd-D duplicate (with
  timing toast) · toolbar + shortcuts.
- **T1 — `strata/tools` observer** (framework, developed against the example): panel shell ·
  entities tab · loop readout · lifecycle recorder + timeline.
- **E2 — it shows its receipts**: simulate mode (`Integrate`/`Bounce`, `runIf`) · stress
  controls + `?count=` · mounts the observer (`attachObserver`) · app HUD sparkline with
  ECS/paint split, toggles, pipeline rebuild.
- **E3 — it's a keeper**: persistence (autosave + file IO + restore discipline) · read-only
  inspector (`readField`) · README architecture walkthrough mapping each module to its
  design.md section (§4 schema, §5 command surface, §6 queries, §7 pipeline, §8 snapshots,
  §16 frame loop, §18 gestures) · visual polish pass.

## 11. Post-MVP extensions (explicitly not now, seams already in place)

Undo/redo (snapshot stack over `export()`, capped ~50, lands in `commands.ts`) · editable
inspector fields · connect tool (seeded arrows already prove the relation story) · resize/
rotate handles (`DragOrigin`/`SizeOrigin` origin-stamping pattern) · grid snap (`SnapToGrid`
+ `runIf` — §18 verbatim) · frames/grouping via `ChildOf` (seeded `Related` queries) ·
minimap (second camera over the same world) · WebGL instanced toggle (same draw buffer —
"same world, two renderers") · ghost-collaborator bots driving `commands.ts` · p95
interaction metrics (tldraw's PerformanceManager vocabulary).

## 12. Risks

- **HMR × process-global schema**: any `define*` re-run throws. Mitigation: single schema
  module, `globalThis` guard + `hot.decline()`, tested explicitly in E0.
- **Canvas2D paint ceiling** (~5-10k visible full-redraw): LOD degrades hard; HUD splits
  ECS/paint; stress capped at 100k; WebGL documented as the growth path.
- **No change events**: content dirtiness lives in the `commands.ts` funnel — one bypassing
  mutation = stale canvas that looks like a framework bug. Funnel discipline from day one.
- **Marquee-commit tag spike** (Selected on ~5-10k at pointer-up = bulk migrations, our
  weak path, one-off): budget it on the HUD; documented fallback is a `selected:u8` field
  if it exceeds ~2ms.
- **Restore invalidates handles**: single `worldRef`, tools reset to idle on restore, no
  handles in UI state.
- **Out-of-tick iteration corruption**: `world.query().each` has no command buffer —
  collect-then-mutate everywhere (hitTest documents the convention).
- **Timer credibility**: ring-buffer averages, COOP/COEP for high-res `performance.now()`.

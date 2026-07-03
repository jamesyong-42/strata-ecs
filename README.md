# strata-ecs

A collaborative **ECS** (entity-component-system) framework in TypeScript, aimed at
**editors and infinite-canvas apps** — Figma/Google-Docs-like documents — **not games**.

The name is the architecture: a stack of **strata** differentiated by how fast they
change and how long they last. A volatile query-optimized runtime sits on top; an
optional collaborative document and live presence layer underneath, projecting data
up and down across a precisely specified seam. **Nothing in the hot path pays for
durability or sync.**

> Full specification: [`docs/design.md`](docs/design.md).
> Flagship demo: the [canvas-editor example](examples/canvas-editor) — an infinite-canvas
> whiteboard in vanilla TS + Canvas2D whose only runtime dependency is `strata-ecs`.

## Architecture — four layered parts

```
 SYSTEMS (user code: queries + mutations, every tick)
        ▲ read           │ write
 ┌──────┴─────────────────▼──────────────────────────────┐
 │ PART I  — RUNTIME CORE         (strata-ecs)            │  ← feature-complete
 │   archetypes (SoA typed columns) · tag bitsets ·      │
 │   relation indices · generational-index entities      │
 └──────┬─────────────────────────────────────┬──────────┘
 ┌──────┴─────────────────────────────────────┴──────────┐
 │ PART II — STORAGE SUBSTRATE    (internal)              │
 │   snapshot ladder · projector kernel · medium-agnostic │
 └──────┬─────────────────────────────────┬──────────────┘
 ┌──────┴──────────────┐   ┌──────────────┴───────────────┐
 │ PART III — DURABLE  │   │ PART IV — EPHEMERAL           │
 │ (strata-ecs/durable)│   │ (strata-ecs/ephemeral)        │
 │ Loro CRDT · commit  │   │ Loro EphemeralStore · presence │
 └─────────────────────┘   └───────────────────────────────┘
```

Each part is meant to be adopted in order of increasing commitment. **Part I is a
usable product on its own** — a fast, local, single-user ECS. Parts III–IV are strictly
optional and quarantine Loro to exactly two adapter classes.

## Status

| Part | Import | Status |
|---|---|---|
| I — Runtime Core | `strata-ecs` | ✅ **feature-complete** — reactive tier, dev-tools + React binding, benchmarked, adversarially reviewed |
| II — Storage Substrate | (internal) | 📐 spec'd ([`docs/005-part2-spec.md`](docs/005-part2-spec.md)) |
| III — Durable Layer | `strata-ecs/durable` | ⏳ not started |
| IV — Ephemeral Layer | `strata-ecs/ephemeral` | ⏳ not started |

Part I performance (Node 24, 10k entities): a movement tick runs in **~0.23 ms**
(≈44M entity-updates/s) with no per-row allocation in the hot loop. See
[`BENCHMARKS.md`](BENCHMARKS.md) for the cross-library comparison.

## Quick start

```ts
import {
  createWorld, defineComponent, defineTag, defineQuery,
  defineSystem, phase,
} from "strata-ecs";

const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });
const Frozen = defineTag("Frozen");

const Movement = defineSystem(defineQuery([Position, Velocity]), (batch) => {
  // Columns are typed straight from the schema — `px` is a Float32Array, no cast.
  const px = batch.col(Position).x;
  const py = batch.col(Position).y;
  const vx = batch.col(Velocity).x;
  const vy = batch.col(Velocity).y;
  for (const r of batch) {           // matched rows; filters fused
    px[r] += vx[r];                  // immediate typed-array writes
    py[r] += vy[r];
  }
});

const world = createWorld();
const e = world.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 2 }]] });

world.tick([phase("sim", [Movement])]);
world.read(e, Position); // { x: 1, y: 2 }

// Save / load. Plain import needs a fresh world; import(bytes, { replace: true })
// restores IN PLACE, keeping the world's identity (the document-open path — R3):
const bytes = world.export();
world.import(bytes, { replace: true });
```

### Reactive layer — the world is the change detector

No manual dirty flags. Subscribe to a query and the framework tells you when matching
data changes; flush once per frame with `notify()`. The same signal drives the React
binding (`strata-ecs/react`).

```ts
// Vanilla: drive a repaint from a query subscription.
const stop = world.reactive.observeQuery(
  defineQuery([Position]),
  [Position],                  // columns to watch
  () => requestRepaint(),      // fires at the next notify() after a matching change
);
world.reactive.notify();       // call once per frame; fires pending observers
stop();                        // Unsubscribe when done
```

```tsx
// React: a component that re-renders only when this entity's Position changes.
import { useComponent } from "strata-ecs/react";

function ShapeInspector({ world, entity }: { world: World; entity: Entity }) {
  const pos = useComponent(world, entity, Position);
  return <div>{pos ? `${pos.x}, ${pos.y}` : "—"}</div>;
}
```

## Development

Requires **Node 24+** (see [`.nvmrc`](.nvmrc)) and **pnpm**.

```bash
pnpm install       # install dev dependencies
pnpm test          # run the test suite (vitest)
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm bench         # run benchmarks (vitest bench)
pnpm build         # bundle to dist/ (tsup → ESM + .d.ts)
pnpm run ci        # typecheck + lint + test
pnpm example:canvas # run the flagship canvas-editor demo
```

## Project layout

```
src/
  core/        Part I — the runtime core        → import: strata-ecs
  storage/     Part II — the storage substrate  (internal plumbing)
  durable/     Part III — the durable layer     → import: strata-ecs/durable
  ephemeral/   Part IV — the ephemeral layer    → import: strata-ecs/ephemeral
  tools/       dev-tools observer panel         → import: strata-ecs/tools
  react/       React binding (useComponent/…)   → import: strata-ecs/react
  index.ts     public entry (re-exports core)
examples/
  canvas-editor/    the flagship demo — infinite-canvas whiteboard
docs/
  design.md                          the full design specification
  plan-part1.md                      the Part I implementation plan
  001-system-access-declaration.md   system access rules (declared read/write)
  002-reactivity.md                  the reactive tier + change detection
  003-resource-reactivity-and-react.md  resource reactivity + the React binding
  004-part2-4-revision.md            Parts II–IV revision plan
  005-part2-spec.md                  Part II normative spec
  006-part3-4-amendments.md          Parts III/IV normative amendments
  review-part1.md                    Part I honest design review
  perf-hotpath.md                    hot-path performance notes
BENCHMARKS.md                        curated cross-library benchmark analysis
```

## License

MIT — see [`LICENSE`](LICENSE).

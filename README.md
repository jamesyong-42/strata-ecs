# strata

A collaborative **ECS** (entity-component-system) framework in TypeScript, aimed at
**editors and infinite-canvas apps** — Figma/Google-Docs-like documents — **not games**.

The name is the architecture: a stack of **strata** differentiated by how fast they
change and how long they last. A volatile query-optimized runtime sits on top; an
optional collaborative document and live presence layer underneath, projecting data
up and down across a precisely specified seam. **Nothing in the hot path pays for
durability or sync.**

> Full specification: [`docs/design.md`](docs/design.md).
> Current build plan: [`docs/plan-part1.md`](docs/plan-part1.md).

## Architecture — four layered parts

```
 SYSTEMS (user code: queries + mutations, every tick)
        ▲ read           │ write
 ┌──────┴─────────────────▼──────────────────────────────┐
 │ PART I  — RUNTIME CORE         (strata)                │  ← being built now
 │   archetypes (SoA typed columns) · tag bitsets ·      │
 │   relation indices · generational-index entities      │
 └──────┬─────────────────────────────────────┬──────────┘
 ┌──────┴─────────────────────────────────────┴──────────┐
 │ PART II — STORAGE SUBSTRATE    (internal)              │
 │   snapshot ladder · projector kernel · medium-agnostic │
 └──────┬─────────────────────────────────┬──────────────┘
 ┌──────┴──────────────┐   ┌──────────────┴───────────────┐
 │ PART III — DURABLE  │   │ PART IV — EPHEMERAL           │
 │ (strata/durable)    │   │ (strata/ephemeral)            │
 │ Loro CRDT · commit  │   │ Loro EphemeralStore · presence │
 └─────────────────────┘   └───────────────────────────────┘
```

Each part is meant to be adopted in order of increasing commitment. **Part I is a
usable product on its own** — a fast, local, single-user ECS. Parts III–IV are strictly
optional and quarantine Loro to exactly two adapter classes.

## Status

| Part | Package | Status |
|---|---|---|
| I — Runtime Core | `strata` | ✅ **feature-complete** — 147 tests, benchmarked, adversarially reviewed |
| II — Storage Substrate | (internal) | ⏳ not started |
| III — Durable Layer | `strata/durable` | ⏳ not started |
| IV — Ephemeral Layer | `strata/ephemeral` | ⏳ not started |

Part I performance (Node 24, 10k entities): a movement tick runs in **~0.23 ms**
(≈44M entity-updates/s) with no per-row allocation in the hot loop.

## Quick start

```ts
import {
  createWorld, defineComponent, defineTag, defineQuery,
  defineSystem, phase,
} from "strata";

const Position = defineComponent("Position", { x: "f32", y: "f32" });
const Velocity = defineComponent("Velocity", { x: "f32", y: "f32" });
const Frozen = defineTag("Frozen");

const Movement = defineSystem(defineQuery([Position, Velocity]), (batch) => {
  // Raw columns. (Precise per-field typing — Float32Array here — is a planned
  // ergonomic improvement; for now cast to the backing array.)
  const px = batch.col(Position).x as Float32Array;
  const py = batch.col(Position).y as Float32Array;
  const vx = batch.col(Velocity).x as Float32Array;
  const vy = batch.col(Velocity).y as Float32Array;
  for (const r of batch) {           // matched rows; filters fused
    px[r] += vx[r];                  // immediate typed-array writes
    py[r] += vy[r];
  }
});

const world = createWorld();
const e = world.spawn({ components: [[Position, { x: 0, y: 0 }], [Velocity, { x: 1, y: 2 }]] });

world.tick([phase("sim", [Movement])]);
world.read(e, Position); // { x: 1, y: 2 }

// Save / load (non-collaborative)
const bytes = world.export();
const restored = createWorld();
restored.import(bytes);
```

## Development

Requires **Node 24+** and **pnpm**.

```bash
pnpm install       # install dev dependencies
pnpm test          # run the test suite (vitest)
pnpm test:watch    # watch mode
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm bench         # run benchmarks (vitest bench)
pnpm build         # bundle to dist/ (tsup → ESM + .d.ts)
pnpm ci            # typecheck + lint + test
```

## Project layout

```
src/
  core/        Part I — the runtime core        → export: strata
  storage/     Part II — the storage substrate  (internal plumbing)
  durable/     Part III — the durable layer      → export: strata/durable
  ephemeral/   Part IV — the ephemeral layer      → export: strata/ephemeral
  index.ts     public entry (re-exports core)
docs/
  design.md         the full design specification
  plan-part1.md     the Part I implementation plan
```

## License

MIT

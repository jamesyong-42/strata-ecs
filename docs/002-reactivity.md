# Patch Note 002 — Local-Runtime Reactivity (observe/react to component changes; React integration)

**Status:** Proposed — amended 2026-07-02 after an implementation-fit + adversarial review against the code as built. The four soundness fixes: stamping re-anchored to the shared structural primitives (§2.2), the frame-counter off-by-one resolved (§4.1a), membership versions moved into the store and extended to tag/relation filters (§4.2), and blanket-stamp scope specified (001 §3.1).
**Scope:** Part I (runtime core) — a reactive *read* layer over runtime column changes. Local-runtime only.
**Baseline:** `design.md` (locked). This note is an *amendment*; it does not modify the baseline. §N references point into the locked doc.
**Depends on:** **Patch Note 001** (System Access Declaration) — lands together with this note (001's enforcement only arms here).
**Companion binding:** `@strata/react` (a thin adapter package; see §5). The core layer is framework-agnostic.
**Naming:** `world.reactive.*` is deliberately disjoint from the shipped `world.observe(WorldObserver)` (T0): the telemetry hooks fire mid-flush under a must-not-mutate/never-throw contract for dev tools; reactive observers fire at the settled boundary and may *schedule* work. Two different contracts, two different names — nothing here touches `world.observe`.

---

## 0. Scope, and what this deliberately is not

This is **Part B of the reactivity design** (Part A is Patch Note 001). It specifies the layer that lets user code **observe and react to component value changes** — a specific entity's `Position`, or "did anything matching this query change" — and integrates cleanly with React via `useSyncExternalStore`.

Two scoping decisions, both settled and both load-bearing:

1. **Local-runtime only.** Reactivity observes **local runtime column changes** — nothing from Parts III–IV. It does *not* react to remote durable edits or ephemeral presence through this layer. (Those layers already compute their own change information — reconcile facts, ephemeral blob-diffs — and *could* be wired in later as additional feeds; that is explicitly out of scope here and noted as future work in §6.) This keeps the layer entirely within Part I, congruent with §0's "Part I usable on its own."
2. **Poll-at-boundary, never push-per-write.** There are **no callbacks on the hot path.** Change detection is column version stamps compared at a single point per frame; the hot loop writes raw floats and knows nothing. This is the flecs/DOTS change-detection model, not a per-write event model — the only model compatible with the baseline's hot-path thesis (§3, "no per-row object allocation in the hot loop").

The layer changes **no timing rule in §0** (value writes stay immediate, structure stays deferred), no placement/migration (§5.5), and no query semantics (§6). It is an additive *read/observe* surface plus one new point in the tick.

---

## 1. The change, in one paragraph

Each `(archetype, component)` column gains a `lastWrittenFrame` stamp, bumped (off the hot path) when a system writes a column it declared in `access.write` (Patch Note 001), when the structural flush migrates an archetype, or when an out-of-tick `world.edit()` writes. A new **reactive phase** runs once per tick, after all systems and the flush, when the world is fully settled: it compares stamps against per-observer state and fires the observers whose watched data changed. Observers come in three tiers of increasing precision and cost — **query-level** (did anything matching this query change), **entity-level** (did this entity's component change), **value-level** (did this entity's component *value* actually differ) — and a thin React binding maps the value tier onto `useSyncExternalStore`. Cost is proportional to *what is observed*, never to world size; nothing touches the hot loop.

---

## 2. Change detection (the substrate)

### 2.1 The stamp

- One counter, **owned by the store** (amended): `store.frame`. It must live where the stamping chokepoints live — `writeComponent`, `place/unplace/migrate` are all `RuntimeStore` methods, and the World's `tickCount` is private to the World and semantically different (ticks run, not observation frames; a fixed-timestep app runs several ticks per frame). `world.reactive.frame` exposes it read-only. **It increments at the END of each `reactive.notify()` pass** — not at tick top — see §4.1a; this is what makes out-of-tick writes observable.
- One stamp per `(archetype, component)` (amended): our columns are per-**field** (`Map<FieldId, Column>`) and the `Column` objects are *replaced* on growth, so a stamp cannot ride the column object. It lives in a **per-archetype parallel array** `lastWrittenFrame: number[]`, indexed by the component's position in the archetype's sorted `componentIds` (the arrays are short; `FieldMeta.component` lets `writeComponent` find the slot without a lookup structure).

A column is **stamped** by setting its slot to `store.frame`. An observer detects change by comparing a stored `lastSeenFrame` against the stamp: newer ⇒ changed.

### 2.2 Where stamps come from (amended: anchored to the shared primitives, not the flush)

**The master gate (amended after the bench A/B gate):** every stamp/bump site below is guarded by a store-level flag flipped **once, when `world.reactive` is first accessed** — the same branch-on-null discipline as the dev-tool observer roster. This is not optional politeness: the always-on variant measured **+17–28% on migrate-heavy scenarios** (add_remove, toggle_frame) in the interleaved bench gate, because migrate's added-column stamping is a per-migration loop. A world that never touches reactivity pays literally zero stores; observers baseline at registration, so stamps skipped before the first `world.reactive` access are unobservable by construction.

The original draft anchored structural detection to the command-buffer flush — **wrong against both the baseline and the code as built**: §5.6 defines mutation paths that never touch the flush (immediate `world.*` outside ticks — how the canvas example does nearly *all* its structural mutation — and, later, projection at `sync()`). The flush is just a dispatcher into the same primitives the immediate path calls. So stamping/versioning lives **in the shared primitives**, where every path converges:

1. **System value writes.** After a system runs, the tick stamps per 001 §3.1's two routes: blanket over query-matching archetypes (with the `hasComponent` guard) + precise stamps at the `writeComponent` chokepoint for edit-path writes. Resolves 001's open decision #1 — see §2.3.
2. **Structural primitives.** `place`/`unplace` bump their archetype's rows-version; `migrate` additionally stamps the *added* components' columns in the destination archetype; tag and relation mutations (including the cascade cleanup inside `destroy`) bump the tag/relation version (§4.2). One integer store inside ops already doing O(fields) work — and because the flush, the immediate `world.*` surface, and future projection **all call these same primitives**, every mutation path is covered identically with no per-path code. (`projectComponent`'s overwrite branch also stamps — one line — so the future durable/ephemeral feeds aren't silently dark.) **No structural access declaration is needed** (001 §5 keeps structure out of `access`); the primitives are the information.
3. **Out-of-tick value writes.** A `world.edit(e).set(C, v)` from an input handler between frames (§5.2, immediate path) stamps at the same `writeComponent` chokepoint. With the frame counter incrementing at the END of `notify()` (§4.1a), the stamp carries a frame number strictly greater than every observer's `lastSeenFrame` — the original draft's "stamp against the current frame" lost exactly these writes (§4.1a).

**Not a stamp source (by design):** raw column writes outside any system and outside `edit()` — e.g. a `world.query(...).each` walk that pokes typed arrays directly. Nothing can see those. The rule is: out-of-tick *bulk* value work goes through a (one-shot, `runIf`-gated) system; out-of-tick *per-entity* writes go through `edit()`. For escape hatches there is `world.reactive.invalidate(C)` — a manual whole-component stamp — but reaching for it usually means the write belonged in a system.

### 2.3 Resolving 001's open decision #1 — blanket-stamp is the default; lazy is opt-in

001 deferred whether a system stamps its whole `access.write` set (blanket) or only columns it actually wrote (lazy). **Default: blanket.** After a system runs, stamp every column in its `access.write`. Rationale:

- **Zero per-write cost.** Blanket stamping is a handful of integer writes *per system per frame* (one per declared write column), never per element. The hot loop is untouched. Lazy stamping requires a write-accessor with a branch on first-write-per-column-per-frame — cheap, but non-zero on the hot path, which the thesis resists.
- **Over-firing is absorbed by the value tier.** Blanket's imprecision is that a system declaring `write: [Position]` stamps `Position` even on a frame it conditionally didn't write it (Rule 1 of 001: the declaration is the envelope). This produces a spurious *query-tier* (Tier 1) fire. But the **value tier (Tier 3) suppresses it** via its equality check (§3.3): the value didn't change, so no notification reaches React. So the cases that care about spurious fires (React views) are already protected, and the cases that don't (a canvas re-rendering because "something in this archetype moved") tolerate the occasional extra fire cheaply.
- **Lazy remains available as opt-in.** A system for which even a spurious Tier-1 fire is costly may use a lazy write-accessor (`batch.colW(C)`, which stamps `C` on first actual write this frame) instead of `batch.col(C)`. This is a per-system choice: `access.write` grants permission and defines the blanket candidate set; the accessor choice tunes stamping precision. Default blanket; reach for `colW` only where measured to matter. **Deferred:** `colW` is not in the first implementation round — the shipped layer offers blanket stamping only, with `runIf`-gating (001 §3.4) as the way to keep conditional writers quiet; `colW` lands when a measured case needs it.

---

## 3. The observer layer — three tiers as a visible ladder

The tiers have genuinely different costs (a ~1000× spread), so — per the baseline's ethos that the mechanism should be honest about what it costs (§0) — they are **three distinct methods**, not one `observe()` that hides the granularity. The user picks the precision that matches the need.

```ts
interface Reactive {
  // TIER 1 — query-level. Fires when ANY matching archetype's watched column stamped,
  //   OR the query's membership changed (§4.2). Cheapest, coarsest.
  observeQuery(plan: QueryPlan, cols: Component[], cb: () => void): Unsubscribe;

  // TIER 2 — entity-level. Fires when THIS entity's component column stamped
  //   (fires even if the value is equal — column-granular).
  observeEntity<S>(e: Entity, c: Component<S>, cb: (v: S | undefined) => void): Unsubscribe;

  // TIER 3 — value-level. Fires ONLY when THIS entity's component VALUE actually differs
  //   (equality-checked against the previous value). Suppresses spurious fires.
  observeValue<S>(e: Entity, c: Component<S>, cb: (v: S | undefined) => void,
                  eq?: (a: S, b: S) => boolean): Unsubscribe;

  // The settled point — user-called once per frame after all ticks (§4.1); no-op when empty.
  notify(): void;
  // Tier 3's boxed value (the React binding's stable getSnapshot, §5).
  peek<S>(e: Entity, c: Component<S>): S | undefined;
  // Escape hatch: manual whole-component stamp for writes no chokepoint can see (§2.2).
  invalidate(c: Component): void;
  // Read-only view of the frame counter (§2.1/§4.1a).
  readonly frame: number;
}
```

`world.reactive` exposes this; it is a Part-I object, present whether or not any layer is attached. Registering the first observer is what switches on 001's dev-mode `access` enforcement (001 §2.4) — the tax is tied to the feature.

### 3.1 Tier 1 — query-level (column stamps only)

Backed purely by stamps. The observer stores `lastSeenFrame` and the query's `lastSeenMembershipVersion`. At the reactive phase, it is **dirty** if either (a) any archetype matching `plan` has a watched column (`cols`) with `lastWrittenFrame > lastSeenFrame`, or (b) the membership version changed (§4.2). Cost: a few integer compares per observed query per frame (one per matching archetype per watched column). Drives "re-render the canvas when any shape moved" — no per-entity work at all. This is the tier most React *views* use: a list re-renders when *anything* in it changed, and per-entity precision is unnecessary.

### 3.2 Tier 2 — entity-level (the watched set)

Column stamps are archetype-wide, too coarse for "watch this one entity." So the layer maintains a **watched set** per component: `Map<Component, Set<Entity>>`, holding only the specific rows under observation. At the reactive phase, for each watched component whose column stamped in *some* archetype, iterate that component's watched set — the handful actually subscribed to, often size 1 ("the selected shape") — and for each watched entity whose row is in a stamped archetype, fire `cb` with the current value (via `get`, §3.4). **Cost is proportional to observer count, never world size**: watching N entities costs O(N), independent of how many entities exist. This is the core discipline — reactivity you can afford because you pay for what you observe.

### 3.3 Tier 3 — value-level (equality-checked)

Tier 2 plus a **stored previous value box** per watched `(entity, component)`. At the phase, when Tier 2 says "this entity's column stamped," read the current value, run `eq` (default: shallow structural equality over the component's fields) against the stored box; fire *only* if different, then replace the box. This suppresses spurious fires — setting `x` to the same number, or a blanket over-stamp (§2.3) on a frame the value didn't actually change. The stored box does **double duty**: it is exactly the stable reference the React binding's `getSnapshot` returns (§5). Cost: Tier 2 + one read + one equality check + boxed storage per watched cell.

**The ladder, honest about cost:** Tier 1 is O(archetypes-per-query) integer compares; Tier 3 is O(watched) reads + equality + storage. "Watch the collection" and "watch one shape's exact value with no spurious fires" are ~1000× apart, and the API makes the user say which they are paying for.

### 3.4 Observer reads use `get`, not `read` — and entity death is defined

Observers read the current value with **`get` semantics** (`S | undefined`), never `read` (which throws on absent). This is mandatory and inherits directly from the locked design's read split and its D-series dynamics finding (§ the `get`/`read` guidance and §13.5): a watched entity can be **despawned** — including, in a collaborative app, by a remote peer at a `sync()` boundary — and the observer must survive it. On despawn, the entity's generation bumps (§5.4, `ctx.destroy` at flush; the immediate-path despawn likewise), so the observer's stored handle goes stale. At the next reactive phase:

- Tier 2/3: the watched-set entry reads `get(e, c)` → `undefined` (generation mismatch) → the observer **fires once with `undefined`** (so React can unmount / fall back) and **self-removes** from the watched set and value-box store.
- **Amended — eager cleanup closes the generation-wrap hole.** "The dead handle can never match the slot's next occupant" is only true for the first 4095 recycles (§2's documented wrap); a mounted React subscription is exactly the long-lived handle the wrap defense assumed away, and a wrapped re-issue would make a stale watch silently fire with a *different entity's* value. So the reactive layer additionally registers **one internal death hook** when the first entity/value watcher registers: on destroy of a watched entity, the watch fires `undefined` and is removed **at that pass**, not lazily. The `get`→`undefined` path remains as the belt-and-braces fallback; with eager cleanup, no watch survives long enough to be ABA'd. **Implementation note (amended):** this hook is a *dedicated internal store slot*, **not** `world.observe` — routing it through the T0 observer roster would flip the roster non-null and tax every tick with per-system `performance.now` timing, so the reactive death path must stay off the tools' cost. It still fires pre-teardown and only *queues* the entity; the undefined-fire happens at the next `notify()`.
- **Component removal (not death), amended.** A watched entity can lose `c` while still alive (an `edit`/migrate that removes the component). At the next phase, if the entity is alive but `c` is absent, the observer **fires once with `undefined`** and clears its boxed value, but **keeps the watch** — a later re-add of `c` re-fires normally via migrate's added-column stamp (§2.2). Only despawn removes the watch. This is what stops `peek` from serving a stale value after the component is gone.

---

## 4. The reactive phase, and the one subtle piece

### 4.1 Where it runs (amended: an explicit user-called step, not baked into tick)

The original draft ran `notifyObservers()` inside every `world.tick()`. **Wrong for the baseline's own frame model**: §16.2 explicitly blesses multiple ticks per frame (fixed timestep — "tick the sim pipeline N times, then the render-prep pipeline once") and multi-cadence pipelines; notification inside tick would fire N storms per frame, falsifying §5's "React reconciles at most once per frame". The loop is user-owned (§16.2), so the reactive step is a **user-called line in the loop**, matching `sync()`'s shape exactly:

```
function frame() {
  world.sync();                    // inbound (no-op in pure Part I)
  world.tick(simPipeline);         // as many ticks as the frame needs…
  world.tick(renderPrepPipeline);  //   …none of them notify
  world.reactive.notify();         // ONE settled point: compare stamps, fire dirty observers
  render(world);
}
```

Inside `tick`, the only additions are the per-system stamps (001 §3.1); the flush needs no reactive code of its own — the primitives it calls already bump (§2.2). `reactive.notify()` is a no-op with zero registered observers (pure Part I pays nothing), and an app that never calls it simply has inert stamps.

Because notification runs at **one defined point with the world consistent**, React never observes a half-applied frame — it always renders a coherent world state.

### 4.1a Frame-counter semantics (amended: the off-by-one, fixed)

All stamps — in-tick and out-of-tick — use the **current** `store.frame`, and `reactive.notify()` increments the counter **at the end of its pass**: compare, fire, then `frame++`. Consequences, stated exactly:

- During frame F, every write (systems, flush-driven migrations, out-of-tick input handlers between the previous `notify()` and this one) stamps F. Observers' `lastSeenFrame` is F−1 or older, so all of it is observed at this pass. After the pass, `frame` becomes F+1.
- **Registration is a frame boundary (amended).** A fresh observer must land on that same `lastSeen = F−1` footing, or a change made in the *same* frame as its registration (stamp F, `lastSeen` also F, strict `>`) is silently lost forever. So each `observe*` **advances the counter and baselines the observer at `frame − 1`**: writes stamped before the subscription (≤ the pre-registration frame) never fire; writes stamped after it (the new current frame) are observed at the very next `notify()`. No priming pass is required — subscribe, mutate, `notify()` sees it.
- The original draft stamped out-of-tick writes "against the current `world.frame`" with the increment at tick TOP — under which an input-handler edit after tick N's notification stamped N, compared `N > N` at the next pass, and was **silently never observed**. The end-of-pass increment removes the hole with no special-casing of write sources.

### 4.2 The membership-version (amended: store-owned, and covering tag/relation filters)

Tier 1 must fire when query **membership** changes — an entity gains `Position` and now matches — not only when values change. Column stamps don't capture membership. Two corrections to the original draft:

**Where the version lives.** NOT on the `Query` object: a compiled `Query` is deliberately store-agnostic and shared across worlds — the canvas example holds module-level queries across `world.import()` swaps, so per-query state on the plan would cross-contaminate worlds. Versions live in the **store's per-query cache** (the same structure that already caches each query's matching-archetype list).

**What bumps it — three signals, all in the shared primitives (§2.2), covering every mutation path:**

- a per-archetype `rowsVersion`, bumped in `place`/`unplace` (covers spawn/despawn/migrate — rows gained or lost — from the immediate path AND the flush identically);
- the **existing archetype-creation hook** (the store already notifies query caches when a new archetype starts matching — §3.1 lazy creation) bumps the affected queries directly;
- one global `tagRelVersion`, bumped by tag/relation mutations. **The original draft missed this class entirely**: `world.addTag(e, Selected)` moves no archetype rows, yet changes membership of every tag-filtered query (`[Position, Size, Selected]`). Only queries with row filters consult it — a coarse signal, but tag-filtered Tier-1 observers are rare and the alternative (per-tag versions) is bookkeeping v1 doesn't need.

Tier 1 is dirty if a watched column stamped, **or** any matching archetype's `rowsVersion` advanced, **or** (row-filtered queries only) `tagRelVersion` advanced — all compared lazily inside the loop Tier 1 already runs over the query's matching archetypes; no inverse archetype→queries index exists or is needed. Tiers 2/3 don't consult membership: they observe *specific entities*, and departure is the death path (§3.4).

---

## 5. The React binding (`@strata/react`)

Thin, over React 18's `useSyncExternalStore`, which wants exactly `subscribe(cb)` + `getSnapshot()` and re-renders when the snapshot would differ:

```ts
function useComponent<S>(e: Entity, c: Component<S>): S | undefined {
  return useSyncExternalStore(
    cb => world.reactive.observeValue(e, c, cb),   // Tier 3: register watch; returns unsubscribe
    () => world.reactive.peek(e, c),               // returns the boxed value — stable ref until a real change
  );
}
```

**Amended — `useQuery`/`queryResult` are cut from v1.** The draft's cached-`Entity[]` snapshot had no assigned owner, and its rebuild is O(matching entities) per dirty frame — for a world-sized query that contradicts "cost proportional to what is observed" outright, and under blanket stamping its identity churns every frame a declared writer runs (an infinite-re-render footgun for exactly the users `useSyncExternalStore` is meant to protect). v1 ships `useComponent` (Tier 3) as the headline; list views subscribe with `observeQuery` (Tier 1) and maintain their own arrays — which is what a canvas/list renderer does anyway. A future `useQuery` needs a specified cache owner and an incremental membership diff; deferred until someone actually needs it. The binding is client-only in v1 (`getServerSnapshot` unaddressed — strata worlds don't SSR).

Three properties make this correct:

- **Stable references.** `peek` returns Tier 3's value box — a reference stable until the value actually changes. This satisfies `useSyncExternalStore`'s hard requirement — a snapshot that returns a fresh reference every call causes an infinite render loop. The value tier already stores the previous state, so the stable reference falls out for free. (List views subscribe with `observeQuery` (Tier 1) and maintain their own arrays; the cut `queryResult` cache is deferred, §5 amendment.)
- **Frame cadence.** Observers fire once per tick at the reactive phase. React reconciles at most once per frame per changed subscription. Tier 3's equality check keeps incidental UI (a properties panel) from re-rendering on frames where the watched value didn't actually change, while a canvas view (Tier 1) re-renders whenever anything moved — the right behavior for each.
- **Unmount / death.** Entity despawn → `peek` returns `undefined` and the observer fires (§3.4) → the component renders its `undefined` branch (fallback / unmount). Congruent with the `get`-not-`read` rule; no stale render.

The binding is a **separate package** so the core reactive layer stays framework-agnostic (a Vue/Svelte/vanilla binding is the same three primitives over a different adapter). The core ships `Reactive`; `@strata/react` ships the hooks.

---

## 6. Non-goals and boundaries

- **Not remote/collaborative change.** Local runtime only (§0). Durable reconcile facts and ephemeral blob-diffs are *not* fed into observers here. They are viable **future** feeds (both layers already compute per-cell change information — reconcile classification, the ephemeral last-seen-blob diff), and wiring them in would let a React view react uniformly to local edits, a collaborator's durable edits, and remote presence through one hook. Explicitly deferred; noted so the seam is visible.
- **Not push-per-write.** No hot-path callbacks; poll-at-boundary only (§0, §2).
- **Not a new timing rule.** §0 unchanged. Value writes immediate, structure deferred — reactivity only *reads* at the boundary.
- **Not effectful observers mid-frame.** Observers fire at the reactive phase (§4.1), after the world settles — never mid-system. An observer callback that mutates the world does so *after* the frame, through the normal surfaces (it must not re-enter iteration); the safe pattern is to schedule work for the next tick, same as the ephemeral "stage after tick" pattern the baseline describes. (A dev-mode guard rejects structural mutation from within a `reactive.notify()` callback, reusing the store's existing observer-emit reentrancy flag.)
- **Observers do NOT survive `world.import()` / world swaps (amended).** `import()` requires an empty world, so restore replaces the World instance — and a fresh world re-mints the same dense slot/generation sequence, so a carried-over watch could *validly alias an unrelated entity*. The reactive registry belongs to its world and dies with it; apps re-subscribe after a swap (the canvas example's `onRestore` re-attach discipline, already established for the observer panel, is the pattern).
- **Resource reactivity: REQUIRED fast-follow, not optional (amended).** One version counter per resource, bumped in `setResource`; a Tier-1-equivalent `observeResource(R, cb)`. Promoted from "natural extension" because the flagship example's hottest changing value — the `Camera` — is a resource: without this, the example's repaint logic keeps a manual `dirty.camera` flag forever, and the "reactivity dissolves the dirty flags" story stays half-told. Kept out of v1's diff only to keep the first cut reviewable; it should land in the same release train.

---

## 7. How this folds into the (locked) doc — ripple map

Nothing below is applied to the locked baseline; this maps where a future edition would integrate 002, against real anchors.

| Baseline anchor | Integration |
|---|---|
| §7.2 / §16 (the tick; § line 852, § line 2486) | Ticks gain only the per-system stamps; `world.reactive.notify()` is a **user-called line in the §16.2 frame loop**, after all ticks (§4.1). |
| §6.1 (`QueryPlan`) | **No change to the plan object** — membership versions live in the store's per-query cache (§4.2); the compiled plan stays store-agnostic. |
| §5.4 (command buffer / flush) | **No reactive code in the flush itself** — the shared structural primitives it dispatches into carry the stamps/versions (§2.2), covering the immediate path and future projection identically. |
| Part I API reference (near `read`/`get`, § line 1042) | Add the `Reactive` interface (`observeQuery`/`observeEntity`/`observeValue` + `peek`/`invalidate`) and `world.reactive`. |
| §3 column storage | Add `lastWrittenFrame` per `(archetype, component)` column (§2.1). |
| A new subsection (e.g. §7.4 "Reactivity") or a short Part I addendum | The conceptual home: the three tiers, poll-at-boundary, the reactive phase, cost ladder. |
| §0 (timing table / overview) | **No change** — reactivity adds no timing rule. |
| Patch Note 001 §6 | Mark open decision #1 (blanket vs lazy) **resolved: blanket default, lazy opt-in** (§2.3), and #2 (tiers/membership/React) **resolved** by this note. |
| `@strata/react` | New companion package (§5); not part of the core doc, referenced from the reactivity subsection. |

---

## 8. Summary

Reactivity lands as a **poll-at-boundary read layer** that never touches the hot path: column version stamps (bumped off-hot-path from `access.write`, the flush, and out-of-tick writes), compared once per frame at a new reactive phase when the world is settled. Three tiers — query / entity / value — form a visible cost ladder from O(archetypes) integer compares to O(watched) equality checks, so the user pays for the precision they ask for. Entity death is defined through the existing `get`/generation-bump invariants; the React binding is a thin `useSyncExternalStore` adapter whose stable references fall out of the value tier's boxing. It is local-runtime only, adds no timing rule, breaks no baseline promise, and resolves both decisions 001 deferred. The collaborative feeds (durable reconcile, ephemeral diff) are a visible, deferred future extension.

# Patch Note 003 — Resource Reactivity + the `strata-ecs/react` binding

**Status:** Proposed
**Scope:** Part I — extends the shipped reactivity layer (002, commit `bbaf9f3`) to resources, and ships the React binding 002 §5 specified.
**Depends on:** 001+002 as implemented (`world.reactive`, the `reactiveOn` master gate, registration-as-frame-boundary, the boxed Tier-3 pattern).
**Resolves:** 002 §6's "resource reactivity: REQUIRED fast-follow" and 002 §5's companion binding.

---

## 1. Resource reactivity

### 1.1 Why (one sentence)

The canvas example's hottest changing value — the `Camera` — is a resource, and without this it keeps a manual `dirty.camera` flag forever; with it, `dirty` shrinks to the single honest app-state force channel 002 predicted.

### 1.2 The stamp

- One `lastWrittenFrame` per resource, in a store-owned dense array indexed by `ResourceId` (ids are dense; grow lazily to `resourceById`'s ceiling). NOT on the stored value object (it is replaced wholesale by every `setResource`).
- Bumped in **`setResource` only** — the single write chokepoint (resources have no column path, no structural path; `getResource`'s aliased object *can* be mutated in place, but that is already documented as a contract violation the framework does not see). **Behind the `reactiveOn` master gate**, like every other stamp site.
- Same frame model as 002 §4.1a: stamps carry the current `store.frame`; `notify()` advances at end-of-pass; out-of-tick `setResource` between passes is therefore always observed.

### 1.3 The observer

```ts
// on world.reactive — Tier-3 semantics (boxed, equality-suppressed), because setResource
// replaces the stored object wholesale, so identity alone cannot mean "changed":
observeResource<S>(r: Resource<S>, cb: (v: S | undefined) => void,
                   eq?: (a: S, b: S) => boolean): Unsubscribe;
// the boxed last-delivered value — the React binding's stable getSnapshot:
peekResource<S>(r: Resource<S>): S | undefined;
```

- **Registration is a frame boundary** (identical to the other tiers): `advanceFrame()` then baseline `lastSeen = frame − 1`; the box primes to the current value at registration; registration never back-fires.
- At `notify()` (a new pass between Tier 1 and the entity tiers): if the resource's stamp > `lastSeen`, read `getResource`, compare against the box with `eq` (default: shallow equality over the resource's fields), fire only on a real change, replace the box.
- **No death path**: resources cannot be removed; `undefined` is only ever delivered for a never-set resource that a later pass still finds unset (i.e. never — a stamp implies a set). A watch lives until unsubscribed or the world dies.
- Same lifecycle boundaries as 002 §6: watches do not survive `world.import()`/world swaps; callbacks are read-only (the emit reentrancy guard applies) and must not throw (swallowed + `devError`).

### 1.4 Example integration (the payoff)

`dirty.camera` is deleted. Camera mutations (`panBy`/`zoomAt`/`setViewportSize`/`zoomToFit`/restore) call `syncCameraResource()` immediately instead of raising a flag — `setResource` per input event is a validated small-object write, the same order of cost the flag machinery had. `reactivity.ts` adds `observeResource(Camera, () => { repaint.doc = true; })` (camera changes are view-only — NOT wired to autosave; the viewport rides snapshots but per-pan autosave churn is noise, and any doc edit saves it anyway). The frame loop's painted condition becomes `repaint.doc || dirty.doc` and the pre-tick camera-sync-on-dirty step disappears (the resource is always current).

## 2. `strata-ecs/react`

### 2.1 Packaging (deviation from 002 §5's "separate package", deliberately)

Shipped as the **`strata-ecs/react` subpath export** (like `strata-ecs/tools`): entry `src/react/index.ts` → `dist/react/`. The core still never imports React — the separation 002 wanted is the *dependency direction*, and a subpath preserves it while keeping one repo, one version, one publish. `react >= 18` becomes an **optional peerDependency**. Root devDeps gain `react`, `react-dom`, `@types/react`, `happy-dom` (tests only; none enter the publish graph).

### 2.2 The hooks (v1: exactly two)

```ts
function useComponent<S>(world: World, e: Entity, c: Component<S>): S | undefined;
function useResource<S>(world: World, r: Resource<S>): S | undefined;
```

Both are thin `useSyncExternalStore` adapters:
- `subscribe` = `world.reactive.observeValue(e, c, onStoreChange)` / `observeResource(r, onStoreChange)` — returns the Unsubscribe directly.
- `getSnapshot` = `world.reactive.peek(e, c)` / `peekResource(r)` — the Tier-3 box: stable reference until a real change, exactly `useSyncExternalStore`'s requirement.
- `getServerSnapshot` = the same function (prevents an SSR hard-crash; the binding is semantically client-only — strata worlds don't SSR — and the docs say so).
- Entity death delivers `undefined` once (002 §3.4) → the component renders its undefined branch. World swaps: the caller re-renders with the new `World` (worldRef pattern); hooks keyed on `world` re-subscribe via `useSyncExternalStore`'s subscribe identity — implement `subscribe` with `useCallback([world, e, c])` so a swapped world triggers resubscription.
- **No `useQuery` in v1** — the 002 amendment stands (unowned O(world) snapshot cache). List views subscribe with `observeQuery` and manage their own arrays.

### 2.3 Tests

`src/react/react.test.tsx` under `happy-dom` (`// @vitest-environment happy-dom`), driving real `react-dom/client` roots inside `act()`: value renders; a `world.edit()` + `notify()` re-renders with the new value; equality-suppressed writes do NOT re-render; entity death renders the undefined branch; `useResource` re-renders on `setResource` + `notify()` and not on equal-value sets; unmount unsubscribes (no fire after unmount); a world-swap re-subscribes. The tools tsconfig pattern applies: if the root program needs isolation from JSX/react types, `src/react` gets its own tsconfig half in the `typecheck` chain.

## 3. Ripple

| Anchor | Change |
|---|---|
| 002 §6 resource bullet | Mark resolved by this note. |
| 002 §5 | Note the subpath packaging + that `useResource` ships alongside `useComponent`. |
| `docs/plan-example-canvas.md` | `dirty.camera` removal noted once landed. |
| exports map / tsup | `./react` entry, react optional peer. |

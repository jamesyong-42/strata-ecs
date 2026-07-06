/**
 * `@vibecook/strata-ecs/react` — the React binding for the reactive layer (Patch Note 002 §5, amended by 003 §2).
 *
 * Two hooks, each a `useSyncExternalStore` adapter over `world.reactive`'s Tier-3 channel:
 *
 *   import { useComponent, useResource } from "@vibecook/strata-ecs/react";
 *   const pos = useComponent(world, entity, Position);   // S | undefined
 *   const cam = useResource(world, Camera);              // S | undefined
 *
 * The design the spec describes: `subscribe` registers a Tier-3 watch (equality-suppressed at the
 * settled `reactive.notify()` boundary, 002 §4.1 — notify is user-called, the app's frame loop), and
 * `getSnapshot` returns the watch's boxed value — a reference stable until the value actually changes,
 * which is exactly what `useSyncExternalStore` requires (a fresh reference every call spins an infinite
 * render loop). An equal-value write never re-renders; a real change re-renders once.
 *
 * `subscribe` is keyed on `[world, e, c]` (resp. `[world, r]`): when any change — most importantly a
 * **worldRef swap** (002 §6: watches die with their world; the app re-renders with the new `World`) —
 * its identity changes, so `useSyncExternalStore` tears down the old watch and re-subscribes.
 *
 * `useComponent` needs two corrections that the raw `reactive.peek` cannot provide on its own, because
 * React calls `getSnapshot` at moments the core's `peek` was not built for (both verified in
 * react.test.tsx; both are noted for the core in the PR message — the intended long-term home is core):
 *
 *   1. **Reference stability before the subscription exists.** `useSyncExternalStore` calls
 *      `getSnapshot` during the first render, BEFORE the subscribe effect runs — so no Tier-3 box
 *      exists yet and `peek` falls back to a fresh `get` decode, a NEW object every call. That is the
 *      "getSnapshot should be cached to avoid an infinite loop" contract violation. We memoize the last
 *      snapshot and keep returning it while it stays shallow-equal to the next read, so the reference is
 *      stable across calls (once subscribed, `peek` returns the stable box and this is an `Object.is` no-op).
 *   2. **Death must read as `undefined` immediately.** The core's death paths now null the Tier-3 box
 *      BEFORE firing (this binding's tests originally caught them firing first, which made `peek` serve
 *      the stale box to a synchronous `getSnapshot` and React skip the re-render — fixed in
 *      reactive.ts's drainDeaths + fallback, mirroring the component-removal path). The
 *      `world.isAlive(e)` guard on the read stays as defense-in-depth: it costs one generation check
 *      and makes the undefined-on-death contract (002 §3.4) hold locally, whatever the core does.
 *
 * `useResource` needs neither: `getResource` returns the stored object (stable until the next
 * `setResource`) and resources have no death path, so `peekResource` is already a stable snapshot.
 *
 * The core never imports React; this binding never imports react-dom. It is **semantically
 * client-only** — strata worlds do not server-render — but `getServerSnapshot` is wired to the same
 * `getSnapshot` so an accidental SSR render returns the current value instead of hard-crashing.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Component, Entity, Resource, World } from "../core/index";

/**
 * Subscribe a component to one entity's component *value* (Tier 3, 002 §3.3). Returns the current
 * value, or `undefined` when the entity is dead or lacks the component. Re-renders once per real
 * change at the app's next `reactive.notify()`; an equal-value write does not re-render. Swapping the
 * `world`/`entity`/`component` argument re-subscribes.
 */
export function useComponent<S>(world: World, e: Entity, c: Component<S>): S | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => world.reactive.observeValue(e, c, onStoreChange),
    [world, e, c],
  );
  // A reference-stable snapshot over the Tier-3 box (see the file header, points 1 and 2). The read is
  // `isAlive`-guarded so a despawn surfaces as `undefined` at the death callback rather than the stale box.
  const last = useRef<{ primed: boolean; value: S | undefined }>({
    primed: false,
    value: undefined,
  });
  const getSnapshot = (): S | undefined => {
    const next = world.isAlive(e) ? world.reactive.peek(e, c) : undefined;
    const prev = last.current;
    if (prev.primed && shallowEqual(prev.value, next)) return prev.value;
    last.current = { primed: true, value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe a component to a world resource's value (003 §1.3 — Tier-3-equivalent; `setResource`
 * replaces the object wholesale, so it is equality-suppressed too). Returns the current value, or
 * `undefined` for a never-set resource. Re-renders once per real change at the next `notify()`; an
 * equal-value `setResource` does not re-render. Swapping the `world`/`resource` argument re-subscribes.
 */
export function useResource<S>(world: World, r: Resource<S>): S | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => world.reactive.observeResource(r, onStoreChange),
    [world, r],
  );
  // peekResource returns the STORED object — reference-stable between setResource calls — but an
  // equality-SUPPRESSED setResource (new object, equal fields) still swaps its identity without a
  // notification, so the snapshot is ref-cached exactly like useComponent's (an unstable snapshot
  // with no notification is a useSyncExternalStore contract violation). Reused as
  // getServerSnapshot so an accidental SSR render returns the value rather than hard-crashing.
  const last = useRef<{ primed: boolean; value: S | undefined }>({
    primed: false,
    value: undefined,
  });
  const getSnapshot = (): S | undefined => {
    const next = world.reactive.peekResource(r);
    const prev = last.current;
    if (prev.primed && shallowEqual(prev.value, next)) return prev.value;
    last.current = { primed: true, value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Shallow structural equality over a value object's fields (mirrors the core's Tier-3 default). Used
 * only to keep `useComponent`'s snapshot reference stable across the pre-subscription render window,
 * where `peek` falls back to a fresh `get` decode (file header, point 1); once a watch exists the box
 * is stable and the leading `Object.is` short-circuits this to a single comparison.
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) if (!Object.is(ao[k], bo[k])) return false;
  return true;
}

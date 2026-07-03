/**
 * Dev-tool observability hooks (docs/plan-tools-observer.md).
 *
 * A `WorldObserver` is the data feed for first-party tools (`strata-ecs/tools` — inspector,
 * lifecycle timeline, per-system profiler). Attach with `world.observe(obs)`; the returned
 * function detaches. The design contract:
 *
 * - ZERO COST WHEN UNATTACHED — hot paths (spawn/destroy/tick) pay one branch-on-null and
 *   nothing else: no timing calls, no allocation. Timing (`performance.now()`) happens only
 *   while at least one observer is attached.
 * - READ-ONLY — observer callbacks must not mutate the world. `onDestroy` can fire in the
 *   middle of a command-buffer flush (§5.4); a mutation there corrupts the drain. In dev
 *   builds, `spawn`/`destroy` called from inside a callback are diagnosed via `devError`
 *   (the reentrant destroy is ignored).
 * - MUST NOT THROW — a throwing callback is swallowed and reported via `devError`, never
 *   propagated: an observer can never abort a flush mid-drain, leak a minted identity, or
 *   break a tick.
 * - `onSpawn` fires exactly once per entity: after placement for immediate `world.spawn`;
 *   at the eager identity mint for a system's deferred `ctx.spawn` (placement lands at that
 *   phase's flush, §5.2 — the entity is identity-only inside the callback). During snapshot
 *   import it fires per entity as it is placed: scalar/string/enum fields are readable, but
 *   eid fields still hold the null-entity placeholder and relation edges are not yet wired
 *   (both land in the load's second phase, §8.2).
 * - `onDestroy` fires BEFORE teardown: the dying entity's components, tags, and relations
 *   are still fully readable inside the callback (the hook tools freeze final labels from).
 * - ROSTER SEMANTICS — the observer list is copy-on-write. Lifecycle events snapshot it per
 *   event; `tick()` snapshots it once at entry, so attaching/detaching mid-tick affects tick
 *   telemetry from the NEXT tick. Detaching from inside a callback never skips a sibling.
 * - RESET IS WHOLESALE — a `world.reset()` (or `import(bytes, { replace: true })`) does NOT fire
 *   per-entity `onDestroy`: a 100k-entity reset would otherwise emit 100k callbacks. The roster
 *   SURVIVES the reset (attachments are not detached); a single `onReset` fires AFTER teardown
 *   completes (the world is already empty and all pre-reset handles read dead inside it). `onReset`
 *   is the signal to drop per-entity state wholesale — a re-import's `onSpawn` events repopulate it.
 */

import type { Entity } from "./entity";

export interface WorldObserver {
  /** An entity came into existence (see timing contract above). */
  onSpawn?(e: Entity): void;
  /** An entity is about to be torn down — still fully readable inside the callback. */
  onDestroy?(e: Entity): void;
  /**
   * The world was reset wholesale (`world.reset()` / `import` with `replace`) — fired ONCE after
   * teardown, in place of per-entity `onDestroy`. Optional and backward-compatible: an observer
   * that ignores it simply keeps stale per-entity records that no longer name live entities.
   */
  onReset?(): void;
  /** `world.tick()` entered. `tick` is the 1-based running `world.tickCount`. */
  onTickStart?(tick: number): void;
  /**
   * A system slot was visited. `ran === false` means it was skipped by its own `runIf` or
   * its phase's (`micros` is 0 then); otherwise `micros` is the body's wall-clock time.
   */
  onSystemRun?(phase: string, system: string, ran: boolean, micros: number): void;
  /** A phase's command buffer was flushed (the phase boundary, §7.2). */
  onPhaseFlush?(phase: string, micros: number): void;
  /** `world.tick()` finished. */
  onTickEnd?(tick: number, micros: number): void;
}

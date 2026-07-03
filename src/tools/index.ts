/**
 * `strata-ecs/tools` — first-party dev tools (docs/plan-tools-observer.md).
 *
 * The Observer is a zero-dependency vanilla-DOM panel usable from ANY host app:
 *
 *   import { attachObserver } from "strata-ecs/tools";
 *   const obs = attachObserver(world, { describe });   // …later: obs.dispose()
 *
 * Three tabs: **entities** (virtualized live list + component/tag/relation detail pane),
 * **systems** (per-system µs, run/skip idle%, per-phase flush rows — fed by the core's
 * WorldObserver telemetry), **timeline** (a canvas waterfall of every entity's birth→death,
 * captured via lifecycle hooks so even one-tick entities appear).
 *
 * Costs: the world pays the observer-attached telemetry path only while attached (and
 * exactly one branch-on-null when not); the panel itself polls at ~8 Hz and draws the
 * timeline on its own rAF only while that tab is visible.
 */

import type { World } from "../core/index";
import { defaultDescribe, type DescribeFn, type EntityDescription } from "./observer/describe";
import { EntitiesTab } from "./observer/entities";
import { LoopStats } from "./observer/loop";
import { Panel } from "./observer/panel";
import { createLifecycleRecorder, type LifecycleRecorder, type LifeRecord } from "./observer/recorder";
import { injectStyle } from "./observer/style";
import { TimelineTab } from "./observer/timeline";

export type { DescribeFn, EntityDescription, LifecycleRecorder, LifeRecord };
export { createLifecycleRecorder, defaultDescribe };

export interface ObserverOptions {
  /** Where to mount the panel (default: document.body). */
  container?: HTMLElement;
  /** App-provided identity-off-composition labeling (default: component-name labels). */
  describe?: DescribeFn;
  /** Lifecycle-record cap — oldest DEAD records evict first (default 4000). */
  recorderCap?: number;
  /** Tab to open when no persisted layout exists yet. */
  defaultTab?: "entities" | "systems" | "timeline";
  /** Tab to FORCE open, beating any persisted layout (for shareable ?obs= links). */
  tab?: "entities" | "systems" | "timeline";
}

export interface ObserverHandle {
  dispose(): void;
}

const POLL_MS = 120;

/** Mount the observer panel over a world. Returns a handle whose dispose() detaches
 *  everything (world hooks, DOM, timers). */
export function attachObserver(world: World, opts: ObserverOptions = {}): ObserverHandle {
  const container = opts.container ?? document.body;
  const describe = opts.describe ?? defaultDescribe;
  injectStyle(container.ownerDocument);

  const recorder = createLifecycleRecorder(world, describe, opts.recorderCap);
  const loop = new LoopStats();
  const detachLoop = world.observe(loop.observer());

  const panel = new Panel(container, { defaultTab: opts.defaultTab, tab: opts.tab });
  const entities = new EntitiesTab(panel.panes.entities, () => world);
  const timeline = new TimelineTab(panel.panes.timeline, () => world, recorder, describe);
  const loopRoot = panel.panes.systems.querySelector(".strata-obs-loop") as HTMLElement;

  panel.tabChanged((tab, open) => timeline.setActive(open && tab === "timeline"));
  timeline.setActive(panel.isOpen && panel.activeTab === "timeline");

  const poll = window.setInterval(() => {
    let live = 0;
    for (const a of world.runtime.archetypes()) live += a.count;
    panel.setSummary(`${live.toLocaleString()} entities · tick ${world.tickCount.toLocaleString()}`);
    if (!panel.isOpen) return;
    if (panel.activeTab === "entities") entities.refresh();
    else if (panel.activeTab === "systems") loop.render(loopRoot);
  }, POLL_MS);

  return {
    dispose() {
      window.clearInterval(poll);
      timeline.dispose();
      recorder.dispose();
      detachLoop();
      panel.dispose();
    },
  };
}

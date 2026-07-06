/**
 * `@vibecook/strata-ecs/tools` — first-party dev tools (docs/plan-tools-observer.md).
 *
 * The Observer is a zero-dependency vanilla-DOM panel usable from ANY host app:
 *
 *   import { attachObserver } from "@vibecook/strata-ecs/tools";
 *   const obs = attachObserver(world, { describe });   // …later: obs.dispose()
 *
 * Base tabs: **entities** (virtualized live list + component/tag/relation detail pane),
 * **systems** (per-system µs, run/skip idle%, per-phase flush rows — fed by the core's
 * WorldObserver telemetry), **timeline** (a canvas waterfall of every entity's birth→death,
 * captured via lifecycle hooks so even one-tick entities appear).
 *
 * Two OPTIONAL collab tabs light up when the host wires a store getter (below): **durable**
 * (the un-agreed sync delta — baseline vs converged Loro doc, side by side) and **ephemeral**
 * (every peer's live presence blobs, grouped by writer). Both are OFF unless their option is
 * given, so a solo app pays nothing and the tools package never needs `loro-crdt` installed.
 *
 * Costs: the world pays the observer-attached telemetry path only while attached (and
 * exactly one branch-on-null when not); the panel itself polls at ~8 Hz and draws the
 * timeline on its own rAF only while that tab is visible.
 */

import type { World } from "../core/index";
import { defaultDescribe, type DescribeFn, type EntityDescription } from "./observer/describe";
import { DurableTab } from "./observer/durable-tab";
import { EntitiesTab } from "./observer/entities";
import { EphemeralTab } from "./observer/ephemeral-tab";
import { LoopStats } from "./observer/loop";
import { Panel, type TabId } from "./observer/panel";
import { createLifecycleRecorder, type LifecycleRecorder, type LifeRecord } from "./observer/recorder";
import { injectStyle } from "./observer/style";
import { TimelineTab } from "./observer/timeline";

export type { DescribeFn, EntityDescription, LifecycleRecorder, LifeRecord };
export { createLifecycleRecorder, defaultDescribe };

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * The collab-store inspection surface — STRUCTURAL interfaces the host satisfies with live objects.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `@vibecook/strata-ecs/tools` MUST NOT import `@vibecook/strata-ecs/durable` or `@vibecook/strata-ecs/ephemeral` — not even
 * type-only: the tools ship as a standalone browser panel and the package must stay installable
 * and typecheckable WITHOUT `loro-crdt` present (design §0). So the observer declares its OWN
 * minimal read shapes here, and the host passes its live `DurableStore` / `EphemeralStore` (which
 * happen to satisfy them). These four interfaces are the EXACT structural mirror of first-party
 * fields — the correspondence is load-bearing, and a collab example's typecheck (which DOES import
 * both worlds) is what catches drift:
 *
 *   - {@link ObserverSnapshotView} mirrors substrate `Snapshot`'s bulk-read pair (`entities()` /
 *     `readEntity()` — types.ts). `EntityKey` is a branded string, assignable to the plain `string`
 *     here; the branding is compile-time only, so passing plain strings back through works at runtime.
 *   - {@link ObserverDurableSource} mirrors the REAL `DurableStore` fields `.docId` + `.snapshot`
 *     (durable-store.ts — `snapshot` is the store's @internal `LoroSnapshot`, whose bulk-read pair
 *     satisfies `ObserverSnapshotView`) and the durable `Attachment.baseline` (binding.ts — the
 *     @internal converged-value baseline inspection seam; first-party tools are exactly what it
 *     exists for).
 *   - {@link ObserverEphemeralSource} mirrors `EphemeralStore.debugDump()` (ephemeral-store.ts's
 *     `EphemeralDebugDump`, whose `blob` is `EphemeralBlob = Record<string, unknown>`) — the store's
 *     single debug/observability read, never a sync path.
 */

/** One entity's aggregated record — the structural mirror of substrate `EntityRecord` (types.ts §1.2). */
export interface ObserverEntityRecord {
  key: string;
  components: Record<string, unknown>;
  tags: string[];
  /** arity "one" → scalar target key; arity "many" → array of target keys (§8.1). */
  relations: Record<string, string | string[]>;
}

/** The bulk-read pair the durable tab walks — the structural mirror of substrate `Snapshot` (types.ts). */
export interface ObserverSnapshotView {
  entities(): Iterable<string>;
  readEntity(key: string): ObserverEntityRecord | undefined;
}

/**
 * What the durable tab needs each poll: the store's identity + converged Loro view, plus the
 * attachment's founding-agreement baseline. The Δ between the two views is the un-agreed sync delta.
 */
export interface ObserverDurableSource {
  store: { docId: string; snapshot: ObserverSnapshotView };
  attachment: { baseline: ObserverSnapshotView };
}

/** What the ephemeral tab reads each poll — the structural mirror of `EphemeralStore.debugDump()`. */
export interface ObserverEphemeralSource {
  debugDump(): {
    peerId: string;
    ttlMs: number;
    throttleMs: number;
    entries: ReadonlyArray<{ key: string; blob: Record<string, unknown> }>;
  };
}

export interface ObserverOptions {
  /** Where to mount the panel (default: document.body). */
  container?: HTMLElement;
  /** App-provided identity-off-composition labeling (default: component-name labels). */
  describe?: DescribeFn;
  /** Lifecycle-record cap — oldest DEAD records evict first (default 4000). */
  recorderCap?: number;
  /** Tab to open when no persisted layout exists yet. */
  defaultTab?: TabId;
  /** Tab to FORCE open, beating any persisted layout (for shareable ?obs= links). */
  tab?: TabId;
  /**
   * Getter (re-read each poll) — return null while no durable store is attached. Presence of the
   * OPTION (not its return value) is what shows the durable tab, so the tab exists before the first
   * collab connect and shows a placeholder until a store arrives.
   */
  durable?: () => ObserverDurableSource | null;
  /** Getter (re-read each poll) — return null while no ephemeral store is attached. The OPTION shows the tab. */
  ephemeral?: () => ObserverEphemeralSource | null;
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

  // The collab tabs are opt-in: the base three always render; durable/ephemeral join the strip only
  // when their getter is supplied (the package must work with no collab layer present at all).
  const tabs: TabId[] = ["entities", "systems", "timeline"];
  if (opts.durable !== undefined) tabs.push("durable");
  if (opts.ephemeral !== undefined) tabs.push("ephemeral");

  const panel = new Panel(container, { tabs, defaultTab: opts.defaultTab, tab: opts.tab });
  // The base three panes always exist (they are always in `tabs`); `!` documents that invariant.
  const entities = new EntitiesTab(panel.panes.entities!, () => world);
  const timeline = new TimelineTab(panel.panes.timeline!, () => world, recorder, describe);
  const loopRoot = panel.panes.systems!.querySelector(".strata-obs-loop") as HTMLElement;
  // Built only when their option is present — so is their pane, hence the non-null option guard pairing.
  const durable = opts.durable !== undefined ? new DurableTab(panel.panes.durable!, opts.durable) : null;
  const ephemeral = opts.ephemeral !== undefined ? new EphemeralTab(panel.panes.ephemeral!, opts.ephemeral) : null;

  panel.tabChanged((tab, open) => timeline.setActive(open && tab === "timeline"));
  timeline.setActive(panel.isOpen && panel.activeTab === "timeline");

  const poll = window.setInterval(() => {
    let live = 0;
    for (const a of world.runtime.archetypes()) live += a.count;
    panel.setSummary(`${live.toLocaleString()} entities · tick ${world.tickCount.toLocaleString()}`);
    if (!panel.isOpen) return;
    if (panel.activeTab === "entities") entities.refresh();
    else if (panel.activeTab === "systems") loop.render(loopRoot);
    else if (panel.activeTab === "durable") durable?.refresh();
    else if (panel.activeTab === "ephemeral") ephemeral?.refresh();
  }, POLL_MS);

  return {
    dispose() {
      // The two collab tabs own no timers and no world hooks — only DOM inside their pane, which
      // panel.dispose() removes with the whole subtree (incl. the durable filter input's listener).
      window.clearInterval(poll);
      timeline.dispose();
      recorder.dispose();
      detachLoop();
      panel.dispose();
    },
  };
}

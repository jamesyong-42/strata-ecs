/**
 * Entry point. Boot order: seed the world → wire canvases + chrome + input → start the
 * frame loop. Shareable stress links: ?count=50000 (clamped to [100, 100000] — well under
 * strata's 2^20 entity-slot ceiling; the Canvas2D paint budget is the real limit, and the
 * HUD's ecs/paint split shows exactly which one you're hitting).
 *
 * ?script=demo runs a scripted marquee → drag → duplicate sequence (used by the headless
 * verification screenshots; also a handy smoke test after refactors).
 */

import { attachObserver, type ObserverOptions } from "strata/tools";
import { cam, setViewportSize, zoomToFit } from "./app/camera";
import { dirty, setOnMutate, stats } from "./app/commands";
import { duplicateSelection, setSelection } from "./app/editorOps";
import { describeShape } from "./app/describe";
import { startFrameLoop } from "./app/frameLoop";
import { hitTestPoint, hitTestRegion } from "./app/hitTest";
import { attachInput } from "./app/input";
import { hasAutosave, loadAutosave, onRestore, saveToLocalStorage, scheduleAutosave } from "./app/persistence";
import { wireReactivity } from "./app/reactivity";
import { seedBoard } from "./app/seed";
import { isSimOn, setSimBound, setSimulate } from "./app/sim";
import { clearBoard, stressSpawn } from "./app/stress";
import { interaction, pointerDown, pointerMove, pointerUp, setTool } from "./app/tools";
import { worldRef } from "./app/worldRef";
import { buildPipeline, SYSTEM_NAMES, type SystemName } from "./ecs/pipeline";
import { cullFlags } from "./ecs/systems/cull";
import { ContentLayer, lodFlags } from "./render/contentLayer";
import { drawBuffer } from "./render/drawBuffer";
import { OverlayLayer } from "./render/overlayLayer";
import { Hud } from "./ui/hud";
import { buildToolbar } from "./ui/toolbar";

const params = new URLSearchParams(location.search);
const count = Math.min(100_000, Math.max(100, Number(params.get("count") ?? 10_000) || 10_000));

const content = document.getElementById("content") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;

const contentLayer = new ContentLayer(content);
const overlayLayer = new OverlayLayer(overlay);

// The schedule is a value — the HUD's checkboxes rebuild it live (schedule-as-data).
const disabledSystems = new Set<SystemName>();
let pipeline = buildPipeline(disabledSystems);

const hud = new Hud(document.getElementById("hud") as HTMLElement, {
  systemNames: SYSTEM_NAMES,
  onSimToggle(on) {
    setSimulate(on);
    notify(on ? "simulate ON — every shape got a velocity; keep editing" : "simulate off — frozen mid-flight");
  },
  onSpawn(n) {
    const r = stressSpawn(n);
    notify(
      r.spawned === 0
        ? `at the ${(100_000).toLocaleString()}-shape cap`
        : `spawned ${r.spawned.toLocaleString()} fully-initialized shapes in ${r.ms.toFixed(1)}ms`,
    );
  },
  onClear() {
    const n = clearBoard();
    notify(`destroyed ${n.toLocaleString()} shapes (relations cascaded)`);
  },
  onSystemToggle(name, enabled) {
    if (enabled) disabledSystems.delete(name as SystemName);
    else disabledSystems.add(name as SystemName);
    pipeline = buildPipeline(disabledSystems); // just a new array — no scheduler, no registration
    dirty.doc = true; // toggling Cull changes what the next paint shows
    notify(`${name} ${enabled ? "re-enabled" : "removed from the pipeline"}`);
  },
  onCullTestToggle(enabled) {
    cullFlags.viewportTest = enabled;
    dirty.doc = true;
    notify(enabled ? "viewport cull back on" : `cull test OFF — painting all ${stats.entities.toLocaleString()} shapes`);
  },
  onLodToggle(enabled) {
    lodFlags.enabled = enabled;
    dirty.doc = true;
    notify(enabled ? "LOD on (greeked text far out)" : "LOD OFF — full text + strokes at every zoom");
  },
});
const notify = (msg: string): void => hud.setNote(msg);

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  contentLayer.resize(w, h, dpr);
  overlayLayer.resize(w, h, dpr);
  setViewportSize(w, h);
}
window.addEventListener("resize", fitCanvases);
fitCanvases();

// Boot document: an explicit ?count= (or ?fresh=1) always seeds; otherwise the autosave —
// world.export() bytes in localStorage — restores the last session, viewport included.
// An incompatible autosave (schema drift) is quarantined by loadAutosave, never a brick.
let booted = false;
if (!params.has("count") && params.get("fresh") !== "1" && hasAutosave()) {
  const load = loadAutosave();
  if (load === "restored") {
    notify(`restored autosave — ${stats.entities.toLocaleString()} shapes (world.import)`);
    booted = true;
  } else if (load === "incompatible") {
    notify("autosave was incompatible with the current schema — seeded a fresh board");
  }
}
if (!booted) {
  const seeded = seedBoard(worldRef.current, count);
  setSimBound(Math.sqrt(count) * 55 * 1.5); // fit the bounce box to the seeded spread
  notify(`seeded ${seeded.count.toLocaleString()} shapes + ${seeded.arrows} arrows in ${seeded.ms.toFixed(1)}ms`);
  zoomToFit();
}
setOnMutate(scheduleAutosave); // every document mutation debounces an idle-time export
// Wire the single Tier-1 renderable observer that drives repaint + autosave. Called AFTER the
// boot seed so the (unarmed) seed pays no stamping tax — the seeded board's first paint comes
// from commands.ts's initial dirty.doc, not from the observer (registration never back-fires).
wireReactivity();

buildToolbar(document.getElementById("toolbar") as HTMLElement, notify);
attachInput(overlay, notify);
// The framework's own observer panel (strata/tools): entity inspector, per-system µs,
// lifecycle timeline — the app only supplies the labeling. ?obs=systems|timeline picks the
// starting tab for shareable links.
const obsTab = params.get("obs");
const obsOpts: ObserverOptions = {
  describe: describeShape,
  // `tab` (not defaultTab): a shared ?obs= link must win over this browser's persisted layout
  tab: obsTab === "systems" || obsTab === "timeline" || obsTab === "entities" ? obsTab : undefined,
};
let observer = attachObserver(worldRef.current, obsOpts);
// a restore swaps the World instance — re-attach the observer and re-sync chrome state
onRestore(() => {
  observer.dispose();
  observer = attachObserver(worldRef.current, obsOpts);
  wireReactivity(); // fresh world = fresh reactive registry — re-subscribe (002 §6); restore()
  // already set dirty.doc so the first post-restore frame paints (registration never back-fires)
  hud.setSimState(isSimOn()); // SimMode rides in the snapshot — a restored storm resumes
});
startFrameLoop(
  () => pipeline,
  () => contentLayer.paint(drawBuffer),
  () => overlayLayer.paint(),
  (s) => hud.frame(s, overlayLayer.selectedCount),
);

// ?sim=1 boots straight into simulate mode (headless verification / shareable links).
if (params.get("sim") === "1") setSimulate(true);
hud.setSimState(isSimOn()); // boot may have restored (or forced) a running storm

// ?script=persist exercises the full save→clear→restore cycle in-process: export bytes,
// wipe the world, import into a FRESH world (ref swap + observer re-attach) — the same
// code path the autosave boot-restore takes.
if (params.get("script") === "persist") {
  setTimeout(() => {
    const before = stats.entities;
    if (!saveToLocalStorage()) {
      notify("persist test ABORTED — export exceeded the localStorage quota (board untouched)");
      return;
    }
    clearBoard();
    const cleared = stats.entities;
    const load = loadAutosave();
    notify(
      load === "restored"
        ? `persist test: saved ${before.toLocaleString()} → cleared ${cleared} → restored ${stats.entities.toLocaleString()} into a fresh world`
        : `persist test FAILED at restore (${load})`,
    );
  }, 600);
}

// Scripted interaction demo — the same code paths real input drives, minus the DOM events.
if (params.get("script") === "demo") {
  setTimeout(() => {
    const rw = cam.w / 5 / cam.zoom;
    const rh = cam.h / 5 / cam.zoom;
    const hits = hitTestRegion(cam.x - rw, cam.y - rh, cam.x + rw, cam.y + rh);
    setSelection(hits.entities);
    interaction.mode = "drag"; // feed DragMoveSystem exactly like a pointer drag would
    interaction.pendingDx = 260 / cam.zoom;
    interaction.pendingDy = 140 / cam.zoom;
    setTimeout(() => {
      interaction.mode = "dragEnd";
      const d = duplicateSelection();
      // regression check for the review-caught critical: a completed draw gesture must
      // PERSIST its shape (setTool used to cancel-destroy it at commit)
      const dx = cam.x - (cam.w / 2 - 60) / cam.zoom;
      const dy = cam.y - (cam.h / 2 - 160) / cam.zoom;
      setTool("rect");
      pointerDown({ sx: 0, sy: 0, wx: dx, wy: dy, shift: false });
      pointerMove({ sx: 0, sy: 0, wx: dx + 180 / cam.zoom, wy: dy + 120 / cam.zoom, shift: false }, 180, 120);
      pointerUp({ sx: 0, sy: 0, wx: dx + 180 / cam.zoom, wy: dy + 120 / cam.zoom, shift: false });
      const drawn = hitTestPoint(dx + 90 / cam.zoom, dy + 60 / cam.zoom);
      notify(
        `demo: marquee ${hits.entities.length.toLocaleString()} → drag → dup ${d.count.toLocaleString()} in ${d.ms.toFixed(1)}ms · draw persisted: ${drawn !== undefined ? "YES" : "NO"}`,
      );
    }, 400);
  }, 400);
}

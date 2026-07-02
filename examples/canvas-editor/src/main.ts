/**
 * Entry point. Boot order: seed the world → wire canvases + chrome + input → start the
 * frame loop. Shareable stress links: ?count=50000 (clamped to [100, 100000] — well under
 * strata's 2^20 entity-slot ceiling; the Canvas2D paint budget is the real limit, and the
 * HUD's ecs/paint split shows exactly which one you're hitting).
 *
 * ?script=demo runs a scripted marquee → drag → duplicate sequence (used by the headless
 * verification screenshots; also a handy smoke test after refactors).
 */

import { attachObserver } from "strata/tools";
import { cam, setViewportSize, zoomToFit } from "./app/camera";
import { duplicateSelection, setSelection } from "./app/editorOps";
import { describeShape } from "./app/describe";
import { startFrameLoop } from "./app/frameLoop";
import { hitTestPoint, hitTestRegion } from "./app/hitTest";
import { attachInput } from "./app/input";
import { seedBoard } from "./app/seed";
import { interaction, pointerDown, pointerMove, pointerUp, setTool } from "./app/tools";
import { worldRef } from "./app/worldRef";
import { buildPipeline } from "./ecs/pipeline";
import { ContentLayer } from "./render/contentLayer";
import { drawBuffer } from "./render/drawBuffer";
import { OverlayLayer } from "./render/overlayLayer";
import { Hud } from "./ui/hud";
import { buildToolbar } from "./ui/toolbar";

const params = new URLSearchParams(location.search);
const count = Math.min(100_000, Math.max(100, Number(params.get("count") ?? 10_000) || 10_000));

const content = document.getElementById("content") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const hud = new Hud(document.getElementById("hud") as HTMLElement);
const notify = (msg: string): void => hud.setNote(msg);

const contentLayer = new ContentLayer(content);
const overlayLayer = new OverlayLayer(overlay);
const pipeline = buildPipeline();

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

const seeded = seedBoard(worldRef.current, count);
notify(`seeded ${seeded.count.toLocaleString()} shapes + ${seeded.arrows} arrows in ${seeded.ms.toFixed(1)}ms`);
zoomToFit();

buildToolbar(document.getElementById("toolbar") as HTMLElement, notify);
attachInput(overlay, notify);
// The framework's own observer panel (strata/tools): entity inspector, per-system µs,
// lifecycle timeline — the app only supplies the labeling. ?obs=systems|timeline picks the
// starting tab for shareable links.
const obsTab = params.get("obs");
attachObserver(worldRef.current, {
  describe: describeShape,
  // `tab` (not defaultTab): a shared ?obs= link must win over this browser's persisted layout
  tab: obsTab === "systems" || obsTab === "timeline" || obsTab === "entities" ? obsTab : undefined,
});
startFrameLoop(
  () => pipeline,
  () => contentLayer.paint(drawBuffer),
  () => overlayLayer.paint(),
  (s) => hud.frame(s, overlayLayer.selectedCount),
);

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

/**
 * Entry point. Boot order: seed the world → wire canvases + input → start the frame loop.
 * Shareable stress links: ?count=50000 (clamped to [100, 100000] — well under strata's
 * 2^20 entity-slot ceiling; the Canvas2D paint budget is the real limit, and the HUD's
 * ecs/paint split shows exactly which one you're hitting).
 */

import { setViewportSize, zoomToFit } from "./app/camera";
import { startFrameLoop } from "./app/frameLoop";
import { attachInput } from "./app/input";
import { seedBoard } from "./app/seed";
import { worldRef } from "./app/worldRef";
import { buildPipeline } from "./ecs/pipeline";
import { ContentLayer } from "./render/contentLayer";
import { drawBuffer } from "./render/drawBuffer";
import { Hud } from "./ui/hud";

const params = new URLSearchParams(location.search);
const count = Math.min(100_000, Math.max(100, Number(params.get("count") ?? 10_000) || 10_000));

const content = document.getElementById("content") as HTMLCanvasElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const hud = new Hud(document.getElementById("hud") as HTMLElement);

const layer = new ContentLayer(content);
const pipeline = buildPipeline();

function fitCanvases(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  layer.resize(w, h, dpr);
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  setViewportSize(w, h);
}
window.addEventListener("resize", fitCanvases);
fitCanvases();

const seeded = seedBoard(worldRef.current, count);
hud.setNote(`seeded ${seeded.count.toLocaleString()} shapes + ${seeded.arrows} arrows in ${seeded.ms.toFixed(1)}ms`);
zoomToFit();

attachInput(overlay);
startFrameLoop(
  () => pipeline,
  () => layer.paint(drawBuffer),
  (s) => hud.frame(s),
);

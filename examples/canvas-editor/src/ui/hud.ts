/**
 * HUD skeleton (E0): fps + the ECS-vs-paint frame split + live counts, in hand-rolled DOM
 * updated at 10 Hz. E2 grows this into sparkline + stress controls + toggles; the
 * per-system table comes from `strata/tools` (T1), not from here.
 */

import type { FrameStats } from "../app/frameLoop";
import { stats } from "../app/commands";
import { drawBuffer } from "../render/drawBuffer";
import { cam } from "../app/camera";

const fmtMs = (ms: number): string => (ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(0)}µs`);

export class Hud {
  private fpsEma = 60;
  private ecsEma = 0;
  private paintEma = 0;
  private lastText = 0;
  private readonly note: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor(root: HTMLElement) {
    root.innerHTML = `<div class="hud-title">strata canvas</div><div class="hud-body"></div><div class="hud-note"></div>`;
    this.body = root.querySelector(".hud-body") as HTMLDivElement;
    this.note = root.querySelector(".hud-note") as HTMLDivElement;
  }

  setNote(text: string): void {
    this.note.textContent = text;
  }

  frame(s: FrameStats): void {
    const a = 0.08;
    this.fpsEma += (1000 / Math.max(s.frameMs, 0.01) - this.fpsEma) * a;
    this.ecsEma += (s.ecsMs - this.ecsEma) * a;
    if (s.painted) this.paintEma += (s.paintMs - this.paintEma) * 0.3;

    const now = performance.now();
    if (now - this.lastText < 100) return; // 10 Hz DOM writes — the HUD must not become the cost
    this.lastText = now;
    this.body.textContent =
      `${this.fpsEma.toFixed(0)} fps · ecs ${fmtMs(this.ecsEma)} · paint ${fmtMs(this.paintEma)}\n` +
      `${stats.entities.toLocaleString()} entities · ${drawBuffer.count.toLocaleString()} visible · zoom ${(cam.zoom * 100).toFixed(0)}%`;
  }
}

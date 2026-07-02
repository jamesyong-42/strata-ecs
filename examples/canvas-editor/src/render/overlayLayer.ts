/**
 * Overlay layer — repainted EVERY frame (it's cheap), so indicators never force a content
 * repaint: selection outlines, hover ring, the live marquee + its preview highlights. The
 * Excalidraw dual-canvas / tldraw indicator-canvas pattern.
 */

import { cam } from "../app/camera";
import { interaction } from "../app/tools";
import { worldRef } from "../app/worldRef";
import { selectedBoxes } from "../ecs/queries";
import { Position, Size } from "../ecs/schema";

const SELECT_BLUE = "#58a6ff";

export class OverlayLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Filled per paint; the HUD reads it (selected count without a second query walk). */
  selectedCount = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  paint(): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cam.w, cam.h);
    // world-space transform (same as the content layer)
    ctx.setTransform(
      cam.zoom * dpr,
      0,
      0,
      cam.zoom * dpr,
      dpr * (cam.w / 2 - cam.x * cam.zoom),
      dpr * (cam.h / 2 - cam.y * cam.zoom),
    );
    const px1 = 1 / cam.zoom; // one screen px in world units

    // selection outlines — read-only walk over [Position, Size, Selected]
    const world = worldRef.current;
    ctx.strokeStyle = SELECT_BLUE;
    ctx.lineWidth = 1.5 * px1;
    let selected = 0;
    world.query(selectedBoxes).each((b) => {
      const px = b.col(Position).x as Float32Array;
      const py = b.col(Position).y as Float32Array;
      const sw = b.col(Size).w as Float32Array;
      const sh = b.col(Size).h as Float32Array;
      for (let i = 0; i < b.count; i++) {
        const r = b.rows[i];
        ctx.strokeRect(px[r] - sw[r] / 2 - 2 * px1, py[r] - sh[r] / 2 - 2 * px1, sw[r] + 4 * px1, sh[r] + 4 * px1);
      }
      selected += b.count;
    });
    this.selectedCount = selected;

    // hover ring (select tool, idle)
    const hover = interaction.hover;
    if (hover !== undefined && interaction.mode === "idle" && world.isAlive(hover)) {
      const hx = world.readField<number>(hover, Position, "x");
      const hy = world.readField<number>(hover, Position, "y");
      const hw = world.readField<number>(hover, Size, "w");
      const hh = world.readField<number>(hover, Size, "h");
      if (hx !== undefined && hy !== undefined && hw !== undefined && hh !== undefined) {
        ctx.strokeStyle = "rgba(88,166,255,.5)";
        ctx.lineWidth = 1 * px1;
        ctx.strokeRect(hx - hw / 2 - 4 * px1, hy - hh / 2 - 4 * px1, hw + 8 * px1, hh + 8 * px1);
      }
    }

    // marquee rect + live preview highlights (rects captured during the region walk —
    // no per-entity re-reads, even with thousands of shapes inside the sweep)
    const m = interaction.marquee;
    if (m !== null) {
      ctx.strokeStyle = "rgba(88,166,255,.35)";
      ctx.lineWidth = 1 * px1;
      const rects = interaction.previewRects;
      for (let i = 0; i < rects.length; i += 4) {
        ctx.strokeRect(rects[i] - rects[i + 2] / 2, rects[i + 1] - rects[i + 3] / 2, rects[i + 2], rects[i + 3]);
      }
      ctx.fillStyle = "rgba(88,166,255,.08)";
      ctx.strokeStyle = SELECT_BLUE;
      const x = Math.min(m.x0, m.x1);
      const y = Math.min(m.y0, m.y1);
      const w2 = Math.abs(m.x1 - m.x0);
      const h2 = Math.abs(m.y1 - m.y0);
      ctx.fillRect(x, y, w2, h2);
      ctx.strokeRect(x, y, w2, h2);
    }
  }
}

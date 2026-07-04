/**
 * Overlay layer — repainted EVERY frame (it's cheap), so indicators never force a content
 * repaint: selection outlines, hover ring, the live marquee + its preview highlights. The
 * Excalidraw dual-canvas / tldraw indicator-canvas pattern.
 */

import { cam } from "../app/camera";
import { interaction } from "../app/tools";
import { world } from "../app/worldRef";
import { activeCollab } from "../collab/mode";
import { remotePresence, selectedBoxes } from "../ecs/queries";
import { CursorPos, Position, PresenceInfo, SelectionRef, Size } from "../ecs/schema";

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

    // selection outlines — read-only walk over [Position, Size, Selected]. One batched path
    // + one stroke() (a strokeRect per shape is an order of magnitude more draw calls), and
    // sub-2-screen-px boxes are skipped: at far zoom a 5k selection would otherwise tank
    // idle fps for outlines nobody can see.
    ctx.strokeStyle = SELECT_BLUE;
    ctx.lineWidth = 1.5 * px1;
    const minWorld = 2 * px1;
    let selected = 0;
    ctx.beginPath();
    world.query(selectedBoxes).each((b) => {
      const px = b.col(Position).x;
      const py = b.col(Position).y;
      const sw = b.col(Size).w;
      const sh = b.col(Size).h;
      for (let i = 0; i < b.count; i++) {
        const r = b.rows[i];
        if (sw[r] < minWorld && sh[r] < minWorld) continue;
        ctx.rect(px[r] - sw[r] / 2 - 2 * px1, py[r] - sh[r] / 2 - 2 * px1, sw[r] + 4 * px1, sh[r] + 4 * px1);
      }
      selected += b.count;
    });
    ctx.stroke();
    this.selectedCount = selected;

    // hover ring (select tool, idle)
    const hover = interaction.hover;
    if (hover !== undefined && interaction.mode === "idle" && world.isAlive(hover)) {
      const hx = world.readField(hover, Position, "x");
      const hy = world.readField(hover, Position, "y");
      const hw = world.readField(hover, Size, "w");
      const hh = world.readField(hover, Size, "h");
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

    // remote presence (collab): peers' selection outlines (world-space) + live cursors (screen-space).
    // Read every frame off the `Not(Local)` projection — no repaint flag needed because the overlay
    // already repaints every frame, so a moving remote cursor animates for free (never a content repaint).
    this.paintPresence(ctx, px1);
  }

  /**
   * Draw remote peers' presence. Two passes over `[CursorPos, PresenceInfo, Not(Local)]` (a handful of
   * entities): (1) a `SelectionRef` facet resolves through `doc.resolve` to a colored outline in WORLD
   * space, skipped if the referenced shape isn't on this peer yet; (2) a labeled cursor in SCREEN space
   * so it stays a constant size at any zoom. Empty and free in local-only mode.
   */
  private paintPresence(ctx: CanvasRenderingContext2D, px1: number): void {
    const collab = activeCollab();

    // 1. Selection outlines — world-space (the transform the marquee block left set).
    ctx.lineWidth = 1.5 * px1;
    world.query(remotePresence).each((b) => {
      for (const r of b) {
        const e = b.entity(r);
        const sel = world.get(e, SelectionRef);
        if (sel === undefined || sel.targetKey === null || collab === null) continue;
        const target = collab.doc.resolve(sel.targetKey);
        if (target === undefined || !world.isAlive(target)) continue; // peer selected a shape we can't resolve — skip
        const p = world.get(target, Position);
        const s = world.get(target, Size);
        if (p === undefined || s === undefined) continue;
        ctx.strokeStyle = world.get(e, PresenceInfo)?.color ?? SELECT_BLUE;
        ctx.strokeRect(p.x - s.w / 2 - 3 * px1, p.y - s.h / 2 - 3 * px1, s.w + 6 * px1, s.h + 6 * px1);
      }
    });

    // 2. Cursors — screen-space (constant size). Convert world → screen (the inverse of screenToWorld).
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    world.query(remotePresence).each((b) => {
      for (const r of b) {
        const e = b.entity(r);
        const pos = world.get(e, CursorPos);
        const info = world.get(e, PresenceInfo);
        if (pos === undefined || info === undefined) continue;
        const sx = (pos.x - cam.x) * cam.zoom + cam.w / 2;
        const sy = (pos.y - cam.y) * cam.zoom + cam.h / 2;
        if (sx < -40 || sy < -40 || sx > cam.w + 200 || sy > cam.h + 40) continue; // off-screen cursor — skip
        this.drawCursor(ctx, sx, sy, info.name ?? "peer", info.color ?? SELECT_BLUE);
      }
    });
  }

  /** One remote cursor: a filled arrow with the peer's color + a name pill, in screen (CSS) px. */
  private drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string): void {
    ctx.save();
    ctx.translate(x, y);

    // the arrow — tip at (0,0), the true cursor position
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 12.5);
    ctx.lineTo(7.5, 19);
    ctx.lineTo(9.5, 18);
    ctx.lineTo(6.5, 11.8);
    ctx.lineTo(12, 11);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(13,17,23,.85)";
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // the name pill, offset from the tip
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const padX = 6;
    const w = ctx.measureText(name).width + padX * 2;
    const h = 16;
    const lx = 13;
    const ly = 9;
    ctx.beginPath();
    const rr = 4;
    ctx.moveTo(lx + rr, ly);
    ctx.arcTo(lx + w, ly, lx + w, ly + h, rr);
    ctx.arcTo(lx + w, ly + h, lx, ly + h, rr);
    ctx.arcTo(lx, ly + h, lx, ly, rr);
    ctx.arcTo(lx, ly, lx + w, ly, rr);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = "#0d1117";
    ctx.fillText(name, lx + padX, ly + h / 2 + 0.5);

    ctx.restore();
  }
}

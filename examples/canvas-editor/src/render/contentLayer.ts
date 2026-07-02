/**
 * Content layer — Canvas2D, repainted only when the dirty flags say so. Consumes the
 * z-sorted DrawBuffer that CullSystem produced inside the tick; the only per-shape world
 * reads at paint time are `readField` label lookups, capped to visible sticky notes — an
 * honest, small-count use of strata's random-access path.
 *
 * LOD (the tldraw thresholds): below GREEK_ZOOM, note text renders as a gray "greek" bar
 * and strokes are dropped — what keeps 10k+ mixed shapes honest on a 2D canvas.
 */

import type { Entity } from "strata";
import { cam } from "../app/camera";
import { worldRef } from "../app/worldRef";
import { connected } from "../ecs/queries";
import { ConnectedTo, Label, Position } from "../ecs/schema";
import type { DrawBuffer } from "./drawBuffer";

const GREEK_ZOOM = 0.35;

/** HUD toggle: LOD off forces full detail (real text + strokes) at every zoom — the honest
 *  way to show what greeking/stroke-dropping buys on a 2D canvas. */
export const lodFlags = { enabled: true };
const KIND_RECT = 1;
const KIND_ELLIPSE = 2;
const KIND_NOTE = 3;
const TAU = Math.PI * 2;
const GRID_STEP = 200; // world units between background dots

export class ContentLayer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Packed 0xRRGGBBAA → css string (the seeded palette is small, so this stays tiny). */
  private readonly cssCache = new Map<number, string>();

  /** Per-paint flags: which visible notes won the label budget (sized to the draw buffer). */
  private labelFlags = new Uint8Array(0);

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  private css(color: number): string {
    let s = this.cssCache.get(color);
    if (s === undefined) {
      const r = (color >>> 24) & 0xff;
      const g = (color >>> 16) & 0xff;
      const b = (color >>> 8) & 0xff;
      const a = color & 0xff;
      s = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
      this.cssCache.set(color, s);
    }
    return s;
  }

  paint(db: DrawBuffer): void {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const world = worldRef.current;

    // screen-space clear + background
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, cam.w, cam.h);
    this.paintGrid(ctx);

    // world-space transform: translate view center, scale by zoom, offset by camera
    ctx.setTransform(
      cam.zoom * dpr,
      0,
      0,
      cam.zoom * dpr,
      dpr * (cam.w / 2 - cam.x * cam.zoom),
      dpr * (cam.h / 2 - cam.y * cam.zoom),
    );

    this.paintArrows(ctx);

    const detailed = !lodFlags.enabled || cam.zoom >= GREEK_ZOOM;
    // Label budget goes to the TOP of the z-order (the notes the user actually sees), and
    // over-budget notes still get greek bars — never blank faces.
    if (this.labelFlags.length < db.count) this.labelFlags = new Uint8Array(db.x.length);
    this.labelFlags.fill(0, 0, db.count);
    if (detailed) {
      let budget = 400; // cap per-paint readField label lookups
      for (let k = db.count - 1; k >= 0 && budget > 0; k--) {
        const i = db.order[k];
        if (db.kind[i] === KIND_NOTE) {
          this.labelFlags[i] = 1;
          budget--;
        }
      }
    }
    for (let k = 0; k < db.count; k++) {
      const i = db.order[k];
      const x = db.x[i] - db.w[i] / 2;
      const y = db.y[i] - db.h[i] / 2;
      const w = db.w[i];
      const h = db.h[i];
      ctx.fillStyle = this.css(db.color[i]);
      switch (db.kind[i]) {
        case KIND_RECT:
          ctx.fillRect(x, y, w, h);
          break;
        case KIND_ELLIPSE:
          ctx.beginPath();
          ctx.ellipse(db.x[i], db.y[i], w / 2, h / 2, 0, 0, TAU);
          ctx.fill();
          break;
        case KIND_NOTE: {
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, 10);
          ctx.fill();
          if (this.labelFlags[i] === 1) {
            const text = world.readField<string>(db.entity[i] as Entity, Label, "text");
            if (text !== undefined) {
              ctx.fillStyle = "rgba(13,17,23,.85)";
              ctx.font = "600 22px ui-sans-serif, system-ui, sans-serif";
              ctx.textBaseline = "top";
              ctx.fillText(text, x + 14, y + 12, w - 28);
            }
          } else {
            // greeked text — zoomed out, or over the label budget (never a blank face)
            ctx.fillStyle = "rgba(13,17,23,.35)";
            ctx.fillRect(x + w * 0.12, y + h * 0.18, w * 0.76, h * 0.14);
            ctx.fillRect(x + w * 0.12, y + h * 0.44, w * 0.55, h * 0.14);
          }
          break;
        }
      }
      if (detailed) {
        ctx.strokeStyle = "rgba(240,246,252,.12)";
        ctx.lineWidth = 1 / cam.zoom;
        if (db.kind[i] === KIND_ELLIPSE) ctx.stroke();
        else ctx.strokeRect(x, y, w, h);
      }
    }
  }

  /** Faint dot grid in screen space — the "infinite canvas" cue. Skipped when zoomed far out. */
  private paintGrid(ctx: CanvasRenderingContext2D): void {
    const step = GRID_STEP * cam.zoom;
    if (step < 24) return;
    ctx.fillStyle = "rgba(110,118,129,.25)";
    const offX = ((cam.w / 2 - cam.x * cam.zoom) % step) + step;
    const offY = ((cam.h / 2 - cam.y * cam.zoom) % step) + step;
    for (let sx = offX % step; sx < cam.w; sx += step) {
      for (let sy = offY % step; sy < cam.h; sy += step) {
        ctx.fillRect(sx - 1, sy - 1, 2, 2);
      }
    }
  }

  /**
   * Connector arrows, drawn under the shapes. This is a read-only out-of-tick query walk
   * (design.md §16.2) over shapes with edges — seeded at ~3% of the board, so the per-edge
   * `getAllRelated` + `readField` endpoint reads stay honestly small-count.
   */
  private paintArrows(ctx: CanvasRenderingContext2D): void {
    const world = worldRef.current;
    ctx.strokeStyle = "rgba(139,148,158,.55)";
    ctx.lineWidth = 2 / cam.zoom;
    // segment-AABB cull against the view rect (padded for arrowheads) — same brute-force
    // thesis as CullSystem; without it every off-screen arrow is path-built per paint
    const pad = 12 / Math.max(cam.zoom, 0.15);
    const minX = cam.x - cam.w / 2 / cam.zoom - pad;
    const maxX = cam.x + cam.w / 2 / cam.zoom + pad;
    const minY = cam.y - cam.h / 2 / cam.zoom - pad;
    const maxY = cam.y + cam.h / 2 / cam.zoom + pad;
    world.query(connected).each((b) => {
      const px = b.col(Position).x as Float32Array;
      const py = b.col(Position).y as Float32Array;
      for (const r of b) {
        const x0 = px[r];
        const y0 = py[r];
        for (const target of b.getAllRelated(r, ConnectedTo)) {
          const x1 = world.readField<number>(target, Position, "x");
          const y1 = world.readField<number>(target, Position, "y");
          if (x1 === undefined || y1 === undefined) continue;
          if (
            Math.max(x0, x1) < minX ||
            Math.min(x0, x1) > maxX ||
            Math.max(y0, y1) < minY ||
            Math.min(y0, y1) > maxY
          ) {
            continue;
          }
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
          // arrowhead
          const angle = Math.atan2(y1 - y0, x1 - x0);
          const size = 10 / Math.max(cam.zoom, 0.15);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - size * Math.cos(angle - 0.45), y1 - size * Math.sin(angle - 0.45));
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - size * Math.cos(angle + 0.45), y1 - size * Math.sin(angle + 0.45));
          ctx.stroke();
        }
      }
    });
  }
}

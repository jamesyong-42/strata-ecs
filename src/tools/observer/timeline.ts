/**
 * The timeline tab — a Chrome-network-style waterfall of entity lifecycles. One horizontal
 * bar per entity from birth to death (or the live "now" edge), rows in birth order, drawn
 * to <canvas> so thousands of dead entities pan & zoom at 60fps. Interaction is
 * logic-analyzer standard: two-finger scroll pans (X = time, Y = rows), ctrl-wheel /
 * trackpad-pinch zooms the time axis, drag pans time, live-tail follows "now" and
 * re-engages when you scroll back to the right edge. The unit switch re-projects the X
 * axis between wall-clock ms and ECS ticks — every record carries both.
 */

import type { World } from "../../core/index";
import { genOf, slotOf } from "../../core/entity";
import type { DescribeFn } from "./describe";
import type { LifecycleRecorder, LifeRecord } from "./recorder";

type Unit = "ms" | "ticks";

const GUTTER = 104;
const ROW_H = 15;
const RULER_H = 20;
const BAR_PAD = 3;

const UNIT_CFG: Record<Unit, { span: number; min: number; max: number }> = {
  ms: { span: 6000, min: 150, max: 120000 },
  ticks: { span: 360, min: 15, max: 6000 },
};

const MS_STEPS = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000];
const TICK_STEPS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 3000];

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function niceStep(unit: Unit, pxPerUnit: number, minPx: number): number {
  const steps = unit === "ms" ? MS_STEPS : TICK_STEPS;
  for (const s of steps) if (s * pxPerUnit >= minPx) return s;
  return steps[steps.length - 1];
}

function fmtRuler(unit: Unit, v: number): string {
  if (unit === "ticks") return `t${v}`;
  return v >= 1000 ? `${+(v / 1000).toFixed(v % 1000 ? 1 : 0)}s` : `${v}ms`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

const escapeHtml = (s: string): string => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

export class TimelineTab {
  private unit: Unit = "ms";
  private view = { span: UNIT_CFG.ms.span, viewStart: 0, follow: true, scrollY: 0, stickBottom: true };
  private readonly wrap: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private readonly liveBtn: HTMLButtonElement;
  private raf = 0;
  active = false;

  constructor(
    root: HTMLElement,
    private readonly world: () => World,
    private readonly recorder: LifecycleRecorder,
    private readonly describe: DescribeFn,
  ) {
    root.innerHTML =
      `<div class="strata-obs-tlbar">` +
      `<div class="strata-obs-seg"><button data-u="ms" class="on">ms</button><button data-u="ticks">ticks</button></div>` +
      `<button class="strata-obs-tllive on"><span class="dot"></span> live</button>` +
      `<button class="strata-obs-btn" data-clear>clear</button>` +
      `</div>` +
      `<div class="strata-obs-tlwrap"><canvas class="strata-obs-tlcanvas"></canvas><div class="strata-obs-tltip"></div></div>`;
    this.wrap = root.querySelector(".strata-obs-tlwrap") as HTMLDivElement;
    this.canvas = root.querySelector(".strata-obs-tlcanvas") as HTMLCanvasElement;
    this.tip = root.querySelector(".strata-obs-tltip") as HTMLDivElement;
    this.liveBtn = root.querySelector(".strata-obs-tllive") as HTMLButtonElement;

    for (const b of root.querySelectorAll<HTMLButtonElement>(".strata-obs-seg button")) {
      b.addEventListener("click", () => {
        this.unit = b.dataset.u as Unit;
        for (const x of root.querySelectorAll(".strata-obs-seg button")) x.classList.toggle("on", x === b);
        // tick↔ms isn't linear — re-base to a live-tail default for the unit
        this.view = { span: UNIT_CFG[this.unit].span, viewStart: 0, follow: true, scrollY: 0, stickBottom: true };
      });
    }
    this.liveBtn.addEventListener("click", () => {
      this.view.follow = true;
      this.view.stickBottom = true;
    });
    (root.querySelector("[data-clear]") as HTMLButtonElement).addEventListener("click", () => this.recorder.clear());

    this.attachInteraction();
  }

  setActive(on: boolean): void {
    this.active = on;
    if (on && this.raf === 0) {
      const loop = (): void => {
        this.raf = this.active ? requestAnimationFrame(loop) : 0;
        if (this.active) this.draw();
      };
      this.raf = requestAnimationFrame(loop);
    }
    if (!on && this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  dispose(): void {
    this.setActive(false);
  }

  private now(): number {
    return this.unit === "ms" ? this.recorder.nowMs() : this.world().tickCount;
  }

  private born(r: LifeRecord): number {
    return this.unit === "ms" ? r.bornMs : r.bornTick;
  }

  private died(r: LifeRecord): number | null {
    return this.unit === "ms" ? r.diedMs : r.diedTick;
  }

  private desc(r: LifeRecord): { label: string; color: string; phase: string | null } {
    if (r.diedMs !== null) return { label: r.label, color: r.color, phase: r.phase };
    const d = this.describe(this.world(), r.id);
    return { label: d.label, color: d.color ?? "#768390", phase: d.phase ?? null };
  }

  // ── the draw pass (runs on its own rAF only while the tab is visible) ──
  private draw(): void {
    const cv = this.canvas;
    const cssW = this.wrap.clientWidth;
    const cssH = this.wrap.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    const ctx = cv.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cfg = UNIT_CFG[this.unit];
    const v = this.view;
    const plotW = cssW - GUTTER;
    const bodyH = cssH - RULER_H;
    const now = this.now();

    v.span = clamp(v.span, cfg.min, cfg.max);
    if (v.follow) v.viewStart = now - v.span;
    const pxPerUnit = plotW / v.span;
    const t2x = (t: number): number => GUTTER + (t - v.viewStart) * pxPerUnit;

    const recs = this.recorder.records();
    const contentH = recs.length * ROW_H;
    const maxScroll = Math.max(0, contentH - bodyH);
    v.scrollY = v.stickBottom ? maxScroll : clamp(v.scrollY, 0, maxScroll);

    // bars, clipped to the plot
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, RULER_H, plotW, bodyH);
    ctx.clip();

    const step = niceStep(this.unit, pxPerUnit, 72);
    ctx.strokeStyle = "rgba(110,118,129,.12)";
    ctx.lineWidth = 1;
    const firstLine = Math.ceil(v.viewStart / step) * step;
    for (let t = firstLine; t2x(t) <= cssW; t += step) {
      const x = Math.round(t2x(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }

    const firstRow = Math.max(0, Math.floor(v.scrollY / ROW_H));
    const lastRow = Math.min(recs.length - 1, Math.ceil((v.scrollY + bodyH) / ROW_H));
    // resolve descriptions ONCE per visible row per frame — the bars pass and the gutter
    // pass share them (live describes call into the app; don't pay for them twice)
    const descs: { label: string; color: string; phase: string | null }[] = [];
    for (let i = firstRow; i <= lastRow; i++) descs[i - firstRow] = this.desc(recs[i]);
    for (let i = firstRow; i <= lastRow; i++) {
      const r = recs[i];
      const y = RULER_H + i * ROW_H - v.scrollY;
      const alive = r.diedMs === null;
      const d = descs[i - firstRow];

      const x0 = t2x(this.born(r));
      const x1 = alive ? t2x(now) : t2x(this.died(r) as number);
      const left = clamp(x0, GUTTER, cssW);
      const right = clamp(Math.max(x1, x0 + 1), GUTTER, cssW);
      if (right <= GUTTER || left >= cssW) continue;

      ctx.fillStyle = d.color;
      ctx.globalAlpha = alive ? 0.95 : 0.75;
      ctx.fillRect(left, y + BAR_PAD, right - left, ROW_H - BAR_PAD * 2);
      ctx.globalAlpha = 1;
      if (alive && x1 >= GUTTER && x1 <= cssW) {
        ctx.fillStyle = "#e6edf3";
        ctx.fillRect(right - 1.5, y + BAR_PAD, 1.5, ROW_H - BAR_PAD * 2);
      }
    }
    ctx.restore();

    // gutter (id + label) over a solid panel
    ctx.fillStyle = "rgba(13,17,23,.92)";
    ctx.fillRect(0, RULER_H, GUTTER, bodyH);
    ctx.strokeStyle = "#21262d";
    ctx.beginPath();
    ctx.moveTo(GUTTER + 0.5, RULER_H);
    ctx.lineTo(GUTTER + 0.5, cssH);
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, GUTTER, bodyH);
    ctx.clip();
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = firstRow; i <= lastRow; i++) {
      const r = recs[i];
      const y = RULER_H + i * ROW_H - v.scrollY + ROW_H / 2;
      const d = descs[i - firstRow];
      ctx.fillStyle = "#6e7681";
      ctx.fillText(`#${slotOf(r.id)}`, 6, y);
      ctx.fillStyle = d.color;
      ctx.fillText(ellipsize(ctx, d.label, GUTTER - 46), 42, y);
    }
    ctx.restore();

    // ruler
    ctx.fillStyle = "rgba(22,27,34,.96)";
    ctx.fillRect(0, 0, cssW, RULER_H);
    ctx.strokeStyle = "#21262d";
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(cssW, RULER_H + 0.5);
    ctx.stroke();
    ctx.fillStyle = "#6e7681";
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, plotW, RULER_H);
    ctx.clip();
    for (let t = firstLine; t2x(t) <= cssW; t += step) {
      const x = t2x(t);
      ctx.strokeStyle = "rgba(110,118,129,.4)";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H - 5);
      ctx.lineTo(Math.round(x) + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(fmtRuler(this.unit, t), x + 3, RULER_H / 2);
    }
    ctx.restore();
    ctx.fillStyle = "#484f58";
    ctx.fillText(this.unit, 6, RULER_H / 2);

    // now line
    const nowX = t2x(now);
    if (nowX >= GUTTER && nowX <= cssW) {
      ctx.strokeStyle = "rgba(88,166,255,.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(nowX) + 0.5, 0);
      ctx.lineTo(Math.round(nowX) + 0.5, cssH);
      ctx.stroke();
    }

    this.liveBtn.classList.toggle("on", v.follow);
  }

  // ── wheel pan/zoom + drag-pan + hover tooltip ──
  private attachInteraction(): void {
    const cv = this.canvas;
    const plotWidth = (): number => Math.max(1, this.wrap.clientWidth - GUTTER);
    const maxScrollY = (): number =>
      Math.max(0, this.recorder.records().length * ROW_H - (this.wrap.clientHeight - RULER_H));
    const reconcileFollow = (now: number): void => {
      const v = this.view;
      v.follow = v.viewStart + v.span >= now - v.span * 0.01;
    };

    cv.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const v = this.view;
        const cfg = UNIT_CFG[this.unit];
        const now = this.now();
        const pxPerUnit = plotWidth() / v.span;
        if (e.ctrlKey) {
          const rect = cv.getBoundingClientRect();
          const px = clamp(e.clientX - rect.left, GUTTER, rect.width);
          const tUnder = v.viewStart + (px - GUTTER) / pxPerUnit;
          const newSpan = clamp(v.span * Math.exp(e.deltaY * 0.01), cfg.min, cfg.max);
          if (v.follow) {
            v.span = newSpan;
            v.viewStart = now - newSpan;
          } else {
            const newPxPerUnit = plotWidth() / newSpan;
            v.span = newSpan;
            v.viewStart = tUnder - (px - GUTTER) / newPxPerUnit;
          }
          return;
        }
        if (e.deltaX !== 0) {
          v.viewStart += e.deltaX / pxPerUnit;
          reconcileFollow(now);
        }
        if (e.deltaY !== 0) {
          v.scrollY = clamp(v.scrollY + e.deltaY, 0, maxScrollY());
          v.stickBottom = v.scrollY >= maxScrollY() - 1;
        }
      },
      { passive: false },
    );

    let drag: { x: number; vs: number } | null = null;
    cv.addEventListener("pointerdown", (e) => {
      if (e.clientX - cv.getBoundingClientRect().left < GUTTER) return;
      drag = { x: e.clientX, vs: this.view.viewStart };
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = "grabbing";
      this.hideTip();
    });
    cv.addEventListener("pointermove", (e) => {
      if (drag !== null) {
        const v = this.view;
        v.viewStart = drag.vs - (e.clientX - drag.x) / (plotWidth() / v.span);
        reconcileFollow(this.now());
        return;
      }
      this.showTip(e);
    });
    const endDrag = (e: PointerEvent): void => {
      if (drag === null) return;
      drag = null;
      cv.style.cursor = "";
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    cv.addEventListener("pointerup", endDrag);
    cv.addEventListener("pointercancel", endDrag);
    cv.addEventListener("pointerleave", () => this.hideTip());
  }

  private hideTip(): void {
    this.tip.style.display = "none";
  }

  private showTip(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const my = e.clientY - rect.top;
    if (my < RULER_H) return this.hideTip();
    const v = this.view;
    const row = Math.floor((my - RULER_H + v.scrollY) / ROW_H);
    const recs = this.recorder.records();
    if (row < 0 || row >= recs.length) return this.hideTip();
    const r = recs[row];
    const alive = r.diedMs === null;
    const d = this.desc(r);
    const dMs = (alive ? this.recorder.nowMs() : (r.diedMs as number)) - r.bornMs;
    const dTk = (alive ? this.world().tickCount : (r.diedTick as number)) - r.bornTick;
    const diedTxt = alive ? "alive" : `t${r.diedTick} · ${fmtMs(r.diedMs as number)}`;
    this.tip.innerHTML =
      `<b>#${slotOf(r.id)}·${genOf(r.id)}</b> ${escapeHtml(d.label)}` +
      (d.phase !== null ? ` <span class="k">${escapeHtml(d.phase)}</span>` : "") +
      `<div>born&nbsp; t${r.bornTick} · ${fmtMs(r.bornMs)}</div>` +
      `<div>died&nbsp; ${diedTxt}</div>` +
      `<div>life&nbsp;&nbsp; ${dTk} tick${dTk === 1 ? "" : "s"} · ${fmtMs(dMs)}</div>`;
    this.tip.style.display = "block";
    const tx = e.clientX - rect.left + 12;
    const ty = my + 12;
    this.tip.style.left = `${Math.min(tx, this.wrap.clientWidth - this.tip.offsetWidth - 6)}px`;
    this.tip.style.top = `${Math.min(ty, this.wrap.clientHeight - this.tip.offsetHeight - 6)}px`;
  }
}

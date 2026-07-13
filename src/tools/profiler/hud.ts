/**
 * `attachProfiler` — the frame profiler's overlay shell. A compact always-on cockpit (the
 * generalization of the canvas-editor example's HUD), distinct from the observer panel on
 * purpose: the panel is an inspector you OPEN, the profiler is a meter you LEAVE ON.
 *
 * Collapsed: fps + tick µs + a frame-time sparkline (gray = whole frame, purple overlay =
 * the ECS share, green line = budget — a wandering line is more credible than a pinned 60).
 * Expanded (click): frame/tick percentiles, per-lane costs, the hottest systems, and the
 * worst-frame breakdown with a reset.
 *
 * Cost discipline, same as the example it grew from: the sparkline draws on the overlay's
 * OWN rAF (never inside observer callbacks — DOM work there would bill itself to the tick),
 * text re-renders at 10 Hz, `stats()` aggregation runs at 10 Hz and only while expanded do
 * the table sections render. The rAF pauses with the tab (browser semantics), and
 * `dispose()` tears down rAF, recorder hooks and DOM.
 */

import type { World } from "../../core/index";
import {
  createProfilerRecorder,
  type ProfilerStats,
  type ProfilerSystemStat,
} from "./recorder";

export interface ProfilerOptions {
  /** Where to mount the overlay (default: document.body). */
  container?: HTMLElement;
  /** Frame budget in ms — the sparkline's green line, the over-budget counter and the
   *  vertical scale (2× budget tops it out). Default 16.7. */
  budgetMs?: number;
  /** Sample window in frames (default 240 — four seconds at 60fps). */
  windowSize?: number;
  /** Lanes to pre-register so their display order/colors are stable before the first report. */
  lanes?: readonly string[];
  /** Screen corner (default "br"). */
  corner?: "tl" | "tr" | "bl" | "br";
  /** Start with the detail sections open (default false). */
  expanded?: boolean;
}

export interface ProfilerHandle {
  /** Report a host-side cost (ms) for the current frame — paint, layout, network decode…
   *  Multiple reports to one lane within a frame accumulate. Lane names should be a small
   *  fixed set — slots are never evicted. */
  lane(name: string, ms: number): void;
  /** Programmatic snapshot of everything the overlay shows. */
  stats(): ProfilerStats;
  /** Start measuring fresh (clears the window, counters and the worst-frame capture). */
  reset(): void;
  /** Remove the overlay and detach from the world. */
  dispose(): void;
}

const STYLE_ID = "strata-prof-style";

const CSS = `
.strata-prof { position: fixed; z-index: 99998; background: rgba(13,17,23,.96);
  border: 1px solid #30363d; border-radius: 10px; color: #e6edf3;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  box-shadow: 0 6px 22px rgba(0,0,0,.45); user-select: none; }
.strata-prof * { box-sizing: border-box; }
.strata-prof.tl { top: 10px; left: 10px; } .strata-prof.tr { top: 10px; right: 10px; }
.strata-prof.bl { bottom: 10px; left: 10px; } .strata-prof.br { bottom: 10px; right: 10px; }
.strata-prof-head { display: flex; align-items: center; gap: 8px; padding: 6px 9px; cursor: pointer; }
.strata-prof-fps { font-weight: 700; color: #a371f7; min-width: 46px; }
.strata-prof-tick { color: #8b949e; min-width: 74px; }
.strata-prof-spark { display: block; }
.strata-prof-caret { color: #8b949e; }
.strata-prof-body { display: none; border-top: 1px solid #21262d; padding: 7px 9px 8px; min-width: 288px; }
.strata-prof.open .strata-prof-body { display: block; }
.strata-prof-sect { color: #8b949e; font-weight: 700; padding: 5px 0 2px; }
.strata-prof-row { display: flex; align-items: center; gap: 7px; padding: 1px 0; white-space: nowrap; }
.strata-prof-name { min-width: 96px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.strata-prof-bar { flex: 1; height: 5px; border-radius: 3px; background: #21262d; overflow: hidden; }
.strata-prof-bar > i { display: block; height: 100%; background: #58a6ff; border-radius: 3px; }
.strata-prof-stat { color: #8b949e; margin-left: auto; }
.strata-prof-dim { color: #8b949e; }
.strata-prof-more { color: #8b949e; padding: 1px 0; }
.strata-prof-foot { display: flex; align-items: center; gap: 8px; padding-top: 6px; color: #8b949e; }
.strata-prof-btn { background: none; border: 1px solid #30363d; border-radius: 6px; color: #8b949e;
  cursor: pointer; font: inherit; padding: 1px 8px; margin-left: auto; }
.strata-prof-btn:hover { color: #e6edf3; border-color: #8b949e; }
`;

function injectStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID) !== null) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

// `"` and `'` included: names are untrusted display strings and one sink is a title="…" attribute.
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]);
const fmtMs = (ms: number): string => (ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(0)}µs`);
const fmtUs = (us: number): string => (us >= 1000 ? `${(us / 1000).toFixed(2)}ms` : `${us.toFixed(0)}µs`);

const SPARK_W = 132; // 66 samples at 2px/bar
const SPARK_H = 26;
const SPARK_SAMPLES = SPARK_W / 2;
const TOP_SYSTEMS = 8;

/** Mount the frame-profiler overlay over a world. One line to attach in the canonical
 *  loop shape; `lane()` is the optional extra fidelity. Returns a handle whose `dispose()`
 *  detaches everything (world hooks, rAF, DOM). */
export function attachProfiler(world: World, opts: ProfilerOptions = {}): ProfilerHandle {
  const container = opts.container ?? document.body;
  const budgetMs = opts.budgetMs ?? 16.7;
  const recorder = createProfilerRecorder(world, {
    windowSize: opts.windowSize,
    budgetMs,
    lanes: opts.lanes,
  });
  injectStyle(container.ownerDocument);

  const root = container.ownerDocument.createElement("div");
  root.className = `strata-prof ${opts.corner ?? "br"}${opts.expanded === true ? " open" : ""}`;
  root.innerHTML =
    `<div class="strata-prof-head">` +
    `<span class="strata-prof-fps">— fps</span>` +
    `<span class="strata-prof-tick">tick —</span>` +
    `<canvas class="strata-prof-spark"></canvas>` +
    `<span class="strata-prof-caret">▸</span>` +
    `</div>` +
    `<div class="strata-prof-body"></div>`;
  container.appendChild(root);

  const head = root.querySelector(".strata-prof-head") as HTMLElement;
  const fpsEl = root.querySelector(".strata-prof-fps") as HTMLElement;
  const tickEl = root.querySelector(".strata-prof-tick") as HTMLElement;
  const caret = root.querySelector(".strata-prof-caret") as HTMLElement;
  const body = root.querySelector(".strata-prof-body") as HTMLElement;
  const sparkEl = root.querySelector(".strata-prof-spark") as HTMLCanvasElement;

  const dpr = Math.min(2, container.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  sparkEl.width = SPARK_W * dpr;
  sparkEl.height = SPARK_H * dpr;
  sparkEl.style.width = `${SPARK_W}px`;
  sparkEl.style.height = `${SPARK_H}px`;
  // happy-dom & friends return null here — the overlay then simply skips sparkline drawing
  const spark = sparkEl.getContext("2d");
  spark?.scale(dpr, dpr);

  const onHeadClick = (): void => {
    root.classList.toggle("open");
    caret.textContent = root.classList.contains("open") ? "▾" : "▸";
    renderText(); // the body may be stale from while it was hidden
  };
  head.addEventListener("click", onHeadClick);

  // Refilled per rAF — fixed buffers so the draw loop allocates nothing in steady state.
  const frameSamples = new Float32Array(SPARK_SAMPLES);
  const tickSamples = new Float32Array(SPARK_SAMPLES);
  const scaleMs = budgetMs * 2; // budget sits mid-chart; spikes clamp at the top

  const drawSpark = (): void => {
    if (spark === null) return;
    const n = recorder.copyRecent("frame", frameSamples);
    recorder.copyRecent("tick", tickSamples);
    spark.clearRect(0, 0, SPARK_W, SPARK_H);
    spark.fillStyle = "rgba(110,118,129,.28)";
    for (let i = 0; i < n; i++) {
      const h = Math.min(frameSamples[i] / scaleMs, 1) * SPARK_H;
      spark.fillRect((SPARK_SAMPLES - n + i) * 2, SPARK_H - h, 1.6, h);
    }
    spark.fillStyle = "#a371f7";
    for (let i = 0; i < n; i++) {
      const h = Math.min(tickSamples[i] / scaleMs, 1) * SPARK_H;
      spark.fillRect((SPARK_SAMPLES - n + i) * 2, SPARK_H - h, 1.6, h);
    }
    spark.fillStyle = "rgba(63,185,80,.5)";
    spark.fillRect(0, SPARK_H - (budgetMs / scaleMs) * SPARK_H, SPARK_W, 1);
  };

  const pctRow = (label: string, p: { p50: number; p95: number; p99: number; max: number }, extra = ""): string =>
    `<div class="strata-prof-row"><span class="strata-prof-name">${label}</span>` +
    `<span>p50 ${fmtMs(p.p50)} · p95 ${fmtMs(p.p95)} · p99 ${fmtMs(p.p99)} · max ${fmtMs(p.max)}${extra}</span></div>`;

  const sysRow = (s: ProfilerSystemStat, maxAvg: number): string => {
    const total = s.runs + s.skips;
    const idle = total === 0 ? 0 : Math.round((s.skips / total) * 100);
    const stat = idle > 0 ? `${fmtUs(s.avgUs)} · ${idle}% idle` : `${fmtUs(s.avgUs)} · max ${fmtUs(s.maxUs)}`;
    return (
      `<div class="strata-prof-row" title="${esc(s.phase)}">` +
      `<span class="strata-prof-name">${esc(s.isFlush ? `⤓ ${s.phase} flush` : s.name)}</span>` +
      `<span class="strata-prof-bar"><i style="width:${Math.max(2, (s.avgUs / maxAvg) * 100).toFixed(1)}%"></i></span>` +
      `<span class="strata-prof-stat">${stat}</span></div>`
    );
  };

  const renderBody = (s: ProfilerStats): void => {
    const parts: string[] = [];
    parts.push(`<div class="strata-prof-sect">frame</div>`);
    parts.push(pctRow("frame", s.frame, ` · <span class="strata-prof-dim">${s.overBudgetPct.toFixed(0)}% over</span>`));
    parts.push(pctRow("tick", s.tick));

    if (s.lanes.length > 0) {
      parts.push(`<div class="strata-prof-sect">lanes</div>`);
      const laneMax = Math.max(0.001, ...s.lanes.map((l) => l.avgMs));
      for (const l of s.lanes) {
        parts.push(
          `<div class="strata-prof-row"><span class="strata-prof-name">${esc(l.name)}</span>` +
            `<span class="strata-prof-bar"><i style="width:${Math.max(2, (l.avgMs / laneMax) * 100).toFixed(1)}%"></i></span>` +
            `<span class="strata-prof-stat">${fmtMs(l.avgMs)} · max ${fmtMs(l.maxMs)}</span></div>`,
        );
      }
    }

    if (s.systems.length > 0) {
      parts.push(`<div class="strata-prof-sect">hottest systems</div>`);
      const sorted = [...s.systems].sort((a, b) => b.avgUs - a.avgUs);
      const shown = sorted.slice(0, TOP_SYSTEMS);
      const maxAvg = Math.max(1, shown[0]?.avgUs ?? 1);
      for (const sys of shown) parts.push(sysRow(sys, maxAvg));
      if (sorted.length > TOP_SYSTEMS)
        parts.push(`<div class="strata-prof-more">… ${sorted.length - TOP_SYSTEMS} more (see the observer panel)</div>`);
    }

    if (s.worst !== null) {
      const w = s.worst;
      parts.push(`<div class="strata-prof-sect">worst frame</div>`);
      parts.push(
        `<div class="strata-prof-row"><span>${fmtMs(w.frameMs)} @ tick ${w.tick.toLocaleString()}` +
          ` · <span class="strata-prof-dim">ecs ${fmtMs(w.tickMs)}</span></span></div>`,
      );
      for (const l of w.lanes)
        parts.push(
          `<div class="strata-prof-row"><span class="strata-prof-name">${esc(l.name)}</span>` +
            `<span class="strata-prof-stat">${fmtMs(l.ms)}</span></div>`,
        );
      for (const sys of w.systems.slice(0, 4))
        parts.push(
          `<div class="strata-prof-row"><span class="strata-prof-name">${esc(sys.isFlush ? `⤓ ${sys.phase} flush` : sys.name)}</span>` +
            `<span class="strata-prof-stat">${fmtUs(sys.micros)}</span></div>`,
        );
    }

    parts.push(
      `<div class="strata-prof-foot"><span>${s.samples} samples · budget ${fmtMs(budgetMs)}</span>` +
        `<button type="button" class="strata-prof-btn">↺ reset</button></div>`,
    );
    body.innerHTML = parts.join("");
    // innerHTML replaced the node — rebind. One listener, rebuilt with the body at 10 Hz.
    body.querySelector(".strata-prof-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      recorder.reset();
      renderText();
    });
  };

  let lastText = -1e9; // first loop pass always renders the head text
  const renderText = (): void => {
    const s = recorder.stats();
    if (s.samples === 0) {
      fpsEl.textContent = "— fps";
      tickEl.textContent = "waiting for ticks";
    } else {
      fpsEl.textContent = `${s.fps.toFixed(0)} fps`;
      tickEl.textContent = `tick ${fmtMs(s.tick.last)}`;
    }
    if (root.classList.contains("open")) renderBody(s);
  };

  let raf = 0;
  const loop = (): void => {
    raf = (container.ownerDocument.defaultView ?? window).requestAnimationFrame(loop);
    drawSpark();
    const t = performance.now();
    if (t - lastText < 100) return; // 10 Hz text — the profiler must not become the cost
    lastText = t;
    renderText();
  };
  loop();

  return {
    lane: (name, ms) => recorder.lane(name, ms),
    stats: () => recorder.stats(),
    reset: () => {
      recorder.reset();
      renderText();
    },
    dispose() {
      (container.ownerDocument.defaultView ?? window).cancelAnimationFrame(raf);
      head.removeEventListener("click", onHeadClick);
      recorder.dispose();
      root.remove();
    },
  };
}

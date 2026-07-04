/**
 * The app HUD: fps + the ECS-vs-paint frame split, a frame-time sparkline (a wandering line
 * is more credible than a pinned 60), stress controls, SIMULATE, and the self-inflicted-
 * jank toggles. The per-system µs table lives in the strata-ecs/tools observer panel — this HUD
 * is the app's own cockpit. Text updates at 10 Hz; only the tiny sparkline draws per frame.
 */

import type { FrameStats } from "../app/frameLoop";
import { stats } from "../app/commands";
import { drawBuffer } from "../render/drawBuffer";
import { cam } from "../app/camera";

const fmtMs = (ms: number): string => (ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(0)}µs`);

const SPARK_W = 240;
const SPARK_H = 34;
const SAMPLES = 120;

export interface HudActions {
  onSimToggle(on: boolean): void;
  onSpawn(n: number): void;
  onClear(): void;
  onSystemToggle(name: string, enabled: boolean): void;
  onCullTestToggle(enabled: boolean): void;
  onLodToggle(enabled: boolean): void;
  systemNames: readonly string[];
}

export class Hud {
  private fpsEma = 60;
  private ecsEma = 0;
  private contentEma = 0;
  private overlayEma = 0;
  private lastText = 0;
  private readonly note: HTMLDivElement;
  private readonly collab: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly spark: CanvasRenderingContext2D;
  private readonly frameRing = new Float32Array(SAMPLES);
  private readonly ecsRing = new Float32Array(SAMPLES);
  private ringIdx = 0;
  private simOn = false;
  private simBtn!: HTMLButtonElement;

  constructor(root: HTMLElement, actions: HudActions) {
    root.innerHTML =
      `<div class="hud-title">strata canvas</div>` +
      `<div class="hud-collab"></div>` +
      `<div class="hud-body"></div>` +
      `<canvas class="hud-spark" width="${SPARK_W * 2}" height="${SPARK_H * 2}" style="width:${SPARK_W}px;height:${SPARK_H}px"></canvas>` +
      `<div class="hud-controls"></div>` +
      `<div class="hud-note"></div>`;
    this.body = root.querySelector(".hud-body") as HTMLDivElement;
    this.note = root.querySelector(".hud-note") as HTMLDivElement;
    this.collab = root.querySelector(".hud-collab") as HTMLDivElement;
    const sparkEl = root.querySelector(".hud-spark") as HTMLCanvasElement;
    this.spark = sparkEl.getContext("2d") as CanvasRenderingContext2D;
    this.spark.scale(2, 2);
    this.buildControls(root.querySelector(".hud-controls") as HTMLDivElement, actions);
  }

  private buildControls(el: HTMLDivElement, a: HudActions): void {
    const btn = (label: string, title: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", () => onClick(b));
      el.appendChild(b);
      return b;
    };
    this.simBtn = btn(
      "▶ simulate",
      "Give every shape a velocity and run the simulate phase — keep editing while it storms",
      () => {
        this.setSimState(!this.simOn);
        a.onSimToggle(this.simOn);
      },
    );
    btn("+1k", "Spawn 1,000 fully-initialized shapes", () => a.onSpawn(1000));
    btn("+10k", "Spawn 10,000 fully-initialized shapes", () => a.onSpawn(10_000));
    btn("clear", "Destroy the whole document (arrows cascade)", () => a.onClear());

    const checks = document.createElement("div");
    checks.className = "hud-checks";
    el.appendChild(checks);
    const check = (label: string, title: string, initial: boolean, onChange: (on: boolean) => void): void => {
      const lab = document.createElement("label");
      lab.title = title;
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = initial;
      c.addEventListener("change", () => onChange(c.checked));
      lab.append(c, document.createTextNode(label));
      checks.appendChild(lab);
    };
    for (const name of a.systemNames) {
      check(name, `Remove ${name} from the pipeline (the schedule is a plain array — rebuild it live)`, true, (on) =>
        a.onSystemToggle(name, on),
      );
    }
    check("cull test", "Disable the viewport test: every shape goes to paint — watch the sparkline crater", true, (on) =>
      a.onCullTestToggle(on),
    );
    check("LOD", "Disable text greeking + stroke dropping at far zoom", true, (on) => a.onLodToggle(on));
  }

  setNote(text: string): void {
    this.note.textContent = text;
  }

  /** Collab sync chips (room · peers · pending/held/applied). Driven by observeResource on the two
   *  status resources — set-on-change, so an idle network never calls this (the HUD never polls). */
  setCollabChips(text: string): void {
    this.collab.textContent = text;
    this.collab.classList.add("on");
  }

  /** Keep the button in step with the WORLD's SimMode (boot ?sim=1, autosave restore) —
   *  a desynced button would re-randomize a running storm instead of pausing it. */
  setSimState(on: boolean): void {
    this.simOn = on;
    this.simBtn.textContent = on ? "⏸ simulate" : "▶ simulate";
    this.simBtn.classList.toggle("on", on);
  }

  frame(s: FrameStats, selected = 0): void {
    const a = 0.08;
    this.fpsEma += (1000 / Math.max(s.frameMs, 0.01) - this.fpsEma) * a;
    this.ecsEma += (s.ecsMs - this.ecsEma) * a;
    if (s.painted) this.contentEma += (s.contentMs - this.contentEma) * 0.3;
    this.overlayEma += (s.overlayMs - this.overlayEma) * a;

    this.frameRing[this.ringIdx] = s.frameMs;
    this.ecsRing[this.ringIdx] = s.ecsMs;
    this.ringIdx = (this.ringIdx + 1) % SAMPLES;
    this.drawSpark();

    const now = performance.now();
    if (now - this.lastText < 100) return; // 10 Hz DOM writes — the HUD must not become the cost
    this.lastText = now;
    this.body.textContent =
      `${this.fpsEma.toFixed(0)} fps · ecs ${fmtMs(this.ecsEma)} · paint ${fmtMs(this.contentEma)} +${fmtMs(this.overlayEma)} overlay\n` +
      `${stats.entities.toLocaleString()} entities · ${drawBuffer.count.toLocaleString()} visible · ` +
      `${selected.toLocaleString()} selected · zoom ${(cam.zoom * 100).toFixed(0)}%`;
  }

  /** 2px bars: gray = whole frame, purple overlay = the ECS share. 33ms tops the scale. */
  private drawSpark(): void {
    const ctx = this.spark;
    ctx.clearRect(0, 0, SPARK_W, SPARK_H);
    ctx.fillStyle = "rgba(110,118,129,.28)";
    for (let i = 0; i < SAMPLES; i++) {
      const v = this.frameRing[(this.ringIdx + i) % SAMPLES];
      const h = Math.min(v / 33.3, 1) * SPARK_H;
      ctx.fillRect(i * 2, SPARK_H - h, 1.6, h);
    }
    ctx.fillStyle = "#a371f7";
    for (let i = 0; i < SAMPLES; i++) {
      const v = this.ecsRing[(this.ringIdx + i) % SAMPLES];
      const h = Math.min(v / 33.3, 1) * SPARK_H;
      ctx.fillRect(i * 2, SPARK_H - h, 1.6, h);
    }
    // the 60fps line
    ctx.fillStyle = "rgba(63,185,80,.5)";
    ctx.fillRect(0, SPARK_H - (16.7 / 33.3) * SPARK_H, SPARK_W, 1);
  }
}

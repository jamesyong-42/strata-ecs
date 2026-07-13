/**
 * The app HUD — the app's own cockpit: document stats, stress controls, SIMULATE, and the
 * self-inflicted-jank toggles. The PERF readout lives in the framework's tools now: fps,
 * sparkline, percentiles and the worst-frame breakdown in the strata-ecs/tools profiler
 * overlay (bottom-left; this HUD grew into it and then handed that job back to the library),
 * and the per-system µs table in the observer panel. Text updates at 10 Hz.
 */

import { stats } from "../app/commands";
import { drawBuffer } from "../render/drawBuffer";
import { cam } from "../app/camera";

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
  private lastText = 0;
  private readonly note: HTMLDivElement;
  private readonly collab: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly controls: HTMLDivElement;
  private simOn = false;
  private simBtn!: HTMLButtonElement;
  // undo/redo — created only in collab mode (enableHistory); disabled state driven reactively.
  private undoBtn?: HTMLButtonElement;
  private redoBtn?: HTMLButtonElement;

  constructor(root: HTMLElement, actions: HudActions) {
    root.innerHTML =
      `<div class="hud-title">strata canvas</div>` +
      `<div class="hud-collab"></div>` +
      `<div class="hud-body"></div>` +
      `<div class="hud-controls"></div>` +
      `<div class="hud-note"></div>`;
    this.body = root.querySelector(".hud-body") as HTMLDivElement;
    this.note = root.querySelector(".hud-note") as HTMLDivElement;
    this.collab = root.querySelector(".hud-collab") as HTMLDivElement;
    this.controls = root.querySelector(".hud-controls") as HTMLDivElement;
    this.buildControls(this.controls, actions);
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

  /** Add the undo/redo control buttons — COLLAB MODE ONLY (the ?collab boot calls this once). They share
   *  the control-button style and start disabled; {@link setHistoryState} drives their enabled state. */
  enableHistory(actions: { onUndo(): void; onRedo(): void }): void {
    const mk = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.disabled = true;
      b.addEventListener("click", onClick);
      return b;
    };
    this.undoBtn = mk("↶ undo", "Undo the last change (Cmd/Ctrl+Z) — local edits only, converges on every peer", actions.onUndo);
    this.redoBtn = mk("↷ redo", "Redo (Shift+Cmd/Ctrl+Z or Ctrl+Y)", actions.onRedo);
    this.controls.prepend(this.redoBtn);
    this.controls.prepend(this.undoBtn); // prepend redo then undo → [undo][redo] lead the control row
  }

  /** Enable/disable the undo/redo buttons — called reactively from DurableUndoStatus (set-on-change, so
   *  this fires only when a button's availability actually flips, never per frame). */
  setHistoryState(canUndo: boolean, canRedo: boolean): void {
    if (this.undoBtn !== undefined) this.undoBtn.disabled = !canUndo;
    if (this.redoBtn !== undefined) this.redoBtn.disabled = !canRedo;
  }

  /** Keep the button in step with the WORLD's SimMode (boot ?sim=1, autosave restore) —
   *  a desynced button would re-randomize a running storm instead of pausing it. */
  setSimState(on: boolean): void {
    this.simOn = on;
    this.simBtn.textContent = on ? "⏸ simulate" : "▶ simulate";
    this.simBtn.classList.toggle("on", on);
  }

  /** Called per frame; writes DOM at 10 Hz — the HUD must not become the cost. */
  frame(selected = 0): void {
    const now = performance.now();
    if (now - this.lastText < 100) return;
    this.lastText = now;
    this.body.textContent =
      `${stats.entities.toLocaleString()} entities · ${drawBuffer.count.toLocaleString()} visible · ` +
      `${selected.toLocaleString()} selected · zoom ${(cam.zoom * 100).toFixed(0)}%`;
  }
}

/**
 * The observer window shell — draggable by its header, resizable (CSS `resize`), collapse
 * toggle, tab strip; position/size/open-state/tab persisted to localStorage so the panel
 * stays where you put it across reloads (which matter here: editing the schema module
 * full-reloads the page by design).
 */

const LS_KEY = "strata-obs:layout";
const MARGIN = 8;
const KEEP = 90; // px that must stay on screen so the header is always grabbable

export type TabId = "entities" | "systems" | "timeline";

interface Layout {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  open?: boolean;
  tab?: TabId;
}

function loadLayout(): Layout {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as Layout;
  } catch {
    return {};
  }
}

function saveLayout(patch: Layout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...loadLayout(), ...patch }));
  } catch {
    /* private mode / quota — non-fatal for a dev tool */
  }
}

function clampPos(x: number, y: number, w: number): { x: number; y: number } {
  const maxX = window.innerWidth - KEEP;
  const minX = Math.min(MARGIN, MARGIN - (w - KEEP));
  const maxY = window.innerHeight - 34;
  return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, MARGIN), maxY) };
}

export class Panel {
  readonly el: HTMLDivElement;
  readonly summaryEl: HTMLSpanElement;
  readonly panes: Record<TabId, HTMLDivElement>;
  private tab: TabId;
  private open: boolean;
  private onTabChange: (t: TabId, open: boolean) => void = () => {};
  private readonly ro: ResizeObserver;
  private readonly onWinResize = (): void => {
    const r = this.el.getBoundingClientRect();
    const p = clampPos(r.left, r.top, this.el.offsetWidth);
    this.el.style.left = `${p.x}px`;
    this.el.style.top = `${p.y}px`;
  };

  constructor(container: HTMLElement, opts?: { defaultTab?: TabId; tab?: TabId }) {
    const l = loadLayout();
    // an explicit `tab` (e.g. from a shareable ?obs= link) beats the persisted layout;
    // `defaultTab` only fills in when nothing is persisted
    this.tab = opts?.tab ?? l.tab ?? opts?.defaultTab ?? "entities";
    this.open = l.open ?? true;

    this.el = document.createElement("div");
    this.el.className = "strata-obs";
    this.el.innerHTML =
      `<div class="strata-obs-head">` +
      `<span class="strata-obs-grip" aria-hidden="true">⠿</span>` +
      `<span class="strata-obs-live" aria-hidden="true"></span>` +
      `<span class="strata-obs-name">strata observer</span>` +
      `<span class="strata-obs-summary"></span>` +
      `<button type="button" class="strata-obs-btn" data-collapse title="Collapse">▾</button>` +
      `</div>` +
      `<div class="strata-obs-tabs" data-nodrag>` +
      `<button type="button" class="strata-obs-tab" data-tab="entities">entities</button>` +
      `<button type="button" class="strata-obs-tab" data-tab="systems">systems</button>` +
      `<button type="button" class="strata-obs-tab" data-tab="timeline">timeline</button>` +
      `</div>` +
      `<div class="strata-obs-body">` +
      `<div class="strata-obs-pane" data-pane="entities"></div>` +
      `<div class="strata-obs-pane" data-pane="systems"><div class="strata-obs-loop"></div></div>` +
      `<div class="strata-obs-pane" data-pane="timeline"></div>` +
      `</div>`;
    container.appendChild(this.el);

    this.summaryEl = this.el.querySelector(".strata-obs-summary") as HTMLSpanElement;
    this.panes = {
      entities: this.el.querySelector(`[data-pane="entities"]`) as HTMLDivElement,
      systems: this.el.querySelector(`[data-pane="systems"]`) as HTMLDivElement,
      timeline: this.el.querySelector(`[data-pane="timeline"]`) as HTMLDivElement,
    };

    // restore size, then position (clamped to the viewport)
    if (typeof l.w === "number") this.el.style.width = `${l.w}px`;
    if (typeof l.h === "number") this.el.style.height = `${l.h}px`;
    const w = this.el.offsetWidth;
    const p = clampPos(l.x ?? window.innerWidth - w - 16, l.y ?? 16, w);
    this.el.style.left = `${p.x}px`;
    this.el.style.top = `${p.y}px`;

    this.applyOpen();
    this.applyTab();
    this.wireDrag();
    window.addEventListener("resize", this.onWinResize);
    this.ro = new ResizeObserver(() => {
      if (this.open) saveLayout({ w: this.el.offsetWidth, h: this.el.offsetHeight });
    });
    this.ro.observe(this.el);

    (this.el.querySelector("[data-collapse]") as HTMLButtonElement).addEventListener("click", () => {
      this.open = !this.open;
      saveLayout({ open: this.open });
      this.applyOpen();
    });
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      b.addEventListener("click", () => {
        this.tab = b.dataset.tab as TabId;
        saveLayout({ tab: this.tab });
        this.applyTab();
      });
    }
  }

  get activeTab(): TabId {
    return this.tab;
  }

  get isOpen(): boolean {
    return this.open;
  }

  tabChanged(fn: (t: TabId, open: boolean) => void): void {
    this.onTabChange = fn;
  }

  setSummary(text: string): void {
    this.summaryEl.textContent = text;
  }

  dispose(): void {
    window.removeEventListener("resize", this.onWinResize);
    this.ro.disconnect();
    this.el.remove();
  }

  private applyOpen(): void {
    this.el.classList.toggle("collapsed", !this.open);
    (this.el.querySelector(".strata-obs-tabs") as HTMLElement).style.display = this.open ? "" : "none";
    (this.el.querySelector(".strata-obs-body") as HTMLElement).style.display = this.open ? "" : "none";
    (this.el.querySelector("[data-collapse]") as HTMLElement).textContent = this.open ? "▾" : "▸";
    this.onTabChange(this.tab, this.open);
  }

  private applyTab(): void {
    for (const b of this.el.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      b.classList.toggle("active", b.dataset.tab === this.tab);
    }
    for (const [id, pane] of Object.entries(this.panes)) {
      pane.classList.toggle("active", id === this.tab);
    }
    this.onTabChange(this.tab, this.open);
  }

  private wireDrag(): void {
    const head = this.el.querySelector(".strata-obs-head") as HTMLDivElement;
    let drag: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null;
    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") !== null) return; // let buttons be buttons
      const r = this.el.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      head.setPointerCapture(e.pointerId);
      this.el.classList.add("dragging");
      e.preventDefault();
    });
    head.addEventListener("pointermove", (e) => {
      if (drag?.id !== e.pointerId) return;
      const p = clampPos(drag.ox + (e.clientX - drag.sx), drag.oy + (e.clientY - drag.sy), this.el.offsetWidth);
      this.el.style.left = `${p.x}px`;
      this.el.style.top = `${p.y}px`;
    });
    const end = (e: PointerEvent): void => {
      if (drag?.id !== e.pointerId) return;
      drag = null;
      this.el.classList.remove("dragging");
      const r = this.el.getBoundingClientRect();
      saveLayout({ x: r.left, y: r.top });
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }

}

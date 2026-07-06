/**
 * The observer window shell — draggable by its header, resizable (CSS `resize`), collapse
 * toggle, tab strip; position/size/open-state/tab persisted to localStorage so the panel
 * stays where you put it across reloads (which matter here: editing the schema module
 * full-reloads the page by design).
 */

const LS_KEY = "strata-obs:layout";
const MARGIN = 8;
const KEEP = 90; // px that must stay on screen so the header is always grabbable

export type TabId = "entities" | "systems" | "timeline" | "durable" | "ephemeral";

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
  /** Built EXACTLY for the rendered tab list — a tab absent from `opts.tabs` has no pane (Partial). */
  readonly panes: Partial<Record<TabId, HTMLDivElement>>;
  private readonly tabs: readonly TabId[];
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

  constructor(container: HTMLElement, opts: { tabs: TabId[]; defaultTab?: TabId; tab?: TabId }) {
    // At least the base three are always passed; index 0 is the guaranteed fallback target below.
    this.tabs = opts.tabs.length > 0 ? [...opts.tabs] : (["entities"] as TabId[]);
    const l = loadLayout();
    // an explicit `tab` (e.g. from a shareable ?obs= link) beats the persisted layout; `defaultTab`
    // only fills in when nothing is persisted — but ANY of the three can name a tab this build does not
    // render (a persisted `durable` on an app that dropped the option), so fall back to the first tab.
    const wanted = opts.tab ?? l.tab ?? opts.defaultTab ?? this.tabs[0];
    this.tab = this.tabs.includes(wanted) ? wanted : this.tabs[0];
    this.open = l.open ?? true;

    this.el = document.createElement("div");
    this.el.className = "strata-obs";
    // The SHELL is a static markup literal (no data); the per-tab buttons/panes are generated below via
    // createElement + textContent (the tab id is a fixed union literal, never user/peer data — but it goes
    // through textContent regardless, so this stays clean of any innerHTML-with-data path).
    this.el.innerHTML =
      `<div class="strata-obs-head">` +
      `<span class="strata-obs-grip" aria-hidden="true">⠿</span>` +
      `<span class="strata-obs-live" aria-hidden="true"></span>` +
      `<span class="strata-obs-name">strata observer</span>` +
      `<span class="strata-obs-summary"></span>` +
      `<button type="button" class="strata-obs-btn" data-collapse title="Collapse">▾</button>` +
      `</div>` +
      `<div class="strata-obs-tabs" data-nodrag></div>` +
      `<div class="strata-obs-body"></div>`;
    container.appendChild(this.el);

    this.summaryEl = this.el.querySelector(".strata-obs-summary") as HTMLSpanElement;
    const doc = this.el.ownerDocument;
    const strip = this.el.querySelector(".strata-obs-tabs") as HTMLDivElement;
    const body = this.el.querySelector(".strata-obs-body") as HTMLDivElement;
    this.panes = {};
    for (const id of this.tabs) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "strata-obs-tab";
      btn.dataset.tab = id;
      btn.textContent = id;
      strip.appendChild(btn);

      const pane = doc.createElement("div");
      pane.className = "strata-obs-pane";
      pane.dataset.pane = id;
      // systems' pane hosts the loop readout root the LoopStats renders into (index.ts queries it).
      if (id === "systems") {
        const loopRoot = doc.createElement("div");
        loopRoot.className = "strata-obs-loop";
        pane.appendChild(loopRoot);
      }
      body.appendChild(pane);
      this.panes[id] = pane;
    }

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
    for (const id of this.tabs) {
      this.panes[id]?.classList.toggle("active", id === this.tab);
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

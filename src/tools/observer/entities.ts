/**
 * The entities tab — every live entity, virtualized (only visible rows exist in the DOM, so
 * a 100k-entity stress world scrolls fine), with a Flecs-Explorer-style detail pane showing
 * the selected entity's live component values, tags, and relations.
 *
 * Enumeration is a pure archetype walk (`world.runtime.archetypes()` — the tools are
 * first-party and may reach through the @internal runtime). The walk is SNAPSHOTTED once
 * per refresh and reused by scroll-driven window renders; visible-row resolution is a
 * single cumulative pass over that snapshot. All reads are the public read surface
 * (`get`/`hasTag`/`getRelations`/`getReverse`) at panel poll rate — never per frame.
 */

import type { Entity, World } from "../../core/index";
import { genOf, slotOf } from "../../core/entity";
import { componentById, relationById, relationCount, tagById, tagCount } from "../../core/schema";

const ROW_H = 20;
const FILTER_CAP = 5000;

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

function fmtValue(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function fmtData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${fmtValue(v)}`)
    .join("  ");
}

interface ArchSlice {
  entities: Uint32Array;
  count: number;
}

export class EntitiesTab {
  private readonly list: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly rows: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly filterInput: HTMLInputElement;
  private readonly matchInfo: HTMLSpanElement;
  private selected: Entity | null = null;
  private filter = "";
  /** Archetype snapshot for the current refresh window (scroll renders reuse it). */
  private snapshot: ArchSlice[] = [];
  private totalCount = 0;
  /** Filtered snapshot (capped at FILTER_CAP; the info span shows the true match count). */
  private filtered: Entity[] = [];
  private trueMatches = 0;
  private lastDetailHtml = "";

  constructor(
    root: HTMLElement,
    private readonly world: () => World,
  ) {
    root.innerHTML =
      `<div class="strata-obs-filterrow"><input class="strata-obs-filter" placeholder="filter by component name…" />` +
      `<span class="strata-obs-stat"></span></div>` +
      `<div class="strata-obs-list"><div class="strata-obs-spacer"></div><div class="strata-obs-rows"></div></div>` +
      `<div class="strata-obs-detail"><div class="strata-obs-empty">click an entity</div></div>`;
    this.filterInput = root.querySelector(".strata-obs-filter") as HTMLInputElement;
    this.matchInfo = root.querySelector(".strata-obs-filterrow .strata-obs-stat") as HTMLSpanElement;
    this.list = root.querySelector(".strata-obs-list") as HTMLDivElement;
    this.spacer = root.querySelector(".strata-obs-spacer") as HTMLDivElement;
    this.rows = root.querySelector(".strata-obs-rows") as HTMLDivElement;
    this.detail = root.querySelector(".strata-obs-detail") as HTMLDivElement;

    this.filterInput.addEventListener("input", () => {
      this.filter = this.filterInput.value.trim().toLowerCase();
      this.refresh();
    });
    this.list.addEventListener("scroll", () => this.renderWindow());
    this.rows.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest("[data-e]");
      if (row === null) return;
      const id = Number((row as HTMLElement).dataset.e);
      if (!Number.isInteger(id)) return;
      this.selected = id as Entity;
      this.refresh();
    });
  }

  /** Called at the panel poll rate while this tab is visible. */
  refresh(): void {
    this.rebuildSnapshot();
    this.renderWindow();
    this.renderDetail();
  }

  /** One archetype walk per refresh; scroll renders between polls reuse the result. */
  private rebuildSnapshot(): void {
    const w = this.world();
    this.snapshot.length = 0;
    this.totalCount = 0;
    this.trueMatches = 0;
    for (const arch of w.runtime.archetypes()) {
      if (arch.count === 0) continue;
      if (this.filter !== "") {
        // archetype-level match on component names keeps filtering O(archetypes)
        let ok = false;
        for (const cid of arch.componentIds) {
          const c = componentById(cid);
          if (c !== undefined && c.name.toLowerCase().includes(this.filter)) {
            ok = true;
            break;
          }
        }
        if (!ok) continue;
        this.trueMatches += arch.count;
      }
      this.snapshot.push({ entities: arch.entities, count: arch.count });
      this.totalCount += arch.count;
    }
    if (this.filter !== "") {
      this.filtered.length = 0;
      for (const a of this.snapshot) {
        for (let i = 0; i < a.count && this.filtered.length < FILTER_CAP; i++) {
          this.filtered.push(a.entities[i] as Entity);
        }
      }
      this.matchInfo.textContent =
        this.trueMatches > FILTER_CAP
          ? `showing ${FILTER_CAP.toLocaleString()} of ${this.trueMatches.toLocaleString()}`
          : `${this.trueMatches.toLocaleString()} matches`;
    } else {
      this.matchInfo.textContent = "";
    }
  }

  private rowHtml(w: World, e: Entity): string {
    const arch = w.runtime.archetypeOf(e);
    const names: string[] = [];
    if (arch !== undefined) {
      for (const cid of arch.componentIds) {
        const c = componentById(cid);
        if (c !== undefined) names.push(c.name);
        if (names.length === 3) break;
      }
    }
    const chips: string[] = [];
    const tn = tagCount();
    for (let t = 0; t < tn && chips.length < 3; t++) {
      const tag = tagById(t);
      if (tag !== undefined && w.hasTag(e, tag)) chips.push(`<span class="strata-obs-chip">${esc(tag.name)}</span>`);
    }
    return (
      `<div class="strata-obs-row${e === this.selected ? " sel" : ""}" data-e="${e}">` +
      `<span class="strata-obs-id">#${slotOf(e)}·${genOf(e)}</span>` +
      `<span class="strata-obs-label">${esc(names.join("·") || "∅")}</span>` +
      chips.join("") +
      `</div>`
    );
  }

  private renderWindow(): void {
    const w = this.world();
    const usingFilter = this.filter !== "";
    const total = usingFilter ? this.filtered.length : this.totalCount;
    this.spacer.style.height = `${total * ROW_H}px`;
    const first = Math.max(0, Math.floor(this.list.scrollTop / ROW_H) - 4);
    const last = Math.min(total - 1, Math.ceil((this.list.scrollTop + this.list.clientHeight) / ROW_H) + 4);
    this.rows.style.top = `${first * ROW_H}px`;

    const parts: string[] = [];
    if (usingFilter) {
      for (let i = first; i <= last; i++) parts.push(this.rowHtml(w, this.filtered[i]));
    } else {
      // single cumulative pass over the snapshot — no per-row re-walk
      let base = 0;
      let i = first;
      for (const a of this.snapshot) {
        if (i > last) break;
        if (i >= base + a.count) {
          base += a.count;
          continue;
        }
        while (i <= last && i - base < a.count) {
          parts.push(this.rowHtml(w, a.entities[i - base] as Entity));
          i++;
        }
        base += a.count;
      }
    }
    this.rows.innerHTML = total === 0 ? `<div class="strata-obs-empty">no entities</div>` : parts.join("");
  }

  private renderDetail(): void {
    const w = this.world();
    const e = this.selected;
    let html: string;
    if (e === null || !w.isAlive(e)) {
      html = `<div class="strata-obs-empty">${e === null ? "click an entity" : "entity destroyed"}</div>`;
    } else {
      const parts: string[] = [
        `<div class="strata-obs-comp"><span class="strata-obs-cname">#${slotOf(e)}·${genOf(e)}</span></div>`,
      ];
      const arch = w.runtime.archetypeOf(e);
      if (arch !== undefined) {
        for (const cid of arch.componentIds) {
          const c = componentById(cid);
          if (c === undefined) continue;
          const value = w.get(e, c);
          parts.push(
            `<div class="strata-obs-comp"><span class="strata-obs-cname">${esc(c.name)}</span>` +
              `<span class="strata-obs-cval">${esc(value === undefined ? "—" : fmtData(value as Record<string, unknown>))}</span></div>`,
          );
        }
      }
      const tn = tagCount();
      const tags: string[] = [];
      for (let t = 0; t < tn; t++) {
        const tag = tagById(t);
        if (tag !== undefined && w.hasTag(e, tag)) tags.push(esc(tag.name));
      }
      if (tags.length > 0) {
        parts.push(
          `<div class="strata-obs-comp"><span class="strata-obs-cname">tags</span><span class="strata-obs-cval">${tags.join("  ")}</span></div>`,
        );
      }
      const rn = relationCount();
      for (let ri = 0; ri < rn; ri++) {
        const rel = relationById(ri);
        if (rel === undefined) continue;
        const out = w.getRelations(e, rel);
        const rev = w.getReverse(e, rel);
        if (out.length === 0 && rev.length === 0) continue;
        const fmtE = (x: Entity): string => `#${slotOf(x)}·${genOf(x)}`;
        const bits: string[] = [];
        if (out.length > 0) bits.push(`→ ${out.slice(0, 8).map(fmtE).join(" ")}${out.length > 8 ? ` +${out.length - 8}` : ""}`);
        if (rev.length > 0) bits.push(`← ${rev.slice(0, 8).map(fmtE).join(" ")}${rev.length > 8 ? ` +${rev.length - 8}` : ""}`);
        parts.push(
          `<div class="strata-obs-comp"><span class="strata-obs-cname">${esc(rel.name)}</span><span class="strata-obs-cval">${bits.join("   ")}</span></div>`,
        );
      }
      html = parts.join("");
    }
    // skip identical rewrites — a static entity keeps its DOM, so text selection survives
    if (html !== this.lastDetailHtml) {
      this.lastDetailHtml = html;
      this.detail.innerHTML = html;
    }
  }
}

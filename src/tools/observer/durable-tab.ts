/**
 * The durable tab — the un-agreed SYNC DELTA, made visible. It walks the union of the attachment's
 * founding-agreement BASELINE (binding.ts §13.1 — the converged value every reconcile compares against)
 * and the store's converged LORO document (durable-store.ts `.snapshot`), and shows each entity's two
 * records SIDE BY SIDE. Rows where the two disagree are the cells the runtime and the document have NOT
 * yet reconciled (a local drag in flight, a dropped-then-held remote value, §13.3) — the highlighted Δ is
 * the whole point of the tab.
 *
 * It reaches BOTH views through {@link ObserverDurableSource}, a structural interface the host's live
 * `DurableStore` + durable `Attachment` satisfy — the tools package never imports `strata-ecs/durable`
 * (design §0; see index.ts). The getter is re-read every poll and returns null before a collab store is
 * attached, so the tab exists (a placeholder) from first mount and lights up when sync begins.
 *
 * Rendering discipline: entity records carry PEER-CONTROLLED component/relation values, so every dynamic
 * string goes through `textContent` (never innerHTML-with-data — an XSS in a dev panel is still an XSS).
 * Records are compared/printed via a KEY-SORTED stable stringify so two structurally-equal records
 * stringify identically (else every poll would false-flag a Δ from key-order noise). The filter input is
 * built ONCE and never rebuilt, and the body is only re-rendered when its content signature actually
 * changes (diff-before-replace) — so a focused filter keeps its value/caret and a text selection in the
 * body survives the ~8 Hz poll.
 *
 * Cost discipline (load-bearing on a large shared board): both `readEntity()` and the stable stringify are
 * O(cell-count) PER ENTITY, so a naïve "read+stringify every union key every poll" pass is O(n) on BOTH
 * stores at the panel's ~8 Hz rate — on a ~10k-entity doc that pass alone is ~200 ms, so it runs back-to-back
 * and pins the main thread (canvas render starved). We bound the per-poll work two ways: (1) the SIDE-BY-SIDE
 * VIEW reads+stringifies ONLY the rows that survive the filter and the {@link MAX_ROWS} cap (≤200 reads/poll,
 * independent of doc size), and (2) the exact whole-union Δ COUNT — which by definition must scan every key
 * on both sides — is throttled to {@link DELTA_SCAN_MS} and cached between scans. The visible rows and their
 * per-row diff highlight stay fresh every poll; only the aggregate number in the header may lag a change by
 * up to one scan interval. (An exact O(changed) Δ is impossible through the read-only Snapshot seam — there
 * is no per-entity change signal, so detecting a change costs a full read either way; throttling the scan is
 * the achievable bound.)
 */

import type { ObserverDurableSource, ObserverEntityRecord } from "../index";

/** Rendered-row cap — a 100k-entity doc must not build 100k DOM rows; the footer points at the filter. */
const MAX_ROWS = 200;
/**
 * Whole-union Δ scan cadence (ms). The side-by-side rows + filter refresh at the panel's ~8 Hz poll, but the
 * exact Δ over the WHOLE union is an O(entities) read+stringify pass on BOTH stores (~200 ms on a large doc);
 * running it every poll pins the main thread (see header "Cost discipline"). We recompute the count at most
 * this often and cache it between scans — chosen a few× slower than the poll so a steady large doc pays the
 * O(n) pass at ~1 Hz, not 8 Hz, while the visible rows stay fully live.
 */
const DELTA_SCAN_MS = 1000;
/** The placeholder rendered when a side lacks an entity present on the other (the un-agreed key). */
const MISSING = "—";

/**
 * Compact, KEY-SORTED JSON — the canonical form both stores' records are printed and compared in. Object
 * keys are sorted recursively so two records with the same cells but different insertion order stringify
 * equal (arrays keep order — a relation-target or tag list IS ordered). Shared with the ephemeral tab.
 *
 * Non-finite floats are emitted as their legible token ("NaN"/"Infinity"/"-Infinity") rather than left to
 * `JSON.stringify`, which collapses ALL of NaN/±Infinity to the literal `null`. Float columns legitimately
 * hold non-finite values (canon.ts §2.4 — f32/f64 keep NaN/±Inf so they survive the round-trip), and the
 * `null` collapse both hides them (indistinguishable from an absent field) AND — the real bug this tab
 * exists to avoid — makes a genuine `NaN`-vs-`Infinity` runtime/document divergence stringify identically,
 * so the Δ would report a real disagreement as agreement (no `.diff`, not counted). The token keeps distinct
 * non-finite values unequal and legible; a string cell literally spelling "NaN" is a far narrower collision
 * than the four-way null collapse it replaces.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value); // NaN/±Infinity → legible token
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** One union row: the key plus each side's stringified record ({@link MISSING} when absent) and their Δ. */
interface Row {
  key: string;
  baseStr: string;
  loroStr: string;
  diff: boolean;
}

export class DurableTab {
  private readonly doc: Document;
  private readonly head: HTMLDivElement;
  private readonly filterRow: HTMLDivElement;
  /** The static "baseline / loro" column captions — which side is which (hidden with the filter row). */
  private readonly colLabels: HTMLDivElement;
  private readonly filterInput: HTMLInputElement;
  private readonly body: HTMLDivElement;
  /** Content signature of the last body render — the diff-before-replace guard (preserves focus/selection). */
  private lastSig = "";
  /** Cached whole-union Δ (shown in the header), recomputed at most every {@link DELTA_SCAN_MS} — see refresh. */
  private deltaCount = 0;
  /** Timestamp of the last whole-union Δ scan; `-Infinity` forces a scan on the first poll and after re-attach. */
  private lastDeltaScanAt = Number.NEGATIVE_INFINITY;

  constructor(
    root: HTMLElement,
    private readonly source: () => ObserverDurableSource | null,
  ) {
    this.doc = root.ownerDocument;
    // Static shell only (no data); the filter input is a static markup literal, built once and never
    // rebuilt so a poll never clobbers its value/caret. All dynamic text is set via textContent below.
    root.innerHTML =
      `<div class="strata-obs-storehead"></div>` +
      `<div class="strata-obs-filterrow"><input class="strata-obs-filter" placeholder="filter by key…" /></div>` +
      `<div class="strata-obs-durlabels"><span>baseline</span><span>loro (converged)</span></div>` +
      `<div class="strata-obs-durbody"></div>`;
    this.head = root.querySelector(".strata-obs-storehead") as HTMLDivElement;
    this.filterRow = root.querySelector(".strata-obs-filterrow") as HTMLDivElement;
    this.colLabels = root.querySelector(".strata-obs-durlabels") as HTMLDivElement;
    this.filterInput = root.querySelector(".strata-obs-filter") as HTMLInputElement;
    this.body = root.querySelector(".strata-obs-durbody") as HTMLDivElement;

    // Typing narrows the union immediately (like the entities tab): the input event recomputes, the
    // content signature changes, and the body re-renders — all without disturbing the input node itself.
    this.filterInput.addEventListener("input", () => this.refresh());
  }

  /** Called at the panel poll rate while the durable tab is visible. */
  refresh(): void {
    const src = this.source();
    if (src === null) {
      this.head.textContent = "";
      this.filterRow.style.display = "none";
      this.colLabels.style.display = "none";
      // Force a fresh scan if a store re-attaches, so the header Δ never lingers from a prior source.
      this.lastDeltaScanAt = Number.NEGATIVE_INFINITY;
      this.renderBodyOnce("\u0000null", (body) => {
        const ph = this.doc.createElement("div");
        ph.className = "strata-obs-empty";
        ph.textContent = "no durable store attached — pass durable to attachObserver / start collab";
        body.appendChild(ph);
      });
      return;
    }
    this.filterRow.style.display = "";
    this.colLabels.style.display = "";

    const baseline = src.attachment.baseline;
    const loro = src.store.snapshot;
    // Key iteration + union is O(n) but cheap (no per-cell read); the expensive readEntity+stringify is
    // bounded below. The union is BOTH the display domain and the Δ scan domain — both need the key set.
    const baseKeys = [...baseline.entities()];
    const loroKeys = [...loro.entities()];
    const union = [...new Set([...baseKeys, ...loroKeys])].sort();

    // DISPLAY: filter on keys FIRST (string ops only), cap, then read+stringify ONLY the ≤MAX_ROWS survivors,
    // so the side-by-side view costs O(MAX_ROWS) reads/poll regardless of doc size — the responsive path
    // (typing in the filter, the visible diff highlights) never walks the whole union.
    const filter = this.filterInput.value.trim().toLowerCase();
    const matchedKeys = filter === "" ? union : union.filter((k) => k.toLowerCase().includes(filter));
    const cappedKeys = matchedKeys.slice(0, MAX_ROWS);
    const overflow = matchedKeys.length - cappedKeys.length;
    const capped: Row[] = cappedKeys.map((key) => {
      const baseStr = recordStr(baseline.readEntity(key));
      const loroStr = recordStr(loro.readEntity(key));
      return { key, baseStr, loroStr, diff: baseStr !== loroStr };
    });

    // Δ: the true sync delta over the WHOLE union (independent of the display filter/cap). This is the only
    // O(n)-read pass, so it is THROTTLED — recomputed at most every DELTA_SCAN_MS and cached otherwise, so a
    // steady large doc pays it at ~1 Hz, not the ~8 Hz poll. First poll and re-attach scan eagerly (sentinel).
    const now = Date.now();
    if (now - this.lastDeltaScanAt >= DELTA_SCAN_MS) {
      this.lastDeltaScanAt = now;
      let delta = 0;
      for (const key of union) {
        if (recordStr(baseline.readEntity(key)) !== recordStr(loro.readEntity(key))) delta++;
      }
      this.deltaCount = delta;
    }

    this.head.textContent = `doc ${src.store.docId} · baseline ${baseKeys.length} · loro ${loroKeys.length} · Δ ${this.deltaCount}`;

    // Diff-before-replace: only rebuild the body when the visible content actually changed, so a poll on a
    // steady doc leaves the DOM (and any in-body text selection) untouched.
    const sig = `${filter}\u0001${overflow}\u0001${capped
      .map((r) => `${r.key}\u0002${r.diff ? "1" : "0"}\u0002${r.baseStr}\u0002${r.loroStr}`)
      .join("\u0003")}`;
    this.renderBodyOnce(sig, (body) => {
      for (const r of capped) body.appendChild(this.rowEl(r));
      if (capped.length === 0) {
        const empty = this.doc.createElement("div");
        empty.className = "strata-obs-empty";
        empty.textContent = filter === "" ? "runtime and document agree — no entities" : "no keys match the filter";
        body.appendChild(empty);
      }
      if (overflow > 0) {
        const footer = this.doc.createElement("div");
        footer.className = "strata-obs-empty";
        footer.textContent = `+${overflow} more — filter to narrow`;
        body.appendChild(footer);
      }
    });
  }

  /** Build one two-column row: the key (spanning), then the baseline and loro records side by side. */
  private rowEl(r: Row): HTMLDivElement {
    const row = this.doc.createElement("div");
    row.className = r.diff ? "strata-obs-durrow diff" : "strata-obs-durrow";
    const key = this.doc.createElement("div");
    key.className = "strata-obs-durkey";
    key.textContent = r.key;
    const base = this.doc.createElement("div");
    base.className = "strata-obs-durcol";
    base.textContent = r.baseStr;
    const loro = this.doc.createElement("div");
    loro.className = "strata-obs-durcol";
    loro.textContent = r.loroStr;
    row.append(key, base, loro);
    return row;
  }

  /** Rebuild the body via `fill` only when `sig` differs from the last render (the diff-before-replace gate). */
  private renderBodyOnce(sig: string, fill: (body: HTMLDivElement) => void): void {
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.body.textContent = "";
    fill(this.body);
  }
}

/** A side's record as canonical JSON, or {@link MISSING} when the entity is absent from that side. */
function recordStr(rec: ObserverEntityRecord | undefined): string {
  return rec === undefined ? MISSING : stableStringify(rec);
}

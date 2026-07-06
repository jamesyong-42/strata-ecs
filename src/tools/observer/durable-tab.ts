/**
 * The durable tab — the un-agreed SYNC DELTA, made visible. It walks the union of the attachment's
 * founding-agreement BASELINE (binding.ts §13.1 — the converged value every reconcile compares against)
 * and the store's converged LORO document (durable-store.ts `.snapshot`), and shows each entity's two
 * records SIDE BY SIDE as collapsible TREES (json-tree.ts): collapsed, a row is one preview line per
 * side; expanded, you drill into components/tags/relations with type-colored leaves. Rows where the two
 * records disagree are the cells the runtime and the document have NOT yet reconciled (a local drag in
 * flight, a dropped-then-held remote value, §13.3) — the highlighted Δ is the whole point of the tab.
 *
 * It reaches BOTH views through {@link ObserverDurableSource}, a structural interface the host's live
 * `DurableStore` + durable `Attachment` satisfy — the tools package never imports `strata-ecs/durable`
 * (design §0; see index.ts). The getter is re-read every poll and returns null before a collab store is
 * attached, so the tab exists (a placeholder) from first mount and lights up when sync begins.
 *
 * Refresh discipline (json-tree.ts owns the machinery, this header owns the WHY):
 *  - Rows reconcile per-key via {@link syncKeyedRows} — a row's DOM is rebuilt only when ITS record pair
 *    changes, so a drag streaming through one entity never disturbs the row you are inspecting, and the
 *    filter input (built once, never rebuilt) keeps its value/caret through every poll.
 *  - Tree expansion lives in a tab-owned path set, NOT in the DOM — a changed row re-renders with your
 *    expanded nodes still open, now showing the fresh values (that is what makes the tree usable at all
 *    against live sync traffic).
 *
 * Rendering discipline: entity records carry PEER-CONTROLLED component/relation values, so every dynamic
 * string goes through `textContent` (never innerHTML-with-data — an XSS in a dev panel is still an XSS).
 * Records are compared via the KEY-SORTED {@link stableStringify} so equal records never false-flag a Δ
 * from key-order noise.
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
import { PATH_SEP, stableStringify, syncKeyedRows, treeNode, type KeyedRow } from "./json-tree";

export { stableStringify }; // canonical home is json-tree.ts; re-exported for source compatibility

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
 * Synthetic row ids for the placeholder/empty/footer rows, PATH_SEP-prefixed so they cannot collide with a
 * strata-minted entity key (a hostile wire key COULD embed the separator — worst case one row renders with
 * the wrong signature semantics, cosmetic).
 */
const ROW_PLACEHOLDER = `${PATH_SEP}ph`;
const ROW_EMPTY = `${PATH_SEP}empty`;
const ROW_FOOTER = `${PATH_SEP}footer`;

/** One union row: the key, each side's record (undefined = absent) + its canonical string, and their Δ. */
interface Row {
  key: string;
  base: ObserverEntityRecord | undefined;
  loro: ObserverEntityRecord | undefined;
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
  /** Per-row DOM cache for {@link syncKeyedRows} — row identity survives polls; content changes rebuild. */
  private readonly rowCache = new Map<string, { sig: string; el: HTMLElement }>();
  /** Open tree paths (json-tree.ts header) — survives row rebuilds AND rows leaving/re-entering the view. */
  private readonly expanded = new Set<string>();
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

    // Typing narrows the union immediately (like the entities tab): the input event recomputes and the
    // reconciler drops/adds rows — without disturbing the input node itself.
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
      syncKeyedRows(
        this.body,
        [{ id: ROW_PLACEHOLDER, sig: "", build: () => this.noteEl("no durable store attached — pass durable to attachObserver / start collab") }],
        this.rowCache,
      );
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
      const base = baseline.readEntity(key);
      const loroRec = loro.readEntity(key);
      const baseStr = recordStr(base);
      const loroStr = recordStr(loroRec);
      return { key, base, loro: loroRec, baseStr, loroStr, diff: baseStr !== loroStr };
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

    // Reconcile per row: unchanged rows keep their DOM (expanded subtrees, selection); a changed row
    // rebuilds and its trees re-open from the expansion set with the fresh values.
    const rows: KeyedRow[] = capped.map((r) => ({
      id: r.key,
      sig: `${r.diff ? "1" : "0"}${PATH_SEP}${r.baseStr}${PATH_SEP}${r.loroStr}`,
      build: () => this.rowEl(r),
    }));
    if (capped.length === 0) {
      rows.push({
        id: ROW_EMPTY,
        sig: filter === "" ? "agree" : "nomatch",
        build: () => this.noteEl(filter === "" ? "runtime and document agree — no entities" : "no keys match the filter"),
      });
    }
    if (overflow > 0) {
      rows.push({
        id: ROW_FOOTER,
        sig: String(overflow),
        build: () => this.noteEl(`+${overflow} more — filter to narrow`),
      });
    }
    syncKeyedRows(this.body, rows, this.rowCache);
  }

  /** Build one two-column row: the key (spanning), then the baseline and loro record TREES side by side. */
  private rowEl(r: Row): HTMLDivElement {
    const row = this.doc.createElement("div");
    row.className = r.diff ? "strata-obs-durrow diff" : "strata-obs-durrow";
    const key = this.doc.createElement("div");
    key.className = "strata-obs-durkey";
    key.textContent = r.key;
    row.append(key, this.colEl(r.key, "b", r.base), this.colEl(r.key, "l", r.loro));
    return row;
  }

  /** One side's cell: the record as a collapsible tree, or {@link MISSING} when the side lacks the entity. */
  private colEl(key: string, side: "b" | "l", rec: ObserverEntityRecord | undefined): HTMLDivElement {
    const col = this.doc.createElement("div");
    col.className = "strata-obs-durcol";
    if (rec === undefined) col.textContent = MISSING;
    // Root path is side-scoped so expanding an entity's baseline does not also expand its loro side.
    else col.appendChild(treeNode({ doc: this.doc, path: `${side}${PATH_SEP}${key}`, value: rec, expanded: this.expanded }));
    return col;
  }

  /** A muted note row (placeholder / empty state / overflow footer). */
  private noteEl(text: string): HTMLDivElement {
    const el = this.doc.createElement("div");
    el.className = "strata-obs-empty";
    el.textContent = text;
    return el;
  }
}

/** A side's record as canonical JSON, or {@link MISSING} when the entity is absent from that side. */
function recordStr(rec: ObserverEntityRecord | undefined): string {
  return rec === undefined ? MISSING : stableStringify(rec);
}

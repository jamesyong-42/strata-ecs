/**
 * The ephemeral tab — every peer's LIVE PRESENCE, grouped by writer. It reads the store's one
 * debug/observability seam (`eph.debugDump()`, ephemeral-store.ts — never a sync path) and lays out every
 * partition's current blob: your own first (labeled "(you)"), then each remote peer's, one entry per key.
 * Each blob field renders as a collapsible TREE (json-tree.ts) — expand `components` once and watch a
 * remote cursor's numbers tick live underneath.
 *
 * It reaches the dump through {@link ObserverEphemeralSource}, a structural interface the host's live
 * `EphemeralStore` satisfies — the tools package never imports `strata-ecs/ephemeral` (design §0; see
 * index.ts). The getter is re-read every poll and returns null before an ephemeral store is attached.
 *
 * WRITER SPLIT (load-bearing): ephemeral keys are minted `"<peerId>-<int>"` (ephemeral-store.ts §15.3),
 * and a `peerId` is a uuid that ITSELF contains dashes — so the writer is the key with ONLY its final
 * `-<digits>` segment stripped (`key.replace(/-\d+$/, "")`), never a split on the first dash. Getting this
 * wrong would scatter one peer's entities across bogus groups.
 *
 * Refresh discipline (mirrors the durable tab; json-tree.ts header has the WHY): rows reconcile per
 * group-header/per-entry via {@link syncKeyedRows}, so one peer's cursor stream (its blob re-arrives at
 * the sender's throttle rate) rebuilds ONLY that entry's row; tree expansion lives in a tab-owned path
 * set, so the rebuilt entry re-renders with your expanded nodes still open, showing the fresh values.
 *
 * Rendering discipline: blob values are PEER-CONTROLLED, so every dynamic string goes through
 * `textContent` (never innerHTML-with-data). Blob fields render in sorted order; each is a tree node
 * (collapsed = inline preview; a primitive field is just a leaf line).
 */

import type { ObserverEphemeralSource } from "../index";
import { PATH_SEP, stableStringify, syncKeyedRows, treeNode, type KeyedRow } from "./json-tree";

/** Synthetic row ids (PATH_SEP-prefixed, collision-safe vs minted keys — durable-tab.ts precedent). */
const ROW_PLACEHOLDER = `${PATH_SEP}ph`;
const ROW_EMPTY = `${PATH_SEP}empty`;

export class EphemeralTab {
  private readonly doc: Document;
  private readonly head: HTMLDivElement;
  private readonly body: HTMLDivElement;
  /** Per-row DOM cache for {@link syncKeyedRows} — row identity survives polls; content changes rebuild. */
  private readonly rowCache = new Map<string, { sig: string; el: HTMLElement }>();
  /** Open tree paths (json-tree.ts header) — survives entry rebuilds as the live blobs stream through. */
  private readonly expanded = new Set<string>();

  constructor(
    root: HTMLElement,
    private readonly source: () => ObserverEphemeralSource | null,
  ) {
    this.doc = root.ownerDocument;
    // Static shell only; all dynamic text is set via textContent below.
    root.innerHTML = `<div class="strata-obs-storehead"></div><div class="strata-obs-ephbody"></div>`;
    this.head = root.querySelector(".strata-obs-storehead") as HTMLDivElement;
    this.body = root.querySelector(".strata-obs-ephbody") as HTMLDivElement;
  }

  /** Called at the panel poll rate while the ephemeral tab is visible. */
  refresh(): void {
    const src = this.source();
    if (src === null) {
      this.head.textContent = "";
      syncKeyedRows(
        this.body,
        [{ id: ROW_PLACEHOLDER, sig: "", build: () => this.noteEl("no ephemeral store attached — pass ephemeral to attachObserver / start collab") }],
        this.rowCache,
      );
      return;
    }

    const dump = src.debugDump();
    this.head.textContent = `peer ${dump.peerId} · ttl ${dump.ttlMs}ms · throttle ${dump.throttleMs}ms · ${dump.entries.length} entries`;

    // Group by writer (final -<digits> stripped), own partition first and labeled, remotes sorted for stability.
    // Guard the local peerId: a key equal to it (no -<int> suffix) would strip its own final -digits and file
    // under a phantom writer — strata never mints such a key (every key is `<peerId>-<int>`, §15.3), but a
    // non-strata peer could inject one on the wire, so keep it in the own group rather than spawn a bogus one.
    const groups = new Map<string, Array<{ key: string; blob: Record<string, unknown> }>>();
    for (const entry of dump.entries) {
      const writer = entry.key === dump.peerId ? entry.key : entry.key.replace(/-\d+$/, "");
      let g = groups.get(writer);
      if (g === undefined) {
        g = [];
        groups.set(writer, g);
      }
      g.push(entry);
    }
    const remotes = [...groups.keys()].filter((w) => w !== dump.peerId).sort();
    const ordered = groups.has(dump.peerId) ? [dump.peerId, ...remotes] : remotes;

    // One keyed row per group header + per entry, so a re-blobbed cursor rebuilds only its own entry row.
    const rows: KeyedRow[] = [];
    for (const writer of ordered) {
      const label = writer === dump.peerId ? `${writer} (you)` : writer;
      rows.push({ id: `g${PATH_SEP}${writer}`, sig: label, build: () => this.groupEl(label) });
      for (const entry of groups.get(writer) ?? []) {
        rows.push({ id: `e${PATH_SEP}${entry.key}`, sig: stableStringify(entry.blob), build: () => this.entryEl(entry) });
      }
    }
    if (rows.length === 0) {
      rows.push({ id: ROW_EMPTY, sig: "", build: () => this.noteEl("no presence — no peers (including you) have live entities") });
    }
    syncKeyedRows(this.body, rows, this.rowCache);
  }

  /** One group header (a writer peer, "(you)" for the local partition). */
  private groupEl(label: string): HTMLDivElement {
    const el = this.doc.createElement("div");
    el.className = "strata-obs-ephgroup";
    el.textContent = label;
    return el;
  }

  /** One entry: its key, then one collapsible tree node per blob field (sorted; primitives are leaves). */
  private entryEl(entry: { key: string; blob: Record<string, unknown> }): HTMLDivElement {
    const el = this.doc.createElement("div");
    el.className = "strata-obs-ephentry";
    const key = this.doc.createElement("div");
    key.className = "strata-obs-ephkey";
    key.textContent = entry.key;
    el.appendChild(key);
    // Object.entries tolerates a hostile non-object blob (yields nothing → just the key line).
    for (const field of Object.keys(entry.blob).sort()) {
      el.appendChild(
        treeNode({
          doc: this.doc,
          path: `${entry.key}${PATH_SEP}${field}`,
          label: field,
          value: entry.blob[field],
          expanded: this.expanded,
        }),
      );
    }
    return el;
  }

  /** A muted note row (placeholder / empty state). */
  private noteEl(text: string): HTMLDivElement {
    const el = this.doc.createElement("div");
    el.className = "strata-obs-empty";
    el.textContent = text;
    return el;
  }
}

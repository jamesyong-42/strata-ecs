/**
 * The observer's interactive value widgets — a devtools-style collapsible JSON TREE plus the keyed
 * row reconciler both collab tabs render through. Extracted here because the durable and ephemeral
 * tabs show the same kind of thing (peer-synced records as nested plain data) and must solve the
 * same two problems the same way:
 *
 *  1. EXPANSION OUTSIDE THE DOM. The panel polls at ~8 Hz and live collab data changes constantly
 *     (a remote cursor re-blobs at the ephemeral throttle rate), so any DOM the data flows through
 *     is rebuilt often. If "expanded" lived in the DOM it would snap shut on every rebuild — so it
 *     lives in a caller-owned `Set<string>` of node PATHS instead, and a rebuilt node re-renders
 *     already-open with the fresh values. That set is the whole trick: expand `components/Fill`
 *     once and watch its numbers tick live underneath.
 *  2. REBUILD ONLY WHAT CHANGED. {@link syncKeyedRows} reconciles a desired row list against the
 *     container by (id, content-signature): unchanged rows keep their exact DOM nodes (text
 *     selection, hover, expanded subtrees untouched), changed rows rebuild in place, removed rows
 *     leave. One peer's cursor stream no longer rebuilds the entry you are inspecting.
 *
 * Tree shape: primitives render as `key: value` leaf lines (type-colored; numbers print natively,
 * so NaN/±Infinity stay legible); objects/arrays render as a toggle line — caret + key + an inline
 * truncated preview while collapsed — with children INDENTED below while expanded. Children are
 * built lazily on first expand (a collapsed 200-row board never pays for its subtrees) from the
 * value captured at build time — safe because any value change re-renders the whole row anyway
 * (the caller's signature includes the stringified record).
 *
 * Node paths join the ancestor property names with `"\u0000"` (a separator no minted key or schema
 * name contains; a hostile wire NAME could embed one and alias another path, but the worst case is
 * a node rendering pre-expanded — cosmetic). Rendering discipline: every dynamic string goes
 * through `textContent` (values are PEER-CONTROLLED; an XSS in a dev panel is still an XSS).
 */

/**
 * Compact, KEY-SORTED JSON — the canonical form records are previewed and content-compared in (the
 * durable tab's Δ and both tabs' row signatures). Object keys are sorted recursively so two records
 * with the same cells but different insertion order stringify equal (arrays keep order — a
 * relation-target or tag list IS ordered).
 *
 * Non-finite floats are emitted as their legible token ("NaN"/"Infinity"/"-Infinity") rather than
 * left to `JSON.stringify`, which collapses ALL of NaN/±Infinity to the literal `null`. Float
 * columns legitimately hold non-finite values (canon.ts §2.4 — f32/f64 keep NaN/±Inf so they
 * survive the round-trip), and the `null` collapse both hides them AND makes a genuine
 * `NaN`-vs-`Infinity` runtime/document divergence stringify identically — the durable Δ would
 * report a real disagreement as agreement. (Expanded tree LEAVES print numbers natively, so
 * non-finite values are legible there without any token.)
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

/** Collapsed-branch inline preview length — enough to recognize a record, short enough to stay one line. */
const PREVIEW_LEN = 60;

/** The path separator (see header) — exported for the tabs building root paths. */
export const PATH_SEP = "\u0000";

/** A branch = a non-null object/array with at least one own entry (empty ones render as `{}`/`[]` leaves). */
function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  if (value === null || typeof value !== "object") return false;
  return Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0;
}

/** Truncated stable stringify — what a collapsed branch shows inline. */
function previewOf(value: unknown): string {
  const s = stableStringify(value);
  return s.length > PREVIEW_LEN ? `${s.slice(0, PREVIEW_LEN)}…` : s;
}

/** A branch's children in render order: array index order; object keys SORTED (matches the preview). */
function childEntries(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v]);
  return Object.keys(value)
    .sort()
    .map((k) => [k, (value as Record<string, unknown>)[k]]);
}

/** Leaf value text + its type class. Numbers print natively so NaN/±Infinity stay legible (never "null"). */
function leafText(value: unknown): { text: string; cls: string } {
  switch (typeof value) {
    case "string":
      return { text: JSON.stringify(value), cls: "str" };
    case "number":
      return { text: String(value), cls: "num" };
    case "boolean":
      return { text: String(value), cls: "bool" };
    case "undefined":
      return { text: "undefined", cls: "nul" };
    default:
      if (value === null) return { text: "null", cls: "nul" };
      // an EMPTY object/array (isBranch said no) — render its literal so emptiness is visible
      return { text: Array.isArray(value) ? "[]" : "{}", cls: "nul" };
  }
}

export interface TreeNodeOptions {
  doc: Document;
  /** This node's unique path (root path from the tab + `PATH_SEP`-joined ancestor names). */
  path: string;
  /** Property name shown before the value/preview; omit for a root whose context already names it. */
  label?: string;
  value: unknown;
  /** The caller-owned open-paths set — shared by every node of a tab so state survives rebuilds. */
  expanded: Set<string>;
}

/**
 * Build one tree node (leaf line, or toggle line + lazy children). The returned element is
 * self-contained: clicking a branch line toggles `opts.expanded` and updates in place.
 */
export function treeNode(opts: TreeNodeOptions): HTMLElement {
  const { doc, path, label, value, expanded } = opts;
  const span = (cls: string, text?: string): HTMLSpanElement => {
    const s = doc.createElement("span");
    s.className = cls;
    if (text !== undefined) s.textContent = text;
    return s;
  };

  if (!isBranch(value)) {
    const line = doc.createElement("div");
    line.className = "strata-obs-tline leaf";
    if (label !== undefined) line.appendChild(span("strata-obs-tkey", label));
    const { text, cls } = leafText(value);
    line.appendChild(span(`strata-obs-tval ${cls}`, text));
    return line;
  }

  const wrap = doc.createElement("div");
  wrap.className = "strata-obs-tnode";
  const line = doc.createElement("div");
  line.className = "strata-obs-tline branch";
  const caret = span("strata-obs-tcaret");
  line.appendChild(caret);
  if (label !== undefined) line.appendChild(span("strata-obs-tkey", label));
  const preview = span("strata-obs-tprev", previewOf(value));
  line.appendChild(preview);
  wrap.appendChild(line);

  let kids: HTMLDivElement | null = null; // built on first expand only
  const apply = (): void => {
    const open = expanded.has(path);
    caret.textContent = open ? "▾" : "▸";
    preview.style.display = open ? "none" : "";
    if (open && kids === null) {
      kids = doc.createElement("div");
      kids.className = "strata-obs-tkids";
      for (const [k, v] of childEntries(value)) {
        kids.appendChild(treeNode({ doc, path: `${path}${PATH_SEP}${k}`, label: k, value: v, expanded }));
      }
      wrap.appendChild(kids);
    }
    if (kids !== null) kids.style.display = open ? "" : "none";
  };
  line.addEventListener("click", () => {
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    apply();
  });
  apply();
  return wrap;
}

/** One reconcilable row: a stable identity, a content signature, and how to (re)build it. */
export interface KeyedRow {
  id: string;
  /** Rebuild the row's DOM iff this differs from the cached signature for `id`. */
  sig: string;
  build: () => HTMLElement;
}

/**
 * Reconcile `rows` (in order) into `container`, reusing cached DOM for rows whose signature is
 * unchanged. `cache` is caller-owned (one per tab) so identity survives across refreshes; rows
 * whose id disappears are removed from both DOM and cache.
 */
export function syncKeyedRows(
  container: HTMLElement,
  rows: readonly KeyedRow[],
  cache: Map<string, { sig: string; el: HTMLElement }>,
): void {
  const want = new Set(rows.map((r) => r.id));
  for (const [id, c] of cache) {
    if (!want.has(id)) {
      c.el.remove();
      cache.delete(id);
    }
  }
  rows.forEach((row, i) => {
    let c = cache.get(row.id);
    if (c === undefined || c.sig !== row.sig) {
      const el = row.build();
      if (c !== undefined) c.el.replaceWith(el);
      c = { sig: row.sig, el };
      cache.set(row.id, c);
    }
    // position fix: only touches the DOM when the row is not already at its slot
    if (container.children[i] !== c.el) container.insertBefore(c.el, container.children[i] ?? null);
  });
}

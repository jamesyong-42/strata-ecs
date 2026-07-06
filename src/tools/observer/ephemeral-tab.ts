/**
 * The ephemeral tab — every peer's LIVE PRESENCE, grouped by writer. It reads the store's one
 * debug/observability seam (`eph.debugDump()`, ephemeral-store.ts — never a sync path) and lays out every
 * partition's current blob: your own first (labeled "(you)"), then each remote peer's, one entry per key.
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
 * Rendering discipline: blob values are PEER-CONTROLLED, so every dynamic string goes through
 * `textContent` (never innerHTML-with-data). A blob field that is a string array (`tags`) renders as a
 * plain joined list; every other field renders as compact key-sorted JSON. The body is only re-rendered
 * when the dump's content signature changes, so a text selection survives the ~8 Hz poll.
 */

import type { ObserverEphemeralSource } from "../index";
import { stableStringify } from "./durable-tab";

export class EphemeralTab {
  private readonly doc: Document;
  private readonly head: HTMLDivElement;
  private readonly body: HTMLDivElement;
  /** Content signature of the last body render — the diff-before-replace guard (preserves text selection). */
  private lastSig = "";

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
      this.renderBodyOnce(" null", (body) => {
        const ph = this.doc.createElement("div");
        ph.className = "strata-obs-empty";
        ph.textContent = "no ephemeral store attached — pass ephemeral to attachObserver / start collab";
        body.appendChild(ph);
      });
      return;
    }

    const dump = src.debugDump();
    this.head.textContent = `peer ${dump.peerId} · ttl ${dump.ttlMs}ms · throttle ${dump.throttleMs}ms · ${dump.entries.length} entries`;

    // Group by writer (final -<digits> stripped), own partition first and labeled, remotes sorted for stability.
    const groups = new Map<string, Array<{ key: string; blob: Record<string, unknown> }>>();
    for (const entry of dump.entries) {
      const writer = entry.key.replace(/-\d+$/, "");
      let g = groups.get(writer);
      if (g === undefined) {
        g = [];
        groups.set(writer, g);
      }
      g.push(entry);
    }
    const remotes = [...groups.keys()].filter((w) => w !== dump.peerId).sort();
    const ordered = groups.has(dump.peerId) ? [dump.peerId, ...remotes] : remotes;

    const sig = `${dump.peerId}${dump.ttlMs}${dump.throttleMs}${ordered
      .map((w) => `${w}:${(groups.get(w) ?? []).map((e) => `${e.key}=${stableStringify(e.blob)}`).join(",")}`)
      .join("|")}`;
    this.renderBodyOnce(sig, (body) => {
      if (ordered.length === 0) {
        const empty = this.doc.createElement("div");
        empty.className = "strata-obs-empty";
        empty.textContent = "no presence — no peers (including you) have live entities";
        body.appendChild(empty);
        return;
      }
      for (const writer of ordered) {
        const groupHead = this.doc.createElement("div");
        groupHead.className = "strata-obs-ephgroup";
        groupHead.textContent = writer === dump.peerId ? `${writer} (you)` : writer;
        body.appendChild(groupHead);
        for (const entry of groups.get(writer) ?? []) body.appendChild(this.entryEl(entry));
      }
    });
  }

  /** One entry: its key, then one line per blob field (a `tags` string array joins to a list; else JSON). */
  private entryEl(entry: { key: string; blob: Record<string, unknown> }): HTMLDivElement {
    const el = this.doc.createElement("div");
    el.className = "strata-obs-ephentry";
    const key = this.doc.createElement("div");
    key.className = "strata-obs-ephkey";
    key.textContent = entry.key;
    el.appendChild(key);
    for (const [field, value] of Object.entries(entry.blob)) {
      const line = this.doc.createElement("div");
      line.className = "strata-obs-comp";
      const name = this.doc.createElement("span");
      name.className = "strata-obs-cname";
      name.textContent = field;
      const val = this.doc.createElement("span");
      val.className = "strata-obs-cval";
      // A string-array field (the blob's `tags`) reads better as a plain joined list than as JSON.
      val.textContent = isStringArray(value) ? value.join(", ") : stableStringify(value);
      line.append(name, val);
      el.appendChild(line);
    }
    return el;
  }

  /** Rebuild the body via `fill` only when `sig` differs from the last render (the diff-before-replace gate). */
  private renderBodyOnce(sig: string, fill: (body: HTMLDivElement) => void): void {
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.body.textContent = "";
    fill(this.body);
  }
}

/** A value that is an array of only strings — the `tags` blob field renders as a joined list, not JSON. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

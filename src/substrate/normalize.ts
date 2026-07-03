/**
 * `normalizeBatch` — the exported pure normalization (Patch Note 005 §4).
 *
 * Reconcile classifies a {@link ChangeBatch} against the PRE-COMMIT baseline (Part III §13.3), which
 * needs a normalized view: the final fact per cell, in a stable order. Factored out as a pure,
 * exported function so it is unit-testable in isolation and reusable by Part III and the conformance
 * suite. Correctness is defined by the acceptance oracle (§4.3, property P5): applying
 * `normalizeBatch(events)` to a `MutableSnapshot` yields the IDENTICAL state as applying the raw
 * `events` in order.
 *
 * The four rules (§4.2):
 * - DESPAWN DOMINANCE: `despawn(k)` erases all earlier facts for `k` in the batch (its existence,
 *   components, tags, outgoing edges). The incoming-edge removals of the three-part contract are
 *   their OWN cells on other keys — not synthesized here; a well-formed producer emits them, or the
 *   surviving `despawn` cleans them at apply time (baseline.ts `despawn`).
 * - RESPAWN-FRESH: a `spawn(k)` AFTER a `despawn(k)` starts a fresh record — earlier facts stay
 *   erased, the despawn SURVIVES (it must still run its incoming-edge cleanup before the respawn),
 *   later facts accumulate. A `spawn(k)` while `k` is already spawned likewise clears its own prior
 *   facts (a fresh record).
 * - LAST-FACT-WINS per cell: for a non-dominated cell, the final fact survives (remove-then-set → set).
 * - ORDER PRESERVED: survivors keep their batch order — this function MUST NOT reorder (§4.2). The
 *   spawn-first / despawn-last invariants then follow for a well-formed batch (spawn emitted before,
 *   despawn after, a key's other facts), and despawn dominance already removes any fact a despawn
 *   would strand.
 */

import type { ChangeEvent } from "./types";
import type { EntityKey } from "../core/field";

/** Rare delimiter for the cell-key strings (unlikely in a component name or peer-prefixed key). */
const SEP = "\u001f";

/**
 * The cell a fact addresses (§4.1). Entity existence, `(key, comp)`, `(key, tag)`, a relation edge
 * `(key, rel, target)` for arity "many", `(key, rel, all)` for arity "one" / target-less removes,
 * and `(res)`. Two facts collide (last-fact-wins) iff they produce the same string.
 */
function cellKeyOf(e: ChangeEvent): string {
  switch (e.kind) {
    case "spawn":
    case "despawn":
      return `E${SEP}${e.key}`;
    case "component-set":
    case "component-remove":
      return `C${SEP}${e.key}${SEP}${e.comp.name}`;
    case "tag-add":
    case "tag-remove":
      return `T${SEP}${e.key}${SEP}${e.tag.name}`;
    case "relation-set":
      // arity "one": the whole single-valued slot — collides with a target-less remove of the same rel.
      return `R${SEP}${e.key}${SEP}${e.rel.name}${SEP}*`;
    case "relation-add":
      return `R${SEP}${e.key}${SEP}${e.rel.name}${SEP}${e.target}`;
    case "relation-remove":
      // target given → that one edge's cell; target-less → the whole relation slot (§4.1).
      return `R${SEP}${e.key}${SEP}${e.rel.name}${SEP}${e.target ?? "*"}`;
    case "resource-set":
    case "resource-remove":
      return `S${SEP}${e.res.name}`;
  }
}

/**
 * The key whose OWN cells this fact belongs to — the unit despawn/respawn erases. Existence,
 * components, tags, and OUTGOING relations are owned by their `key`; resource facts are entity-less
 * (`undefined`) and untouched by despawn.
 */
function ownKeyOf(e: ChangeEvent): EntityKey | undefined {
  switch (e.kind) {
    case "resource-set":
    case "resource-remove":
      return undefined;
    default:
      return e.key;
  }
}

export function normalizeBatch(events: readonly ChangeEvent[]): ChangeEvent[] {
  const n = events.length;
  const alive = new Array<boolean>(n).fill(true);

  // Last surviving event index per NON-existence cell (component/tag/relation/resource). Existence is
  // handled by the spawn/despawn owners below, because spawn↔despawn is not a plain last-fact-wins.
  const cellOwner = new Map<string, number>();
  // Per key: surviving ERASABLE own facts (spawn + components + tags + outgoing relations). A despawn
  // OR a fresh spawn erases every member. A despawn is NOT a member — it is a barrier that survives a
  // respawn so its incoming-edge cleanup still runs.
  const ownFacts = new Map<EntityKey, Set<number>>();
  const despawnOwner = new Map<EntityKey, number>(); // surviving despawn per key — a later despawn supersedes it

  const eraseOwn = (k: EntityKey): void => {
    const own = ownFacts.get(k);
    if (own === undefined) return;
    for (const j of own) alive[j] = false;
    own.clear();
  };
  const addOwn = (k: EntityKey, i: number): void => {
    let s = ownFacts.get(k);
    if (s === undefined) ownFacts.set(k, (s = new Set()));
    s.add(i);
  };

  for (let i = 0; i < n; i++) {
    const e = events[i];
    if (e.kind === "spawn") {
      // Fresh record: clear this key's prior erasable facts (a prior life this spawn overwrites). A
      // prior despawn (barrier) is NOT erased — it stays to clean incoming edges before this respawn.
      eraseOwn(e.key);
      addOwn(e.key, i);
    } else if (e.kind === "despawn") {
      eraseOwn(e.key); // erase the record + components + tags + outgoing edges accumulated so far
      const prior = despawnOwner.get(e.key);
      if (prior !== undefined) alive[prior] = false; // a second despawn supersedes the first
      despawnOwner.set(e.key, i);
      // NB: not added to ownFacts — it must survive a subsequent respawn (respawn-fresh, §4.2).
    } else {
      // Every other fact addresses exactly one cell: last-fact-wins supersedes the prior owner.
      const cell = cellKeyOf(e);
      const prev = cellOwner.get(cell);
      if (prev !== undefined) {
        alive[prev] = false;
        const pk = ownKeyOf(events[prev]);
        if (pk !== undefined) ownFacts.get(pk)?.delete(prev);
      }
      cellOwner.set(cell, i);
      const k = ownKeyOf(e);
      if (k !== undefined) addOwn(k, i);
    }
  }

  const out: ChangeEvent[] = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(events[i]);
  return out;
}

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
 * The rules (§4.2):
 * - DESPAWN DOMINANCE: `despawn(k)` erases all earlier facts for `k` in the batch (its existence
 *   spawn, components, tags, outgoing edges). The incoming-edge removals of the three-part contract
 *   are their OWN cells on other keys — not synthesized here; a well-formed producer emits them, or
 *   the surviving `despawn` cleans them at apply time (baseline.ts `despawn`).
 * - DUPLICATE-SPAWN DEDUPE, FIRST-SPAWN-WINS per despawn-segment: existence is idempotent — the
 *   baseline's `spawn` is EXISTENCE-ONLY (it clears nothing, §4.1) — so a `spawn(k)` is DROPPED when a
 *   `spawn(k)` already survives in the current segment; a surviving `despawn(k)` resets the segment,
 *   so a later `spawn` (a respawn) survives. FIRST-wins, not last, is deliberate: last-wins would turn
 *   [spawn, setC, spawn] into [setC, spawn] and violate §4.2's spawn-first invariant — first-wins
 *   keeps [spawn, setC]. The respawn's despawn barrier SURVIVES (it must still run its incoming-edge
 *   cleanup before the respawn); post-despawn facts accumulate onto the fresh record.
 * - LAST-FACT-WINS per cell: for a non-dominated cell, the final fact survives (remove-then-set → set).
 * - ORDER PRESERVED: survivors keep their batch order — this function MUST NOT reorder (§4.2). The
 *   spawn-first / despawn-last invariants then follow for a well-formed batch (spawn emitted before,
 *   despawn after, a key's other facts), and despawn dominance already removes any fact a despawn
 *   would strand.
 */

import type { ChangeEvent } from "./types";
import type { EntityKey } from "../core/field";

/**
 * The cell a fact addresses (§4.1), as a COLLISION-PROOF string — two facts collide (last-fact-wins)
 * iff they produce the same string. Encoded as a JSON tuple so a peer-controlled EntityKey or name
 * containing ANY delimiter cannot forge a collision (verified: a naive separator-join let
 * key='a'/target='b<SEP>rel<SEP>c' collide with key='a<SEP>rel<SEP>b'/target='c', §E3). The arity-"one"
 * slot and a target-less remove use a 3-tuple (the whole slot); an arity-"many" edge and a TARGETED
 * remove use a 4-tuple (that one edge) — different tuple LENGTHS, so a real target key (even the
 * literal "*") is never conflated with the whole-slot cell.
 */
function cellKeyOf(e: ChangeEvent): string {
  switch (e.kind) {
    case "spawn":
    case "despawn":
      return JSON.stringify(["E", e.key]);
    case "component-set":
    case "component-remove":
      return JSON.stringify(["C", e.key, e.comp.name]);
    case "tag-add":
    case "tag-remove":
      return JSON.stringify(["T", e.key, e.tag.name]);
    case "relation-set":
      return JSON.stringify(["R", e.key, e.rel.name]); // arity "one": the whole single-valued slot
    case "relation-add":
      return JSON.stringify(["R", e.key, e.rel.name, e.target]); // one specific edge
    case "relation-remove":
      // target given → that one edge (4-tuple); target-less → the whole slot (3-tuple, §4.1). The slot
      // form COLLIDES with relation-set (both 3-tuple) — correct: a set and a target-less clear share it.
      return e.target === undefined
        ? JSON.stringify(["R", e.key, e.rel.name])
        : JSON.stringify(["R", e.key, e.rel.name, e.target]);
    case "order-invalidate":
      // The (parent, rel, order) cell (plan-ordered-relations §4.2). Distinct "O" family so it can
      // never collide with the parent's own edge slot; payload-free, so plain last-fact-wins IS the
      // ≤1-per-(parent,rel)-per-segment dedupe. Owned by the parent key (despawn dominance erases
      // pending invalidations for a dead parent — its sequence dies with it).
      return JSON.stringify(["O", e.key, e.rel.name]);
    case "resource-set":
    case "resource-remove":
      return JSON.stringify(["S", e.res.name]);
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
  // erases every member. A despawn is NOT a member — it is a barrier that survives a respawn so its
  // incoming-edge cleanup still runs.
  const ownFacts = new Map<EntityKey, Set<number>>();
  const despawnOwner = new Map<EntityKey, number>(); // surviving despawn per key — a later despawn supersedes it
  // Per key: the surviving `spawn` in the CURRENT despawn-segment (first-spawn-wins). A despawn resets
  // it; while set, a further spawn(k) is a redundant duplicate and is dropped.
  const spawnOwner = new Map<EntityKey, number>();

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
      // Existence-only + FIRST-spawn-wins (§4.2): a spawn survives only if none already survives since
      // the last despawn; a redundant spawn is dropped (keeps spawn-first — last-wins would emit
      // [setC, spawn]). It clears NOTHING (existence is idempotent) — the despawn is the only eraser.
      if (spawnOwner.has(e.key)) {
        alive[i] = false;
      } else {
        spawnOwner.set(e.key, i);
        addOwn(e.key, i);
      }
    } else if (e.kind === "despawn") {
      eraseOwn(e.key); // erase the spawn + components + tags + outgoing edges accumulated so far
      spawnOwner.delete(e.key); // reset the segment: a later spawn (respawn) survives
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

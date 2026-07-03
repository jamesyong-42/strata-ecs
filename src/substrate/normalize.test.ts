/**
 * `normalizeBatch` (Patch Note 005 §4) — TABLE-DRIVEN per §4.2. Every case is checked TWICE:
 * (1) the surviving indices (dominance / last-fact-wins / order preservation), and (2) the
 * ACCEPTANCE ORACLE P5 (§4.3): applying the normalized output to a `BaselineSnapshot` yields the
 * IDENTICAL state as applying the raw events in order.
 */

import { describe, expect, it } from "vitest";
import { entityKey } from "../core/field";
import { type Relation, type Resource, defineComponent, defineRelation, defineResource, defineTag } from "../core/schema";
import { normalizeBatch } from "./normalize";
import { BaselineSnapshot } from "./baseline";
import type { ChangeEvent } from "./types";

const C1 = defineComponent("NORMC1", { x: "u8" });
const C2 = defineComponent("NORMC2", { x: "u8" }); // same field name so the shared `setC` factory fits both
const T1 = defineTag("NORMT1");
const ROne = defineRelation("NORMROne", { arity: "one" });
const RMany = defineRelation("NORMRMany", { arity: "many" });
const Res = defineResource("NORMRes", { v: "u8" });

const A = entityKey("A");
const B = entityKey("B");

// --- event factories (origin is irrelevant to normalization) ---
const spawn = (key = A): ChangeEvent => ({ kind: "spawn", key, origin: "remote" });
const despawn = (key = A): ChangeEvent => ({ kind: "despawn", key, origin: "remote" });
const setC = (key: typeof A, comp = C1, x = 1): ChangeEvent => ({ kind: "component-set", key, comp, value: { x }, origin: "remote" });
const remC = (key: typeof A, comp = C1): ChangeEvent => ({ kind: "component-remove", key, comp, origin: "remote" });
const addT = (key: typeof A): ChangeEvent => ({ kind: "tag-add", key, tag: T1, origin: "remote" });
const remT = (key: typeof A): ChangeEvent => ({ kind: "tag-remove", key, tag: T1, origin: "remote" });
const setR = (key: typeof A, target: typeof A, rel: Relation = ROne): ChangeEvent => ({ kind: "relation-set", key, rel, target, origin: "remote" });
const addR = (key: typeof A, target: typeof A, rel: Relation = RMany): ChangeEvent => ({ kind: "relation-add", key, rel, target, origin: "remote" });
const remR = (key: typeof A, rel: Relation, target?: typeof A): ChangeEvent => ({ kind: "relation-remove", key, rel, target, origin: "remote" });
const setRes = (v = 1, res: Resource = Res): ChangeEvent => ({ kind: "resource-set", res, value: { v }, origin: "remote" });
const remRes = (res: Resource = Res): ChangeEvent => ({ kind: "resource-remove", res, origin: "remote" });

// --- P5 oracle: apply raw vs normalized to two fresh baselines, compare full state ---
function apply(bs: BaselineSnapshot, e: ChangeEvent): void {
  switch (e.kind) {
    case "spawn": bs.spawn(e.key); break;
    case "despawn": bs.despawn(e.key); break;
    case "component-set": bs.setComponent(e.key, e.comp, e.value); break;
    case "component-remove": bs.removeComponent(e.key, e.comp); break;
    case "tag-add": bs.addTag(e.key, e.tag); break;
    case "tag-remove": bs.removeTag(e.key, e.tag); break;
    case "relation-set": bs.setRelation(e.key, e.rel, e.target); break;
    case "relation-add": bs.addRelation(e.key, e.rel, e.target); break;
    case "relation-remove": bs.removeRelation(e.key, e.rel, e.target); break;
    case "resource-set": bs.setResource(e.res, e.value); break;
    case "resource-remove": bs.removeResource(e.res); break;
  }
}

function keysOf(events: readonly ChangeEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const e of events) {
    if ("key" in e) keys.add(e.key);
    if ("target" in e && e.target !== undefined) keys.add(e.target);
  }
  return keys;
}

/** A comparable dump of a baseline's full observable state — per-key CELL reads (not just readEntity). */
function dump(bs: BaselineSnapshot, keys: Set<string>): unknown {
  const entities: Record<string, unknown> = {};
  for (const s of keys) {
    const k = entityKey(s);
    entities[s] = {
      live: bs.hasEntity(k),
      c1: bs.getComponent(k, C1) ?? null,
      c2: bs.getComponent(k, C2) ?? null,
      t1: bs.hasTag(k, T1),
      one: bs.getRelationOne(k, ROne) ?? null,
      many: bs.getRelationMany(k, RMany).sort(),
      rec: bs.readEntity(k) ?? null,
    };
  }
  return { entities, res: bs.getResource(Res) ?? null };
}

function applyAll(events: readonly ChangeEvent[]): BaselineSnapshot {
  const bs = new BaselineSnapshot();
  for (const e of events) apply(bs, e);
  return bs;
}

interface Case {
  name: string;
  events: ChangeEvent[];
  survivors: number[]; // indices into `events`, in output order
}

const cases: Case[] = [
  { name: "spawn→mutate→despawn collapses to despawn", events: [spawn(A), setC(A), addT(A), despawn(A)], survivors: [3] },
  { name: "despawn→spawn begins a fresh record (prior facts stay erased)", events: [spawn(A), setC(A, C1, 1), despawn(A), spawn(A), setC(A, C2, 2)], survivors: [2, 3, 4] },
  { name: "remove-then-set on a cell → set", events: [setC(A, C1, 1), remC(A, C1), setC(A, C1, 5)], survivors: [2] },
  { name: "set-then-remove on a cell → remove", events: [setC(A, C1, 1), setC(A, C1, 2), remC(A, C1)], survivors: [2] },
  { name: "tag add-then-remove → remove", events: [addT(A), remT(A)], survivors: [1] },
  { name: "relation arity-one last-fact-wins (same slot)", events: [setR(A, A, ROne), setR(A, B, ROne)], survivors: [1] },
  { name: "relation arity-many distinct edges both survive", events: [addR(A, A, RMany), addR(A, B, RMany)], survivors: [0, 1] },
  { name: "relation-add then remove same edge → remove", events: [addR(A, B, RMany), remR(A, RMany, B)], survivors: [1] },
  { name: "relation-set then target-less remove collide on the slot → remove", events: [setR(A, B, ROne), remR(A, ROne)], survivors: [1] },
  // Arity-ONE TARGETED remove is a DISTINCT cell from the set (the remove is conditional per-edge, §4.1
  // amendment) — both survive in order; the impl is correct as-is (§E4).
  { name: "arity-one set then TARGETED remove → both survive in order", events: [setR(A, B, ROne), remR(A, ROne, B)], survivors: [0, 1] },
  { name: "resource last-fact-wins", events: [setRes(1), setRes(2)], survivors: [1] },
  { name: "resource set then remove → remove", events: [setRes(1), remRes()], survivors: [1] },
  { name: "order preserved across independent survivors", events: [spawn(A), spawn(B), setC(A), setC(B)], survivors: [0, 1, 2, 3] },
  { name: "spawn-first holds for a well-formed key", events: [spawn(A), setC(A, C1, 1), setC(A, C2, 2)], survivors: [0, 1, 2] },
  { name: "despawn-last: despawn A trails B's surviving facts", events: [spawn(A), spawn(B), setC(B, C1, 1), despawn(A)], survivors: [1, 2, 3] },
  { name: "incoming edge: despawn target erases the spawn but keeps the edge fact for despawn to clean", events: [spawn(A), spawn(B), setR(B, A, ROne), despawn(A)], survivors: [1, 2, 3] },
  { name: "respawn keeps the despawn barrier (incoming cleanup runs before respawn)", events: [spawn(A), spawn(B), setR(B, A, ROne), despawn(A), spawn(A)], survivors: [1, 2, 3, 4] },
  { name: "second despawn supersedes the first", events: [despawn(A), spawn(A), despawn(A)], survivors: [2] },
  // Duplicate-spawn dedupe, FIRST-spawn-wins per segment (§4.2): a redundant spawn drops, keeping spawn-first.
  { name: "duplicate spawn drops (first-wins): [spawn, setC, spawn] → [spawn, setC]", events: [spawn(A), setC(A), spawn(A)], survivors: [0, 1] },
  { name: "a despawn resets the segment so the respawn survives: [spawn, setC, despawn, spawn] → [despawn, spawn]", events: [spawn(A), setC(A), despawn(A), spawn(A)], survivors: [2, 3] },
  { name: "ill-formed [setC, spawn] — existence-only spawn does not erase, both survive in order", events: [setC(A), spawn(A)], survivors: [0, 1] },
];

describe("normalizeBatch — §4.2 dominance, last-fact-wins, order", () => {
  for (const c of cases) {
    it(c.name, () => {
      const out = normalizeBatch(c.events);
      // (1) surviving indices, in order
      expect(out.map((e) => c.events.indexOf(e))).toEqual(c.survivors);
      // (2) P5 acceptance oracle: normalized ≡ raw apply (§4.3)
      const keys = keysOf(c.events);
      expect(dump(applyAll(out), keys)).toEqual(dump(applyAll(c.events), keys));
    });
  }
});

describe("normalizeBatch — collision-proof cell keys (§E3)", () => {
  it("separator-laden EntityKeys cannot forge a cell-key collision", () => {
    const SEP = String.fromCharCode(31); // U+001F — the old naive cell-key delimiter
    const a = entityKey("a");
    const t1 = entityKey(`b${SEP}${RMany.name}${SEP}c`); // edge a → 'b<SEP>rel<SEP>c'
    const a2 = entityKey(`a${SEP}${RMany.name}${SEP}b`); // edge 'a<SEP>rel<SEP>b' → 'c'
    const t2 = entityKey("c");
    // A naive `R SEP key SEP rel SEP target` join maps BOTH edges to the same string; the JSON-tuple
    // encoding keeps them separate, so both survive as distinct cells.
    const out = normalizeBatch([addR(a, t1, RMany), addR(a2, t2, RMany)]);
    expect(out.length).toBe(2);
    const bs = applyAll(out);
    expect(bs.getRelationMany(a, RMany)).toEqual([t1]);
    expect(bs.getRelationMany(a2, RMany)).toEqual([t2]);
  });

  it("the literal '*' as a target key does not collide with the whole-slot cell", () => {
    const star = entityKey("*");
    // add edge A→'*', then a target-LESS remove (whole slot) — distinct cells (4-tuple vs 3-tuple), so
    // the target-less clear does NOT drop the specific-'*' add; both survive and the raw apply matches.
    const evs = [addR(A, star, RMany), addR(A, B, RMany), remR(A, RMany)];
    const out = normalizeBatch(evs);
    expect(dump(applyAll(out), keysOf(evs))).toEqual(dump(applyAll(evs), keysOf(evs)));
  });
});

describe("normalizeBatch — invariants", () => {
  it("preserves survivor order and is a no-op on already-minimal batches", () => {
    const evs = [spawn(A), spawn(B), setC(A), addR(A, B, RMany)];
    expect(normalizeBatch(evs)).toEqual(evs);
  });

  it("spawn-first / despawn-last hold structurally for a well-formed lifecycle", () => {
    const evs = [spawn(A), setC(A, C1, 1), addT(A), setR(A, B, ROne), despawn(A)];
    const out = normalizeBatch(evs);
    expect(out[0].kind).toBe("despawn"); // whole life collapses; despawn dominates
    // A well-formed spawn→…(no despawn) keeps spawn first:
    const alive = normalizeBatch([spawn(A), setC(A, C1, 1), addT(A)]);
    expect(alive[0].kind).toBe("spawn");
  });
});

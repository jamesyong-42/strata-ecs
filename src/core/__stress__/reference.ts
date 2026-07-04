/**
 * A plain-JS reference model of the ECS's observable semantics, plus a {@link Harness} that applies
 * the same op to both the real {@link World} and the model and can assert they agree. This is the
 * oracle the op-sequence fuzz checks against: if any spawn/destroy/add/remove/write/tag/relation
 * interleaving diverges — a lost value, a leaked edge, a stale handle reading alive — assertEquiv
 * throws at the first mismatched op, and fast-check shrinks to the minimal failing sequence.
 *
 * The model keys entities by a stable logical index; the harness holds the parallel real handle.
 * Preconditions are enforced identically on both sides (a no-op that the model rejects is also
 * skipped on the world), so the fuzz exercises valid state transitions rather than the throw paths
 * (those are pinned deterministically in command-buffer.stress.ts).
 */

import { expect } from "vitest";
import {
  type Component,
  type Entity,
  createWorld,
  defineComponent,
  defineRelation,
  defineTag,
} from "../index";

// Fixed schema (uniquely named; process-global, evaluated once per isolated test file).
const CA = defineComponent("RefCA", { x: "i32" });
const CB = defineComponent("RefCB", { y: "f64" });
const CC = defineComponent("RefCC", { s: "string" });
const COMPS: ReadonlyArray<{ key: string; h: Component; field: string }> = [
  { key: "CA", h: CA as Component, field: "x" },
  { key: "CB", h: CB as Component, field: "y" },
  { key: "CC", h: CC as Component, field: "s" },
];
const TAGS = [defineTag("RefT0"), defineTag("RefT1")];
const ROne = defineRelation("RefROne", { arity: "one" });
const RMany = defineRelation("RefRMany", { arity: "many" });

export const COMPONENT_COUNT = COMPS.length;
export const TAG_COUNT = TAGS.length;

/**
 * The fixed component schema, exposed for the reactive fuzz oracle (fuzz-reactive.fuzz.ts): each entry
 * carries the component handle (to register `observeValue`/`observeQuery`), the single field name, and
 * the `key` under which {@link Harness} stores that component's value in {@link Harness.model}. The
 * oracle reads a model value with `model[i].comps.get(REACTIVE_COMPS[c].key)` and compares it to what
 * the real observer fired — so the two views must key identically, which reusing COMPS guarantees.
 */
export const REACTIVE_COMPS = COMPS;

export type Op =
  | { t: "spawn" }
  | { t: "destroy"; i: number }
  | { t: "addC"; i: number; c: number; v: number | string }
  | { t: "rmC"; i: number; c: number }
  | { t: "wrC"; i: number; c: number; v: number | string }
  | { t: "addTag"; i: number; tag: number }
  | { t: "rmTag"; i: number; tag: number }
  | { t: "setOne"; i: number; j: number }
  | { t: "rmOne"; i: number }
  | { t: "addMany"; i: number; j: number }
  | { t: "rmMany"; i: number; j: number };

interface MEntity {
  alive: boolean;
  comps: Map<string, Record<string, unknown>>;
  tags: Set<number>;
  relOne?: number; // target logical index
  relMany: Set<number>;
}

function pushRev(map: Map<number, number[]>, key: number, val: number): void {
  const arr = map.get(key);
  if (arr === undefined) map.set(key, [val]);
  else arr.push(val);
}

export class Harness {
  readonly world = createWorld();
  readonly handles: (Entity | null)[] = [];
  readonly model: MEntity[] = [];

  private aliveIdx(i: number): number | undefined {
    return i >= 0 && i < this.model.length && this.model[i].alive ? i : undefined;
  }

  apply(op: Op): void {
    switch (op.t) {
      case "spawn":
        this.handles.push(this.world.spawn());
        this.model.push({ alive: true, comps: new Map(), tags: new Set(), relMany: new Set() });
        return;
      case "destroy": {
        const k = this.aliveIdx(op.i);
        if (k === undefined) return;
        this.world.destroy(this.handles[k] as Entity);
        const m = this.model[k];
        m.alive = false;
        m.comps.clear();
        m.tags.clear();
        m.relOne = undefined;
        m.relMany.clear();
        for (const other of this.model) {
          if (!other.alive) continue;
          if (other.relOne === k) other.relOne = undefined;
          other.relMany.delete(k);
        }
        return;
      }
      case "addC": {
        const k = this.aliveIdx(op.i);
        const comp = COMPS[op.c];
        if (k === undefined || this.model[k].comps.has(comp.key)) return;
        const value = { [comp.field]: op.v };
        this.world.addComponent(this.handles[k] as Entity, comp.h, value);
        this.model[k].comps.set(comp.key, value);
        return;
      }
      case "rmC": {
        const k = this.aliveIdx(op.i);
        const comp = COMPS[op.c];
        if (k === undefined || !this.model[k].comps.has(comp.key)) return;
        this.world.removeComponent(this.handles[k] as Entity, comp.h);
        this.model[k].comps.delete(comp.key);
        return;
      }
      case "wrC": {
        const k = this.aliveIdx(op.i);
        const comp = COMPS[op.c];
        if (k === undefined || !this.model[k].comps.has(comp.key)) return;
        const value = { [comp.field]: op.v };
        this.world.edit(this.handles[k] as Entity).set(comp.h, value);
        this.model[k].comps.set(comp.key, value);
        return;
      }
      case "addTag": {
        const k = this.aliveIdx(op.i);
        if (k === undefined) return;
        this.world.addTag(this.handles[k] as Entity, TAGS[op.tag]);
        this.model[k].tags.add(op.tag);
        return;
      }
      case "rmTag": {
        const k = this.aliveIdx(op.i);
        if (k === undefined) return;
        this.world.removeTag(this.handles[k] as Entity, TAGS[op.tag]);
        this.model[k].tags.delete(op.tag);
        return;
      }
      case "setOne": {
        const k = this.aliveIdx(op.i);
        const tgt = this.aliveIdx(op.j);
        if (k === undefined || tgt === undefined) return;
        this.world.setRelation(this.handles[k] as Entity, ROne, this.handles[tgt] as Entity);
        this.model[k].relOne = tgt;
        return;
      }
      case "rmOne": {
        const k = this.aliveIdx(op.i);
        if (k === undefined) return;
        this.world.removeRelation(this.handles[k] as Entity, ROne);
        this.model[k].relOne = undefined;
        return;
      }
      case "addMany": {
        const k = this.aliveIdx(op.i);
        const tgt = this.aliveIdx(op.j);
        if (k === undefined || tgt === undefined) return;
        this.world.addRelation(this.handles[k] as Entity, RMany, this.handles[tgt] as Entity);
        this.model[k].relMany.add(tgt);
        return;
      }
      case "rmMany": {
        const k = this.aliveIdx(op.i);
        const tgt = this.aliveIdx(op.j);
        if (k === undefined || tgt === undefined) return;
        this.world.removeRelation(this.handles[k] as Entity, RMany, this.handles[tgt] as Entity);
        this.model[k].relMany.delete(tgt);
        return;
      }
    }
  }

  /** Assert the world matches the model for every logical entity. Throws on the first divergence. */
  assertEquiv(): void {
    const w = this.world;

    // Reverse edges, derived from the model's forward maps (alive sources only).
    const revOne = new Map<number, number[]>();
    const revMany = new Map<number, number[]>();
    for (let k = 0; k < this.model.length; k++) {
      const m = this.model[k];
      if (!m.alive) continue;
      if (m.relOne !== undefined) pushRev(revOne, m.relOne, k);
      for (const t of m.relMany) pushRev(revMany, t, k);
    }
    const handlesOf = (idxs: number[] | undefined): number[] =>
      (idxs ?? []).map((k) => this.handles[k] as number).sort((a, b) => a - b);
    const sortNums = (a: readonly number[]): number[] => [...a].sort((x, y) => x - y);

    for (let i = 0; i < this.model.length; i++) {
      const h = this.handles[i] as Entity;
      const m = this.model[i];
      expect(w.isAlive(h)).toBe(m.alive);
      if (!m.alive) continue;
      expect(w.isPlaced(h)).toBe(true); // spawn always places (empty archetype), so alive ⇒ placed

      for (const comp of COMPS) {
        const has = m.comps.has(comp.key);
        expect(w.has(h, comp.h)).toBe(has);
        if (has) expect(w.read(h, comp.h)).toEqual(m.comps.get(comp.key));
      }
      for (let tg = 0; tg < TAGS.length; tg++) {
        expect(w.hasTag(h, TAGS[tg])).toBe(m.tags.has(tg));
      }

      const one = m.relOne !== undefined ? (this.handles[m.relOne] as Entity) : undefined;
      expect(w.getRelation(h, ROne)).toBe(one);
      expect(sortNums(w.getRelations(h, RMany))).toEqual(handlesOf([...m.relMany]));
      expect(sortNums(w.getReverse(h, ROne))).toEqual(handlesOf(revOne.get(i)));
      expect(sortNums(w.getReverse(h, RMany))).toEqual(handlesOf(revMany.get(i)));
    }
  }
}

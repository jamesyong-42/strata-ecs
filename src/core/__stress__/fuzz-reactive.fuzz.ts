/**
 * Property fuzz for the reactive layer (review-part1 R7) — the piece the original op-sequence fuzz
 * could never reach: because `reactiveOn` gates all stamp maintenance behind a live observer, the
 * plain fuzz never even EXECUTES the stamp/skip machinery. This file arms observers and drives a
 * random interleaving of component value/structural ops, observe/unobserve, and `notify()`, checking
 * every fire against a reference oracle derived from {@link Harness}'s model.
 *
 * It is the regression net for the R5/R6 work: the per-component quiescent skip (`componentMaxFrame`)
 * and its bump sites (value write, migrate add/remove, reset, death). A skip that drops a fire — the
 * verifier's exact fear — surfaces here as a predicted fire the observer never delivered.
 *
 * The oracle (the verifier's amendments, followed exactly):
 *   - Tier 3 (`observeValue`) is EXACT — it fires iff the model value CHANGED vs the LAST-FIRED value
 *     under the layer's OWN shallow equality (the box is primed at registration, so a no-op first
 *     notify never back-fires). Component removal fires `undefined` once; entity death fires
 *     `undefined` once (then the watch self-removes). We assert the fired sequence equals the model's.
 *   - Tier 1 (`observeQuery`) may OVER-fire but must NEVER MISS. We assert only the lower bound: an op
 *     that DEFINITELY dirties the query (a value write, add, remove, or destroy touching the watched
 *     component of a matching entity — each provably bumps a stamp `queryDirty` consults) forces a
 *     fire at the next notify. Extra fires from co-resident churn are allowed and unchecked.
 *
 * Two variants: an interleaved one where observers attach mid-sequence, and an armed-from-op-0 one
 * where observers exist before the first op — so `reactiveOn` is on for the WHOLE run and every
 * structural/value op executes stamp maintenance (today's fuzz never does).
 */

import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { type Component, type Entity, type Query, type Unsubscribe, defineQuery } from "../index";
import { Harness, REACTIVE_COMPS } from "./reference";
import { SEED, fuzzRuns, scaled } from "./harness";

const MAX_IDX = 16;
const COMP_COUNT = REACTIVE_COMPS.length; // 3: i32 / f64 / string

/** The layer's Tier-3 default equality, copied verbatim from reactive.ts so the oracle decides
 *  "changed" exactly as the layer does (single-field records reduce this to an Object.is on the field). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const k of keys) if (!Object.is(ao[k], bo[k])) return false;
  return true;
}

/** logical-index component key → its index in REACTIVE_COMPS (for reading model.comps by handle idx). */
const KEY_TO_C = new Map(REACTIVE_COMPS.map((rc, i) => [rc.key, i]));

type Val = Record<string, unknown>;

/** A Tier-3 `observeValue` watch mirrored in the oracle — its own box + hadValue, exactly like the layer. */
interface ValueWatch {
  kind: "value";
  i: number; // entity logical index
  c: number; // component index
  unsub: Unsubscribe;
  fires: unknown[]; // every value the real callback received, in order
  box: Val | undefined; // last-FIRED value (undefined = unset / removed / dead)
  hadValue: boolean; // last-known "present with a value" — drives the fire-once-undefined on removal
  removed: boolean;
}

/** A Tier-1 `observeQuery` watch — only its fire COUNT and the never-miss obligation are tracked. */
interface QueryWatch {
  kind: "query";
  c: number; // the query is defineQuery([c]); cols = [c]
  unsub: Unsubscribe;
  fires: number;
  mustFire: boolean; // a definite dirtying op happened since the last notify
  removed: boolean;
}

type Watch = ValueWatch | QueryWatch;

/** Reuse one compiled query per component index — observeQuery over [that component], cols = [it]. */
const queryCache = new Map<number, Query>();
function queryFor(c: number): Query {
  let q = queryCache.get(c);
  if (q === undefined) {
    q = defineQuery([REACTIVE_COMPS[c].h as Component]);
    queryCache.set(c, q);
  }
  return q;
}

type ROp =
  | { t: "spawn" }
  | { t: "destroy"; i: number }
  | { t: "addC"; i: number; c: number; v: number | string }
  | { t: "rmC"; i: number; c: number }
  | { t: "wrC"; i: number; c: number; v: number | string }
  | { t: "notify" }
  | { t: "observeValue"; i: number; c: number }
  | { t: "observeQuery"; c: number }
  | { t: "unobserve"; k: number };

/**
 * Drives a {@link Harness} (real world + reference model) plus the reactive oracle above. State ops go
 * through `Harness.apply` (so world and model stay in lockstep, preconditions enforced identically);
 * reactive ops register/settle observers and are checked against the model.
 */
class ReactiveHarness {
  readonly h = new Harness();
  private readonly watches: Watch[] = [];

  get world() {
    return this.h.world;
  }

  private aliveIdx(i: number): number | undefined {
    return i >= 0 && i < this.h.model.length && this.h.model[i].alive ? i : undefined;
  }

  /** Mark every live query-watch on component `c` as owed a fire — called only for provably-dirtying ops. */
  private markQueryDirty(c: number): void {
    for (const w of this.watches)
      if (w.kind === "query" && !w.removed && w.c === c) w.mustFire = true;
  }

  /** Register a Tier-3 value watch on an ALIVE entity (dead-at-registration is a skip-gated edge we avoid). */
  private observeValue(i: number, c: number): void {
    const k = this.aliveIdx(i);
    if (k === undefined) return;
    const rc = REACTIVE_COMPS[c];
    const cur = this.h.model[k].comps.get(rc.key) as Val | undefined;
    const w: ValueWatch = {
      kind: "value",
      i: k,
      c,
      unsub: () => {},
      fires: [],
      box: cur, // the layer primes tier-3 box = current value at registration
      hadValue: cur !== undefined,
      removed: false,
    };
    w.unsub = this.world.reactive.observeValue(
      this.h.handles[k] as Entity,
      rc.h as Component,
      (v) => w.fires.push(v),
    );
    this.watches.push(w);
  }

  private observeQuery(c: number): void {
    const w: QueryWatch = {
      kind: "query",
      c,
      unsub: () => {},
      fires: 0,
      mustFire: false,
      removed: false,
    };
    w.unsub = this.world.reactive.observeQuery(
      queryFor(c),
      [REACTIVE_COMPS[c].h as Component],
      () => {
        w.fires++;
      },
    );
    this.watches.push(w);
  }

  private unobserve(k: number): void {
    const live = this.watches.filter((w) => !w.removed);
    if (live.length === 0) return;
    const w = live[k % live.length];
    w.unsub();
    w.removed = true;
  }

  /**
   * Predict the delta a value watch fires at this notify AND advance its box/hadValue/removed to the
   * post-notify state (the model marching in lockstep with the layer). Death is checked FIRST — a
   * destroyed entity is drained by drainDeaths before the entity tiers run, firing undefined once and
   * self-removing (so a removal in the same inter-notify gap is absorbed, never double-counted).
   */
  private predictValue(w: ValueWatch): unknown[] {
    const m = this.h.model[w.i];
    if (!m.alive) {
      // The death hook is installed whenever any tier-3 watch is live, so this watch's entity was
      // queued at destroy; drainDeaths fires undefined unconditionally, then removes the watch.
      w.box = undefined;
      w.hadValue = false;
      w.removed = true;
      return [undefined];
    }
    const v = m.comps.get(REACTIVE_COMPS[w.c].key) as Val | undefined;
    if (v !== undefined) {
      const changed = w.box === undefined ? true : !shallowEqual(v, w.box);
      w.hadValue = true;
      if (changed) {
        w.box = v;
        return [v];
      }
      return [];
    }
    // absent: fire undefined once on the present→absent transition, then stay quiet.
    if (w.hadValue) {
      w.box = undefined;
      w.hadValue = false;
      return [undefined];
    }
    return [];
  }

  private notify(): void {
    // Snapshot pre-fire counters and compute value predictions BEFORE firing (predictValue advances
    // the oracle's boxes, so it must run once, before notify delivers the real callbacks).
    const valuePred = new Map<ValueWatch, unknown[]>();
    const preLen = new Map<Watch, number>();
    for (const w of this.watches) {
      if (w.removed) continue;
      if (w.kind === "value") {
        preLen.set(w, w.fires.length);
        valuePred.set(w, this.predictValue(w));
      } else {
        preLen.set(w, w.fires);
      }
    }

    this.world.reactive.notify();

    for (const [w, pred] of valuePred) {
      const delta = w.fires.slice(preLen.get(w) as number);
      expect(delta).toEqual(pred); // Tier 3 is EXACT — same values, same order, no miss, no over-fire
    }
    for (const w of this.watches) {
      if (w.kind !== "query" || w.removed) continue;
      const fired = w.fires - (preLen.get(w) as number);
      if (w.mustFire) expect(fired).toBeGreaterThanOrEqual(1); // never-miss; over-fire unchecked
      w.mustFire = false;
    }
  }

  apply(op: ROp): void {
    switch (op.t) {
      case "notify":
        this.notify();
        return;
      case "observeValue":
        this.observeValue(op.i, op.c);
        return;
      case "observeQuery":
        this.observeQuery(op.c);
        return;
      case "unobserve":
        this.unobserve(op.k);
        return;
      // --- state ops: mark provably-dirtying cases for Tier-1, THEN mutate world+model via Harness ---
      case "wrC": {
        const k = this.aliveIdx(op.i);
        if (k !== undefined && this.h.model[k].comps.has(REACTIVE_COMPS[op.c].key))
          this.markQueryDirty(op.c);
        this.h.apply({ t: "wrC", i: op.i, c: op.c, v: op.v });
        return;
      }
      case "addC": {
        const k = this.aliveIdx(op.i);
        if (k !== undefined && !this.h.model[k].comps.has(REACTIVE_COMPS[op.c].key))
          this.markQueryDirty(op.c);
        this.h.apply({ t: "addC", i: op.i, c: op.c, v: op.v });
        return;
      }
      case "rmC": {
        const k = this.aliveIdx(op.i);
        if (k !== undefined && this.h.model[k].comps.has(REACTIVE_COMPS[op.c].key))
          this.markQueryDirty(op.c);
        this.h.apply({ t: "rmC", i: op.i, c: op.c });
        return;
      }
      case "destroy": {
        const k = this.aliveIdx(op.i);
        if (k !== undefined) {
          for (const key of this.h.model[k].comps.keys())
            this.markQueryDirty(KEY_TO_C.get(key) as number);
        }
        this.h.apply({ t: "destroy", i: op.i });
        return;
      }
      case "spawn":
        this.h.apply({ t: "spawn" });
        return;
    }
  }

  /** Detach everything (idempotent) — hygiene between runs, not load-bearing for correctness. */
  disposeAll(): void {
    for (const w of this.watches) if (!w.removed) w.unsub();
  }
}

// --- arbitraries -------------------------------------------------------------

const idx = fc.integer({ min: 0, max: MAX_IDX });
const compSel = fc.integer({ min: 0, max: COMP_COUNT - 1 });
// i32-safe / f64-exact / short-string ranges so a written value round-trips encode→decode unchanged
// (the model value and the store-decoded value the oracle compares must be identical).
const iVal = fc.integer({ min: -100_000, max: 100_000 });
const fVal = fc.integer({ min: -1_000_000, max: 1_000_000 });
const sVal = fc.string({ maxLength: 8 });

/** A value-carrying op with the value type matched to the component (0:i32, 1:f64, 2:string). */
const cval = (t: "addC" | "wrC") =>
  fc.oneof(
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(0), v: iVal }),
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(1), v: fVal }),
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(2), v: sVal }),
  );

// Biased toward writes + notifies (the stamp/settle machinery under test) via repetition.
const rop = fc.oneof(
  cval("addC"),
  cval("addC"),
  cval("wrC"),
  cval("wrC"),
  cval("wrC"),
  fc.record({ t: fc.constant("rmC"), i: idx, c: compSel }),
  fc.record({ t: fc.constant("spawn") }),
  fc.record({ t: fc.constant("destroy"), i: idx }),
  fc.record({ t: fc.constant("observeValue"), i: idx, c: compSel }),
  fc.record({ t: fc.constant("observeQuery"), c: compSel }),
  fc.record({ t: fc.constant("unobserve"), k: fc.integer({ min: 0, max: 15 }) }),
  fc.record({ t: fc.constant("notify") }),
  fc.record({ t: fc.constant("notify") }),
  fc.record({ t: fc.constant("notify") }),
) as fc.Arbitrary<ROp>;

describe("fuzz: reactive fire oracle (review-part1 R7)", () => {
  it("interleaved observe/mutate/notify — Tier-3 exact, Tier-1 never-miss", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: MAX_IDX + 1 }),
        fc.array(rop, { maxLength: scaled(50) }),
        (nSpawn, ops) => {
          const rh = new ReactiveHarness();
          for (let s = 0; s < nSpawn; s++) rh.apply({ t: "spawn" });
          for (const op of ops) rh.apply(op);
          rh.apply({ t: "notify" }); // a final settle so trailing writes are checked
          rh.disposeAll();
        },
      ),
      { seed: SEED, numRuns: fuzzRuns(150) },
    );
  });

  it("armed from op 0 — observers exist before the first op, so stamp maintenance runs throughout", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: MAX_IDX + 1 }),
        // Pre-registered watches: value watches over the first few entities and a query per component.
        fc.array(fc.record({ i: idx, c: compSel }), { minLength: 1, maxLength: 6 }),
        fc.array(rop, { maxLength: scaled(50) }),
        (nSpawn, pre, ops) => {
          const rh = new ReactiveHarness();
          for (let s = 0; s < nSpawn; s++) rh.apply({ t: "spawn" });
          // Arm BEFORE any mutation: observeQuery on every component + the seeded value watches. From
          // here reactiveOn is on, so every following op executes the stamp-maintenance code path.
          for (let c = 0; c < COMP_COUNT; c++) rh.apply({ t: "observeQuery", c });
          for (const p of pre) rh.apply({ t: "observeValue", i: p.i, c: p.c });
          rh.apply({ t: "notify" }); // settle registration baselines
          for (const op of ops) rh.apply(op);
          rh.apply({ t: "notify" });
          rh.disposeAll();
        },
      ),
      { seed: SEED, numRuns: fuzzRuns(150) },
    );
  });
});

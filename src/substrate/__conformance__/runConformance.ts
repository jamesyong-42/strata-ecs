/**
 * `runConformance` — the MutableSnapshot-generic half of the M4 suite (Patch Note 005 §8, §9-M4).
 *
 * The properties here are written GENERICALLY over a `() => MutableSnapshot` factory so that Part
 * III's `LoroSnapshot` runs the IDENTICAL suite on day one — this file is the acceptance gate for the
 * Loro adapter, not just the in-memory baseline (§9 scope cut). It hosts the four properties whose
 * subject is the store-under-test itself:
 *
 *   - P1  ladder ⇔ runtime cell equivalence (the canonical-value law, §2, end-to-end).
 *   - P2  despawn completeness (the three-part contract, §1.3).
 *   - P5  normalizeBatch ≡ raw apply (the §4.3 acceptance oracle).
 *   - P7 (state) re-applying an already-applied fact changes neither the store NOR the runtime.
 *
 * The Projector/Reactive-infrastructure properties (P3 bijection, P6 visible-at-notify, P7's
 * fires-no-watch half) live in their own files: every adapter drives the SAME `Projector`, so there
 * is nothing adapter-specific to re-parameterize. P4 (export/import) is likewise per-adapter — the
 * baseline's is `world.export/import`; Part III adds the CRDT `export/applyRemote` round-trip.
 */

import { describe, expect, it } from "vitest";
import { normalizeBatch } from "../normalize";
import type { MutableSnapshot } from "../types";
import type { EntityKey } from "../../core/field";
import {
  type Op,
  type Schema,
  type SnapshotView,
  RuntimeOracle,
  SCHEMA,
  applyEvent,
  applyToStore,
  diffStores,
  diffViews,
  findIncoming,
  genEvents,
  genOps,
  keyPool,
  mulberry32,
} from "./harness";

export interface ConformanceConfig {
  /** A label for the store-under-test — names the top-level describe (e.g. "BaselineSnapshot"). */
  readonly label: string;
  /** Fixed seeds — deterministic in CI (§8). The stress variant passes a wider set. */
  readonly seeds: readonly number[];
  /** Key-pool size (≤ 64 entities, §8). */
  readonly keyCount: number;
  /** Ops per sequence (≤ 200, §8). */
  readonly opCount: number;
}

/**
 * The duplicate-fact set for P7-state — every fact re-applied here must be state-idempotent on BOTH
 * the ladder AND the runtime oracle. Two kinds:
 *  - RE-APPLIED PRESENT FACTS: a same-canonical-value `setC`/`setRes`, a re-add of a present tag/edge,
 *    and a duplicate `spawn` of an already-existent key (existence-only, §4.1 — no-op on the baseline,
 *    `ensurePlaced` no-op on the oracle).
 *  - GENUINELY STAMPLESS NO-OPS: a `despawn` of a TRULY-absent key (no cells, no incoming edge, not
 *    spawned — so it touches nothing on either side; a cell-less key that is still a live relation
 *    TARGET is EXCLUDED, since despawning it would sever that incoming edge — a real change), a remove
 *    of an ABSENT component/tag/relation from a live entity, an absent-resource remove (§6.1).
 */
function duplicateFacts(view: SnapshotView, keys: readonly EntityKey[], schema: Schema): Op[] {
  const dups: Op[] = [];
  for (const k of keys) {
    const exists = view.hasEntity(k);
    if (exists) dups.push({ t: "spawn", k }); // duplicate spawn of an already-existent key — existence-only
    for (const c of schema.components) {
      const v = view.getComponent(k, c);
      if (v !== undefined) dups.push({ t: "setC", k, c, v }); // re-write the SAME canonical value
      else if (exists) dups.push({ t: "rmC", k, c }); // remove an ABSENT component from a live entity
    }
    for (const t of schema.tags) {
      if (view.hasTag(k, t)) dups.push({ t: "addTag", k, tag: t });
      else if (exists) dups.push({ t: "rmTag", k, tag: t }); // remove an ABSENT tag
    }
    for (const r of schema.relOne) {
      const tk = view.getRelationOne(k, r);
      if (tk !== undefined) dups.push({ t: "setRel", k, r, tk });
      else if (exists) dups.push({ t: "rmRel", k, r }); // target-less remove of an ABSENT arity-one slot
    }
    for (const r of schema.relMany) {
      const many = view.getRelationMany(k, r);
      for (const tk of many) dups.push({ t: "addRel", k, r, tk });
      if (many.length === 0 && exists) dups.push({ t: "rmRel", k, r }); // target-less remove of an ABSENT slot
    }
    // A despawn of a TRULY-absent key (not existent AND no incoming edge) is a no-op on both sides.
    if (!exists && findIncoming(view, k, keys, schema) === null) dups.push({ t: "despawn", k });
  }
  for (const res of schema.resources) {
    const v = view.getResource(res);
    if (v !== undefined) dups.push({ t: "setRes", res, v }); // same-value resource set (idempotent re-canon)
    else dups.push({ t: "rmRes", res }); // absent-resource remove — stampless no-op (§6.1)
  }
  return dups;
}

/**
 * Coverage counts over one generated op stream — the triggers the properties depend on. Asserting sane
 * minimums (below) stops a future generator tweak from silently HOLLOWING the suite (e.g. dropping
 * despawns, or never re-spawning a key) while the properties keep vacuously passing.
 */
interface Coverage {
  dominance: number; // a despawn that erases ≥1 accumulated own fact for the key (§4.2 dominance)
  respawn: number; // a spawn of a previously-despawned key
  removeThenSet: number; // a setC on a (key, component) cell that was just removed (remove-then-set → set)
  despawnWithIncoming: number; // a despawn of a key that currently has ≥1 incoming relation edge
}

function opCoverage(ops: readonly Op[]): Coverage {
  const cov: Coverage = { dominance: 0, respawn: 0, removeThenSet: 0, despawnWithIncoming: 0 };
  const accumulated = new Set<EntityKey>(); // own facts since this key's last spawn/despawn
  const despawnedOnce = new Set<EntityKey>();
  const removedCell = new Set<string>(); // `${k}|${comp.name}` awaiting a re-set
  const incoming = new Map<EntityKey, number>(); // approx live incoming-edge count per target
  for (const op of ops) {
    switch (op.t) {
      case "spawn":
        if (despawnedOnce.has(op.k)) cov.respawn++;
        accumulated.add(op.k);
        break;
      case "despawn":
        if (accumulated.has(op.k)) cov.dominance++;
        if ((incoming.get(op.k) ?? 0) > 0) cov.despawnWithIncoming++;
        accumulated.delete(op.k);
        despawnedOnce.add(op.k);
        incoming.delete(op.k); // the despawn's cascade severs incoming edges
        break;
      case "setC":
        if (removedCell.has(`${op.k}|${op.c.name}`)) cov.removeThenSet++;
        removedCell.delete(`${op.k}|${op.c.name}`);
        accumulated.add(op.k);
        break;
      case "rmC":
        removedCell.add(`${op.k}|${op.c.name}`);
        break;
      case "addTag":
        accumulated.add(op.k);
        break;
      case "setRel":
      case "addRel":
        accumulated.add(op.k);
        incoming.set(op.tk, (incoming.get(op.tk) ?? 0) + 1);
        break;
    }
  }
  return cov;
}

export function runConformance(makeStore: () => MutableSnapshot, cfg: ConformanceConfig): void {
  const keys = keyPool(cfg.keyCount);

  describe(`conformance — ${cfg.label} (005 §8)`, () => {
    // --- P1 ---------------------------------------------------------------
    describe("P1 — ladder⇔runtime cell equivalence", () => {
      for (const seed of cfg.seeds) {
        it(`agrees on every cell after every op (seed ${seed})`, () => {
          const rng = mulberry32(seed);
          const ops = genOps(rng, { keys, opCount: cfg.opCount });
          const store = makeStore();
          const oracle = new RuntimeOracle();
          ops.forEach((op, i) => {
            applyToStore(store, op);
            oracle.apply(op);
            const diff = diffViews(store, oracle, keys, SCHEMA);
            // Fail AT the diverging op, naming the cell — a minimized repro without a shrinker.
            expect(diff, `op #${i} ${op.t} diverged: ${diff}`).toBeNull();
          });
        });
      }
    });

    // --- P2 ---------------------------------------------------------------
    describe("P2 — despawn completeness (§1.3)", () => {
      for (const seed of cfg.seeds) {
        it(`no incoming edge survives a despawn (seed ${seed})`, () => {
          const rng = mulberry32(seed ^ 0x2222);
          const ops = genOps(rng, { keys, opCount: cfg.opCount });
          const store = makeStore();
          const oracle = new RuntimeOracle();
          for (const op of ops) {
            applyToStore(store, op);
            oracle.apply(op);
            if (op.t === "despawn") {
              // P2 is a property of the STORE-UNDER-TEST: the baseline's reverse-index cascade must leave
              // NO incoming edge to a despawned key (§1.3). This baseline scan is the REAL structural
              // assertion — it reads forward maps directly, so a surviving edge would be caught.
              expect(findIncoming(store, op.k, keys, SCHEMA), `ladder kept an incoming edge to ${op.k}`).toBeNull();
              // The oracle scan is HONESTLY WEAKER, not a second structural proof: the runtime's guarantee
              // for a despawned key is VALIDATE-ON-READ (getRelation/getRelations drop an edge to a dead
              // target, harness.ts), so `findIncoming` reads undefined whether or not the cascade physically
              // cleaned the forward edge. It confirms the runtime's read-time guarantee; the eager cascade
              // itself is proven by the baseline scan above and the runtime's own destroy tests.
              expect(findIncoming(oracle, op.k, keys, SCHEMA), `oracle kept an incoming edge to ${op.k}`).toBeNull();
            }
          }
        });
      }
    });

    // --- P5 ---------------------------------------------------------------
    describe("P5 — normalizeBatch ≡ raw apply (§4.3)", () => {
      for (const seed of cfg.seeds) {
        it(`normalized apply == raw apply (seed ${seed})`, () => {
          const rng = mulberry32(seed ^ 0x5555);
          const events = genEvents(rng, { keys, opCount: cfg.opCount });

          const normalized = makeStore();
          for (const e of normalizeBatch(events)) applyEvent(normalized, e);

          const raw = makeStore();
          for (const e of events) applyEvent(raw, e);

          expect(diffStores(normalized, raw, keys, SCHEMA)).toBeNull();
        });
      }
    });

    // --- P7 (state half) --------------------------------------------------
    describe("P7 — projection idempotence: state (§2.5, §6.1)", () => {
      for (const seed of cfg.seeds) {
        it(`re-applying already-applied facts changes neither store nor runtime (seed ${seed})`, () => {
          const rng = mulberry32(seed ^ 0x7777);
          const ops = genOps(rng, { keys, opCount: cfg.opCount });

          const store = makeStore();
          const oracle = new RuntimeOracle();
          for (const op of ops) {
            applyToStore(store, op);
            oracle.apply(op);
          }
          // A reference replay that never sees the duplicates — the pre-image to compare against.
          const reference = makeStore();
          for (const op of ops) applyToStore(reference, op);

          expect(diffViews(store, oracle, keys, SCHEMA), "P1 must hold before the idempotence check").toBeNull();

          const dups = duplicateFacts(store, keys, SCHEMA);
          for (const op of dups) {
            applyToStore(store, op);
            oracle.apply(op);
          }

          // Neither the store nor the runtime moved, and they stay equivalent.
          expect(diffStores(store, reference, keys, SCHEMA), "store changed under duplicate facts").toBeNull();
          expect(diffViews(store, oracle, keys, SCHEMA), "store/runtime diverged under duplicate facts").toBeNull();
        });
      }
    });

    // --- generator coverage (§E8) -----------------------------------------
    describe("generator coverage — the CI seed set exercises every trigger", () => {
      it("hits sane minimums for dominance / respawn / remove-then-set / despawn-with-incoming", () => {
        const total: Coverage = { dominance: 0, respawn: 0, removeThenSet: 0, despawnWithIncoming: 0 };
        for (const seed of cfg.seeds) {
          const cov = opCoverage(genOps(mulberry32(seed), { keys, opCount: cfg.opCount }));
          total.dominance += cov.dominance;
          total.respawn += cov.respawn;
          total.removeThenSet += cov.removeThenSet;
          total.despawnWithIncoming += cov.despawnWithIncoming;
        }
        // Floors, well below the observed counts — a future generator tweak that stops exercising a
        // trigger trips these before the P1/P2/P5/P7 properties can pass VACUOUSLY.
        expect(total.dominance, `dominance too rare: ${JSON.stringify(total)}`).toBeGreaterThanOrEqual(10);
        expect(total.respawn, `respawn too rare: ${JSON.stringify(total)}`).toBeGreaterThanOrEqual(3);
        expect(total.removeThenSet, `remove-then-set too rare: ${JSON.stringify(total)}`).toBeGreaterThanOrEqual(2);
        expect(total.despawnWithIncoming, `despawn-with-incoming too rare: ${JSON.stringify(total)}`).toBeGreaterThanOrEqual(3);
      });
    });
  });
}

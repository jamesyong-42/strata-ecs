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

/** The duplicate-fact set for P7-state: every fact the store currently already holds, read back out. */
function duplicateFacts(view: SnapshotView, keys: readonly EntityKey[], schema: Schema): Op[] {
  const dups: Op[] = [];
  for (const k of keys) {
    for (const c of schema.components) {
      const v = view.getComponent(k, c);
      if (v !== undefined) dups.push({ t: "setC", k, c, v }); // re-write the SAME canonical value
    }
    for (const t of schema.tags) if (view.hasTag(k, t)) dups.push({ t: "addTag", k, tag: t });
    for (const r of schema.relOne) {
      const tk = view.getRelationOne(k, r);
      if (tk !== undefined) dups.push({ t: "setRel", k, r, tk });
    }
    for (const r of schema.relMany) for (const tk of view.getRelationMany(k, r)) dups.push({ t: "addRel", k, r, tk });
  }
  // Genuinely stampless no-ops: remove an ABSENT resource; despawn a key with no cells (§6.1, §5.2).
  for (const res of schema.resources) if (view.getResource(res) === undefined) dups.push({ t: "rmRes", res });
  return dups;
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
              // The property is on the store-under-test (the BASELINE matches); the oracle's
              // reverse-index cascade agrees.
              expect(findIncoming(store, op.k, keys, SCHEMA), `ladder kept an incoming edge to ${op.k}`).toBeNull();
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
  });
}

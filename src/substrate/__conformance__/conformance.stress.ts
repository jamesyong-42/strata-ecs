/**
 * The wider randomized variant of the M4 conformance suite (Patch Note 005 §8) — kept OUT of the
 * default `test`/`ci` run (fast, fixed-seed) and behind `pnpm test:stress`. It widens the seed space
 * and the op/entity bounds for the MutableSnapshot-generic properties (P1/P2/P5/P7-state) and the
 * projector bijection (P3), scaled by `STRESS_SCALE` (see `core/__stress__/harness.ts`). The bounds
 * still respect §8's ceilings (≤ 64 entities) at `STRESS_SCALE=1`; a bigger scale is a soak.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { scaled } from "../../core/__stress__/harness";
import { createWorld } from "../../core/world";
import type { Entity } from "../../core/entity";
import { type EntityKey, entityKey } from "../../core/field";
import { Projector } from "../projector";
import { BaselineSnapshot } from "../baseline";
import { LoroSnapshot } from "../../durable/loro-snapshot";
import { keyPool, mulberry32, pick, randInt } from "./harness";
import { runConformance } from "./runConformance";

// A wide seed span (grows with SCALE). Distinct seeds → distinct op streams.
const SEED_COUNT = scaled(24);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, i) => 0x9e37 * (i + 1) + i);

// P1/P2/P5/P7-state at scale: more keys (still ≤ 64 at SCALE=1) and more ops per sequence.
runConformance(() => new BaselineSnapshot(), {
  label: "BaselineSnapshot (stress)",
  seeds: SEEDS,
  keyCount: Math.min(64, scaled(40)),
  opCount: scaled(500),
});

// Part III M0: the Loro adapter runs the same WIDE SEED sweep (the soak dimension) but at LIGHTER
// per-test bounds. The wasm store is ~50x slower per op than the baseline's Maps, and the harness does
// an O(keyCount) cell-diff after EVERY op, so the baseline's 40-key/500-op bounds make a single P1 test
// run multiple seconds — long enough to trip vitest's worker→reporter RPC ("onTaskUpdate" timeout). Full
// PARITY at the baseline's exact bounds is already the CI conformance run (conformance.test.ts, seeds
// [1,2,3,7,42] / 16 / 200); this soak trades per-test size for seed breadth.
runConformance(() => new LoroSnapshot(new LoroDoc()), {
  label: "LoroSnapshot (stress)",
  seeds: SEEDS,
  keyCount: Math.min(20, scaled(16)),
  opCount: scaled(200),
});

// P3 bijection at scale — a wider interleaving sweep with the same invariant assertions.
describe("P3 — projector bijection (stress)", () => {
  for (const seed of SEEDS) {
    it(`bijection holds under a long interleaving (seed ${seed})`, () => {
      const rng = mulberry32(seed ^ 0x3333);
      const rt = createWorld().runtime;
      let counter = 0;
      const proj = new Projector(rt, () => entityKey(`smint${counter++}`));
      const keys = keyPool(Math.min(64, scaled(24)));
      const bound = new Map<EntityKey, Entity>();
      const iterations = scaled(800);

      for (let i = 0; i < iterations; i++) {
        const k = pick(rng, keys);
        switch (randInt(rng, 6)) {
          case 0: {
            const had = bound.get(k);
            const h = proj.resolveByKey(k);
            if (had !== undefined) expect(h).toBe(had);
            else bound.set(k, h);
            expect(proj.requireKey(h)).toBe(k);
            break;
          }
          case 1: {
            const handle = rt.allocateIdentity();
            const key = proj.createPair(handle);
            expect(bound.has(key)).toBe(false);
            bound.set(key, handle);
            break;
          }
          case 2:
            if (bound.size > 0) {
              const [rk, rh] = pick(rng, [...bound]);
              expect(proj.requireKey(rh)).toBe(rk);
            }
            break;
          case 3:
            expect(() => proj.requireKey(rt.allocateIdentity())).toThrow(/not in this store/);
            break;
          default: {
            const old = bound.get(k);
            proj.remove(k);
            if (old !== undefined) {
              expect(rt.isAlive(old)).toBe(false);
              expect(() => proj.requireKey(old)).toThrow();
              const fresh = proj.resolveByKey(k);
              expect(fresh).not.toBe(old);
              bound.set(k, fresh);
            }
          }
        }
      }
      // One full-bijection sweep at the end keeps the per-iteration cost linear at large scale.
      for (const [bk, bh] of bound) {
        expect(proj.handleFor(bk)).toBe(bh);
        expect(proj.keyFor(bh)).toBe(bk);
      }
    });
  }
});

/**
 * P3 — projector bijection under interleavings (Patch Note 005 §8, §5.1).
 *
 * Random interleavings of `resolveByKey` / `createPair` / `requireKey` / `remove` against a reference
 * model of the key↔handle bijection. Asserts, after every op:
 *   - the two maps stay EXACT inverses (`handleFor`∘`keyFor` is identity on every bound pair);
 *   - `requireKey` throws EXACTLY for unbound handles — never for a bound one, always for an unbound
 *     (a `world.spawn`-style runtime-only handle, or a removed one);
 *   - after `remove(k)`, `resolveByKey(k)` mints a FRESH handle and the old one is dead.
 *
 * The Projector is adapter-independent (every durable/ephemeral binding drives the same class), so
 * this property is not parameterized by the store factory — it is the kernel's own contract.
 */

import { describe, expect, it } from "vitest";
import { createWorld } from "../../core/world";
import type { Entity } from "../../core/entity";
import { type EntityKey, entityKey } from "../../core/field";
import { Projector } from "../projector";
import { keyPool, mulberry32, pick, randInt, type Rng } from "./harness";

function setup() {
  const world = createWorld();
  const rt = world.runtime;
  let counter = 0;
  const proj = new Projector(rt, () => entityKey(`mint${counter++}`));
  return { rt, proj };
}

/** Every bound pair is an exact inverse, and `requireKey` recovers the key. */
function assertBijection(proj: Projector, bound: Map<EntityKey, Entity>): void {
  for (const [k, h] of bound) {
    expect(proj.handleFor(k)).toBe(h);
    expect(proj.keyFor(h)).toBe(k);
    expect(proj.requireKey(h)).toBe(k);
  }
}

describe("P3 — projector bijection under interleavings (§5.1)", () => {
  for (const seed of [11, 23, 101, 2024, 55555]) {
    it(`maps stay exact inverses; requireKey throws exactly for unbound handles (seed ${seed})`, () => {
      const rng: Rng = mulberry32(seed);
      const { rt, proj } = setup();
      const keys = keyPool(12);
      const bound = new Map<EntityKey, Entity>();

      for (let i = 0; i < 300; i++) {
        const k = pick(rng, keys);
        switch (randInt(rng, 6)) {
          case 0: {
            // resolveByKey — idempotent for a bound key; mints (identity-only) for an absent one.
            const had = bound.get(k);
            const h = proj.resolveByKey(k);
            if (had !== undefined) {
              expect(h).toBe(had); // idempotent
            } else {
              expect(proj.keyFor(h)).toBe(k); // freshly minted → bound both ways
              bound.set(k, h);
            }
            expect(proj.requireKey(h)).toBe(k);
            break;
          }
          case 1: {
            // createPair — a fresh runtime handle gets a minted key; a second call throws.
            const handle = rt.allocateIdentity();
            const key = proj.createPair(handle);
            expect(bound.has(key)).toBe(false); // a minted key is always new
            expect(proj.requireKey(handle)).toBe(key);
            expect(() => proj.createPair(handle)).toThrow(/already has a key/);
            bound.set(key, handle);
            break;
          }
          case 2: {
            // requireKey on a BOUND handle → its key.
            if (bound.size > 0) {
              const [rk, rh] = pick(rng, [...bound]);
              expect(proj.requireKey(rh)).toBe(rk);
            }
            break;
          }
          case 3: {
            // requireKey on an UNBOUND (runtime-only) handle → throws.
            const runtimeOnly = rt.allocateIdentity();
            expect(() => proj.requireKey(runtimeOnly)).toThrow(/not in this store/);
            break;
          }
          case 4:
          case 5: {
            // remove — the old handle dies, the bijection drops it, and a re-resolve mints fresh.
            const old = bound.get(k);
            proj.remove(k);
            if (old !== undefined) {
              expect(rt.isAlive(old)).toBe(false); // generation bumped
              expect(proj.keyFor(old)).toBeUndefined();
              expect(proj.handleFor(k)).toBeUndefined();
              expect(() => proj.requireKey(old)).toThrow(/not in this store/);
              const fresh = proj.resolveByKey(k);
              expect(fresh).not.toBe(old); // a FRESH handle, never the dead one
              expect(rt.isAlive(fresh)).toBe(true);
              bound.set(k, fresh);
            } else {
              expect(proj.handleFor(k)).toBeUndefined(); // remove of an unbound key is a no-op
            }
            break;
          }
        }
        assertBijection(proj, bound);
      }
    });
  }
});

/**
 * Property fuzz: a random sequence of spawn/destroy/add/remove/write/tag/relation ops applied to
 * the real world must keep it identical to the {@link Harness} reference model after EVERY op.
 * fast-check shrinks any divergence to a minimal failing sequence (seeded → replays deterministically).
 */

import fc from "fast-check";
import { describe, it } from "vitest";
import { Harness, type Op } from "./reference";
import { SEED, fuzzRuns, scaled } from "./harness";

const MAX_IDX = 24;
const idx = fc.integer({ min: 0, max: MAX_IDX });
const tag = fc.integer({ min: 0, max: 1 });
const compSel = fc.integer({ min: 0, max: 2 });
// i32-safe and f64-exact ranges so a written value round-trips through encode/decode unchanged.
const iVal = fc.integer({ min: -100_000, max: 100_000 });
const fVal = fc.integer({ min: -1_000_000, max: 1_000_000 });
const sVal = fc.string({ maxLength: 8 });

const withValue = (t: "addC" | "wrC") =>
  fc.oneof(
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(0), v: iVal }),
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(1), v: fVal }),
    fc.record({ t: fc.constant(t), i: idx, c: fc.constant(2), v: sVal }),
  );

const op = fc.oneof(
  fc.record({ t: fc.constant("spawn") }),
  fc.record({ t: fc.constant("destroy"), i: idx }),
  withValue("addC"),
  withValue("wrC"),
  fc.record({ t: fc.constant("rmC"), i: idx, c: compSel }),
  fc.record({ t: fc.constant("addTag"), i: idx, tag }),
  fc.record({ t: fc.constant("rmTag"), i: idx, tag }),
  fc.record({ t: fc.constant("setOne"), i: idx, j: idx }),
  fc.record({ t: fc.constant("rmOne"), i: idx }),
  fc.record({ t: fc.constant("addMany"), i: idx, j: idx }),
  fc.record({ t: fc.constant("rmMany"), i: idx, j: idx }),
) as fc.Arbitrary<Op>;

describe("fuzz: random op sequence vs reference model (§5.5)", () => {
  it("world state matches the model after every op", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 8, max: MAX_IDX + 1 }),
        fc.array(op, { maxLength: scaled(60) }),
        (nSpawn, ops) => {
          const h = new Harness();
          for (let s = 0; s < nSpawn; s++) h.apply({ t: "spawn" });
          h.assertEquiv();
          for (const o of ops) {
            h.apply(o);
            h.assertEquiv();
          }
        },
      ),
      { seed: SEED, numRuns: fuzzRuns(200) },
    );
  });
});

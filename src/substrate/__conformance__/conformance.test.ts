/**
 * M4 conformance suite — the in-memory `BaselineSnapshot` under the MutableSnapshot-generic
 * properties P1/P2/P5/P7-state (Patch Note 005 §8). Fixed seeds, bounded size — the whole file runs
 * in well under the CI budget.
 *
 * Part III M0 (plan-part3.md): `LoroSnapshot` runs the IDENTICAL suite (same seeds/bounds) as its
 * acceptance gate (§9 scope cut promised this: "the day the Loro adapter lands, the acceptance test
 * already exists"). A test file may import `loro-crdt` (the quarantine is about the shipped library
 * graph, not tests); production code still routes every Loro call through `LoroSnapshot`.
 */

import { LoroDoc } from "loro-crdt";
import { BaselineSnapshot } from "../baseline";
import { LoroSnapshot } from "../../durable/loro-snapshot";
import { runConformance } from "./runConformance";

runConformance(() => new BaselineSnapshot(), {
  label: "BaselineSnapshot",
  seeds: [1, 2, 3, 7, 42],
  keyCount: 16,
  opCount: 200,
});

runConformance(() => new LoroSnapshot(new LoroDoc()), {
  label: "LoroSnapshot",
  seeds: [1, 2, 3, 7, 42],
  keyCount: 16,
  opCount: 200,
});

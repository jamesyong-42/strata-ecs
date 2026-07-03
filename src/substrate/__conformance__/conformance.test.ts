/**
 * M4 conformance suite — the in-memory `BaselineSnapshot` under the MutableSnapshot-generic
 * properties P1/P2/P5/P7-state (Patch Note 005 §8). Fixed seeds, bounded size — the whole file runs
 * in well under the CI budget. Part III's `LoroSnapshot` will call the SAME `runConformance` with its
 * own factory (the acceptance gate, §9).
 */

import { BaselineSnapshot } from "../baseline";
import { runConformance } from "./runConformance";

runConformance(() => new BaselineSnapshot(), {
  label: "BaselineSnapshot",
  seeds: [1, 2, 3, 7, 42],
  keyCount: 16,
  opCount: 200,
});

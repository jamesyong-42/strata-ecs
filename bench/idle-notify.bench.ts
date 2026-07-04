/**
 * Idle-notify microbench (review-part1 R5). The flagship example calls `world.reactive.notify()`
 * every rAF, so the cost of a pass over an IDLE world — nothing written since the last pass — is
 * paid continuously. Before the quiescent fast path, each idle pass spread `[...keys]` / `[...m]` /
 * `[...arr]` and did an archetype lookup + value decode per watched cell; after it, a clean
 * component is one compare against its skip watermark. This bench pins that: 10k Tier-3 watches,
 * world fully idle, `notify()` per pass.
 *
 *   pnpm exec vitest bench --run bench/idle-notify.bench.ts
 */
import { bench, describe } from "vitest";
import { createWorld, defineComponent } from "../src/index";

const Pos = defineComponent("IdleNotifyPos", { x: "f32", y: "f32" });
const N = 10_000;

// 10k entities, each with a Tier-3 value watch — the "useComponent-per-shape at 10k scale" the
// review names as the realistic exposure. Settle once so every watermark is caught up and every
// subsequent notify is a pure idle pass (no fires).
const w = createWorld();
for (let i = 0; i < N; i++) {
  const e = w.spawn({ components: [[Pos, { x: i, y: i }]] });
  w.reactive.observeValue(e, Pos, () => {});
}
w.reactive.notify();

describe("idle notify — 10k Tier-3 watches, world idle", () => {
  bench("notify() per pass", () => {
    w.reactive.notify();
  });
});

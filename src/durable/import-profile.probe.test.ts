/**
 * Task #75 U0 PROBE: where does the bootstrap-import time go, and what is its complexity?
 *
 * The stall measurement showed a fresh joiner importing a 10k-entity snapshot burns ~14-16s of
 * main-thread CPU inside `doc.applyRemote`, scaling ~O(n²) (20k = ~58s). This probe splits the cost:
 *   (a) loro's own `doc.import(bytes)` into a bare LoroDoc (no adapter);
 *   (b) `exportJsonUpdates` over the imported range (the per-commit splitter's input);
 *   (c) the full adapter `applyRemote` (import + per-commit frontier-diff + translatePairs).
 * (c) - (a) - (b) ≈ the adapter's translation share. Run at three sizes to see the growth law.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { defineComponent, defineTag, entityKey } from "../core";
import { createDurableStore } from "./durable-store";

const IPPos = defineComponent("IPPos", { x: "f32", y: "f32" });
const IPSize = defineComponent("IPSize", { w: "f32", h: "f32" });
const IPFill = defineComponent("IPFill", { r: "u8", g: "u8", b: "u8" });
const IPSel = defineTag("IPSel");

function makeSeedSnapshot(n: number): Uint8Array {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  const store = createDurableStore(doc);
  const s = store.snapshot;
  s.commit(() => {
    for (let i = 0; i < n; i++) {
      const k = entityKey(`1-${i}`);
      s.spawn(k);
      s.setComponent(k, IPPos, { x: i, y: i });
      s.setComponent(k, IPSize, { w: 10, h: 10 });
      s.setComponent(k, IPFill, { r: 1, g: 2, b: 3 });
      if (i % 4 === 0) s.addTag(k, IPSel);
    }
  });
  return s.export();
}

const ms = (t: number): string => t.toFixed(0).padStart(6) + "ms";

describe("import-profile probe (task #75)", () => {
  it("splits bootstrap-import cost across loro import / json export / adapter translation", () => {
    for (const n of [2_500, 5_000, 10_000]) {
      const bytes = makeSeedSnapshot(n);

      // (a) bare loro import — no adapter anywhere.
      const bare = new LoroDoc();
      bare.setPeerId(9);
      const t0 = performance.now();
      bare.import(bytes);
      const tImport = performance.now() - t0;

      // (b) the per-commit splitter's input: JSON updates over the whole imported range.
      const t1 = performance.now();
      const schema = bare.exportJsonUpdates(new LoroDoc().version(), bare.version(), false);
      const tJson = performance.now() - t1;

      // (c) the full adapter path.
      const recvDoc = new LoroDoc();
      recvDoc.setPeerId(8);
      const recv = createDurableStore(recvDoc);
      const t2 = performance.now();
      const batches = recv.snapshot.applyRemote(bytes);
      const tFull = performance.now() - t2;

      const events = batches.reduce((a, b) => a + b.events.length, 0);
      console.log(
        `n=${String(n).padStart(6)}  bytes=${(bytes.byteLength / 1e6).toFixed(2)}MB  ` +
          `import=${ms(tImport)}  jsonExport=${ms(tJson)}  fullApplyRemote=${ms(tFull)}  ` +
          `translation≈${ms(tFull - tImport - tJson)}  changes=${schema.changes.length}  ` +
          `batches=${batches.length}  events=${events}`,
      );

      // REGRESSION PIN (task #75): the bootstrap fast path coalesces to one batch and stays far off
      // the old quadratic (~8s at 10k on this machine; ~0.5s fixed). Loose bound to absorb CI load.
      expect(batches.length).toBe(1);
      if (n === 10_000) expect(tFull).toBeLessThan(3000);
    }
  }, 300_000);
});

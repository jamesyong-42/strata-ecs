import { describe, expect, it } from "vitest";
import { Not, createWorld, defineComponent, defineQuery, defineTag } from "./index";

describe("Batch.rows / count (generator-free iteration, §6.2)", () => {
  it("dense chunk: rows is the identity range, count === denseCount, isDense true", () => {
    const C = defineComponent("BR_C", { v: "u32" });
    const w = createWorld();
    for (let i = 0; i < 5; i++) w.spawn({ components: [[C, { v: i }]] });

    const seen: number[] = [];
    let isDense = false;
    let count = -1;
    let denseCount = -1;
    w.query(defineQuery([C])).each((b) => {
      isDense = b.isDense;
      count = b.count;
      denseCount = b.denseCount;
      for (let i = 0; i < b.count; i++) seen.push(b.rows[i]);
    });

    expect(isDense).toBe(true);
    expect(count).toBe(5);
    expect(denseCount).toBe(5);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("filtered chunk: count/rows are the matched rows only, and agree with for..of", () => {
    const C = defineComponent("BR_C2", { v: "u32" });
    const T = defineTag("BR_T2");
    const w = createWorld();
    for (let i = 0; i < 6; i++) {
      const e = w.spawn({ components: [[C, { v: i }]] });
      if (i % 2 === 0) w.addTag(e, T); // even i tagged → Not(T) matches odd i
    }

    const viaRows: number[] = [];
    const viaForOf: number[] = [];
    w.query(defineQuery([C, Not(T)])).each((b) => {
      expect(b.isDense).toBe(false);
      expect(b.denseCount).toBe(6); // all 6 live in the same [C] archetype
      for (let i = 0; i < b.count; i++) viaRows.push(w.read(b.entity(b.rows[i]), C).v);
      for (const r of b) viaForOf.push(w.read(b.entity(r), C).v);
    });

    expect(viaRows.sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(viaForOf.sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("a filtered query nested inside a filtered body does not corrupt the outer rows", () => {
    const C = defineComponent("BR_C3", { v: "u32" });
    const D = defineComponent("BR_D3", { w: "u32" });
    const T = defineTag("BR_T3");
    const w = createWorld();
    for (let i = 0; i < 8; i++) {
      const e = w.spawn({ components: [[C, { v: i }]] });
      if (i % 2 === 0) w.addTag(e, T); // Not(T) over C matches odd i → v = 1,3,5,7
    }
    for (let i = 0; i < 4; i++) {
      const e = w.spawn({ components: [[D, { w: i }]] });
      if (i % 2 === 0) w.addTag(e, T);
    }

    const qOuter = defineQuery([C, Not(T)]);
    const qInner = defineQuery([D, Not(T)]); // filtered, different archetype → reuses row scratch
    const outer: number[] = [];
    w.query(qOuter).each((b) => {
      for (let i = 0; i < b.count; i++) {
        // Run a nested filtered query mid-iteration; if the outer's rows aliased the shared scratch
        // this would clobber it. The per-chunk copy makes it safe.
        let innerSeen = 0;
        w.query(qInner).each((bi) => {
          innerSeen += bi.count;
        });
        expect(innerSeen).toBe(2); // D with odd i → w = 1,3
        outer.push(w.read(b.entity(b.rows[i]), C).v);
      }
    });

    expect(outer.sort((a, b) => a - b)).toEqual([1, 3, 5, 7]);
  });
});

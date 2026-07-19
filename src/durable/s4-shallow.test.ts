/**
 * S4 Tier A — at-rest SHALLOW snapshot export + the cross-boundary hardening it exposed.
 *
 * `exportSnapshot({ mode: "shallow" })` compacts the oplog at the current frontier (state complete,
 * history truncated below it) for autosave / disk. This file pins its structural properties and its two
 * laws, plus the boundary hardening: a full-history peer's increment reaching below the truncation
 * boundary throws a BARE non-Error string in loro, which the adapter now maps to {@link
 * PendingImportError} (the same quarantine-and-re-bootstrap contract as any unrecoverable import).
 *
 *   - (a) shallow is smaller than full under overwrite churn (structural — no absolute numbers);
 *   - (b) the RELOAD RECIPE (bare-import THEN createDurableStore) restores full fidelity, undo intact;
 *   - (c) shallow bytes through applyRemote on a CONSTRUCTED store quarantine (the B0 construction-op fact);
 *   - (d) a cross-boundary increment into a shallow-restored store maps to PendingImportError + quarantines;
 *   - (e) two stores restored from the SAME shallow base delta-converge (both directions).
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { entityKey } from "../core";
import { defineComponent, defineTag } from "../core";
import { PendingImportError } from "./loro-snapshot";
import { createDurableStore } from "./durable-store";

const Pos = defineComponent("S4Pos", { x: "f32", y: "f32" });
const Sel = defineTag("S4Sel");

const K = (s: string) => entityKey(s);

/** A fresh LoroDoc with an explicit peer id (peer id → key prefix + LWW ordering), wrapped in a store. */
function store(peerId: number): { store: ReturnType<typeof createDurableStore>; doc: LoroDoc } {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return { store: createDurableStore(doc), doc };
}

// ---------------------------------------------------------------------------------------------------
describe("shallow export — size + fidelity (S4 Tier A)", () => {
  it("a shallow snapshot is smaller than a full one after overwrite churn", () => {
    const { store: s } = store(1);
    const snap = s.snapshot;
    const keys = Array.from({ length: 50 }, (_, i) => K(`1-${i}`));
    snap.commit(() => {
      for (const k of keys) {
        snap.spawn(k);
        snap.setComponent(k, Pos, { x: 0, y: 0 });
      }
    });
    // Churn: overwrite every entity's Pos many times. LWW converges the STATE, but every op stays in
    // the full oplog — exactly the history a shallow snapshot garbage-collects.
    for (let round = 0; round < 60; round++) {
      snap.commit(() => {
        for (const k of keys) snap.setComponent(k, Pos, { x: round, y: round });
      });
    }
    snap.commit(() => {
      for (let i = 0; i < 10; i++) snap.despawn(keys[i]); // ghosts: empty containers linger (the floor)
    });

    const full = s.exportSnapshot();
    const shallow = s.exportSnapshot({ mode: "shallow" });
    expect(shallow.byteLength).toBeLessThan(full.byteLength);
  });

  it("no-argument export is unchanged (a full snapshot restores through applyRemote as before)", () => {
    const { store: src } = store(1);
    src.snapshot.commit(() => {
      src.snapshot.spawn(K("1-0"));
      src.snapshot.setComponent(K("1-0"), Pos, { x: 3, y: 4 });
    });
    const full = src.exportSnapshot();

    // A full snapshot still imports cleanly onto a constructed store (the classic bootstrap path).
    const { store: joiner } = store(2);
    expect(() => joiner.applyRemote(full)).not.toThrow();
    expect(joiner.snapshot.getComponent(K("1-0"), Pos)).toEqual({ x: 3, y: 4 });
  });

  it("reload recipe: bare-import shallow bytes THEN createDurableStore restores full fidelity, undo intact", () => {
    const { store: src } = store(1);
    const snap = src.snapshot;
    const keys = [K("1-0"), K("1-1"), K("1-2")];
    snap.commit(() => {
      for (const k of keys) {
        snap.spawn(k);
        snap.setComponent(k, Pos, { x: 1, y: 2 });
      }
      snap.addTag(K("1-0"), Sel);
    });
    for (let r = 0; r < 10; r++) snap.commit(() => snap.setComponent(K("1-1"), Pos, { x: r, y: r }));

    const shallow = src.exportSnapshot({ mode: "shallow" });

    // THE RELOAD RECIPE: import into a BARE doc first, THEN construct the store (adopts the docId,
    // pristine-fast, shallow-compatible).
    const reDoc = new LoroDoc();
    reDoc.import(shallow);
    const restored = createDurableStore(reDoc);

    // docId + entity key set + every entity record match the source.
    expect(restored.docId).toBe(src.docId);
    expect(new Set(restored.snapshot.entityKeysRaw())).toEqual(new Set(src.snapshot.entityKeysRaw()));
    for (const k of restored.snapshot.entities()) {
      expect(restored.snapshot.readEntity(k)).toEqual(src.snapshot.readEntity(k));
    }

    // Undo works on the restored store: the stack starts empty (a joiner has nothing to undo), and the
    // first local commit is undoable — the lazy UndoManager makes this natural (S3 phase 1).
    expect(restored.canUndo()).toBe(false);
    restored.snapshot.commit(() => restored.snapshot.setComponent(K("1-2"), Pos, { x: 99, y: 99 }));
    expect(restored.canUndo()).toBe(true);
    expect(restored.undo()).toBe(true);
    expect(restored.snapshot.getComponent(K("1-2"), Pos)).toEqual({ x: 1, y: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe("shallow boundary — quarantine + hardening (S4 Tier A)", () => {
  it("shallow bytes through applyRemote on a CONSTRUCTED store quarantine (the B0 construction-op fact)", () => {
    const { store: src } = store(1);
    src.snapshot.commit(() => src.snapshot.spawn(K("1-0")));
    const shallow = src.exportSnapshot({ mode: "shallow" });

    // A constructed store carries its own docId commit — a divergent op the shallow base lacks — so the
    // shallow snapshot takes a pending import and permanently quarantines. This is WHY the reload recipe
    // (bare import first) exists; a constructed store is the wrong door for a shallow snapshot.
    const { store: dst } = store(2);
    expect(() => dst.applyRemote(shallow)).toThrow(PendingImportError);
    expect(() => dst.applyRemote(shallow)).toThrow(PendingImportError); // permanent
  });

  it("a full-history peer's cross-boundary increment maps to PendingImportError + quarantines the store", () => {
    // Authority A publishes a snapshot early; full-history peer B mirrors it at that point.
    const { store: A } = store(1);
    A.snapshot.commit(() => {
      A.snapshot.spawn(K("1-0"));
      A.snapshot.setComponent(K("1-0"), Pos, { x: 0, y: 0 });
    });
    const bDoc = new LoroDoc();
    bDoc.setPeerId(2);
    bDoc.import(A.exportSnapshot()); // B holds A's FULL history from the shared base
    const B = createDurableStore(bDoc);
    const bBase = B.snapshot.version();

    // A churns forward, then compacts — the shallow snapshot's history is truncated ABOVE that base.
    for (let r = 1; r <= 15; r++) A.snapshot.commit(() => A.snapshot.setComponent(K("1-0"), Pos, { x: r, y: r }));
    const shallow = A.exportSnapshot({ mode: "shallow" });

    // A peer restored from that shallow base (reload recipe).
    const reDoc = new LoroDoc();
    reDoc.import(shallow);
    const restored = createDurableStore(reDoc);

    // B (still branched at the shared base) authors an edit; its increment's deps predate the boundary.
    // Loro throws a BARE non-Error string ("…not included in the shallow history…") that used to escape
    // applyRemote uncaught — it is now mapped to the quarantine class.
    B.snapshot.commit(() => B.snapshot.setComponent(K("1-0"), Pos, { x: 999, y: 999 }));
    const crossBoundary = B.snapshot.exportUpdatesSince(bBase);

    expect(() => restored.applyRemote(crossBoundary)).toThrow(PendingImportError);
    expect(() => restored.applyRemote(crossBoundary)).toThrow(PendingImportError); // permanently quarantined
  });

  it("genuinely undecodable bytes still pass through untouched (only the shallow boundary is remapped)", () => {
    const { store: s } = store(1);
    // A garbage frame is NOT a shallow-history failure — it must NOT be swallowed into the quarantine
    // class (that would let one hostile frame poison the store); the transport owns the total catch.
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let threw: unknown;
    try {
      s.applyRemote(garbage);
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeInstanceOf(PendingImportError);
    // and the store is NOT quarantined by hostile bytes — a legitimate import still works afterward.
    const { store: other } = store(2);
    other.snapshot.commit(() => other.snapshot.spawn(K("2-0")));
    expect(() => s.applyRemote(other.exportSnapshot())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("shallow same-base peers (S4 Tier A)", () => {
  it("two stores restored from the SAME shallow base delta-converge in both directions", () => {
    const { store: src } = store(1);
    const snap = src.snapshot;
    snap.commit(() => {
      for (const k of [K("1-0"), K("1-1")]) {
        snap.spawn(k);
        snap.setComponent(k, Pos, { x: 0, y: 0 });
      }
    });
    for (let r = 0; r < 8; r++) snap.commit(() => snap.setComponent(K("1-0"), Pos, { x: r, y: r }));
    const shallow = src.exportSnapshot({ mode: "shallow" });

    // Two peers restored from the SAME shallow base (reload recipe, distinct peer ids).
    const p1Doc = new LoroDoc();
    p1Doc.setPeerId(11);
    p1Doc.import(shallow);
    const P1 = createDurableStore(p1Doc);
    const p2Doc = new LoroDoc();
    p2Doc.setPeerId(22);
    p2Doc.import(shallow);
    const P2 = createDurableStore(p2Doc);

    const baseP1 = P1.snapshot.version();
    const baseP2 = P2.snapshot.version();
    P1.snapshot.commit(() => P1.snapshot.setComponent(K("1-0"), Pos, { x: 100, y: 100 }));
    P2.snapshot.commit(() => P2.snapshot.setComponent(K("1-1"), Pos, { x: 200, y: 200 }));

    // Exchange increments across the shared shallow base — no boundary crossed, so no quarantine.
    expect(() => P2.applyRemote(P1.snapshot.exportUpdatesSince(baseP1))).not.toThrow();
    expect(() => P1.applyRemote(P2.snapshot.exportUpdatesSince(baseP2))).not.toThrow();

    for (const k of [K("1-0"), K("1-1")]) {
      expect(P1.snapshot.readEntity(k)).toEqual(P2.snapshot.readEntity(k));
    }
    expect(P1.snapshot.getComponent(K("1-0"), Pos)).toEqual({ x: 100, y: 100 });
    expect(P1.snapshot.getComponent(K("1-1"), Pos)).toEqual({ x: 200, y: 200 });
  });
});

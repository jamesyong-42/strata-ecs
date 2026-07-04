/**
 * `strata-ecs/durable` — the public surface + `DurableSyncStatus` (Part III **M5**; design.md Part III
 * API reference, 006 C7 as amended). Imports come THROUGH THE BARREL (`./index`) so the test doubles as
 * proof the public entry resolves and wires end-to-end (the react/tools precedent: test the `./index`
 * entry, not the built dist). Coverage:
 *   - barrel: every public value/type export resolves; a full create→attach→transaction→sync→read
 *     round-trip works through the barrel; the re-exported `PendingImportError` is the same symbol;
 *   - DurableSyncStatus set-on-change: an IDLE network (repeated empty drains) fires NO observeResource
 *     callback — the whole point of the amendment (006 C7);
 *   - activity: a local-echo enqueue and a remote enqueue both bump `pendingInbound`; a drain that applies
 *     ≥1 fact advances `lastAppliedFrame` and drops `pendingInbound` back to 0; a live drag-drop shows in
 *     `heldCells`, and ending the drag clears it;
 *   - useResource-shaped consumption: a Tier-3 `observeResource` + `peekResource` watch (the exact shape
 *     `strata-ecs/react`'s `useResource` is built on) sees a real change once and reads the current value.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createWorld, defineComponent } from "../core";
import {
  attachDurable,
  createDurableStore,
  DurableSyncStatus,
  PendingImportError,
  type Attachment,
  type DurableStore,
  type DurableSyncStatusValue,
  type Mutator,
  type TxEditor,
} from "./index";
import { PendingImportError as PendingImportErrorInternal } from "./loro-snapshot";

const SPos = defineComponent("SURFPos", { x: "f32", y: "f32" });

function makeStore(peerId: number): DurableStore {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/** The current DurableSyncStatus, forced non-undefined (attach always publishes an initial value). */
function status(w: ReturnType<typeof createWorld>): DurableSyncStatusValue {
  return w.getResource(DurableSyncStatus)!;
}

// ===================================================================================================
describe("the public barrel (strata-ecs/durable)", () => {
  it("exposes the documented value + type surface, and it wires end-to-end", () => {
    expect(typeof createDurableStore).toBe("function");
    expect(typeof attachDurable).toBe("function");
    expect(typeof PendingImportError).toBe("function");
    expect(PendingImportError.prototype).toBeInstanceOf(Error);
    // DurableSyncStatus is the framework resource object (not a factory).
    expect(DurableSyncStatus.name).toBe("DurableSyncStatus");

    // A round-trip through ONLY the public exports — the type annotations prove DurableStore / Attachment
    // / Mutator / TxEditor / DurableSyncStatusValue all resolve from the barrel (compile-time), the calls
    // prove the wiring runs (runtime).
    const store: DurableStore = makeStore(1);
    const w = createWorld();
    const att: Attachment = attachDurable(w, store);
    const h = store.transaction((tx: Mutator) => {
      const e = tx.spawn({ components: [[SPos, { x: 0, y: 0 }]] });
      const ed: TxEditor = tx.edit(e);
      ed.set(SPos, { x: 1, y: 2 }); // SPos is introduced-this-tx → folds into the spawn payload (§12.2)
      return e;
    });
    w.sync(); // structure rides projection → the spawn + component land now
    expect(w.read(h, SPos)).toEqual({ x: 1, y: 2 });
    expect(store.keyOf(h)).toBeDefined();

    const v: DurableSyncStatusValue | undefined = status(w);
    expect(v).toBeDefined();
    att.detach();
  });

  it("re-exports the SAME PendingImportError as the adapter throws", () => {
    // Same symbol → a `catch (e) { if (e instanceof PendingImportError) … }` on the public import matches
    // what the adapter throws internally.
    expect(PendingImportError).toBe(PendingImportErrorInternal);
  });
});

// ===================================================================================================
describe("DurableSyncStatus — producer-side set-on-change (006 C7)", () => {
  it("an idle network fires NO observeResource callback across repeated empty drains", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);

    // Arm a resource watch AFTER attach (so the initial publish, made before reactivity armed, is not a
    // fire), then run many empty sync→notify cycles. An empty drain applies nothing and moves no field, so
    // set-on-change writes nothing, nothing stamps, and the watch never fires (the idle guarantee).
    let fires = 0;
    w.reactive.observeResource(DurableSyncStatus, () => {
      fires++;
    });
    for (let i = 0; i < 5; i++) {
      w.sync();
      w.reactive.notify();
    }
    expect(fires).toBe(0);
  });

  it("initial publish is present and zeroed after attach", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    expect(status(w)).toEqual({ pendingInbound: 0, heldCells: 0, lastAppliedFrame: 0 });
  });
});

// ===================================================================================================
describe("DurableSyncStatus — activity-driven fields (006 C7)", () => {
  it("a local-echo enqueue bumps pendingInbound; the drain applies → lastAppliedFrame advances, pendingInbound falls", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);
    expect(status(w)).toEqual({ pendingInbound: 0, heldCells: 0, lastAppliedFrame: 0 });

    // Commit a spawn: the local echo enqueues (subscription) and republishes at the enqueue boundary,
    // BEFORE any sync — so pendingInbound is 1 and lastAppliedFrame is still 0 (nothing applied yet).
    store.transaction((tx) => tx.spawn({ components: [[SPos, { x: 3, y: 4 }]] }));
    expect(status(w).pendingInbound).toBe(1);
    expect(status(w).lastAppliedFrame).toBe(0);

    // Drain: the spawn + component apply → lastAppliedFrame advances once, pendingInbound falls to 0.
    w.sync();
    expect(status(w)).toEqual({ pendingInbound: 0, heldCells: 0, lastAppliedFrame: 1 });

    // A second empty drain applies nothing → lastAppliedFrame does NOT advance again (never per-drain).
    w.sync();
    expect(status(w).lastAppliedFrame).toBe(1);
  });

  it("a remote enqueue bumps pendingInbound; draining it advances lastAppliedFrame and projects the entity", () => {
    const a = makeStore(1);
    const wA = createWorld();
    attachDurable(wA, a);
    const b = makeStore(2);
    const wB = createWorld();
    attachDurable(wB, b);

    // A creates a shape and syncs its own echo.
    const hA = a.transaction((tx) => tx.spawn({ components: [[SPos, { x: 7, y: 8 }]] }));
    wA.sync();
    const key = a.keyOf(hA)!;

    const before = status(wB);
    expect(before.pendingInbound).toBe(0);

    // Deliver A's document to B (a full-state import) — applyRemote enqueues + republishes at the enqueue
    // boundary, so B sees pendingInbound > 0 BEFORE it drains.
    b.applyRemote(a.snapshot.export());
    expect(status(wB).pendingInbound).toBeGreaterThan(0);
    expect(status(wB).lastAppliedFrame).toBe(before.lastAppliedFrame); // not applied yet

    // Drain on B: the remote facts apply → the entity projects, pendingInbound falls to 0, lastAppliedFrame
    // advances past its prior value.
    wB.sync();
    expect(status(wB).pendingInbound).toBe(0);
    expect(status(wB).lastAppliedFrame).toBeGreaterThan(before.lastAppliedFrame);
    const hB = b.resolve(key)!;
    expect(wB.read(hB, SPos)).toEqual({ x: 7, y: 8 });
  });

  it("a live drag-drop shows in heldCells; ending the drag clears it", () => {
    // Two peers sharing a pre-existing SPos entity.
    const a = makeStore(1);
    const wA = createWorld();
    attachDurable(wA, a);
    const b = makeStore(2);
    const wB = createWorld();
    attachDurable(wB, b);
    const hA = a.transaction((tx) => tx.spawn({ components: [[SPos, { x: 0, y: 0 }]] }));
    wA.sync();
    const key = a.keyOf(hA)!;
    b.applyRemote(a.snapshot.export());
    wB.sync();
    const hB = b.resolve(key)!;
    expect(wB.read(hB, SPos)).toEqual({ x: 0, y: 0 });
    expect(status(wA).heldCells).toBe(0);

    // A drags SPos runtime-only (diverges runtime {9,9} from baseline {0,0}) — no commit, no echo.
    wA.edit(hA).set(SPos, { x: 9, y: 9 });

    // B commits SPos concurrently; deliver B→A. A drains it mid-drag → (remote, value) DROP → the ledger
    // holds it. heldCells reflects the live hold.
    b.transaction((tx) => tx.edit(hB).set(SPos, { x: 7, y: 7 }));
    wB.sync();
    a.applyRemote(b.snapshot.export());
    wA.sync();
    expect(wA.read(hA, SPos)).toEqual({ x: 9, y: 9 }); // the drag stands (drop, not stomp)
    expect(status(wA).heldCells).toBe(1);

    // A commits its own value (ends the drag): supersession (b) clears the held loser; the next drain shows
    // heldCells back to 0.
    a.transaction((tx) => tx.edit(hA).set(SPos, { x: 9, y: 9 }));
    wA.sync();
    expect(status(wA).heldCells).toBe(0);
  });

  it("detach removes the runtime-local status (useResource → undefined)", () => {
    const store = makeStore(1);
    const w = createWorld();
    const att = attachDurable(w, store);
    expect(w.getResource(DurableSyncStatus)).toBeDefined();
    att.detach();
    expect(w.getResource(DurableSyncStatus)).toBeUndefined();
  });
});

// ===================================================================================================
describe("DurableSyncStatus — useResource-shaped consumption (003 §1.3)", () => {
  it("a reactive observeResource + peekResource watch sees a real change once and reads the current value", () => {
    const store = makeStore(1);
    const w = createWorld();
    attachDurable(w, store);

    // The exact machinery strata-ecs/react's useResource is built on: subscribe via observeResource,
    // read via peekResource (equality-suppressed at the notify boundary).
    let fires = 0;
    let latest: DurableSyncStatusValue | undefined;
    w.reactive.observeResource(DurableSyncStatus, () => {
      fires++;
      latest = w.reactive.peekResource(DurableSyncStatus) as DurableSyncStatusValue | undefined;
    });

    // Real activity: a committed spawn drains and applies → lastAppliedFrame advances → one fire.
    store.transaction((tx) => tx.spawn({ components: [[SPos, { x: 1, y: 1 }]] }));
    w.sync();
    w.reactive.notify();
    expect(fires).toBe(1);
    expect(latest?.lastAppliedFrame).toBe(1);

    // A quiet frame (empty drain) → no change → no additional fire (set-on-change).
    w.sync();
    w.reactive.notify();
    expect(fires).toBe(1);
    expect(w.reactive.peekResource(DurableSyncStatus)).toEqual({ pendingInbound: 0, heldCells: 0, lastAppliedFrame: 1 });
  });
});

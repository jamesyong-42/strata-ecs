/**
 * Non-undoable transactions — `doc.transaction(fn, { undoable: false })` (petition 2).
 *
 * A transaction whose single Loro commit is EXCLUDED from THIS peer's UndoManager (via the reserved
 * {@link NON_UNDOABLE_ORIGIN}), so document migrations / read-repair / janitorial transforms no longer
 * have to nuke user history with `clearHistory()`. Pins:
 *   a. a store whose ONLY commit is non-undoable → `canUndo()` false;
 *   b. a user tx then a non-undoable tx → the user step is still undoable and its cell reverts, while the
 *      engine cell survives; the engine commit added NO step;
 *   c. the redo-stack interaction (pinned-observed loro behavior);
 *   d. `undoGroup` wrapping one undoable + one non-undoable tx → one step, reverting the undoable one only;
 *   e. `capture` history hook does NOT fire for a non-undoable commit (and still fires for a normal one);
 *   f. the LINGERING-ORIGIN pin — an EMPTY non-undoable tx must not drop the FOLLOWING user tx off undo;
 *   g. cross-peer — A's non-undoable commit reaches B as a NORMAL remote batch; B's undo stack untouched.
 *
 * Mirrors history.test.ts's attached-store fixtures (the real `doc.transaction` path is exercised end to
 * end; the seam is `runTransaction` → `snapshot.commit(body, { undoable })`).
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createWorld, defineComponent, defineTag, entityKey } from "../core";
import type { ChangeBatch } from "../substrate";
import { attachDurable } from "./binding";
import { createDurableStore } from "./durable-store";

const NUPos = defineComponent("NUPos", { x: "f32", y: "f32" });
const NUFill = defineComponent("NUFill", { v: "f32" });
const NUSel = defineTag("NUSel");

const K = (s: string) => entityKey(s);

function makeStore(peerId: number) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

function makeAttached(peerId: number) {
  const store = makeStore(peerId);
  const world = createWorld();
  const att = attachDurable(world, store);
  return { store, world, att };
}

// ---------------------------------------------------------------------------------------------------
describe("undoable: false excludes the commit from the local undo stack", () => {
  it("(a) a store whose ONLY commit is a non-undoable transaction cannot undo", () => {
    const { store, world } = makeAttached(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }), { undoable: false });
    const key = store.keyOf(h)!;

    // The commit still LANDED in the document — it just pushed no undo step.
    expect(store.snapshot.hasEntity(key)).toBe(true);
    expect(store.snapshot.getComponent(key, NUPos)).toEqual({ x: 1, y: 1 });
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false); // empty stack — nothing to revert
    world.sync();
    expect(store.canUndo()).toBe(false);
  });

  it("(b) a user tx then a non-undoable tx: only the user step is undoable; the engine cell survives", () => {
    const { store } = makeAttached(1);
    // User transaction — an ordinary undoable step.
    const hu = store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }));
    const userKey = store.keyOf(hu)!;
    expect(store.canUndo()).toBe(true);

    // Engine (non-undoable) transaction — writes a durable cell but adds NO undo step.
    const he = store.transaction((tx) => tx.spawn({ components: [[NUFill, { v: 42 }]] }), { undoable: false });
    const engineKey = store.keyOf(he)!;
    expect(store.canUndo()).toBe(true); // still exactly the user's one step

    // Undo reverts ONLY the user step: the user entity is gone, the engine cell survives.
    expect(store.undo()).toBe(true);
    expect(store.snapshot.hasEntity(userKey)).toBe(false);
    expect(store.snapshot.hasEntity(engineKey)).toBe(true);
    expect(store.snapshot.getComponent(engineKey, NUFill)).toEqual({ v: 42 });

    // The engine commit contributed no step → the stack is now empty.
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false);
  });

  it("(c) redo-stack interaction with an intervening non-undoable tx (pinned-observed loro behavior)", () => {
    const { store } = makeAttached(1);
    const hu = store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }));
    const userKey = store.keyOf(hu)!;
    expect(store.undo()).toBe(true);
    expect(store.canRedo()).toBe(true);

    // A non-undoable transaction lands between the undo and a would-be redo.
    store.transaction((tx) => tx.spawn({ components: [[NUFill, { v: 7 }]] }), { undoable: false });

    // PINNED-OBSERVED loro-crdt@1.13.6 behavior: an excluded-origin commit is ignored by the UndoManager
    // entirely — it neither pushes an undo step NOR clears the redo stack (contrast rule 3, where a NORMAL
    // local commit clears redo). So the user's redo SURVIVES the intervening engine write — the desirable
    // outcome. This is loro's behavior, pinned; if a loro upgrade changes it, this assertion catches it.
    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.snapshot.hasEntity(userKey)).toBe(true);
  });

  it("(d) undoGroup wrapping one undoable + one non-undoable tx is one step, reverting the undoable only", () => {
    const { store } = makeAttached(1);
    let userKey = "";
    let engineKey = "";
    store.undoGroup(() => {
      const hu = store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }));
      userKey = String(store.keyOf(hu)!);
      const he = store.transaction((tx) => tx.spawn({ components: [[NUFill, { v: 9 }]] }), { undoable: false });
      engineKey = String(store.keyOf(he)!);
    });

    // Exactly one undoable step exists (the non-undoable tx never joined the group's step).
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.snapshot.hasEntity(K(userKey))).toBe(false); // the undoable spawn reverted
    expect(store.snapshot.hasEntity(K(engineKey))).toBe(true); // the non-undoable spawn survives
    expect(store.canUndo()).toBe(false); // one step only
  });
});

// ---------------------------------------------------------------------------------------------------
describe("history hooks", () => {
  it("(e) capture does NOT fire for a non-undoable commit, but still fires for a normal one", () => {
    const { store } = makeAttached(1);
    const captured: string[] = [];
    store.setHistoryHooks({
      capture: (stack) => {
        captured.push(stack);
        return null;
      },
    });

    // Non-undoable: no step is pushed → capture never runs.
    store.transaction((tx) => tx.spawn({ components: [[NUFill, { v: 1 }]] }), { undoable: false });
    expect(captured).toEqual([]);

    // Normal: a step is pushed onto the undo stack → capture fires with the "undo" label.
    store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }));
    expect(captured).toEqual(["undo"]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("lingering-origin pin (petition 2 critical)", () => {
  it("(f) an EMPTY non-undoable tx does not drop the FOLLOWING user tx off the undo stack", () => {
    const { store } = makeAttached(1);
    // fn records nothing → the seal stages no ops. The non-undoable origin must NOT linger onto the next
    // commit (probe-verified it does not in loro-crdt@1.13.6; the staged-ops guard makes it correct-by-
    // construction regardless). No step either way — an empty commit changes nothing.
    store.transaction(() => {}, { undoable: false });
    expect(store.canUndo()).toBe(false);

    // The following ordinary user transaction MUST be undoable.
    const h = store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 1, y: 1 }]] }));
    const key = store.keyOf(h)!;
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.snapshot.hasEntity(key)).toBe(false);
    expect(store.canUndo()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("cross-peer", () => {
  it("(g) A's non-undoable commit reaches B as a normal remote batch; B's undo stack is untouched", () => {
    const a = makeAttached(1);
    const b = makeAttached(2);

    // A commits a non-undoable transaction (its own stack stays empty).
    const ha = a.store.transaction((tx) => tx.spawn({ components: [[NUPos, { x: 5, y: 5 }]], tags: [NUSel] }), {
      undoable: false,
    });
    a.world.sync();
    const key = a.store.keyOf(ha)!;
    expect(a.store.canUndo()).toBe(false); // A's only commit was non-undoable

    // B observes the incoming batch, then imports A's document.
    const seen: ChangeBatch[] = [];
    b.store.snapshot.subscribe((batch) => seen.push(batch));
    b.store.applyRemote(a.store.exportSnapshot());

    // B saw an ordinary REMOTE batch (undoability is a LOCAL concern — nothing rides the wire), and the
    // values landed in B's document.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((batch) => batch.origin === "remote")).toBe(true);
    expect(b.store.snapshot.getComponent(key, NUPos)).toEqual({ x: 5, y: 5 });
    expect(b.store.snapshot.hasTag(key, NUSel)).toBe(true);

    // The remote arrival projects into B's runtime and never touches B's (empty) undo stack.
    b.world.sync();
    expect(b.world.read(b.store.resolve(key)!, NUPos)).toEqual({ x: 5, y: 5 });
    expect(b.store.canUndo()).toBe(false);
    expect(b.store.canRedo()).toBe(false);
  });
});

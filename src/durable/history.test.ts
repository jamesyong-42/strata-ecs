/**
 * Public undo/redo — the behavior matrix (plan-undo U3).
 *
 * Pins the collaborative-undo consensus rules the design adopted (Figma / Liveblocks / Yjs / Loro /
 * tldraw survey) AT THE PUBLIC API level (`DurableStore.undo/redo/...`), plus the loro-faithful
 * divergences the docs promise:
 *   1. own-changes-only — a peer's ops are never on this store's stacks;
 *   2. one transaction = one undo step; `undoGroup` collapses several into one;
 *   3. redo clears on a new local commit;
 *   4. empty-stack undo/redo return false and change nothing;
 *   5. selection metadata rides the stacks via capture/restore hooks;
 *   + divergences: undo re-asserts pre-op state as newest (clobbers a causally-newer remote same-cell
 *     write; undo-of-spawn takes peers' later components), and attached reversal lands at the NEXT
 *     `world.sync()`. Container-delete convergence is pinned separately (undo-container.probe.test.ts).
 *
 * Store-level scenarios drive local commits via `store.snapshot.commit(() => …)` (the M3 executor's
 * exact seam); attached scenarios use the real `doc.transaction`.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { createWorld, defineComponent, entityKey } from "../core";
import { attachDurable } from "./binding";
import { createDurableStore } from "./durable-store";
import { PendingImportError } from "./loro-snapshot";
import { DurableUndoStatus } from "./undo-status";

const HPos = defineComponent("HISTPos", { x: "f32", y: "f32" });
const HFill = defineComponent("HISTFill", { v: "f32" });

const K = (s: string) => entityKey(s);

function makeStore(peerId: number, opts?: { maxUndoSteps?: number }) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc, opts);
}

function makeAttached(peerId: number) {
  const store = makeStore(peerId);
  const world = createWorld();
  const att = attachDurable(world, store);
  return { store, world, att };
}

/** Full-state exchange both ways, then drain both runtimes (the loopback "everyone settles" barrier). */
function settle(a: { store: ReturnType<typeof makeStore>; world: ReturnType<typeof createWorld> }, b: typeof a) {
  const aBytes = a.store.exportSnapshot();
  const bBytes = b.store.exportSnapshot();
  a.store.applyRemote(bBytes);
  b.store.applyRemote(aBytes);
  a.world.sync();
  b.world.sync();
}

// ---------------------------------------------------------------------------------------------------
describe("stack mechanics (rules 3 & 4)", () => {
  it("fresh store: both stacks empty, undo/redo are false no-ops", () => {
    const s = makeStore(1);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  it("commit → undo → redo roundtrip moves the document and both flags", () => {
    const s = makeStore(1);
    s.snapshot.commit(() => {
      s.snapshot.spawn(K("1-0"));
      s.snapshot.setComponent(K("1-0"), HPos, { x: 1, y: 2 });
    });
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);

    expect(s.undo()).toBe(true);
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(true);

    expect(s.redo()).toBe(true);
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(true);
    expect(s.snapshot.getComponent(K("1-0"), HPos)).toEqual({ x: 1, y: 2 });
    expect(s.canRedo()).toBe(false);
  });

  it("a new local commit clears the redo stack (rule 3)", () => {
    const s = makeStore(1);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    s.undo();
    expect(s.canRedo()).toBe(true);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1"))); // divergent new edit
    expect(s.canRedo()).toBe(false);
    expect(s.redo()).toBe(false);
  });

  it("maxUndoSteps caps the stack — the oldest step evicts", () => {
    const s = makeStore(1, { maxUndoSteps: 2 });
    for (let i = 0; i < 3; i++) s.snapshot.commit(() => s.snapshot.spawn(K(`1-${i}`)));
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(false); // the first spawn evicted past the cap
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(true); // …so it survives undo-all
  });

  it("clearHistory empties both stacks", () => {
    const s = makeStore(1);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1")));
    s.undo();
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(true);
    s.clearHistory();
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.snapshot.hasEntity(K("1-1"))).toBe(false); // clear forgets history, never reverts state
  });
});

// ---------------------------------------------------------------------------------------------------
describe("grouping (rule 2)", () => {
  it("one transaction = one undo step (attached)", () => {
    const { store, world } = makeAttached(1);
    store.transaction((tx) => {
      tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] });
      tx.spawn({ components: [[HPos, { x: 2, y: 2 }]] });
    });
    world.sync();
    expect([...store.snapshot.entities()].length).toBe(2);
    expect(store.undo()).toBe(true);
    world.sync();
    expect([...store.snapshot.entities()].length).toBe(0); // BOTH spawns reverted by one step
    expect(store.canUndo()).toBe(false);
  });

  it("undoGroup collapses several commits into one step", () => {
    const s = makeStore(1);
    s.undoGroup(() => {
      s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
      s.snapshot.commit(() => s.snapshot.spawn(K("1-1")));
    });
    expect(s.undo()).toBe(true);
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(s.snapshot.hasEntity(K("1-1"))).toBe(false);
    expect(s.canUndo()).toBe(false); // exactly one step existed
  });

  it("a throwing undoGroup body still closes the group; prior commits stay one undoable step", () => {
    const s = makeStore(1);
    expect(() =>
      s.undoGroup(() => {
        s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
        throw new Error("gesture cancelled");
      }),
    ).toThrow(/gesture cancelled/);
    expect(s.canUndo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
    // and the group is really closed — the next commit is its own separate step
    s.snapshot.commit(() => s.snapshot.spawn(K("1-9")));
    expect(s.canUndo()).toBe(true);
  });

  it("undo groups do not nest", () => {
    const s = makeStore(1);
    expect(() =>
      s.undoGroup(() => {
        s.undoGroup(() => {});
      }),
    ).toThrow(/do not nest/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("collaborative semantics (rule 1 + documented divergences)", () => {
  it("own-changes-only: A's undo never touches B's independent entity", () => {
    const a = makeAttached(1);
    const b = makeAttached(2);
    a.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    settle(a, b);
    b.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 2, y: 2 }]] }));
    settle(a, b);

    expect(a.store.canUndo()).toBe(true);
    expect(b.store.canUndo()).toBe(true);
    a.store.undo(); // reverts A's spawn ONLY
    settle(a, b);

    expect(a.store.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(b.store.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(a.store.snapshot.hasEntity(K("2-0"))).toBe(true); // B's entity untouched
    expect(b.store.snapshot.hasEntity(K("2-0"))).toBe(true);
    // and B's stack is unaffected by A's undo arriving as a remote batch
    expect(b.store.canUndo()).toBe(true);
  });

  it("divergence pin: undoing a value edit re-asserts pre-op state as NEWEST, clobbering a causally-newer remote write", () => {
    const a = makeAttached(1);
    const b = makeAttached(2);
    const h = a.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 0, y: 0 }]] }));
    const key = a.store.keyOf(h)!;
    settle(a, b);
    a.store.transaction((tx) => tx.edit(a.store.resolve(key)!).set(HPos, { x: 1, y: 1 }));
    settle(a, b);
    b.store.transaction((tx) => tx.edit(b.store.resolve(key)!).set(HPos, { x: 2, y: 2 })); // causally NEWER
    settle(a, b);
    expect(a.store.getComponent(a.store.resolve(key)!, HPos)).toEqual({ x: 2, y: 2 });

    a.store.undo(); // reverts A's x:1 edit → re-asserts x:0 as the newest op
    settle(a, b);
    expect(a.store.getComponent(a.store.resolve(key)!, HPos)).toEqual({ x: 0, y: 0 });
    expect(b.store.getComponent(b.store.resolve(key)!, HPos)).toEqual({ x: 0, y: 0 }); // B's 2 clobbered — converged
  });

  it("divergence pin: undoing a spawn takes a peer's later component with it (converged everywhere)", () => {
    const a = makeAttached(1);
    const b = makeAttached(2);
    a.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    settle(a, b);
    const hb = b.store.resolve(K("1-0"))!;
    b.store.transaction((tx) => tx.addComponent(hb, HFill, { v: 7 })); // B builds on A's entity
    settle(a, b);
    expect(a.store.getComponentByKey(K("1-0"), HFill)).toEqual({ v: 7 });

    a.store.undo(); // A reverts its spawn — B's later component goes with the entity
    settle(a, b);
    expect(a.store.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(b.store.snapshot.hasEntity(K("1-0"))).toBe(false);
  });

  it("attached reversal lands at the NEXT world.sync(), not synchronously", () => {
    const { store, world } = makeAttached(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    world.sync();
    const key = store.keyOf(h)!;
    expect(store.resolve(key)).toBeDefined();

    store.undo();
    expect(store.snapshot.hasEntity(key)).toBe(false); // the DOCUMENT reverted immediately…
    expect(store.resolve(key)).toBeDefined(); // …but the runtime holds until the next sync
    world.sync();
    expect(store.resolve(key)).toBeUndefined();
  });

  it("pins loro behavior: a remote import does NOT clear the local redo stack", () => {
    const a = makeAttached(1);
    const b = makeAttached(2);
    a.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    a.store.undo();
    expect(a.store.canRedo()).toBe(true);
    b.store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 2, y: 2 }]] }));
    settle(a, b); // B's commit arrives at A as a remote import
    expect(a.store.canRedo()).toBe(true); // remote arrivals are not "new local edits" — redo survives
    expect(a.store.redo()).toBe(true);
    settle(a, b);
    expect(b.store.snapshot.hasEntity(K("1-0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("selection metadata hooks (rule 5)", () => {
  it("capture/restore roundtrip with correct stack labels", () => {
    const s = makeStore(1);
    const log: string[] = [];
    let selection = "sel-A";
    s.setHistoryHooks({
      capture: (stack) => {
        log.push(`capture:${stack}:${selection}`);
        return selection;
      },
      restore: (value, stack) => {
        log.push(`restore:${stack}:${String(value)}`);
      },
    });

    s.snapshot.commit(() => s.snapshot.spawn(K("1-0"))); // push undo step, selection sel-A
    selection = "sel-B"; // the user selected something else since
    s.undo(); // pop undo (restore sel-A) FIRST, then push the inverse onto redo (capture sel-B)
    s.redo(); // pop redo (restore sel-B) first, then push back onto undo (capture current)

    // Pins loro 1.13's pop-then-push ordering — restore always fires before the same call's capture.
    expect(log).toEqual([
      "capture:undo:sel-A",
      "restore:undo:sel-A",
      "capture:redo:sel-B",
      "restore:redo:sel-B",
      "capture:undo:sel-B",
    ]);
  });

  it("hooks may not re-enter the document — undo() from restore throws into the hook", () => {
    const s = makeStore(1);
    let seen: unknown = null;
    s.setHistoryHooks({
      restore: () => {
        try {
          s.undo();
        } catch (err) {
          seen = err;
        }
      },
    });
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    s.undo();
    expect(String(seen)).toMatch(/history hook/);
  });

  it("a throwing capture hook is isolated — the commit and the step both land", () => {
    const s = makeStore(1);
    s.setHistoryHooks({
      capture: () => {
        throw new Error("app bug");
      },
    });
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(true);
    expect(s.canUndo()).toBe(true);
    expect(s.undo()).toBe(true); // the step is intact, its metadata just null
  });
});

// ---------------------------------------------------------------------------------------------------
describe("guards", () => {
  it("undo/redo/clearHistory/undoGroup inside doc.transaction throw", () => {
    const { store } = makeAttached(1);
    store.transaction((tx) => {
      tx.spawn();
      expect(() => store.undo()).toThrow(/inside doc.transaction/);
      expect(() => store.redo()).toThrow(/inside doc.transaction/);
      expect(() => store.clearHistory()).toThrow(/inside doc.transaction/);
      expect(() => store.undoGroup(() => {})).toThrow(/inside doc.transaction/);
    });
  });

  it("undo/redo during an adapter commit scope throw", () => {
    const s = makeStore(1);
    s.snapshot.commit(() => {
      expect(() => s.undo()).toThrow(/during commit/);
      expect(() => s.redo()).toThrow(/during commit/);
    });
  });

  it("a quarantined store refuses undo/redo (PendingImportError) but allows clearHistory", () => {
    const src = makeStore(1);
    src.snapshot.commit(() => src.snapshot.spawn(K("1-0")));
    const v1 = src.snapshot.version();
    src.snapshot.commit(() => src.snapshot.spawn(K("1-1")));
    const laterHalf = src.snapshot.exportUpdatesSince(v1); // increment missing its causal base

    const s = makeStore(2);
    s.snapshot.commit(() => s.snapshot.spawn(K("2-0"))); // give it a real undo stack first
    expect(() => s.applyRemote(laterHalf)).toThrow(PendingImportError);
    expect(() => s.undo()).toThrow(PendingImportError);
    expect(() => s.redo()).toThrow(PendingImportError);
    expect(() => s.clearHistory()).not.toThrow(); // cleanup path stays open
  });
});

// ---------------------------------------------------------------------------------------------------
describe("DurableUndoStatus + detach (plan-undo U2)", () => {
  it("publishes reactively while attached; removed at detach; store methods survive detach", () => {
    const { store, world, att } = makeAttached(1);
    expect(world.getResource(DurableUndoStatus)).toEqual({ canUndo: false, canRedo: false });

    store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    expect(world.getResource(DurableUndoStatus)).toEqual({ canUndo: true, canRedo: false });

    store.undo();
    expect(world.getResource(DurableUndoStatus)).toEqual({ canUndo: false, canRedo: true });

    att.detach();
    expect(world.getResource(DurableUndoStatus)).toBeUndefined();
    // history lives on the store (its doc), not the attachment — the stacks survive detach
    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.snapshot.hasEntity(K("1-0"))).toBe(true);
  });

  it("history spans re-attach: a step from the first attachment undoes under the second", () => {
    const { store, att } = makeAttached(1);
    store.transaction((tx) => tx.spawn({ components: [[HPos, { x: 1, y: 1 }]] }));
    att.detach();

    const world2 = createWorld();
    attachDurable(world2, store);
    world2.sync();
    expect(store.resolve(K("1-0"))).toBeDefined(); // re-projected under the new world

    expect(store.undo()).toBe(true);
    world2.sync();
    expect(store.resolve(K("1-0"))).toBeUndefined();
    expect(world2.getResource(DurableUndoStatus)?.canRedo).toBe(true);
  });
});

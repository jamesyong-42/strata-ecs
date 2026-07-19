/**
 * S3 — lazy UndoManager (the join-wall fix): the COMMITTED pin file.
 *
 * ROOT CAUSE (attribution 2026-07-19, docs/plan-petitions-s2-s4.md): loro's UndoManager × a pre-import
 * divergent local commit (strata's construction docId write) makes `doc.import` super-linear — a joiner's
 * bootstrap wall. THE FIX (shipped): the adapter constructs its `UndoManager` LAZILY — not in the
 * `LoroSnapshot` constructor, but at the first UNDOABLE local commit (or the first `beginUndoGroup`) — so a
 * pristine joiner's bootstrap import runs manager-free.
 *
 * WHAT LIVES HERE:
 *  A1 construction order (raw loro) — a manager constructed BEFORE ops are staged tracks the commit (the
 *     adapter's commit() entry point suffices); the after-staging case is pinned too, for the map.
 *  A2 lazy semantics (raw loro) — a manager constructed AFTER prior local commits + a big import: prior
 *     commits are NOT undoable (equivalent to strata's semantics — the first undoable commit is what
 *     constructs it), new commits are, and excludeOriginPrefixes are respected post-construction.
 *  + adapter-behavior pins — that the LoroSnapshot constructs the manager at exactly (and only) the two
 *     triggers, is nullable-safe everywhere else, and stays semantically identical to the old eager build.
 *
 * NO TIMING ASSERTIONS. The A3 (perf gate) and A4 (mid-session increment) measurements that GATED this
 * change proved process-state-unstable — pristine-fast was reproduced every run, but the exact
 * per-ingredient splits were not — so the numbers live in docs/plan-petitions-s2-s4.md (docs-local), never
 * in the default suite. The one durable fact the suite pins is CONSTRUCTION TIMING (manager-free until a
 * real undoable action), which is deterministic; the speedup it buys is not asserted here.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc, UndoManager } from "loro-crdt";
import { defineComponent, entityKey } from "../core";
import { createDurableStore } from "./durable-store";

const MPos = defineComponent("S3MPos", { x: "f32", y: "f32" });
const MSize = defineComponent("S3MSize", { w: "f32", h: "f32" });
const MFill = defineComponent("S3MFill", { r: "u8", g: "u8", b: "u8" });

function makeSeedSnapshot(n: number): { bytes: Uint8Array; version: ReturnType<LoroDoc["version"]> } {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  const store = createDurableStore(doc);
  const s = store.snapshot;
  s.commit(() => {
    for (let i = 0; i < n; i++) {
      const k = entityKey(`1-${i}`);
      s.spawn(k);
      s.setComponent(k, MPos, { x: i, y: i });
      s.setComponent(k, MSize, { w: 10, h: 10 });
      s.setComponent(k, MFill, { r: 1, g: 2, b: 3 });
    }
  });
  return { bytes: s.export(), version: doc.version() };
}

const UM_OPTS = {
  mergeInterval: 0,
  maxUndoSteps: 100,
  excludeOriginPrefixes: ["strata-meta", "strata-nonundoable"],
};

const K = (s: string) => entityKey(s);

function store(peerId: number, opts?: { maxUndoSteps?: number }) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc, opts);
}

describe("S3 — lazy UndoManager loro-semantics probes", () => {
  it("A1: a manager constructed before doc.commit() tracks the commit — staged-ops order pinned", () => {
    // Case Y (the adapter's shape): construct at commit entry, BEFORE ops are staged.
    const y = new LoroDoc();
    y.setPeerId(2);
    const umY = new UndoManager(y, UM_OPTS);
    y.getMap("m").set("k", 1);
    y.commit();
    y.getMap("m").set("k", 2);
    y.commit();
    expect(umY.canUndo()).toBe(true);
    expect(umY.undo()).toBe(true);
    expect(y.getMap("m").get("k")).toBe(1);

    // Case X: ops ALREADY STAGED (uncommitted) when the manager is constructed, then commit.
    const x = new LoroDoc();
    x.setPeerId(3);
    x.getMap("m").set("k", 1);
    x.commit(); // a pre-manager baseline commit
    x.getMap("m").set("k", 2); // staged, uncommitted
    const umX = new UndoManager(x, UM_OPTS);
    x.commit();
    // PIN whichever way loro behaves — the adapter constructs at commit() entry BEFORE staging, so
    // either outcome is compatible; the pin just keeps the fact from drifting silently.
    const tracked = umX.canUndo() && umX.undo() === true;
    const after = x.getMap("m").get("k");
    console.log(`A1 case X (construct after staging): tracked=${tracked} valueAfterUndo=${after}`);
    if (tracked) expect(after).toBe(1);
    else expect(after).toBe(2);
  });

  it("A2: lazy construction after prior commits + a big import — prior local commits not undoable; new ones are; excluded origins respected", () => {
    const { bytes } = makeSeedSnapshot(1_000);

    const doc = new LoroDoc();
    doc.setPeerId(4);
    doc.getMap("meta").set("docId", "lazy-probe"); // the construction docId commit (pre-manager)
    doc.commit({ origin: "strata-meta:construction" });
    doc.import(bytes); // bootstrap, manager-free

    const um = new UndoManager(doc, UM_OPTS); // ← the lazy construction moment

    // Nothing before construction is undoable — the stacks start empty.
    expect(um.canUndo()).toBe(false);
    expect(um.canRedo()).toBe(false);

    // A new plain local commit is undoable…
    doc.getMap("m").set("a", 1);
    doc.commit();
    expect(um.canUndo()).toBe(true);

    // …an excluded-origin commit pushes nothing (and does not clear redo).
    expect(um.undo()).toBe(true);
    expect(um.canRedo()).toBe(true);
    doc.getMap("meta").set("aux", 1);
    doc.commit({ origin: "strata-meta:aux" });
    expect(um.canRedo()).toBe(true); // excluded origin left the redo stack alone
    expect(um.redo()).toBe(true);
    expect(doc.getMap("m").get("a")).toBe(1);
  });
});

describe("S3 — lazy UndoManager adapter behavior (LoroSnapshot construction timing)", () => {
  it("a freshly constructed store has NO manager — the docId meta commit does not build one", () => {
    const s = store(1);
    // createDurableStore seals the docId write (META_ORIGIN) at construction — it must not construct the
    // manager (that seal is excluded from undo anyway).
    expect(s.snapshot.hasUndoManagerForTest).toBe(false);
  });

  it("a joiner's bootstrap applyRemote imports manager-free", () => {
    const src = store(1);
    src.snapshot.commit(() => {
      src.snapshot.spawn(K("1-0"));
      src.snapshot.setComponent(K("1-0"), MPos, { x: 1, y: 2 });
    });

    const joiner = store(2);
    joiner.snapshot.applyRemote(src.snapshot.export());
    expect(joiner.snapshot.hasEntity(K("1-0"))).toBe(true); // the snapshot landed…
    expect(joiner.snapshot.hasUndoManagerForTest).toBe(false); // …with no manager attached
  });

  it("every history reader/writer before the first undoable commit is a no-op and constructs nothing", () => {
    const s = store(1);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.undo()).toBe(false);
    expect(s.redo()).toBe(false);
    expect(() => s.clearHistory()).not.toThrow(); // empty stacks → true no-op
    expect(s.snapshot.hasUndoManagerForTest).toBe(false);
  });

  it("the first undoable commit constructs the manager and that commit is undoable", () => {
    const s = store(1);
    expect(s.snapshot.hasUndoManagerForTest).toBe(false);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    expect(s.snapshot.hasUndoManagerForTest).toBe(true);
    expect(s.canUndo()).toBe(true);
    expect(s.undo()).toBe(true); // the first undoable commit reverts — it WAS tracked (A1 case Y)
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
  });

  it("a store that only ever does non-undoable commits + metaTransaction NEVER constructs a manager", () => {
    const s = store(1);
    // The exact seam the M3 executor uses for a non-undoable transaction: snapshot.commit(body, {undoable:false}).
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")), { undoable: false });
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1")), { undoable: false });
    s.metaTransaction((m) => m.set("engine.schema", 3)); // an embedder metadata stamp (META_ORIGIN)
    expect(s.snapshot.hasUndoManagerForTest).toBe(false);
    expect(s.canUndo()).toBe(false);
    // The document still holds everything — non-undoability is a local-undo concern only.
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(true);
    expect(s.snapshot.hasEntity(K("1-1"))).toBe(true);
  });

  it("history hooks installed BEFORE construction fire on the first push and ride the undo (multiplex survives lazy build)", () => {
    const s = store(1);
    const log: string[] = [];
    s.setHistoryHooks({
      capture: (stack) => {
        log.push(`capture:${stack}`);
        return "sel";
      },
      restore: (value, stack) => {
        log.push(`restore:${stack}:${String(value)}`);
      },
    });
    // Hooks are held on the adapter, not the manager — installing them constructs nothing.
    expect(s.snapshot.hasUndoManagerForTest).toBe(false);

    s.snapshot.commit(() => s.snapshot.spawn(K("1-0"))); // first push → capture fires for the undo stack
    expect(log).toEqual(["capture:undo"]);

    expect(s.undo()).toBe(true); // pop-then-push: restore the undo step, then capture the redo step
    expect(log).toEqual(["capture:undo", "restore:undo:sel", "capture:redo"]);
  });

  it("beginUndoGroup as the very first history action constructs at groupStart and collapses to one step", () => {
    const s = store(1);
    s.snapshot.beginUndoGroup();
    expect(s.snapshot.hasUndoManagerForTest).toBe(true); // constructed at groupStart, before any commit
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1")));
    s.snapshot.endUndoGroup();

    expect(s.undo()).toBe(true); // one step reverts BOTH commits
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(s.snapshot.hasEntity(K("1-1"))).toBe(false);
    expect(s.canUndo()).toBe(false); // exactly one step existed
  });

  it("maxUndoSteps is honored on the lazy construction", () => {
    const s = store(1, { maxUndoSteps: 2 });
    for (let i = 0; i < 3; i++) s.snapshot.commit(() => s.snapshot.spawn(K(`1-${i}`)));
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.undo()).toBe(false); // capped at 2 — the oldest step evicted before construction's options applied
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(true); // …so the first spawn survives undo-all
  });
});

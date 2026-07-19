/**
 * M0 PROBE (plan-ordered-relations §7): pin the loro-crdt MovableList facts the ordered-relations
 * design depends on, BEFORE any implementation exists. Two of these were GO/NO-GO for the design;
 * both came back GO — this file is the pin so a loro upgrade that shifts any load-bearing fact
 * fails loudly here first.
 *
 * Observed truths pinned (loro-crdt 1.13.x, 2026-07-19):
 *
 *   A — COUNTER SPANS (GO/NO-GO 1, feeds the `frontierAfter` fix): the adapter's map-only
 *       assumption ("`change.ops.length` is exactly the span", loro-snapshot.ts:930-936) is
 *       FALSE once MovableList ops exist. Contiguous inserts MERGE into one op whose `value` is
 *       an ARRAY (always an array — a single insert is `["x"]`; inserting an array-valued
 *       element nests). Span rule, verified against consecutive op counters and the frontier
 *       tip: insert → value.length · delete → len · move → 1 · set → 1 · map ops → 1.
 *
 *   B — DIFF VISIBILITY (GO/NO-GO 2, feeds 005-amendment translation): a PURE-reorder commit
 *       yields exactly ONE `doc.diff` pair — the list container, type "list", path
 *       ["entities", <key>, "relO:*"] (length 3) — so order-invalidation cells are cheaply
 *       derivable. Container creation yields the parent map pair (updated: {"relO:*"}) PLUS the
 *       list pair carrying the initial inserts. A MovableList `move` surfaces in diffs as
 *       delete+insert deltas (no move delta kind exists).
 *
 *   C — CONCURRENCY: native move-vs-move converges with the element appearing ONCE (no dup);
 *       delete+insert EMULATION of a move duplicates the element under a concurrent native move
 *       (why reorders MUST seal as native `move` — P8.7); a moved element SURVIVES a concurrent
 *       delete (move wins — a despawn-prune racing a reorder leaves a stale entry: harmless, the
 *       D7 read filter drops it); concurrent same-destination reparent produces a DUPLICATE
 *       entry inside ONE list (why D7 dedupes); concurrent same-anchor inserts converge without
 *       item interleaving (single items).
 *
 *   E — UNDO (adapter options: mergeInterval 0, excludeOriginPrefixes): undo-of-move reverts
 *       only the move; a reparent tx (edge set + two list touches, one commit) reverts
 *       ATOMICALLY; excluded-origin list ops survive undo of an earlier step; undo of the
 *       commit that CREATED the list container DELETES the container (the finding-9 residual's
 *       sibling — same shape as undo-of-spawn, pinned in undo-container.probe.test.ts) and a
 *       concurrent remote insert into that list is LOST — but every peer AND a fresh joiner
 *       converge on the loss, and redo restores the container with its entries.
 *
 *   G — QUARANTINE: an out-of-causal-order list increment imports with `pending` non-null,
 *       exactly like map increments — the PendingImportError path needs no list-specific work.
 *
 *   F — COST (loose bounds; actuals logged): 10k-entry list ≈ 81KB snapshot / ~2ms import;
 *       one move exports ≈ 85B; clearing 10k entries (the despawn shape) keeps the emptied
 *       list importable and roughly halves the snapshot.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc, LoroMap, LoroMovableList, UndoManager } from "loro-crdt";

const ADAPTER_UNDO_OPTS = {
  mergeInterval: 0,
  maxUndoSteps: 100,
  excludeOriginPrefixes: ["strata-meta", "strata-nonundoable"],
};

/** entities → P (map) → relO:C (movable list); returns the list. */
function mintList(doc: LoroDoc, parent = "P"): LoroMovableList {
  return doc
    .getMap("entities")
    .setContainer(parent, new LoroMap())
    .setContainer("relO:C", new LoroMovableList());
}

function listOf(doc: LoroDoc, parent = "P"): LoroMovableList | undefined {
  const p = doc.getMap("entities").get(parent) as LoroMap | undefined;
  return p?.get("relO:C") as LoroMovableList | undefined;
}

/** Two docs seeded with the same P→[x,y,z] list; b imported a's snapshot. */
function seededPair(): { a: LoroDoc; b: LoroDoc; la: LoroMovableList; lb: LoroMovableList } {
  const a = new LoroDoc();
  a.setPeerId(10);
  const la = mintList(a);
  ["x", "y", "z"].forEach((s, i) => la.insert(i, s));
  a.commit();
  const b = new LoroDoc();
  b.setPeerId(11);
  b.import(a.export({ mode: "snapshot" }));
  const lb = listOf(b) as LoroMovableList;
  return { a, b, la, lb };
}

function converge(a: LoroDoc, b: LoroDoc): void {
  a.import(b.export({ mode: "update" }));
  b.import(a.export({ mode: "update" }));
}

/** The span rule frontierAfter must adopt (sum per-op, NOT ops.length). */
function opSpan(content: Record<string, unknown>): number {
  if (content.type === "insert" && Array.isArray(content.value)) return content.value.length;
  if (content.type === "delete") return content.len as number;
  return 1; // map insert/delete, movable move, movable set
}

describe("M0 probe A — counter spans (GO/NO-GO 1)", () => {
  it("MovableList ops break the ops.length==span assumption; the per-op rule reproduces every counter", () => {
    const doc = new LoroDoc();
    doc.setPeerId(1);
    const list = mintList(doc);
    list.insert(0, "a");
    list.insert(1, "b");
    list.insert(2, "c"); // merges → one insert op, value ["a","b","c"], span 3
    list.delete(0, 2); // span 2
    list.insert(1, "d");
    list.insert(2, "e"); // merges → span 2
    list.move(2, 0); // span 1
    list.set(0, "e2"); // span 1
    doc.commit();

    const changes = doc.exportJsonUpdates().changes;
    expect(changes.length).toBe(1);
    const ops = changes[0]!.ops;

    // The falsified assumption: 7 ops, 11 counters.
    const total = ops.reduce((n, op) => n + opSpan(op.content as Record<string, unknown>), 0);
    expect(ops.length).toBe(7);
    expect(total).toBe(11);
    expect(total).not.toBe(ops.length);

    // The rule is exact: each op starts where the previous one's span ends…
    for (let i = 1; i < ops.length; i++) {
      const prev = ops[i - 1]!;
      expect(ops[i]!.counter).toBe(prev.counter + opSpan(prev.content as Record<string, unknown>));
    }
    // …and the frontier tip is first-counter + total span − 1.
    const tip = doc.frontiers()[0]!;
    expect(tip.counter).toBe(ops[0]!.counter + total - 1);
  });

  it("insert `value` is ALWAYS an array — singletons wrap, array-valued elements nest", () => {
    const doc = new LoroDoc();
    doc.setPeerId(2);
    const list = mintList(doc);
    list.insert(0, "solo");
    list.insert(1, ["nested", "array"]); // ONE element whose value is an array
    doc.commit();
    const ops = doc.exportJsonUpdates().changes.flatMap((c) => c.ops);
    const insert = ops.find((o) => (o.content as { type: string; pos?: number }).type === "insert" && "pos" in o.content)!;
    const value = (insert.content as { value: unknown[] }).value;
    expect(value).toEqual(["solo", ["nested", "array"]]); // 2 elements → span 2
    expect(opSpan(insert.content as Record<string, unknown>)).toBe(2);
  });
});

describe("M0 probe B — diff visibility (GO/NO-GO 2)", () => {
  it("a pure-reorder commit is ONE list-diff pair at the relO: path; creation is map-pair + list-pair", () => {
    const doc = new LoroDoc();
    doc.setPeerId(3);
    const P = doc.getMap("entities").setContainer("P", new LoroMap());
    doc.commit();
    const f0 = doc.frontiers();

    const list = P.setContainer("relO:C", new LoroMovableList());
    ["a", "b", "c"].forEach((s, i) => list.insert(i, s));
    doc.commit();
    const f1 = doc.frontiers();

    list.move(2, 0);
    doc.commit();
    const f2 = doc.frontiers();

    // Creation commit: parent-map pair (updated: relO:C) + list pair (initial inserts).
    const creation = doc.diff(f0, f1, false);
    expect(creation.length).toBe(2);
    const mapPair = creation.find(([, d]) => d.type === "map")!;
    const listPair = creation.find(([, d]) => d.type === "list")!;
    expect(Object.keys((mapPair[1] as { updated: Record<string, unknown> }).updated)).toEqual(["relO:C"]);
    expect(doc.getPathToContainer(listPair[0])).toEqual(["entities", "P", "relO:C"]);

    // Pure reorder: exactly one pair, list-typed, path length 3 — the order-invalidation source.
    const reorder = doc.diff(f1, f2, false);
    expect(reorder.length).toBe(1);
    const [cid, diff] = reorder[0]!;
    expect(diff.type).toBe("list");
    expect(doc.getPathToContainer(cid)).toEqual(["entities", "P", "relO:C"]);

    // A move has NO move-delta — it surfaces as insert + delete around a retain.
    const kinds = (diff as { diff: Record<string, unknown>[] }).diff.flatMap((d) => Object.keys(d));
    expect(kinds).toContain("insert");
    expect(kinds).toContain("delete");
  });
});

describe("M0 probe C — concurrent order semantics", () => {
  it("native move vs native move: converges, element appears exactly once", () => {
    const { a, b, la, lb } = seededPair();
    la.move(0, 2);
    a.commit();
    lb.move(0, 1);
    b.commit();
    converge(a, b);
    expect(la.toArray()).toEqual(lb.toArray());
    expect(la.toArray().filter((v) => v === "x").length).toBe(1);
    expect(la.toArray()).toEqual(["y", "x", "z"]); // pinned 1.13.x outcome
  });

  it("delete+insert EMULATION duplicates under a concurrent native move — reorders must seal as native move (P8.7)", () => {
    const { a, b, la, lb } = seededPair();
    la.move(0, 2); // native
    a.commit();
    lb.delete(0, 1); // emulated "move"
    lb.insert(1, "x");
    b.commit();
    converge(a, b);
    expect(la.toArray()).toEqual(lb.toArray());
    expect(la.toArray().filter((v) => v === "x").length).toBe(2); // the duplication
  });

  it("move vs delete: the MOVE wins — the element survives (stale-entry filter territory, not corruption)", () => {
    const { a, b, la, lb } = seededPair();
    la.move(0, 2);
    a.commit();
    lb.delete(0, 1);
    b.commit();
    converge(a, b);
    expect(la.toArray()).toEqual(lb.toArray());
    expect(la.toArray()).toEqual(["y", "z", "x"]); // pinned: survives at the move destination
  });

  it("concurrent same-destination reparent duplicates WITHIN one list — D7 dedupe is mandatory", () => {
    const a = new LoroDoc();
    a.setPeerId(20);
    const e = a.getMap("entities");
    const p1 = e.setContainer("P1", new LoroMap()).setContainer("relO:C", new LoroMovableList());
    e.setContainer("P2", new LoroMap()).setContainer("relO:C", new LoroMovableList());
    p1.insert(0, "x");
    a.commit();
    const b = new LoroDoc();
    b.setPeerId(21);
    b.import(a.export({ mode: "snapshot" }));

    const move = (doc: LoroDoc) => {
      (listOf(doc, "P1") as LoroMovableList).delete(0, 1);
      (listOf(doc, "P2") as LoroMovableList).insert(0, "x");
      doc.commit();
    };
    move(a);
    move(b);
    converge(a, b);
    expect((listOf(a, "P2") as LoroMovableList).toArray()).toEqual(["x", "x"]);
    expect((listOf(b, "P2") as LoroMovableList).toArray()).toEqual(["x", "x"]);
    expect((listOf(a, "P1") as LoroMovableList).toArray()).toEqual([]);
  });

  it("concurrent inserts at the same anchor converge identically on both peers", () => {
    const { a, b, la, lb } = seededPair();
    la.insert(1, "a1");
    a.commit();
    lb.insert(1, "b1");
    b.commit();
    converge(a, b);
    expect(la.toArray()).toEqual(lb.toArray());
    expect(la.toArray()).toEqual(["x", "a1", "b1", "y", "z"]); // pinned 1.13.x outcome
  });
});

describe("M0 probe E — undo over MovableList (adapter options)", () => {
  it("undo-of-move reverts only the move; undo-of-creation deletes the container; redo restores it WITH entries", () => {
    const doc = new LoroDoc();
    doc.setPeerId(30);
    const P = doc.getMap("entities").setContainer("P", new LoroMap());
    doc.commit();
    const undo = new UndoManager(doc, ADAPTER_UNDO_OPTS);

    const list = P.setContainer("relO:C", new LoroMovableList());
    list.insert(0, "a");
    list.insert(1, "b");
    doc.commit();
    list.move(1, 0);
    doc.commit();
    expect(list.toArray()).toEqual(["b", "a"]);

    undo.undo();
    expect((listOf(doc) as LoroMovableList).toArray()).toEqual(["a", "b"]); // move only

    undo.undo(); // the creation commit — finding-9 sibling: the container GOES AWAY
    expect((doc.getMap("entities").get("P") as LoroMap).keys()).toEqual([]);

    undo.redo();
    expect((listOf(doc) as LoroMovableList).toArray()).toEqual(["a", "b"]); // returns with entries
  });

  it("a reparent tx (edge + two list touches, ONE commit) reverts atomically", () => {
    const doc = new LoroDoc();
    doc.setPeerId(31);
    const e = doc.getMap("entities");
    const P1 = e.setContainer("P1", new LoroMap());
    const P2 = e.setContainer("P2", new LoroMap());
    const X = e.setContainer("X", new LoroMap());
    const l1 = P1.setContainer("relO:C", new LoroMovableList());
    const l2 = P2.setContainer("relO:C", new LoroMovableList());
    X.set("rel1:ChildOf", "P1");
    l1.insert(0, "X");
    doc.commit();
    const undo = new UndoManager(doc, ADAPTER_UNDO_OPTS);

    X.set("rel1:ChildOf", "P2");
    l1.delete(0, 1);
    l2.insert(0, "X");
    doc.commit();

    undo.undo();
    expect(X.get("rel1:ChildOf")).toBe("P1");
    expect(l1.toArray()).toEqual(["X"]);
    expect(l2.toArray()).toEqual([]);
  });

  it("excluded-origin list ops survive an undo of an earlier step", () => {
    const doc = new LoroDoc();
    doc.setPeerId(32);
    const list = mintList(doc);
    list.insert(0, "a");
    doc.commit();
    const undo = new UndoManager(doc, ADAPTER_UNDO_OPTS);

    list.insert(1, "undoable");
    doc.commit();
    list.insert(2, "janitorial");
    doc.commit({ origin: "strata-nonundoable" });

    undo.undo();
    expect(list.toArray()).toEqual(["a", "janitorial"]);
  });

  it("undo-of-creation vs a concurrent remote insert: the insert is LOST but every peer and a fresh joiner CONVERGE", () => {
    const a = new LoroDoc();
    a.setPeerId(33);
    const Pa = a.getMap("entities").setContainer("P", new LoroMap());
    a.commit();
    const undoA = new UndoManager(a, ADAPTER_UNDO_OPTS);
    const la = Pa.setContainer("relO:C", new LoroMovableList());
    la.insert(0, "a1");
    a.commit();

    const b = new LoroDoc();
    b.setPeerId(34);
    b.import(a.export({ mode: "snapshot" }));
    (listOf(b) as LoroMovableList).insert(1, "b1"); // concurrent with A's undo
    b.commit();
    undoA.undo();
    converge(a, b);

    const viewOf = (doc: LoroDoc) => {
      const p = doc.getMap("entities").get("P") as LoroMap;
      return { keys: p.keys(), list: (p.get("relO:C") as LoroMovableList | undefined)?.toArray() ?? null };
    };
    const fresh = new LoroDoc();
    fresh.setPeerId(35);
    fresh.import(a.export({ mode: "snapshot" }));

    expect(viewOf(a)).toEqual({ keys: [], list: null });
    expect(viewOf(b)).toEqual(viewOf(a));
    expect(viewOf(fresh)).toEqual(viewOf(a));
  });
});

describe("M0 probe G — pending import", () => {
  it("an out-of-causal-order list increment goes pending, exactly like map increments", () => {
    const a = new LoroDoc();
    a.setPeerId(40);
    const list = mintList(a);
    list.insert(0, "a");
    a.commit();
    const base = a.export({ mode: "snapshot" });
    const v1 = a.version();
    list.insert(1, "mid");
    a.commit();
    const v2 = a.version();
    list.insert(2, "tip");
    a.commit();
    const updMid = a.export({ mode: "update", from: v1 });
    const updTip = a.export({ mode: "update", from: v2 });

    const fresh = new LoroDoc();
    fresh.setPeerId(41);
    expect(fresh.import(updTip).pending).not.toBeNull(); // the quarantine trigger
    expect(fresh.import(base).pending).toBeNull();
    expect(fresh.import(updMid).pending).toBeNull(); // unlocks the buffered tip
    expect((listOf(fresh) as LoroMovableList).toArray()).toEqual(["a", "mid", "tip"]);
  });
});

describe("M0 probe F — cost shape (loose bounds; actuals logged)", () => {
  it("10k-entry list: snapshot/import/one-move-update stay small; the despawn clear keeps the list importable", () => {
    const doc = new LoroDoc();
    doc.setPeerId(50);
    const list = mintList(doc);
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) list.insert(i, `50-${i}`);
    doc.commit();
    const snap = doc.export({ mode: "snapshot" });
    const t1 = performance.now();
    const fresh = new LoroDoc();
    fresh.setPeerId(51);
    fresh.import(snap);
    const t2 = performance.now();

    const vPre = doc.version();
    list.move(9_999, 0);
    doc.commit();
    const moveBytes = doc.export({ mode: "update", from: vPre }).byteLength;

    list.delete(0, list.length); // the despawn shape: entries cleared, container kept
    doc.commit();
    const cleared = doc.export({ mode: "snapshot" });
    const fresh2 = new LoroDoc();
    fresh2.setPeerId(52);
    fresh2.import(cleared);
    expect((listOf(fresh2) as LoroMovableList).toArray()).toEqual([]);

    console.info(
      `[m0-cost] build+snapshot=${(t1 - t0).toFixed(0)}ms snapshot=${(snap.byteLength / 1024).toFixed(0)}KB ` +
        `import=${(t2 - t1).toFixed(0)}ms one-move-update=${moveBytes}B cleared-snapshot=${(cleared.byteLength / 1024).toFixed(0)}KB`,
    );
    expect(snap.byteLength).toBeLessThan(1_000_000); // observed ~81KB
    expect(t2 - t1).toBeLessThan(1_500); // observed ~2ms
    expect(moveBytes).toBeLessThan(4_096); // observed ~85B
    expect((listOf(fresh) as LoroMovableList).length).toBe(10_000);
  });
});

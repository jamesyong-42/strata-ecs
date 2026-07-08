/**
 * U0 PROBE (plan-undo): does undo-of-spawn re-open the finding-9 container-delete holes?
 *
 * The adapter's no-delete layout guarantees containers are minted once and never deleted — but
 * `undo()` inverts a spawn commit's `setContainer`, deleting the per-entity container. Two candidate
 * failures (finding 9 a/b analogs), probed here at the store/adapter level:
 *
 *   P1 — CONCURRENT peer set vs undo-of-spawn: B sets a cell on X concurrently with A undoing X's
 *        spawn. If B's op is orphaned inside the deleted container with NO removal fact, B's view
 *        (and any attached world) diverges from A and from a fresh joiner — permanently.
 *   P2 — BUFFERED replay: a receiver importing [spawn+set][set2][undo] in ONE applyRemote buffer
 *        translates per-commit against the post-import head; if the container is deleted at head,
 *        earlier commits' facts drop (`getPathToContainer`), and the batch stream a world would
 *        apply disagrees with the doc.
 *   P3 — redo-of-undone-spawn: does the container return, and does a peer's concurrent cell land?
 *
 * These start as INVESTIGATION probes (they print the observed truth); the assertions pin
 * convergence properties that MUST hold for a public undo API. If they fail, the pre-mint fix
 * (plan-undo U1) is required and these become its regression tests.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { entityKey } from "../core";
import { defineComponent } from "../core";
import { createDurableStore } from "./durable-store";
import type { ChangeBatch } from "../substrate/types";

const UPPos = defineComponent("UPPos", { x: "f32", y: "f32" });
const UPHealth = defineComponent("UPHealth", { hp: "f32" });

const K = (s: string) => entityKey(s);

function store(peerId: number) {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/** Converged doc-level view of one entity, for cross-peer comparison. */
function view(s: ReturnType<typeof createDurableStore>, key: string) {
  return {
    has: s.snapshot.hasEntity(K(key)),
    pos: s.snapshot.getComponent(K(key), UPPos),
    hp: s.snapshot.getComponent(K(key), UPHealth),
  };
}

describe("U0 probe — undo-of-spawn vs the no-delete container invariant", () => {
  it("P1: concurrent remote set vs undo-of-spawn — all peers and a fresh joiner converge to the same view", () => {
    const a = store(1);
    const b = store(2);
    const X = "1-0";

    // A spawns X (one undoable commit: spawn + initial component).
    a.snapshot.commit(() => {
      a.snapshot.spawn(K(X));
      a.snapshot.setComponent(K(X), UPPos, { x: 1, y: 2 });
    });
    b.snapshot.applyRemote(a.snapshot.export());
    expect(view(b, X).has).toBe(true);

    // CONCURRENT: B adds a second component; A undoes the spawn.
    b.snapshot.commit(() => {
      b.snapshot.setComponent(K(X), UPHealth, { hp: 5 });
    });
    a.snapshot.undo();
    expect(view(a, X).has).toBe(false); // locally, the undo despawned X

    // Exchange full state both ways; capture the fact batches B receives (what a world would apply).
    const aBytes = a.snapshot.export();
    const bBytes = b.snapshot.export();
    const batchesAtB: ChangeBatch[] = b.snapshot.applyRemote(aBytes);
    const batchesAtA: ChangeBatch[] = a.snapshot.applyRemote(bBytes);

    // Fresh joiner imports the converged state from A.
    const c = store(3);
    c.snapshot.applyRemote(a.snapshot.export());

    const va = view(a, X);
    const vb = view(b, X);
    const vc = view(c, X);
    // Investigation output — the observed truth this probe exists to reveal.
    console.log("P1 views", { va, vb, vc });
    console.log("P1 facts at B:", JSON.stringify(batchesAtB.flatMap((batch) => batch.events)));
    console.log("P1 facts at A:", JSON.stringify(batchesAtA.flatMap((batch) => batch.events)));

    // THE convergence contract a public undo() must not break: all three views identical.
    expect(vb).toEqual(va);
    expect(vc).toEqual(va);
  });

  it("P2: buffered [spawn+set][set2][undo] in ONE import — per-commit replay does not drop facts silently", () => {
    const a = store(1);
    const X = "1-0";
    // Bootstrap the receiver from the post-construction base (docId meta commit) FIRST — a buffered
    // increment without its causal base goes PENDING by design. The probe's point is that the three
    // DATA commits below arrive in ONE import.
    const v0 = a.snapshot.version();
    const base = a.snapshot.export();

    a.snapshot.commit(() => {
      a.snapshot.spawn(K(X));
      a.snapshot.setComponent(K(X), UPPos, { x: 1, y: 2 });
    });
    a.snapshot.commit(() => {
      a.snapshot.setComponent(K(X), UPPos, { x: 9, y: 9 });
    });
    a.snapshot.undo(); // reverts set2 only
    a.snapshot.undo(); // reverts the spawn — container delete at head

    const buffer = a.snapshot.exportUpdatesSince(v0);
    const recv = store(2);
    recv.snapshot.applyRemote(base);
    const batches: ChangeBatch[] = recv.snapshot.applyRemote(buffer);

    console.log("P2 batch count:", batches.length);
    console.log("P2 batches:", JSON.stringify(batches));
    console.log("P2 receiver view:", view(recv, X));

    // Doc-level convergence: receiver agrees with sender (X absent on both).
    expect(view(recv, X)).toEqual(view(a, X));
    // A world applying these batches must ALSO end at "X absent": if any batch spawns X, some later
    // batch must despawn it (net absence through the fact stream, not via silent drops).
    const flat = JSON.stringify(batches);
    const spawned = flat.includes('"spawn"') || flat.includes('"add"');
    if (spawned) {
      expect(flat).toMatch(/despawn/);
    }
  });

  it("P3: redo after undo-of-spawn restores the entity; a peer's concurrent cell converges identically everywhere", () => {
    const a = store(1);
    const b = store(2);
    const X = "1-0";

    a.snapshot.commit(() => {
      a.snapshot.spawn(K(X));
      a.snapshot.setComponent(K(X), UPPos, { x: 1, y: 2 });
    });
    b.snapshot.applyRemote(a.snapshot.export());

    b.snapshot.commit(() => {
      b.snapshot.setComponent(K(X), UPHealth, { hp: 5 });
    });
    a.snapshot.undo();
    a.snapshot.redo(); // the spawn returns — but does the container, and does B's concurrent cell?

    b.snapshot.applyRemote(a.snapshot.export());
    a.snapshot.applyRemote(b.snapshot.export());

    const va = view(a, X);
    const vb = view(b, X);
    console.log("P3 views", { va, vb });

    expect(va.has).toBe(true);
    expect(vb).toEqual(va);
  });
});

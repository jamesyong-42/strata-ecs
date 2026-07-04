/**
 * The reconcile matrix — Part III **M4** (docs/plan-part3.md; design.md §13.3–§13.5; 006 B3, C5).
 *
 * The correctness heart of the durable layer: the drag-protected origin×kind value semantics. Drives
 * real attached `World`s exchanging bytes (harness template: transaction.test.ts). Coverage:
 *   - the full origin×kind matrix incl. resources — asserting exactly which of {runtime, baseline,
 *     ledger} moved for each cell;
 *   - the §18.5 drag flow (the architecture in miniature): A drags while B commits → remote values DROP
 *     + the ledger holds the latest; A commits → held cleared by supersession (b), the sweep does NOT
 *     resurrect B's losing value; both peers converge to A's committed value (committer-wins);
 *   - the silent-reconverge case: a drag returns to baseline without committing → the NEXT sweep applies
 *     the held value (and stamps — observeQuery fires);
 *   - supersession (a) (a later applied remote clears an older hold) and (c) (a structural remove clears
 *     the hold — no zombie resurrection);
 *   - the stale-echo regression (M3's scenario): a SINGLE sync converges both peers to the LWW winner —
 *     the own-echo re-reads the CONVERGED value and does not clobber;
 *   - the stranded-cell DEV warning (§13.5): a diverged-forever cell warns once; agreement resets it;
 *   - foreign-schema R4 (006 B3): an older peer's commit preserves a newer peer's unknown field in the
 *     register, while the baseline holds the stripped value; inbound extras strip (not reject);
 *   - a bounded randomized convergence property (5 seeds × 100 ops).
 */

import { describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { createWorld, defineComponent, defineQuery, defineResource, defineSystem, phase } from "../core";
import { cellEquals, tryCanon } from "../substrate";
import { createDurableStore } from "./durable-store";
import { attachDurable } from "./binding";
import { runConvergenceProperty } from "./__stress__/reconcile-harness";

const MPos = defineComponent("MRPos", { x: "f32", y: "f32" }); // the DRAGGED component (conflict path)
const MFill = defineComponent("MRFill", { r: "u8", g: "u8", b: "u8" }); // a second component (independence)
const MClock = defineResource("MRClock", { t: "u32" });

function makeStore(peerId: number): ReturnType<typeof createDurableStore> {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return createDurableStore(doc);
}

/**
 * Two attached peers with a buffered wire-INCREMENT transport both ways (the real §14.2 outbound path)
 * and a bidirectional snapshot bootstrap (M3's finding: each peer imports the other's causal base before
 * streaming increments). `seedPos(v)` creates one shared pre-existing entity holding `MPos = v` on both.
 */
function twoPeers() {
  const a = makeStore(1);
  const wA = createWorld();
  const attA = attachDurable(wA, a);
  const b = makeStore(2);
  const wB = createWorld();
  const attB = attachDurable(wB, b);
  b.applyRemote(a.snapshot.export());
  a.applyRemote(b.snapshot.export());
  wA.sync();
  wB.sync();
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  a.subscribeOutbound((x) => toB.push(x));
  b.subscribeOutbound((x) => toA.push(x));
  const deliverToA = () => {
    for (const x of toA.splice(0)) a.applyRemote(x);
  };
  const deliverToB = () => {
    for (const x of toB.splice(0)) b.applyRemote(x);
  };
  const seedPos = (v: { x: number; y: number }) => {
    const hA = a.transaction((tx) => tx.spawn({ components: [[MPos, v]] }));
    wA.sync();
    const key = a.keyOf(hA)!;
    deliverToB();
    wB.sync();
    const hB = b.resolve(key)!;
    return { key, hA, hB };
  };
  return { a, wA, attA, b, wB, attB, deliverToA, deliverToB, seedPos };
}

// ===================================================================================================
describe("the reconcile matrix — origin × kind × agreement (§13.3)", () => {
  it("(own | remote, structural): component add/remove always apply + advance the baseline", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });

    // (own, structural add): A commits addComponent MFill.
    h.a.transaction((tx) => tx.addComponent(hA, MFill, { r: 1, g: 2, b: 3 }));
    h.wA.sync();
    expect(h.wA.read(hA, MFill)).toEqual({ r: 1, g: 2, b: 3 });
    expect(h.attA.baseline.getComponent(key, MFill)).toEqual({ r: 1, g: 2, b: 3 });

    // (remote, structural add) on B: it arrives, applies, advances B's baseline.
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.read(hB, MFill)).toEqual({ r: 1, g: 2, b: 3 });
    expect(h.attB.baseline.getComponent(key, MFill)).toEqual({ r: 1, g: 2, b: 3 });

    // (own, structural remove): A commits removeComponent → gone from runtime + baseline.
    h.a.transaction((tx) => tx.removeComponent(hA, MFill));
    h.wA.sync();
    expect(h.wA.get(hA, MFill)).toBeUndefined();
    expect(h.attA.baseline.getComponent(key, MFill)).toBeUndefined();

    // (remote, structural remove) on B.
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.get(hB, MFill)).toBeUndefined();
    expect(h.attB.baseline.getComponent(key, MFill)).toBeUndefined();
  });

  it("(own, value, AGREED): the own-echo applies the converged value + advances baseline (a no-op in effect)", () => {
    const h = twoPeers();
    const { key, hA } = h.seedPos({ x: 0, y: 0 });
    // A commits a value on the pre-existing MPos; no drag in flight when the echo drains.
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 }));
    h.wA.sync();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 5, y: 5 });
    expect(cellEquals(h.wA.read(hA, MPos), h.attA.baseline.getComponent(key, MPos))).toBe(true);
  });

  it("(own, value, RE-DRAG): the echo advances the baseline ONLY; the live re-drag is untouched (§13.3 asymmetry)", () => {
    const h = twoPeers();
    const { key, hA } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 })); // commit → runtime==baseline=={5,5}, echo enqueued
    h.wA.edit(hA).set(MPos, { x: 9, y: 9 }); // re-drag BEFORE the echo drains → runtime {9,9}, baseline {5,5}
    h.wA.sync(); // (own, value) not agreed → baseline advances to converged {5,5}; runtime left to the drag
    expect(h.wA.read(hA, MPos)).toEqual({ x: 9, y: 9 }); // the re-drag survived
    expect(h.attA.baseline.getComponent(key, MPos)).toEqual({ x: 5, y: 5 }); // banked our authored value
  });

  it("(remote, value, AGREED): applies the converged value + advances baseline", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits; A not dragging
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 7, y: 7 });
    expect(cellEquals(h.wA.read(hA, MPos), h.attA.baseline.getComponent(key, MPos))).toBe(true);
  });

  it("(remote, value, DRAG): DROP — runtime + baseline untouched; the ledger holds the value (recovered on reconverge)", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.wA.edit(hA).set(MPos, { x: 9, y: 9 }); // A drags → runtime {9,9}, baseline {0,0}
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits concurrently
    h.deliverToA();
    h.wA.sync(); // (remote, value) mid-drag → DROP
    expect(h.wA.read(hA, MPos)).toEqual({ x: 9, y: 9 }); // runtime UNTOUCHED (the drag stands)
    expect(h.attA.baseline.getComponent(key, MPos)).toEqual({ x: 0, y: 0 }); // baseline UNTOUCHED
    // The ledger banked B's value: reconverge to baseline without committing → the sweep recovers it.
    h.wA.edit(hA).set(MPos, { x: 0, y: 0 });
    h.wA.sync();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 7, y: 7 }); // the held value applied by the sweep
  });

  it("resources run the identical matrix at cardinality one (§13.4): agree, drop+hold+sweep, remove structural", () => {
    const h = twoPeers();
    h.a.transaction((tx) => tx.setResource(MClock, { t: 1 })); // shared resource
    h.wA.sync();
    h.deliverToB();
    h.wB.sync();

    // (remote, resource value, AGREED): A not scrubbing → applies.
    h.b.transaction((tx) => tx.setResource(MClock, { t: 42 }));
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.getResource(MClock)).toEqual({ t: 42 });
    expect(h.attA.baseline.getResource(MClock)).toEqual({ t: 42 });

    // (remote, resource value, DRAG): A scrubs the resource (runtime-only) → a remote write DROPS + holds.
    h.wA.setResource(MClock, { t: 500 }); // runtime diverges from baseline {t:42}
    h.b.transaction((tx) => tx.setResource(MClock, { t: 9 }));
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.getResource(MClock)).toEqual({ t: 500 }); // runtime untouched
    expect(h.attA.baseline.getResource(MClock)).toEqual({ t: 42 }); // baseline untouched
    h.wA.setResource(MClock, { t: 42 }); // reconverge without committing
    h.wA.sync();
    expect(h.wA.getResource(MClock)).toEqual({ t: 9 }); // held resource value swept in

    // resource-remove is the one STRUCTURAL resource fact (§13.4): always applies.
    h.b.transaction((tx) => tx.removeResource(MClock));
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.getResource(MClock)).toBeUndefined();
    expect(h.attA.baseline.getResource(MClock)).toBeUndefined();
  });

  it("(own, resource value, AGREED): the own-echo applies converged + advances baseline (a no-op in effect)", () => {
    const h = twoPeers();
    h.a.transaction((tx) => tx.setResource(MClock, { t: 1 }));
    h.wA.sync();
    h.a.transaction((tx) => tx.setResource(MClock, { t: 7 })); // no scrub in flight when the echo drains
    h.wA.sync();
    expect(h.wA.getResource(MClock)).toEqual({ t: 7 });
    expect(cellEquals(h.wA.getResource(MClock), h.attA.baseline.getResource(MClock))).toBe(true);
  });

  it("(own, resource value, RE-DRAG): the echo advances the baseline ONLY; the live re-scrub is untouched", () => {
    const h = twoPeers();
    h.a.transaction((tx) => tx.setResource(MClock, { t: 1 }));
    h.wA.sync();
    h.a.transaction((tx) => tx.setResource(MClock, { t: 5 })); // commit → runtime==baseline=={5}, echo enqueued
    h.wA.setResource(MClock, { t: 9 }); // re-scrub BEFORE the echo drains → runtime {9}, baseline {5}
    h.wA.sync(); // (own, resource) not agreed → baseline advances to converged {5}; runtime left to the scrub
    expect(h.wA.getResource(MClock)).toEqual({ t: 9 }); // the re-scrub survived
    expect(h.attA.baseline.getResource(MClock)).toEqual({ t: 5 }); // banked our authored value (own asymmetry)
  });
});

// ===================================================================================================
describe("the drag flow — §18.5, the architecture in miniature", () => {
  it("A drags while B commits → remote drops + ledger holds; A commits → sweep never resurrects B's value; both converge", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });

    // Phase 1 — A drags (runtime-only divergence). Settle its own stamp, then arm an observer.
    h.wA.edit(hA).set(MPos, { x: 20, y: 20 });
    h.wA.sync();
    h.wA.reactive.notify();
    let aFires = 0;
    h.wA.reactive.observeValue(hA, MPos, () => {
      aFires++;
    });

    // Phase 2 — B commits concurrently; A drains it mid-drag → DROP. NO reactive callback fires (nothing changed).
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 99, y: 99 }));
    h.deliverToA();
    h.wA.sync();
    h.wA.reactive.notify();
    expect(aFires).toBe(0); // the drop path fired no reactive callbacks while held
    expect(h.wA.read(hA, MPos)).toEqual({ x: 20, y: 20 }); // the drag stands
    expect(h.attA.baseline.getComponent(key, MPos)).toEqual({ x: 0, y: 0 });

    // Phase 3 — A's drag ends with a commit → runtime/doc/baseline agree, the held entry is cleared by
    // supersession (b). The sweep must NOT resurrect B's losing {99,99}.
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 30, y: 30 }));
    h.wA.sync();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 30, y: 30 });
    expect(cellEquals(h.wA.read(hA, MPos), h.attA.baseline.getComponent(key, MPos))).toBe(true);
    h.wA.sync(); // an extra empty drain — the sweep still must not resurrect {99,99}
    expect(h.wA.read(hA, MPos)).toEqual({ x: 30, y: 30 });

    // Phase 4 — exchange: both converge to A's committed value (committer-wins as the later op). B's
    // observeQuery lights up with zero wiring (005 §5.3).
    let bFires = 0;
    h.wB.reactive.observeQuery(defineQuery([MPos]), [MPos], () => {
      bFires++;
    });
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.read(hB, MPos)).toEqual({ x: 30, y: 30 });
    h.wB.reactive.notify();
    expect(bFires).toBeGreaterThan(0);
    expect(h.wA.read(hA, MPos)).toEqual({ x: 30, y: 30 });
  });
});

// ===================================================================================================
describe("silent-reconverge — the held-cell sweep (006 C5)", () => {
  it("a drag written back EXACTLY to baseline (no commit) → the next sweep applies the held value AND stamps", () => {
    const h = twoPeers();
    const { hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.wA.edit(hA).set(MPos, { x: 5, y: 5 }); // diverge
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits → held on A
    h.deliverToA();
    h.wA.sync(); // DROP + hold {7,7}
    h.wA.reactive.notify();

    h.wA.edit(hA).set(MPos, { x: 0, y: 0 }); // reconverge to baseline exactly (NO commit)
    let fires = 0;
    h.wA.reactive.observeQuery(defineQuery([MPos]), [MPos], () => {
      fires++;
    });
    h.wA.sync(); // the sweep sees runtime == baseline → applies the held {7,7} (a projector write → stamps)
    h.wA.reactive.notify();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 7, y: 7 }); // recovered — only the sweep produces this value
    expect(fires).toBeGreaterThan(0); // sweep-applies stamp (006 C2), so reactivity observes the recovery
  });
});

// ===================================================================================================
describe("held-cell supersession (006 C5)", () => {
  it("(a) a later APPLIED remote value clears an older hold — no zombie apply of the stale value", () => {
    const h = twoPeers();
    const { hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.wA.edit(hA).set(MPos, { x: 5, y: 5 }); // diverge
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits → held {7,7} on A
    h.deliverToA();
    h.wA.sync();

    h.wA.edit(hA).set(MPos, { x: 0, y: 0 }); // reconverge (runtime == baseline)
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 8, y: 8 })); // a NEWER remote
    h.deliverToA();
    h.wA.sync(); // agreed → apply {8,8} + clear the hold; the sweep then finds nothing
    expect(h.wA.read(hA, MPos)).toEqual({ x: 8, y: 8 }); // the newer applied value, NOT the zombie {7,7}
  });

  it("(c) a remote component-remove on a held cell clears the hold — the sweep does not resurrect the component", () => {
    const h = twoPeers();
    const { hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.wA.edit(hA).set(MPos, { x: 5, y: 5 }); // diverge
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits → held {7,7} on A
    h.deliverToA();
    h.wA.sync();

    h.b.transaction((tx) => tx.removeComponent(hB, MPos)); // B removes the component (structural)
    h.deliverToA();
    h.wA.sync(); // structural remove applies (even mid-drag) + clears the hold (c)
    h.wA.sync(); // an extra sweep — still no resurrection
    expect(h.wA.get(hA, MPos)).toBeUndefined(); // the component stays gone, NOT resurrected to {7,7}
  });

  it("(b) a single-tx removeComponent+addComponent clears the held loser — the sweep does not resurrect it", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.wA.edit(hA).set(MPos, { x: 9, y: 9 }); // A drags → runtime {9,9}, baseline {0,0}
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // B commits → held {7,7} on A
    h.deliverToA();
    h.wA.sync(); // DROP + hold {7,7}
    // ONE tx removes then re-adds MPos: the NET frontier diff is a single component-SET (no remove fact),
    // so supersession (c) never fires — the addComponent seal branch must clear the held loser via rule (b).
    h.a.transaction((tx) => {
      tx.removeComponent(hA, MPos);
      tx.addComponent(hA, MPos, { x: 5, y: 5 });
    });
    h.wA.sync(); // own echo advances the baseline to {5,5}; the drag {9,9} is still in flight at runtime
    h.wA.edit(hA).set(MPos, { x: 5, y: 5 }); // end the drag by writing back to baseline exactly (NO commit)
    h.wA.sync(); // the sweep sees runtime == baseline → must NOT resurrect {7,7}
    expect(h.wA.read(hA, MPos)).toEqual({ x: 5, y: 5 }); // the committer-wins value, NOT the held loser
    expect(h.a.snapshot.getComponent(key, MPos)).toEqual({ x: 5, y: 5 });
  });
});

// ===================================================================================================
describe("the stale-echo regression (M3's scenario, in a SINGLE sync)", () => {
  it("A commits v1, B commits v2 concurrently (LWW picks one); one sync converges BOTH peers to the winner", () => {
    const h = twoPeers();
    const { hA, hB } = h.seedPos({ x: 0, y: 0 });

    // Concurrent commits, neither peer has seen the other (bytes buffered).
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 1, y: 1 })); // A's own-echo enqueued
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 2, y: 2 })); // B's own-echo enqueued
    h.deliverToA(); // A now holds B's remote AND its own stale echo
    h.deliverToB(); // B now holds A's remote AND its own stale echo

    // A SINGLE sync on each peer drains {remote, own-echo}. The own-echo re-reads the CONVERGED value, so
    // it cannot clobber a remote that won LWW between the commit and this sync.
    h.wA.sync();
    h.wB.sync();

    const va = h.wA.read(hA, MPos);
    const vb = h.wB.read(hB, MPos);
    expect(va).toEqual(vb); // both peers agree on ONE whole value
    expect([JSON.stringify({ x: 1, y: 1 }), JSON.stringify({ x: 2, y: 2 })]).toContain(JSON.stringify(va));
    // And the runtime equals the converged doc on both (the own-echo did not leave a stale runtime).
    expect(cellEquals(va, h.a.snapshot.getComponent(h.a.keyOf(hA)!, MPos) as never)).toBe(true);
    expect(cellEquals(vb, h.b.snapshot.getComponent(h.b.keyOf(hB)!, MPos) as never)).toBe(true);
  });
});

// ===================================================================================================
describe("own value-echo reclassified as structural ADD — the converged re-read (M4R fix 1)", () => {
  // A commits a VALUE to a present cell; a concurrent remote structural change (removeComponent / destroy)
  // wins LWW and drains remote-FIRST in the same sync (decision E), CLEARING the baseline so A's own
  // value-echo reclassifies as a structural ADD. The echo MUST re-read converged truth — else it resurrects
  // a cell/entity the document deleted. runtime==baseline self-conceals the zombie, so it survives re-sync.
  it("remote removeComponent WON LWW → the own echo does NOT resurrect the removed cell (no zombie)", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 })); // own echo enqueued, NOT yet synced
    // Make B's remove causally AFTER A's set (B imports A's commit first) → the remove wins unambiguously.
    h.deliverToB();
    h.wB.sync();
    h.b.transaction((tx) => tx.removeComponent(hB, MPos));
    // A drains remote-remove THEN own-echo in ONE sync: the remove clears the baseline, the echo classifies
    // as a structural ADD, and the converged re-read (doc removed the cell) applies NOTHING.
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.get(hA, MPos)).toBeUndefined(); // no resurrection
    expect(h.attA.baseline.getComponent(key, MPos)).toBeUndefined();
    // Survives a full re-sync both ways (the self-concealment the review flagged): still absent everywhere.
    h.deliverToB();
    h.wB.sync();
    h.deliverToA();
    h.wA.sync();
    expect(h.wA.get(hA, MPos)).toBeUndefined();
    expect(h.a.snapshot.getComponent(key, MPos)).toBeUndefined();
    expect(h.b.snapshot.getComponent(key, MPos)).toBeUndefined();
  });

  it("remote destroy WON LWW → the own value-echo does NOT resurrect a zombie cell on a dead entity", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 })); // own echo enqueued
    h.deliverToB();
    h.wB.sync();
    h.b.transaction((tx) => tx.destroy(hB)); // causally after A's set → the destroy wins
    h.deliverToA();
    h.wA.sync(); // remote-despawn first (entity gone), then own echo → structural ADD → converged undefined
    expect(h.wA.get(hA, MPos)).toBeUndefined();
    expect(h.attA.baseline.hasEntity(key)).toBe(false);
    expect(h.a.snapshot.hasEntity(key)).toBe(false);
  });

  it("(control) the own VALUE wins LWW → the cell converges to the value on both peers (no over-drop)", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.b.transaction((tx) => tx.removeComponent(hB, MPos)); // B removes first
    h.deliverToA(); // A imports the remove but has NOT synced (baseline still has MPos)
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 })); // causally after B's remove → the set wins
    h.wA.sync(); // remote-remove then own-echo; the converged re-read re-adds the LWW-winning value
    expect(h.wA.read(hA, MPos)).toEqual({ x: 5, y: 5 });
    // Converge B and settle: both peers agree on the winning value, runtime == doc. (B's own remove-echo
    // LOSES here — the fix-2 remove-echo path re-reads converged and keeps the value instead of removing.)
    h.deliverToB();
    h.wB.sync();
    h.deliverToA();
    h.wA.sync();
    expect(h.wB.read(hB, MPos)).toEqual({ x: 5, y: 5 });
    expect(h.wA.read(hA, MPos)).toEqual({ x: 5, y: 5 });
    expect(h.a.snapshot.getComponent(key, MPos)).toEqual({ x: 5, y: 5 });
    expect(h.b.snapshot.getComponent(key, MPos)).toEqual({ x: 5, y: 5 });
  });
});

// ===================================================================================================
describe("own structural REMOVE / DESPAWN echoes — the converged re-read (M4R fix 2)", () => {
  // The mirror of fix 1: an own removeComponent/destroy echo is commit-time-stale, so a concurrent remote
  // SET that won LWW must survive — the remover/despawner must honor the CONVERGED doc, not blindly remove.
  it("remove-echo LOSES: own removeComponent + a remote add that won LWW → the remover honors converged", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.removeComponent(hA, MPos)); // own remove-echo enqueued, NOT yet synced
    h.deliverToB();
    h.wB.sync(); // B reconciles the remove → MPos absent on B
    h.b.transaction((tx) => tx.addComponent(hB, MPos, { x: 7, y: 7 })); // causally after → re-adds, wins LWW
    h.deliverToA();
    h.wA.sync(); // A drains remote-add THEN its own remove-echo (decision E) in ONE sync
    // The own remove-echo re-reads converged {7,7} (the add won) → applies the value, does NOT remove.
    expect(h.wA.read(hA, MPos)).toEqual({ x: 7, y: 7 });
    expect(h.a.snapshot.getComponent(key, MPos)).toEqual({ x: 7, y: 7 }); // runtime == doc on the remover
    expect(cellEquals(h.wA.read(hA, MPos), h.attA.baseline.getComponent(key, MPos))).toBe(true);
  });

  it("despawn-echo LOSES: own destroy + a concurrent remote set that won LWW → the entity SURVIVES", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    // Concurrent: A destroys, B sets — neither delivered. B's set wins the per-cell LWW (peerId tiebreak).
    h.a.transaction((tx) => tx.destroy(hA)); // own despawn-echo enqueued
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 }));
    h.deliverToA(); // A imports B's set (partial-cell resurrection: exists gone, MPos alive)
    h.wA.sync(); // remote set applies {7,7}, then the own despawn-echo reconciles per-cell → entity survives
    expect(h.wA.get(hA, MPos)).toEqual({ x: 7, y: 7 }); // the entity survived with the winner's cell
    expect(h.attA.baseline.getComponent(key, MPos)).toEqual({ x: 7, y: 7 });
    expect(h.a.snapshot.getComponent(key, MPos)).toEqual({ x: 7, y: 7 }); // runtime + baseline == doc
    expect(cellEquals(h.wA.get(hA, MPos), h.attA.baseline.getComponent(key, MPos))).toBe(true);
  });

  it("REMOTE despawn with a surviving cell (separate drains) → the receiver KEEPS the cell, no divergence", () => {
    // The remote-side twin (a probe discovery: the review scoped fix 2 to own-origin, but a despawn's
    // whole-entity removal also loses a concurrently-surviving cell on the peer that RECEIVES it). B's own
    // set-echo drains in an EARLIER sync than A's remote despawn, so the own-echo can't re-project the cell —
    // the remote despawn must itself reconcile survival.
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.destroy(hA)); // buffered to B
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 })); // wins the per-cell LWW
    h.wB.sync(); // B's own set-echo drains NOW (earlier drain) → MPos {7,7} settled on B
    h.deliverToA();
    h.wA.sync(); // A: remote set + own despawn-echo → A keeps the entity with {7,7}
    h.deliverToB();
    h.wB.sync(); // B: the REMOTE despawn drains in a LATER drain → must reconcile survival, not despawn
    expect(h.wB.get(hB, MPos)).toEqual({ x: 7, y: 7 }); // B kept the winning cell (no divergence)
    expect(h.attB.baseline.getComponent(key, MPos)).toEqual({ x: 7, y: 7 });
    expect(h.b.snapshot.getComponent(key, MPos)).toEqual({ x: 7, y: 7 });
    expect(h.wA.get(hA, MPos)).toEqual({ x: 7, y: 7 }); // both peers agree
  });

  it("(control) remove-echo WINS (no concurrent set) → the cell is removed and converges on both peers", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.removeComponent(hA, MPos));
    h.wA.sync(); // own remove-echo, no concurrent → converged undefined → removes
    expect(h.wA.get(hA, MPos)).toBeUndefined();
    expect(h.attA.baseline.getComponent(key, MPos)).toBeUndefined();
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.get(hB, MPos)).toBeUndefined();
  });

  it("(control) despawn-echo WINS (no concurrent survival) → the entity despawns and converges on both peers", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });
    h.a.transaction((tx) => tx.destroy(hA));
    h.wA.sync(); // own despawn-echo, doc fully gone → despawns
    expect(h.attA.baseline.hasEntity(key)).toBe(false);
    expect(h.a.snapshot.hasEntity(key)).toBe(false);
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.get(hB, MPos)).toBeUndefined();
    expect(h.b.snapshot.hasEntity(key)).toBe(false);
  });
});

// ===================================================================================================
describe("the stranded-cell DEV warning (§13.5)", () => {
  it("a diverged-forever cell accumulating remote drops warns ONCE; agreement resets the counter", () => {
    const h = twoPeers();
    const { hA, hB } = h.seedPos({ x: 0, y: 0 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const strandedWarns = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes("looks stranded")).length;

    h.wA.edit(hA).set(MPos, { x: 9, y: 9 }); // A diverges and never commits — a stranded cell
    for (let i = 1; i <= 100; i++) {
      h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: i % 500, y: i % 500 }));
      h.deliverToA();
      h.wA.sync(); // each drop increments the per-cell counter
    }
    expect(strandedWarns()).toBe(1); // exactly one warning past the ~100 threshold

    // Agreement resets: A commits (restores agreement) → the counter + the one-shot flag clear.
    h.a.transaction((tx) => tx.edit(hA).set(MPos, { x: 9, y: 9 }));
    h.wA.sync();
    h.wA.edit(hA).set(MPos, { x: 1, y: 1 }); // strand it AGAIN
    for (let i = 1; i <= 100; i++) {
      h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: (i % 400) + 1, y: (i % 400) + 1 }));
      h.deliverToA();
      h.wA.sync();
    }
    expect(strandedWarns()).toBe(2); // the reset re-armed the warning; a fresh strand warns again
    warnSpy.mockRestore();
  });
});

// ===================================================================================================
describe("foreign schema R4 (006 B3) — unknown fields survive; local compares strip", () => {
  it("inbound unknown fields STRIP (not reject) via the canon path", () => {
    // tryCanon iterates the LOCAL schema only, so an extra field is dropped — never a reject.
    const gate = tryCanon(MPos, { x: 1, y: 2, z: 99 } as never);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.value).toEqual({ x: 1, y: 2 }); // z stripped, no `z` key
  });

  it("an older peer's commit PRESERVES a newer peer's unknown field in the register; the baseline holds the stripped value", () => {
    const a = makeStore(1);
    const wA = createWorld();
    const attA = attachDurable(wA, a);
    const hA = a.transaction((tx) => tx.spawn({ components: [[MPos, { x: 1, y: 1 }]] }));
    wA.sync();
    const key = a.keyOf(hA)!;

    // A "newer-schema" peer that imports A's base, then writes MPos WITH an unknown `z` field (causally
    // after A's commit, so it wins LWW and its z lands in A's register on import).
    const forge = new LoroDoc();
    forge.setPeerId(99);
    forge.import(a.snapshot.export());
    const child = forge.getMap("entities").get(String(key)) as LoroMap;
    child.set("comp:MRPos", { x: 1, y: 1, z: 9 });
    forge.commit({ message: "strata:0" });
    a.applyRemote(forge.export({ mode: "snapshot" }));
    wA.sync();

    // Inbound R4: the unknown field STRIPPED before the baseline (no reject) — compares stay local-schema.
    expect(attA.baseline.getComponent(key, MPos)).toEqual({ x: 1, y: 1 });
    expect((a.snapshot.getComponent(key, MPos) as Record<string, unknown>).z).toBe(9); // z lives in Loro

    // Outbound R4 overlay: A (older schema) commits a KNOWN-field change → z must SURVIVE in the register.
    a.transaction((tx) => tx.edit(hA).set(MPos, { x: 5, y: 5 }));
    wA.sync();
    const raw = a.snapshot.getComponent(key, MPos) as Record<string, unknown>;
    expect(raw.x).toBe(5);
    expect(raw.y).toBe(5);
    expect(raw.z).toBe(9); // the newer peer's field was NOT stripped by the older peer's commit
    // The baseline + the runtime hold the stripped local-schema value.
    expect(attA.baseline.getComponent(key, MPos)).toEqual({ x: 5, y: 5 });
    expect(wA.read(hA, MPos)).toEqual({ x: 5, y: 5 });
    attA.detach();
  });

  it("an older peer's setResource PRESERVES a newer peer's unknown resource field (the R4 resource twin)", () => {
    const a = makeStore(1);
    const wA = createWorld();
    const attA = attachDurable(wA, a);
    a.transaction((tx) => tx.setResource(MClock, { t: 1 }));
    wA.sync();

    // A "newer-schema" peer imports A's base, then writes MClock WITH an unknown `phase` field (causally
    // after A's commit → wins LWW, its field lands in A's resource register on import).
    const forge = new LoroDoc();
    forge.setPeerId(99);
    forge.import(a.snapshot.export());
    forge.getMap("resources").set("MRClock", { t: 1, phase: 7 });
    forge.commit({ message: "strata:0" });
    a.applyRemote(forge.export({ mode: "snapshot" }));
    wA.sync();

    // Inbound R4: the unknown field STRIPPED before the baseline (no reject); the raw value lives in Loro.
    expect(attA.baseline.getResource(MClock)).toEqual({ t: 1 });
    expect((a.snapshot.getResource(MClock) as Record<string, unknown>).phase).toBe(7);

    // Outbound R4 overlay: A (older schema) commits a KNOWN-field change → `phase` must SURVIVE the register.
    a.transaction((tx) => tx.setResource(MClock, { t: 5 }));
    wA.sync();
    const raw = a.snapshot.getResource(MClock) as Record<string, unknown>;
    expect(raw.t).toBe(5);
    expect(raw.phase).toBe(7); // the newer peer's field was NOT stripped by the older peer's setResource
    // The baseline + the runtime hold the stripped local-schema value.
    expect(attA.baseline.getResource(MClock)).toEqual({ t: 5 });
    expect(wA.getResource(MClock)).toEqual({ t: 5 });
    attA.detach();
  });
});

// ===================================================================================================
describe("frame-loop integration — in-system durable commit + concurrent remote (006 C4 shape, end-to-end)", () => {
  it("a system commits a durable value during tick; the following frame converges runtime==doc; observeQuery fires", () => {
    const h = twoPeers();
    const { key, hA, hB } = h.seedPos({ x: 0, y: 0 });

    // A real system on A: commits a durable value to MPos each tick via doc.transaction. It DECLARES
    // access.write=[MPos] — the synchronous writeComponent hits the 001 chokepoint under enforcement (006 C4).
    const Bump = defineSystem(
      defineQuery([MPos]),
      (batch) => {
        for (const r of batch) h.a.transaction((tx) => tx.edit(batch.entity(r)).set(MPos, { x: 3, y: 3 }));
      },
      { name: "Bump", access: { write: [MPos] } },
    );
    // Arming an observer also arms 001 enforcement (001 §2.4), so the C4 chokepoint is live this run.
    let aFires = 0;
    h.wA.reactive.observeQuery(defineQuery([MPos]), [MPos], () => {
      aFires++;
    });

    // A concurrent remote change from B is pending (buffered), delivered before A's frame.
    h.b.transaction((tx) => tx.edit(hB).set(MPos, { x: 7, y: 7 }));
    h.deliverToA();

    // Frame 1: sync (drains B's remote {7,7}) → tick (Bump commits {3,3}, causally after → wins) → notify.
    h.wA.sync();
    h.wA.tick([phase("p", [Bump])]);
    h.wA.reactive.notify();

    // Frame 2: sync drains the own-echo of the in-tick commit; the runtime must equal the converged doc.
    h.wA.sync();
    h.wA.reactive.notify();
    expect(h.wA.read(hA, MPos)).toEqual({ x: 3, y: 3 }); // A's in-tick commit is the later op → it wins
    expect(cellEquals(h.wA.read(hA, MPos), h.a.snapshot.getComponent(key, MPos) as never)).toBe(true); // runtime == doc
    expect(aFires).toBeGreaterThan(0); // the drained remote + the commit lit observeQuery up (005 §5.3)

    // And it converges to B: A's committed {3,3} wins on B too.
    h.deliverToB();
    h.wB.sync();
    expect(h.wB.read(hB, MPos)).toEqual({ x: 3, y: 3 });
  });
});

// ===================================================================================================
describe("randomized convergence (bounded, ci)", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`converges under seed ${seed} (100 interleaved ops, 4 entities)`, () => {
      runConvergenceProperty({ seed, ops: 100, entities: 4 });
    });
  }
});

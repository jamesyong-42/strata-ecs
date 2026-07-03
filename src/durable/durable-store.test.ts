/**
 * `createDurableStore` / `DurableStore` — Part III M1 (docs/plan-part3.md; design.md §14).
 *
 * Covers the M1 surface the underlying LoroSnapshot (M0) does not:
 *   - key minting + counter RESUME past this peer's max existing key (foreign / non-numeric ignored);
 *   - docId: a stable GUID in the reserved "meta" root map, agreed across reload and across peers;
 *   - applyRemote: enqueues one batch per remote commit; drainPending empties; a pending (missing-deps)
 *     import propagates PendingImportError and permanently quarantines (the queue rejects further batches);
 *   - subscribeOutbound: per-commit increments a receiver imports in order to converge; identical bytes to
 *     every subscriber; unsubscribe stops delivery;
 *   - pre-attach reads: getComponentByKey works; keyOf/resolve/getComponent are undefined with no bijection;
 *   - exportUpdatesSince state-equivalence (increment vs full snapshot).
 *
 * M1 has no `transaction` (M3), so local commits are driven directly through the store's @internal
 * snapshot — exactly what M2's binding / M3's executor will do.
 */

import { describe, expect, it } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { type Entity, entityKey } from "../core";
import { defineComponent, defineTag } from "../core";
import { LoroSnapshot, PendingImportError } from "./loro-snapshot";
import { createDurableStore } from "./durable-store";

const DSPos = defineComponent("DSPos", { x: "f32", y: "f32" });
const DSSel = defineTag("DSSel");

const K = (s: string) => entityKey(s);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh LoroDoc with an explicit peer id, wrapped in a store (peer id → key prefix + LWW ordering). */
function store(peerId: number): { store: ReturnType<typeof createDurableStore>; doc: LoroDoc } {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return { store: createDurableStore(doc), doc };
}

// ---------------------------------------------------------------------------------------------------
describe("key minting + counter resume (§14.1/§14.2)", () => {
  it("mints peer-prefixed keys from 0 on a fresh doc", () => {
    const { store: s } = store(1);
    expect(s.mintKey()).toBe("1-0");
    expect(s.mintKey()).toBe("1-1");
    expect(s.mintKey()).toBe("1-2");
  });

  it("resumes past this peer's max existing key on reload — never re-mints 1-0", () => {
    const first = store(1);
    for (let i = 0; i < 5; i++) {
      const k = first.store.mintKey(); // 1-0 .. 1-4
      first.store.snapshot.commit(() => first.store.snapshot.spawn(k));
    }
    const bytes = first.store.snapshot.export();

    // Reload the SAME peer id into a fresh doc → the counter resumes at 5, not 0.
    const reloaded = new LoroDoc();
    reloaded.setPeerId(1);
    reloaded.import(bytes);
    const s2 = createDurableStore(reloaded);
    expect(s2.mintKey()).toBe("1-5");
  });

  it("foreign-peer keys and non-numeric suffixes do NOT bump the counter", () => {
    const doc = new LoroDoc();
    doc.setPeerId(1);
    const em = doc.getMap("entities");
    em.setContainer("1-2", new LoroMap()).set("exists", true); // own key, suffix 2 → counts
    em.setContainer("9-9", new LoroMap()).set("exists", true); // FOREIGN prefix → ignored
    em.setContainer("1-abc", new LoroMap()).set("exists", true); // own prefix, non-numeric → ignored
    doc.commit({ message: "strata:0" });

    const s = createDurableStore(doc);
    expect(s.mintKey()).toBe("1-3"); // max own numeric suffix is 2 → resume at 3
  });
});

// ---------------------------------------------------------------------------------------------------
describe("docId — stable GUID in the reserved meta map (§14.1)", () => {
  it("is a fresh GUID on a fresh doc", () => {
    const { store: s } = store(1);
    expect(s.docId).toMatch(UUID);
  });

  it("is stable across reload and agreed by two stores over the same doc bytes", () => {
    const first = store(1);
    const id = first.store.docId;
    const bytes = first.store.snapshot.export();

    // Reload (same peer) → the store reads the existing docId, never mints a new one.
    const reloadedDoc = new LoroDoc();
    reloadedDoc.setPeerId(1);
    reloadedDoc.import(bytes);
    expect(createDurableStore(reloadedDoc).docId).toBe(id);

    // A DIFFERENT peer loading the same initial bytes derives the same docId (first-writer-wins).
    const otherDoc = new LoroDoc();
    otherDoc.setPeerId(2);
    otherDoc.import(bytes);
    expect(createDurableStore(otherDoc).docId).toBe(id);
  });

  it("the docId write is not an undo step (excluded via META_ORIGIN)", () => {
    const { store: s } = store(1);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    s.snapshot.undo(); // reverts the spawn
    expect(s.snapshot.hasEntity(K("1-0"))).toBe(false);
    expect(s.docId).toMatch(UUID); // docId survived — the meta write was never undoable
  });
});

// ---------------------------------------------------------------------------------------------------
describe("applyRemote — inbound wire → binding queue (§14.2)", () => {
  it("enqueues one batch per remote commit; drainPending empties", () => {
    const sender = store(10);
    sender.store.snapshot.commit(() => sender.store.snapshot.spawn(K("10-0"))); // commit 1
    sender.store.snapshot.commit(() => sender.store.snapshot.setComponent(K("10-0"), DSPos, { x: 1, y: 2 })); // 2
    sender.store.snapshot.commit(() => sender.store.snapshot.addTag(K("10-0"), DSSel)); // 3

    const recv = store(20);
    recv.store.applyRemote(sender.store.snapshot.export()); // returns void — batches go to the queue

    const drained = recv.store.drainPending();
    expect(drained).toHaveLength(3); // 3 entity commits (the docId meta commit surfaces no batch)
    expect(drained.every((b) => b.origin === "remote")).toBe(true);
    expect(recv.store.drainPending()).toEqual([]); // emptied by the first drain
  });

  it("a pending (missing-deps) import propagates PendingImportError and quarantines; the queue rejects further batches", () => {
    const sender = store(10);
    sender.store.snapshot.commit(() => sender.store.snapshot.setComponent(K("10-0"), DSPos, { x: 1, y: 1 })); // commit 1
    const vvAfter1 = sender.doc.version();
    sender.store.snapshot.commit(() => sender.store.snapshot.setComponent(K("10-0"), DSPos, { x: 2, y: 2 })); // commit 2
    // The later half depends on commit 1, which the fresh receiver lacks → pending on import.
    const laterHalf = sender.doc.export({ mode: "update", from: vvAfter1 });

    const recv = store(20);
    expect(() => recv.store.applyRemote(laterHalf)).toThrow(PendingImportError);
    expect(recv.store.drainPending()).toEqual([]); // nothing enqueued from the poisoned import

    // Permanent: every future applyRemote throws BEFORE enqueuing — the queue cannot grow.
    const healthy = store(30);
    healthy.store.snapshot.commit(() => healthy.store.snapshot.spawn(K("30-0")));
    expect(() => recv.store.applyRemote(healthy.store.snapshot.export())).toThrow(PendingImportError);
    expect(recv.store.drainPending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("subscribeOutbound — outbound wire (§14.2)", () => {
  it("ships one increment per local commit; a receiver importing them in order converges", () => {
    const sender = store(1);
    const payloads: Uint8Array[] = [];
    sender.store.subscribeOutbound((b) => payloads.push(b));

    // Bootstrap the receiver with the base (the docId commit) so the increments' deps are satisfied —
    // §14.2 wires transport before editing, and a joining peer snapshots the base first (006 §A5.2).
    const recvDoc = new LoroDoc();
    recvDoc.setPeerId(2);
    recvDoc.import(sender.store.snapshot.export());

    sender.store.snapshot.commit(() => sender.store.snapshot.spawn(K("1-0")));
    sender.store.snapshot.commit(() => sender.store.snapshot.setComponent(K("1-0"), DSPos, { x: 3, y: 4 }));
    expect(payloads).toHaveLength(2);

    const st1 = recvDoc.import(payloads[0]);
    const st2 = recvDoc.import(payloads[1]);
    expect(st1.pending).toBeNull();
    expect(st2.pending).toBeNull();
    expect(new LoroSnapshot(recvDoc).getComponent(K("1-0"), DSPos)).toEqual({ x: 3, y: 4 });
  });

  it("every subscriber receives the identical bytes; unsubscribe stops delivery", () => {
    const { store: s } = store(1);
    const a: Uint8Array[] = [];
    const b: Uint8Array[] = [];
    const unsubA = s.subscribeOutbound((x) => a.push(x));
    s.subscribeOutbound((x) => b.push(x));

    s.snapshot.commit(() => s.snapshot.spawn(K("1-0")));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]); // SAME buffer — computed once, handed to all subscribers

    unsubA();
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1")));
    expect(a).toHaveLength(1); // A unsubscribed → no further delivery
    expect(b).toHaveLength(2); // B still receiving
  });

  it("a subscriber attaching mid-life misses commits sealed before it subscribed (versioning starts at construction)", () => {
    const { store: s } = store(1);
    s.snapshot.commit(() => s.snapshot.spawn(K("1-0"))); // sealed BEFORE any subscriber

    const late: Uint8Array[] = [];
    s.subscribeOutbound((x) => late.push(x));
    s.snapshot.commit(() => s.snapshot.spawn(K("1-1"))); // only this one is delivered
    expect(late).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("reads — pre-attach seam (§14.3)", () => {
  it("getComponentByKey reads the doc; keyOf/resolve/getComponent are undefined with no bijection", () => {
    const { store: s } = store(1);
    s.snapshot.commit(() => s.snapshot.setComponent(K("1-0"), DSPos, { x: 5, y: 6 }));

    // Key-addressed read works pre-attach (no bijection needed).
    expect(s.getComponentByKey(K("1-0"), DSPos)).toEqual({ x: 5, y: 6 });
    expect(s.getComponentByKey(K("1-nope"), DSPos)).toBeUndefined();

    // Handle-addressed reads need the projector bijection, which is null pre-attach → undefined.
    const handle = 0 as unknown as Entity;
    expect(s.keyOf(handle)).toBeUndefined();
    expect(s.resolve(K("1-0"))).toBeUndefined();
    expect(s.getComponent(handle, DSPos)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
describe("exportUpdatesSince — state equivalence with a full snapshot", () => {
  it("base snapshot + increment converges to the same state as the full snapshot", () => {
    const src = store(1);
    src.store.snapshot.commit(() => src.store.snapshot.spawn(K("1-0"))); // base state
    const baseBytes = src.store.snapshot.export();
    const v0 = src.store.snapshot.version();

    src.store.snapshot.commit(() => src.store.snapshot.setComponent(K("1-0"), DSPos, { x: 1, y: 2 }));
    src.store.snapshot.commit(() => src.store.snapshot.spawn(K("1-1")));
    const increment = src.store.snapshot.exportUpdatesSince(v0);
    const fullBytes = src.store.snapshot.export();

    // Receiver A: full snapshot.
    const a = new LoroDoc();
    a.setPeerId(2);
    a.import(fullBytes);
    const aSnap = new LoroSnapshot(a);

    // Receiver B: base snapshot, then the single increment since v0.
    const b = new LoroDoc();
    b.setPeerId(3);
    b.import(baseBytes);
    expect(b.import(increment).pending).toBeNull();
    const bSnap = new LoroSnapshot(b);

    expect(bSnap.readEntity(K("1-0"))).toEqual(aSnap.readEntity(K("1-0")));
    expect(bSnap.readEntity(K("1-1"))).toEqual(aSnap.readEntity(K("1-1")));
    expect([...bSnap.entities()].sort()).toEqual([...aSnap.entities()].sort());
  });
});

/**
 * `metaTransaction` — sanctioned embedder document-metadata writes (petition 3b; 005 §10.11 as-built
 * amendment). The reserved "meta" root map is where an embedder stamps its OWN doc-metadata (engine version,
 * schema markers, feature flags) that must travel and persist WITH the document but are not ECS facts.
 * `DurableStore.metaTransaction(fn)` hands `fn` a primitive-only {@link MetaEditor} and seals whatever it
 * stages as ONE commit that is:
 *   - `strata:<n>`-tagged (so an importing peer never sees it as a foreign/untagged writer);
 *   - excluded from undo/redo (the docId write's exclusion, generalized);
 *   - transparent to batch translation (no ChangeBatch — observers and peers never hear it as an ECS change).
 *
 * Also pins the warn-site EXEMPTION: `applyRemote`'s untagged-writer notice is suppressed for a foreign
 * META-ONLY commit (a legacy embedder that stamped the "meta" map before metaTransaction existed), but still
 * fires for a coalesced foreign commit that touches meta AND entities.
 *
 * Reuses durable-store.test.ts's fixture shape (explicit peer ids; local commits driven through the
 * @internal snapshot; attached fixtures mirror nonundoable.test.ts for the undo pins).
 */

import { describe, expect, it, vi } from "vitest";
import { LoroDoc, LoroMap } from "loro-crdt";
import { createWorld, defineComponent, entityKey } from "../core";
import type { ChangeBatch } from "../substrate";
import { attachDurable } from "./binding";
import { createDurableStore } from "./durable-store";
import { DOC_ID_KEY, type MetaEditor } from "./loro-snapshot";

const MTPos = defineComponent("MTPos", { x: "f32", y: "f32" });

const K = (s: string) => entityKey(s);
const STRATA = /^strata:\d+$/;

/** A fresh LoroDoc with an explicit peer id, wrapped in a store (peer id → key prefix + LWW ordering). */
function mkStore(peerId: number): { store: ReturnType<typeof createDurableStore>; doc: LoroDoc } {
  const doc = new LoroDoc();
  doc.setPeerId(peerId);
  return { store: createDurableStore(doc), doc };
}

/** An attached store (for the doc.transaction / undo pins), mirroring nonundoable.test.ts. */
function mkAttached(peerId: number) {
  const { store, doc } = mkStore(peerId);
  const world = createWorld();
  const att = attachDurable(world, store);
  return { store, doc, world, att };
}

/** This peer's own oplog change messages, in order (distinct `strata:<n>` never coalesce — finding 3). */
function myMessages(doc: LoroDoc): (string | undefined)[] {
  return (doc.getAllChanges().get(doc.peerIdStr) ?? []).map((c) => c.message);
}

/** The `strata:<n>` sequence numbers this peer has sealed, in order. */
function strataSeqs(doc: LoroDoc): number[] {
  const out: number[] = [];
  for (const m of myMessages(doc)) if (m && STRATA.test(m)) out.push(Number(m.slice("strata:".length)));
  return out;
}

/** How many warn calls were the untagged-writer notice specifically (isolates it from any other warn). */
function untaggedWarnCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes("no strata tag")).length;
}

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — seal is tagged and sequenced (petition 3b; 005 §10.11)", () => {
  it("seals a meta write as a strata-tagged commit", () => {
    const { store, doc } = mkStore(1);
    store.metaTransaction((m) => m.set("engine.version", "1.4.0"));
    const msgs = myMessages(doc);
    expect(msgs[msgs.length - 1]).toMatch(STRATA); // the latest change is the meta seal, strata-tagged
  });

  it("an empty callback commits nothing and burns no strata sequence", () => {
    const { store, doc } = mkStore(1);
    store.snapshot.commit(() => store.snapshot.spawn(K("1-0"))); // a real commit → strata:1
    const seqsBefore = strataSeqs(doc);
    const changeCountBefore = myMessages(doc).length;

    store.metaTransaction(() => {}); // empty — nothing staged

    expect(myMessages(doc).length).toBe(changeCountBefore); // no new change appeared
    expect(strataSeqs(doc)).toEqual(seqsBefore); // no sequence burned

    store.snapshot.commit(() => store.snapshot.spawn(K("1-1"))); // the next real commit
    expect(Math.max(...strataSeqs(doc))).toBe(Math.max(...seqsBefore) + 1); // contiguous — nothing burned
  });

  it("a read-only callback (only get) commits nothing", () => {
    const { store, doc } = mkStore(1);
    store.metaTransaction((m) => m.set("engine.k", "v")); // one real meta seal
    const changeCountAfterWrite = myMessages(doc).length;

    let read: unknown;
    store.metaTransaction((m) => {
      read = m.get("engine.k");
    }); // reads only → nothing staged → no seal
    expect(read).toBe("v");
    expect(myMessages(doc).length).toBe(changeCountAfterWrite); // no extra change from the read-only tx
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — value discipline", () => {
  it("reserves the docId key: set() throws and the doc is unchanged", () => {
    const { store, doc } = mkStore(1);
    const docIdBefore = store.snapshot.readMeta(DOC_ID_KEY);
    const changeCountBefore = myMessages(doc).length;

    expect(() => store.metaTransaction((m) => m.set(DOC_ID_KEY, "hijacked"))).toThrow(/reserved/i);

    expect(store.snapshot.readMeta(DOC_ID_KEY)).toBe(docIdBefore); // untouched
    expect(store.docId).toBe(docIdBefore); // the store's frozen docId agrees
    expect(myMessages(doc).length).toBe(changeCountBefore); // no stray commit / no seq burn
  });

  it("rejects non-primitive values (object / null / undefined)", () => {
    const { store } = mkStore(1);
    expect(() => store.metaTransaction((m) => m.set("engine.o", {} as unknown as string))).toThrow(
      /string \| number \| boolean/,
    );
    expect(() => store.metaTransaction((m) => m.set("engine.n", null as unknown as string))).toThrow();
    expect(() => store.metaTransaction((m) => m.set("engine.u", undefined as unknown as string))).toThrow();
  });

  it("accepts string / number / boolean and reads them back through get()", () => {
    const { store } = mkStore(1);
    store.metaTransaction((m) => {
      m.set("engine.s", "v1");
      m.set("engine.n", 42);
      m.set("engine.b", true);
    });

    let s: unknown, n: unknown, b: unknown, absent: unknown;
    store.metaTransaction((m) => {
      s = m.get("engine.s");
      n = m.get("engine.n");
      b = m.get("engine.b");
      absent = m.get("engine.missing");
    });
    expect(s).toBe("v1");
    expect(n).toBe(42);
    expect(b).toBe(true);
    expect(absent).toBeUndefined();
  });

  it("get() reads foreign non-primitive junk as absent", () => {
    const { store, doc } = mkStore(1);
    // A hostile/legacy writer puts a CONTAINER at a meta key straight on the raw doc, and COMMITS it (so it
    // is not left pending — an uncommitted op would otherwise be swept into the next metaTransaction's seal).
    doc.getMap("meta").setContainer("engine.bad", new LoroMap());
    doc.commit();

    let read: unknown = "sentinel";
    store.metaTransaction((m) => {
      read = m.get("engine.bad");
    });
    expect(read).toBeUndefined(); // a container value reads as absent — never leaked
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — the editor is closed after the callback", () => {
  it("a leaked editor reference throws on get and set", () => {
    const { store } = mkStore(1);
    let leaked!: MetaEditor;
    store.metaTransaction((m) => {
      leaked = m;
    });
    expect(() => leaked.get("engine.x")).toThrow(/closed/);
    expect(() => leaked.set("engine.x", "1")).toThrow(/closed/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — excluded from undo (petition 3b; 005 §10.11)", () => {
  it("a user transaction reverts on undo while the meta write survives, and the meta commit adds no step", () => {
    const { store } = mkAttached(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[MTPos, { x: 1, y: 1 }]] }));
    const key = store.keyOf(h)!;
    expect(store.canUndo()).toBe(true);

    store.metaTransaction((m) => m.set("engine.version", "1.4.0"));
    expect(store.canUndo()).toBe(true); // still exactly the user's one step — meta pushed nothing

    expect(store.undo()).toBe(true);
    expect(store.snapshot.hasEntity(key)).toBe(false); // the USER edit reverted
    expect(store.snapshot.readMeta("engine.version")).toBe("1.4.0"); // meta value untouched by the undo
    expect(store.canUndo()).toBe(false); // the meta commit contributed no undo step
  });

  it("a store whose only commits are meta cannot undo", () => {
    const { store } = mkStore(1);
    store.metaTransaction((m) => m.set("engine.version", "1"));
    expect(store.canUndo()).toBe(false);
    expect(store.undo()).toBe(false); // empty stack — nothing to revert
  });

  it("a meta write between an undo and a redo does not clear the redo stack", () => {
    const { store } = mkAttached(1);
    const h = store.transaction((tx) => tx.spawn({ components: [[MTPos, { x: 1, y: 1 }]] }));
    const key = store.keyOf(h)!;
    expect(store.undo()).toBe(true);
    expect(store.canRedo()).toBe(true);

    store.metaTransaction((m) => m.set("engine.version", "1")); // excluded origin → must not clear redo

    expect(store.canRedo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.snapshot.hasEntity(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — transparent to translation (no batch, no untagged warn)", () => {
  it("produces no local ChangeBatch", () => {
    const { store } = mkStore(1);
    const seen: ChangeBatch[] = [];
    store.snapshot.subscribe((b) => seen.push(b));
    store.metaTransaction((m) => m.set("engine.schema", "v3"));
    expect(seen).toEqual([]); // meta is transparent — the seal surfaces no event
  });

  it("a peer importing the export sees no batch and no untagged-writer warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = mkStore(1);
      a.store.metaTransaction((m) => m.set("engine.schema", "v3"));
      const aBytes = a.store.snapshot.export();

      const b = mkStore(2);
      b.store.snapshot.commit(() => b.store.snapshot.spawn(K("2-0"))); // local state → per-change path
      b.store.applyRemote(aBytes);

      expect(b.store.drainPending()).toEqual([]); // a's meta-only commits surface no batch
      expect(untaggedWarnCount(warn)).toBe(0); // strata-tagged (and meta-only) → no untagged warn
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("untagged-writer warn — meta-only exemption (petition 3b; 005 §10.11)", () => {
  it("a legacy untagged META-ONLY commit does not trip the untagged-writer warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A pre-metaTransaction embedder stamps engine meta straight on the raw doc, committed WITHOUT a
      // strata message — the exact shape metaTransaction now replaces.
      const legacy = new LoroDoc();
      legacy.setPeerId(1);
      legacy.getMap("meta").set("engine.version", "legacy-1");
      legacy.commit(); // untagged
      const bytes = legacy.export({ mode: "snapshot" });

      const recv = mkStore(2);
      recv.store.snapshot.commit(() => recv.store.snapshot.spawn(K("2-0"))); // local state → per-change path
      recv.store.applyRemote(bytes);

      expect(untaggedWarnCount(warn)).toBe(0); // meta-only → exempt
      expect(recv.store.drainPending()).toEqual([]); // and it carried no ECS facts
    } finally {
      warn.mockRestore();
    }
  });

  it("a legacy untagged commit touching meta AND entities still warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacy = new LoroDoc();
      legacy.setPeerId(1);
      legacy.getMap("meta").set("engine.version", "legacy-2");
      legacy.getMap("entities").setContainer("1-0", new LoroMap()).set("exists", true);
      legacy.commit(); // ONE untagged commit touching BOTH the meta root AND an entity
      const bytes = legacy.export({ mode: "snapshot" });

      const recv = mkStore(2);
      recv.store.snapshot.commit(() => recv.store.snapshot.spawn(K("2-0"))); // local state → per-change path
      recv.store.applyRemote(bytes);

      expect(untaggedWarnCount(warn)).toBe(1); // not meta-only → boundary is best-effort → warn fires
      expect(recv.store.drainPending().length).toBeGreaterThan(0); // the entity fact came through
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — reentrancy", () => {
  it("metaTransaction inside doc.transaction throws", () => {
    const { store } = mkAttached(1);
    expect(() =>
      store.transaction(() => {
        store.metaTransaction((m) => m.set("engine.x", "1"));
      }),
    ).toThrow(/inside doc\.transaction/);
  });

  it("doc.transaction inside a metaTransaction callback throws via the commit guard", () => {
    const { store } = mkAttached(1);
    expect(() =>
      store.metaTransaction(() => {
        store.transaction(() => {}); // reaches snapshot.commit, which sees the open scope
      }),
    ).toThrow(/nested commit/);
  });

  it("metaTransaction inside a metaTransaction callback throws via the commit guard", () => {
    const { store } = mkStore(1);
    expect(() =>
      store.metaTransaction(() => {
        store.metaTransaction((m) => m.set("engine.x", "1"));
      }),
    ).toThrow(/during commit/);
  });

  it("a throwing callback still seals whatever it staged", () => {
    const { store } = mkStore(1);
    expect(() =>
      store.metaTransaction((m) => {
        m.set("engine.partial", "kept");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    let v: unknown;
    store.metaTransaction((m) => {
      v = m.get("engine.partial");
    });
    expect(v).toBe("kept"); // the staged key sealed in `finally` before the error propagated
  });
});

// ---------------------------------------------------------------------------------------------------
describe("metaTransaction — pre-attach and cross-peer", () => {
  it("works on a store never attached to a world", () => {
    const { store } = mkStore(1); // never attached
    store.metaTransaction((m) => m.set("engine.version", "1.0"));
    expect(store.snapshot.readMeta("engine.version")).toBe("1.0");
  });

  it("two peers writing different meta keys converge on exchange", () => {
    const a = mkStore(1);
    const b = mkStore(2);
    a.store.metaTransaction((m) => m.set("engine.a", "A"));
    b.store.metaTransaction((m) => m.set("engine.b", "B"));

    const aBytes = a.store.snapshot.export();
    const bBytes = b.store.snapshot.export();
    a.store.applyRemote(bBytes);
    b.store.applyRemote(aBytes);

    expect(a.store.snapshot.readMeta("engine.a")).toBe("A");
    expect(a.store.snapshot.readMeta("engine.b")).toBe("B");
    expect(b.store.snapshot.readMeta("engine.a")).toBe("A");
    expect(b.store.snapshot.readMeta("engine.b")).toBe("B");
  });
});

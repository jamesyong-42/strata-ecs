import { describe, expect, it } from "vitest";
import {
  type ECSStore,
  type Entity,
  type EntityKey,
  RuntimeStore,
  createWorld,
  defineComponent,
  defineQuery,
  entityKey,
} from "./index";

describe("ECSStore contract", () => {
  it("a RuntimeStore is fully usable through the representation-agnostic ECSStore interface", () => {
    const C = defineComponent<{ v: number }>("CE", { v: "u32" });
    // Hold the concrete store ONLY as the abstract contract (what World/ctx and Parts II–IV do).
    const store: ECSStore = new RuntimeStore();
    const e = store.spawn({ components: [[C, { v: 7 }]] });
    expect(store.has(e, C)).toBe(true);
    expect(store.read(e, C)).toEqual({ v: 7 });
    store.writeComponent(e, C, { v: 9 });
    expect(store.get(e, C)).toEqual({ v: 9 });

    let count = 0;
    store.query(defineQuery([C])).each((b) => {
      for (const _r of b) count++;
    });
    expect(count).toBe(1);
    expect(store.firstOf(defineQuery([C]))).toBe(e);

    store.destroy(e);
    expect(store.isAlive(e)).toBe(false);
  });
});

const Ref = defineComponent<{ key: EntityKey | null; label: string }>("RefE", {
  key: "key",
  label: "string",
});

describe("EntityKey (branded key field, §14.3)", () => {
  it("round-trips a branded key value and survives a snapshot as a plain string", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Ref, { key: entityKey("doc:42"), label: "a" }]] });
    expect(w.read(e, Ref).key).toBe("doc:42"); // reads back the string, typed EntityKey | null

    const w2 = createWorld();
    w2.import(w.export());
    const e2 = w2.firstOf(defineQuery([Ref])) as Entity;
    expect(w2.read(e2, Ref).key).toBe("doc:42"); // key is a string column → serializes as itself
  });

  it("distinguishes a null key from a set one", () => {
    const w = createWorld();
    const e = w.spawn({ components: [[Ref, { key: null, label: "b" }]] });
    expect(w.read(e, Ref).key).toBe(null);
  });

  it("the brand rejects a plain string on a typed value write (addComponent/edit)", () => {
    const w = createWorld();
    const e = w.spawn();
    // @ts-expect-error — a plain string is not an EntityKey; the brand catches the mis-typed ref.
    w.addComponent(e, Ref, { key: "not-branded", label: "x" });
    // and the correctly-branded write type-checks:
    w.edit(e).set(Ref, { key: entityKey("doc:1"), label: "ok" });
    expect(w.read(e, Ref).key).toBe("doc:1");
  });
});

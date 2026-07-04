/**
 * `LoroEphemeralSnapshot` contract tests (Part IV M0, plan-part4.md "Acceptance").
 *
 * The adapter is thin, so these pin the SPIKE-VERIFIED behaviours the store (M1/M2) leans on:
 *   - round-trip: set → encodeChanged → apply → `remote` event carrying the whole blob (NaN/nested OK);
 *   - the E5 per-key LWW ordering contract: a stale, out-of-order blob is NEVER surfaced (finding 2);
 *   - `encodeKeys` subset: only the chosen keys cross, and applying refreshes/creates exactly those;
 *   - TTL `timeout` → despawn-shaped event; keepalive re-`set` refreshes (owner AND receiver), no flicker;
 *   - explicit `delete` → the despawn-shaped (`timeout`) event on the receiver (finding 5);
 *   - idempotent re-apply of an identical buffer surfaces NO event (finding 2);
 *   - `local` own-echo events; `encodeChanged` coalescing + null-when-clean.
 *
 * Timing tests use short real TTLs (the JS wrapper's cleanup runs every ttl/2, finding 4) with small
 * awaits — no fake timers, because the expiry lives in Loro's wasm timer, not JS we can advance.
 */

import { afterEach, describe, expect, it } from "vitest";
import { EphemeralStore } from "loro-crdt";
import { type EntityKey, entityKey } from "../core/field";
import { LoroEphemeralSnapshot } from "./loro-ephemeral-snapshot";
import type { EphemeralEvent } from "./types";

const k = (s: string): EntityKey => entityKey(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Track every store we make so we can clear its wasm cleanup timer between tests.
const made: EphemeralStore[] = [];
function store(ttlMs = 30_000): EphemeralStore {
  const s = new EphemeralStore(ttlMs);
  made.push(s);
  return s;
}
/** An adapter plus a live capture of the events it surfaces. */
function adapter(ttlMs = 30_000): { eph: LoroEphemeralSnapshot; events: EphemeralEvent[] } {
  const eph = new LoroEphemeralSnapshot(store(ttlMs));
  const events: EphemeralEvent[] = [];
  eph.subscribe((ev) => events.push(ev));
  return { eph, events };
}
afterEach(() => {
  for (const s of made.splice(0)) s.destroy();
});

describe("round-trip: set → encodeChanged → apply", () => {
  it("surfaces a remote event carrying the whole blob on the receiver", () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { CursorPos: { x: 1, y: 2 }, Sel: true });
    const bytes = A.eph.encodeChanged();
    expect(bytes).not.toBeNull();

    B.eph.apply(bytes!);
    const remote = B.events.filter((e) => e.kind === "remote");
    expect(remote).toHaveLength(1);
    expect(remote[0].key).toBe("alice-0");
    expect(remote[0].value).toEqual({ CursorPos: { x: 1, y: 2 }, Sel: true });
  });

  it("round-trips NaN / ±Infinity / nested objects / arrays with fidelity (finding 6)", () => {
    const A = adapter();
    const B = adapter();
    const blob = {
      C: { x: NaN, y: Infinity, z: -Infinity, n: 42 },
      nested: { a: { b: [1, 2, NaN] } },
      ref: { key: "shape-7" },
    };
    A.eph.set(k("alice-0"), blob);
    B.eph.apply(A.eph.encodeChanged()!);

    const v = B.events.find((e) => e.kind === "remote")!.value as typeof blob;
    expect(Number.isNaN(v.C.x)).toBe(true);
    expect(v.C.y).toBe(Infinity);
    expect(v.C.z).toBe(-Infinity);
    expect(v.C.n).toBe(42);
    expect(v.nested.a.b[0]).toBe(1);
    expect(Number.isNaN(v.nested.a.b[2] as number)).toBe(true);
    expect(v.ref).toEqual({ key: "shape-7" });
  });

  it("own set surfaces a local echo (with value); receiver-less encode returns null when clean", () => {
    const A = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    const local = A.events.filter((e) => e.kind === "local");
    expect(local).toHaveLength(1);
    expect(local[0].key).toBe("alice-0");
    expect(local[0].value).toEqual({ v: 1 });

    A.eph.encodeChanged(); // drains the dirty set
    expect(A.eph.encodeChanged()).toBeNull(); // nothing dirty → null (clean contract)
  });

  it("coalesces repeated sets of one key to the latest value in a single buffer", () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    A.eph.set(k("alice-0"), { v: 2 });
    A.eph.set(k("alice-0"), { v: 3 });
    B.eph.apply(A.eph.encodeChanged()!);
    const remote = B.events.filter((e) => e.kind === "remote");
    expect(remote).toHaveLength(1);
    expect(remote[0].value).toEqual({ v: 3 });
  });
});

describe("E5 — per-key LWW ordering (finding 2)", () => {
  it("drops a stale, out-of-order blob: never surfaces it, view stays newest", async () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    const b1 = A.eph.encodeChanged()!;
    await sleep(5); // distinct wall-clock ms so v2's blob out-timestamps v1's (finding 2)
    A.eph.set(k("alice-0"), { v: 2 });
    const b2 = A.eph.encodeChanged()!;

    B.eph.apply(b2); // newer first
    B.eph.apply(b1); // stale older second — must be dropped, never surfaced

    const remote = B.events.filter((e) => e.kind === "remote");
    expect(remote).toHaveLength(1); // ONLY v2 surfaced; the stale apply produced no event
    expect(remote[0].value).toEqual({ v: 2 });
  });

  it("idempotent re-apply of an identical buffer surfaces no second event", () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    const buf = A.eph.encodeChanged()!;
    B.eph.apply(buf);
    B.eph.apply(buf); // identical → empty event arrays → nothing surfaced
    expect(B.events.filter((e) => e.kind === "remote")).toHaveLength(1);
  });
});

describe("encodeKeys — chosen subset (006 B5 keepalive)", () => {
  it("crosses only the chosen keys, not others in the store", () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { a: 1 });
    A.eph.set(k("alice-1"), { b: 2 });
    A.eph.set(k("bob-9"), { c: 3 }); // a learned remote key — must NOT be re-broadcast (006 B5)

    const bytes = A.eph.encodeKeys([k("alice-0"), k("alice-1")]);
    expect(bytes).not.toBeNull();
    B.eph.apply(bytes!);

    const keys = B.events.filter((e) => e.kind === "remote").map((e) => e.key).sort();
    expect(keys).toEqual(["alice-0", "alice-1"]);
  });

  it("returns null when none of the requested keys are present", () => {
    const A = adapter();
    expect(A.eph.encodeKeys([k("ghost-0")])).toBeNull();
  });
});

describe("TTL timeout + keepalive (finding 4)", () => {
  it("fires a timeout (despawn-shaped) event when a received key expires", async () => {
    const A = adapter();
    const B = adapter(150); // short TTL on the RECEIVER
    A.eph.set(k("alice-0"), { v: 1 });
    B.eph.apply(A.eph.encodeChanged()!);
    expect(B.events.some((e) => e.kind === "remote")).toBe(true);

    await sleep(300); // > ttl + one cleanup tick (ttl/2)
    const timeouts = B.events.filter((e) => e.kind === "timeout" && e.key === "alice-0");
    expect(timeouts.length).toBeGreaterThanOrEqual(1);
  });

  it("keepalive re-set keeps the OWNER's own idle key alive (no spurious own-key timeout)", async () => {
    const A = adapter(150); // short TTL owner
    A.eph.set(k("alice-0"), { v: 1 });
    for (let i = 0; i < 6; i++) {
      await sleep(50); // ttl/3
      A.eph.encodeKeys([k("alice-0")]); // keepalive: re-stamps on the REAL store
    }
    // No timeout for the own key, and it is still present.
    expect(A.events.some((e) => e.kind === "timeout" && e.key === "alice-0")).toBe(false);
    // Still encodable (present) after the idle period.
    expect(A.eph.encodeKeys([k("alice-0")])).not.toBeNull();
  });

  it("keepalive buffers keep a RECEIVER's copy alive across the TTL window", async () => {
    const A = adapter();
    const B = adapter(150);
    A.eph.set(k("alice-0"), { v: 1 });
    B.eph.apply(A.eph.encodeChanged()!);
    for (let i = 0; i < 6; i++) {
      await sleep(50); // ttl/3
      B.eph.apply(A.eph.encodeKeys([k("alice-0")])!); // fresh-stamped keepalive
    }
    expect(B.events.some((e) => e.kind === "timeout" && e.key === "alice-0")).toBe(false);
  });
});

describe("explicit delete (finding 5)", () => {
  it("propagates a despawn-shaped (timeout) event to the receiver", async () => {
    const A = adapter();
    const B = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    B.eph.apply(A.eph.encodeChanged()!);
    expect(B.events.some((e) => e.kind === "remote" && e.key === "alice-0")).toBe(true);

    await sleep(5); // the tombstone must out-timestamp the last set (finding 5)
    A.eph.delete(k("alice-0"));
    const tombs = A.eph.encodeDeletes();
    expect(tombs).toHaveLength(1);
    for (const t of tombs) B.eph.apply(t);

    const despawn = B.events.filter((e) => e.kind === "timeout" && e.key === "alice-0");
    expect(despawn).toHaveLength(1);
  });

  it("delete surfaces a local echo on the owner and drains from encodeDeletes once", () => {
    const A = adapter();
    A.eph.set(k("alice-0"), { v: 1 });
    A.eph.delete(k("alice-0"));
    expect(A.events.some((e) => e.kind === "local" && e.key === "alice-0" && e.value === undefined)).toBe(true);
    expect(A.eph.encodeDeletes()).toHaveLength(1);
    expect(A.eph.encodeDeletes()).toHaveLength(0); // drained
  });
});

describe("dispose", () => {
  it("stops surfacing events after dispose", () => {
    const A = adapter();
    A.eph.dispose();
    A.eph.set(k("alice-0"), { v: 1 }); // source still mutates, but no listener fan-out
    expect(A.events).toHaveLength(0);
  });
});

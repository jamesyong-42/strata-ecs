/**
 * `world.resourceStamp` (petition 10) — pull-based resource change detection: a monotonic
 * per-WRITE counter behind its own armed flag, the `orderStamp` mechanics applied to
 * `setResource`/`removeResource`. The contract under test: dormant until the first read arms it
 * (pre-arming writes are unstamped — a poller baselines at 0); EVERY effective write moves the
 * number, same-frame rewrites included (the reason it is a counter, NOT the reactive layer's
 * frame stamp); absent-resource removes are stampless; stamps die on `reset()`; and the whole
 * thing works in a world that never armed reactivity — that independence is the point.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, defineResource } from "./index";

// Own names — the schema registry is process-global per test file.
const Camera = defineResource("RSTAMPCamera", { x: "f32", y: "f32" });
const Gesture = defineResource("RSTAMPGesture", { active: "bool" });

afterEach(() => vi.restoreAllMocks());

describe("resourceStamp — arming and baseline", () => {
  it("reads 0 before any write, and pre-arming writes are unstamped (poller baselines at 0)", () => {
    const w = createWorld();
    expect(w.resourceStamp(Camera)).toBe(0); // arms
    const w2 = createWorld();
    w2.setResource(Camera, { x: 1, y: 2 }); // BEFORE the first read — unstamped by design
    expect(w2.resourceStamp(Camera)).toBe(0); // arms; the earlier write is not visible
    w2.setResource(Camera, { x: 3, y: 4 }); // first post-arming write
    expect(w2.resourceStamp(Camera)).toBeGreaterThan(0);
  });
});

describe("resourceStamp — every effective write moves the number", () => {
  it("bumps strictly on every setResource, same-frame back-to-back writes included", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    w.setResource(Camera, { x: 2, y: 2 }); // same frame, no tick/notify between
    const s2 = w.resourceStamp(Camera);
    w.setResource(Camera, { x: 2, y: 2 }); // same VALUE — still a write, still bumps
    const s3 = w.resourceStamp(Camera);
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });
  it("updateResource bumps (it routes through setResource)", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    w.updateResource(Camera, (v) => ({ ...v, x: v.x + 1 }));
    expect(w.resourceStamp(Camera)).toBeGreaterThan(s1);
  });
  it("removeResource bumps when present; an absent remove is stampless", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    w.removeResource(Camera);
    const s2 = w.resourceStamp(Camera);
    expect(s2).toBeGreaterThan(s1);
    w.removeResource(Camera); // already absent — Map.delete false, no stamp
    expect(w.resourceStamp(Camera)).toBe(s2);
  });
  it("stamps are independent per resource", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    const g0 = w.resourceStamp(Gesture);
    w.setResource(Camera, { x: 1, y: 1 });
    expect(w.resourceStamp(Gesture)).toBe(g0); // untouched resource unchanged
    expect(w.resourceStamp(Camera)).toBeGreaterThan(0);
  });
});

describe("resourceStamp — reset and reactive independence", () => {
  it("stamps die on reset(); a post-reset write still reads as changed", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    expect(s1).toBeGreaterThan(0);
    w.reset();
    expect(w.resourceStamp(Camera)).toBe(0); // cleared with the values
    w.setResource(Camera, { x: 9, y: 9 });
    const s2 = w.resourceStamp(Camera);
    expect(s2).toBeGreaterThan(0);
    expect(s2).not.toBe(s1); // the counter stays monotonic — a stale pre-reset baseline still differs
  });
  it("works in a reactive-armed world too (the two gates are independent)", () => {
    const w = createWorld();
    w.reactive.observeResource(Camera, () => {}); // arms reactiveOn
    w.resourceStamp(Camera); // arms poll stamps
    w.setResource(Camera, { x: 1, y: 1 });
    expect(w.resourceStamp(Camera)).toBeGreaterThan(0);
  });
});

describe("resourceStamp — DEV misuse guard", () => {
  it("a handle that is not the registered resource warns and reads a forever-0, without arming", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = createWorld();
    const impostor = { ...Camera }; // same id/name, different identity — never the stamped handle
    expect(w.resourceStamp(impostor)).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    // The guarded path returned BEFORE arming: a pre-first-real-read write stays unstamped.
    w.setResource(Camera, { x: 1, y: 1 });
    expect(w.resourceStamp(Camera)).toBe(0); // real first read arms only now
  });
});

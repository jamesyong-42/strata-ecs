/**
 * `world.resourceStamp` (petition 10) — pull-based resource change detection: a monotonic
 * per-WRITE counter behind its own armed flag, the `orderStamp` mechanics applied to
 * `setResource`/`removeResource`. The contract under test: dormant until the first read of ANY
 * resource arms collection WORLD-WIDE (pre-arming writes are unstamped — an early poller
 * baselines at 0); EVERY effective write moves the
 * number, same-frame rewrites included (the reason it is a counter, NOT the reactive layer's
 * frame stamp); absent-resource removes are stampless; `reset()` BUMPS every held resource's
 * stamp (a wholesale value-wipe is a change — review finding 1; the number never moves backward);
 * and the whole thing works in a world that never armed reactivity — that independence is the point.
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
  it("arming is WORLD-WIDE: the first read of ANY resource stamps every later write (review finding)", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arms via Camera…
    w.setResource(Gesture, { active: true }); // …and a never-read resource's write is stamped
    expect(w.resourceStamp(Gesture)).toBeGreaterThan(0); // its own first read sees it
  });
  it("polling never arms the reactive layer (the cost claim's other direction, pinned)", () => {
    const w = createWorld();
    w.resourceStamp(Camera);
    w.setResource(Camera, { x: 1, y: 1 });
    expect(w.isReactiveEnabled).toBe(false);
  });
});

describe("resourceStamp — every effective write moves the number", () => {
  it("bumps strictly on every setResource — same-frame rewrites AND across tick boundaries", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    w.setResource(Camera, { x: 2, y: 2 }); // same frame, no tick/notify between
    const s2 = w.resourceStamp(Camera);
    w.tick([]); // a frame boundary neither bumps nor clears — armed state survives (acceptance row)
    expect(w.resourceStamp(Camera)).toBe(s2);
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
  it("reset() bumps every held resource's stamp — the wipe is observable, the number never regresses", () => {
    const w = createWorld();
    w.resourceStamp(Camera); // arm
    w.setResource(Camera, { x: 1, y: 1 });
    const s1 = w.resourceStamp(Camera);
    expect(s1).toBeGreaterThan(0);
    w.reset();
    const s2 = w.resourceStamp(Camera);
    expect(s2).toBeGreaterThan(s1); // the transition to undefined moved the number
    w.setResource(Camera, { x: 9, y: 9 });
    expect(w.resourceStamp(Camera)).toBeGreaterThan(s2); // and writes keep climbing from there
  });

  it("the finding-1 repro: a value observed at baseline 0 cannot vanish invisibly through reset", () => {
    const w = createWorld();
    w.setResource(Camera, { x: 1, y: 1 }); // pre-arm write
    const base = w.resourceStamp(Camera); // arms; reads 0 — and the poller caches the visible value
    expect(base).toBe(0);
    expect(w.getResource(Camera)).toEqual({ x: 1, y: 1 });
    w.reset();
    expect(w.getResource(Camera)).toBeUndefined();
    expect(w.resourceStamp(Camera)).toBeGreaterThan(base); // the wipe is reported
  });

  it("an unheld resource gains no stamp from reset (only held values transition)", () => {
    const w = createWorld();
    w.resourceStamp(Gesture); // arm; Gesture never written
    w.setResource(Camera, { x: 1, y: 1 });
    w.reset();
    expect(w.resourceStamp(Gesture)).toBe(0); // nothing was held, nothing to observe
  });
  it("works in a reactive-armed world too (the two gates are independent)", () => {
    const w = createWorld();
    w.reactive.observeResource(Camera, () => {}); // arms reactiveOn
    w.resourceStamp(Camera); // arms poll stamps
    w.setResource(Camera, { x: 1, y: 1 });
    expect(w.resourceStamp(Camera)).toBeGreaterThan(0);
  });
});

describe("resourceStamp — DEV misuse guard (diagnostics-only, build-invariant reads)", () => {
  it("an impostor handle warns ONCE, still arms, and reads the id's live stamp (same as prod)", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = createWorld();
    const impostor = { ...Camera }; // same id/name, different identity — never the registered handle
    expect(w.resourceStamp(impostor)).toBe(0); // arms (review finding 2: arming must not differ by build)
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).not.toMatch(/strata: strata:/); // finding 3: no double prefix
    w.setResource(Camera, { x: 1, y: 1 }); // post-arming write — stamped
    const real = w.resourceStamp(Camera);
    expect(real).toBeGreaterThan(0);
    expect(w.resourceStamp(impostor)).toBe(real); // keyed by id: the reading itself is not wrong
    expect(spy).toHaveBeenCalledOnce(); // finding 4: warn-once per id, the poll path stays quiet
  });
});

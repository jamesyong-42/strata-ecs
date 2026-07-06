// @vitest-environment happy-dom
/**
 * `@vibecook/strata-ecs/tools` observer lifecycle smoke (review-part1 R7). The recorder is unit-tested next door;
 * this pins the OTHER ~90% — the DOM panel's full attach→render→dispose teardown, which nothing
 * exercised. dispose() is a 5-part teardown (interval, timeline, recorder, loop-detach, panel/DOM);
 * a leak here is invisible until a host app mounts the panel twice.
 *
 * The panel polls on `window.setInterval` (POLL_MS), so we drive it with fake timers and query the
 * resulting DOM. We stay on the default `entities` tab throughout: the `timeline` tab drives a canvas
 * via requestAnimationFrame, which happy-dom stubs too thinly to assert on — and the lifecycle
 * (not the pixels) is the value here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, defineComponent } from "../../core/index";
import { attachObserver } from "../index";

// The panel needs ResizeObserver to construct; happy-dom may not ship it, and the panel only needs it
// to not throw (it observes for layout persistence, which these tests never trigger). Stub if absent.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const g = globalThis as { ResizeObserver?: unknown };
if (typeof g.ResizeObserver === "undefined") g.ResizeObserver = ResizeObserverStub;

const TLPos = defineComponent("TLPos", { x: "f32", y: "f32" });
const POLL_MS = 120; // mirrors attachObserver's internal poll rate (index.ts POLL_MS)

let container: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.useRealTimers();
  container.remove();
  document.body.innerHTML = "";
  localStorage.clear(); // the panel persists layout there — keep tests independent
});

/** Entity rows the panel has rendered into its virtualized list. */
function renderedRows(): NodeListOf<Element> {
  return container.querySelectorAll(".strata-obs-rows [data-e]");
}

describe("strata-ecs/tools observer lifecycle", () => {
  it("attaches (both roster entries + one interval), renders entity rows, then disposes cleanly", () => {
    const world = createWorld();
    for (let i = 0; i < 6; i++) world.spawn({ components: [[TLPos, { x: i, y: i }]] });

    const obs = attachObserver(world, { container });

    // attach wired BOTH world-observers (the lifecycle recorder + the loop-stats recorder) and one poll.
    expect(world.runtime.observers?.length).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    // tick a few frames, then let the poll fire — the entities tab renders rows from the archetypes.
    world.tick([]);
    world.tick([]);
    vi.advanceTimersByTime(POLL_MS);

    expect(container.querySelector(".strata-obs")).not.toBeNull();
    expect(renderedRows().length).toBeGreaterThan(0);
    expect(container.querySelector(".strata-obs-summary")?.textContent).toContain("6 entities");

    obs.dispose();

    // (1) the poll interval is cleared, (2) BOTH roster entries detached, (3) the panel DOM is gone.
    expect(vi.getTimerCount()).toBe(0);
    expect(world.runtime.observers).toBeNull();
    expect(container.querySelector(".strata-obs")).toBeNull();

    // and it stays inert: further time + world churn produces no DOM, no re-attachment, no callbacks.
    vi.advanceTimersByTime(POLL_MS * 5);
    world.spawn();
    world.tick([]);
    world.destroy(world.spawn());
    expect(container.querySelector(".strata-obs")).toBeNull();
    expect(world.runtime.observers).toBeNull();
  });

  it("a fresh attach reflects a SECOND world, not the disposed one", () => {
    const worldA = createWorld();
    for (let i = 0; i < 3; i++) worldA.spawn({ components: [[TLPos, { x: i, y: i }]] });
    const obsA = attachObserver(worldA, { container });
    vi.advanceTimersByTime(POLL_MS);
    expect(container.querySelector(".strata-obs-summary")?.textContent).toContain("3 entities");
    obsA.dispose();
    expect(worldA.runtime.observers).toBeNull();

    const worldB = createWorld();
    for (let i = 0; i < 9; i++) worldB.spawn();
    const obsB = attachObserver(worldB, { container });

    expect(worldB.runtime.observers?.length).toBe(2);
    vi.advanceTimersByTime(POLL_MS);
    expect(container.querySelector(".strata-obs-summary")?.textContent).toContain("9 entities");
    expect(renderedRows().length).toBeGreaterThan(0);

    obsB.dispose();
    expect(worldB.runtime.observers).toBeNull();
  });
});

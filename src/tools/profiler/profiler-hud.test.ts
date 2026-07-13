// @vitest-environment happy-dom
/**
 * `attachProfiler` overlay lifecycle smoke — the recorder is unit-tested next door; this pins
 * the DOM shell: attach→render→expand→reset→dispose. Mirrors lifecycle.test.ts's rationale
 * (a teardown leak is invisible until a host mounts twice). happy-dom's canvas returns a null
 * 2d context, which the overlay treats as "skip sparkline drawing" — the text/DOM paths are
 * what these tests assert. Renders are driven synchronously through the head-click and reset
 * paths, not the rAF loop (happy-dom's rAF is too thin to schedule reliably under fake time).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorld, defineTickSystem, phase } from "../../core/index";
import { attachProfiler, type ProfilerHandle } from "./hud";

let container: HTMLElement;
let handle: ProfilerHandle | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  container.remove();
});

const $ = (sel: string): HTMLElement => {
  const el = container.querySelector(sel);
  expect(el, `expected ${sel} in the overlay`).not.toBeNull();
  return el as HTMLElement;
};

describe("attachProfiler overlay", () => {
  it("mounts collapsed with a waiting head, expands on click, and shows live sections", () => {
    const w = createWorld();
    handle = attachProfiler(w, { container });

    const root = $(".strata-prof");
    expect(root.classList.contains("open")).toBe(false);
    expect(root.classList.contains("br")).toBe(true); // default corner
    expect($(".strata-prof-tick").textContent).toBe("waiting for ticks");

    $(".strata-prof-head").click();
    expect(root.classList.contains("open")).toBe(true);
    expect($(".strata-prof-body").textContent).toContain("frame");
    expect($(".strata-prof-btn").textContent).toContain("reset");

    const spin = defineTickSystem(() => {}, { name: "spin" });
    w.tick([phase("p", [spin])]);
    w.tick([phase("p", [spin])]);
    handle.lane("paint", 3);

    // collapse + re-expand re-renders the body from fresh stats
    $(".strata-prof-head").click();
    $(".strata-prof-head").click();
    expect($(".strata-prof-fps").textContent).not.toBe("— fps");
    const body = $(".strata-prof-body").textContent ?? "";
    expect(body).toContain("hottest systems");
    expect(body).toContain("spin");
    expect(body).toContain("worst frame");
    expect(body).toContain("lanes");
    expect(body).toContain("paint");
  });

  it("escapes untrusted names — a quote-bearing phase cannot break out of the title attribute", () => {
    const w = createWorld();
    handle = attachProfiler(w, { container, expanded: true });
    const evilPhase = `x" onmouseover="alert(1)`;
    const evilSystem = `<b>&"'sys`;
    const spin = defineTickSystem(() => {}, { name: evilSystem });
    w.tick([phase(evilPhase, [spin])]);
    w.tick([phase(evilPhase, [spin])]);
    $(".strata-prof-head").click(); // close
    $(".strata-prof-head").click(); // open + fresh render

    const titles = [...container.querySelectorAll(".strata-prof-row[title]")].map((r) => r.getAttribute("title"));
    expect(titles).toContain(evilPhase); // round-trips intact — the quote stayed inside the attribute
    expect(container.querySelector("[onmouseover]")).toBeNull(); // no attribute breakout
    expect(container.querySelector(".strata-prof-body b")).toBeNull(); // name renders as text, not markup
    expect($(".strata-prof-body").textContent ?? "").toContain(evilSystem);
  });

  it("the reset button clears the window and the head returns to waiting", () => {
    const w = createWorld();
    handle = attachProfiler(w, { container, expanded: true });
    w.tick([]);
    w.tick([]);
    $(".strata-prof-head").click(); // close
    $(".strata-prof-head").click(); // open + fresh render
    expect(handle.stats().samples).toBe(1);

    $(".strata-prof-btn").click();
    expect(handle.stats().samples).toBe(0);
    expect(handle.stats().worst).toBeNull();
    expect($(".strata-prof-tick").textContent).toBe("waiting for ticks");
  });

  it("dispose removes the overlay, detaches from the world, and style injection stays idempotent", () => {
    const w = createWorld();
    handle = attachProfiler(w, { container });
    const second = attachProfiler(w, { container, corner: "tl" });
    expect(document.querySelectorAll("#strata-prof-style")).toHaveLength(1);
    expect(container.querySelectorAll(".strata-prof")).toHaveLength(2);

    second.dispose();
    expect(container.querySelectorAll(".strata-prof")).toHaveLength(1);

    const h = handle;
    handle = null;
    w.tick([]);
    w.tick([]);
    const before = h.stats().samples;
    h.dispose();
    expect(container.querySelectorAll(".strata-prof")).toHaveLength(0);
    w.tick([]); // detached — must neither throw nor record
    expect(h.stats().samples).toBe(before);
  });
});

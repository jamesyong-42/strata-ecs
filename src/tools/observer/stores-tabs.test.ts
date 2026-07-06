// @vitest-environment happy-dom
/**
 * `strata-ecs/tools` observer collab tabs (durable + ephemeral, TASK A2). These tabs are the ONLY
 * observer surface fed by structural interfaces the host satisfies with live collab stores — the tools
 * package never imports `strata-ecs/durable`/`ephemeral` (design §0), so these tests stub the interfaces
 * directly (a plain object with `entities()`/`readEntity()`, a plain `debugDump()`), exactly as the
 * package's own typecheck sees them. Setup mirrors lifecycle.test.ts: happy-dom, fake timers, the panel's
 * internal POLL_MS drives every render.
 *
 * What is pinned here: the opt-in tab strip (3 base tabs vs 5 with both options); the durable Δ (union of
 * baseline + loro, "—" for a missing side, the diff highlight EXACTLY on the disagreeing rows, filter,
 * the 200-row cap + footer); the ephemeral writer split (final -digits stripped, own group first + "(you)",
 * dashes in a peer-id preserved); null-getter placeholders; the persisted-but-absent-tab fallback; and the
 * load-bearing safety property — peer-controlled values are rendered as TEXT, never parsed as HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld } from "../../core/index";
import {
  attachObserver,
  type ObserverDurableSource,
  type ObserverEntityRecord,
  type ObserverEphemeralSource,
  type ObserverHandle,
  type ObserverSnapshotView,
} from "../index";

// The panel needs ResizeObserver to construct; happy-dom may not ship it (lifecycle.test.ts precedent).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const g = globalThis as { ResizeObserver?: unknown };
if (typeof g.ResizeObserver === "undefined") g.ResizeObserver = ResizeObserverStub;

const POLL_MS = 120; // mirrors attachObserver's internal poll rate (index.ts POLL_MS)

let container: HTMLElement;
let world: ReturnType<typeof createWorld>;
const handles: ObserverHandle[] = [];

/** attachObserver + track the handle so afterEach disposes every panel (interval + DOM). */
function attach(opts: Parameters<typeof attachObserver>[1]): ObserverHandle {
  const h = attachObserver(world, opts);
  handles.push(h);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  world = createWorld();
});

afterEach(() => {
  for (const h of handles.splice(0)) h.dispose();
  vi.useRealTimers();
  container.remove();
  document.body.innerHTML = "";
  localStorage.clear(); // the panel persists layout there — keep tests independent
});

/** A structural `ObserverSnapshotView` over a fixed key→record map (the stub the durable tab walks). */
function snapshotView(records: Record<string, ObserverEntityRecord>): ObserverSnapshotView {
  return {
    entities: () => Object.keys(records),
    readEntity: (key) => records[key],
  };
}

function rec(key: string, components: Record<string, unknown>): ObserverEntityRecord {
  return { key, components, tags: [], relations: {} };
}

const tabButtons = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".strata-obs-tab")];
const durRows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".strata-obs-durrow")];
const rowByKey = (key: string): HTMLElement | undefined =>
  durRows().find((r) => r.querySelector(".strata-obs-durkey")?.textContent === key);
const cols = (row: HTMLElement): string[] =>
  [...row.querySelectorAll(".strata-obs-durcol")].map((c) => c.textContent ?? "");

describe("strata-ecs/tools collab tabs — tab strip", () => {
  it("renders exactly the 3 base tabs when neither collab option is given (regression)", () => {
    attach({ container });
    const labels = tabButtons().map((b) => b.textContent);
    expect(labels).toEqual(["entities", "systems", "timeline"]);
  });

  it("adds durable + ephemeral tabs when both options are given", () => {
    attach({ container, durable: () => null, ephemeral: () => null });
    const labels = tabButtons().map((b) => b.textContent);
    expect(labels).toEqual(["entities", "systems", "timeline", "durable", "ephemeral"]);
  });

  it("falls back to the first tab when a persisted tab is not in this build's tab list", () => {
    localStorage.setItem("strata-obs:layout", JSON.stringify({ tab: "durable", open: true }));
    // No durable option → no durable tab; the persisted "durable" must NOT throw and must fall back.
    expect(() => attach({ container })).not.toThrow();
    expect(tabButtons()).toHaveLength(3);
    expect(container.querySelector(".strata-obs-pane.active")?.getAttribute("data-pane")).toBe("entities");
  });
});

describe("strata-ecs/tools durable tab", () => {
  // baseline vs loro chosen to hit all four cases: only-in-baseline, only-in-loro, in-both-equal,
  // in-both-different — so the union, the "—" placeholders, and the diff highlight are all exercised.
  const baseline = {
    "a-baseonly": rec("a-baseonly", { Pos: { x: 0 } }),
    "d-diff": rec("d-diff", { Pos: { x: 1 } }),
    "e-equal": rec("e-equal", { Pos: { x: 5 } }),
  };
  const loro = {
    "c-loroonly": rec("c-loroonly", { Pos: { x: 9 } }),
    "d-diff": rec("d-diff", { Pos: { x: 2 } }), // same key, different value → the un-agreed cell
    "e-equal": rec("e-equal", { Pos: { x: 5 } }), // deep-equal to baseline → NOT a delta
  };
  const source: ObserverDurableSource = {
    store: { docId: "doc-42", snapshot: snapshotView(loro) },
    attachment: { baseline: snapshotView(baseline) },
  };

  it("renders the sorted union with a header, '—' for missing sides, and the Δ highlight on exactly the disagreeing rows", () => {
    attach({ container, tab: "durable", durable: () => source });
    vi.advanceTimersByTime(POLL_MS);

    // union of {a-baseonly,d-diff,e-equal} ∪ {c-loroonly,d-diff,e-equal}, sorted.
    expect(durRows().map((r) => r.querySelector(".strata-obs-durkey")?.textContent)).toEqual([
      "a-baseonly",
      "c-loroonly",
      "d-diff",
      "e-equal",
    ]);

    // header: 3 baseline keys, 3 loro keys, and Δ over the three disagreeing rows (only e-equal agrees).
    expect(container.querySelector(".strata-obs-storehead")?.textContent).toBe(
      "doc doc-42 · baseline 3 · loro 3 · Δ 3",
    );

    // missing sides render "—" (base col first, loro col second).
    expect(cols(rowByKey("a-baseonly")!)[1]).toBe("—"); // present in baseline, absent in loro
    expect(cols(rowByKey("c-loroonly")!)[0]).toBe("—"); // absent in baseline, present in loro

    // the diff class lands on the un-agreed rows and NOWHERE else.
    expect(rowByKey("a-baseonly")!.classList.contains("diff")).toBe(true);
    expect(rowByKey("c-loroonly")!.classList.contains("diff")).toBe(true);
    expect(rowByKey("d-diff")!.classList.contains("diff")).toBe(true);
    expect(rowByKey("e-equal")!.classList.contains("diff")).toBe(false);
  });

  it("narrows the rendered rows by the key filter (without rebuilding the input)", () => {
    attach({ container, tab: "durable", durable: () => source });
    vi.advanceTimersByTime(POLL_MS);
    expect(durRows()).toHaveLength(4);

    // scope to the durable pane — the entities pane ALSO has a .strata-obs-filter input.
    const durFilter = ".strata-obs-pane[data-pane='durable'] .strata-obs-filter";
    const input = container.querySelector<HTMLInputElement>(durFilter)!;
    input.value = "diff";
    input.dispatchEvent(new Event("input")); // fires the tab's live-filter refresh synchronously

    expect(durRows().map((r) => r.querySelector(".strata-obs-durkey")?.textContent)).toEqual(["d-diff"]);
    // same input node survived the re-render (value preserved, not clobbered).
    expect(container.querySelector<HTMLInputElement>(durFilter)).toBe(input);
    expect(input.value).toBe("diff");
  });

  it("caps at 200 rendered rows and shows a '+N more' footer", () => {
    const many: Record<string, ObserverEntityRecord> = {};
    for (let i = 0; i < 250; i++) many[`k${String(i).padStart(3, "0")}`] = rec(`k${String(i).padStart(3, "0")}`, { N: { i } });
    const bigSource: ObserverDurableSource = {
      store: { docId: "big", snapshot: snapshotView({}) }, // loro empty → every baseline key is a delta
      attachment: { baseline: snapshotView(many) },
    };
    attach({ container, tab: "durable", durable: () => bigSource });
    vi.advanceTimersByTime(POLL_MS);

    expect(durRows()).toHaveLength(200);
    const footers = [...container.querySelectorAll(".strata-obs-empty")].map((e) => e.textContent);
    expect(footers).toContain("+50 more — filter to narrow");
  });

  it("renders a placeholder while the durable getter returns null", () => {
    attach({ container, tab: "durable", durable: () => null });
    vi.advanceTimersByTime(POLL_MS);
    expect(container.querySelector(".strata-obs-pane[data-pane='durable'] .strata-obs-empty")?.textContent).toContain(
      "no durable store attached",
    );
    expect(durRows()).toHaveLength(0);
  });

  it("renders peer-controlled component values as literal text, never as HTML", () => {
    const evil = "<img src=x onerror=boom>";
    const xssSource: ObserverDurableSource = {
      store: { docId: "d", snapshot: snapshotView({}) },
      attachment: { baseline: snapshotView({ "p-1": rec("p-1", { Note: evil }) }) },
    };
    attach({ container, tab: "durable", durable: () => xssSource });
    vi.advanceTimersByTime(POLL_MS);

    expect(container.querySelector("img")).toBeNull(); // the string was NOT parsed into an element
    expect(cols(rowByKey("p-1")!)[0]).toContain(evil); // it appears verbatim in the baseline column
  });
});

describe("strata-ecs/tools ephemeral tab", () => {
  // own peer "p1" (two entities) + a remote whose peer-id ITSELF contains dashes: the writer split must
  // strip ONLY the final -<digits>, so "p2-longer-uuid-7" belongs to writer "p2-longer-uuid".
  const source: ObserverEphemeralSource = {
    debugDump: () => ({
      peerId: "p1",
      ttlMs: 5000,
      throttleMs: 16,
      entries: [
        { key: "p1-1", blob: { components: { Cursor: { x: 1 } }, tags: ["Selection", "Active"] } },
        { key: "p1-2", blob: { components: {}, tags: [] } },
        { key: "p2-longer-uuid-7", blob: { components: { Cursor: { x: 2 } }, tags: [] } },
      ],
    }),
  };

  it("groups entries by writer, own partition first and labeled '(you)', dashes in a peer-id preserved", () => {
    attach({ container, tab: "ephemeral", ephemeral: () => source });
    vi.advanceTimersByTime(POLL_MS);

    const groups = [...container.querySelectorAll(".strata-obs-ephgroup")].map((e) => e.textContent);
    expect(groups).toEqual(["p1 (you)", "p2-longer-uuid"]); // own first; remote writer keeps its inner dashes

    // header carries the three scalars + entry count.
    expect(container.querySelector(".strata-obs-storehead")?.textContent).toBe(
      "peer p1 · ttl 5000ms · throttle 16ms · 3 entries",
    );

    // both own keys are present as entries.
    const keys = [...container.querySelectorAll(".strata-obs-ephkey")].map((e) => e.textContent);
    expect(keys).toEqual(["p1-1", "p1-2", "p2-longer-uuid-7"]);

    // a string-array `tags` field renders as a joined list, not JSON.
    const vals = [...container.querySelectorAll(".strata-obs-cval")].map((e) => e.textContent);
    expect(vals).toContain("Selection, Active");
  });

  it("renders a placeholder while the ephemeral getter returns null", () => {
    attach({ container, tab: "ephemeral", ephemeral: () => null });
    vi.advanceTimersByTime(POLL_MS);
    expect(
      container.querySelector(".strata-obs-pane[data-pane='ephemeral'] .strata-obs-empty")?.textContent,
    ).toContain("no ephemeral store attached");
  });

  it("renders peer-controlled blob values as literal text, never as HTML", () => {
    const evil = "<img src=x onerror=boom>";
    const xssSource: ObserverEphemeralSource = {
      debugDump: () => ({
        peerId: "p1",
        ttlMs: 5000,
        throttleMs: 16,
        entries: [{ key: "p1-1", blob: { components: { Note: evil }, tags: [] } }],
      }),
    };
    attach({ container, tab: "ephemeral", ephemeral: () => xssSource });
    vi.advanceTimersByTime(POLL_MS);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".strata-obs-pane[data-pane='ephemeral']")?.textContent).toContain(evil);
  });
});

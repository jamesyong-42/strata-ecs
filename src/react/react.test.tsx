// @vitest-environment happy-dom
/**
 * `strata/react` binding tests (003 §2.3). Drives REAL `react-dom/client` roots under happy-dom,
 * inside `act()`, with `reactive.notify()` called by the test as the frame loop (002 §4.1 — notify is
 * user-called). Render counts are read from a probe that bumps a counter each render; useSyncExternalStore
 * bails out (no render) when `getSnapshot` returns the same boxed reference, which is exactly what the
 * Tier-3 equality box guarantees — so an equal-value write is a zero-delta render (002 §3.3 / 003 §1.3).
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorld, defineComponent, defineResource, type Entity, type World } from "../index";
import { useComponent, useResource } from "./index";

// Enables React's act() semantics + silences "not wrapped in act" warnings (React 19).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Process-global schema handles (RXT-prefixed to stay clear of any other suite's names).
const RXTPos = defineComponent<{ x: number; y: number }>("RXTPos", { x: "f32", y: "f32" });
const RXTCamera = defineResource<{ zoom: number }>("RXTCamera", { zoom: "f32" });

interface Counter {
  n: number;
}

/** Bumps `counter` every render; renders the component value or an explicit "none" undefined branch. */
function PosProbe({
  world,
  entity,
  counter,
}: {
  world: World;
  entity: Entity;
  counter: Counter;
}): ReactNode {
  counter.n++;
  const v = useComponent(world, entity, RXTPos);
  return <span>{v ? `${v.x},${v.y}` : "none"}</span>;
}

/** Bumps `counter` every render; renders the resource value or the "none" undefined branch. */
function CameraProbe({ world, counter }: { world: World; counter: Counter }): ReactNode {
  counter.n++;
  const v = useResource(world, RXTCamera);
  return <span>{v ? String(v.zoom) : "none"}</span>;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

/** Render (or re-render) `el` into the root and flush inside act(). `null` unmounts the tree. */
async function render(el: ReactNode): Promise<void> {
  await act(async () => {
    root.render(el);
  });
}

function text(): string {
  return container.textContent ?? "";
}

describe("useComponent", () => {
  it("renders the current component value", async () => {
    const world = createWorld();
    const e = world.spawn({ components: [[RXTPos, { x: 1, y: 2 }]] });
    const counter = { n: 0 };
    await render(<PosProbe world={world} entity={e} counter={counter} />);
    expect(text()).toBe("1,2");
  });

  it("re-renders with the new value after a set + notify", async () => {
    const world = createWorld();
    const e = world.spawn({ components: [[RXTPos, { x: 1, y: 2 }]] });
    const counter = { n: 0 };
    await render(<PosProbe world={world} entity={e} counter={counter} />);
    const baseline = counter.n;

    await act(async () => {
      world.edit(e).set(RXTPos, { x: 5, y: 6 });
      world.reactive.notify();
    });

    expect(text()).toBe("5,6");
    expect(counter.n).toBe(baseline + 1);
  });

  it("does NOT re-render on an equal-value write (Tier-3 suppression)", async () => {
    const world = createWorld();
    const e = world.spawn({ components: [[RXTPos, { x: 5, y: 6 }]] });
    const counter = { n: 0 };
    await render(<PosProbe world={world} entity={e} counter={counter} />);
    const baseline = counter.n;

    await act(async () => {
      world.edit(e).set(RXTPos, { x: 5, y: 6 }); // identical field values — stamps, but value is equal
      world.reactive.notify();
    });

    expect(text()).toBe("5,6");
    expect(counter.n).toBe(baseline); // the box's equality check suppressed the render
  });

  it("renders the undefined branch after the entity is destroyed", async () => {
    const world = createWorld();
    const e = world.spawn({ components: [[RXTPos, { x: 1, y: 2 }]] });
    const counter = { n: 0 };
    await render(<PosProbe world={world} entity={e} counter={counter} />);
    expect(text()).toBe("1,2");

    await act(async () => {
      world.destroy(e);
      world.reactive.notify(); // eager death fires `undefined` once (002 §3.4)
    });

    expect(text()).toBe("none");
  });

  it("unsubscribes on unmount — later writes never re-render it", async () => {
    const world = createWorld();
    const e = world.spawn({ components: [[RXTPos, { x: 1, y: 2 }]] });
    const counter = { n: 0 };
    await render(<PosProbe world={world} entity={e} counter={counter} />);
    await render(null); // unmount the probe → runs the useSyncExternalStore cleanup (the Unsubscribe)
    const afterUnmount = counter.n;

    await act(async () => {
      world.edit(e).set(RXTPos, { x: 7, y: 8 });
      world.reactive.notify();
      world.edit(e).set(RXTPos, { x: 9, y: 9 });
      world.reactive.notify();
    });

    expect(counter.n).toBe(afterUnmount); // no callback reached the unmounted component
  });

  it("re-subscribes and renders the NEW world's value on a world swap", async () => {
    const worldA = createWorld();
    const eA = worldA.spawn({ components: [[RXTPos, { x: 1, y: 1 }]] });
    const worldB = createWorld();
    const eB = worldB.spawn({ components: [[RXTPos, { x: 9, y: 9 }]] });
    const counter = { n: 0 };

    await render(<PosProbe world={worldA} entity={eA} counter={counter} />);
    expect(text()).toBe("1,1");

    // Swap the world prop: subscribe identity (keyed on [world, e, c]) changes → resubscribe to worldB.
    await render(<PosProbe world={worldB} entity={eB} counter={counter} />);
    expect(text()).toBe("9,9");

    // The new subscription is live — worldB drives updates…
    await act(async () => {
      worldB.edit(eB).set(RXTPos, { x: 20, y: 20 });
      worldB.reactive.notify();
    });
    expect(text()).toBe("20,20");

    // …and the swapped-away world no longer does.
    const afterB = counter.n;
    await act(async () => {
      worldA.edit(eA).set(RXTPos, { x: 3, y: 3 });
      worldA.reactive.notify();
    });
    expect(counter.n).toBe(afterB);
    expect(text()).toBe("20,20");
  });
});

describe("useResource", () => {
  it("renders the current resource value", async () => {
    const world = createWorld();
    world.setResource(RXTCamera, { zoom: 1 });
    const counter = { n: 0 };
    await render(<CameraProbe world={world} counter={counter} />);
    expect(text()).toBe("1");
  });

  it("re-renders on setResource + notify, and NOT on an equal-value set", async () => {
    const world = createWorld();
    world.setResource(RXTCamera, { zoom: 1 });
    const counter = { n: 0 };
    await render(<CameraProbe world={world} counter={counter} />);
    const baseline = counter.n;

    await act(async () => {
      world.setResource(RXTCamera, { zoom: 2 });
      world.reactive.notify();
    });
    expect(text()).toBe("2");
    expect(counter.n).toBe(baseline + 1);

    const afterChange = counter.n;
    await act(async () => {
      world.setResource(RXTCamera, { zoom: 2 }); // replaces the object, but the value is equal
      world.reactive.notify();
    });
    expect(text()).toBe("2");
    expect(counter.n).toBe(afterChange); // equality-suppressed (003 §1.3)
  });

  it("re-subscribes to a new world's resource on a world swap", async () => {
    const worldA = createWorld();
    worldA.setResource(RXTCamera, { zoom: 1 });
    const worldB = createWorld();
    worldB.setResource(RXTCamera, { zoom: 5 });
    const counter = { n: 0 };

    await render(<CameraProbe world={worldA} counter={counter} />);
    expect(text()).toBe("1");

    await render(<CameraProbe world={worldB} counter={counter} />);
    expect(text()).toBe("5");
  });
});

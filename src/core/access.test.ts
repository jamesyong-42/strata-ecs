import { describe, expect, it, vi } from "vitest";
import { Any, defineComponent, defineQuery, defineSystem, phase } from "./index";
import { effectiveRead, validatePipelineAccess } from "./access-diagnostics";

// Schema names are prefixed "ACC" to stay unique in the process-global schema (§4).
const A = defineComponent("ACCA", { a: "u32" });
const B = defineComponent("ACCB", { b: "u32" });
const C = defineComponent("ACCC", { c: "u32" });
const D = defineComponent("ACCD", { d: "u32" });
const E = defineComponent("ACCE", { e: "u32" });
const F = defineComponent("ACCF", { f: "u32" });

/** Compare component sets by id, order-independent. */
const ids = (cs: readonly { id: number }[]): number[] => cs.map((c) => c.id).sort((x, y) => x - y);

describe("SystemAccess round-trip (001 §2.1)", () => {
  it("carries the declared access through defineSystem", () => {
    const sys = defineSystem(defineQuery([A]), () => {}, { access: { write: [A], read: [B] } });
    expect(sys.access).toEqual({ write: [A], read: [B] });
  });

  it("leaves access undefined when omitted — no eager default materialized", () => {
    const sys = defineSystem(defineQuery([A]), () => {});
    expect(sys.access).toBeUndefined();
  });
});

describe("effectiveRead — the read-default rule (001 §2.3)", () => {
  it("defaults to the query components when access is omitted", () => {
    const sys = defineSystem(defineQuery([A, B]), () => {});
    expect(ids(effectiveRead(sys))).toEqual(ids([A, B]));
  });

  it("subtracts the write set from the query-component default", () => {
    const sys = defineSystem(defineQuery([A, B]), () => {}, { access: { write: [A] } });
    expect(ids(effectiveRead(sys))).toEqual(ids([B]));
  });

  it("returns an explicit read declaration verbatim", () => {
    const sys = defineSystem(defineQuery([A, B]), () => {}, { access: { read: [C] } });
    expect(ids(effectiveRead(sys))).toEqual(ids([C]));
  });

  it("includes Any(...) group members in the default read set", () => {
    const sys = defineSystem(defineQuery([A, Any(B, C)]), () => {});
    expect(ids(effectiveRead(sys))).toEqual(ids([A, B, C]));
  });
});

describe("validatePipelineAccess — advisory diagnostics (001 §3.3)", () => {
  it("warns when two same-phase systems declare write of the same component", () => {
    const s1 = defineSystem(defineQuery([A]), () => {}, { name: "W1", access: { write: [A] } });
    const s2 = defineSystem(defineQuery([A]), () => {}, { name: "W2", access: { write: [A] } });
    const pipeline = [phase("p", [s1, s2])];

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipelineAccess(pipeline);
    const calls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/order-dependence/);
    expect(calls[0]).toContain("ACCA");
  });

  it("warns when a read precedes a same-phase write of the same component", () => {
    const reader = defineSystem(defineQuery([D]), () => {}, { name: "Reader" });
    const writer = defineSystem(defineQuery([D]), () => {}, { name: "Writer", access: { write: [D] } });
    const pipeline = [phase("p", [reader, writer])];

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipelineAccess(pipeline);
    const calls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/reads stale/);
    expect(calls[0]).toContain("ACCD");
  });

  it("does not warn on a clean pipeline (single writer preceding its reader)", () => {
    const writer = defineSystem(defineQuery([E]), () => {}, { name: "Writer", access: { write: [E] } });
    const reader = defineSystem(defineQuery([E]), () => {}, { name: "Reader" });
    const pipeline = [phase("p", [writer, reader])];

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipelineAccess(pipeline);
    const n = spy.mock.calls.length;
    spy.mockRestore();

    expect(n).toBe(0);
  });

  it("deduplicates warnings across repeated calls (once per pipeline)", () => {
    const reader = defineSystem(defineQuery([F]), () => {}, { name: "Reader" });
    const writer = defineSystem(defineQuery([F]), () => {}, { name: "Writer", access: { write: [F] } });
    const pipeline = [phase("p", [reader, writer])];

    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipelineAccess(pipeline);
    const afterFirst = spy.mock.calls.length;
    validatePipelineAccess(pipeline);
    const afterSecond = spy.mock.calls.length;
    spy.mockRestore();

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // the second call re-warns nothing
  });
});

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
// Petition-3a attestation fixtures (single-letter columns kept distinct from the A–F set above).
const G = defineComponent("ACCG", { g: "u32" });
const H = defineComponent("ACCH", { h: "u32" });
const I = defineComponent("ACCI", { i: "u32" });
const J = defineComponent("ACCJ", { j: "u32" });
const K = defineComponent("ACCK", { k: "u32" });
const L = defineComponent("ACCL", { l: "u32" });
const M = defineComponent("ACCM", { m: "u32" });
const N = defineComponent("ACCN", { n: "u32" });
const O = defineComponent("ACCO", { o: "u32" });
// Acceptance-shape columns for the petition example (semantic names for readability).
const Position = defineComponent("ACCPosition", { x: "f32", y: "f32" });
const StackZ = defineComponent("ACCStackZ", { z: "u32" });
const Size = defineComponent("ACCSize", { w: "f32", h: "f32" });

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

  it("round-trips orderIndependent verbatim (petition 3a; 001 §3.3 as-built amendment)", () => {
    const sys = defineSystem(defineQuery([A]), () => {}, { access: { write: [A], orderIndependent: [A] } });
    expect(sys.access).toEqual({ write: [A], orderIndependent: [A] });
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

  it("is unaffected by orderIndependent — write-subtraction is unchanged (petition 3a)", () => {
    // orderIndependent is advisory-only metadata; it must never re-add an attested column to the
    // read set nor otherwise perturb the §2.3 default (here: query [A, B] minus write [A] = [B]).
    const sys = defineSystem(defineQuery([A, B]), () => {}, { access: { write: [A], orderIndependent: [A] } });
    expect(ids(effectiveRead(sys))).toEqual(ids([B]));
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

  // --- order-independence attestation (petition 3a; 001 §3.3 as-built amendment) ---

  /** Run the walker once under a console.warn spy and return the warning strings (same harness as above). */
  const warningsFor = (pipeline: Parameters<typeof validatePipelineAccess>[0]): string[] => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipelineAccess(pipeline);
    const calls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    return calls;
  };

  it("suppresses advisory (a) when BOTH co-writers attest the shared column", () => {
    const s1 = defineSystem(defineQuery([G]), () => {}, { name: "OI_A1", access: { write: [G], orderIndependent: [G] } });
    const s2 = defineSystem(defineQuery([G]), () => {}, { name: "OI_A2", access: { write: [G], orderIndependent: [G] } });
    const calls = warningsFor([phase("p", [s1, s2])]);
    expect(calls.filter((m) => /order-dependence/.test(m))).toHaveLength(0);
    expect(calls).toHaveLength(0); // subset satisfied, no reader → nothing else fires either
  });

  it("still warns advisory (a) when only ONE co-writer attests", () => {
    const s1 = defineSystem(defineQuery([H]), () => {}, { name: "OI_B1", access: { write: [H], orderIndependent: [H] } });
    const s2 = defineSystem(defineQuery([H]), () => {}, { name: "OI_B2", access: { write: [H] } });
    const oi = warningsFor([phase("p", [s1, s2])]).filter((m) => /order-dependence/.test(m));
    expect(oi).toHaveLength(1);
    expect(oi[0]).toContain("ACCH");
  });

  it("still warns when three co-writers write a column but only two attest", () => {
    const s1 = defineSystem(defineQuery([I]), () => {}, { name: "OI_C1", access: { write: [I], orderIndependent: [I] } });
    const s2 = defineSystem(defineQuery([I]), () => {}, { name: "OI_C2", access: { write: [I], orderIndependent: [I] } });
    const s3 = defineSystem(defineQuery([I]), () => {}, { name: "OI_C3", access: { write: [I] } });
    const oi = warningsFor([phase("p", [s1, s2, s3])]).filter((m) => /order-dependence/.test(m));
    expect(oi).toHaveLength(1);
    expect(oi[0]).toContain("ACCI");
  });

  it("suppresses per column: both attest J yet co-write un-attested K → J silent, K warned", () => {
    const s1 = defineSystem(defineQuery([J, K]), () => {}, { name: "OI_D1", access: { write: [J, K], orderIndependent: [J] } });
    const s2 = defineSystem(defineQuery([J, K]), () => {}, { name: "OI_D2", access: { write: [J, K], orderIndependent: [J] } });
    const oi = warningsFor([phase("p", [s1, s2])]).filter((m) => /order-dependence/.test(m));
    expect(oi).toHaveLength(1); // only the un-attested column warns
    expect(oi[0]).toContain("ACCK");
    expect(oi.some((m) => m.includes("ACCJ"))).toBe(false); // J was suppressed
  });

  it("petition acceptance shape: move/resize both attest Position in one phase → zero access warns", () => {
    const moveBehavior = defineSystem(defineQuery([Position, StackZ]), () => {}, {
      name: "moveBehavior",
      access: { write: [Position, StackZ], orderIndependent: [Position] },
    });
    const resizeBehavior = defineSystem(defineQuery([Position, Size]), () => {}, {
      name: "resizeBehavior",
      access: { write: [Position, Size], orderIndependent: [Position] },
    });
    // Position suppressed (both attest); StackZ/Size are single-writer; both subsets satisfied.
    expect(warningsFor([phase("interact", [moveBehavior, resizeBehavior])])).toHaveLength(0);
  });

  it("advisory (a) counts DISTINCT systems: self-dup write entries and same-system-twice never self-warn", () => {
    // Review fix (2026-07-11): a duplicated write entry ([N, N]) or the same System object slotted
    // twice in a phase used to inflate the writer-index list for ONE writer and name the system
    // against itself — §3.3's hazard is "two systems", so a self-pair must not warn.
    const dup = defineSystem(defineQuery([N]), () => {}, { name: "SelfDup", access: { write: [N, N] } });
    expect(warningsFor([phase("p", [dup])]).filter((m) => /order-dependence/.test(m))).toHaveLength(0);
    const twice = defineSystem(defineQuery([O]), () => {}, { name: "Twice", access: { write: [O] } });
    expect(warningsFor([phase("p", [twice, twice])]).filter((m) => /order-dependence/.test(m))).toHaveLength(0);
    // Two DISTINCT systems still warn even when one carries a duplicate entry — and names dedup.
    const other = defineSystem(defineQuery([N]), () => {}, { name: "Other", access: { write: [N] } });
    const oi = warningsFor([phase("p", [dup, other])]).filter((m) => /order-dependence/.test(m));
    expect(oi).toHaveLength(1);
    expect(oi[0]).toContain('"SelfDup", "Other"');
  });

  it("warns subset hygiene when an attested column is not in write, and leaves suppression unaffected", () => {
    // s1 attests L (which it never writes) — inert — while both systems co-write M un-attested.
    const s1 = defineSystem(defineQuery([M]), () => {}, { name: "OI_F1", access: { write: [M], orderIndependent: [L] } });
    const s2 = defineSystem(defineQuery([M]), () => {}, { name: "OI_F2", access: { write: [M] } });
    const calls = warningsFor([phase("p", [s1, s2])]);

    const hygiene = calls.filter((m) => /must be a subset of write/.test(m));
    expect(hygiene).toHaveLength(1);
    expect(hygiene[0]).toContain("ACCL");

    const oi = calls.filter((m) => /order-dependence/.test(m));
    expect(oi).toHaveLength(1); // M's advisory still fires — the stray L attestation did not suppress it
    expect(oi[0]).toContain("ACCM");
  });

  it("advisory (b) still fires when a reader precedes an attested writer — attestation must not silence (b)", () => {
    const reader = defineSystem(defineQuery([N]), () => {}, { name: "OI_G_Reader" });
    const writer = defineSystem(defineQuery([N]), () => {}, { name: "OI_G_Writer", access: { write: [N], orderIndependent: [N] } });
    const calls = warningsFor([phase("p", [reader, writer])]);

    expect(calls.filter((m) => /order-dependence/.test(m))).toHaveLength(0); // single writer → no (a)
    const stale = calls.filter((m) => /reads stale/.test(m));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("ACCN");
  });
});

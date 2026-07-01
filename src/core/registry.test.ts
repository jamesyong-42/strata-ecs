import { describe, expect, it } from "vitest";
import { Registry } from "./registry";

describe("Registry — interning", () => {
  it("assigns dense ids and round-trips names", () => {
    const r = new Registry();
    expect(r.define("Position")).toBe(0);
    expect(r.define("Velocity")).toBe(1);
    expect(r.resolve(0)).toBe("Position");
    expect(r.resolve(1)).toBe("Velocity");
    expect(r.idOf("Velocity")).toBe(1);
    expect(r.has("Position")).toBe(true);
    expect(r.has("Nope")).toBe(false);
    expect(r.size).toBe(2);
  });

  it("returns undefined for unknown ids / names", () => {
    const r = new Registry();
    r.define("A");
    expect(r.resolve(999)).toBeUndefined();
    expect(r.idOf("B")).toBeUndefined();
  });

  it("throws on duplicate definition", () => {
    const r = new Registry();
    r.define("Position");
    expect(() => r.define("Position")).toThrow(/already defined/);
  });
});

describe("Registry — reservation", () => {
  it("reserves a framework name and forbids redefining it", () => {
    const r = new Registry();
    const id = r.reserve("Local");
    expect(r.isReserved("Local")).toBe(true);
    expect(r.has("Local")).toBe(true);
    expect(r.resolve(id)).toBe("Local");
    expect(() => r.define("Local")).toThrow(/reserved framework identifier/);
  });

  it("reservation is idempotent and keeps a stable id", () => {
    const r = new Registry();
    const id = r.reserve("Local");
    expect(r.reserve("Local")).toBe(id);
    expect(r.size).toBe(1);
  });

  it("reserved and defined names share one dense id space, in registration order", () => {
    const r = new Registry();
    expect(r.reserve("Local")).toBe(0);
    expect(r.define("Position")).toBe(1);
    expect(r.define("Velocity")).toBe(2);
    expect(r.resolve(0)).toBe("Local");
  });
});

import { describe, expect, it } from "vitest";
import { VERSION } from "./index";

describe("scaffold smoke test", () => {
  it("exposes a string version", () => {
    expect(typeof VERSION).toBe("string");
  });
});

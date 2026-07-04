/**
 * `Local` — the framework-exported partition-ownership tag (design §15.4/§20). A short core test: it is
 * a normal, importable tag; users cannot define it (the name is reserved); and the framework path that
 * mints it is guarded to reserved names only.
 */

import { describe, expect, it } from "vitest";
import { Local } from "./local";
import { Not, createWorld, defineComponent, defineQuery, defineTag } from ".";
import { defineFrameworkTag } from "./schema";

describe("Local", () => {
  it("is a tag named 'Local', importable from the core barrel", () => {
    expect(Local.name).toBe("Local");
    expect(typeof Local.id).toBe("number");
  });

  it("users cannot define it — the name is reserved", () => {
    expect(() => defineTag("Local")).toThrow(/reserved framework identifier/);
  });

  it("defineFrameworkTag refuses a non-reserved name", () => {
    expect(() => defineFrameworkTag("NotReservedTag")).toThrow(/reserved/i);
  });

  it("behaves as an ordinary query tag (Local / Not(Local))", () => {
    const P = defineComponent("LocalTestPos", { x: "f32" });
    const mine = defineQuery([P, Local]);
    const theirs = defineQuery([P, Not(Local)]);
    const world = createWorld();

    const a = world.spawn({ components: [[P, { x: 0 }]] });
    world.addTag(a, Local); // (apps never do this — the ephemeral store owns it — but the tag is ordinary)
    const b = world.spawn({ components: [[P, { x: 1 }]] });

    expect(world.firstOf(mine)).toBe(a);
    expect(world.firstOf(theirs)).toBe(b);
  });
});

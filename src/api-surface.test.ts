/**
 * API surface snapshot — the public RUNTIME export surface, pinned as literals.
 *
 * Every name a consumer can import from the five entries is enumerated here, sorted. The pin
 * is deliberate friction on the export seam in both directions:
 *
 *  - REMOVING or renaming a name is a breaking change — this test is the tripwire that makes
 *    it impossible to do by accident (a re-export dropped in a refactor, a barrel edit).
 *  - ADDING a name is a release decision, not a side effect: updating this list is the prompt
 *    to also update CHANGELOG.md and docs/api.html in the same commit.
 *
 * Types-only exports don't appear here (they have no runtime binding); the d.ts surface is
 * covered by typecheck + the docs/api.html discipline. The exports-map SUBPATHS are pinned
 * too — a new entry point is as public as a new function.
 *
 * The /tools and /react pins live in their OWN projects (src/tools/api-surface.test.ts,
 * src/react/api-surface.test.ts): importing them here would pull DOM/React types into the
 * root tsc program, and that program typechecking WITHOUT them is the core's browser-free /
 * react-free guarantee.
 */
import { describe, expect, test } from "vitest";

import * as core from "./index";
import * as durable from "./durable/index";
import * as ephemeral from "./ephemeral/index";
import pkg from "../package.json";

const SURFACE = {
  core: [
    "All",
    "Any",
    "Local",
    "Not",
    "Reactive",
    "Related",
    "VERSION",
    "World",
    "createWorld",
    "defineComponent",
    "defineQuery",
    "defineRelation",
    "defineResource",
    "defineSystem",
    "defineTag",
    "defineTickSystem",
    "entityKey",
    "enumOf",
    "field",
    "phase",
    "validatePipelineAccess",
  ],
  durable: [
    "DurableSyncStatus",
    "DurableUndoStatus",
    "PendingImportError",
    "attachDurable",
    "createDurableStore",
  ],
  ephemeral: [
    "EphemeralSyncStatus",
    "LoroEphemeralSnapshot",
    "attachEphemeral",
    "createEphemeralStore",
  ],
} as const;

const MODULES: Record<keyof typeof SURFACE, object> = {
  core,
  durable,
  ephemeral,
};

describe("public API surface", () => {
  for (const entry of Object.keys(SURFACE) as (keyof typeof SURFACE)[]) {
    test(`${entry} runtime exports match the pinned surface`, () => {
      expect(Object.keys(MODULES[entry]).sort(), surfaceChangeHint(entry)).toEqual([
        ...SURFACE[entry],
      ]);
    });
  }

  test("exports-map subpaths match the pinned entry points", () => {
    expect(Object.keys(pkg.exports).sort(), surfaceChangeHint("exports map")).toEqual([
      ".",
      "./durable",
      "./ephemeral",
      "./package.json",
      "./react",
      "./tools",
    ]);
  });
});

function surfaceChangeHint(entry: string): string {
  return (
    `the "${entry}" public surface changed. If intended: update this pin, CHANGELOG.md, ` +
    `and docs/api.html in the SAME commit (removal/rename = breaking). If not intended: a ` +
    `barrel or exports-map edit leaked.`
  );
}

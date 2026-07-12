/**
 * /react runtime export pin — the react half of src/api-surface.test.ts, living in THIS
 * project because importing the binding from the root program would drag React types into it
 * (the root typechecking without them is the core's react-free guarantee).
 */
import { expect, test } from "vitest";

import * as reactBinding from "./index";

test("/react runtime exports match the pinned surface", () => {
  expect(
    Object.keys(reactBinding).sort(),
    `the "/react" public surface changed. If intended: update this pin, CHANGELOG.md, and ` +
      `docs/api.html in the SAME commit (removal/rename = breaking). If not: a barrel edit leaked.`,
  ).toEqual(["useComponent", "useResource"]);
});

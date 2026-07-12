/**
 * /tools runtime export pin — the tools half of src/api-surface.test.ts, living in THIS
 * project because importing the panel from the root program would drag DOM types into it
 * (the root typechecking without DOM is the core's browser-free guarantee).
 */
import { expect, test } from "vitest";

import * as tools from "./index";

test("/tools runtime exports match the pinned surface", () => {
  expect(
    Object.keys(tools).sort(),
    `the "/tools" public surface changed. If intended: update this pin, CHANGELOG.md, and ` +
      `docs/api.html in the SAME commit (removal/rename = breaking). If not: a barrel edit leaked.`,
  ).toEqual(["attachObserver", "createLifecycleRecorder", "defaultDescribe"]);
});

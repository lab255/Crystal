import { describe, expect, it } from "vitest";
import {
  BASE_BRANCH_LENS_PARAM,
  NEW_WORKFLOW_NAV,
  paletteCapabilities,
  REVIEW_REF_NAV,
} from "./capabilities.js";

describe("paletteCapabilities", () => {
  it("offers shell capabilities in addition to navigation", () => {
    expect(paletteCapabilities(false).map((command) => [command.title, command.action])).toEqual([
      ["Review vs ref…", "review-ref"],
      ["Set lens: diff vs base branch", "set-base-lens"],
      ["Clear lens", "clear-lens"],
      ["Publish / sharing settings…", "publish-settings"],
      ["Open workspace…", "open-workspace"],
      ["New workflow…", "new-workflow"],
      ["Keyboard shortcuts", "keyboard-shortcuts"],
    ]);
  });

  it("only offers saving a facet while a lens is active", () => {
    expect(paletteCapabilities(false).some((command) => command.action === "save-lens")).toBe(false);
    expect(paletteCapabilities(true).some((command) => command.action === "save-lens")).toBe(true);
  });

  it("targets the concrete capability surfaces", () => {
    expect(BASE_BRANCH_LENS_PARAM).toBe("diff:base");
    expect(REVIEW_REF_NAV).toEqual({ architect: { view: "architecture", vs: null } });
    expect(NEW_WORKFLOW_NAV).toEqual({
      orchestrate: { tab: "workflows", workflow: null, builder: null },
    });
  });
});

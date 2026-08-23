import { describe, expect, it } from "vitest";
import {
  BASE_BRANCH_LENS_PARAM,
  NEW_THREAD_NAV,
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
      ["New thread…", "new-thread"],
      ["Keyboard shortcuts", "keyboard-shortcuts"],
    ]);
  });

  it("only offers facet creation and saving while a lens is active", () => {
    expect(paletteCapabilities(false).some((command) => command.action === "new-facet")).toBe(false);
    expect(paletteCapabilities(false).some((command) => command.action === "save-lens")).toBe(false);
    expect(paletteCapabilities(true).map((command) => command.id)).toEqual([
      "review.ref",
      "lens.diff-base",
      "lens.new-facet",
      "lens.save-facet",
      "lens.clear",
      "settings.publish",
      "ws.open",
      "thread.new",
      "shortcuts.open",
    ]);
    expect(paletteCapabilities(true).some((command) => command.action === "new-facet")).toBe(true);
    expect(paletteCapabilities(true).some((command) => command.action === "save-lens")).toBe(true);
  });

  it("targets the concrete capability surfaces", () => {
    expect(BASE_BRANCH_LENS_PARAM).toBe("diff:base");
    expect(REVIEW_REF_NAV).toEqual({ architect: { view: "architecture", vs: null } });
    expect(NEW_THREAD_NAV).toEqual({
      mode: "threads",
      threads: { thread: null, compose: true },
    });
  });
});

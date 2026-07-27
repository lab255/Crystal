import { describe, expect, it } from "vitest";
import { branchNameError } from "./run-surface.js";

/**
 * The Apply-as-branch dialog's validation: the point of replacing
 * window.prompt was that a bad name is caught *before* it reaches git.
 */
describe("branchNameError", () => {
  it("accepts ordinary branch names", () => {
    expect(branchNameError("crystal/run-abc123")).toBeNull();
    expect(branchNameError("feature/track-b_v2")).toBeNull();
    expect(branchNameError("hotfix-1.2.3")).toBeNull();
  });

  it("rejects empty and whitespace-only names", () => {
    expect(branchNameError("")).not.toBeNull();
    expect(branchNameError("   ")).not.toBeNull();
  });

  it("rejects git-invalid characters and sequences", () => {
    for (const bad of [
      "has space",
      "tilde~1",
      "caret^2",
      "colon:x",
      "quest?x",
      "star*x",
      "brack[x",
      "back\\slash",
      "double..dot",
      "at@{brace",
      "double//slash",
    ]) {
      expect(branchNameError(bad), bad).not.toBeNull();
    }
  });

  it("rejects bad leading and trailing forms", () => {
    for (const bad of ["-leading", "/leading", ".leading", "trailing/", "trailing.", "x.lock"]) {
      expect(branchNameError(bad), bad).not.toBeNull();
    }
  });
});

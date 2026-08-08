import { describe, expect, it } from "vitest";
import { workspaceBrowseError } from "./OpenWorkspaceDialog.js";

describe("workspaceBrowseError", () => {
  it("turns a failed browse request into an inline-ready message", () => {
    expect(workspaceBrowseError(new Error("Permission denied"))).toBe(
      "Could not browse this folder: Permission denied",
    );
  });
});

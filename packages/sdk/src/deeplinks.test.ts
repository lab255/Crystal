import { describe, expect, it } from "vitest";
import { linkedWorkspaceAvailability, UNKNOWN_WORKSPACE_NOTICE } from "./deeplinks.js";

describe("linkedWorkspaceAvailability", () => {
  it("distinguishes a loading workspace list from an unknown workspace", () => {
    expect(linkedWorkspaceAvailability("missing", null)).toBe("unknown");
    expect(linkedWorkspaceAvailability("missing", { workspaces: [] })).toBe("pending");
    expect(linkedWorkspaceAvailability("missing", { workspaces: [] }, true)).toBe("unknown");
    expect(
      linkedWorkspaceAvailability("missing", {
        workspaces: [{ id: "known", name: "Known", root: "/known" }],
      }),
    ).toBe("unknown");
  });

  it("accepts a workspace present on the linked server", () => {
    expect(
      linkedWorkspaceAvailability("known", {
        workspaces: [{ id: "known", name: "Known", root: "/known" }],
      }),
    ).toBe("available");
  });

  it("uses the explicit missing-workspace notice", () => {
    expect(UNKNOWN_WORKSPACE_NOTICE).toBe(
      "This link points at a workspace this server doesn't have open",
    );
  });
});

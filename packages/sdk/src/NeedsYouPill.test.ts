import { describe, expect, it } from "vitest";
import type { PendingPermission } from "@crystal/core";
import { fleetNeedsYouCount } from "./NeedsYouPill.js";

describe("fleetNeedsYouCount", () => {
  it("adds parked permissions to questions and failures across workspaces", () => {
    const permission = { id: "p1" } as PendingPermission;
    expect(
      fleetNeedsYouCount(
        [
          { key: "default/a", count: 2 },
          { key: "default/b", count: 0 },
        ],
        { "default/a": [permission], "default/b": [permission, permission] },
      ),
    ).toBe(5);
  });
});

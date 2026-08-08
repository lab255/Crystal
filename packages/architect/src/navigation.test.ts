import { describe, expect, it } from "vitest";
import { bareCodeMapPatch } from "./navigation.js";

describe("bareCodeMapPatch", () => {
  it("keeps the codebase view while seeding the URL workspace", () => {
    expect(bareCodeMapPatch("linked", "active")).toEqual({
      view: "codebase",
      codemap: { kind: "workspace", ws: "linked" },
    });
  });

  it("opens the cross-workspace level when no workspace is active", () => {
    expect(bareCodeMapPatch(null, null)).toEqual({
      view: "codebase",
      codemap: { kind: "all" },
    });
  });
});

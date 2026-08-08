import { describe, expect, it } from "vitest";
import { createArchOverlay, createArchitectureGraph } from "@crystal/core";
import { reconcileCanonicalOverlay, summarizeOverride } from "./canonical-overlay.js";

describe("reconcileCanonicalOverlay", () => {
  it("threads stale semantic override ids through reconciliation", () => {
    const overlay = {
      ...createArchOverlay(),
      overrides: {
        "sys:gone": { label: "Former API", tech: ["node"] },
        "sys:position-only": { x: 12, y: 24 },
        "ctr:api": { label: "API container" },
      },
    };

    const result = reconcileCanonicalOverlay(
      overlay,
      createArchitectureGraph("derived"),
      ["ctr:api"],
    );

    expect(result.staleIds).toEqual(["sys:gone"]);
    expect(result.overlay.overrides).toEqual({
      "sys:gone": { label: "Former API", tech: ["node"] },
      "ctr:api": { label: "API container" },
    });
  });
});

describe("summarizeOverride", () => {
  it("describes authored fields for hidden and stale rows", () => {
    expect(summarizeOverride({ label: "Former API", tech: ["node"], x: 12, y: 24 })).toBe(
      "position · label “Former API” · tech (1)",
    );
    expect(summarizeOverride(undefined)).toBe("no overrides");
  });
});

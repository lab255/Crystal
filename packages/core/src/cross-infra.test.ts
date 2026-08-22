import { describe, expect, it } from "vitest";
import { CrossInfraOverlaySchema, createCrossInfraOverlay, type CrossInfraMap } from "./cross-infra.js";

describe("cross infrastructure contract", () => {
  it("creates a stable, structured-clone-safe overlay record", () => {
    const overlay = createCrossInfraOverlay("2026-08-22T00:00:00.000Z");
    expect(overlay).toEqual({
      id: "default",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      envSelection: {},
      pins: {},
      identityLinks: [],
    });
    expect(CrossInfraOverlaySchema.parse(structuredClone(overlay))).toEqual(overlay);
  });

  it("defaults identity links for old records and tolerates degenerate links", () => {
    const old = CrossInfraOverlaySchema.parse({
      id: "default", createdAt: "now", updatedAt: "now", envSelection: {}, pins: {},
    });
    expect(old.identityLinks).toEqual([]);
    expect(CrossInfraOverlaySchema.parse({
      ...old,
      identityLinks: [{ id: "link-1", members: [{ ws: "a", key: "ext:db" }] }],
    }).identityLinks[0]?.members).toHaveLength(1);
  });

  it("models per-project fan-out failures without rejecting the map", () => {
    const map: CrossInfraMap = {
      projects: [{ ws: "a", name: "A", environments: [], error: "unavailable" }],
      shared: [],
      generatedAt: "2026-08-22T00:00:00.000Z",
    };
    expect(structuredClone(map)).toEqual(map);
  });
});

import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchOverlay,
  createArchitectureGraph,
  extractOverlay,
} from "@crystal/core";
import { splitInfraOnly } from "./arch-view-filter.js";
import { transformCanvasCommit } from "./ArchitectMode.js";
import { shouldPersistCanonicalEdit } from "./use-canonical-architecture.js";

describe("ArchitectMode canonical canvas integration", () => {
  it("repairs split-canvas omissions before overlay extraction", () => {
    const service = { ...createArchNode("service", "API", { x: 10, y: 20 }), id: "service" };
    const filtered = { ...createArchNode("service", "Worker", { x: 30, y: 40 }), id: "filtered" };
    const zone = { ...createArchNode("vpc", "Production VPC", { x: 300, y: 40 }), id: "vpc" };
    const ghost = { ...createArchNode("service", "Removed", { x: 500, y: 40 }), id: "ghost" };
    const rendered = {
      ...createArchitectureGraph("architecture"),
      nodes: [service, filtered, zone],
      edges: [
        { id: "zone-edge", source: "service", target: "vpc", kind: "sync" as const, label: "" },
        { id: "filtered-edge", source: "service", target: "filtered", kind: "sync" as const, label: "" },
      ],
    };
    const { view, infraOnly } = splitInfraOnly(rendered);
    const edited = {
      ...view,
      nodes: [
        ...view.nodes
          .filter((node) => node.id !== filtered.id)
          .map((node) => node.id === service.id ? { ...node, position: { x: 80, y: 90 } } : node),
        ghost,
      ],
      edges: view.edges.filter((edge) => edge.id !== "filtered-edge"),
    };

    const transformed = transformCanvasCommit({
      edited,
      rendered,
      ghostIds: new Set([ghost.id]),
      viewFilteredIds: new Set([filtered.id]),
      infraOnly,
    });

    const overlay = extractOverlay({
      derived: rendered,
      rendered,
      edited: transformed,
      prev: createArchOverlay(),
    });

    expect(overlay.overrides.service).toMatchObject({ x: 80, y: 90 });
    expect(overlay.hiddenIds).toEqual([]);
    expect(transformed.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining(["service", "filtered", "vpc"]),
    );
    expect(transformed.nodes.map((node) => node.id)).not.toContain("ghost");
    expect(transformed.edges.map((edge) => edge.id)).toEqual(
      expect.arrayContaining(["filtered-edge", "zone-edge"]),
    );
  });
});

describe("canonical viewport persistence", () => {
  it("does not persist a mount-only viewport delta before a user graph edit", () => {
    const rendered = createArchitectureGraph("architecture");
    const viewportOnly = { ...rendered, viewport: { x: 1.25, y: -3.5, zoom: 0.9 } };
    expect(shouldPersistCanonicalEdit(rendered, viewportOnly, false)).toEqual({
      persist: false,
      sessionHasUserEdit: false,
    });

    const edited = { ...rendered, name: "Edited" };
    expect(shouldPersistCanonicalEdit(rendered, edited, false)).toEqual({
      persist: true,
      sessionHasUserEdit: true,
    });
    expect(shouldPersistCanonicalEdit(rendered, viewportOnly, true).persist).toBe(true);
  });
});

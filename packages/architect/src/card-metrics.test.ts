import { describe, expect, it } from "vitest";
import {
  createArchNode,
  createArchitectureGraph,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
} from "@crystal/core";
import { estimateCardSize, estimateGraphDims } from "./card-metrics.js";

function node(id: string, kind: ArchNodeKind, patch: Partial<ArchNode> = {}): ArchNode {
  return { ...createArchNode(kind, id, { x: 0, y: 0 }), ...patch, id };
}

function graph(nodes: ArchNode[]): ArchitectureGraph {
  return { ...createArchitectureGraph("metrics"), nodes, edges: [] };
}

describe("estimateCardSize", () => {
  it("matches the renderer's fixed entity footprint", () => {
    expect(estimateCardSize(node("entity", "entity"))).toEqual({ width: 180, height: 90 });
  });

  it("grows for descriptions and wrapped technology badges", () => {
    const plain = node("plain", "service");
    const detailed = node("detailed", "service", {
      description: "A two-line service description with useful context.",
      tech: ["TypeScript", "PostgreSQL", "OpenTelemetry", "Redis", "React"],
    });
    expect(estimateCardSize(detailed).height).toBeGreaterThan(estimateCardSize(plain).height);
  });

  it("honors the renderer's width caps for each card family", () => {
    expect(estimateCardSize(node("person", "person")).width).toBe(120);
    expect(estimateCardSize(node("container", "container")).width).toBe(288);
    expect(estimateCardSize(node("system", "system", { size: null })).width).toBe(288);
    expect(estimateCardSize(node("leaf", "service")).width).toBe(224);
  });

  it("defaults the code badge from codeModule and permits an explicit override", () => {
    const linked = node("linked", "service", {
      codeModule: "packages/core",
      description: "Linked code",
    });
    const plain = node("plain", "service", { description: "Optional code" });
    expect(
      estimateCardSize(linked).height - estimateCardSize(linked, { codeBadge: false }).height,
    ).toBe(22);
    expect(
      estimateCardSize(plain, { codeBadge: true }).height - estimateCardSize(plain).height,
    ).toBe(22);
  });
});

describe("estimateGraphDims", () => {
  it("covers cards and omits the exact system/group nodes rendered as pens", () => {
    const boundary = node("boundary", "system");
    const child = node("child", "container", { parentId: boundary.id });
    const bareSystem = node("bare", "system", { size: null });
    const dims = estimateGraphDims(graph([boundary, child, bareSystem]));

    expect(dims.has(boundary.id)).toBe(false);
    expect(dims.get(child.id)?.width).toBe(288);
    expect(dims.get(bareSystem.id)?.width).toBe(288);
  });
});

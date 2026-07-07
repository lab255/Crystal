import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, CodeMapSummary, CodeTrace } from "@crystal/core";
import { createArchNode, createArchitectureGraph } from "@crystal/core";
import { projectTrace, stepKeyOf } from "./dataflow.js";

function graph(): ArchitectureGraph {
  const node = (id: string, label: string, codeModule: string | null) => ({
    ...createArchNode("service", label, { x: 0, y: 0 }),
    id,
    codeModule,
  });
  return {
    ...createArchitectureGraph("g"),
    environments: [],
    nodes: [
      node("web", "Web", "apps/web"),
      node("server", "Server", "apps/server"),
      node("core", "Core", "packages/core"),
    ],
    edges: [{ id: "e1", source: "web", target: "server", kind: "sync", label: "" }],
  };
}

const summary: CodeMapSummary = {
  modules: [
    { path: "apps/web", name: "web", fileCount: 3 },
    { path: "apps/server", name: "server", fileCount: 5 },
    { path: "packages/core", name: "core", fileCount: 7 },
    { path: "packages/other", name: "other", fileCount: 2 },
  ],
  deps: [],
  fileTotal: 17,
  generatedAt: "t",
};

function trace(steps: [file: string, symbol: string, module: string, depth: number][]): CodeTrace {
  return {
    entry: { file: steps[0]![0], symbol: steps[0]![1] },
    steps: steps.map(([file, symbol, module, depth]) => ({
      ref: { file, symbol },
      module,
      line: 1,
      depth,
    })),
    edges: [],
    truncated: false,
    unresolvedCalls: [],
  };
}

describe("projectTrace", () => {
  it("collapses same-node steps and numbers hops along drawn edges", () => {
    const t = trace([
      ["apps/web/a.ts", "submit", "apps/web", 0],
      ["apps/web/b.ts", "post", "apps/web", 1], // same node — collapsed
      ["apps/server/h.ts", "handle", "apps/server", 1],
      ["packages/core/x.ts", "validate", "packages/core", 2],
    ]);
    const flow = projectTrace(t, graph(), summary);
    expect(flow.nodeOrder.map((n) => n.nodeId)).toEqual(["web", "server", "core"]);
    // web→server has a drawn edge (either direction); server→core does not.
    expect(flow.edgeSteps.get("e1")).toEqual([1]);
    expect(flow.ghostHops).toEqual([{ source: "server", target: "core", step: 2 }]);
    expect(flow.unmappedSteps).toEqual([]);
  });

  it("matches drawn edges direction-insensitively", () => {
    const t = trace([
      ["apps/server/h.ts", "handle", "apps/server", 0],
      ["apps/web/a.ts", "notify", "apps/web", 1], // travels against e1's arrow
    ]);
    const flow = projectTrace(t, graph(), summary);
    expect(flow.edgeSteps.get("e1")).toEqual([1]);
    expect(flow.ghostHops).toEqual([]);
  });

  it("reports steps in unlinked modules as unmapped", () => {
    const t = trace([
      ["apps/web/a.ts", "submit", "apps/web", 0],
      ["packages/other/z.ts", "helper", "packages/other", 1],
    ]);
    const flow = projectTrace(t, graph(), summary);
    expect(flow.unmappedSteps).toHaveLength(1);
    expect(flow.unmappedSteps[0]!.ref.symbol).toBe("helper");
    expect(flow.nodeOrder.map((n) => n.nodeId)).toEqual(["web"]);
  });

  it("resolves every mapped step to its node id (trace-click reveal)", () => {
    const t = trace([
      ["apps/web/a.ts", "submit", "apps/web", 0],
      ["apps/web/b.ts", "post", "apps/web", 1], // same node — still resolvable
      ["apps/server/h.ts", "handle", "apps/server", 1],
      ["packages/other/z.ts", "helper", "packages/other", 2], // unmapped — absent
    ]);
    const flow = projectTrace(t, graph(), summary);
    expect(flow.stepNodeIds.get(stepKeyOf(t.steps[0]!))).toBe("web");
    expect(flow.stepNodeIds.get(stepKeyOf(t.steps[1]!))).toBe("web");
    expect(flow.stepNodeIds.get(stepKeyOf(t.steps[2]!))).toBe("server");
    expect(flow.stepNodeIds.has(stepKeyOf(t.steps[3]!))).toBe(false);
  });
});

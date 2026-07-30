import { describe, expect, it } from "vitest";
import type { Edge as RfEdge } from "@xyflow/react";
import type { SystemLink, SystemModule, SystemOverview } from "@crystal/core";
import {
  buildPartsContent,
  multiPartSystems,
  partNodeId,
  splitEdgesByParts,
} from "./part-split.js";

const system = (id: string, parts: string[], partLinks?: SystemModule["partLinks"]): SystemModule => ({
  id,
  name: id.replace(/^sys:/, ""),
  concept: null,
  role: "domain" as SystemModule["role"],
  layer: "backend" as SystemModule["layer"],
  parts: parts.map((path) => ({ path, pkg: path, fileCount: 3 })),
  fileCount: parts.length * 3,
  intents: [],
  exports: [],
  exportedTotal: 0,
  externals: [],
  libraries: [],
  endpoints: [],
  components: [],
  componentCount: 0,
  ...(partLinks ? { partLinks } : {}),
});

const overview = (systems: SystemModule[], links: SystemLink[] = []): SystemOverview => ({
  systems,
  links,
  fileTotal: systems.reduce((n, s) => n + s.fileCount, 0),
  generatedAt: "",
});

describe("multiPartSystems", () => {
  it("keys multi-part systems by canonical id and skips single-part ones", () => {
    const m = multiPartSystems(
      overview([system("sys:auth", ["a/auth", "b/auth"]), system("sys:tiny", ["lib/tiny"])]),
    );
    expect(m.has("sys:auth")).toBe(true);
    expect(m.has("sys:tiny")).toBe(false);
  });
});

describe("buildPartsContent", () => {
  const auth = system(
    "sys:auth",
    ["server/auth", "client/auth"],
    [{ source: "client/auth", target: "server/auth", weight: 7 }],
  );
  const systems = new Map([["sys:auth", auth]]);

  it("emits one part card per part, parented to the system, plus a container size", () => {
    const content = buildPartsContent(new Set(["sys:auth"]), systems);
    expect(content.nodes).toHaveLength(2);
    for (const n of content.nodes) {
      expect(n.parentId).toBe("sys:auth");
      expect(n.type).toBe("part");
      expect(n.draggable).toBe(false);
    }
    const size = content.sizes.get("sys:auth")!;
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it("wires partLinks as intra edges between part node ids", () => {
    const content = buildPartsContent(new Set(["sys:auth"]), systems);
    expect(content.edges).toHaveLength(1);
    const e = content.edges[0]!;
    expect(e.source).toBe(partNodeId("sys:auth", "client/auth"));
    expect(e.target).toBe(partNodeId("sys:auth", "server/auth"));
    expect(e.label).toBe("×7");
  });

  it("is empty for systems that are not expanded or unknown", () => {
    expect(buildPartsContent(new Set(), systems).nodes).toHaveLength(0);
    expect(buildPartsContent(new Set(["sys:ghost"]), systems).nodes).toHaveLength(0);
  });
});

describe("splitEdgesByParts", () => {
  const link = (parts: NonNullable<SystemLink["parts"]>, extra?: Partial<SystemLink>): SystemLink => ({
    source: "sys:web",
    target: "sys:auth",
    weight: parts.reduce((n, p) => n + p.weight, 0),
    symbols: [],
    parts,
    ...extra,
  });
  const edge = (id: string, source: string, target: string): RfEdge => ({
    id,
    source,
    target,
    style: { stroke: "blue", strokeWidth: 2 },
  });

  it("splits an aggregate onto part endpoints when the target side is expanded", () => {
    const agg = edge("link:sys:web->sys:auth", "sys:web", "sys:auth");
    const out = splitEdgesByParts([agg], {
      expanded: new Set(["sys:auth"]),
      linkOf: new Map([
        [
          agg.id,
          link([
            { sourcePart: "app/web", targetPart: "server/auth", weight: 5 },
            { sourcePart: "app/web", targetPart: "client/auth", weight: 2 },
          ]),
        ],
      ]),
      maxWeight: 7,
    });
    expect(out.map((e) => e.id)).toEqual(["link:sys:web->sys:auth#0", "link:sys:web->sys:auth#1"]);
    expect(out[0]!.source).toBe("sys:web");
    expect(out[0]!.target).toBe(partNodeId("sys:auth", "server/auth"));
    expect(out[0]!.label).toBe("×5");
    // Styling inherits from the aggregate; only the stroke width re-derives.
    expect(out[0]!.style!.stroke).toBe("blue");
  });

  it("re-aggregates several part pairs onto one edge when only the source side is expanded", () => {
    const agg = edge("link:sys:web->sys:auth", "sys:web", "sys:auth");
    const out = splitEdgesByParts([agg], {
      expanded: new Set(["sys:web"]),
      linkOf: new Map([
        [
          agg.id,
          link([
            { sourcePart: "app/web", targetPart: "server/auth", weight: 5 },
            { sourcePart: "app/web", targetPart: "client/auth", weight: 2 },
          ]),
        ],
      ]),
      maxWeight: 7,
    });
    // Both attributions resolve to the same (part, system) pair — one edge.
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe(partNodeId("sys:web", "app/web"));
    expect(out[0]!.target).toBe("sys:auth");
    expect(out[0]!.label).toBe("×7");
  });

  it("never splits api-only links and returns the input array when nothing splits", () => {
    const agg = edge("link:sys:web->sys:auth", "sys:web", "sys:auth");
    const edges = [agg];
    const out = splitEdgesByParts(edges, {
      expanded: new Set(["sys:auth"]),
      linkOf: new Map([
        [
          agg.id,
          link([{ sourcePart: "app/web", targetPart: "server/auth", weight: 3 }], {
            weight: 0,
            apis: [{ method: "GET", path: "/x", file: "f", weight: 3 } as never],
          }),
        ],
      ]),
      maxWeight: 3,
    });
    expect(out).toBe(edges);
  });

  it("leaves edges of collapsed systems untouched by identity", () => {
    const agg = edge("link:sys:a->sys:b", "sys:a", "sys:b");
    const other = edge("dep:x", "m:x", "m:y");
    const out = splitEdgesByParts([agg, other], {
      expanded: new Set(["sys:unrelated"]),
      linkOf: new Map(),
      maxWeight: 1,
    });
    expect(out[0]).toBe(agg);
    expect(out[1]).toBe(other);
  });
});

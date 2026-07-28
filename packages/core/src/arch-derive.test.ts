import { describe, expect, it } from "vitest";
import {
  canonicalSystemIds,
  deriveArchGraph,
  overviewDiffGhosts,
  overviewDiffMarks,
} from "./arch-derive.js";
import type { CodeExternalDep } from "./external-services.js";
import type { SystemModule, SystemOverview } from "./system-overview.js";
import type { SystemOverviewDiff } from "./system-insights.js";

export function system(over: Partial<SystemModule> & { id: string; name: string }): SystemModule {
  return {
    concept: null,
    role: "domain",
    layer: "backend",
    parts: [],
    fileCount: 10,
    intents: [],
    exports: [],
    exportedTotal: 0,
    externals: [],
    libraries: [],
    endpoints: [],
    components: [],
    componentCount: 0,
    ...over,
  };
}

export function overview(
  systems: SystemModule[],
  links: SystemOverview["links"] = [],
): SystemOverview {
  return { systems, links, fileTotal: 100, generatedAt: "2026-01-01T00:00:00Z" };
}

const AUTH = system({
  id: "sys:auth",
  name: "Authentication",
  parts: [{ path: "packages/server/src/auth", pkg: "packages/server", fileCount: 8 }],
  libraries: [{ pkg: "jsonwebtoken", weight: 4 }],
});
const UI = system({
  id: "sys:ui",
  name: "UI",
  role: "shared",
  layer: "frontend",
  parts: [{ path: "packages/ui", pkg: "packages/ui", fileCount: 20 }],
});

describe("canonicalSystemIds", () => {
  it("keeps unsuffixed ids and re-keys collision suffixes by primary part", () => {
    const systems = [
      system({ id: "sys:api", name: "API", parts: [{ path: "packages/a/src/api", pkg: "packages/a", fileCount: 3 }] }),
      system({ id: "sys:api-2", name: "API (b)", parts: [{ path: "packages/b/src/api", pkg: "packages/b", fileCount: 3 }] }),
      system({ id: "sys:auth-2", name: "Auth 2" }), // no bare "sys:auth" sibling — a real name
    ];
    const ids = canonicalSystemIds(systems);
    expect(ids.get("sys:api")).toBe("sys:api");
    expect(ids.get("sys:api-2")).toBe("sys:api@packages-b-src-api");
    expect(ids.get("sys:auth-2")).toBe("sys:auth-2");
  });
});

describe("deriveArchGraph", () => {
  const externals: CodeExternalDep[] = [
    {
      id: "s3",
      name: "S3 / object storage",
      category: "storage",
      packages: ["@aws-sdk/client-s3"],
      clients: [{ module: "packages/server", weight: 5 }],
      weight: 5,
    },
  ];

  it("projects systems, links and external services onto canonical ids", () => {
    const graph = deriveArchGraph({
      overview: overview(
        [AUTH, UI],
        [{ source: "sys:ui", target: "sys:auth", weight: 4, symbols: ["login"] }],
      ),
      externals,
      modules: [
        { path: "packages/server", name: "server", fileCount: 30 },
        { path: "packages/ui", name: "ui", fileCount: 20 },
      ],
    });
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toEqual(["sys:auth", "sys:ui", "ext:s3"]);
    const auth = graph.nodes.find((n) => n.id === "sys:auth")!;
    expect(auth.kind).toBe("service");
    expect(auth.codeModule).toBe("packages/server"); // part dir isn't a module — falls back to pkg
    expect(auth.tech).toEqual(["jsonwebtoken"]);
    const ui = graph.nodes.find((n) => n.id === "sys:ui")!;
    expect(ui.kind).toBe("frontend"); // layer refines role
    expect(ui.codeModule).toBe("packages/ui"); // part dir IS a module
    const s3 = graph.nodes.find((n) => n.id === "ext:s3")!;
    expect(s3.kind).toBe("datastore");
    expect(graph.edges.map((e) => e.id)).toEqual([
      "link:sys:ui->sys:auth",
      "extlink:sys:auth->ext:s3",
    ]);
    expect(graph.edges[1]!.kind).toBe("data");
  });

  it("is deterministic — same input, same graph", () => {
    const input = {
      overview: overview([AUTH, UI]),
      externals,
      modules: [{ path: "packages/server", name: "server", fileCount: 30 }],
    };
    expect(deriveArchGraph(input)).toEqual(deriveArchGraph(input));
  });
});

describe("overview diff projection", () => {
  const diff: SystemOverviewDiff = {
    addedSystems: [{ id: "sys:new", name: "New", role: "domain", fileCount: 4 }],
    removedSystems: [{ id: "sys:old", name: "Old", role: "data", fileCount: 6 }],
    resized: [{ id: "sys:auth", name: "Authentication", before: 8, after: 14 }],
    addedLinks: [],
    removedLinks: [
      { source: "sys:ui", sourceName: "UI", target: "sys:old", targetName: "Old", weight: 2, symbols: [] },
    ],
    reweighted: [
      { source: "sys:ui", sourceName: "UI", target: "sys:auth", targetName: "Authentication", before: 3, after: 9, symbols: [] },
    ],
    addedExternals: [{ system: "sys:auth", systemName: "Authentication", name: "Redis" }],
    removedExternals: [],
    total: 4,
  };

  it("maps the overview diff onto shared marks", () => {
    const marks = overviewDiffMarks(diff);
    expect(marks["sys:new"]).toEqual({ kind: "added" });
    expect(marks["sys:old"]).toEqual({ kind: "removed", ghost: true });
    expect(marks["sys:auth"]).toEqual({
      kind: "changed",
      detail: "8 → 14 files · +Redis",
    });
    expect(marks["link:sys:ui->sys:old"]).toEqual({ kind: "removed", ghost: true });
    expect(marks["link:sys:ui->sys:auth"]).toEqual({
      kind: "changed",
      detail: "3 → 9 imports",
    });
  });

  it("produces ghost nodes and edges for removed systems/links", () => {
    const ghosts = overviewDiffGhosts(diff);
    expect(ghosts.nodes.map((n) => n.id)).toEqual(["sys:old"]);
    expect(ghosts.nodes[0]!.kind).toBe("datastore");
    expect(ghosts.edges.map((e) => e.id)).toEqual(["link:sys:ui->sys:old"]);
  });
});

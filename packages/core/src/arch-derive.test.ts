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

  it("carries the crossing symbol, weight and api-only flag onto link edges", () => {
    const graph = deriveArchGraph({
      overview: overview(
        [AUTH, UI],
        [
          { source: "sys:ui", target: "sys:auth", weight: 4, symbols: ["login", "logout"] },
          {
            source: "sys:auth",
            target: "sys:ui",
            weight: 0,
            symbols: [],
            apis: [
              { method: "GET", path: "/api/session", weight: 3 },
              { method: "POST", path: "/api/logout", weight: 1 },
            ],
          },
        ],
      ),
      externals: [],
      modules: [],
    });
    const imports = graph.edges.find((e) => e.id === "link:sys:ui->sys:auth")!;
    expect(imports.label).toBe("login ×4");
    expect(imports.weight).toBe(4);
    expect(imports.apiOnly).toBeUndefined();
    const wire = graph.edges.find((e) => e.id === "link:sys:auth->sys:ui")!;
    expect(wire.label).toBe("GET /api/session +1");
    expect(wire.apiOnly).toBe(true);
    expect(wire.weight).toBe(4); // matched API call weight stands in for imports
    expect(wire.kind).toBe("sync");
  });

  it("nests systems inside module containers when a module owns several", () => {
    const server1 = system({
      id: "sys:forms",
      name: "Forms",
      parts: [{ path: "packages/server/src/forms", pkg: "packages/server", fileCount: 12 }],
    });
    const server2 = system({
      id: "sys:auth",
      name: "Auth",
      parts: [{ path: "packages/server/src/auth", pkg: "packages/server", fileCount: 8 }],
    });
    const graph = deriveArchGraph({
      overview: overview([server1, server2, UI]),
      externals: [],
      modules: [
        { path: "packages/server", name: "@app/server", fileCount: 30 },
        { path: "packages/ui", name: "@app/ui", fileCount: 20 },
      ],
    });
    const mod = graph.nodes.find((n) => n.id === "mod:packages-server");
    expect(mod).toBeDefined();
    expect(mod!.kind).toBe("group");
    expect(mod!.label).toBe("@app/server");
    expect(mod!.codeModule).toBe("packages/server");
    expect(graph.nodes.find((n) => n.id === "sys:forms")!.parentId).toBe("mod:packages-server");
    expect(graph.nodes.find((n) => n.id === "sys:auth")!.parentId).toBe("mod:packages-server");
    // A one-system module IS its system — no wrapper for the UI package.
    expect(graph.nodes.find((n) => n.id === "sys:ui")!.parentId).toBeNull();
    expect(graph.nodes.some((n) => n.id === "mod:packages-ui")).toBe(false);
  });

  it("emits no module tier when every system lives in one module (or the root)", () => {
    const a = system({
      id: "sys:a",
      name: "A",
      parts: [{ path: "src/a", pkg: ".", fileCount: 5 }],
    });
    const b = system({
      id: "sys:b",
      name: "B",
      parts: [{ path: "src/b", pkg: ".", fileCount: 5 }],
    });
    const rootOnly = deriveArchGraph({ overview: overview([a, b]), externals: [], modules: [] });
    expect(rootOnly.nodes.every((n) => !n.id.startsWith("mod:"))).toBe(true);

    const oneModule = deriveArchGraph({
      overview: overview([
        system({ id: "sys:x", name: "X", parts: [{ path: "pkg/src/x", pkg: "pkg", fileCount: 3 }] }),
        system({ id: "sys:y", name: "Y", parts: [{ path: "pkg/src/y", pkg: "pkg", fileCount: 3 }] }),
      ]),
      externals: [],
      modules: [{ path: "pkg", name: "pkg", fileCount: 6 }],
    });
    // One wrapper box around everything is noise, not structure.
    expect(oneModule.nodes.every((n) => !n.id.startsWith("mod:"))).toBe(true);
  });

  it("marks edges participating in a dependency cycle", () => {
    const graph = deriveArchGraph({
      overview: overview(
        [AUTH, UI],
        [
          { source: "sys:ui", target: "sys:auth", weight: 2, symbols: ["login"] },
          { source: "sys:auth", target: "sys:ui", weight: 1, symbols: ["Button"] },
        ],
      ),
      externals: [],
      modules: [],
    });
    expect(graph.edges.every((e) => e.cycle === true)).toBe(true);
    // A one-way link is not a cycle.
    const acyclic = deriveArchGraph({
      overview: overview([AUTH, UI], [{ source: "sys:ui", target: "sys:auth", weight: 2, symbols: [] }]),
      externals: [],
      modules: [],
    });
    expect(acyclic.edges[0]!.cycle).toBeUndefined();
  });
});

describe("screens and endpoints layers", () => {
  const FRONTEND = system({
    id: "sys:web",
    name: "Web",
    role: "entry",
    layer: "frontend",
    parts: [{ path: "packages/web", pkg: "packages/web", fileCount: 12 }],
  });
  const API = system({
    id: "sys:api",
    name: "API",
    parts: [{ path: "packages/server/src/api", pkg: "packages/server", fileCount: 9 }],
    endpoints: [
      { method: "GET", path: "/api/forms", file: "packages/server/src/api/forms.ts" },
      { method: "POST", path: "/api/forms", file: "packages/server/src/api/forms.ts" },
    ],
  });
  const screens = [
    {
      id: "react-router:/forms",
      route: "/forms",
      file: "packages/web/src/pages/Forms.tsx",
      source: "react-router" as const,
    },
  ];
  const modules = [
    { path: "packages/web", name: "web", fileCount: 12 },
    { path: "packages/server", name: "server", fileCount: 9 },
  ];

  it("aggregates matched calls into labelled screen→system flow edges", () => {
    const graph = deriveArchGraph({
      overview: overview([FRONTEND, API]),
      externals: [],
      modules,
      surfaces: {
        screens,
        calls: [
          {
            screen: "react-router:/forms",
            method: "GET",
            path: "/api/forms",
            file: "packages/web/src/pages/Forms.tsx",
            endpoint: { method: "GET", path: "/api/forms", file: "packages/server/src/api/forms.ts" },
          },
        ],
      },
    });
    const flow = graph.edges.find((e) => e.id.startsWith("flow:"))!;
    expect(flow.source).toBe("screen:react-router:/forms");
    expect(flow.target).toBe("sys:api");
    expect(flow.label).toBe("GET /api/forms"); // the route itself for a single call
    expect(flow.weight).toBe(1);
    expect(flow.apiOnly).toBe(true);
  });

  it("materializes called routes as ep: nodes grouped per serving system", () => {
    const graph = deriveArchGraph({
      overview: overview([FRONTEND, API]),
      externals: [],
      modules,
      surfaces: {
        endpoints: true,
        screens,
        calls: [
          {
            screen: "react-router:/forms",
            method: "GET",
            path: "/api/forms",
            file: "packages/web/src/pages/Forms.tsx",
            endpoint: { method: "GET", path: "/api/forms", file: "packages/server/src/api/forms.ts" },
          },
          {
            screen: "react-router:/forms",
            method: "GET",
            path: "/api/forms",
            file: "packages/web/src/components/FormList.tsx",
            endpoint: { method: "GET", path: "/api/forms", file: "packages/server/src/api/forms.ts" },
          },
        ],
      },
    });
    const ep = graph.nodes.find((n) => n.id === "ep:GET /api/forms")!;
    expect(ep.kind).toBe("endpoint");
    expect(ep.parentId).toBe("routes:sys:api");
    expect(ep.codeFile).toBe("packages/server/src/api/forms.ts");
    const group = graph.nodes.find((n) => n.id === "routes:sys:api")!;
    expect(group.kind).toBe("group");
    expect(group.label).toBe("API routes");
    // The routes box is anchored beside the system that serves them…
    expect(graph.edges.some((e) => e.id === "eplink:routes:sys:api->sys:api")).toBe(true);
    // …and the flow targets the route, aggregated over both call sites.
    const flow = graph.edges.find((e) => e.id.startsWith("flow:"))!;
    expect(flow.target).toBe("ep:GET /api/forms");
    expect(flow.label).toBe("2 calls");
    expect(flow.weight).toBe(2);
    // The uncalled POST route stays off the canvas (pane material, not graph).
    expect(graph.nodes.some((n) => n.id === "ep:POST /api/forms")).toBe(false);
  });

  it("suppresses same-system loops and badges unmatched calls", () => {
    const graph = deriveArchGraph({
      overview: overview([FRONTEND, API]),
      externals: [],
      modules,
      surfaces: {
        screens,
        calls: [
          {
            // Serving file lives in the screen's own system — plumbing, not architecture.
            screen: "react-router:/forms",
            method: "GET",
            path: "/session",
            file: "packages/web/src/pages/Forms.tsx",
            endpoint: { method: "GET", path: "/session", file: "packages/web/src/server.ts" },
          },
          {
            // No serving route matched — drift worth surfacing on the card.
            screen: "react-router:/forms",
            method: "POST",
            path: "/api/missing",
            file: "packages/web/src/pages/Forms.tsx",
          },
        ],
      },
    });
    expect(graph.edges.some((e) => e.id.startsWith("flow:"))).toBe(false);
    const screen = graph.nodes.find((n) => n.id === "screen:react-router:/forms")!;
    expect(screen.description).toContain("1 unmatched call");
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

describe("instance-granular externals", () => {
  it("derives one node per named instance plus a residual service node", () => {
    const externals: CodeExternalDep[] = [
      {
        id: "s3",
        name: "S3 / object storage",
        category: "storage",
        packages: ["@aws-sdk/client-s3"],
        clients: [
          { module: "packages/server", weight: 5 },
          { module: "packages/worker", weight: 2 },
        ],
        weight: 7,
        instances: [
          { name: "uploads", clients: [{ module: "packages/server", weight: 3 }], weight: 3 },
          { name: "exports", clients: [{ module: "packages/server", weight: 2 }], weight: 2 },
        ],
      },
    ];
    const graph = deriveArchGraph({
      overview: overview([
        system({
          id: "sys:server",
          name: "Server",
          parts: [{ path: "packages/server", pkg: "packages/server", fileCount: 5 }],
        }),
        system({
          id: "sys:worker",
          name: "Worker",
          parts: [{ path: "packages/worker", pkg: "packages/worker", fileCount: 2 }],
        }),
      ]),
      externals,
      modules: [],
    });
    const extIds = graph.nodes.filter((n) => n.id.startsWith("ext:")).map((n) => n.id);
    // two named buckets + the residual service node (packages/worker unclaimed)
    expect(extIds).toEqual(["ext:s3:uploads", "ext:s3:exports", "ext:s3"]);
    const uploads = graph.nodes.find((n) => n.id === "ext:s3:uploads")!;
    expect(uploads.label).toBe("uploads");
    expect(uploads.kind).toBe("datastore");
    expect(graph.edges.map((e) => e.id)).toEqual([
      "extlink:sys:server->ext:s3:uploads",
      "extlink:sys:server->ext:s3:exports",
      "extlink:sys:worker->ext:s3",
    ]);
  });

  it("fully claimed clients drop the residual service node", () => {
    const externals: CodeExternalDep[] = [
      {
        id: "redis-queue",
        name: "Redis queue",
        category: "queue",
        packages: ["bullmq"],
        clients: [{ module: "packages/server", weight: 4 }],
        weight: 4,
        instances: [
          { name: "emails", clients: [{ module: "packages/server", weight: 4 }], weight: 4 },
        ],
      },
    ];
    const graph = deriveArchGraph({
      overview: overview([
        system({
          id: "sys:server",
          name: "Server",
          parts: [{ path: "packages/server", pkg: "packages/server", fileCount: 5 }],
        }),
      ]),
      externals,
      modules: [],
    });
    const extIds = graph.nodes.filter((n) => n.id.startsWith("ext:")).map((n) => n.id);
    expect(extIds).toEqual(["ext:redis-queue:emails"]);
    expect(graph.edges.map((e) => e.id)).toEqual([
      "extlink:sys:server->ext:redis-queue:emails",
    ]);
  });
});

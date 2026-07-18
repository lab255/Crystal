import { describe, expect, it } from "vitest";
import type {
  ScreenApiCall,
  ScreenSurface,
  SurfacesReport,
  SystemLayer,
  SystemModule,
  SystemOverview,
  SystemRole,
} from "@crystal/core";
import {
  buildSystemMapScene,
  screenNodeId,
  type MapScreenData,
  type MapSystemData,
  type SystemMapScene,
} from "./scene.js";

/* ---- fixtures ---- */

const ROLE_OF_LAYER: Record<SystemLayer, SystemRole> = {
  frontend: "domain",
  backend: "domain",
  database: "data",
  integrations: "integration",
};

function sys(
  id: string,
  layer: SystemLayer,
  partPath: string,
  patch: Partial<SystemModule> = {},
): SystemModule {
  return {
    id,
    name: id.replace(/^sys:/, ""),
    concept: null,
    role: ROLE_OF_LAYER[layer],
    layer,
    parts: [{ path: partPath, pkg: ".", fileCount: 4 }],
    fileCount: 4,
    intents: [],
    exports: [],
    exportedTotal: 0,
    externals: [],
    endpoints: [],
    components: [],
    componentCount: 0,
    ...patch,
  };
}

function screen(id: string, route: string, file: string): ScreenSurface {
  return { id, route, file, source: "react-router" };
}

function report(patch: Partial<SurfacesReport> = {}): SurfacesReport {
  return {
    screens: [],
    components: [],
    stories: [],
    endpoints: [],
    schemas: [],
    demo: { appUrl: null, storybookUrl: null },
    generatedAt: "",
    ...patch,
  };
}

function overview(
  systems: SystemModule[],
  links: SystemOverview["links"] = [],
): SystemOverview {
  return { systems, links, fileTotal: systems.length * 4, generatedAt: "" };
}

function call(
  screenId: string,
  method: string,
  path: string,
  endpointFile?: string,
): ScreenApiCall {
  return {
    screen: screenId,
    method,
    path,
    file: "web/src/api.ts",
    ...(endpointFile ? { endpoint: { method, path, file: endpointFile } } : {}),
  };
}

function build(
  input: Partial<Parameters<typeof buildSystemMapScene>[0]> = {},
): SystemMapScene {
  return buildSystemMapScene({
    report: report(),
    overview: overview([]),
    calls: [],
    selected: null,
    find: "",
    ...input,
  });
}

const nodeById = (scene: SystemMapScene, id: string) =>
  scene.nodes.find((n) => n.id === id);

/* ---- tests ---- */

describe("buildSystemMapScene — bands", () => {
  it("assigns systems to layer bands and skips empty bands", () => {
    const scene = build({
      overview: overview([
        sys("sys:api", "backend", "server/api"),
        sys("sys:store", "database", "server/db"),
      ]),
    });
    expect(nodeById(scene, "band:backend")).toBeTruthy();
    expect(nodeById(scene, "band:data")).toBeTruthy();
    expect(nodeById(scene, "band:screens")).toBeUndefined();
    expect(nodeById(scene, "band:integrations")).toBeUndefined();
    expect(nodeById(scene, "sys:api")?.parentId).toBe("band:backend");
    expect(nodeById(scene, "sys:store")?.parentId).toBe("band:data");
  });

  it("orders parents before children (react-flow requirement)", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/a/page.tsx")] }),
      overview: overview([
        sys("sys:web-a", "frontend", "web/a"),
        sys("sys:web-b", "frontend", "web/b"),
        sys("sys:api", "backend", "server/api"),
      ]),
    });
    const indexOf = new Map(scene.nodes.map((n, i) => [n.id, i]));
    for (const n of scene.nodes) {
      if (n.parentId) {
        expect(indexOf.get(n.parentId)).toBeLessThan(indexOf.get(n.id)!);
      }
    }
  });

  it("builds a backend-only map when there are no screens", () => {
    const scene = build({
      overview: overview([sys("sys:api", "backend", "server/api")]),
      calls: [call("ghost", "GET", "/x", "server/api/r.ts")],
    });
    expect(scene.empty).toBe(false);
    expect(nodeById(scene, "sys:api")).toBeTruthy();
    expect(scene.edges.filter((e) => (e.data as { kind?: string }).kind === "call")).toHaveLength(0);
  });

  it("hides fixture-scoped systems and screens, reporting the count", () => {
    const scene = build({
      report: report({
        screens: [
          screen("s1", "/a", "examples/demo/web/pages/Home.tsx"),
          screen("s2", "/b", "web/pages/Home.tsx"),
        ],
      }),
      overview: overview([
        sys("sys:web", "frontend", "web"),
        sys("sys:demo-api", "backend", "examples/demo/server"),
      ]),
    });
    expect(nodeById(scene, "sys:demo-api")).toBeUndefined();
    expect(nodeById(scene, screenNodeId("s1"))).toBeUndefined();
    expect(nodeById(scene, screenNodeId("s2"))).toBeTruthy();
    expect(scene.fixturesHidden).toBe(2);
  });

  it("trims quiet-role backend systems unless the product story involves them", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([
        sys("sys:web", "frontend", "web"),
        sys("sys:api", "backend", "server/api", {
          endpoints: [{ method: "GET", path: "/x", file: "server/api/r.ts" }],
        }),
        // Pure platform noise: shared role, no endpoints, nothing calls it.
        sys("sys:utils", "backend", "server/utils", { role: "shared" }),
        // Shared role but it serves a traced call — stays.
        sys("sys:kernel", "backend", "server/kernel", { role: "shared" }),
      ]),
      calls: [call("s1", "GET", "/k", "server/kernel/k.ts")],
    });
    expect(nodeById(scene, "sys:utils")).toBeUndefined();
    expect(nodeById(scene, "sys:kernel")).toBeTruthy();
    expect(scene.quietHidden).toBe(1);
    // A workspace made only of quiet systems still maps everything.
    const allQuiet = build({
      overview: overview([sys("sys:utils", "backend", "src/utils", { role: "shared" })]),
    });
    expect(nodeById(allQuiet, "sys:utils")).toBeTruthy();
    expect(allQuiet.quietHidden).toBe(0);
  });

  it("returns an empty scene for empty input", () => {
    const scene = build();
    expect(scene.empty).toBe(true);
    expect(scene.nodes).toHaveLength(0);
    expect(scene.edges).toHaveLength(0);
  });
});

describe("buildSystemMapScene — screens grouping", () => {
  it("groups screens under their owning frontend system when several exist", () => {
    const scene = build({
      report: report({
        screens: [
          screen("s1", "/a", "web/a/pages/Home.tsx"),
          screen("s2", "/b", "web/b/pages/Home.tsx"),
        ],
      }),
      overview: overview([
        sys("sys:web-a", "frontend", "web/a"),
        sys("sys:web-b", "frontend", "web/b"),
      ]),
    });
    expect(nodeById(scene, "sys:web-a")?.type).toBe("mapFeGroup");
    expect(nodeById(scene, screenNodeId("s1"))?.parentId).toBe("sys:web-a");
    expect(nodeById(scene, screenNodeId("s2"))?.parentId).toBe("sys:web-b");
  });

  it("groups a single frontend system's screens under its labelled container", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web")]),
    });
    expect(nodeById(scene, "sys:web")?.type).toBe("mapFeGroup");
    expect(nodeById(scene, screenNodeId("s1"))?.parentId).toBe("sys:web");
  });

  it("lays unattributed screens directly in the band", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "elsewhere/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web")]),
    });
    expect(nodeById(scene, screenNodeId("s1"))?.parentId).toBe("band:screens");
  });

  it("gives a screen-less frontend system a compact card", () => {
    const scene = build({
      report: report({
        screens: [screen("s1", "/a", "web/a/pages/Home.tsx")],
      }),
      overview: overview([
        sys("sys:web-a", "frontend", "web/a"),
        sys("sys:admin", "frontend", "web/admin"),
      ]),
    });
    const card = nodeById(scene, "sys:admin");
    expect(card?.type).toBe("mapSystem");
    expect((card?.data as MapSystemData).compact).toBe(true);
  });
});

describe("buildSystemMapScene — edges", () => {
  const backend = sys("sys:api", "backend", "server/api", {
    endpoints: [
      { method: "GET", path: "/x", file: "server/api/r.ts" },
      { method: "POST", path: "/y", file: "server/api/r.ts" },
    ],
  });

  it("aggregates screen calls per (screen, system) with a call-count label", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
      calls: [
        call("s1", "GET", "/x", "server/api/r.ts"),
        call("s1", "POST", "/y", "server/api/r.ts"),
      ],
    });
    const edge = scene.edges.find((e) => e.id === "call:screen:s1->sys:api");
    expect(edge).toBeTruthy();
    expect(edge?.label).toBe("2 calls");
    // A single call labels with its route instead.
    const single = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
      calls: [call("s1", "GET", "/x", "server/api/r.ts")],
    });
    expect(single.edges.find((e) => e.id === "call:screen:s1->sys:api")?.label).toBe("GET /x");
  });

  it("ignores unmatched calls and calls from unknown screens", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
      calls: [call("s1", "GET", "/external"), call("ghost", "GET", "/x", "server/api/r.ts")],
    });
    expect(scene.edges.filter((e) => (e.data as { kind?: string }).kind === "call")).toHaveLength(0);
    // The unmatched call still counts on the screen card — flagged as drift.
    const data = nodeById(scene, screenNodeId("s1"))?.data as MapScreenData;
    expect(data.callCount).toBe(1);
    expect(data.unmatchedCount).toBe(1);
  });

  it("falls back to SystemLink.apis edges for frontend systems without screen edges", () => {
    const overviewData = overview(
      [sys("sys:web-a", "frontend", "web/a"), sys("sys:web-b", "frontend", "web/b"), backend],
      [
        {
          source: "sys:web-a",
          target: "sys:api",
          weight: 0,
          symbols: [],
          apis: [{ method: "GET", path: "/x", weight: 2 }],
        },
      ],
    );
    const noScreens = build({
      report: report({ screens: [screen("s1", "/a", "web/a/pages/Home.tsx")] }),
      overview: overviewData,
    });
    expect(noScreens.edges.find((e) => e.id === "feapi:sys:web-a->sys:api")).toBeTruthy();
    // …but not when a screen-level edge already covers the pair.
    const covered = build({
      report: report({ screens: [screen("s1", "/a", "web/a/pages/Home.tsx")] }),
      overview: overviewData,
      calls: [call("s1", "GET", "/x", "server/api/r.ts")],
    });
    expect(covered.edges.find((e) => e.id === "feapi:sys:web-a->sys:api")).toBeUndefined();
    expect(covered.edges.find((e) => e.id === "call:screen:s1->sys:api")).toBeTruthy();
  });

  it("draws system→system links between non-frontend systems, api-only ones dashed", () => {
    const scene = build({
      overview: overview(
        [backend, sys("sys:store", "database", "server/db"), sys("sys:hooks", "integrations", "server/hooks")],
        [
          { source: "sys:api", target: "sys:store", weight: 3, symbols: [] },
          {
            source: "sys:hooks",
            target: "sys:api",
            weight: 0,
            symbols: [],
            apis: [{ method: "POST", path: "/y", weight: 1 }],
          },
        ],
      ),
    });
    const imports = scene.edges.find((e) => e.id === "link:sys:api->sys:store");
    expect(imports?.label).toBe("×3");
    expect(imports?.style?.strokeDasharray).toBeUndefined();
    // Downward cross-band traffic flows bottom → top…
    expect(imports?.sourceHandle).toBe("b");
    expect(imports?.targetHandle).toBe("t");
    const apiOnly = scene.edges.find((e) => e.id === "link:sys:hooks->sys:api");
    expect(apiOnly?.label).toBe("POST /y");
    expect(apiOnly?.style?.strokeDasharray).toBe("4 3");
    expect(apiOnly?.animated).toBe(true);
    // …while upward links keep the side handles.
    expect(apiOnly?.sourceHandle).toBe("r");
    expect(apiOnly?.targetHandle).toBe("l");
  });

  it("draws edges to frontend-served systems, but never to the screen's own container", () => {
    const scene = build({
      report: report({
        screens: [screen("s1", "/a", "web/a/pages/Home.tsx")],
      }),
      overview: overview([
        sys("sys:web-a", "frontend", "web/a"),
        sys("sys:web-b", "frontend", "web/b"),
      ]),
      calls: [
        // Served by the *other* frontend system (a BFF / Next app/api) — draws.
        call("s1", "GET", "/api/x", "web/b/api/routes.ts"),
        // Served by the screen's own system — a loop on its own card; skipped.
        call("s1", "GET", "/api/self", "web/a/api/self.ts"),
      ],
    });
    expect(scene.edges.find((e) => e.id === "call:screen:s1->sys:web-b")).toBeTruthy();
    expect(scene.edges.find((e) => e.id === "call:screen:s1->sys:web-a")).toBeUndefined();
  });

  it("resolves the selection object the inspector consumes; stale ids resolve null", () => {
    const screens = [screen("s1", "/a", "web/pages/Home.tsx")];
    const base = {
      report: report({ screens }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
    };
    const onScreen = build({ ...base, selected: screenNodeId("s1") });
    expect(onScreen.selection).toMatchObject({ kind: "screen", screen: { id: "s1" } });
    const onEp = build({ ...base, selected: "ep:GET /x" });
    expect(onEp.selection).toMatchObject({ kind: "endpoint", epKey: "GET /x" });
    const stale = build({ ...base, selected: "sys:renamed-away" });
    expect(stale.selection).toBeNull();
    const fixtureHidden = build({
      ...base,
      overview: overview([sys("sys:demo", "backend", "examples/demo/server")]),
      selected: "sys:demo",
    });
    expect(fixtureHidden.selection).toBeNull();
  });

  it("routes screen call edges bottom → top into the serving system", () => {
    const scene = build({
      report: report({ screens: [screen("s1", "/a", "web/pages/Home.tsx")] }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
      calls: [call("s1", "GET", "/x", "server/api/r.ts")],
    });
    const edge = scene.edges.find((e) => e.id === "call:screen:s1->sys:api");
    expect(edge?.sourceHandle).toBe("b");
    expect(edge?.targetHandle).toBe("t");
  });
});

describe("buildSystemMapScene — selection and find", () => {
  const backend = sys("sys:api", "backend", "server/api", {
    endpoints: [{ method: "GET", path: "/x", file: "server/api/r.ts" }],
  });
  const screens = [
    screen("s1", "/caller", "web/pages/Caller.tsx"),
    screen("s2", "/idle", "web/pages/Idle.tsx"),
  ];

  it("selecting a node dims non-neighbors and fades non-incident edges", () => {
    const scene = build({
      report: report({ screens }),
      overview: overview([sys("sys:web", "frontend", "web"), backend, sys("sys:store", "database", "server/db")]),
      calls: [call("s1", "GET", "/x", "server/api/r.ts")],
      selected: screenNodeId("s1"),
    });
    expect((nodeById(scene, screenNodeId("s1"))?.data as MapScreenData).dimmed).toBe(false);
    expect((nodeById(scene, "sys:api")?.data as MapSystemData).dimmed).toBe(false);
    expect((nodeById(scene, screenNodeId("s2"))?.data as MapScreenData).dimmed).toBe(true);
    expect((nodeById(scene, "sys:store")?.data as MapSystemData).dimmed).toBe(true);
    const edge = scene.edges.find((e) => e.id === "call:screen:s1->sys:api");
    expect(edge?.style?.opacity).toBe(1);
  });

  it("selecting an endpoint keeps its owner and callers bright", () => {
    const scene = build({
      report: report({ screens }),
      overview: overview([sys("sys:web", "frontend", "web"), backend]),
      calls: [call("s1", "GET", "/x", "server/api/r.ts")],
      selected: "ep:GET /x",
    });
    const owner = nodeById(scene, "sys:api")?.data as MapSystemData;
    expect(owner.dimmed).toBe(false);
    expect(owner.selected).toBe(true);
    expect(owner.selectedEndpoint).toBe("GET /x");
    expect((nodeById(scene, screenNodeId("s1"))?.data as MapScreenData).dimmed).toBe(false);
    expect((nodeById(scene, screenNodeId("s2"))?.data as MapScreenData).dimmed).toBe(true);
  });

  it("a stale selected id dims nothing", () => {
    const scene = build({
      report: report({ screens }),
      overview: overview([backend]),
      selected: "sys:renamed-away",
    });
    expect(scene.nodes.some((n) => (n.data as { dimmed?: boolean }).dimmed)).toBe(false);
  });

  it("find dims misses across screens and systems", () => {
    const scene = build({
      report: report({ screens }),
      overview: overview([backend]),
      find: "caller",
    });
    expect((nodeById(scene, screenNodeId("s1"))?.data as MapScreenData).dimmed).toBe(false);
    expect((nodeById(scene, screenNodeId("s2"))?.data as MapScreenData).dimmed).toBe(true);
    expect((nodeById(scene, "sys:api")?.data as MapSystemData).dimmed).toBe(true);
    // Endpoint text matches count for the serving system.
    const byRoute = build({
      report: report({ screens }),
      overview: overview([backend]),
      find: "get /x",
    });
    expect((nodeById(byRoute, "sys:api")?.data as MapSystemData).dimmed).toBe(false);
  });
});

describe("buildSystemMapScene — ref-review marks", () => {
  const backend = sys("sys:api", "backend", "server/api", {
    endpoints: [
      { method: "GET", path: "/x", file: "server/api/r.ts" },
      { method: "POST", path: "/x", file: "server/api/r.ts" },
    ],
  });
  const screens = [
    screen("s1", "/caller", "web/pages/Caller.tsx"),
    screen("s2", "/gone", "web/pages/Gone.tsx"),
  ];
  const calls = [call("s1", "GET", "/x", "server/api/r.ts")];
  const marks = {
    node: new Map([
      [screenNodeId("s1"), "modified" as const],
      [screenNodeId("s2"), "removed" as const],
      ["sys:api", "modified" as const],
    ]),
    edge: new Map([[`call:${screenNodeId("s1")}->sys:api`, "added" as const]]),
    ep: new Map([["sys:api|POST /x", "removed" as const]]),
  };

  it("stamps node marks and per-card endpoint marks during decoration", () => {
    const scene = build({ report: report({ screens }), overview: overview([backend]), calls, marks });
    expect((nodeById(scene, screenNodeId("s1"))?.data as MapScreenData).mark).toBe("modified");
    expect((nodeById(scene, screenNodeId("s2"))?.data as MapScreenData).mark).toBe("removed");
    const sysData = nodeById(scene, "sys:api")?.data as MapSystemData;
    expect(sysData.mark).toBe("modified");
    expect(sysData.epMarks).toEqual({ "POST /x": "removed" });
  });

  it("colors marked edges even at rest and keeps them readable when faded", () => {
    const scene = build({ report: report({ screens }), overview: overview([backend]), calls, marks });
    const edge = scene.edges.find((e) => e.id === `call:${screenNodeId("s1")}->sys:api`)!;
    expect(edge.style?.stroke).toBe("var(--color-ok)");
    // Selecting an unrelated node fades the marked edge but not to invisibility.
    const selectedScene = build({
      report: report({ screens }),
      overview: overview([backend]),
      calls,
      marks,
      selected: screenNodeId("s2"),
    });
    const faded = selectedScene.edges.find((e) => e.id === `call:${screenNodeId("s1")}->sys:api`)!;
    expect(faded.style?.stroke).toBe("var(--color-ok)");
    expect(faded.style?.opacity).toBe(0.45);
  });

  it("dashes removed edges", () => {
    const removedMarks = {
      node: new Map(),
      edge: new Map([[`call:${screenNodeId("s1")}->sys:api`, "removed" as const]]),
      ep: new Map(),
    };
    const scene = build({
      report: report({ screens }),
      overview: overview([backend]),
      calls,
      marks: removedMarks,
    });
    const edge = scene.edges.find((e) => e.id === `call:${screenNodeId("s1")}->sys:api`)!;
    expect(edge.style?.stroke).toBe("var(--color-danger)");
    expect(edge.style?.strokeDasharray).toBe("5 4");
  });
});

import { describe, expect, it } from "vitest";
import { system, overview } from "./arch-derive.test.js";
import { deriveArchGraph } from "./arch-derive.js";
import {
  C4_SHARED_CONTAINER_ID,
  C4_SYSTEM_ID,
  C4_USER_PERSON_ID,
  c4RelId,
  c4ViewKey,
  containerForFile,
  containerNodeIdOf,
  deriveC4Model,
  isInfraCategory,
  projectC4,
  relationVerb,
  rollupC4Marks,
  schemaNodeId,
  schemaRefEdgeId,
  type C4DeriveInput,
} from "./c4.js";
import type { CodeExternalDep } from "./external-services.js";
import type { CodeModule, CodeModuleDep } from "./codemap.js";
import type { SchemaSurface } from "./surfaces.js";

/** A three-container monorepo: server app, web app, shared library code. */
const MODULES: CodeModule[] = [
  { path: ".", name: "crystal", fileCount: 2 },
  { path: "apps/server", name: "server", fileCount: 30 },
  { path: "apps/web", name: "web", fileCount: 20 },
  { path: "packages/core", name: "core", fileCount: 40 },
];
const DEPS: CodeModuleDep[] = [
  { source: "apps/server", target: "packages/core", weight: 12 },
  { source: "apps/web", target: "packages/core", weight: 9 },
];
const EXTERNALS: CodeExternalDep[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "database",
    packages: ["pg"],
    clients: [{ module: "apps/server", weight: 6 }],
    weight: 6,
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    packages: ["stripe"],
    clients: [{ module: "apps/server", weight: 2 }],
    weight: 2,
  },
];

const API = system({
  id: "sys:api",
  name: "API",
  role: "entry",
  parts: [{ path: "apps/server/src/api", pkg: "apps/server", fileCount: 18 }],
  endpoints: [{ method: "GET", path: "/api/things", file: "apps/server/src/api/routes.ts" }],
  libraries: [{ pkg: "fastify", weight: 9 }],
});
const SCREENS = system({
  id: "sys:screens",
  name: "Screens",
  layer: "frontend",
  parts: [{ path: "apps/web/src", pkg: "apps/web", fileCount: 16 }],
  libraries: [{ pkg: "react", weight: 20 }],
});
const MODEL = system({
  id: "sys:model",
  name: "Domain model",
  role: "shared",
  parts: [{ path: "packages/core/src", pkg: "packages/core", fileCount: 30 }],
});

const OVERVIEW = overview(
  [API, SCREENS, MODEL],
  [
    { source: "sys:api", target: "sys:model", weight: 5, symbols: ["parseThing"] },
    { source: "sys:screens", target: "sys:model", weight: 3, symbols: ["Thing"] },
  ],
);

const INPUT: C4DeriveInput = {
  overview: OVERVIEW,
  externals: EXTERNALS,
  modules: MODULES,
  deps: DEPS,
};

const USER_SCHEMA: SchemaSurface = {
  id: "apps/server/src/data.ts#User",
  name: "User",
  file: "apps/server/src/data.ts",
  line: 3,
  kind: "interface",
  fields: [
    { name: "id", type: "string", pk: true },
    { name: "email", type: "string" },
  ],
  usedBy: 4,
};
const TEAM_SCHEMA: SchemaSurface = {
  id: "apps/server/src/data.ts#Team",
  name: "Team",
  file: "apps/server/src/data.ts",
  line: 12,
  kind: "interface",
  fields: [
    { name: "owner", type: "User", references: "User" },
    { name: "view", type: "ViewState", references: "ViewState" },
  ],
  usedBy: 2,
};
const VIEW_SCHEMA: SchemaSurface = {
  id: "apps/web/src/state.ts#ViewState",
  name: "ViewState",
  file: "apps/web/src/state.ts",
  line: 5,
  kind: "type",
  fields: [{ name: "viewer", type: "User", references: "User" }],
  usedBy: 3,
};
const SCHEMAS = [USER_SCHEMA, TEAM_SCHEMA, VIEW_SCHEMA] as const;

function derive() {
  return deriveC4Model(INPUT);
}

function derivedGraph() {
  return deriveArchGraph({ overview: OVERVIEW, externals: EXTERNALS, modules: MODULES });
}

describe("deriveC4Model", () => {
  it("seeds a container per deployable module and pools library code as shared", () => {
    const model = derive();
    const byId = new Map(model.containers.map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual([
      "ctr:apps-server",
      "ctr:apps-web",
      C4_SHARED_CONTAINER_ID,
    ]);
    expect(byId.get("ctr:apps-server")).toMatchObject({
      name: "server",
      variant: "server",
      memberSystemIds: ["sys:api"],
      modulePath: "apps/server",
    });
    expect(byId.get("ctr:apps-web")).toMatchObject({ variant: "web", memberSystemIds: ["sys:screens"] });
    expect(byId.get(C4_SHARED_CONTAINER_ID)).toMatchObject({
      variant: "shared",
      memberSystemIds: ["sys:model"],
    });
    expect(model.containerOfSystem).toEqual({
      "sys:api": "ctr:apps-server",
      "sys:screens": "ctr:apps-web",
      "sys:model": C4_SHARED_CONTAINER_ID,
    });
    expect(model.containerOfModule["packages/core"]).toBe(C4_SHARED_CONTAINER_ID);
    expect(model.systemName).toBe("crystal");
    expect(model.hasScreens).toBe(true);
    expect(model.categoryOfService.stripe).toBe("payments");
    expect(model.nameOfService.postgres).toBe("PostgreSQL");
  });

  it("disambiguates colliding module slugs without changing ordinary ids", () => {
    const fooDash = system({
      id: "sys:foo-dash",
      name: "Foo dash",
      parts: [{ path: "apps/foo-bar/src", pkg: "apps/foo-bar", fileCount: 4 }],
      endpoints: [{ method: "GET", path: "/dash", file: "apps/foo-bar/src/api.ts" }],
    });
    const fooUnderscore = system({
      id: "sys:foo-underscore",
      name: "Foo underscore",
      parts: [{ path: "apps/foo_bar/src", pkg: "apps/foo_bar", fileCount: 5 }],
      endpoints: [{ method: "GET", path: "/underscore", file: "apps/foo_bar/src/api.ts" }],
    });
    const modules: CodeModule[] = [
      { path: ".", name: "collision", fileCount: 9 },
      { path: "apps/foo-bar", name: "foo-dash", fileCount: 4 },
      { path: "apps/foo_bar", name: "foo-underscore", fileCount: 5 },
    ];
    const input: C4DeriveInput = {
      overview: overview([fooDash, fooUnderscore]),
      externals: [],
      modules,
    };

    const first = deriveC4Model(input);
    const reversed = deriveC4Model({ ...input, modules: [...modules].reverse() });
    const dashId = first.containerOfModule["apps/foo-bar"]!;
    const underscoreId = first.containerOfModule["apps/foo_bar"]!;
    expect(dashId).not.toBe(underscoreId);
    expect(first.containers.map((container) => container.id)).toEqual(
      expect.arrayContaining([dashId, underscoreId]),
    );
    expect(reversed.containerOfModule["apps/foo-bar"]).toBe(dashId);
    expect(reversed.containerOfModule["apps/foo_bar"]).toBe(underscoreId);

    expect(containerNodeIdOf("apps/server")).toBe("ctr:apps-server");
    expect(derive().containerOfModule["apps/server"]).toBe("ctr:apps-server");
  });

  it("folds library code into a single app instead of minting a shared box", () => {
    const model = deriveC4Model({
      ...INPUT,
      overview: overview([API, MODEL], OVERVIEW.links),
      modules: MODULES.filter((m) => m.path !== "apps/web"),
      deps: [DEPS[0]!],
    });
    expect(model.containers.map((c) => c.id)).toEqual(["ctr:apps-server"]);
    expect(model.containerOfSystem["sys:model"]).toBe("ctr:apps-server");
  });

  it("falls back to one app container for a single-package repo", () => {
    const model = deriveC4Model({
      overview: overview([
        system({ id: "sys:pages", name: "Pages", layer: "frontend", parts: [{ path: "src/pages", pkg: ".", fileCount: 5 }] }),
        system({ id: "sys:logic", name: "Logic", parts: [{ path: "src/logic", pkg: ".", fileCount: 7 }] }),
      ]),
      externals: [],
      modules: [{ path: ".", name: "app", fileCount: 12 }],
    });
    expect(model.containers.map((c) => c.id)).toEqual(["ctr:app"]);
    expect(model.containers[0]).toMatchObject({ name: "app", variant: "web", modulePath: "." });
    expect(model.containerOfSystem["sys:pages"]).toBe("ctr:app");
    expect(model.containerOfSystem["sys:logic"]).toBe("ctr:app");
    expect(model.containerOfModule["."]).toBe("ctr:app");
  });

  it("never lets synthetic dir modules seed containers", () => {
    // A single-package SPA: dir modules synthesized per folder, screens
    // spread across them — every folder used to become its own "web app".
    const model = deriveC4Model({
      overview: overview(
        [
          system({ id: "sys:components", name: "Components", layer: "frontend", parts: [{ path: "src/components", pkg: "src/components", fileCount: 13 }] }),
          system({ id: "sys:geometry", name: "Geometry", parts: [{ path: "src/geometry", pkg: "src/geometry", fileCount: 15 }] }),
          system({ id: "sys:sim", name: "Sim", parts: [{ path: "src/sim", pkg: "src/sim", fileCount: 2 }] }),
        ],
        [{ source: "sys:components", target: "sys:geometry", weight: 8, symbols: ["mesh"] }],
      ),
      externals: [],
      modules: [
        { path: ".", name: "inventor", fileCount: 90 },
        { path: "src/components", name: "components", fileCount: 13, synthetic: true },
        { path: "src/geometry", name: "geometry", fileCount: 15, synthetic: true },
        { path: "src/sim", name: "sim", fileCount: 2, synthetic: true },
      ],
      deps: [{ source: "src/components", target: "src/geometry", weight: 8 }],
      screens: [{ id: "scr:main", route: "/", file: "src/components/App.tsx" }] as never,
    });
    expect(model.containers.map((c) => c.id)).toEqual(["ctr:app"]);
    expect(model.containers[0]).toMatchObject({ name: "inventor", variant: "web" });
    expect(new Set(Object.values(model.containerOfSystem))).toEqual(new Set(["ctr:app"]));
    expect(model.containerOfModule["src/geometry"]).toBe("ctr:app");
  });

  it("attributes screens to their owning container", () => {
    const model = deriveC4Model({
      ...INPUT,
      screens: [
        { id: "scr:home", route: "/", file: "apps/web/src/Home.tsx" },
        { id: "scr:about", route: "/about", file: "apps/web/src/About.tsx" },
      ] as never,
    });
    const web = model.containers.find((c) => c.id === "ctr:apps-web")!;
    expect(web.screenCount).toBe(2);
    expect(model.containers.find((c) => c.id === "ctr:apps-server")!.screenCount).toBe(0);
  });

  it("marks a seedless library repo as shared library code", () => {
    const model = deriveC4Model({
      overview: overview([
        system({ id: "sys:utils", name: "Utils", role: "shared", parts: [{ path: "src/utils", pkg: ".", fileCount: 9 }] }),
      ]),
      externals: [],
      modules: [{ path: ".", name: "lib", fileCount: 9 }],
    });
    expect(model.containers.map((c) => c.variant)).toEqual(["shared"]);
  });
});

describe("projectC4 · context", () => {
  it("shows persons, one system box and external systems only", () => {
    const projection = projectC4({ graph: derivedGraph(), model: derive(), view: { level: "context" } });
    const ids = projection.graph.nodes.map((n) => n.id);
    expect(ids).toContain(C4_USER_PERSON_ID);
    expect(ids).toContain(C4_SYSTEM_ID);
    expect(ids).toContain("ext:stripe");
    expect(ids).not.toContain("ext:postgres"); // owned infra lives inside the system
    expect(ids).not.toContain("sys:api");
    // Internals roll up into the system box; the person uses it.
    expect(projection.nodeRollup["sys:api"]).toBe(C4_SYSTEM_ID);
    const rel = projection.graph.edges.find((e) => e.id === c4RelId(C4_SYSTEM_ID, "ext:stripe"));
    expect(rel?.label).toContain(relationVerb("payments"));
    expect(
      projection.graph.edges.some(
        (e) => e.source === C4_USER_PERSON_ID && e.target === C4_SYSTEM_ID && e.label === "Uses",
      ),
    ).toBe(true);
    expect(projection.drill[C4_SYSTEM_ID]).toEqual({ level: "containers" });
    expect(projection.typeLines[C4_SYSTEM_ID]).toBe("Software System");
  });

  it("rolls schema entities into the visible software system", () => {
    const projection = projectC4({
      graph: derivedGraph(),
      model: derive(),
      view: { level: "context" },
      schemas: SCHEMAS,
    });
    expect(projection.graph.nodes.some((node) => node.id.startsWith("schema:"))).toBe(false);
    expect(projection.nodeRollup[schemaNodeId(USER_SCHEMA.id)]).toBe(C4_SYSTEM_ID);
  });
});

describe("projectC4 · containers", () => {
  it("nests containers and owned infra in the boundary, aggregates the edges", () => {
    const projection = projectC4({ graph: derivedGraph(), model: derive(), view: { level: "containers" } });
    const byId = new Map(projection.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("ctr:apps-server")?.parentId).toBe(C4_SYSTEM_ID);
    expect(byId.get("ext:postgres")?.parentId).toBe(C4_SYSTEM_ID);
    expect(byId.get("ext:stripe")?.parentId).toBeNull();
    expect(byId.has("sys:model")).toBe(false);

    const serverToShared = projection.graph.edges.find(
      (e) => e.id === c4RelId("ctr:apps-server", C4_SHARED_CONTAINER_ID),
    );
    expect(serverToShared?.label).toBe("Uses · imports ×5");
    expect(projection.edgeRollup["link:sys:api->sys:model"]).toBe(serverToShared?.id);

    const toPostgres = projection.graph.edges.find(
      (e) => e.id === c4RelId("ctr:apps-server", "ext:postgres"),
    );
    expect(toPostgres?.label).toContain(relationVerb("database"));
    expect(toPostgres?.kind).toBe("data");

    expect(
      projection.graph.edges.some(
        (e) => e.source === C4_USER_PERSON_ID && e.target === "ctr:apps-web",
      ),
    ).toBe(true);
    expect(projection.typeLines["ctr:apps-server"]).toBe("Container · Server application");
    expect(projection.typeLines["ext:postgres"]).toBe("Container · PostgreSQL");
    expect(projection.typeLines["ext:stripe"]).toBe("External System · payments");
    expect(projection.drill["ctr:apps-web"]).toEqual({ level: "components", scope: "ctr:apps-web" });
    // The open boundary drills back out.
    expect(projection.drill[C4_SYSTEM_ID]).toEqual({ level: "context" });
  });

  it("rolls schema entities into owners and annotates container cards", () => {
    const projection = projectC4({
      graph: derivedGraph(),
      model: derive(),
      view: { level: "containers" },
      schemas: SCHEMAS,
    });
    const byId = new Map(projection.graph.nodes.map((node) => [node.id, node]));

    expect(byId.has(schemaNodeId(USER_SCHEMA.id))).toBe(false);
    expect(projection.nodeRollup[schemaNodeId(USER_SCHEMA.id)]).toBe("ctr:apps-server");
    expect(projection.nodeRollup[schemaNodeId(VIEW_SCHEMA.id)]).toBe("ctr:apps-web");
    expect(byId.get("ctr:apps-server")?.description).toContain("2 entities");
    expect(byId.get("ctr:apps-web")?.description).toContain("1 entity");

    const marks = rollupC4Marks(
      { [schemaNodeId(USER_SCHEMA.id)]: { kind: "changed", detail: "field added" } },
      projection,
    );
    expect(marks["ctr:apps-server"]).toEqual({ kind: "changed", detail: "1 changed" });
  });
});

describe("projectC4 · components", () => {
  it("scopes to one container with verbatim internals and rolled-up neighbours", () => {
    const projection = projectC4({
      graph: derivedGraph(),
      model: derive(),
      view: { level: "components", scope: "ctr:apps-server" },
    });
    const byId = new Map(projection.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("ctr:apps-server")?.kind).toBe("system"); // the boundary box
    expect(byId.get("sys:api")?.parentId).toBe("ctr:apps-server");
    expect(byId.has("sys:screens")).toBe(false);
    // The shared container appears as a neighbour card because sys:api uses it.
    expect(byId.get(C4_SHARED_CONTAINER_ID)?.kind).toBe("container");
    expect(projection.nodeRollup["sys:model"]).toBe(C4_SHARED_CONTAINER_ID);
    expect(
      projection.graph.edges.some((e) => e.id === c4RelId("sys:api", C4_SHARED_CONTAINER_ID)),
    ).toBe(true);
    // External services the members touch show one hop out.
    expect(byId.has("ext:postgres")).toBe(true);
    expect(byId.has("ext:stripe")).toBe(true);
    expect(projection.typeLines["sys:api"]).toBe("Component");
    // Boundary drills up; the neighbour container drills into itself.
    expect(projection.drill["ctr:apps-server"]).toEqual({ level: "containers" });
    expect(projection.drill[C4_SHARED_CONTAINER_ID]).toEqual({
      level: "components",
      scope: C4_SHARED_CONTAINER_ID,
    });
  });

  it("keeps the user attached to web containers", () => {
    const projection = projectC4({
      graph: derivedGraph(),
      model: derive(),
      view: { level: "components", scope: "ctr:apps-web" },
    });
    expect(projection.graph.nodes.some((n) => n.id === C4_USER_PERSON_ID)).toBe(true);
    expect(
      projection.graph.edges.some(
        (e) => e.source === C4_USER_PERSON_ID && e.target === "ctr:apps-web",
      ),
    ).toBe(true);
  });

  it("renders owned schemas as entities and only materializes in-scope references", () => {
    const projection = projectC4({
      graph: derivedGraph(),
      model: derive(),
      view: { level: "components", scope: "ctr:apps-server" },
      schemas: SCHEMAS,
    });
    const byId = new Map(projection.graph.nodes.map((node) => [node.id, node]));
    const userId = schemaNodeId(USER_SCHEMA.id);
    const teamId = schemaNodeId(TEAM_SCHEMA.id);

    expect(byId.get(userId)).toMatchObject({
      kind: "entity",
      parentId: "ctr:apps-server",
      codeFile: USER_SCHEMA.file,
      entityFields: ["id", "email"],
    });
    expect(byId.get(teamId)?.parentId).toBe("ctr:apps-server");
    expect(byId.has(schemaNodeId(VIEW_SCHEMA.id))).toBe(false);
    expect(projection.typeLines[userId]).toBe("Entity · interface");
    expect(
      projection.graph.edges.find(
        (edge) => edge.id === schemaRefEdgeId(TEAM_SCHEMA.id, USER_SCHEMA.id),
      ),
    ).toMatchObject({ source: teamId, target: userId, kind: "data", label: "owner" });
    expect(
      projection.graph.edges.some(
        (edge) => edge.id === schemaRefEdgeId(TEAM_SCHEMA.id, VIEW_SCHEMA.id),
      ),
    ).toBe(false);
  });

  it("leaves the projection unchanged when schemas are absent or empty", () => {
    const base = {
      graph: derivedGraph(),
      model: derive(),
      view: { level: "components", scope: "ctr:apps-server" } as const,
    };
    expect(projectC4({ ...base, schemas: [] })).toEqual(projectC4(base));
  });
});

describe("projectC4 · deployment-only zones", () => {
  it("excludes zones and their descendants identically at every level", () => {
    const baseline = derivedGraph();
    const seed = baseline.nodes[0]!;
    const withZones = {
      ...baseline,
      nodes: [
        ...baseline.nodes,
        { ...seed, id: "vpc:prod", kind: "vpc" as const, label: "Prod VPC", parentId: null },
        { ...seed, id: "inside-vpc", label: "Deployment child", parentId: "vpc:prod" },
      ],
    };
    for (const view of [
      { level: "context" as const },
      { level: "containers" as const },
      { level: "components" as const, scope: "ctr:apps-server" },
    ]) {
      expect(projectC4({ graph: withZones, model: derive(), view })).toEqual(
        projectC4({ graph: baseline, model: derive(), view }),
      );
    }
  });
});

describe("rollupC4Marks", () => {
  it("folds hidden marks into their aggregates with a counting detail", () => {
    const projection = projectC4({ graph: derivedGraph(), model: derive(), view: { level: "containers" } });
    const marks = rollupC4Marks(
      {
        "sys:api": { kind: "changed", detail: "10 → 18 files" },
        "sys:screens": { kind: "added" },
        "link:sys:api->sys:model": { kind: "added" },
        "ext:stripe": { kind: "changed", detail: "+stripe" },
      },
      projection,
    );
    expect(marks["ctr:apps-server"]).toEqual({ kind: "changed", detail: "1 changed" });
    expect(marks["ctr:apps-web"]).toEqual({ kind: "changed", detail: "1 added" });
    expect(marks[c4RelId("ctr:apps-server", C4_SHARED_CONTAINER_ID)]).toEqual({
      kind: "changed",
      detail: "1 added",
    });
    // Visible ids keep their marks verbatim.
    expect(marks["ext:stripe"]).toEqual({ kind: "changed", detail: "+stripe" });
  });
});

describe("c4 helpers", () => {
  it("keys views stably and classifies categories", () => {
    expect(c4ViewKey({ level: "containers" })).toBe("containers");
    expect(c4ViewKey({ level: "components", scope: "ctr:x" })).toBe("components:ctr:x");
    expect(isInfraCategory("queue")).toBe(true);
    expect(isInfraCategory("payments")).toBe(false);
    expect(containerForFile(derive(), USER_SCHEMA.file)).toBe("ctr:apps-server");
  });
});

import { describe, expect, it } from "vitest";
import {
  ArchitectureGraphSchema,
  ArchNodeSchema,
  type ArchitectureGraph,
  type CodeMapSummary,
  type CrossInfraMap,
} from "@crystal/core";
import { computeSharedServices, projectCrossInfraProject } from "./cross-infra.js";

const node = (id: string, kind = "service", codeModule: string | null = id) => ArchNodeSchema.parse({
  id,
  kind,
  label: id,
  position: { x: 0, y: 0 },
  parentId: null,
  size: null,
  codeModule,
  placements: {},
});

function graph(partial: Partial<ArchitectureGraph> = {}): ArchitectureGraph {
  return ArchitectureGraphSchema.parse({
    id: "arch",
    name: "Architecture",
    nodes: [],
    edges: [],
    environments: [],
    journeys: [],
    facets: [],
    viewport: null,
    ...partial,
  });
}

const summary = (externals: CodeMapSummary["externals"]): CodeMapSummary => ({
  generatedAt: "2026-01-01T00:00:00.000Z",
  modules: [],
  deps: [],
  externals,
  fileTotal: 0,
});

describe("projectCrossInfraProject", () => {
  it("preserves projects with zero environments", () => {
    expect(projectCrossInfraProject({ ws: "w", name: "Empty", composed: graph(), summary: null }))
      .toEqual({ ws: "w", name: "Empty", environments: [] });
  });

  it("projects empty targets, placed facts, visible zones, and detected externals", () => {
    const api = { ...node("api", "service", "apps/api"), placements: { prod: { target: "ECS", targetId: "ecs", runtime: "" } } };
    const db = { ...node("db", "datastore", "db"), placements: { prod: { target: "RDS", targetId: "rds", runtime: "" } } };
    const zone = { ...node("vpc", "vpc", null), parentId: null, size: { width: 400, height: 300 } };
    const projected = projectCrossInfraProject({
      ws: "w",
      name: "Shop",
      composed: graph({
        nodes: [api, db, zone],
        edges: [{ id: "api-db", source: "api", target: "db", kind: "data", label: "SQL" }],
        environments: [{
          id: "prod",
          name: "Production",
          kind: "cloud",
          infraNodeIds: ["vpc"],
          targets: [
            { id: "ecs", name: "ECS", kind: "cluster", zone: "vpc" },
            { id: "rds", name: "RDS", kind: "compute" },
            { id: "idle", name: "Idle", kind: "other" },
          ],
        }],
      }),
      summary: summary([{
        id: "postgres",
        name: "PostgreSQL",
        category: "database",
        packages: ["pg"],
        clients: [{ module: "apps/api", weight: 1 }],
        weight: 1,
      }]),
    });
    const env = projected.environments[0]!;
    expect(env.targets.map((target) => [target.id, target.placedNodeIds])).toEqual([
      ["ecs", ["api"]], ["rds", ["db"]], ["idle", []],
    ]);
    expect(env.edges).toEqual([{ id: "api-db", source: "api", target: "db", kind: "data", label: "SQL" }]);
    expect(env.zones).toEqual([{ id: "vpc", label: "vpc", kind: "vpc", parentId: null }]);
    expect(env.externals).toEqual([{
      id: "ext:postgres", label: "PostgreSQL", kind: "datastore", category: "database", clientNodeIds: ["api"],
    }]);
  });

  it("keeps full instance-qualified external ids distinct", () => {
    const api = { ...node("api", "service", "apps/api"), placements: { env: { target: "T", targetId: "t", runtime: "" } } };
    const result = projectCrossInfraProject({
      ws: "w", name: "P",
      composed: graph({ nodes: [api], environments: [{ id: "env", name: "E", kind: "cloud", targets: [{ id: "t", name: "T", kind: "other" }] }] }),
      summary: summary([{
        id: "s3", name: "S3", category: "storage", packages: ["aws"], weight: 2,
        clients: [{ module: "apps/api", weight: 2 }],
        instances: [
          { name: "Uploads", clients: [{ module: "apps/api", weight: 1 }], weight: 1 },
          { name: "Backups", clients: [{ module: "apps/api", weight: 1 }], weight: 1 },
        ],
      }]),
    });
    expect(result.environments[0]!.externals.map((external) => external.id)).toEqual([
      "ext:s3:backups", "ext:s3:uploads",
    ]);
  });

  it("shows every infra zone when the legacy environment omits infraNodeIds", () => {
    const result = projectCrossInfraProject({
      ws: "w",
      name: "Legacy",
      composed: graph({
        nodes: [node("region", "region", null), node("vpc", "vpc", null), node("api")],
        environments: [{ id: "env", name: "E", kind: "cloud", targets: [] }],
      }),
      summary: null,
    });
    expect(result.environments[0]!.zones.map((zone) => zone.id)).toEqual(["region", "vpc"]);
  });

  it("emits named instances and the residual service for unclaimed clients", () => {
    const claimed = { ...node("claimed", "service", "apps/claimed"), placements: { env: { target: "T", targetId: "t", runtime: "" } } };
    const residual = { ...node("residual", "service", "apps/residual"), placements: { env: { target: "T", targetId: "t", runtime: "" } } };
    const result = projectCrossInfraProject({
      ws: "w", name: "P",
      composed: graph({ nodes: [claimed, residual], environments: [{ id: "env", name: "E", kind: "cloud", targets: [{ id: "t", name: "T", kind: "other" }] }] }),
      summary: summary([{
        id: "redis", name: "Redis", category: "cache", packages: ["redis"], weight: 2,
        clients: [{ module: "apps/claimed", weight: 1 }, { module: "apps/residual", weight: 1 }],
        instances: [{ name: "Sessions", clients: [{ module: "apps/claimed", weight: 1 }], weight: 1 }],
      }]),
    });
    expect(result.environments[0]!.externals).toEqual([
      { id: "ext:redis", label: "Redis", kind: "cache", category: "cache", clientNodeIds: ["residual"] },
      { id: "ext:redis:sessions", label: "Sessions", kind: "cache", category: "cache", clientNodeIds: ["claimed"] },
    ]);
  });
});

describe("computeSharedServices", () => {
  const project = (ws: string, externals: CrossInfraMap["projects"][number]["environments"][number]["externals"]): CrossInfraMap["projects"][number] => ({
    ws, name: ws, environments: [{ id: "prod", name: "Prod", kind: "cloud", targets: [], nodes: [], edges: [], zones: [], externals }],
  });
  const ext = (id: string) => ({ id, label: id, kind: "external" as const, clientNodeIds: [`client-${id}`] });

  it("requires evidence from two projects and preserves per-project evidence", () => {
    const shared = computeSharedServices([
      project("a", [ext("ext:redis"), ext("ext:only-a")]),
      project("b", [ext("ext:redis")]),
    ]);
    expect(shared).toEqual([{
      key: "ext:redis", label: "ext:redis", kind: "external",
      projects: [
        { ws: "a", envId: "prod", clientNodeIds: ["client-ext:redis"] },
        { ws: "b", envId: "prod", clientNodeIds: ["client-ext:redis"] },
      ],
    }]);
  });

  it("does not merge different named instances", () => {
    expect(computeSharedServices([
      project("a", [ext("ext:s3:uploads")]),
      project("b", [ext("ext:s3:backups")]),
    ])).toEqual([]);
  });
});

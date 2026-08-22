import { describe, expect, it } from "vitest";
import type { CrossInfraMap, CrossInfraOverlay } from "@crystal/core";
import { buildCrossInfraScene, suggestEnvSelection } from "./cross-scene.js";

const env = (
  id: string,
  name: string,
  kind: "local" | "cloud",
  counts: number[],
): CrossInfraMap["projects"][number]["environments"][number] => ({
  id,
  name,
  kind,
  targets: counts.map((count, index) => ({
    id: `t${index}`,
    name: `Target ${index}`,
    kind: "compute",
    placedNodeIds: Array.from({ length: count }, (_, n) => `n${n}`),
  })),
  nodes: [],
  edges: [],
  zones: [],
  externals: [],
});

const mapOf = (projects: CrossInfraMap["projects"]): CrossInfraMap => ({
  projects,
  shared: [],
  generatedAt: "2026-08-23T00:00:00.000Z",
});

describe("suggestEnvSelection", () => {
  it("uses the widest unique normalized-name match", () => {
    const map = mapOf([
      { ws: "a", name: "A", environments: [env("a-local", " Local ", "local", [1]), env("a-prod", "Prod", "cloud", [9])] },
      { ws: "b", name: "B", environments: [env("b-local", "local", "local", [1]), env("b-stage", "Stage", "cloud", [8])] },
      { ws: "c", name: "C", environments: [env("c-local", "LOCAL", "local", [1])] },
    ]);
    expect(suggestEnvSelection(map)).toEqual({ a: "a-local", b: "b-local", c: "c-local" });
  });

  it("does not treat an ambiguous same-name pair as an exact match", () => {
    const map = mapOf([
      { ws: "a", name: "A", environments: [env("a1", "prod", "cloud", [1]), env("a2", "Prod", "cloud", [8])] },
      { ws: "b", name: "B", environments: [env("b1", "prod", "cloud", [2])] },
    ]);
    expect(suggestEnvSelection(map)).toEqual({ a: "a2", b: "b1" });
  });

  it("returns null for a project without environments", () => {
    expect(suggestEnvSelection(mapOf([{ ws: "empty", name: "Empty", environments: [] }]))).toEqual({ empty: null });
  });
});

describe("buildCrossInfraScene", () => {
  it("orders parents before children, applies pins, and preserves project failures", () => {
    const map = mapOf([
      { ws: "b", name: "Broken", environments: [], error: "compose failed" },
      { ws: "a", name: "Alpha", environments: [env("local", "Local", "local", [3])] },
    ]);
    const overlay: CrossInfraOverlay = {
      id: "default",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      envSelection: {},
      pins: { "project:a": { x: 44, y: 55 } },
    };
    const scene = buildCrossInfraScene(map, overlay);
    expect(scene.nodes.map((node) => node.id)).toEqual([
      "project:a",
      "project:a:target:local:t0",
      "project:b",
    ]);
    expect(scene.nodes[0]!.position).toEqual({ x: 44, y: 55 });
    expect(scene.nodes[1]!.parentId).toBe("project:a");
    expect(scene.warnings).toEqual(["Broken: compose failed"]);
  });

  it("shows selected-environment shared services with cautious framing", () => {
    const a = env("a-local", "Local", "local", []);
    const b = env("b-local", "Local", "local", []);
    a.externals.push({ id: "ext:postgres", label: "Postgres", kind: "datastore", clientNodeIds: [] });
    b.externals.push({ id: "ext:postgres", label: "Postgres", kind: "datastore", clientNodeIds: [] });
    const map = mapOf([
      { ws: "a", name: "A", environments: [a] },
      { ws: "b", name: "B", environments: [b] },
    ]);
    map.shared.push({
      key: "ext:postgres",
      label: "Postgres",
      kind: "datastore",
      projects: [
        { ws: "a", envId: "a-local", clientNodeIds: [] },
        { ws: "b", envId: "b-local", clientNodeIds: [] },
      ],
    });
    const scene = buildCrossInfraScene(map, null);
    const shared = scene.nodes.find((node) => node.data.kind === "shared");
    expect(shared?.data).toMatchObject({ framing: "Same detected service type", consumerCount: 2 });
    expect(scene.edges).toHaveLength(2);
  });

  it("uses instance framing only for ext-prefixed instance-qualified keys", () => {
    const a = env("a", "Production", "cloud", []);
    const b = env("b", "Production", "cloud", []);
    const map = mapOf([
      { ws: "a", name: "A", environments: [a] },
      { ws: "b", name: "B", environments: [b] },
    ]);
    map.shared = ["ext:postgres:cluster-1", "bare:postgres:cluster-1"].map((key) => ({
      key,
      label: key,
      kind: "datastore",
      projects: [{ ws: "a", envId: "a", clientNodeIds: [] }, { ws: "b", envId: "b", clientNodeIds: [] }],
    }));
    const framings = buildCrossInfraScene(map, null).nodes.flatMap((node) =>
      node.data.kind === "shared" ? [node.data.framing] : [],
    );
    expect(framings).toEqual(["Same detected service type", "Detected shared service instance"]);
  });

  it("warns when a suggested selection must break a same-name ambiguity", () => {
    const map = mapOf([
      { ws: "a", name: "Alpha", environments: [env("a2", "production", "cloud", [2]), env("a1", "Production", "cloud", [1])] },
      { ws: "b", name: "Beta", environments: [env("b", "production", "cloud", [1])] },
      { ws: "c", name: "Gamma", environments: [env("c", "production", "cloud", [1])] },
    ]);
    expect(buildCrossInfraScene(map, null).warnings).toContain(
      "Alpha: multiple environments named 'production'; using a2",
    );
  });

  it("is deterministic across project, shared, and environment permutations", () => {
    const projectA = { ws: "a", name: "Alpha", environments: [env("a-stage", "Stage", "cloud", [1]), env("a-prod", "Production", "cloud", [3])] };
    const projectB = { ws: "b", name: "Beta", environments: [env("b-stage", "Stage", "cloud", [1]), env("b-prod", "Production", "cloud", [3])] };
    const shared = ["ext:queue", "ext:db"].map((key) => ({
      key, label: key, kind: "datastore" as const,
      projects: [{ ws: "b", envId: "b-prod", clientNodeIds: [] }, { ws: "a", envId: "a-prod", clientNodeIds: [] }],
    }));
    const variants: CrossInfraMap[] = [];
    for (const reverseProjects of [false, true])
      for (const reverseShared of [false, true])
        for (const reverseEnvs of [false, true]) {
          const projects = [projectA, projectB].map((project) => ({
            ...project,
            environments: reverseEnvs ? [...project.environments].reverse() : [...project.environments],
          }));
          variants.push(mapOf(reverseProjects ? projects.reverse() : projects));
          variants.at(-1)!.shared = reverseShared ? [...shared].reverse() : [...shared];
        }
    const expected = buildCrossInfraScene(variants[0]!, null);
    for (const variant of variants.slice(1)) expect(buildCrossInfraScene(variant, null)).toEqual(expected);
  });

  it("honors an explicit null selection instead of applying a suggestion", () => {
    const map = mapOf([
      { ws: "a", name: "A", environments: [env("a-local", "Local", "local", [2])] },
      { ws: "b", name: "B", environments: [env("b-local", "Local", "local", [2])] },
    ]);
    const overlay: CrossInfraOverlay = {
      id: "default",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      envSelection: { a: null },
      pins: {},
    };
    const project = buildCrossInfraScene(map, overlay).nodes.find((node) => node.id === "project:a");
    expect(project?.data).toMatchObject({ envId: null });
  });
});

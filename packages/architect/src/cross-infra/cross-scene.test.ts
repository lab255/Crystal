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
      identityLinks: [],
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

  it("keeps automatic matches framed as service types even for qualified keys", () => {
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
    expect(framings).toEqual(["Same detected service type", "Same detected service type"]);
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

  it("is deterministic across project, shared, environment, identity-link, and member permutations", () => {
    const projectA = { ws: "a", name: "Alpha", environments: [env("a-stage", "Stage", "cloud", [1]), env("a-prod", "Production", "cloud", [3])] };
    const projectB = { ws: "b", name: "Beta", environments: [env("b-stage", "Stage", "cloud", [1]), env("b-prod", "Production", "cloud", [3])] };
    projectA.environments[1]!.externals.push({ id: "ext:linked", label: "Linked A", kind: "datastore", clientNodeIds: [] });
    projectB.environments[1]!.externals.push({ id: "ext:linked", label: "Linked B", kind: "datastore", clientNodeIds: [] });
    const shared = ["ext:queue", "ext:db"].map((key) => ({
      key, label: key, kind: "datastore" as const,
      projects: [{ ws: "b", envId: "b-prod", clientNodeIds: [] }, { ws: "a", envId: "a-prod", clientNodeIds: [] }],
    }));
    const variants: CrossInfraMap[] = [];
    const links: CrossInfraOverlay["identityLinks"] = [
      { id: "linked", members: [{ ws: "b", key: "ext:linked" }, { ws: "a", key: "ext:linked" }] },
      { id: "stale", members: [{ ws: "missing-b", key: "ext:q" }, { ws: "missing-a", key: "ext:q" }] },
    ];
    const scenes = [];
    for (const reverseProjects of [false, true])
      for (const reverseShared of [false, true])
        for (const reverseEnvs of [false, true])
          for (const reverseLinks of [false, true])
            for (const reverseMembers of [false, true]) {
          const projects = [projectA, projectB].map((project) => ({
            ...project,
            environments: reverseEnvs ? [...project.environments].reverse() : [...project.environments],
          }));
          const variant = mapOf(reverseProjects ? projects.reverse() : projects);
          variant.shared = reverseShared ? [...shared].reverse() : [...shared];
          variants.push(variant);
          const identityLinks = (reverseLinks ? [...links].reverse() : [...links]).map((link) => ({
            ...link,
            members: reverseMembers ? [...link.members].reverse() : [...link.members],
          }));
          scenes.push(buildCrossInfraScene(variant, {
            id: "default", createdAt: "now", updatedAt: "now", envSelection: {}, pins: {}, identityLinks,
          }));
        }
    const expected = scenes[0]!;
    for (const scene of scenes.slice(1)) expect(scene).toEqual(expected);
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
      identityLinks: [],
    };
    const project = buildCrossInfraScene(map, overlay).nodes.find((node) => node.id === "project:a");
    expect(project?.data).toMatchObject({ envId: null });
  });

  it("collapses asserted members, removes them from automatic matching, and applies link pins", () => {
    const a = env("a", "Production", "cloud", []);
    const b = env("b", "Production", "cloud", []);
    a.externals.push({ id: "ext:db", label: "Database", kind: "datastore", clientNodeIds: [] });
    b.externals.push({ id: "ext:db", label: "DB", kind: "datastore", clientNodeIds: [] });
    const map = mapOf([{ ws: "a", name: "A", environments: [a] }, { ws: "b", name: "B", environments: [b] }]);
    map.shared.push({ key: "ext:db", label: "Database", kind: "datastore", projects: [
      { ws: "a", envId: "a", clientNodeIds: [] }, { ws: "b", envId: "b", clientNodeIds: [] },
    ] });
    const overlay: CrossInfraOverlay = {
      id: "default", createdAt: "now", updatedAt: "now", envSelection: {}, pins: { "idlink:one": { x: 7, y: 8 } },
      identityLinks: [{ id: "one", members: [{ ws: "b", key: "ext:db" }, { ws: "a", key: "ext:db" }] }],
    };
    const scene = buildCrossInfraScene(map, overlay);
    expect(scene.nodes.filter((node) => node.data.kind === "shared")).toHaveLength(1);
    expect(scene.nodes.find((node) => node.id === "idlink:one")).toMatchObject({
      position: { x: 7, y: 8 }, data: { label: "Database", framing: "Linked — same instance (user)", consumerCount: 2 },
    });
    expect(scene.edges.map((edge) => edge.data.relationship)).toEqual(["linked-same-instance", "linked-same-instance"]);
  });

  it("keeps stale members and fully stale links visible for unlinking, warns, ignores degenerate links, and sorts by id", () => {
    const a = env("a", "Production", "cloud", []);
    a.externals.push({ id: "ext:db", label: "Database", kind: "datastore", clientNodeIds: [] });
    const overlay: CrossInfraOverlay = {
      id: "default", createdAt: "now", updatedAt: "now", envSelection: {}, pins: {},
      identityLinks: [
        { id: "z", label: "Primary", members: [{ ws: "a", key: "ext:db" }, { ws: "gone", key: "ext:db" }] },
        { id: "a", members: [{ ws: "a", key: "ext:db" }] },
        { id: "stale", members: [{ ws: "gone", key: "ext:db" }, { ws: "missing", key: "ext:q" }] },
      ],
    };
    const scene = buildCrossInfraScene(mapOf([{ ws: "a", name: "A", environments: [a] }]), overlay);
    expect(scene.nodes.filter((node) => node.id.startsWith("idlink:")).map((node) => node.id)).toEqual(["idlink:stale", "idlink:z"]);
    expect(scene.nodes.find((node) => node.id === "idlink:z")?.data).toMatchObject({ warning: "1 linked member is no longer detected" });
    expect(scene.warnings).toContain("Primary: 1 linked member is no longer detected");
    expect(scene.nodes.find((node) => node.id === "idlink:stale")?.data).toMatchObject({
      consumerCount: 0, warning: "2 linked members are no longer detected",
    });
  });

  it("detects identity-link survivors only in each project's selected environment", () => {
    const selected = env("prod", "Production", "cloud", []);
    const unselected = env("stage", "Stage", "cloud", []);
    unselected.externals.push({ id: "ext:db", label: "Staging DB", kind: "datastore", clientNodeIds: [] });
    const overlay: CrossInfraOverlay = {
      id: "default", createdAt: "now", updatedAt: "now", envSelection: { a: "prod" }, pins: {},
      identityLinks: [{ id: "db", members: [{ ws: "a", key: "ext:db" }, { ws: "gone", key: "ext:db" }] }],
    };
    const scene = buildCrossInfraScene(mapOf([{ ws: "a", name: "A", environments: [selected, unselected] }]), overlay);
    expect(scene.nodes.find((node) => node.id === "idlink:db")?.data).toMatchObject({
      consumerCount: 0,
      warning: "2 linked members are no longer detected",
    });
    expect(scene.edges).toEqual([]);
  });

  it("caps project-card external-row height at six plus an overflow row", () => {
    const projectEnv = env("prod", "Production", "cloud", []);
    projectEnv.externals = Array.from({ length: 8 }, (_, index) => ({
      id: `ext:${index}`, label: `Service ${index}`, kind: "external" as const, clientNodeIds: [],
    }));
    const map = mapOf([{ ws: "a", name: "A", environments: [projectEnv] }]);
    const eight = buildCrossInfraScene(map, null).nodes.find((node) => node.id === "project:a")!;
    projectEnv.externals.pop();
    const seven = buildCrossInfraScene(map, null).nodes.find((node) => node.id === "project:a")!;
    expect(eight.style.height).toBe(seven.style.height);
  });
});

import { describe, expect, it } from "vitest";
import {
  createArchitectureGraph,
  createArchNode,
} from "./architecture.js";
import { createProject, createTask } from "./project.js";
import { createRepoRef, createWorkspaceManifest } from "./workspace.js";
import {
  CrystalFileError,
  parseCrystalFile,
  serializeCrystalFile,
} from "./serialization.js";

describe("crystal file envelope", () => {
  it("round-trips an architecture graph", () => {
    const graph = createArchitectureGraph("payments");
    const system = createArchNode("system", "Payments", { x: 0, y: 0 });
    const svc = createArchNode("service", "ledger-api", { x: 40, y: 60 }, system.id);
    graph.nodes.push(system, svc);
    graph.edges.push({ id: "e1", source: svc.id, target: system.id, kind: "async", label: "events" });

    const text = serializeCrystalFile("architecture", graph);
    const parsed = parseCrystalFile("architecture", text);
    expect(parsed).toEqual(graph);
  });

  it("round-trips a project board", () => {
    const project = createProject("Launch");
    project.tasks.push(createTask("Ship the diagrammer", "in_progress"));
    const parsed = parseCrystalFile("project", serializeCrystalFile("project", project));
    expect(parsed).toEqual(project);
  });

  it("round-trips a workspace manifest", () => {
    const ws = createWorkspaceManifest("crystal");
    ws.repos.push(createRepoRef("crystal", "."));
    const parsed = parseCrystalFile("workspace", serializeCrystalFile("workspace", ws));
    expect(parsed).toEqual(ws);
  });

  it("rejects wrong kind", () => {
    const text = serializeCrystalFile("project", createProject("x"));
    expect(() => parseCrystalFile("architecture", text)).toThrow(CrystalFileError);
  });

  it("rejects invalid JSON and newer versions", () => {
    expect(() => parseCrystalFile("project", "not json")).toThrow(CrystalFileError);
    const future = JSON.stringify({ crystal: 99, kind: "project", data: {} });
    expect(() => parseCrystalFile("project", future)).toThrow(/newer/);
  });

  it("applies schema defaults on parse (forward-tolerant reads)", () => {
    const minimal = JSON.stringify({
      crystal: 1,
      kind: "architecture",
      data: { id: "a", name: "min" },
    });
    const graph = parseCrystalFile("architecture", minimal);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it("migrates legacy overlay targets before schema validation", () => {
    const text = JSON.stringify({ crystal: 1, kind: "arch-overlay", data: {
      environments: [{ id: "prod", name: "Prod", kind: "cloud", layout: { ECS: { x: 1, y: 2 } } }],
      overrides: { "sys:a": { placements: { prod: { target: "ecs", runtime: "" } } } },
      manualNodes: [],
    } });
    const overlay = parseCrystalFile("arch-overlay", text);
    expect(overlay.environments[0]!.targets).toEqual([
      { id: "tgt:prod:ecs", name: "ecs", kind: "other", x: 1, y: 2 },
    ]);
    expect(overlay.overrides["sys:a"]!.placements!.prod).toEqual({
      target: "ecs", targetId: "tgt:prod:ecs", runtime: "",
    });
  });
});

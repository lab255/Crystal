import { describe, expect, it } from "vitest";
import { CrystalFileError, parseCrystalFile, serializeCrystalFile } from "./serialization.js";
import {
  ArchSurveySchema,
  EXAMPLE_SURVEY,
  SURVEY_SCHEMA_VERSION,
  SurveyVersionError,
  migrateSurveyData,
  surveyToArchitecture,
} from "./survey.js";

describe("survey schema", () => {
  it("round-trips through the crystal envelope", () => {
    const text = serializeCrystalFile("survey", EXAMPLE_SURVEY);
    const parsed = parseCrystalFile("survey", text);
    expect(parsed).toEqual(EXAMPLE_SURVEY);
  });

  it("the documented example is itself valid (spec cannot drift)", () => {
    expect(ArchSurveySchema.parse(EXAMPLE_SURVEY)).toEqual(EXAMPLE_SURVEY);
    expect(EXAMPLE_SURVEY.schemaVersion).toBe(SURVEY_SCHEMA_VERSION);
  });

  it("tolerates unknown enum values and missing optionals from newer writers", () => {
    const parsed = ArchSurveySchema.parse({
      schemaVersion: 1,
      source: { kind: "quantum-mesh", summary: "" },
      components: [
        { id: "a", name: "A", kind: "hologram", layer: "quantum" },
        { id: "b", name: "B", kind: "datastore", futureField: 42 },
      ],
      relations: [{ source: "a", target: "b", kind: "telepathy" }],
    });
    expect(parsed.source.kind).toBe("codebase");
    expect(parsed.components[0]!.kind).toBe("service");
    expect(parsed.components[0]!.layer).toBeNull();
    expect(parsed.components[0]!.confidence).toBe(1);
    expect(parsed.relations[0]!.kind).toBe("sync");
    expect("futureField" in parsed.components[1]!).toBe(false);
  });

  it("rejects payloads without a schemaVersion", () => {
    expect(() => migrateSurveyData({})).toThrow(SurveyVersionError);
    const text = JSON.stringify({ crystal: 1, kind: "survey", data: { source: {} } });
    expect(() => parseCrystalFile("survey", text)).toThrow(CrystalFileError);
  });

  it("rejects newer schema versions with a clear error", () => {
    expect(() => migrateSurveyData({ schemaVersion: SURVEY_SCHEMA_VERSION + 1 })).toThrow(
      /newer/,
    );
  });

  it("chains migrations from older versions to current", () => {
    const migrations = {
      1: (d: unknown) => ({ ...(d as object), schemaVersion: 2, hopped: true }),
      2: (d: unknown) => ({ ...(d as object), schemaVersion: 3 }),
    };
    const out = migrateSurveyData({ schemaVersion: 1 }, migrations, 3) as {
      schemaVersion: number;
      hopped: boolean;
    };
    expect(out.schemaVersion).toBe(3);
    expect(out.hopped).toBe(true);
    expect(() => migrateSurveyData({ schemaVersion: 1 }, {}, 2)).toThrow(/No migration/);
  });
});

describe("surveyToArchitecture", () => {
  it("converts the example survey into a valid graph", () => {
    const { graph, warnings } = surveyToArchitecture(EXAMPLE_SURVEY, "Imported");
    expect(warnings).toEqual([]);
    expect(graph.name).toBe("Imported");
    expect(graph.nodes).toHaveLength(3);

    const platform = graph.nodes.find((n) => n.label === "Order Platform")!;
    const api = graph.nodes.find((n) => n.label === "storefront-api")!;
    const db = graph.nodes.find((n) => n.label === "orders")!;
    expect(platform.kind).toBe("system");
    expect(api.parentId).toBe(platform.id);
    expect(api.codeModule).toBe("services/storefront");
    expect(db.parentId).toBe(platform.id);

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!).toMatchObject({ source: api.id, target: db.id, kind: "data" });

    expect(graph.environments).toHaveLength(1);
    const env = graph.environments[0]!;
    expect(env).toMatchObject({ name: "Production", kind: "cloud" });
    expect(env.targets).toHaveLength(2);
    expect(api.placements[env.id]).toEqual({
      target: "aws / ecs",
      targetId: env.targets!.find((target) => target.name === "aws / ecs")!.id,
      runtime: "fargate ×2",
    });

    expect(graph.journeys).toHaveLength(1);
    expect(graph.journeys[0]!.entry.symbol).toBe("createOrder");
    expect(graph.description).toContain("ECS Fargate");
  });

  it("skips dangling references and coerces leaf parents, with warnings", () => {
    const survey = ArchSurveySchema.parse({
      schemaVersion: 1,
      source: { kind: "codebase", summary: "" },
      components: [
        { id: "svc", name: "svc", kind: "service" },
        { id: "child", name: "child", kind: "service", parentId: "svc" },
        { id: "orphan", name: "orphan", kind: "service", parentId: "ghost" },
      ],
      relations: [
        { source: "svc", target: "nowhere" },
        { source: "svc", target: "child" },
      ],
      deployments: [
        {
          environment: "Prod",
          placements: [{ componentId: "missing", target: "aws" }],
        },
      ],
    });
    const { graph, warnings } = surveyToArchitecture(survey);
    const svc = graph.nodes.find((n) => n.label === "svc")!;
    expect(svc.kind).toBe("system");
    expect(graph.nodes.find((n) => n.label === "orphan")!.parentId).toBeNull();
    expect(graph.edges).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/unknown parent/);
    expect(warnings.join("\n")).toMatch(/unknown components/);
    expect(warnings.join("\n")).toMatch(/unknown component "missing"/);
  });

  it("defaults to a local environment when the survey has no deployments", () => {
    const survey = ArchSurveySchema.parse({
      schemaVersion: 1,
      source: { kind: "codebase", summary: "" },
      components: [{ id: "a", name: "A", kind: "service" }],
    });
    const { graph } = surveyToArchitecture(survey);
    expect(graph.environments).toHaveLength(1);
    expect(graph.environments[0]!.kind).toBe("local");
  });

  it("orders nodes parents-before-children even when the survey lists children first", () => {
    const survey = ArchSurveySchema.parse({
      schemaVersion: 1,
      source: { kind: "codebase", summary: "" },
      components: [
        { id: "child", name: "child", kind: "service", parentId: "sys" },
        { id: "sys", name: "sys", kind: "system" },
      ],
    });
    const { graph } = surveyToArchitecture(survey);
    const seen = new Set<string>();
    for (const n of graph.nodes) {
      if (n.parentId) expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
  });
});

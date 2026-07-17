import { describe, expect, it } from "vitest";
import {
  ARCH_KIND_OF_CATEGORY,
  EXTERNAL_SERVICE_CATEGORIES,
  aggregateExternalDeps,
  aggregateExternalLibraries,
  classifyExternalPackage,
} from "./external-services.js";

describe("classifyExternalPackage", () => {
  it("classifies well-known service clients", () => {
    expect(classifyExternalPackage("pg")).toMatchObject({ id: "postgres", category: "database" });
    expect(classifyExternalPackage("ioredis")).toMatchObject({ id: "redis", category: "cache" });
    expect(classifyExternalPackage("kafkajs")).toMatchObject({ id: "kafka", category: "queue" });
    expect(classifyExternalPackage("stripe")).toMatchObject({ id: "stripe", category: "payments" });
    expect(classifyExternalPackage("@anthropic-ai/sdk")).toMatchObject({ category: "ai" });
  });

  it("matches scoped-prefix rules", () => {
    expect(classifyExternalPackage("@sentry/node")).toMatchObject({ id: "sentry" });
    expect(classifyExternalPackage("@clerk/nextjs")).toMatchObject({ category: "auth" });
  });

  it("ignores plain libraries", () => {
    expect(classifyExternalPackage("react")).toBeNull();
    expect(classifyExternalPackage("zod")).toBeNull();
    expect(classifyExternalPackage("lodash")).toBeNull();
  });

  it("maps every category onto a diagram node kind", () => {
    for (const category of EXTERNAL_SERVICE_CATEGORIES) {
      expect(ARCH_KIND_OF_CATEGORY[category]).toBeTruthy();
    }
  });
});

describe("aggregateExternalDeps", () => {
  it("groups observations per service with per-module weights", () => {
    const deps = aggregateExternalDeps([
      { module: "apps/api", pkg: "pg" },
      { module: "apps/api", pkg: "pg" },
      { module: "apps/worker", pkg: "pg-promise" },
      { module: "apps/api", pkg: "ioredis" },
      { module: "apps/api", pkg: "left-pad" }, // not a service
    ]);
    expect(deps.map((d) => d.id)).toEqual(["postgres", "redis"]);
    const postgres = deps[0]!;
    expect(postgres.weight).toBe(3);
    expect(postgres.packages).toEqual(["pg", "pg-promise"]);
    expect(postgres.clients).toEqual([
      { module: "apps/api", weight: 2 },
      { module: "apps/worker", weight: 1 },
    ]);
  });

  it("sorts services by total weight, then name", () => {
    const deps = aggregateExternalDeps([
      { module: "a", pkg: "stripe" },
      { module: "a", pkg: "redis" },
      { module: "b", pkg: "redis" },
    ]);
    expect(deps.map((d) => d.id)).toEqual(["redis", "stripe"]);
  });

  it("returns [] when nothing classifies", () => {
    expect(aggregateExternalDeps([{ module: "a", pkg: "react" }])).toEqual([]);
  });
});

describe("aggregateExternalLibraries", () => {
  it("aggregates plain libraries, excluding services, builtins and @types", () => {
    const libs = aggregateExternalLibraries([
      { module: "src/geometry", pkg: "manifold-3d" },
      { module: "src/components", pkg: "three" },
      { module: "src/components", pkg: "three" },
      { module: "src/geometry", pkg: "three" },
      { module: "src/api", pkg: "pg" }, // service — excluded here
      { module: "src/api", pkg: "node:fs" },
      { module: "src/api", pkg: "path" },
      { module: "src/api", pkg: "@types/three" },
    ]);
    expect(libs.map((l) => l.pkg)).toEqual(["three", "manifold-3d"]);
    expect(libs[0]).toEqual({
      pkg: "three",
      weight: 3,
      clients: [
        { module: "src/components", weight: 2 },
        { module: "src/geometry", weight: 1 },
      ],
    });
  });

  it("caps the list by total weight", () => {
    const libs = aggregateExternalLibraries(
      [
        { module: "a", pkg: "one" },
        { module: "a", pkg: "two" },
        { module: "a", pkg: "two" },
        { module: "a", pkg: "three-lib" },
      ],
      2,
    );
    expect(libs.map((l) => l.pkg)).toEqual(["two", "one"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  ARCH_KIND_OF_CATEGORY,
  EXTERNAL_SERVICE_CATEGORIES,
  aggregateExternalDeps,
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

import { describe, expect, it } from "vitest";
import {
  ARCH_KIND_OF_CATEGORY,
  EXTERNAL_SERVICE_CATEGORIES,
  aggregateExternalDeps,
  aggregateExternalLibraries,
  classifyExternalPackage,
  extractServiceInstances,
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

describe("extractServiceInstances", () => {
  it("finds bucket/queue/table names only for imported services", () => {
    const source = `
      import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
      import { Queue } from "bullmq";
      const emails = new Queue("email-jobs");
      await s3.send(new PutObjectCommand({ Bucket: "user-uploads", Key: key }));
      await s3.send(new GetObjectCommand({ Bucket: "user-uploads", Key: key }));
      const params = { TableName: "sessions" }; // dynamo NOT imported — ignored
    `;
    const hits = extractServiceInstances(source, ["@aws-sdk/client-s3", "bullmq"]);
    expect(hits).toEqual([
      { serviceId: "s3", name: "user-uploads" },
      { serviceId: "redis-queue", name: "email-jobs" },
    ]);
  });

  it("returns nothing when no imported service has instance patterns", () => {
    expect(extractServiceInstances(`Bucket: "x"`, ["stripe", "axios"])).toEqual([]);
  });
});

describe("aggregateExternalDeps — instances", () => {
  it("rolls instance names into per-instance client lists", () => {
    const deps = aggregateExternalDeps([
      { module: "packages/server", pkg: "@aws-sdk/client-s3", instances: ["uploads"] },
      { module: "packages/server", pkg: "@aws-sdk/client-s3" },
      { module: "packages/worker", pkg: "@aws-sdk/client-s3", instances: ["uploads", "exports"] },
    ]);
    const s3 = deps.find((d) => d.id === "s3")!;
    expect(s3.weight).toBe(3);
    expect(s3.instances).toEqual([
      {
        name: "uploads",
        clients: [
          { module: "packages/server", weight: 1 },
          { module: "packages/worker", weight: 1 },
        ],
        weight: 2,
      },
      { name: "exports", clients: [{ module: "packages/worker", weight: 1 }], weight: 1 },
    ]);
  });

  it("omits the instances field entirely when no names were observed", () => {
    const deps = aggregateExternalDeps([{ module: "m", pkg: "stripe" }]);
    expect(deps[0]!.instances).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { parseComposeFiles } from "./compose-detect.js";

describe("parseComposeFiles", () => {
  it("normalizes short and long forms and shallow overrides", () => {
    const result = parseComposeFiles([
      { path: "demo/docker-compose.yml", content: `services:\n  api:\n    image: ghcr.io/acme/api:2\n    ports: ["8080:80"]\n    environment: [A=one]\n    depends_on: [db]\n  db:\n    image: postgres:16\n` },
      { path: "demo/docker-compose.override.yml", content: `services:\n  api:\n    build:\n      context: .\n    environment:\n      B: two\n    ports:\n      - target: 80\n        published: 9090\n` },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.topology[0]?.services[0]).toMatchObject({ image: "ghcr.io/acme/api:2", build: ".", environment: { B: "two" }, ports: ["9090:80"], dependsOn: ["db"] });
    expect(result.suggestions.find((s) => s.service === "db")?.external).toMatchObject({ id: "postgres" });
  });

  it("carries instance evidence from container_name and environment", () => {
    const result = parseComposeFiles([{ path: "compose.yml", content: `services:\n  uploads:\n    image: minio/minio:latest\n    container_name: asset-bucket\n    environment:\n      BUCKET_NAME: uploads\n` }]);
    expect(result.suggestions[0]).toMatchObject({
      service: "uploads",
      containerName: "asset-bucket",
      environment: { BUCKET_NAME: "uploads" },
    });
  });

  it("keeps valid files when another file is malformed", () => {
    const result = parseComposeFiles([
      { path: "compose.yml", content: "services:\n  cache:\n    image: redis:7" },
      { path: "bad/compose.yml", content: "services: [" },
    ]);
    expect(result.suggestions).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ path: "bad/compose.yml", severity: "error" });
  });

  it("rejects custom YAML tags", () => {
    const result = parseComposeFiles([{ path: "compose.yml", content: "services: !custom {}" }]);
    expect(result.topology).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("resolves anchors and merge keys", () => {
    const result = parseComposeFiles([{ path: "compose.yml", content: `x-defaults: &defaults\n  image: redis:7\n  environment:\n    MODE: shared\nservices:\n  cache:\n    <<: *defaults\n    ports: ["6379:6379"]\n` }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.topology[0]?.services[0]).toMatchObject({ name: "cache", image: "redis:7", environment: { MODE: "shared" } });
  });

  it("turns !!js/function into a per-file error without evaluating it", () => {
    const result = parseComposeFiles([
      { path: "bad/compose.yml", content: "services: !!js/function 'function () { throw new Error(\\\"evaluated\\\") }'" },
      { path: "compose.yml", content: "services:\n  db:\n    image: postgres:16\n" },
    ]);
    expect(result.suggestions).toHaveLength(1);
    expect(result.diagnostics).toEqual([expect.objectContaining({ path: "bad/compose.yml", severity: "error" })]);
  });

  it("pairs docker-compose overrides with a docker-compose base when both prefixes exist", () => {
    const result = parseComposeFiles([
      { path: "demo/compose.yml", content: "services:\n  api:\n    image: acme/plain:1\n" },
      { path: "demo/docker-compose.yml", content: "services:\n  api:\n    image: acme/docker:1\n" },
      { path: "demo/docker-compose.override.yml", content: "services:\n  api:\n    image: acme/override:1\n" },
    ]);
    expect(result.topology.find((entry) => entry.path.endsWith("docker-compose.yml"))?.services[0]?.image).toBe("acme/override:1");
    expect(result.topology.find((entry) => entry.path.endsWith("/compose.yml"))?.services[0]?.image).toBe("acme/plain:1");
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });
});

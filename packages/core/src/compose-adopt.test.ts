import { describe, expect, it } from "vitest";
import type { ArchitectureGraph, ComposeServiceSuggestion } from "./index.js";
import { applyComposeSuggestions, composeExternalNodeId, isComposeSuggestionAdopted } from "./compose-adopt.js";

const suggestion = (overrides: Partial<ComposeServiceSuggestion> = {}): ComposeServiceSuggestion => ({
  key: "compose.yml:uploads", project: "workspace", path: "compose.yml", service: "worker",
  containerName: "uploads", environment: {}, image: "minio/minio:latest", tech: "minio",
  external: { id: "s3", name: "S3", category: "storage" }, ports: [], volumes: [], networks: [], dependsOn: [], profiles: [],
  ...overrides,
});
const graph = (): ArchitectureGraph => ({
  id: "g", name: "G", description: "", edges: [], journeys: [], facets: [],
  environments: [{ id: "dev", name: "Dev", kind: "local", targets: [] }],
  nodes: [
    { id: "ext:s3:uploads", kind: "datastore", label: "uploads", description: "", position: { x: 0, y: 0 }, tech: [], placements: {} },
    { id: "ext:s3:archive", kind: "datastore", label: "archive", description: "", position: { x: 0, y: 0 }, tech: [], placements: {} },
  ],
});

describe("Compose adoption", () => {
  it("selects one named canonical instance from service, container or env evidence", () => {
    expect(composeExternalNodeId(graph(), suggestion())).toBe("ext:s3:uploads");
    expect(composeExternalNodeId(graph(), suggestion({ containerName: undefined, environment: { BUCKET: "archive" } }))).toBe("ext:s3:archive");
  });

  it("falls back to the service type when instance evidence is absent or ambiguous", () => {
    expect(composeExternalNodeId(graph(), suggestion({ service: "worker", containerName: undefined }))).toBe("ext:s3");
    expect(composeExternalNodeId(graph(), suggestion({ environment: { BUCKET_NAME: "uploads", DATABASE_NAME: "archive" }, containerName: undefined }))).toBe("ext:s3");
  });

  it("does not use password values as named-instance evidence", () => {
    expect(composeExternalNodeId(graph(), suggestion({
      service: "worker",
      containerName: undefined,
      environment: { MINIO_ROOT_PASSWORD: "archive" },
    }))).toBe("ext:s3");
  });

  it("is idempotent and never repoints a user-chosen named-instance placement", () => {
    const first = applyComposeSuggestions(graph(), "dev", [suggestion()]);
    expect(first.nodes.find((node) => node.id === "ext:s3:uploads")?.placements.dev?.targetId).toBeTruthy();
    expect(isComposeSuggestionAdopted(first, "dev", suggestion())).toBe(true);
    expect(applyComposeSuggestions(first, "dev", [suggestion()])).toBe(first);

    const placed = first.nodes.map((node) => node.id === "ext:s3:archive"
      ? { ...node, placements: { dev: { target: "Hand picked", targetId: "custom", runtime: "docker" } } }
      : node);
    const customized = { ...first, nodes: placed } as ArchitectureGraph;
    expect(applyComposeSuggestions(customized, "dev", [suggestion({ containerName: "archive" })])).toBe(customized);

    const legacy = graph();
    legacy.nodes.push({ id: "ext:s3", kind: "datastore", label: "S3", description: "", position: { x: 0, y: 0 }, tech: [], placements: { dev: { target: "Hand picked", targetId: "custom", runtime: "" } } });
    expect(applyComposeSuggestions(legacy, "dev", [suggestion()])).toBe(legacy);
  });
});

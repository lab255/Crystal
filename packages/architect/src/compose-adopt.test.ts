import { describe, expect, it, vi } from "vitest";
import type { ArchitectureGraph, ComposeServiceSuggestion } from "@crystal/core";
import { applyComposeSuggestions, isComposeSuggestionAdopted } from "./compose-adopt.js";

const graph = (): ArchitectureGraph => ({ id: "g", name: "G", description: "", nodes: [], edges: [], environments: [{ id: "dev", name: "Dev", kind: "local", targets: [] }], journeys: [], facets: [] });
const suggestions: ComposeServiceSuggestion[] = [
  { key: "compose.yml:api", project: "workspace", path: "compose.yml", service: "api", image: "acme/api:1", tech: "acme/api", external: null, ports: [], volumes: [], networks: [], dependsOn: [], profiles: [] },
  { key: "compose.yml:db", project: "workspace", path: "compose.yml", service: "db", image: "postgres:16", tech: "postgres", external: { id: "postgres", name: "PostgreSQL", category: "database" }, ports: [], volumes: [], networks: [], dependsOn: [], profiles: [] },
];

describe("applyComposeSuggestions", () => {
  it("adopts a batch in one callback and is idempotent", () => {
    const onChange = vi.fn();
    const first = applyComposeSuggestions(graph(), "dev", suggestions); onChange(first);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(first.environments[0]?.targets).toHaveLength(2);
    expect(first.nodes).toHaveLength(1);
    expect(suggestions.every((s) => isComposeSuggestionAdopted(first, "dev", s))).toBe(true);
    const second = applyComposeSuggestions(first, "dev", suggestions);
    if (second !== first) onChange(second);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(second.environments[0]?.targets).toHaveLength(2);
    expect(second.nodes).toHaveLength(1);
  });

  it("keeps an existing external placement in the active environment", () => {
    const existing = applyComposeSuggestions(graph(), "dev", [suggestions[1]!]);
    const node = existing.nodes[0]!;
    const userTarget = { id: "tgt:dev:user-db", name: "My database", kind: "compute" as const, tech: "postgres" };
    const customized: ArchitectureGraph = {
      ...existing,
      environments: [{ ...existing.environments[0]!, targets: [...existing.environments[0]!.targets!, userTarget] }],
      nodes: [{ ...node, placements: { dev: { target: userTarget.name, targetId: userTarget.id, runtime: "docker" } } }],
    };

    expect(isComposeSuggestionAdopted(customized, "dev", suggestions[1]!)).toBe(true);
    expect(applyComposeSuggestions(customized, "dev", [suggestions[1]!])).toBe(customized);
    expect(customized.nodes[0]!.placements.dev?.targetId).toBe(userTarget.id);
  });
});

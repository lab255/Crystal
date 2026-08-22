import { ARCH_KIND_OF_CATEGORY, type ArchitectureGraph, type ComposeServiceSuggestion } from "@crystal/core";

const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "service";

export function isComposeSuggestionAdopted(graph: ArchitectureGraph, envId: string, suggestion: ComposeServiceSuggestion): boolean {
  if (suggestion.external && graph.nodes.some((node) => node.id === `ext:${suggestion.external!.id}` && !!node.placements[envId])) return true;
  const env = graph.environments.find((candidate) => candidate.id === envId);
  const target = (env?.targets ?? []).find((candidate) => normalize(candidate.name) === normalize(suggestion.service) && normalize(candidate.tech ?? "") === normalize(suggestion.image ?? suggestion.tech));
  if (!target) return false;
  if (!suggestion.external) return true;
  return graph.nodes.some((node) => node.id === `ext:${suggestion.external!.id}` && !!node.placements[envId]);
}

/** One immutable graph transaction for individual or batch Compose adoption. */
export function applyComposeSuggestions(graph: ArchitectureGraph, envId: string, suggestions: readonly ComposeServiceSuggestion[]): ArchitectureGraph {
  const envIndex = graph.environments.findIndex((environment) => environment.id === envId);
  if (envIndex < 0) return graph;
  let nodes = graph.nodes.map((node) => ({ ...node, placements: { ...node.placements } }));
  const environments = graph.environments.map((environment) => ({ ...environment, targets: [...(environment.targets ?? [])] }));
  const environment = environments[envIndex]!;
  const unique = new Map(suggestions.map((suggestion) => [suggestion.key.toLowerCase(), suggestion]));
  let changed = false;
  for (const suggestion of unique.values()) {
    if (suggestion.external && nodes.some((node) => node.id === `ext:${suggestion.external!.id}` && !!node.placements[envId])) continue;
    const targetTech = suggestion.image ?? suggestion.tech;
    let target = environment.targets!.find((candidate) => normalize(candidate.name) === normalize(suggestion.service) && normalize(candidate.tech ?? "") === normalize(targetTech));
    if (!target) {
      const base = `tgt:${envId}:compose:${slug(suggestion.path)}:${slug(suggestion.service)}`;
      let id = base;
      let suffix = 2;
      const used = new Set(environment.targets!.map((candidate) => candidate.id));
      while (used.has(id)) id = `${base}-${suffix++}`;
      target = { id, name: suggestion.service, kind: "compute", tech: targetTech };
      environment.targets!.push(target);
      changed = true;
    }
    if (!suggestion.external) continue;
    const nodeId = `ext:${suggestion.external.id}`;
    let index = nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) {
      nodes.push({ id: nodeId, kind: ARCH_KIND_OF_CATEGORY[suggestion.external.category], label: suggestion.external.name, description: `Compose service ${suggestion.service}`, position: { x: 0, y: 0 }, tech: [suggestion.tech], placements: {} });
      index = nodes.length - 1;
      changed = true;
    }
    const node = nodes[index]!;
    if (!node.placements[envId]) {
      nodes[index] = { ...node, placements: { ...node.placements, [envId]: { target: target.name, targetId: target.id, runtime: "" } } };
      changed = true;
    }
  }
  return changed ? { ...graph, nodes, environments } : graph;
}

import type { ArchitectureGraph } from "./architecture.js";
import type { ComposeServiceSuggestion } from "./compose-detect.js";
import { ARCH_KIND_OF_CATEGORY } from "./external-services.js";

const normalize = (value: string): string => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const slug = (value: string): string => normalize(value) || "service";

/** Resolve the canonical external node using exact Compose instance evidence. */
export function composeExternalNodeId(graph: ArchitectureGraph, suggestion: ComposeServiceSuggestion): string | null {
  if (!suggestion.external) return null;
  const base = `ext:${suggestion.external.id}`;
  const evidence = new Set([
    suggestion.service,
    suggestion.containerName ?? "",
    ...Object.entries(suggestion.environment ?? {})
      .filter(([key]) => /NAME|BUCKET|DB|DATABASE|TABLE|QUEUE|TOPIC/i.test(key))
      .map(([, value]) => value),
  ].map(normalize).filter(Boolean));
  const instances = graph.nodes.filter((node) => node.id.startsWith(`${base}:`));
  const matches = instances.filter((node) => evidence.has(normalize(node.label)) || evidence.has(node.id.slice(base.length + 1)));
  return matches.length === 1 ? matches[0]!.id : base;
}

export function isComposeSuggestionAdopted(graph: ArchitectureGraph, envId: string, suggestion: ComposeServiceSuggestion): boolean {
  const nodeId = composeExternalNodeId(graph, suggestion);
  const baseNodeId = suggestion.external ? `ext:${suggestion.external.id}` : null;
  if (baseNodeId && graph.nodes.some((node) => node.id === baseNodeId && !!node.placements[envId])) return true;
  if (nodeId && graph.nodes.some((node) => node.id === nodeId && !!node.placements[envId])) return true;
  const env = graph.environments.find((candidate) => candidate.id === envId);
  const target = (env?.targets ?? []).find((candidate) => normalize(candidate.name) === normalize(suggestion.service) && normalize(candidate.tech ?? "") === normalize(suggestion.image ?? suggestion.tech));
  return !!target && !suggestion.external;
}

/** One pure, immutable and idempotent graph transaction for Compose adoption. */
export function applyComposeSuggestions(graph: ArchitectureGraph, envId: string, suggestions: readonly ComposeServiceSuggestion[]): ArchitectureGraph {
  const envIndex = graph.environments.findIndex((environment) => environment.id === envId);
  if (envIndex < 0) return graph;
  let nodes = graph.nodes.map((node) => ({ ...node, placements: { ...node.placements } }));
  const environments = graph.environments.map((environment) => ({ ...environment, targets: [...(environment.targets ?? [])] }));
  const environment = environments[envIndex]!;
  const unique = new Map(suggestions.map((suggestion) => [suggestion.key.toLowerCase(), suggestion]));
  let changed = false;
  for (const suggestion of unique.values()) {
    const nodeId = composeExternalNodeId({ ...graph, nodes }, suggestion);
    const baseNodeId = suggestion.external ? `ext:${suggestion.external.id}` : null;
    if (baseNodeId && nodes.some((node) => node.id === baseNodeId && !!node.placements[envId])) continue;
    if (nodeId && nodes.some((node) => node.id === nodeId && !!node.placements[envId])) continue;
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
    if (!suggestion.external || !nodeId) continue;
    let index = nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) {
      nodes.push({ id: nodeId, kind: ARCH_KIND_OF_CATEGORY[suggestion.external.category], label: suggestion.external.name, description: `Compose service ${suggestion.service}`, position: { x: 0, y: 0 }, tech: [suggestion.tech], placements: {} });
      index = nodes.length - 1;
      changed = true;
    }
    const node = nodes[index]!;
    // Existing placement is user-owned: adoption never repoints it.
    if (!node.placements[envId]) {
      nodes[index] = { ...node, placements: { ...node.placements, [envId]: { target: target.name, targetId: target.id, runtime: "" } } };
      changed = true;
    }
  }
  return changed ? { ...graph, nodes, environments } : graph;
}

import {
  ARCH_KIND_OF_CATEGORY,
  isContainerKind,
  isInfraZone,
  type ArchitectureGraph,
  type CodeExternalDep,
  type CodeMapSummary,
  type CrossInfraMap,
  type InfraZoneKind,
} from "@crystal/core";

type CrossInfraProject = CrossInfraMap["projects"][number];

export interface CrossInfraProjectInput {
  ws: string;
  name: string;
  composed: ArchitectureGraph;
  summary: CodeMapSummary | null;
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

/**
 * Project one composed architecture into the plain, environment-scoped DTO
 * consumed by the cross-project canvas. Targets are retained even when empty;
 * zones use the legacy all-visible rule when an environment has no explicit
 * infraNodeIds list.
 */
export function projectCrossInfraProject(input: CrossInfraProjectInput): CrossInfraProject {
  const { ws, name, composed, summary } = input;
  const nodeById = new Map(composed.nodes.map((node) => [node.id, node]));

  return {
    ws,
    name,
    environments: composed.environments.map((environment) => {
      const placementByNode = new Map(
        composed.nodes.flatMap((node) => {
          const placement = node.placements[environment.id];
          return placement?.targetId ? [[node.id, placement] as const] : [];
        }),
      );
      const placedIds = new Set(placementByNode.keys());
      const nodes = composed.nodes
        .filter((node) => {
          if (!placedIds.has(node.id)) return false;
          return !isContainerKind(node.kind) && node.kind !== "note";
        })
        .map((node) => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          targetId: placementByNode.get(node.id)!.targetId!,
        }))
        .sort(byId);
      const visibleNodeIds = new Set(nodes.map((node) => node.id));

      return {
        id: environment.id,
        name: environment.name,
        kind: environment.kind,
        targets: (environment.targets ?? []).map((target) => ({
          id: target.id,
          name: target.name,
          kind: target.kind,
          ...(target.tech === undefined ? {} : { tech: target.tech }),
          ...(target.region === undefined ? {} : { region: target.region }),
          ...(target.zone === undefined ? {} : { zoneId: target.zone }),
          placedNodeIds: nodes
            .filter((node) => node.targetId === target.id)
            .map((node) => node.id),
        })),
        nodes,
        edges: composed.edges
          .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
          .map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            kind: edge.kind,
            label: edge.label,
          }))
          .sort(byId),
        zones: (environment.infraNodeIds ?? composed.nodes
          .filter((node) => isInfraZone(node.kind))
          .map((node) => node.id))
          .map((id) => nodeById.get(id))
          .filter((node): node is NonNullable<typeof node> => !!node && isInfraZone(node.kind))
          .map((node) => ({
            id: node.id,
            label: node.label,
            kind: node.kind as InfraZoneKind,
            ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
          }))
          .sort(byId),
        externals: detectedExternals(composed, environment.id, summary).sort(byId),
      };
    }),
  };
}

function detectedExternals(
  graph: ArchitectureGraph,
  envId: string,
  summary: CodeMapSummary | null,
): CrossInfraMap["projects"][number]["environments"][number]["externals"] {
  if (!summary) return [];
  const placedByModule = new Map<string, string>();
  for (const node of graph.nodes) {
    if (!node.codeModule || !node.placements[envId]?.targetId) continue;
    if (isContainerKind(node.kind) || node.kind === "note") continue;
    placedByModule.set(node.codeModule, node.id);
  }

  const out: ReturnType<typeof detectedExternals> = [];
  const push = (dep: CodeExternalDep, id: string, label: string, clients: readonly { module: string }[]) => {
    const clientNodeIds = [...new Set(clients.map((client) => placedByModule.get(client.module)).filter((id): id is string => !!id))].sort();
    if (clientNodeIds.length === 0) return;
    out.push({
      id,
      label,
      kind: ARCH_KIND_OF_CATEGORY[dep.category] ?? "external",
      category: dep.category,
      clientNodeIds,
    });
  };

  for (const dep of summary.externals ?? []) {
    const claimed = new Set<string>();
    for (const instance of dep.instances ?? []) {
      const slug = instance.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      push(dep, `ext:${dep.id}:${slug}`, instance.name, instance.clients);
      for (const client of instance.clients) claimed.add(client.module);
    }
    const residual = (dep.instances?.length ?? 0) === 0
      ? dep.clients
      : dep.clients.filter((client) => !claimed.has(client.module));
    if ((dep.instances?.length ?? 0) === 0 || residual.length > 0) {
      push(dep, `ext:${dep.id}`, dep.name, residual);
    }
  }
  return out;
}

/** Canonical service ids shared by at least two distinct projects. */
export function computeSharedServices(
  projects: CrossInfraMap["projects"],
): CrossInfraMap["shared"] {
  const candidates = new Map<string, CrossInfraMap["shared"][number]>();
  for (const project of projects) {
    if (project.error) continue;
    for (const environment of project.environments) {
      for (const external of environment.externals) {
        let shared = candidates.get(external.id);
        if (!shared) {
          shared = {
            key: external.id,
            label: external.label,
            kind: external.kind,
            ...(external.category === undefined ? {} : { category: external.category }),
            projects: [],
          };
          candidates.set(external.id, shared);
        }
        shared.projects.push({
          ws: project.ws,
          envId: environment.id,
          clientNodeIds: [...external.clientNodeIds],
        });
      }
    }
  }
  return [...candidates.values()]
    .filter((service) => new Set(service.projects.map((project) => project.ws)).size >= 2)
    .sort((a, b) => a.key.localeCompare(b.key));
}

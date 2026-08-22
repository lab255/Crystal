import {
  ArchDeployTargetSchema,
  TARGET_KINDS,
  TargetKindSchema,
  type ArchDeployTarget,
  type ArchNodeKind,
  type ArchPlacement,
  type ArchitectureGraph,
  type TargetKind,
} from "./architecture.js";
import { uid } from "./ids.js";

export { ArchDeployTargetSchema, TARGET_KINDS, TargetKindSchema };
export type { ArchDeployTarget, TargetKind };

export const INFRA_ZONE_KINDS = [
  "region",
  "zone",
  "vpc",
  "subnet",
  "securitygroup",
  "cluster",
  "namespace",
] as const satisfies readonly ArchNodeKind[];
export type InfraZoneKind = (typeof INFRA_ZONE_KINDS)[number];

export function isInfraZone(kind: ArchNodeKind): kind is InfraZoneKind {
  return (INFRA_ZONE_KINDS as readonly ArchNodeKind[]).includes(kind);
}

const ZONE_CHILDREN: Readonly<Record<InfraZoneKind, readonly InfraZoneKind[]>> = {
  region: ["zone", "vpc", "cluster"],
  zone: ["subnet", "cluster"],
  vpc: ["subnet", "securitygroup", "cluster"],
  subnet: ["securitygroup"],
  securitygroup: [],
  cluster: ["namespace"],
  namespace: [],
};

export function canNestZone(child: InfraZoneKind, parent: InfraZoneKind): boolean {
  return ZONE_CHILDREN[parent].includes(child);
}

const ZONE_LABELS: Record<InfraZoneKind, string> = {
  region: "region",
  zone: "availability zone",
  vpc: "VPC",
  subnet: "subnet",
  securitygroup: "security group",
  cluster: "cluster",
  namespace: "namespace",
};

export function zoneNestingRejection(
  child: InfraZoneKind,
  parent: InfraZoneKind,
): string | null {
  return canNestZone(child, parent)
    ? null
    : `A ${ZONE_LABELS[child]} cannot be nested inside a ${ZONE_LABELS[parent]}.`;
}

const targetLookupKey = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, " ");
const targetSlug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "target";

type PlacementOwner = { placements: Record<string, ArchPlacement> };

function normalizeOwners(
  environments: ArchitectureGraph["environments"],
  owners: readonly PlacementOwner[],
): ArchitectureGraph["environments"] {
  const referencedEnvIds = new Set<string>();
  for (const owner of owners) for (const envId of Object.keys(owner.placements)) referencedEnvIds.add(envId);

  return environments.map((environment) => {
    if (!referencedEnvIds.has(environment.id) && environment.layout === undefined) return environment;
    const targets = (environment.targets ?? []).map((target) => ({ ...target }));
    const byId = new Map(targets.map((target) => [target.id, target]));
    const byName = new Map<string, ArchDeployTarget>();
    const usedIds = new Set(targets.map((target) => target.id));
    for (const target of targets) if (!byName.has(targetLookupKey(target.name))) byName.set(targetLookupKey(target.name), target);

    const materializeName = (rawName: string): ArchDeployTarget => {
      const name = rawName.trim() || "Unknown target";
      const lookup = targetLookupKey(name);
      const found = byName.get(lookup);
      if (found) return found;
      const base = `tgt:${environment.id}:${targetSlug(name)}`;
      let id = base;
      let suffix = 2;
      while (usedIds.has(id)) id = `${base}-${suffix++}`;
      const target: ArchDeployTarget = { id, name, kind: "other" };
      targets.push(target);
      byId.set(id, target);
      byName.set(lookup, target);
      usedIds.add(id);
      return target;
    };

    for (const owner of owners) {
      const placement = owner.placements[environment.id];
      if (!placement) continue;
      let target = placement.targetId ? byId.get(placement.targetId) : undefined;
      if (!target && placement.targetId) {
        target = {
          id: placement.targetId,
          name: placement.target?.trim() || "Unknown target",
          kind: "other",
        };
        targets.push(target);
        byId.set(target.id, target);
        usedIds.add(target.id);
        if (!byName.has(targetLookupKey(target.name))) byName.set(targetLookupKey(target.name), target);
      }
      target ??= materializeName(placement.target);
      owner.placements[environment.id] = { ...placement, targetId: target.id, target: target.name };
    }

    for (const [legacyName, pin] of Object.entries(environment.layout ?? {})) {
      const target = byName.get(targetLookupKey(legacyName)) ?? materializeName(legacyName);
      Object.assign(target, pin);
    }
    const { layout: _layout, ...rest } = environment;
    return { ...rest, targets };
  });
}

function needsDeployNormalization(graph: ArchitectureGraph): boolean {
  const environments = new Map(graph.environments.map((environment) => [environment.id, environment]));
  if (graph.environments.some((environment) => environment.layout !== undefined)) return true;
  for (const node of graph.nodes) {
    for (const [envId, placement] of Object.entries(node.placements)) {
      if (!placement.targetId) return true;
      const environment = environments.get(envId);
      if (!environment) continue;
      const target = (environment.targets ?? []).find((candidate) => candidate.id === placement.targetId);
      if (!target || placement.target !== target.name) return true;
    }
  }
  return false;
}

/**
 * Canonicalize every graph placement against environment-owned target records.
 * Placement keys for ids absent from `graph.environments` are left untouched.
 */
export function normalizeDeployTargets(graph: ArchitectureGraph): ArchitectureGraph {
  if (!needsDeployNormalization(graph)) return graph;
  const nodes = graph.nodes.map((node) => ({
    ...node,
    placements: Object.fromEntries(
      Object.entries(node.placements).map(([envId, placement]) => [envId, { ...placement }]),
    ),
  }));
  const environments = normalizeOwners(graph.environments, nodes);
  return { ...graph, nodes, environments };
}

const plainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/** Raw overlay migration performed before Zod validates the evolving envelope. */
export function normalizeOverlayDeployTargets(raw: unknown): unknown {
  if (!plainObject(raw) || !Array.isArray(raw.environments) || !plainObject(raw.overrides) || !Array.isArray(raw.manualNodes)) return raw;
  if (!raw.environments.every(plainObject) || !raw.manualNodes.every(plainObject)) return raw;

  for (const environment of raw.environments) {
    if (typeof environment.id !== "string") return raw;
    if (environment.targets !== undefined && (!Array.isArray(environment.targets) || !environment.targets.every((target) =>
      plainObject(target) && typeof target.id === "string" && typeof target.name === "string"
    ))) return raw;
    if (environment.layout !== undefined) {
      if (!plainObject(environment.layout) || !Object.values(environment.layout).every((pin) =>
        plainObject(pin) && typeof pin.x === "number" && typeof pin.y === "number"
      )) return raw;
    }
  }
  const validatePlacements = (placements: unknown): placements is Record<string, unknown> =>
    plainObject(placements) && Object.values(placements).every((placement) =>
      plainObject(placement)
      && (placement.target === undefined || typeof placement.target === "string")
      && (placement.targetId === undefined || typeof placement.targetId === "string")
      && (placement.target !== undefined || placement.targetId !== undefined)
    );
  for (const override of Object.values(raw.overrides)) {
    if (!plainObject(override)) return raw;
    if (override.placements !== undefined && !validatePlacements(override.placements)) return raw;
  }
  for (const node of raw.manualNodes) {
    if (node.placements !== undefined && !validatePlacements(node.placements)) return raw;
  }

  const copy = structuredClone(raw) as Record<string, unknown>;
  const environments = copy.environments as Record<string, unknown>[];
  const manualNodes = copy.manualNodes as Record<string, unknown>[];
  const zoneIds = manualNodes
    .filter((node) => typeof node.id === "string" && typeof node.kind === "string" && (INFRA_ZONE_KINDS as readonly string[]).includes(node.kind))
    .map((node) => node.id as string);
  for (const environment of environments) {
    if (!Array.isArray(environment.targets)) environment.targets = [];
    if (!("infraNodeIds" in environment)) environment.infraNodeIds = [...zoneIds];
  }

  const owners: PlacementOwner[] = [];
  const overrides = copy.overrides as Record<string, unknown>;
  for (const override of Object.values(overrides)) {
    if (!plainObject(override) || override.placements === undefined) continue;
    if (!plainObject(override.placements)) return raw;
    owners.push(override as unknown as PlacementOwner);
  }
  for (const node of manualNodes) {
    if (node.placements === undefined) node.placements = {};
    if (!plainObject(node.placements)) return raw;
    owners.push(node as unknown as PlacementOwner);
  }
  copy.environments = normalizeOwners(
    environments as unknown as ArchitectureGraph["environments"],
    owners,
  );
  return copy;
}

export function placementTargetId(placement: unknown): string | undefined {
  return plainObject(placement) && typeof placement.targetId === "string"
    ? placement.targetId
    : undefined;
}

export function upsertDeployTarget(
  graph: ArchitectureGraph,
  envId: string,
  target: ArchDeployTarget,
): ArchitectureGraph {
  const parsed = ArchDeployTargetSchema.parse(target);
  return {
    ...graph,
    environments: graph.environments.map((env) =>
      env.id !== envId
        ? env
        : { ...env, targets: (env.targets ?? []).some((item) => item.id === parsed.id)
          ? (env.targets ?? []).map((item) => item.id === parsed.id ? parsed : item)
          : [...(env.targets ?? []), parsed] },
    ),
    nodes: graph.nodes.map((node) => {
      const placement = node.placements[envId];
      return placement?.targetId === parsed.id
        ? { ...node, placements: { ...node.placements, [envId]: { ...placement, target: parsed.name } } }
        : node;
    }),
  };
}

export function deleteDeployTarget(graph: ArchitectureGraph, envId: string, targetId: string): ArchitectureGraph {
  return {
    ...graph,
    environments: graph.environments.map((env) => env.id === envId
      ? { ...env, targets: (env.targets ?? []).filter((target) => target.id !== targetId) }
      : env),
    nodes: graph.nodes.map((node) => {
      if (node.placements[envId]?.targetId !== targetId) return node;
      const { [envId]: _placement, ...placements } = node.placements;
      return { ...node, placements };
    }),
  };
}

export function renameDeployTarget(graph: ArchitectureGraph, envId: string, targetId: string, name: string): ArchitectureGraph {
  return {
    ...graph,
    environments: graph.environments.map((env) => env.id === envId
      ? { ...env, targets: (env.targets ?? []).map((target) => target.id === targetId ? { ...target, name } : target) }
      : env),
    nodes: graph.nodes.map((node) => {
      const placement = node.placements[envId];
      return placement?.targetId === targetId
        ? { ...node, placements: { ...node.placements, [envId]: { ...placement, target: name } } }
        : node;
    }),
  };
}

export function moveDeployTarget(
  graph: ArchitectureGraph,
  envId: string,
  targetId: string,
  pin: { x: number; y: number; zone?: string } | null,
): ArchitectureGraph {
  return {
    ...graph,
    environments: graph.environments.map((env) => env.id !== envId ? env : {
      ...env,
      targets: (env.targets ?? []).map((target) => {
        if (target.id !== targetId) return target;
        const { x: _x, y: _y, zone: _zone, ...rest } = target;
        return pin ? { ...rest, ...pin } : rest;
      }),
    }),
  };
}

export function duplicateEnvironment(graph: ArchitectureGraph, envId: string, name?: string): ArchitectureGraph {
  graph = normalizeDeployTargets(graph);
  const source = graph.environments.find((env) => env.id === envId);
  if (!source) return graph;
  const newEnvId = uid("env");
  const idMap = new Map<string, string>();
  const targets = (source.targets ?? []).map((target) => {
    const id = uid("tgt");
    idMap.set(target.id, id);
    return { ...target, id };
  });
  const environment = { ...source, id: newEnvId, name: name ?? `${source.name} copy`, targets,
    ...(source.infraNodeIds ? { infraNodeIds: [...source.infraNodeIds] } : {}) };
  return {
    ...graph,
    environments: [...graph.environments, environment],
    nodes: graph.nodes.map((node) => {
      const placement = node.placements[envId];
      if (!placement) return node;
      const targetId = placement.targetId ? idMap.get(placement.targetId) : undefined;
      return { ...node, placements: { ...node.placements, [newEnvId]: { ...placement, ...(targetId ? { targetId } : {}) } } };
    }),
  };
}

/**
 * Remove an environment and its placement keys. The removed environment's own
 * infra zones and notes are pruned when every survivor has explicit, knowable
 * membership and none of them still references the node.
 */
export function removeEnvironment(graph: ArchitectureGraph, envId: string): ArchitectureGraph {
  const removedEnvironment = graph.environments.find((env) => env.id === envId);
  if (!removedEnvironment) return graph;
  const environments = graph.environments.filter((env) => env.id !== envId);
  const canPruneInfra = environments.every((env) => env.infraNodeIds !== undefined);
  const retainedInfraIds = new Set(environments.flatMap((env) => env.infraNodeIds ?? []));
  const removedInfraIds = new Set(removedEnvironment.infraNodeIds ?? []);
  const removedNodeIds = new Set(canPruneInfra
    ? graph.nodes.filter((node) => removedInfraIds.has(node.id)
      && (isInfraZone(node.kind) || node.kind === "note")
      && !retainedInfraIds.has(node.id)).map((node) => node.id)
    : []);
  return {
    ...graph,
    environments,
    nodes: graph.nodes.filter((node) => !removedNodeIds.has(node.id)).map((node) => {
      const { [envId]: _placement, ...placements } = node.placements;
      return { ...node, placements, ...(node.parentId && removedNodeIds.has(node.parentId) ? { parentId: null } : {}) };
    }),
    edges: graph.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
  };
}

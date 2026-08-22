import type { CrossInfraMap, CrossInfraOverlay, TargetKind, ArchNodeKind } from "@crystal/core";

export const PROJECT_NODE_PREFIX = "project:";
export const SHARED_NODE_PREFIX = "shared:";
const PROJECT_WIDTH = 300;
const PROJECT_HEADER_HEIGHT = 78;
const TARGET_WIDTH = 126;
const TARGET_HEIGHT = 74;
const TARGET_GAP = 12;
const PROJECT_GAP_X = 54;
const PROJECT_GAP_Y = 70;
const PROJECT_COLUMNS = 4;
const EMPTY_PROJECT_HEIGHT = 126;
const SHARED_WIDTH = 190;
const SHARED_HEIGHT = 74;
const SHARED_GAP = 24;
const SHARED_BAND_GAP = 92;

export type CrossSceneNodeData =
  | {
      kind: "project";
      ws: string;
      label: string;
      error?: string;
      envId: string | null;
      envName?: string;
      hasEnvironments: boolean;
      unsharedExternalCount: number;
    }
  | {
      kind: "target";
      ws: string;
      envId: string;
      label: string;
      targetKind: TargetKind;
      detail: string;
      placedCount: number;
    }
  | {
      kind: "shared";
      label: string;
      serviceKind: ArchNodeKind;
      category?: string;
      framing: string;
      consumerCount: number;
    };

export interface SceneNode {
  id: string;
  type: "crossInfra";
  position: { x: number; y: number };
  parentId?: string;
  extent?: "parent";
  draggable: boolean;
  selectable: boolean;
  style: { width: number; height: number };
  data: CrossSceneNodeData;
}

export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  type: "smoothstep";
  data: { relationship: "detected-service-type" };
}

export interface CrossInfraScene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  warnings: string[];
}

const normalizeEnvName = (name: string) => name.trim().toLocaleLowerCase();
const placedCount = (env: CrossInfraMap["projects"][number]["environments"][number]) =>
  env.targets.reduce((sum, target) => sum + target.placedNodeIds.length, 0);

/** Suggests only initial choices; persisted user selections always win. */
export function suggestEnvSelection(map: CrossInfraMap): Record<string, string | null> {
  const projects = [...map.projects].sort((a, b) => a.ws.localeCompare(b.ws));
  const candidates = new Map<string, number>();
  for (const project of projects) {
    const counts = new Map<string, number>();
    for (const env of project.environments) {
      const name = normalizeEnvName(env.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, count] of counts) {
      if (count === 1) candidates.set(name, (candidates.get(name) ?? 0) + 1);
    }
  }
  const matchedName = [...candidates]
    .filter(([, count]) => count >= 2)
    .sort(([aName, aCount], [bName, bCount]) => bCount - aCount || aName.localeCompare(bName))[0]?.[0];

  const kindCounts = new Map<"local" | "cloud", number>();
  for (const project of projects) {
    for (const env of project.environments)
      kindCounts.set(env.kind, (kindCounts.get(env.kind) ?? 0) + 1);
  }
  const preferredKind = (["local", "cloud"] as Array<"local" | "cloud">).sort(
    (a, b) => (kindCounts.get(b) ?? 0) - (kindCounts.get(a) ?? 0),
  )[0];

  return Object.fromEntries(
    projects.map((project) => {
      const exact = matchedName
        ? project.environments.filter((env) => normalizeEnvName(env.name) === matchedName)
        : [];
      if (exact.length === 1) return [project.ws, exact[0]!.id];
      const fallback = [...project.environments].sort(
        (a, b) =>
          Number(b.kind === preferredKind) - Number(a.kind === preferredKind) ||
          placedCount(b) - placedCount(a) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )[0];
      return [project.ws, fallback?.id ?? null];
    }),
  );
}

function targetNodeId(ws: string, envId: string, targetId: string): string {
  return `${PROJECT_NODE_PREFIX}${ws}:target:${envId}:${targetId}`;
}

function hasQualifiedInstance(key: string): boolean {
  return key.startsWith("ext:") && key.split(":").length >= 3;
}

export function buildCrossInfraScene(
  map: CrossInfraMap,
  overlay: CrossInfraOverlay | null,
): CrossInfraScene {
  const suggestions = suggestEnvSelection(map);
  const projects = [...map.projects].sort(
    (a, b) => a.ws.localeCompare(b.ws) || a.name.localeCompare(b.name),
  );
  const selected = new Map(
    projects.map((project) => {
      const hasPersistedSelection = Boolean(
        overlay && Object.prototype.hasOwnProperty.call(overlay.envSelection, project.ws),
      );
      const requested = hasPersistedSelection
        ? overlay!.envSelection[project.ws]
        : suggestions[project.ws] ?? null;
      const env = project.error
        ? null
        : project.environments.find((candidate) => candidate.id === requested) ?? null;
      return [project.ws, env] as const;
    }),
  );
  const activeShared = [...map.shared]
    .map((shared) => ({
      shared,
      consumers: shared.projects.filter((consumer) => selected.get(consumer.ws)?.id === consumer.envId),
    }))
    .filter(({ consumers }) => consumers.length >= 2)
    .sort((a, b) => a.shared.label.localeCompare(b.shared.label) || a.shared.key.localeCompare(b.shared.key));
  const sharedKeys = new Set(activeShared.map(({ shared }) => shared.key));
  const warnings: string[] = [];
  const nodes: SceneNode[] = [];
  const projectHeights: number[] = [];

  projects.forEach((project, index) => {
    const env = selected.get(project.ws) ?? null;
    const duplicateNames = env
      ? project.environments.filter(
          (candidate) => normalizeEnvName(candidate.name) === normalizeEnvName(env.name),
        )
      : [];
    if (
      duplicateNames.length > 1 &&
      !(overlay && Object.prototype.hasOwnProperty.call(overlay.envSelection, project.ws))
    ) {
      warnings.push(
        `${project.name}: multiple environments named '${normalizeEnvName(env!.name)}'; using ${env!.id}`,
      );
    }
    const targetRows = Math.ceil((env?.targets.length ?? 0) / 2);
    const height = Math.max(
      EMPTY_PROJECT_HEIGHT,
      PROJECT_HEADER_HEIGHT + targetRows * (TARGET_HEIGHT + TARGET_GAP) + TARGET_GAP,
    );
    projectHeights.push(height);
    const row = Math.floor(index / PROJECT_COLUMNS);
    const col = index % PROJECT_COLUMNS;
    const earlierRowHeights = Array.from({ length: row }, (_, rowIndex) =>
      Math.max(...projectHeights.slice(rowIndex * PROJECT_COLUMNS, (rowIndex + 1) * PROJECT_COLUMNS)),
    );
    const y = earlierRowHeights.reduce((sum, value) => sum + value + PROJECT_GAP_Y, 0);
    const projectId = `${PROJECT_NODE_PREFIX}${project.ws}`;
    const externalCount = env?.externals.filter((external) => !sharedKeys.has(external.id)).length ?? 0;
    if (project.error) warnings.push(`${project.name}: ${project.error}`);
    nodes.push({
      id: projectId,
      type: "crossInfra",
      position: { x: col * (PROJECT_WIDTH + PROJECT_GAP_X), y },
      draggable: true,
      selectable: true,
      style: { width: PROJECT_WIDTH, height },
      data: {
        kind: "project",
        ws: project.ws,
        label: project.name,
        error: project.error,
        envId: env?.id ?? null,
        envName: env?.name,
        hasEnvironments: project.environments.length > 0,
        unsharedExternalCount: externalCount,
      },
    });
    for (const [targetIndex, target] of [...(env?.targets ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .entries()) {
      nodes.push({
        id: targetNodeId(project.ws, env!.id, target.id),
        type: "crossInfra",
        parentId: projectId,
        extent: "parent",
        position: {
          x: TARGET_GAP + (targetIndex % 2) * (TARGET_WIDTH + TARGET_GAP),
          y: PROJECT_HEADER_HEIGHT + Math.floor(targetIndex / 2) * (TARGET_HEIGHT + TARGET_GAP),
        },
        draggable: true,
        selectable: false,
        style: { width: TARGET_WIDTH, height: TARGET_HEIGHT },
        data: {
          kind: "target",
          ws: project.ws,
          envId: env!.id,
          label: target.name,
          targetKind: target.kind,
          detail: [target.tech, target.region].filter(Boolean).join(" · "),
          placedCount: target.placedNodeIds.length,
        },
      });
    }
  });

  const gridRows = Math.ceil(projects.length / PROJECT_COLUMNS);
  const projectBottom = Array.from({ length: gridRows }, (_, row) =>
    Math.max(...projectHeights.slice(row * PROJECT_COLUMNS, (row + 1) * PROJECT_COLUMNS), 0),
  ).reduce((sum, height) => sum + height + PROJECT_GAP_Y, -PROJECT_GAP_Y);
  const bandWidth = activeShared.length * SHARED_WIDTH + Math.max(0, activeShared.length - 1) * SHARED_GAP;
  const canvasWidth = Math.min(PROJECT_COLUMNS, Math.max(1, projects.length)) * PROJECT_WIDTH +
    Math.max(0, Math.min(PROJECT_COLUMNS, projects.length) - 1) * PROJECT_GAP_X;
  const bandStartX = Math.max(0, (canvasWidth - bandWidth) / 2);

  for (const [index, { shared, consumers }] of activeShared.entries()) {
    const id = `${SHARED_NODE_PREFIX}${shared.key}`;
    nodes.push({
      id,
      type: "crossInfra",
      position: { x: bandStartX + index * (SHARED_WIDTH + SHARED_GAP), y: projectBottom + SHARED_BAND_GAP },
      draggable: true,
      selectable: false,
      style: { width: SHARED_WIDTH, height: SHARED_HEIGHT },
      data: {
        kind: "shared",
        label: shared.label,
        serviceKind: shared.kind,
        category: shared.category,
        framing: hasQualifiedInstance(shared.key)
          ? "Detected shared service instance"
          : "Same detected service type",
        consumerCount: consumers.length,
      },
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: SceneEdge[] = activeShared.flatMap(({ shared, consumers }) =>
    consumers
      .map((consumer) => ({
        id: `edge:${shared.key}:${consumer.ws}`,
        source: `${SHARED_NODE_PREFIX}${shared.key}`,
        target: `${PROJECT_NODE_PREFIX}${consumer.ws}`,
        type: "smoothstep" as const,
        data: { relationship: "detected-service-type" as const },
      }))
      .filter((edge) => nodeIds.has(edge.target))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  if (overlay) {
    for (const node of nodes) {
      const pin = overlay.pins[node.id];
      if (pin) node.position = { ...pin };
    }
  }
  return { nodes, edges, warnings };
}

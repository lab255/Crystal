import { isInfraZone, type ArchNode, type ArchitectureGraph, type C4View } from "@crystal/core";

/** The semantic portion of a C4 projection needed by the text exporter. */
export interface MermaidC4Projection {
  graph: ArchitectureGraph;
  typeLines: Readonly<Record<string, string>>;
  view: C4View;
}

const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Mermaid aliases may contain only ASCII alphanumerics and underscores. */
export function sanitizeMermaidId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  if (!sanitized) return "_";
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function aliasesFor(nodes: readonly ArchNode[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const node of [...nodes].sort(byId)) {
    const base = sanitizeMermaidId(node.id);
    let alias = base;
    for (let suffix = 2; used.has(alias); suffix += 1) alias = `${base}_${suffix}`;
    used.add(alias);
    aliases.set(node.id, alias);
  }
  return aliases;
}

function aliasesForIds(ids: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...ids].sort()) {
    const base = sanitizeMermaidId(id);
    let alias = base;
    for (let suffix = 2; used.has(alias); suffix += 1) alias = `${base}_${suffix}`;
    used.add(alias);
    aliases.set(id, alias);
  }
  return aliases;
}

function text(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/"/g, "&quot;");
}

function quoted(value: string): string {
  return `"${text(value)}"`;
}

function diagramKind(view: C4View): "C4Context" | "C4Container" | "C4Component" {
  if (view.level === "context") return "C4Context";
  if (view.level === "containers") return "C4Container";
  return "C4Component";
}

function containerTechnology(node: ArchNode, typeLine: string): string {
  const variant = /^Container\s*·\s*(.+)$/.exec(typeLine)?.[1];
  return variant ? text(variant) : node.tech.join(", ");
}

/**
 * Generate Mermaid C4 from exactly one projected canvas level. Geometry is
 * deliberately ignored; ids determine declaration and relationship order so
 * repeated exports remain reviewable in source control.
 */
export function exportMermaidC4(projection: MermaidC4Projection): string {
  const { graph, typeLines, view } = projection;
  const nodes = graph.nodes.filter((node) => node.kind !== "note" && !isInfraZone(node.kind)).sort(byId);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const aliases = aliasesFor(nodes);
  const children = new Map<string, ArchNode[]>();
  for (const node of nodes) {
    if (!node.parentId || !nodeIds.has(node.parentId)) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  for (const nested of children.values()) nested.sort(byId);

  const boundaryKind = (node: ArchNode): "System_Boundary" | "Container_Boundary" | null => {
    if (!children.has(node.id)) return null;
    const typeLine = typeLines[node.id] ?? "";
    if (typeLine.startsWith("Container")) return "Container_Boundary";
    if (typeLine.startsWith("Software System")) return "System_Boundary";
    if (node.kind === "system" || node.kind === "group") {
      return view.level === "components" ? "Container_Boundary" : "System_Boundary";
    }
    return null;
  };

  const declaration = (node: ArchNode): string => {
    const alias = aliases.get(node.id)!;
    const typeLine = typeLines[node.id] ?? "";
    if (node.kind === "person" || typeLine === "Person") {
      return `Person(${alias}, ${quoted(node.label)})`;
    }
    if (node.kind === "external" || typeLine.startsWith("External System")) {
      return `System_Ext(${alias}, ${quoted(node.label)}, ${quoted(node.description)})`;
    }
    if (typeLine.startsWith("Container") || node.kind === "container") {
      return `Container(${alias}, ${quoted(node.label)}, ${quoted(containerTechnology(node, typeLine))}, ${quoted(node.description)})`;
    }
    if (typeLine.startsWith("Component") || typeLine.startsWith("Entity") || typeLine === "Endpoint") {
      return `Component(${alias}, ${quoted(node.label)}, ${quoted(node.tech.join(", "))}, ${quoted(node.description)})`;
    }
    if (typeLine.startsWith("Software System") || view.level === "context") {
      return `System(${alias}, ${quoted(node.label)}, ${quoted(node.description)})`;
    }
    if (view.level === "containers") {
      return `Container(${alias}, ${quoted(node.label)}, ${quoted(containerTechnology(node, typeLine))}, ${quoted(node.description)})`;
    }
    return `Component(${alias}, ${quoted(node.label)}, ${quoted(node.tech.join(", "))}, ${quoted(node.description)})`;
  };

  const emitted = new Set<string>();
  const renderNode = (node: ArchNode, depth: number): string[] => {
    emitted.add(node.id);
    const indent = "  ".repeat(depth);
    const boundary = boundaryKind(node);
    if (!boundary) return [`${indent}${declaration(node)}`];
    const lines = [
      `${indent}${boundary}(${aliases.get(node.id)!}, ${quoted(node.label)}) {`,
    ];
    for (const child of children.get(node.id) ?? []) {
      lines.push(...renderNode(child, depth + 1));
    }
    lines.push(`${indent}}`);
    return lines;
  };

  const declarations: string[] = [];
  for (const node of nodes) {
    if (emitted.has(node.id)) continue;
    const parent = node.parentId ? nodes.find((candidate) => candidate.id === node.parentId) : null;
    if (parent && boundaryKind(parent)) continue;
    declarations.push(...renderNode(node, 0));
  }

  const relationships = [...graph.edges]
    .sort(byId)
    .flatMap((edge) => {
      const source = aliases.get(edge.source);
      const target = aliases.get(edge.target);
      return source && target
        ? [`Rel(${source}, ${target}, ${quoted(edge.label)})`]
        : [];
    });

  return [
    diagramKind(view),
    `title ${text(graph.name)}`,
    "",
    ...declarations,
    ...(relationships.length > 0 ? ["", ...relationships] : []),
    "",
  ].join("\n");
}

/** Deterministic C4Deployment projection for one environment. */
export function exportMermaidC4Deployment(graph: ArchitectureGraph, envId: string): string {
  const environment = graph.environments.find((candidate) => candidate.id === envId);
  if (!environment) return "C4Deployment\n\n";
  const targetsById = new Map((environment.targets ?? []).map((target) => [target.id, target]));
  for (const node of graph.nodes) {
    const placement = node.placements[envId];
    if (!placement?.targetId || targetsById.has(placement.targetId)) continue;
    targetsById.set(placement.targetId, {
      id: placement.targetId,
      name: placement.target || "Unknown target",
      kind: "other",
    });
  }
  const targets = [...targetsById.values()].sort(byId);
  const placed = graph.nodes
    .filter((node) => {
      const placement = node.placements[envId];
      return !isInfraZone(node.kind) && node.kind !== "note" && !!placement?.targetId;
    })
    .sort(byId);
  const placedIds = new Set(placed.map((node) => node.id));
  const zones = graph.nodes.filter((node) => isInfraZone(node.kind)).sort(byId);
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  const targetIdsByZone = new Map<string | null, typeof targets>();
  for (const target of targets) {
    const zoneId = target.zone && zoneById.has(target.zone) ? target.zone : null;
    targetIdsByZone.set(zoneId, [...(targetIdsByZone.get(zoneId) ?? []), target]);
  }
  const usedZoneIds = new Set<string>();
  for (const target of targets) {
    let zoneId = target.zone && zoneById.has(target.zone) ? target.zone : null;
    const seen = new Set<string>();
    while (zoneId && !seen.has(zoneId)) {
      seen.add(zoneId);
      usedZoneIds.add(zoneId);
      const parentId = zoneById.get(zoneId)?.parentId;
      zoneId = parentId && zoneById.has(parentId) ? parentId : null;
    }
  }
  const children = new Map<string | null, ArchNode[]>();
  for (const zone of zones) {
    if (!usedZoneIds.has(zone.id)) continue;
    const parent = zone.parentId && usedZoneIds.has(zone.parentId) ? zone.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), zone]);
  }
  for (const list of children.values()) list.sort(byId);
  const aliases = aliasesForIds([environment.id, ...zones.filter((zone) => usedZoneIds.has(zone.id)).map((zone) => zone.id), ...targets.map((target) => target.id), ...placed.map((node) => node.id)]);
  const lines = ["C4Deployment", `title ${text(`${graph.name} — ${environment.name}`)}`, "", `Deployment_Node(${aliases.get(environment.id)}, ${quoted(environment.name)}, ${quoted(environment.kind)}) {`];
  const renderTarget = (target: (typeof targets)[number], depth: number) => {
    const indent = "  ".repeat(depth);
    const technology = [target.tech, target.region].filter(Boolean).join(" · ");
    lines.push(`${indent}Deployment_Node(${aliases.get(target.id)}, ${quoted(target.name)}, ${quoted(technology)}) {`);
    for (const node of placed.filter((candidate) => candidate.placements[envId]?.targetId === target.id)) {
      lines.push(`${indent}  Container(${aliases.get(node.id)}, ${quoted(node.label)}, ${quoted(node.tech.join(", "))}, ${quoted(node.description)})`);
    }
    lines.push(`${indent}}`);
  };
  const renderZone = (zone: ArchNode, depth: number) => {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}Deployment_Node(${aliases.get(zone.id)}, ${quoted(zone.label)}, ${quoted(zone.kind)}) {`);
    for (const child of children.get(zone.id) ?? []) renderZone(child, depth + 1);
    for (const target of targetIdsByZone.get(zone.id) ?? []) renderTarget(target, depth + 1);
    lines.push(`${indent}}`);
  };
  for (const zone of children.get(null) ?? []) renderZone(zone, 1);
  for (const target of targetIdsByZone.get(null) ?? []) renderTarget(target, 1);
  lines.push("}");
  const relationships = graph.edges.filter((edge) => placedIds.has(edge.source) && placedIds.has(edge.target)).sort(byId);
  if (relationships.length > 0) lines.push("");
  for (const edge of relationships) lines.push(`Rel(${aliases.get(edge.source)}, ${aliases.get(edge.target)}, ${quoted(edge.label)})`);
  lines.push("");
  return lines.join("\n");
}

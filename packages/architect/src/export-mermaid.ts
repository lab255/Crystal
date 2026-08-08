import type { ArchNode, ArchitectureGraph, C4View } from "@crystal/core";

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
  const nodes = graph.nodes.filter((node) => node.kind !== "note").sort(byId);
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

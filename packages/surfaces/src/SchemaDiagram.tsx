import { useCallback, useMemo } from "react";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { KeyRound, MoveRight } from "lucide-react";
import type { SchemaKind, SchemaSurface } from "@crystal/core";
import { Badge, cn, type BadgeTone } from "@crystal/ui";

/**
 * The ER diagram over the detected schemas: one entity card per schema with
 * its fields inline (pk keyed, relation fields arrowed), edges for every
 * resolved `references`. Small graphs (capped below) — built on the main
 * thread; the heavy-scene worker rule is for the code map's scale, not this.
 */

const MAX_DIAGRAM_NODES = 80;
const MAX_NODE_FIELDS = 12;
const NODE_W = 224;
const HEADER_H = 30;
const FIELD_H = 17;

interface EntityField {
  name: string;
  type?: string;
  pk?: boolean;
  references?: string;
  optional?: boolean;
}

interface EntityData extends Record<string, unknown> {
  name: string;
  kind: SchemaKind;
  tone: BadgeTone;
  fields: EntityField[];
  /** Fields beyond the render cap. */
  more: number;
  selected: boolean;
  dimmed: boolean;
}

type EntityNode = Node<EntityData, "entity">;

function EntityNodeView({ data }: NodeProps<EntityNode>) {
  return (
    <div
      className={cn(
        "w-56 rounded-lg border bg-surface-1 text-left shadow-lg transition-opacity",
        data.selected ? "border-crystal-400 ring-2 ring-crystal-500/30" : "border-edge-strong",
        data.dimmed && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-edge-strong" />
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-edge-strong" />
      <div className="flex items-center gap-1.5 rounded-t-lg border-b border-edge bg-surface-2 px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold text-ink">
          {data.name}
        </span>
        <Badge tone={data.tone} className="shrink-0">
          {data.kind}
        </Badge>
      </div>
      <div className="px-2 py-1">
        {data.fields.map((f) => (
          <div key={f.name} className="flex items-center gap-1 leading-[17px]">
            {f.pk ? (
              <KeyRound className="h-2.5 w-2.5 shrink-0 text-accent-amber" />
            ) : f.references ? (
              <MoveRight className="h-2.5 w-2.5 shrink-0 text-crystal-300" />
            ) : (
              <span className="w-2.5 shrink-0" />
            )}
            <span
              className={cn(
                "shrink-0 font-mono text-[10px]",
                f.pk ? "font-semibold text-ink" : "text-ink-muted",
              )}
            >
              {f.name}
              {f.optional ? "?" : ""}
            </span>
            <span className="min-w-0 truncate text-right font-mono text-[9.5px] text-ink-faint ml-auto">
              {f.references ?? f.type ?? ""}
            </span>
          </div>
        ))}
        {data.more > 0 ? (
          <div className="pl-3.5 text-[9.5px] text-ink-faint">+{data.more} more…</div>
        ) : null}
      </div>
    </div>
  );
}

const nodeTypes = { entity: EntityNodeView };

const KIND_TONE: Record<SchemaKind, BadgeTone> = {
  zod: "emerald",
  interface: "violet",
  type: "blue",
  mongoose: "amber",
  prisma: "cyan",
  drizzle: "emerald",
  typeorm: "rose",
  sql: "slate",
};

/** Pick the diagram population: related schemas first, then usage breadth. */
function pickDiagramSchemas(schemas: readonly SchemaSurface[]): {
  shown: SchemaSurface[];
  dropped: number;
} {
  if (schemas.length <= MAX_DIAGRAM_NODES) return { shown: [...schemas], dropped: 0 };
  const referenced = new Set<string>();
  const referencing = new Set<string>();
  for (const s of schemas) {
    for (const f of s.fields) {
      if (f.references) {
        referencing.add(s.id);
        referenced.add(f.references);
      }
    }
  }
  const score = (s: SchemaSurface): number =>
    (referencing.has(s.id) || referenced.has(s.name) ? 1_000_000 : 0) + s.usedBy;
  const shown = [...schemas].sort((a, z) => score(z) - score(a)).slice(0, MAX_DIAGRAM_NODES);
  return { shown, dropped: schemas.length - shown.length };
}

export function SchemaDiagram({
  schemas,
  selectedId,
  onSelect,
}: {
  schemas: readonly SchemaSurface[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges, dropped } = useMemo(() => {
    const { shown, dropped } = pickDiagramSchemas(schemas);
    // References name schemas by NAME; resolve within the shown set, same
    // file preferred (duplicate names across files are common for DTOs).
    const byName = new Map<string, SchemaSurface[]>();
    for (const s of shown) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    const resolve = (from: SchemaSurface, name: string): SchemaSurface | null => {
      const candidates = byName.get(name) ?? [];
      return candidates.find((c) => c.file === from.file) ?? candidates[0] ?? null;
    };

    const relatedIds = new Set<string>();
    const edges: Edge[] = [];
    for (const s of shown) {
      for (const f of s.fields) {
        if (!f.references) continue;
        const target = resolve(s, f.references);
        if (!target || target.id === s.id) continue;
        relatedIds.add(s.id);
        relatedIds.add(target.id);
        edges.push({
          id: `rel:${s.id}.${f.name}`,
          source: s.id,
          target: target.id,
          label: f.name,
          type: "smoothstep",
          style: { stroke: "var(--color-edge-strong)" },
          labelStyle: { fontSize: 9, fill: "var(--color-ink-faint)" },
          labelBgStyle: { fill: "transparent" },
        });
      }
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 90, marginx: 24, marginy: 24 });
    g.setDefaultEdgeLabel(() => ({}));
    const heightOf = (s: SchemaSurface) =>
      HEADER_H + Math.min(s.fields.length, MAX_NODE_FIELDS) * FIELD_H + 12;
    for (const s of shown) g.setNode(s.id, { width: NODE_W, height: heightOf(s) });
    for (const e of edges) g.setEdge(e.source, e.target);
    dagre.layout(g);

    const anyRelated = relatedIds.size > 0;
    const nodes: EntityNode[] = shown.map((s) => {
      const pos = g.node(s.id);
      return {
        id: s.id,
        type: "entity",
        position: { x: pos.x - NODE_W / 2, y: pos.y - heightOf(s) / 2 },
        data: {
          name: s.name,
          kind: s.kind,
          tone: KIND_TONE[s.kind],
          fields: s.fields.slice(0, MAX_NODE_FIELDS),
          more: Math.max(0, s.fields.length - MAX_NODE_FIELDS),
          selected: s.id === selectedId,
          // With relations present, unrelated entities recede so the ER
          // structure reads first; without any, everything is equal.
          dimmed: anyRelated && !relatedIds.has(s.id) && s.id !== selectedId,
        },
        draggable: true,
      };
    });
    return { nodes, edges, dropped };
  }, [schemas, selectedId]);

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => onSelect(node.id),
    [onSelect],
  );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.1}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-surface-0"
      >
        <Background gap={24} size={1} />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
        />
      </ReactFlow>
      {dropped > 0 ? (
        <div className="absolute right-3 top-3 rounded-lg border border-edge bg-surface-2/95 px-2 py-1 text-[10px] text-ink-faint shadow-lg">
          showing {MAX_DIAGRAM_NODES} of {schemas.length} — related + most-used first
        </div>
      ) : null}
    </div>
  );
}

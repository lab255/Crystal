import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { GitBranch } from "lucide-react";
import type { WorkflowStageDef, WorkflowStageStatus } from "@crystal/core";
import { Tooltip, cn } from "@crystal/ui";

/**
 * The workflow stage graph — one react-flow canvas shared by the template
 * builder (editable: connect/delete dependencies, drag stages) and the live
 * workflow view (read-only, stages colored by status). Layout is a layered
 * DAG computed from `dependsOn` depth; user drags override per stage id, so
 * remount (key by template id) when switching templates.
 */

const NODE_W = 200;
const NODE_H = 76;
const COL_GAP = 260;
const ROW_GAP = 100;

/** Layered layout: x by dependency depth, y centered within each column. */
export function layoutStages(stages: WorkflowStageDef[]): Map<string, { x: number; y: number }> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depths.get(id);
    if (known != null) return known;
    if (visiting.has(id)) return 0; // cycle guard — validation reports it
    visiting.add(id);
    const def = byId.get(id);
    const depth = def?.dependsOn.length
      ? 1 + Math.max(...def.dependsOn.filter((d) => byId.has(d) && d !== id).map(depthOf), -1)
      : 0;
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  const columns = new Map<number, string[]>();
  for (const stage of stages) {
    const depth = depthOf(stage.id);
    const col = columns.get(depth) ?? [];
    col.push(stage.id);
    columns.set(depth, col);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [depth, ids] of columns) {
    ids.forEach((id, i) => {
      positions.set(id, { x: depth * COL_GAP, y: (i - (ids.length - 1) / 2) * ROW_GAP });
    });
  }
  return positions;
}

const STAGE_CARD_CLASSES: Record<WorkflowStageStatus, string> = {
  pending: "border-edge bg-surface-1",
  active: "border-crystal-500/60 bg-crystal-500/10",
  done: "border-ok/40 bg-ok/5",
  skipped: "border-edge bg-surface-1 opacity-60",
};

type StageNodeData = {
  def: WorkflowStageDef;
  status?: WorkflowStageStatus;
  highlighted: boolean;
  connectable: boolean;
};
type StageRfNode = Node<StageNodeData, "stage">;

function StageNode({ data }: NodeProps<StageRfNode>) {
  const { def, status, highlighted, connectable } = data;
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2 shadow-sm transition-colors",
        STAGE_CARD_CLASSES[status ?? "pending"],
        highlighted && "ring-2 ring-crystal-400/60",
      )}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-edge"
        isConnectable={connectable}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-edge"
        isConnectable={connectable}
      />
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs font-semibold text-ink",
            status === "skipped" && "line-through",
          )}
        >
          {def.name || def.id}
        </span>
        {def.perTrack ? (
          <Tooltip content="Runs once per parallel track">
            <GitBranch className="h-3 w-3 shrink-0 text-crystal-300" />
          </Tooltip>
        ) : null}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
        <span className="rounded-full border border-edge px-1.5 py-px font-mono">
          {def.purpose}
        </span>
        {def.model ? <span className="font-mono">{def.model}</span> : null}
        {status && status !== "pending" ? (
          <span
            className={cn(
              "ml-auto font-medium",
              status === "active" && "text-crystal-200",
              status === "done" && "text-ok",
            )}
          >
            {status}
          </span>
        ) : null}
      </div>
      {def.description ? (
        <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-ink-muted">
          {def.description}
        </p>
      ) : null}
    </div>
  );
}

const nodeTypes = { stage: StageNode };

export function WorkflowGraph({
  stages,
  statuses,
  selectedStageId,
  onSelectStage,
  editable = false,
  onConnectDep,
  onRemoveDeps,
  onRemoveStages,
  className,
}: {
  stages: WorkflowStageDef[];
  /** Live stage statuses (workflow view); omit in the builder. */
  statuses?: ReadonlyMap<string, WorkflowStageStatus>;
  selectedStageId?: string | null;
  onSelectStage?: (id: string | null) => void;
  editable?: boolean;
  /** `to` gains a dependency on `from` (an edge was drawn). */
  onConnectDep?: (from: string, to: string) => void;
  onRemoveDeps?: (deps: { from: string; to: string }[]) => void;
  onRemoveStages?: (ids: string[]) => void;
  className?: string;
}) {
  const auto = useMemo(() => layoutStages(stages), [stages]);
  // Drag positions survive structural edits; switching templates remounts
  // (parent keys this component by template id) and clears them.
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});

  const nodes = useMemo<StageRfNode[]>(
    () =>
      stages.map((def) => ({
        id: def.id,
        type: "stage",
        position: dragged[def.id] ?? auto.get(def.id) ?? { x: 0, y: 0 },
        width: NODE_W,
        data: {
          def,
          status: statuses?.get(def.id),
          highlighted: selectedStageId === def.id,
          connectable: editable,
        },
        draggable: editable,
        deletable: editable,
      })),
    [stages, auto, dragged, statuses, selectedStageId, editable],
  );

  const edges = useMemo<Edge[]>(
    () =>
      stages.flatMap((def) =>
        def.dependsOn
          .filter((dep) => dep !== def.id && stages.some((s) => s.id === dep))
          .map((dep) => ({
            id: `${dep}->${def.id}`,
            source: dep,
            target: def.id,
            animated: statuses?.get(def.id) === "active",
            deletable: editable,
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
            style: { strokeWidth: 1.5 },
          })),
      ),
    [stages, statuses, editable],
  );

  return (
    <div className={cn("h-full min-h-0", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<StageRfNode>[]) => {
          const removed: string[] = [];
          for (const change of changes) {
            if (change.type === "position" && change.position) {
              const position = change.position;
              setDragged((prev) => ({ ...prev, [change.id]: position }));
            } else if (change.type === "remove") {
              removed.push(change.id);
            }
          }
          if (removed.length && editable) onRemoveStages?.(removed);
        }}
        onEdgesChange={(changes: EdgeChange[]) => {
          if (!editable) return;
          const removed = changes
            .filter((c) => c.type === "remove")
            .map((c) => {
              const [from, to] = c.id.split("->");
              return { from: from ?? "", to: to ?? "" };
            })
            .filter((d) => d.from && d.to);
          if (removed.length) onRemoveDeps?.(removed);
        }}
        onConnect={(conn) => {
          if (editable && conn.source && conn.target && conn.source !== conn.target) {
            onConnectDep?.(conn.source, conn.target);
          }
        }}
        onNodeClick={(_evt, n) => onSelectStage?.(n.id === selectedStageId ? null : n.id)}
        onPaneClick={() => onSelectStage?.(null)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.2}
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        {editable ? (
          <Controls
            position="bottom-left"
            showInteractive={false}
            className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
          />
        ) : null}
      </ReactFlow>
    </div>
  );
}

import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, GitCompareArrows, Minus, Pencil, Plus } from "lucide-react";
import {
  diffEdgeStatus,
  diffGraphs,
  diffNodeStatus,
  diffTotal,
  type ArchDiff,
  type ArchDiffStatus,
  type ArchDraft,
  type ArchEdge,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";
import { EmptyState, Pane, Split, cn } from "@crystal/ui";
import { KIND_META, toRfEdges, toRfNodes, type ArchRfEdge, type ArchRfNode } from "./model.js";
import { ContainerNode } from "./nodes/ContainerNode.js";
import { LeafNode } from "./nodes/LeafNode.js";
import { NoteNode } from "./nodes/NoteNode.js";

/**
 * Draft review — the draft and its base side by side, with every semantic
 * difference listed at a glance. Works for any draft; drafts minted from a
 * git ref (`archdraft.fromRef`) make this "review this PR / commit against
 * the current architecture".
 */

const nodeTypes = { container: ContainerNode, leaf: LeafNode, note: NoteNode };
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const STATUS_COLOR: Record<ArchDiffStatus, string> = {
  added: "var(--color-ok)",
  removed: "var(--color-danger)",
  changed: "var(--color-warn)",
};
const STATUS_TEXT: Record<ArchDiffStatus, string> = {
  added: "text-ok",
  removed: "text-danger",
  changed: "text-warn",
};

/** Focus request routed to both canvases; nonce re-fires repeated clicks. */
interface FocusRequest {
  ids: string[];
  nonce: number;
}

export function ReviewView({ draft }: { draft: ArchDraft }) {
  const diff = useMemo(() => diffGraphs(draft.base, draft.graph), [draft.base, draft.graph]);
  const nodeStatus = useMemo(() => diffNodeStatus(diff), [diff]);
  const edgeStatus = useMemo(() => diffEdgeStatus(diff), [diff]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);

  const requestFocus = (ids: string[]) =>
    setFocus((prev) => ({ ids, nonce: (prev?.nonce ?? 0) + 1 }));

  return (
    <div className="h-full min-h-0">
      <Split storageKey="architect:review" direction="horizontal">
        <Pane minSize="20%">
          <ReviewCanvas
            title="Current"
            graph={draft.base}
            nodeStatus={nodeStatus}
            edgeStatus={edgeStatus}
            focus={focus}
          />
        </Pane>
        <Pane minSize="20%">
          <ReviewCanvas
            title={draft.name}
            emphasized
            graph={draft.graph}
            nodeStatus={nodeStatus}
            edgeStatus={edgeStatus}
            focus={focus}
          />
        </Pane>
        <Pane defaultSize={304} minSize={228} maxSize={480}>
          <ChangeList draft={draft} diff={diff} onFocus={requestFocus} />
        </Pane>
      </Split>
    </div>
  );
}

function ReviewCanvas({
  title,
  emphasized,
  graph,
  nodeStatus,
  edgeStatus,
  focus,
}: {
  title: string;
  emphasized?: boolean;
  graph: ArchitectureGraph;
  nodeStatus: Map<string, ArchDiffStatus>;
  edgeStatus: Map<string, ArchDiffStatus>;
  focus: FocusRequest | null;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<ArchRfNode, ArchRfEdge> | null>(null);

  const nodes = useMemo(
    () =>
      toRfNodes(graph, EMPTY_SELECTION).map((n) => {
        const status = nodeStatus.get(n.id);
        if (!status) return n;
        return {
          ...n,
          style: {
            ...n.style,
            outline: `2px solid ${STATUS_COLOR[status]}`,
            outlineOffset: 3,
            borderRadius: 12,
          },
        };
      }),
    [graph, nodeStatus],
  );
  const edges = useMemo(
    () =>
      toRfEdges(graph, EMPTY_SELECTION).map((e) => {
        const status = edgeStatus.get(e.id);
        if (!status) return e;
        return {
          ...e,
          style: { ...e.style, stroke: STATUS_COLOR[status], strokeWidth: 2.2, opacity: 1 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: STATUS_COLOR[status],
            width: 16,
            height: 16,
          },
        };
      }),
    [graph, edgeStatus],
  );

  // Zoom to the change the user clicked in the list (ids present in this graph).
  useEffect(() => {
    if (!focus || !instance) return;
    const present = focus.ids.filter((id) => graph.nodes.some((n) => n.id === id));
    if (present.length === 0) return;
    void instance.fitView({
      nodes: present.map((id) => ({ id })),
      duration: 300,
      padding: 0.5,
      maxZoom: 1.1,
    });
  }, [focus, instance, graph]);

  return (
    <div className="relative h-full w-full">
      <div
        className={cn(
          "absolute left-3 top-3 z-10 rounded-lg border px-2 py-0.5 text-[10.5px] font-semibold backdrop-blur",
          emphasized
            ? "border-warn/40 bg-warn/10 text-warn"
            : "border-edge bg-surface-2/90 text-ink-muted",
        )}
      >
        {title}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        proOptions={{ hideAttribution: true }}
        className="bg-surface-0"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
      </ReactFlow>
    </div>
  );
}

function StatusIcon({ status }: { status: ArchDiffStatus }) {
  const Icon = status === "added" ? Plus : status === "removed" ? Minus : Pencil;
  return <Icon className={cn("h-3 w-3 shrink-0", STATUS_TEXT[status])} />;
}

function ChangeList({
  draft,
  diff,
  onFocus,
}: {
  draft: ArchDraft;
  diff: ArchDiff;
  onFocus: (ids: string[]) => void;
}) {
  const total = diffTotal(diff);
  const labelOf = (graph: ArchitectureGraph, id: string): string =>
    graph.nodes.find((n) => n.id === id)?.label ?? "?";

  const nodeEntry = (node: ArchNode, status: ArchDiffStatus, detail?: string) => {
    const Icon = KIND_META[node.kind].icon;
    return (
      <ChangeEntry
        key={`${status}:${node.id}`}
        status={status}
        onClick={() => onFocus([node.id])}
        icon={<Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />}
        label={node.label}
        detail={detail ?? KIND_META[node.kind].label}
      />
    );
  };

  const edgeEntry = (graph: ArchitectureGraph, edge: ArchEdge, status: ArchDiffStatus, detail?: string) => (
    <ChangeEntry
      key={`${status}:${edge.source}->${edge.target}`}
      status={status}
      onClick={() => onFocus([edge.source, edge.target])}
      icon={<ArrowRight className="h-3.5 w-3.5 shrink-0 opacity-80" />}
      label={`${labelOf(graph, edge.source)} → ${labelOf(graph, edge.target)}`}
      detail={detail ?? `${edge.kind}${edge.label ? ` · ${edge.label}` : ""}`}
    />
  );

  return (
    <aside className="flex h-full w-full flex-col border-l border-edge bg-surface-1">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="text-xs font-semibold text-ink">Changes</span>
        <span className="ml-auto rounded-full bg-surface-3 px-1.5 text-[10px] leading-4 text-ink-faint">
          {total}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {total === 0 ? (
          <EmptyState icon={GitCompareArrows} title="No differences">
            “{draft.name}” matches its base architecture — nothing changed structurally.
          </EmptyState>
        ) : (
          <>
            <Section title="Components" count={diff.addedNodes.length + diff.removedNodes.length + diff.changedNodes.length}>
              {diff.addedNodes.map((n) => nodeEntry(n, "added"))}
              {diff.removedNodes.map((n) => nodeEntry(n, "removed"))}
              {diff.changedNodes.map((c) =>
                nodeEntry(c.after, "changed", c.fields.join(", ")),
              )}
            </Section>
            <Section title="Connections" count={diff.addedEdges.length + diff.removedEdges.length + diff.changedEdges.length}>
              {diff.addedEdges.map((e) => edgeEntry(draft.graph, e, "added"))}
              {diff.removedEdges.map((e) => edgeEntry(draft.base, e, "removed"))}
              {diff.changedEdges.map((c) =>
                edgeEntry(
                  draft.graph,
                  c.after,
                  "changed",
                  c.fields
                    .map((f) =>
                      f === "kind"
                        ? `${c.before.kind} → ${c.after.kind}`
                        : `${c.before.label || "∅"} → ${c.after.label || "∅"}`,
                    )
                    .join(" · "),
                ),
              )}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {title} ({count})
      </div>
      {children}
    </div>
  );
}

function ChangeEntry({
  status,
  icon,
  label,
  detail,
  onClick,
}: {
  status: ArchDiffStatus;
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      <StatusIcon status={status} />
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-[10px] text-ink-faint">{detail}</span> : null}
      </span>
    </button>
  );
}

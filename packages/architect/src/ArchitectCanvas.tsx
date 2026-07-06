import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Node as RfNode,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import {
  isContainerKind,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeMapSummary,
} from "@crystal/core";
import {
  addEdge as opAddEdge,
  addNode as opAddNode,
  containerAtPoint,
  absolutePosition,
  deleteEdges,
  deleteNodes,
  reparentNode,
  updateNode,
} from "./graph-ops.js";
import { autoLayout } from "./layout.js";
import {
  KIND_META,
  accentOf,
  toRfEdges,
  toRfNodes,
  type ArchRfEdge,
  type ArchRfNode,
} from "./model.js";
import { ContainerNode } from "./nodes/ContainerNode.js";
import { LeafNode } from "./nodes/LeafNode.js";
import { NoteNode } from "./nodes/NoteNode.js";
import { Inspector } from "./Inspector.js";
import { adoptAutoLinks, computeOverlay, type OverlayResult } from "./overlay.js";
import { Palette, DRAG_MIME } from "./Palette.js";
import { Toolbar } from "./Toolbar.js";
import type { ArchEdgeKind } from "@crystal/core";

const nodeTypes = { container: ContainerNode, leaf: LeafNode, note: NoteNode };

export interface ArchitectCanvasProps {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  /** Live code map for the overlay; null while unavailable. */
  codeSummary?: CodeMapSummary | null;
  overlayOn?: boolean;
  onToggleOverlay?: (on: boolean) => void;
}

const GHOST_STROKE = "var(--color-crystal-400)";

/** Recolor drawn edges by overlay verdict and append dashed ghost edges. */
function applyOverlayToEdges(edges: ArchRfEdge[], overlay: OverlayResult): ArchRfEdge[] {
  const decorated = edges.map((e) => {
    if (overlay.confirmedEdgeIds.has(e.id)) {
      return {
        ...e,
        style: { ...e.style, stroke: "var(--color-ok)", strokeWidth: 2, opacity: 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-ok)", width: 16, height: 16 },
      };
    }
    if (overlay.staleEdgeIds.has(e.id)) {
      return {
        ...e,
        label: e.label ?? "not in code",
        style: { ...e.style, stroke: "var(--color-warn)", strokeDasharray: "3 4", opacity: 0.8 },
        labelStyle: { fill: "var(--color-warn)", fontSize: 9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-warn)", width: 14, height: 14 },
      };
    }
    return e;
  });
  for (const ghost of overlay.ghostEdges) {
    decorated.push({
      id: `ghost:${ghost.sourceModule}->${ghost.targetModule}`,
      source: ghost.source,
      target: ghost.target,
      type: "default",
      animated: true,
      selectable: false,
      deletable: false,
      focusable: false,
      data: { kind: "dependency" },
      label: ghost.weight > 1 ? `code ×${ghost.weight}` : "code",
      style: { stroke: GHOST_STROKE, strokeWidth: 1.3, strokeDasharray: "5 4", opacity: 0.75 },
      labelStyle: { fill: GHOST_STROKE, fontSize: 9 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: GHOST_STROKE, width: 14, height: 14 },
    });
  }
  return decorated;
}

function CanvasInner({
  graph,
  onChange,
  codeSummary,
  overlayOn,
  onToggleOverlay,
}: ArchitectCanvasProps) {
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const [defaultEdgeKind, setDefaultEdgeKind] = useState<ArchEdgeKind>("sync");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();

  // Keep a ref of the latest graph so stale-closure callbacks always mutate fresh state.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const commit = useCallback(
    (next: ArchitectureGraph) => {
      graphRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const overlay = useMemo(
    () => (overlayOn && codeSummary ? computeOverlay(graph, codeSummary) : null),
    [overlayOn, codeSummary, graph],
  );

  const rfNodes = useMemo(() => {
    const nodes = toRfNodes(graph, selectedNodes);
    if (!overlay) return nodes;
    return nodes.map((n) => {
      const code = overlay.nodeBadges.get(n.id);
      return code ? { ...n, data: { ...n.data, code } } : n;
    });
  }, [graph, selectedNodes, overlay]);
  const rfEdges = useMemo(() => {
    const edges = toRfEdges(graph, selectedEdges);
    return overlay ? applyOverlayToEdges(edges, overlay) : edges;
  }, [graph, selectedEdges, overlay]);

  const onNodesChange = useCallback(
    (changes: NodeChange<ArchRfNode>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      for (const change of changes) {
        switch (change.type) {
          case "position":
            if (change.position) {
              g = updateNode(g, change.id, {
                position: { x: change.position.x, y: change.position.y },
              });
            }
            break;
          case "dimensions": {
            const node = g.nodes.find((n) => n.id === change.id);
            if (node && isContainerKind(node.kind) && change.dimensions && change.resizing) {
              g = updateNode(g, change.id, {
                size: { width: change.dimensions.width, height: change.dimensions.height },
              });
            }
            break;
          }
          case "select": {
            selection ??= new Set(selectedNodes);
            if (change.selected) selection.add(change.id);
            else selection.delete(change.id);
            break;
          }
          case "remove":
            g = deleteNodes(g, [change.id]);
            break;
          default:
            break;
        }
      }
      if (selection) setSelectedNodes(selection);
      if (g !== graphRef.current) commit(g);
    },
    [commit, selectedNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ArchRfEdge>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      for (const change of changes) {
        if (change.type === "select") {
          selection ??= new Set(selectedEdges);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        } else if (change.type === "remove") {
          g = deleteEdges(g, [change.id]);
        }
      }
      if (selection) setSelectedEdges(selection);
      if (g !== graphRef.current) commit(g);
    },
    [commit, selectedEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      commit(opAddEdge(graphRef.current, connection.source, connection.target, defaultEdgeKind));
    },
    [commit, defaultEdgeKind],
  );

  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode, nodes: RfNode[]) => {
      let g = graphRef.current;
      const dragged = nodes.length ? nodes : [node];
      for (const rf of dragged) {
        const abs = absolutePosition(g, rf.id);
        const width = rf.measured?.width ?? rf.width ?? 200;
        const height = rf.measured?.height ?? rf.height ?? 80;
        const center = { x: abs.x + width / 2, y: abs.y + height / 2 };
        const container = containerAtPoint(g, center, rf.id);
        const currentParent = g.nodes.find((n) => n.id === rf.id)?.parentId ?? null;
        const nextParent = container?.id ?? null;
        if (nextParent !== currentParent) {
          g = reparentNode(g, rf.id, nextParent, abs);
        }
      }
      if (g !== graphRef.current) commit(g);
    },
    [commit],
  );

  const addNodeAt = useCallback(
    (kind: ArchNodeKind, flowPos: { x: number; y: number }) => {
      let g = graphRef.current;
      const container = containerAtPoint(g, flowPos, undefined);
      const parentAbs = container ? absolutePosition(g, container.id) : { x: 0, y: 0 };
      const rel = { x: flowPos.x - parentAbs.x, y: flowPos.y - parentAbs.y };
      const { graph: next, node } = opAddNode(
        g,
        kind,
        `New ${KIND_META[kind].label.toLowerCase()}`,
        container ? rel : flowPos,
        container?.id ?? null,
      );
      commit(next);
      setSelectedNodes(new Set([node.id]));
      setSelectedEdges(new Set());
    },
    [commit],
  );

  const onDrop = useCallback(
    (evt: DragEvent) => {
      const kind = evt.dataTransfer.getData(DRAG_MIME) as ArchNodeKind;
      if (!kind || !(kind in KIND_META)) return;
      evt.preventDefault();
      addNodeAt(kind, screenToFlowPosition({ x: evt.clientX, y: evt.clientY }));
    },
    [addNodeAt, screenToFlowPosition],
  );

  const addAtViewportCenter = useCallback(
    (kind: ArchNodeKind) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const point = rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      addNodeAt(kind, screenToFlowPosition(point));
    },
    [addNodeAt, screenToFlowPosition],
  );

  const onMoveEnd = useCallback(
    (_evt: unknown, viewport: Viewport) => {
      commit({ ...graphRef.current, viewport });
    },
    [commit],
  );

  const runAutoLayout = useCallback(() => {
    commit(autoLayout(graphRef.current));
    // Let the new positions render, then bring everything into view.
    requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
  }, [commit, fitView]);

  const selectedNode =
    selectedNodes.size === 1 ? graph.nodes.find((n) => selectedNodes.has(n.id)) : undefined;
  const selectedEdge =
    selectedNodes.size === 0 && selectedEdges.size === 1
      ? graph.edges.find((e) => selectedEdges.has(e.id))
      : undefined;

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onMoveEnd={onMoveEnd}
        defaultViewport={graph.viewport ?? undefined}
        fitView={!graph.viewport}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2.5}
        deleteKeyCode={["Delete", "Backspace"]}
        selectionOnDrag={false}
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        className="bg-surface-0"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
        <MiniMap
          pannable
          zoomable
          className="!bottom-3 !right-3 !h-32 !w-44 rounded-lg border border-edge !bg-surface-1"
          maskColor="rgba(6, 8, 12, 0.72)"
          nodeColor={(n) => accentOf((n as ArchRfNode).data.arch)}
          nodeStrokeWidth={0}
        />
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
        />
        <Panel position="top-left">
          <Toolbar
            graph={graph}
            defaultEdgeKind={defaultEdgeKind}
            onDefaultEdgeKindChange={setDefaultEdgeKind}
            onAutoLayout={runAutoLayout}
            onFitView={() => void fitView({ padding: 0.15, duration: 300 })}
            onRename={(name) => commit({ ...graphRef.current, name })}
            overlayOn={overlayOn}
            onToggleOverlay={onToggleOverlay}
          />
        </Panel>
        <Panel position="center-left">
          <Palette onAdd={addAtViewportCenter} />
        </Panel>
        {overlay ? (
          <Panel position="bottom-center">
            <OverlayLegend
              overlay={overlay}
              onAdoptAutoLinks={() => commit(adoptAutoLinks(graphRef.current, overlay))}
            />
          </Panel>
        ) : null}
      </ReactFlow>

      {selectedNode || selectedEdge ? (
        <Inspector
          graph={graph}
          node={selectedNode}
          edge={selectedEdge}
          codeModules={codeSummary?.modules}
          onGraphChange={commit}
          onClearSelection={() => {
            setSelectedNodes(new Set());
            setSelectedEdges(new Set());
          }}
        />
      ) : null}
    </div>
  );
}

function OverlayLegend({
  overlay,
  onAdoptAutoLinks,
}: {
  overlay: OverlayResult;
  onAdoptAutoLinks: () => void;
}) {
  const autoCount = [...overlay.nodeBadges.values()].filter((b) => b.auto).length;
  const swatch = (border: string) => (
    <span className="inline-block w-4 shrink-0" style={{ borderTop: border }} />
  );
  return (
    <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface-2/95 px-3 py-1.5 text-[10px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
      <span className="flex items-center gap-1.5">
        {swatch("2px solid var(--color-ok)")} in code ({overlay.confirmedEdgeIds.size})
      </span>
      <span className="flex items-center gap-1.5">
        {swatch("2px dashed var(--color-crystal-400)")} code only ({overlay.ghostEdges.length})
      </span>
      <span className="flex items-center gap-1.5">
        {swatch("2px dashed var(--color-warn)")} diagram only ({overlay.staleEdgeIds.size})
      </span>
      {overlay.unmappedModules.length > 0 ? (
        <span className="text-ink-faint">{overlay.unmappedModules.length} unlinked modules</span>
      ) : null}
      {autoCount > 0 ? (
        <button
          type="button"
          onClick={onAdoptAutoLinks}
          className="rounded-md bg-crystal-500/15 px-1.5 py-0.5 font-medium text-crystal-300 hover:bg-crystal-500/25"
        >
          Keep {autoCount} suggested link{autoCount > 1 ? "s" : ""}
        </button>
      ) : null}
    </div>
  );
}

export function ArchitectCanvas(props: ArchitectCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner key={props.graph.id} {...props} />
    </ReactFlowProvider>
  );
}

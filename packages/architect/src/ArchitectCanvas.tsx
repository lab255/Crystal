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
import { useCallback, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Code2, Copy, Expand, FolderGit2, LayoutGrid, Maximize2, Pencil, Plus, Rows3, Shrink, Trash2 } from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  isContainerKind,
  uid,
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
  updateEdge,
  updateNode,
} from "./graph-ops.js";
import { useCrystal } from "@crystal/client";
import { cn } from "@crystal/ui";
import { ContextMenu, InlineRename, type MenuEntry } from "./ContextMenu.js";
import { collapseNode, expandNodeIntoCode, hasGeneratedChildren } from "./expand.js";
import { autoLayout } from "./layout.js";
import {
  EDGE_KIND_STYLE,
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
import { adoptAutoLinks, computeOverlay, suggestModuleFor, type OverlayResult } from "./overlay.js";
import type { FlowProjection } from "./dataflow.js";
import { requestOpenFile } from "./codemap/CodeMapView.js";
import { PeekPanel } from "./snippets.js";
import { Palette, DRAG_MIME, PALETTE_KINDS } from "./Palette.js";
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
  /** "Zoom into code": open the code map at the module (and optionally file) a node is linked to. */
  onDrillIntoModule?: (modulePath: string, file?: string) => void;
  /** True while editing a draft plan — canvas gets a visual draft treatment. */
  draftMode?: boolean;
  /** Active journey projection — decorates the canvas as a dataflow lens. */
  flow?: FlowProjection | null;
}

const GHOST_STROKE = "var(--color-crystal-400)";
const FLOW_STROKE = "var(--color-crystal-400)";

/** Journey lens: highlight + number edges on the flow, dim the rest. */
function applyFlowToEdges(edges: ArchRfEdge[], flow: FlowProjection): ArchRfEdge[] {
  const decorated = edges.map((e): ArchRfEdge => {
    const steps = flow.edgeSteps.get(e.id);
    if (!steps) return { ...e, style: { ...e.style, opacity: 0.15 }, label: undefined };
    return {
      ...e,
      animated: true,
      label: steps.join(" · "),
      style: { ...e.style, stroke: FLOW_STROKE, strokeWidth: 2.4, strokeDasharray: undefined, opacity: 1 },
      labelStyle: { fill: FLOW_STROKE, fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, color: FLOW_STROKE, width: 18, height: 18 },
    };
  });
  for (const hop of flow.ghostHops) {
    decorated.push({
      id: `flow:${hop.step}`,
      source: hop.source,
      target: hop.target,
      type: "default",
      animated: true,
      selectable: false,
      deletable: false,
      focusable: false,
      data: { kind: "data" },
      label: String(hop.step),
      style: { stroke: FLOW_STROKE, strokeWidth: 2, strokeDasharray: "5 4", opacity: 0.9 },
      labelStyle: { fill: FLOW_STROKE, fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, color: FLOW_STROKE, width: 18, height: 18 },
    });
  }
  return decorated;
}

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

type MenuState =
  | { kind: "pane"; x: number; y: number; flowPos: { x: number; y: number } }
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "edge"; x: number; y: number; id: string };

function CanvasInner({
  graph,
  onChange,
  codeSummary,
  overlayOn,
  onToggleOverlay,
  onDrillIntoModule,
  draftMode,
  flow,
}: ArchitectCanvasProps) {
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const [defaultEdgeKind, setDefaultEdgeKind] = useState<ArchEdgeKind>("sync");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ x: number; y: number; id: string } | null>(null);
  const [peek, setPeek] = useState<{ module: string; label: string; file?: string } | null>(null);
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
    let nodes = toRfNodes(graph, selectedNodes);
    if (overlay) {
      nodes = nodes.map((n) => {
        const code = overlay.nodeBadges.get(n.id);
        return code ? { ...n, data: { ...n.data, code } } : n;
      });
    }
    if (flow) {
      const stepOf = new Map(flow.nodeOrder.map((o) => [o.nodeId, o.firstStep]));
      nodes = nodes.map((n) => ({
        ...n,
        data: { ...n.data, flow: { step: stepOf.get(n.id) ?? null } },
      }));
    }
    return nodes;
  }, [graph, selectedNodes, overlay, flow]);
  const rfEdges = useMemo(() => {
    let edges = toRfEdges(graph, selectedEdges);
    if (overlay) edges = applyOverlayToEdges(edges, overlay);
    if (flow) edges = applyFlowToEdges(edges, flow);
    return edges;
  }, [graph, selectedEdges, overlay, flow]);

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

  const runAutoLayout = useCallback(
    (mode: "flow" | "layers" = "flow") => {
      commit(autoLayout(graphRef.current, { mode }));
      // Let the new positions render, then bring everything into view.
      requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    },
    [commit, fitView],
  );

  /** Module a node maps to: explicit link, then overlay match, then name match. */
  const moduleForNode = useCallback(
    (id: string): string | null => {
      const node = graphRef.current.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note") return null;
      if (node.codeModule) return node.codeModule;
      const badge = overlay?.nodeBadges.get(id);
      if (badge) return badge.module;
      if (codeSummary) return suggestModuleFor(node, codeSummary.modules)?.path ?? null;
      return null;
    },
    [overlay, codeSummary],
  );

  /**
   * Code anchor of a node: file-linked nodes (from "Expand code") resolve to
   * their file plus its owning module; everything else falls back to the
   * module link.
   */
  const codeRefForNode = useCallback(
    (id: string): { module: string; file?: string } | null => {
      const g = graphRef.current;
      const node = g.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note") return null;
      if (node.codeFile) {
        const file = node.codeFile;
        let parent = node.parentId ? g.nodes.find((n) => n.id === node.parentId) : undefined;
        while (parent && !parent.codeModule) {
          parent = parent.parentId ? g.nodes.find((n) => n.id === parent!.parentId) : undefined;
        }
        const byPrefix = codeSummary?.modules
          .filter((m) => m.path !== "." && file.startsWith(`${m.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0]?.path;
        const module =
          parent?.codeModule ??
          byPrefix ??
          (codeSummary?.modules.some((m) => m.path === ".") ? "." : null);
        return module ? { module, file } : null;
      }
      const module = moduleForNode(id);
      return module ? { module } : null;
    },
    [moduleForNode, codeSummary],
  );

  const { client } = useCrystal();
  const expandNodeCode = useCallback(
    async (id: string, module: string) => {
      try {
        const detail = await client.request("codemap.module", { path: module });
        commit(expandNodeIntoCode(graphRef.current, id, detail));
      } catch {
        // Module vanished from the map between menu open and click — no-op.
      }
    },
    [client, commit],
  );

  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const ref = codeRefForNode(node.id);
      if (ref && onDrillIntoModule) onDrillIntoModule(ref.module, ref.file);
    },
    [codeRefForNode, onDrillIntoModule],
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const g = graphRef.current;
      const node = g.nodes.find((n) => n.id === id);
      if (!node) return;
      const copy = {
        ...structuredClone(node),
        id: uid("node"),
        label: `${node.label} copy`,
        position: { x: node.position.x + 32, y: node.position.y + 32 },
      };
      commit({ ...g, nodes: [...g.nodes, copy] });
      setSelectedNodes(new Set([copy.id]));
    },
    [commit],
  );

  const onNodeContextMenu = useCallback((evt: ReactMouseEvent, node: RfNode) => {
    evt.preventDefault();
    setMenu({ kind: "node", x: evt.clientX, y: evt.clientY, id: node.id });
  }, []);

  const onEdgeContextMenu = useCallback((evt: ReactMouseEvent, edge: ArchRfEdge) => {
    evt.preventDefault();
    setMenu({ kind: "edge", x: evt.clientX, y: evt.clientY, id: edge.id });
  }, []);

  const onPaneContextMenu = useCallback(
    (evt: MouseEvent | ReactMouseEvent) => {
      evt.preventDefault();
      setMenu({
        kind: "pane",
        x: evt.clientX,
        y: evt.clientY,
        flowPos: screenToFlowPosition({ x: evt.clientX, y: evt.clientY }),
      });
    },
    [screenToFlowPosition],
  );

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu) return [];
    const g = graphRef.current;

    if (menu.kind === "pane") {
      return [
        { type: "heading", label: "Add" },
        ...PALETTE_KINDS.map<MenuEntry>((kind) => ({
          type: "item",
          label: KIND_META[kind].label,
          icon: KIND_META[kind].icon,
          onSelect: () => addNodeAt(kind, menu.flowPos),
        })),
        { type: "separator" },
        { type: "item", label: "Auto-layout · flow", icon: LayoutGrid, onSelect: () => runAutoLayout("flow") },
        {
          type: "item",
          label: "Auto-layout · layers",
          icon: Rows3,
          onSelect: () => runAutoLayout("layers"),
        },
        {
          type: "item",
          label: "Fit view",
          icon: Maximize2,
          onSelect: () => void fitView({ padding: 0.15, duration: 300 }),
        },
      ];
    }

    if (menu.kind === "node") {
      const node = g.nodes.find((n) => n.id === menu.id);
      if (!node) return [];
      const ref = codeRefForNode(node.id);
      const hint = ref ? (ref.file ? ref.file.split("/").pop() : ref.module) : undefined;
      const expanded = hasGeneratedChildren(g, node.id);
      return [
        { type: "heading", label: node.label },
        {
          type: "item",
          label: "Rename",
          icon: Pencil,
          onSelect: () => setRenaming({ x: menu.x, y: menu.y, id: node.id }),
        },
        {
          type: "item",
          label: "Peek code",
          icon: Code2,
          disabled: !ref,
          hint,
          onSelect: () => ref && setPeek({ module: ref.module, label: node.label, file: ref.file }),
        },
        {
          type: "item",
          label: "Zoom into code",
          icon: FolderGit2,
          disabled: !ref || !onDrillIntoModule,
          hint,
          onSelect: () => ref && onDrillIntoModule?.(ref.module, ref.file),
        },
        {
          type: "item",
          label: expanded ? "Refresh expanded code" : "Expand code into diagram",
          icon: Expand,
          disabled: !ref || !!ref.file,
          hint: ref && !ref.file ? ref.module : undefined,
          onSelect: () => ref && void expandNodeCode(node.id, ref.module),
        },
        ...(expanded
          ? [
              {
                type: "item",
                label: "Collapse code",
                icon: Shrink,
                onSelect: () => commit(collapseNode(graphRef.current, node.id)),
              } satisfies MenuEntry,
            ]
          : []),
        { type: "item", label: "Duplicate", icon: Copy, onSelect: () => duplicateNode(node.id) },
        { type: "separator" },
        {
          type: "item",
          label: isContainerKind(node.kind) ? "Delete container + contents" : "Delete",
          icon: Trash2,
          danger: true,
          onSelect: () => {
            commit(deleteNodes(graphRef.current, [node.id]));
            setSelectedNodes(new Set());
          },
        },
      ];
    }

    // Edge menu. Ghost edges (code-only) get a single "draw it" action.
    if (menu.id.startsWith("ghost:")) {
      const ghost = overlay?.ghostEdges.find(
        (e) => `ghost:${e.sourceModule}->${e.targetModule}` === menu.id,
      );
      if (!ghost) return [];
      return [
        { type: "heading", label: "Code-only dependency" },
        {
          type: "item",
          label: "Add to diagram",
          icon: Plus,
          onSelect: () =>
            commit(opAddEdge(graphRef.current, ghost.source, ghost.target, "dependency")),
        },
      ];
    }
    const edge = g.edges.find((e) => e.id === menu.id);
    if (!edge) return [];
    return [
      { type: "heading", label: "Connection kind" },
      ...ARCH_EDGE_KINDS.map<MenuEntry>((kind) => ({
        type: "item",
        label: EDGE_KIND_STYLE[kind].label,
        checked: edge.kind === kind,
        onSelect: () => commit(updateEdge(graphRef.current, edge.id, { kind })),
      })),
      { type: "separator" },
      {
        type: "item",
        label: "Delete connection",
        icon: Trash2,
        danger: true,
        onSelect: () => {
          commit(deleteEdges(graphRef.current, [edge.id]));
          setSelectedEdges(new Set());
        },
      },
    ];
  }, [menu, codeRefForNode, expandNodeCode, onDrillIntoModule, addNodeAt, runAutoLayout, fitView, duplicateNode, commit, overlay]);

  const selectedNode =
    selectedNodes.size === 1 ? graph.nodes.find((n) => selectedNodes.has(n.id)) : undefined;
  const selectedEdge =
    selectedNodes.size === 0 && selectedEdges.size === 1
      ? graph.edges.find((e) => selectedEdges.has(e.id))
      : undefined;

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative h-full w-full",
        draftMode && "ring-2 ring-inset ring-warn/50",
      )}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        zoomOnDoubleClick={false}
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

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />
      ) : null}
      {peek ? (
        <PeekPanel
          module={peek.module}
          nodeLabel={peek.label}
          initialFile={peek.file}
          onClose={() => setPeek(null)}
          onOpenFile={requestOpenFile}
        />
      ) : null}
      {renaming ? (
        <InlineRename
          x={renaming.x}
          y={renaming.y}
          initial={graph.nodes.find((n) => n.id === renaming.id)?.label ?? ""}
          onCommit={(label) => {
            commit(updateNode(graphRef.current, renaming.id, { label }));
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : null}

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

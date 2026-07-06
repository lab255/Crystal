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
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Code2,
  Copy,
  Expand,
  ExternalLink,
  FolderGit2,
  LayoutGrid,
  Maximize2,
  MoveUpRight,
  Package,
  Paintbrush,
  Pencil,
  Plus,
  Route,
  Rows3,
  Shrink,
  Trash2,
} from "lucide-react";
import {
  ARCH_EDGE_KINDS,
  isContainerKind,
  uid,
  type ArchEdgeKind,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeFileDetail,
  type CodeMapSummary,
  type CodeModuleDetail,
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
import { useCrystal, useWorkspaces } from "@crystal/client";
import { cn } from "@crystal/ui";
import { ContextMenu, InlineRename, type MenuEntry } from "./ContextMenu.js";
import { collapseNode, hasGeneratedChildren } from "./expand.js";
import { autoLayout } from "./layout.js";
import {
  ACCENT_CSS,
  EDGE_KIND_STYLE,
  KIND_META,
  accentOf,
  toRfEdges,
  toRfNodes,
  type AccentName,
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
import type { SymbolDragPayload } from "./codemap/CodeNode.js";
import {
  absolutePositionOf,
  codeKey,
  fileId,
  type DropTarget,
  type FileNodeData,
  type MapNodeData,
  type MapRfNode,
  type MoveLikeIntent,
  type SymbolNodeData,
} from "./codemap/map-model.js";
import { MapActionsContext, mapNodeTypes, type MapActions } from "./codemap/map-nodes.js";
import { buildCodeContent, unifiedDropTargetAt, type HitTestNode } from "./live-code.js";
import { PeekPanel } from "./snippets.js";
import { Palette, DRAG_MIME, PALETTE_KINDS } from "./Palette.js";
import { Toolbar } from "./Toolbar.js";

const nodeTypes = {
  container: ContainerNode,
  leaf: LeafNode,
  note: NoteNode,
  codeFile: mapNodeTypes.codeFile,
  codeSymbol: mapNodeTypes.codeSymbol,
};

type CanvasNode = ArchRfNode | MapRfNode;

/** Ephemeral live-code children carry map-model ids, never graph node ids. */
function isCodeChildId(id: string): boolean {
  return id.startsWith("f:") || id.startsWith("s:") || id.startsWith("plan:") || id.startsWith("planfile:");
}

export interface ArchitectCanvasProps {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  /** Live code map for the overlay + code expansion; null while unavailable. */
  codeSummary?: CodeMapSummary | null;
  overlayOn?: boolean;
  onToggleOverlay?: (on: boolean) => void;
  /** True while editing a draft plan — canvas gets a visual draft treatment. */
  draftMode?: boolean;
  /** Active journey projection — decorates the canvas as a dataflow lens. */
  flow?: FlowProjection | null;
  /** Move intents on the active draft — rendered as ghosts/marks in expanded code. */
  moves?: readonly MoveLikeIntent[];
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** Record a symbol move intent (drag or menu) on the active/auto-created draft. */
  onRecordMove?: (payload: SymbolDragPayload, target: DropTarget) => void;
  onRecordFileMove?: (fromFile: string, toModule: string) => void;
  /** Open the standalone code map (cross-workspace level / unmapped modules). */
  onOpenFullMap?: (at?: { module: string; file?: string }) => void;
  /** External "zoom into this module (and file)" request — expands in place. */
  expandRequest?: { module: string; file?: string; nonce: number } | null;
  /** Module/file couldn't be matched to a diagram node — caller may fall back. */
  onUnresolvedExpand?: (module: string, file?: string) => void;
  showDuplicates?: boolean;
  onToggleDuplicates?: (on: boolean) => void;
}

const GHOST_STROKE = "var(--color-crystal-400)";
const FLOW_STROKE = "var(--color-crystal-400)";

/**
 * Dynamic level-of-detail. Detail grows continuously with zoom rather than at
 * a global cliff: every candidate gets its own expand threshold — a base zoom
 * plus a penalty for its distance from the viewport center — so nodes open one
 * by one as you keep zooming (center of attention first), instead of everything
 * in view ballooning at once. Each auto-expansion remembers the threshold it
 * fired at and folds up individually once zoom drops a fixed hysteresis below
 * it, which staggers the collapse the same way. Manual expansions stay put.
 */
const LOD_MODULE_EXPAND_ZOOM = 1.15;
const LOD_FILE_EXPAND_ZOOM = 1.7;
/** Extra zoom required at the viewport corner vs its center. */
const LOD_STAGGER = 0.45;
/** Auto-expansions collapse this far below the zoom that opened them. */
const LOD_HYSTERESIS = 0.3;
/** New expansions per evaluation pass — keeps a deep zoom from fetching everything at once. */
const LOD_MODULE_BUDGET = 6;
const LOD_FILE_BUDGET = 16;

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
  | { kind: "edge"; x: number; y: number; id: string }
  | { kind: "codefile"; x: number; y: number; data: FileNodeData }
  | { kind: "codesymbol"; x: number; y: number; data: SymbolNodeData };

interface CacheEntry<T> {
  gen: number;
  detail: T;
}

const NO_MOVES: MoveLikeIntent[] = [];

function CanvasInner({
  graph,
  onChange,
  codeSummary,
  overlayOn,
  onToggleOverlay,
  draftMode,
  flow,
  moves = NO_MOVES,
  onStartJourney,
  onRecordMove,
  onRecordFileMove,
  onOpenFullMap,
  expandRequest,
  onUnresolvedExpand,
  showDuplicates,
  onToggleDuplicates,
}: ArchitectCanvasProps) {
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const [defaultEdgeKind, setDefaultEdgeKind] = useState<ArchEdgeKind>("sync");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<{ x: number; y: number; id: string } | null>(null);
  const [peek, setPeek] = useState<{ module: string; label: string; file?: string } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, getNodes, getViewport } = useReactFlow();

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

  /* ---------------- live code expansion (the unified "zoom in") ---------------- */

  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);

  /** Diagram node id → module path currently expanded into live code. */
  const [codeExpanded, setCodeExpanded] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [openCode, setOpenCode] = useState<ReadonlySet<string>>(() => new Set());
  /** In-flight drag positions for code children (they snap back on drop). */
  const [dragOverrides, setDragOverrides] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    () => new Map(),
  );
  const [generation, setGeneration] = useState(0);
  const [moduleDetails, setModuleDetails] = useState<Map<string, CacheEntry<CodeModuleDetail>>>(
    () => new Map(),
  );
  const [fileDetails, setFileDetails] = useState<Map<string, CacheEntry<CodeFileDetail>>>(
    () => new Map(),
  );
  const inflight = useRef(new Set<string>());

  /** Zoom-driven LOD: what the engine expanded on its own (and may collapse again). */
  const [lodOn, setLodOn] = useState(true);
  const lodOnRef = useRef(lodOn);
  lodOnRef.current = lodOn;
  /** id/path → the staggered threshold the expansion fired at (its collapse anchor). */
  const autoExpandedNodes = useRef(new Map<string, number>());
  const autoExpandedFiles = useRef(new Map<string, number>());
  /** Manually collapsed while zoomed in — LOD leaves these alone until the next zoom-out. */
  const lodSuppressedNodes = useRef(new Set<string>());
  const lodSuppressedFiles = useRef(new Set<string>());
  const expandedRef = useRef<ReadonlyMap<string, string>>(new Map());
  const expandedFilesRef = useRef<ReadonlySet<string>>(new Set());
  expandedFilesRef.current = expandedFiles;

  // The server re-analyzes when code changes on disk — refresh expanded content.
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) setGeneration((g) => g + 1);
      }),
    [client, activeWs],
  );

  // Only nodes that still exist expand; a deleted node drops its code children.
  const expanded = useMemo(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    const m = new Map<string, string>();
    for (const [id, module] of codeExpanded) if (ids.has(id)) m.set(id, module);
    return m as ReadonlyMap<string, string>;
  }, [codeExpanded, graph]);
  expandedRef.current = expanded;

  useEffect(() => {
    for (const module of new Set(expanded.values())) {
      if (moduleDetails.get(module)?.gen === generation) continue;
      const key = `m|${module}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.module", { path: module })
        .then((detail) => setModuleDetails((m) => new Map(m).set(module, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, expanded, generation, moduleDetails]);

  useEffect(() => {
    for (const path of expandedFiles) {
      if (fileDetails.get(path)?.gen === generation) continue;
      const key = `f|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.file", { path })
        .then((detail) => setFileDetails((m) => new Map(m).set(path, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, expandedFiles, generation, fileDetails]);

  const moduleDetailMap = useMemo(() => {
    const m = new Map<string, CodeModuleDetail>();
    for (const [k, v] of moduleDetails) m.set(k, v.detail);
    return m;
  }, [moduleDetails]);
  const fileDetailMap = useMemo(() => {
    const m = new Map<string, CodeFileDetail>();
    for (const [k, v] of fileDetails) m.set(k, v.detail);
    return m;
  }, [fileDetails]);

  const codeContent = useMemo(
    () =>
      buildCodeContent({
        expanded,
        moduleDetails: moduleDetailMap,
        fileDetails: fileDetailMap,
        expandedFiles,
        openCode,
        moves,
      }),
    [expanded, moduleDetailMap, fileDetailMap, expandedFiles, openCode, moves],
  );

  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        // Collapsing something LOD opened is an override — don't reopen it.
        if (autoExpandedFiles.current.delete(path)) lodSuppressedFiles.current.add(path);
        next.delete(path);
      } else {
        lodSuppressedFiles.current.delete(path);
        next.add(path);
      }
      return next;
    });
  }, []);
  const toggleCode = useCallback((file: string, symbol: string) => {
    setOpenCode((prev) => {
      const next = new Set(prev);
      const key = codeKey(file, symbol);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const scheduleFocus = useCallback(
    (id: string) => {
      setTimeout(() => {
        void fitView({ nodes: [{ id }], padding: 0.3, duration: 350, maxZoom: 1.15 });
      }, 80);
    },
    [fitView],
  );

  /* ---------------- overlay + scene ---------------- */

  const overlay = useMemo(
    () => (overlayOn && codeSummary ? computeOverlay(graph, codeSummary) : null),
    [overlayOn, codeSummary, graph],
  );

  const rfNodes = useMemo<CanvasNode[]>(() => {
    let nodes: CanvasNode[] = toRfNodes(graph, selectedNodes);
    if (overlay) {
      nodes = nodes.map((n) => {
        const code = overlay.nodeBadges.get(n.id);
        return code ? ({ ...n, data: { ...n.data, code } } as ArchRfNode) : n;
      });
    }
    if (flow) {
      const stepOf = new Map(flow.nodeOrder.map((o) => [o.nodeId, o.firstStep]));
      nodes = nodes.map(
        (n) =>
          ({
            ...n,
            data: { ...n.data, flow: { step: stepOf.get(n.id) ?? null } },
          }) as ArchRfNode,
      );
    }
    if (expanded.size > 0) {
      // Expanded nodes render as containers sized to their live code content.
      nodes = nodes.map((n) => {
        if (!expanded.has(n.id)) return n;
        const size = codeContent.sizes.get(n.id);
        return {
          ...n,
          type: "container",
          width: size?.width,
          height: size?.height,
          zIndex: -1,
          className: "lod-grow",
          dragHandle: ".arch-container-header",
          data: {
            ...n.data,
            codeExpanded: true,
            codeLoading: codeContent.loading.has(n.id),
          },
        } as ArchRfNode;
      });
      const kids = codeContent.nodes.map((k) => {
        const o = dragOverrides.get(k.id);
        return o ? { ...k, position: o } : k;
      });
      nodes = [...nodes, ...kids];
    }
    return nodes;
  }, [graph, selectedNodes, overlay, flow, expanded, codeContent, dragOverrides]);

  const rfEdges = useMemo(() => {
    let edges = [...toRfEdges(graph, selectedEdges), ...(codeContent.edges as ArchRfEdge[])];
    if (overlay) edges = applyOverlayToEdges(edges, overlay);
    if (flow) edges = applyFlowToEdges(edges, flow);
    return edges;
  }, [graph, selectedEdges, overlay, flow, codeContent]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      let g = graphRef.current;
      let selection: Set<string> | null = null;
      let overrides: Map<string, { x: number; y: number }> | null = null;
      for (const change of changes) {
        switch (change.type) {
          case "position":
            if (!change.position) break;
            if (isCodeChildId(change.id)) {
              overrides ??= new Map(dragOverrides);
              overrides.set(change.id, change.position);
              break;
            }
            g = updateNode(g, change.id, {
              position: { x: change.position.x, y: change.position.y },
            });
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
            if (!isCodeChildId(change.id)) g = deleteNodes(g, [change.id]);
            break;
          default:
            break;
        }
      }
      if (overrides) setDragOverrides(overrides);
      if (selection) setSelectedNodes(selection);
      if (g !== graphRef.current) commit(g);
    },
    [commit, selectedNodes, dragOverrides],
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
      if (isCodeChildId(connection.source) || isCodeChildId(connection.target)) return;
      commit(opAddEdge(graphRef.current, connection.source, connection.target, defaultEdgeKind));
    },
    [commit, defaultEdgeKind],
  );

  /** Module a node maps to: explicit link, then overlay match, then name match. */
  const moduleForNode = useCallback(
    (id: string): string | null => {
      const fromExpansion = expanded.get(id);
      if (fromExpansion) return fromExpansion;
      const node = graphRef.current.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note") return null;
      if (node.codeModule) return node.codeModule;
      const badge = overlay?.nodeBadges.get(id);
      if (badge) return badge.module;
      if (codeSummary) return suggestModuleFor(node, codeSummary.modules)?.path ?? null;
      return null;
    },
    [expanded, overlay, codeSummary],
  );

  /**
   * Code anchor of a node: file-linked nodes (legacy "Expand code") resolve to
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

  /** Expand/collapse a diagram node into its module's live code. */
  const toggleNodeCode = useCallback(
    (id: string) => {
      if (codeExpanded.has(id)) {
        // Collapsing something LOD opened is an override — don't reopen it.
        if (autoExpandedNodes.current.delete(id)) lodSuppressedNodes.current.add(id);
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        return;
      }
      const node = graphRef.current.nodes.find((n) => n.id === id);
      if (!node || node.kind === "note" || isContainerKind(node.kind)) return;
      const module = moduleForNode(id);
      if (!module) return;
      lodSuppressedNodes.current.delete(id);
      setCodeExpanded((prev) => new Map(prev).set(id, module));
      scheduleFocus(id);
    },
    [codeExpanded, moduleForNode, scheduleFocus],
  );

  // External drill requests ("zoom into this module/file") expand in place.
  const expandNonce = useRef(0);
  useEffect(() => {
    if (!expandRequest || expandRequest.nonce === expandNonce.current) return;
    expandNonce.current = expandRequest.nonce;
    const { module, file } = expandRequest;
    const g = graphRef.current;
    const target =
      g.nodes.find((n) => n.codeModule === module && !isContainerKind(n.kind) && n.kind !== "note") ??
      g.nodes.find(
        (n) => !isContainerKind(n.kind) && n.kind !== "note" && !n.codeFile && moduleForNode(n.id) === module,
      );
    if (!target) {
      onUnresolvedExpand?.(module, file);
      return;
    }
    setCodeExpanded((prev) => new Map(prev).set(target.id, module));
    if (file) setExpandedFiles((prev) => (prev.has(file) ? prev : new Set(prev).add(file)));
    scheduleFocus(target.id);
  }, [expandRequest, moduleForNode, onUnresolvedExpand, scheduleFocus]);

  /* ---------------- drag / drop ---------------- */

  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode, nodes: RfNode[]) => {
      if (isCodeChildId(node.id)) {
        // Live code children: a drop on another file/module records a refactor
        // intent; either way the chip snaps back to its derived home.
        const data = node.data as MapNodeData;
        const live = getNodes() as unknown as HitTestNode[];
        const abs = absolutePositionOf(live, node.id);
        const self = live.find((n) => n.id === node.id);
        if (abs && self) {
          const w = self.measured?.width ?? self.width ?? 0;
          const h = self.measured?.height ?? self.height ?? 0;
          const center = { x: abs.x + w / 2, y: abs.y + h / 2 };
          if (data.nodeKind === "symbol" && !data.planned) {
            const target = unifiedDropTargetAt(live, center, { file: data.file, module: data.module }, moduleForNode);
            if (target) onRecordMove?.({ file: data.file, symbol: data.name }, target);
          } else if (data.nodeKind === "file" && !data.planned) {
            const target = unifiedDropTargetAt(live, center, { file: data.path, module: data.module }, moduleForNode);
            if (target && target.module !== data.module) onRecordFileMove?.(data.path, target.module);
          }
        }
        setDragOverrides(new Map());
        return;
      }
      let g = graphRef.current;
      const dragged = (nodes.length ? nodes : [node]).filter((rf) => !isCodeChildId(rf.id));
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
    [commit, getNodes, moduleForNode, onRecordMove, onRecordFileMove],
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

  /** Add a node pre-linked to a code module, expanded into live code. */
  const addModuleNodeAt = useCallback(
    (modulePath: string, moduleName: string, flowPos: { x: number; y: number }) => {
      const { graph: next, node } = opAddNode(graphRef.current, "service", moduleName, flowPos, null);
      commit(updateNode(next, node.id, { codeModule: modulePath }));
      setCodeExpanded((prev) => new Map(prev).set(node.id, modulePath));
      setSelectedNodes(new Set([node.id]));
      scheduleFocus(node.id);
    },
    [commit, scheduleFocus],
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

  /* ------------- dynamic level of detail: zoom in expands, zoom out collapses ------------- */

  /**
   * One LOD pass for a viewport. Expansion: every on-screen candidate whose
   * staggered threshold (base zoom + distance-from-center penalty) the current
   * zoom clears opens up, most central first, within the per-pass budget.
   * Collapse: each auto-expansion folds up individually once zoom drops the
   * hysteresis below the threshold it opened at — unless it would immediately
   * requalify where it sits now (it drifted toward the center since), in which
   * case its anchor is lowered instead of flickering closed and open again.
   * Only automatic expansions are ever collapsed — manual ones stay put.
   */
  const evaluateLod = useCallback(
    (vp: Viewport) => {
      if (!lodOnRef.current) return;
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const view = {
        x: -vp.x / vp.zoom,
        y: -vp.y / vp.zoom,
        w: rect.width / vp.zoom,
        h: rect.height / vp.zoom,
      };
      const live = getNodes() as unknown as HitTestNode[];
      const byId = new Map(live.map((n) => [n.id, n]));
      const boundsOf = (n: HitTestNode) => {
        let x = n.position.x;
        let y = n.position.y;
        let cur: HitTestNode | undefined = n;
        while (cur.parentId) {
          cur = byId.get(cur.parentId);
          if (!cur) break;
          x += cur.position.x;
          y += cur.position.y;
        }
        const w = n.measured?.width ?? n.width ?? 200;
        const h = n.measured?.height ?? n.height ?? 84;
        return { x, y, w, h };
      };
      const inView = (b: { x: number; y: number; w: number; h: number }): boolean =>
        b.x < view.x + view.w && b.x + b.w > view.x && b.y < view.y + view.h && b.y + b.h > view.y;
      const thresholdFor = (n: HitTestNode, base: number): number => {
        const b = boundsOf(n);
        const dx = (b.x + b.w / 2 - (view.x + view.w / 2)) / (view.w / 2);
        const dy = (b.y + b.h / 2 - (view.y + view.h / 2)) / (view.h / 2);
        return base + Math.min(Math.hypot(dx, dy), 1) * LOD_STAGGER;
      };

      const moduleCands: { id: string; threshold: number }[] = [];
      for (const n of live) {
        const data = n.data as Partial<ArchRfNode["data"]>;
        const arch = data.arch;
        if (!arch || data.codeExpanded) continue;
        if (isContainerKind(arch.kind) || arch.kind === "note" || arch.codeFile) continue;
        if (expandedRef.current.has(n.id) || autoExpandedNodes.current.has(n.id)) continue;
        if (lodSuppressedNodes.current.has(n.id)) continue;
        if (!inView(boundsOf(n))) continue;
        const threshold = thresholdFor(n, LOD_MODULE_EXPAND_ZOOM);
        if (vp.zoom >= threshold) moduleCands.push({ id: n.id, threshold });
      }
      moduleCands.sort((a, b) => a.threshold - b.threshold);
      const nodeAdds = new Map<string, string>();
      for (const c of moduleCands) {
        if (nodeAdds.size >= LOD_MODULE_BUDGET) break;
        const module = moduleForNode(c.id);
        if (!module) continue;
        nodeAdds.set(c.id, module);
        autoExpandedNodes.current.set(c.id, c.threshold);
      }
      if (nodeAdds.size > 0) {
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          for (const [id, module] of nodeAdds) next.set(id, module);
          return next;
        });
      }

      const nodeDrops: string[] = [];
      for (const [id, threshold] of autoExpandedNodes.current) {
        if (vp.zoom > threshold - LOD_HYSTERESIS) continue;
        const n = byId.get(id);
        if (n) {
          const now = thresholdFor(n, LOD_MODULE_EXPAND_ZOOM);
          if (vp.zoom >= now) {
            autoExpandedNodes.current.set(id, now);
            continue;
          }
        }
        nodeDrops.push(id);
      }
      if (nodeDrops.length > 0) {
        for (const id of nodeDrops) autoExpandedNodes.current.delete(id);
        setCodeExpanded((prev) => {
          const next = new Map(prev);
          for (const id of nodeDrops) next.delete(id);
          return next;
        });
      }
      if (vp.zoom <= LOD_MODULE_EXPAND_ZOOM - LOD_HYSTERESIS) lodSuppressedNodes.current.clear();

      const fileCands: { path: string; threshold: number }[] = [];
      for (const n of live) {
        const data = n.data as Partial<FileNodeData>;
        if (data.nodeKind !== "file" || data.planned || data.expanded || !data.path) continue;
        const path = data.path;
        if (expandedFilesRef.current.has(path) || autoExpandedFiles.current.has(path)) continue;
        if (lodSuppressedFiles.current.has(path)) continue;
        if (!inView(boundsOf(n))) continue;
        const threshold = thresholdFor(n, LOD_FILE_EXPAND_ZOOM);
        if (vp.zoom >= threshold) fileCands.push({ path, threshold });
      }
      fileCands.sort((a, b) => a.threshold - b.threshold);
      const fileAdds = fileCands.slice(0, LOD_FILE_BUDGET);
      if (fileAdds.length > 0) {
        for (const f of fileAdds) autoExpandedFiles.current.set(f.path, f.threshold);
        setExpandedFiles((prev) => {
          const next = new Set(prev);
          for (const f of fileAdds) next.add(f.path);
          return next;
        });
      }

      const fileDrops: string[] = [];
      for (const [path, threshold] of autoExpandedFiles.current) {
        if (vp.zoom > threshold - LOD_HYSTERESIS) continue;
        const n = byId.get(fileId(path));
        if (n) {
          const now = thresholdFor(n, LOD_FILE_EXPAND_ZOOM);
          if (vp.zoom >= now) {
            autoExpandedFiles.current.set(path, now);
            continue;
          }
        }
        fileDrops.push(path);
      }
      if (fileDrops.length > 0) {
        for (const path of fileDrops) autoExpandedFiles.current.delete(path);
        setExpandedFiles((prev) => {
          const next = new Set(prev);
          for (const path of fileDrops) next.delete(path);
          return next;
        });
      }
      if (vp.zoom <= LOD_FILE_EXPAND_ZOOM - LOD_HYSTERESIS) lodSuppressedFiles.current.clear();
    },
    [getNodes, moduleForNode],
  );

  // Evaluate while the gesture is in flight (rAF-throttled, and only once the
  // viewport has moved meaningfully), so detail appears as you zoom, not after.
  const lodFrame = useRef<number | null>(null);
  const lastLodVp = useRef<Viewport | null>(null);
  const onMove = useCallback(
    (_evt: unknown, vp: Viewport) => {
      if (!lodOnRef.current) return;
      const last = lastLodVp.current;
      if (
        last &&
        Math.abs(vp.zoom - last.zoom) < 0.02 &&
        Math.abs(vp.x - last.x) < 120 &&
        Math.abs(vp.y - last.y) < 120
      ) {
        return;
      }
      if (lodFrame.current != null) return;
      lodFrame.current = requestAnimationFrame(() => {
        lodFrame.current = null;
        lastLodVp.current = vp;
        evaluateLod(vp);
      });
    },
    [evaluateLod],
  );
  useEffect(
    () => () => {
      if (lodFrame.current != null) cancelAnimationFrame(lodFrame.current);
    },
    [],
  );

  // A diagram can open already zoomed in (persisted viewport) — run one pass
  // once the initial nodes have been measured.
  const lodInitDone = useRef(false);
  useEffect(() => {
    if (lodInitDone.current) return;
    const timer = setTimeout(() => {
      lodInitDone.current = true;
      const vp = graphRef.current.viewport;
      if (vp) evaluateLod(vp);
    }, 250);
    return () => clearTimeout(timer);
  }, [evaluateLod]);

  const toggleLod = useCallback(
    (on: boolean) => {
      lodOnRef.current = on;
      setLodOn(on);
      if (on) evaluateLod(getViewport());
    },
    [evaluateLod, getViewport],
  );

  const onMoveEnd = useCallback(
    (_evt: unknown, viewport: Viewport) => {
      commit({ ...graphRef.current, viewport });
      lastLodVp.current = viewport;
      evaluateLod(viewport);
    },
    [commit, evaluateLod],
  );

  const runAutoLayout = useCallback(
    (mode: "flow" | "layers" = "flow") => {
      commit(autoLayout(graphRef.current, { mode }));
      // Let the new positions render, then bring everything into view.
      requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    },
    [commit, fitView],
  );

  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (isCodeChildId(node.id)) {
        const data = node.data as MapNodeData;
        if (data.nodeKind === "file" && !data.planned) toggleFile(data.path);
        else if (data.nodeKind === "symbol" && !data.planned) toggleCode(data.file, data.name);
        return;
      }
      const ref = codeRefForNode(node.id);
      if (ref?.file) {
        requestOpenFile(ref.file);
        return;
      }
      toggleNodeCode(node.id);
    },
    [codeRefForNode, toggleFile, toggleCode, toggleNodeCode],
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
    if (isCodeChildId(node.id)) {
      const data = node.data as MapNodeData;
      if (data.nodeKind === "file") {
        setMenu({ kind: "codefile", x: evt.clientX, y: evt.clientY, data: data as FileNodeData });
      } else if (data.nodeKind === "symbol") {
        setMenu({ kind: "codesymbol", x: evt.clientX, y: evt.clientY, data: data as SymbolNodeData });
      }
      return;
    }
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

  /** Modules with code that no diagram node links to yet. */
  const unmappedModules = useMemo(() => {
    if (!codeSummary) return [];
    const linked = new Set<string>();
    for (const n of graph.nodes) if (n.codeModule) linked.add(n.codeModule);
    for (const m of expanded.values()) linked.add(m);
    return codeSummary.modules.filter((m) => m.fileCount > 0 && !linked.has(m.path));
  }, [codeSummary, graph, expanded]);

  /** "Move to module ▸" entries shared by file/symbol menus. */
  const moveTargetEntries = useCallback(
    (ownModule: string, onPick: (modulePath: string) => void): MenuEntry[] => {
      const modules = (codeSummary?.modules ?? []).filter(
        (m) => m.fileCount > 0 && m.path !== ownModule,
      );
      if (modules.length === 0) return [{ type: "heading", label: "No other modules" }];
      return modules.map<MenuEntry>((m) => ({
        type: "item",
        label: m.name,
        hint: m.path === "." ? "(root)" : m.path,
        onSelect: () => onPick(m.path),
      }));
    },
    [codeSummary],
  );

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu) return [];
    const g = graphRef.current;

    if (menu.kind === "pane") {
      return [
        {
          type: "submenu",
          label: "Add node",
          icon: Plus,
          entries: PALETTE_KINDS.map<MenuEntry>((kind) => ({
            type: "item",
            label: KIND_META[kind].label,
            icon: KIND_META[kind].icon,
            onSelect: () => addNodeAt(kind, menu.flowPos),
          })),
        },
        {
          type: "submenu",
          label: "Add code module",
          icon: Package,
          disabled: unmappedModules.length === 0,
          hint: unmappedModules.length ? String(unmappedModules.length) : "none left",
          entries: unmappedModules.map<MenuEntry>((m) => ({
            type: "item",
            label: m.name,
            hint: `${m.fileCount}f`,
            onSelect: () => addModuleNodeAt(m.path, m.name, menu.flowPos),
          })),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Auto-layout",
          icon: LayoutGrid,
          entries: [
            { type: "item", label: "Flow — top to bottom", icon: LayoutGrid, onSelect: () => runAutoLayout("flow") },
            { type: "item", label: "Layers — by role (fullstack aware)", icon: Rows3, onSelect: () => runAutoLayout("layers") },
          ],
        },
        {
          type: "item",
          label: "Fit view",
          icon: Maximize2,
          onSelect: () => void fitView({ padding: 0.15, duration: 300 }),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Open full code map",
          icon: FolderGit2,
          disabled: !onOpenFullMap,
          onSelect: () => onOpenFullMap?.(),
        },
      ];
    }

    if (menu.kind === "node") {
      const node = g.nodes.find((n) => n.id === menu.id);
      if (!node) return [];
      const ref = codeRefForNode(node.id);
      const module = moduleForNode(node.id);
      const hint = ref ? (ref.file ? ref.file.split("/").pop() : ref.module) : undefined;
      const isLiveExpanded = expanded.has(node.id);
      const canExpandLive = isLiveExpanded || (!!module && !isContainerKind(node.kind) && !node.codeFile);
      const effectiveAccent = node.accent ?? KIND_META[node.kind].defaultAccent;
      return [
        { type: "heading", label: node.label },
        {
          type: "item",
          label: "Rename",
          icon: Pencil,
          onSelect: () => setRenaming({ x: menu.x, y: menu.y, id: node.id }),
        },
        { type: "item", label: "Duplicate", icon: Copy, onSelect: () => duplicateNode(node.id) },
        { type: "separator" },
        {
          type: "item",
          label: isLiveExpanded ? "Collapse code" : "Expand code",
          icon: isLiveExpanded ? Shrink : Expand,
          disabled: !canExpandLive,
          hint: !isLiveExpanded ? (module ?? undefined) : undefined,
          onSelect: () => toggleNodeCode(node.id),
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
          label: "Open in code map",
          icon: FolderGit2,
          disabled: !ref || !onOpenFullMap,
          onSelect: () => ref && onOpenFullMap?.({ module: ref.module, file: ref.file }),
        },
        ...(hasGeneratedChildren(g, node.id)
          ? [
              {
                type: "item",
                label: "Collapse generated code",
                icon: Shrink,
                onSelect: () => commit(collapseNode(graphRef.current, node.id)),
              } satisfies MenuEntry,
            ]
          : []),
        {
          type: "submenu",
          label: "Appearance",
          icon: Paintbrush,
          entries: [
            { type: "heading", label: "Accent" },
            ...(Object.keys(ACCENT_CSS) as AccentName[]).map<MenuEntry>((name) => ({
              type: "item",
              label: name,
              checked: effectiveAccent === name,
              onSelect: () =>
                commit(updateNode(graphRef.current, node.id, { accent: name })),
            })),
            { type: "separator" },
            { type: "heading", label: "Layer" },
            {
              type: "item",
              label: "Auto (from kind)",
              checked: node.layer == null,
              onSelect: () => commit(updateNode(graphRef.current, node.id, { layer: null })),
            },
            ...(["entry", "service", "data"] as const).map<MenuEntry>((layer) => ({
              type: "item",
              label: layer,
              checked: node.layer === layer,
              onSelect: () => commit(updateNode(graphRef.current, node.id, { layer })),
            })),
          ],
        },
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

    if (menu.kind === "codefile") {
      const d = menu.data;
      return [
        { type: "heading", label: d.name },
        {
          type: "item",
          label: d.expanded ? "Collapse file" : "Expand file",
          icon: d.expanded ? Shrink : Expand,
          disabled: !!d.planned,
          onSelect: () => toggleFile(d.path),
        },
        {
          type: "item",
          label: "Open in editor",
          icon: ExternalLink,
          onSelect: () => requestOpenFile(d.path),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Move file to module",
          icon: MoveUpRight,
          disabled: !onRecordFileMove || !!d.planned,
          entries: moveTargetEntries(d.module, (m) => void onRecordFileMove?.(d.path, m)),
        },
      ];
    }

    if (menu.kind === "codesymbol") {
      const d = menu.data;
      const journeyable = d.kind !== "reexport" && d.kind !== "default";
      return [
        { type: "heading", label: d.name },
        {
          type: "item",
          label: d.codeOpen ? "Hide source" : "Show source",
          icon: Code2,
          disabled: !!d.planned,
          onSelect: () => toggleCode(d.file, d.name),
        },
        {
          type: "item",
          label: "Start journey here",
          icon: Route,
          disabled: !onStartJourney || !journeyable || !!d.planned,
          onSelect: () => onStartJourney?.({ file: d.file, symbol: d.name }),
        },
        {
          type: "item",
          label: "Open file in editor",
          icon: ExternalLink,
          onSelect: () => requestOpenFile(d.file),
        },
        { type: "separator" },
        {
          type: "submenu",
          label: "Move to module",
          icon: MoveUpRight,
          disabled: !onRecordMove || !!d.planned || d.kind === "reexport",
          entries: moveTargetEntries(d.module, (m) =>
            void onRecordMove?.({ file: d.file, symbol: d.name }, { module: m }),
          ),
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
      { type: "heading", label: edge.label || "Connection" },
      {
        type: "submenu",
        label: "Connection kind",
        icon: Pencil,
        entries: ARCH_EDGE_KINDS.map<MenuEntry>((kind) => ({
          type: "item",
          label: EDGE_KIND_STYLE[kind].label,
          checked: edge.kind === kind,
          onSelect: () => commit(updateEdge(graphRef.current, edge.id, { kind })),
        })),
      },
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
  }, [
    menu,
    codeRefForNode,
    moduleForNode,
    expanded,
    toggleNodeCode,
    toggleFile,
    toggleCode,
    onOpenFullMap,
    onStartJourney,
    onRecordMove,
    onRecordFileMove,
    moveTargetEntries,
    unmappedModules,
    addNodeAt,
    addModuleNodeAt,
    runAutoLayout,
    fitView,
    duplicateNode,
    commit,
    overlay,
  ]);

  const mapActions = useMemo<MapActions>(
    () => ({
      toggleModule: () => {},
      toggleFile,
      toggleCode,
      startJourney: onStartJourney,
      dropSymbol: (payload, target) => void onRecordMove?.(payload, target),
    }),
    [toggleFile, toggleCode, onStartJourney, onRecordMove],
  );

  const selectedNode =
    selectedNodes.size === 1 ? graph.nodes.find((n) => selectedNodes.has(n.id)) : undefined;
  const selectedEdge =
    selectedNodes.size === 0 && selectedEdges.size === 1
      ? graph.edges.find((e) => selectedEdges.has(e.id))
      : undefined;

  return (
    <MapActionsContext.Provider value={mapActions}>
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
        onMove={onMove}
        onMoveEnd={onMoveEnd}
        defaultViewport={graph.viewport ?? undefined}
        fitView={!graph.viewport}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.05}
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
          nodeColor={(n) => {
            const data = n.data as Partial<ArchRfNode["data"]>;
            return data.arch ? accentOf(data.arch) : "var(--color-crystal-500)";
          }}
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
            lodOn={lodOn}
            onToggleLod={toggleLod}
            overlayOn={overlayOn}
            onToggleOverlay={onToggleOverlay}
            showDuplicates={showDuplicates}
            onToggleDuplicates={onToggleDuplicates}
            onOpenFullMap={onOpenFullMap ? () => onOpenFullMap() : undefined}
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
    </MapActionsContext.Provider>
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

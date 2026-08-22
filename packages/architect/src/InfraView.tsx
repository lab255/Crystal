import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  NodeResizer,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge as RfEdge,
  type Node as RfNode,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  Cloud,
  Gauge,
  Globe2,
  GripVertical,
  ListChecks,
  Laptop,
  MapPin,
  Play,
  Plus,
  Pencil,
  Server,
  Skull,
  StickyNote,
  Trash2,
  Unplug,
  Waypoints,
  X,
} from "lucide-react";
import {
  ARCH_KIND_OF_CATEGORY,
  createArchNode,
  createLocalEnvironment,
  duplicateEnvironment,
  deleteDeployTarget,
  isContainerKind,
  moveDeployTarget,
  renameDeployTarget,
  removeEnvironment as removeEnvironmentFromGraph,
  topoOrderNodes,
  uid,
  upsertDeployTarget,
  updateNodePlacement,
  type ArchDeployTarget,
  type ArchEnvironment,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeExternalDep,
  type CodeMapSummary,
  type DiffMark,
  type DiffMarks,
} from "@crystal/core";
import { useNav, useNavUpdate, useSymbolMenu, useWorkspaces } from "@crystal/client";
import { Badge, Button, Dialog, DialogClose, DialogContent, EmptyState, Input, Tooltip, cn, useContextMenu, type MenuEntry } from "@crystal/ui";
import { CodeNode, type CodeNodeData, type CodeRfNode } from "./codemap/CodeNode.js";
import { InlineRename } from "./ContextMenu.js";
import { absolutePosition as graphAbsolutePosition, addNode as opAddNode, updateNode } from "./graph-ops.js";
import { DRAG_MIME, PALETTE_KINDS, Palette } from "./Palette.js";
import {
  INFRA_ZONE_KINDS,
  environmentPlacementCount,
  environmentSubgraph,
  groupLayer,
  infraGroups,
  infraTargetEdges,
  isEditableDeleteTarget,
  layerBands,
  placedEdges,
  targetMemberColumns,
  zoneNestingRejection,
  type InfraZoneKind,
} from "./infra.js";
import {
  buildInfraTargetLayoutInput,
  BAND_GAP,
  GROUP_GAP,
  infraFreeSpaceOrigin,
  infraTargetLayoutKey,
  LAYOUT_TOP,
  requestInfraTargetLayout,
  type InfraTargetLayoutInput,
  type InfraTargetLayoutOutput,
} from "./infra-layout.js";
import { detectedExternals, detectedInternalEdges, externalNodeId } from "./infra-deps.js";
import { EDGE_KIND_STYLE, KIND_META, accentOf, type ArchRfNode } from "./model.js";
import { SimActionsContext, SimEditor, SimPanel, applyTrafficToEdges, useSimActions } from "./SimPanel.js";
import {
  initialSimTickState,
  isSimKind,
  simulate,
  type SimChaos,
  type SimResult,
  type SimTickState,
  type SimTotals,
} from "./simulation.js";
import { ExportMenu } from "./ExportMenu.js";
import { exportMermaidC4Deployment } from "./export-mermaid.js";
import { RemoveTargetDialog, TargetInspector } from "./TargetInspector.js";
import { DiffCornerBadge, diffBorderStyle, diffNodeClass } from "./nodes/diff-badge.js";
import { NoteNode } from "./nodes/NoteNode.js";
import { ComposeSuggestions } from "./ComposeSuggestions.js";

/**
 * Deployment view — the C4 deployment diagram: the same architecture
 * projected per environment, with deployment nodes (targets) as boxes,
 * container/component instances sitting where they run, and the logical
 * edges connecting them across nodes (a lightweight service map).
 * Placement is drag-and-drop: drag components between targets, drag unplaced
 * components in from the sidebar, drop on empty canvas to name a new target.
 */

/** dataTransfer type for dragging an unplaced component from the sidebar. */
const INFRA_DRAG_MIME = "application/x-crystal-infra-node";

const ZONE_KINDS = INFRA_ZONE_KINDS;
type ZoneKind = InfraZoneKind;

function isZoneKind(kind: ArchNodeKind): kind is ZoneKind {
  return (ZONE_KINDS as readonly ArchNodeKind[]).includes(kind);
}

/** Palette components that can actually be placed — logical containers,
 * notes and people do not deploy to targets. */
const INFRA_COMPONENT_KINDS = PALETTE_KINDS.filter(
  (k) => !isContainerKind(k) && k !== "note" && k !== "person",
);
const INFRA_PALETTE_KINDS: readonly ArchNodeKind[] = [
  ...INFRA_COMPONENT_KINDS,
  ...ZONE_KINDS,
  "note",
];
const INFRA_PALETTE_GROUPS = [
  { label: "Components", kinds: INFRA_COMPONENT_KINDS },
  { label: "Zones", kinds: ZONE_KINDS },
  { label: "Notes", kinds: ["note"] },
] as const;

interface GroupData extends Record<string, unknown> {
  targetId: string;
  target: string;
  count: number;
  /** True when the active environment is local development. */
  local: boolean;
  /** Component ids placed on this target — the blast radius of a target outage. */
  memberIds: string[];
  /** True while the traffic simulation runs (enables the outage switch). */
  simActive: boolean;
  /** How many members are currently crashed. */
  deadCount: number;
  /** Synthetic container for detected external services — not a drop target. */
  detected?: boolean;
}
type GroupRfNode = RfNode<GroupData>;

const InfraGroupNode = memo(function InfraGroupNode({ data }: NodeProps<GroupRfNode>) {
  const Icon = data.detected ? Waypoints : data.local ? Laptop : Cloud;
  const actions = useSimActions();
  const allDead = data.count > 0 && data.deadCount === data.count;
  return (
    <div
      className={cn(
        "h-full w-full rounded-xl border border-dashed bg-surface-1/60",
        allDead ? "border-danger/50" : "border-edge-strong",
      )}
    >
      <div className="infra-target-header flex cursor-grab items-center gap-1.5 border-b border-dashed border-edge px-2.5 py-1.5 active:cursor-grabbing">
        <Icon className={cn("h-3 w-3 shrink-0", allDead ? "text-danger" : "text-crystal-300")} />
        <span className="truncate text-[10.5px] font-semibold text-ink">{data.target}</span>
        <span className="shrink-0 text-[9px] text-ink-faint">
          {data.detected ? "[External]" : "[Deployment Node]"}
        </span>
        <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
          {data.count}
        </span>
        {data.simActive && data.count > 0 ? (
          <Tooltip
            content={
              allDead
                ? "Target down — click to restore everything on it"
                : `Chaos: outage — crash all ${data.count} components on this target`
            }
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                actions?.toggleKillTarget(data.memberIds);
              }}
              className={cn(
                "nodrag flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full transition-colors",
                allDead
                  ? "bg-danger text-white"
                  : data.deadCount > 0
                    ? "bg-danger/20 text-danger hover:bg-danger/30"
                    : "bg-surface-3 text-ink-faint hover:bg-danger/20 hover:text-danger",
              )}
              aria-label={allDead ? `Restore target ${data.target}` : `Take target ${data.target} down`}
              aria-pressed={allDead}
            >
              {allDead ? <Skull className="h-2.5 w-2.5" /> : <Unplug className="h-2.5 w-2.5" />}
            </button>
          </Tooltip>
        ) : null}
      </div>
      {/* Handles keep react-flow quiet; edges attach to child nodes. */}
      <Handle type="target" position={Position.Top} className="!invisible" />
      <Handle type="source" position={Position.Bottom} className="!invisible" />
    </div>
  );
});

interface ZoneData extends Record<string, unknown> {
  zoneId: string;
  kind: ZoneKind;
  label: string;
  accent: string;
}
type ZoneRfNode = RfNode<ZoneData>;

interface ZoneActions {
  resize: (
    id: string,
    position: { x: number; y: number },
    size: { width: number; height: number },
  ) => void;
  remove: (id: string) => void;
}

const ZoneActionsContext = createContext<ZoneActions | null>(null);

const ZoneNode = memo(function ZoneNode({ data, selected }: NodeProps<ZoneRfNode>) {
  const actions = useContext(ZoneActionsContext);
  const meta = KIND_META[data.kind];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "relative h-full w-full rounded-xl border-[1.5px] bg-surface-1/45",
        selected ? "border-crystal-400" : "border-edge-strong",
      )}
      style={{
        background: `color-mix(in srgb, ${data.accent} ${data.kind === "securitygroup" ? 9 : 5}%, var(--color-surface-1) 55%)`,
        borderColor: selected ? undefined : `color-mix(in srgb, ${data.accent} 55%, var(--color-edge-strong))`,
        borderStyle: data.kind === "securitygroup" ? "dotted" : "dashed",
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={200}
        lineClassName="!border-crystal-400/60"
        handleClassName="!h-2 !w-2 !rounded-sm !border-none !bg-crystal-400"
        onResizeEnd={(_event, params) =>
          actions?.resize(
            data.zoneId,
            { x: params.x, y: params.y },
            { width: params.width, height: params.height },
          )
        }
      />
      <div
        className="infra-zone-header flex cursor-grab items-center gap-1.5 rounded-t-[11px] border-b border-dashed border-edge px-2.5 py-1.5 active:cursor-grabbing"
        style={{ background: `color-mix(in srgb, ${data.accent} 11%, transparent)` }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: data.accent }} />
        <span className="truncate text-xs font-semibold text-ink">{data.label}</span>
        <span className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-ink-faint">
          {meta.label}
        </span>
        <button
          type="button"
          className="nodrag flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-active hover:text-danger"
          onClick={(event) => {
            event.stopPropagation();
            actions?.remove(data.zoneId);
          }}
          aria-label={`Delete zone ${data.label}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
});

interface BandLabelData extends Record<string, unknown> {
  label: string;
}
type BandLabelRfNode = RfNode<BandLabelData>;

const BandLabelNode = memo(function BandLabelNode({ data }: NodeProps<BandLabelRfNode>) {
  return (
    <div className="select-none text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
      {data.label}
    </div>
  );
});

interface ExternalData extends Record<string, unknown> {
  dep: CodeExternalDep;
  kind: ArchNodeKind;
  envName: string;
  diff?: DiffMark;
}
type ExternalRfNode = RfNode<ExternalData>;
const AdoptExternalContext = createContext<((dep: CodeExternalDep, x: number, y: number) => void) | null>(null);
const ExternalNode = memo(function ExternalNode({ data }: NodeProps<ExternalRfNode>) {
  const adopt = useContext(AdoptExternalContext);
  const Icon = KIND_META[data.kind].icon;
  return (
    <div
      className={cn("group relative h-full w-full rounded-lg border border-edge bg-surface-2 p-2 text-ink shadow-sm", diffNodeClass(data.diff))}
      style={diffBorderStyle(data.diff)}
    >
      {data.diff ? <DiffCornerBadge mark={data.diff} /> : null}
      <div className="flex items-center gap-2"><Icon className="h-3.5 w-3.5" /><span className="truncate text-xs font-medium">{data.dep.name}</span></div>
      <div className="mt-1 truncate text-[10px] text-ink-faint">{data.dep.packages.slice(0, 3).join(", ")}</div>
      <button type="button" className="nodrag absolute bottom-1.5 right-1.5 rounded-md border border-edge bg-surface-3 px-1.5 py-0.5 text-[9px] text-ink-muted opacity-0 hover:text-ink group-hover:opacity-100" onClick={(event) => { event.stopPropagation(); adopt?.(data.dep, event.clientX, event.clientY); }}>Place in {data.envName}</button>
    </div>
  );
});

const nodeTypes = {
  zone: ZoneNode,
  infragroup: InfraGroupNode,
  code: CodeNode,
  bandlabel: BandLabelNode,
  external: ExternalNode,
  note: NoteNode,
};
type NoteRfNode = ArchRfNode & { type: "note" };
type InfraRfNode = ZoneRfNode | GroupRfNode | CodeRfNode | BandLabelRfNode | ExternalRfNode | NoteRfNode;

const CELL_W = 190;
const CELL_H = 58;
/** Taller cells while simulating — cards grow a live stats strip. */
const CELL_H_SIM = 104;
const CELL_GAP = 12;
/** Simulation tick cadence — slow enough to read, fast enough to feel live. */
const SIM_TICK_MS = 600;
/** Ticks of totals kept for the control-bar sparkline (~30s of history). */
const SIM_HISTORY_TICKS = 48;
const GROUP_PAD = 14;
const GROUP_HEADER = 32;

function zoneSize(kind: ZoneKind): { width: number; height: number } {
  if (kind === "vpc") return { width: 760, height: 520 };
  if (kind === "subnet") return { width: 560, height: 360 };
  return { width: 500, height: 300 };
}

/** Absolute flow-space position for a live react-flow node at any nesting depth. */
function rfAbsolutePosition(nodes: readonly RfNode[], nodeId: string): { x: number; y: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let node = byId.get(nodeId);
  let x = 0;
  let y = 0;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    x += node.position.x;
    y += node.position.y;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return { x, y };
}

function rfNestingDepth(nodes: readonly RfNode[], nodeId: string): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let node = byId.get(nodeId);
  let depth = 0;
  while (node?.parentId && !seen.has(node.id)) {
    seen.add(node.id);
    depth++;
    node = byId.get(node.parentId);
  }
  return depth;
}

export function useInfraTargetLayout(input: InfraTargetLayoutInput | null): InfraTargetLayoutOutput | null {
  const [output, setOutput] = useState<InfraTargetLayoutOutput | null>(null);
  const requestId = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  useEffect(() => () => {
    requestId.current++;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);
  const contentKey = input ? infraTargetLayoutKey(input) : null;
  useEffect(() => {
    if (!input) {
      setOutput(null);
      return;
    }
    const reqId = ++requestId.current;
    let cancelled = false;
    const publish = (next: InfraTargetLayoutOutput) => {
      if (!cancelled && requestId.current === reqId) setOutput(next);
    };
    const compute = (worker: Worker | null) => void requestInfraTargetLayout(input, worker, reqId).then(publish, () => undefined);
    if (typeof Worker === "undefined") {
      compute(null);
    } else {
      try {
        const worker = workerRef.current ?? new Worker(new URL("./infra-layout.worker.ts", import.meta.url), { type: "module" });
        workerRef.current = worker;
        compute(worker);
      } catch {
        workerRef.current?.terminate();
        workerRef.current = null;
        compute(null);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [contentKey]);
  return output;
}

/** Keep a pinned card inside its container — clear of the left edge and header. */
function clampPin(at: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(Math.max(4, at.x)),
    y: Math.round(Math.max(GROUP_HEADER + 4, at.y)),
  };
}

/** Remove only the zone itself, preserving nested zones and assigned targets at root. */
export function deleteZoneFromGraph(graph: ArchitectureGraph, zoneId: string): ArchitectureGraph {
  const zone = graph.nodes.find((node) => node.id === zoneId && isZoneKind(node.kind));
  if (!zone) return graph;
  const zoneAbs = graphAbsolutePosition(graph, zoneId);
  return {
    ...graph,
    nodes: graph.nodes
      .filter((node) => node.id !== zoneId)
      .map((node) =>
        node.parentId === zoneId
          ? { ...node, parentId: null, position: graphAbsolutePosition(graph, node.id) }
          : node,
      ),
    edges: graph.edges.filter((edge) => edge.source !== zoneId && edge.target !== zoneId),
    environments: graph.environments.map((environment) => ({
      ...environment,
      ...(environment.infraNodeIds ? { infraNodeIds: environment.infraNodeIds.filter((id) => id !== zoneId) } : {}),
      targets: (environment.targets ?? []).map((target) => target.zone === zoneId
        ? { ...target, x: zoneAbs.x + (target.x ?? 0), y: zoneAbs.y + (target.y ?? 0), zone: undefined }
        : target),
    })),
  };
}

export function removeInfraNodeFromEnvironment(graph: ArchitectureGraph, envId: string, nodeId: string): ArchitectureGraph {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || (!isZoneKind(node.kind) && node.kind !== "note")) return graph;
  const zoneAbs = graphAbsolutePosition(graph, nodeId);
  const scoped = {
    ...graph,
    environments: graph.environments.map((environment) => environment.id === envId
      ? {
          ...environment,
          infraNodeIds: (environment.infraNodeIds ?? []).filter((id) => id !== nodeId),
          targets: isZoneKind(node.kind) ? (environment.targets ?? []).map((target) => target.zone === nodeId
            ? { ...target, x: zoneAbs.x + (target.x ?? 0), y: zoneAbs.y + (target.y ?? 0), zone: undefined }
            : target) : environment.targets,
        }
      : environment),
  };
  if (scoped.environments.some((environment) => environment.infraNodeIds?.includes(nodeId))) return scoped;
  if (isZoneKind(node.kind)) return deleteZoneFromGraph(scoped, nodeId);
  return {
    ...scoped,
    nodes: scoped.nodes.filter((candidate) => candidate.id !== nodeId),
    edges: scoped.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
  };
}

/** Pending "name a new deployment target" prompt from a drop on empty canvas. */
interface TargetPrompt {
  /** Screen coordinates for the floating input. */
  x: number;
  y: number;
  nodeId: string;
  /** Palette nodes are minted against the live graph only when the prompt settles. */
  kind?: ArchNodeKind;
  /** Detected externals are likewise materialized against the live graph at commit. */
  externalDep?: CodeExternalDep;
}

export function InfraView(props: {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  /** Live code map — powers the detected-dependency overlay (service map). */
  summary?: CodeMapSummary | null;
  /** Ref-review marks (vs <ref>) keyed by node/edge id — drift tints. */
  diffMarks?: DiffMarks | null;
}) {
  return (
    <ReactFlowProvider>
      <InfraInner {...props} />
    </ReactFlowProvider>
  );
}

function InfraInner({
  graph,
  onChange,
  summary = null,
  diffMarks = null,
}: {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  summary?: CodeMapSummary | null;
  diffMarks?: DiffMarks | null;
}) {
  const nav = useNavUpdate();
  const navEnv = useNav((link) => link.architect?.env) ?? null;
  const navSelection = useNav((link) => link.architect?.sel) ?? null;
  const parsedSelection = useMemo(() => {
    if (!navSelection) return { kind: "node" as const, id: null };
    const match = /^(node|target|zone):(.+)$/.exec(navSelection);
    return match
      ? { kind: match[1] as "node" | "target" | "zone", id: match[2]! }
      : { kind: "node" as const, id: navSelection };
  }, [navSelection]);
  const selectedId = parsedSelection.id;
  const select = useCallback((kind: "node" | "target" | "zone", id: string | null) => {
    nav({ architect: { sel: id ? `${kind}:${id}` : null } });
  }, [nav]);
  const [addingEnv, setAddingEnv] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvKind, setNewEnvKind] = useState<ArchEnvironment["kind"]>("cloud");
  const [removeEnvId, setRemoveEnvId] = useState<string | null>(null);
  const [confirmTargetId, setConfirmTargetId] = useState<string | null>(null);
  const [renamePrompt, setRenamePrompt] = useState<{ id: string; kind: "node" | "target"; x: number; y: number } | null>(null);
  const [targetPrompt, setTargetPrompt] = useState<TargetPrompt | null>(null);
  const [externalPlacement, setExternalPlacement] = useState<TargetPrompt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { fitView, screenToFlowPosition } = useReactFlow();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const updateNodeInternals = useUpdateNodeInternals();
  const canvasRef = useRef<HTMLDivElement>(null);
  const workspaceName = useWorkspaces(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeId)?.name ?? "workspace",
  );
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 760 });

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const ratio = rect.height > 0 ? rect.width / rect.height : 1;
      const quantized = Math.round(Math.max(0.5, Math.min(3, ratio)) * 4) / 4;
      const next = { width: Math.round(rect.height * quantized), height: Math.round(rect.height) };
      setCanvasSize((previous) => previous.width === next.width && previous.height === next.height ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph.environments.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keep a ref of the latest graph so the sim tick always reads fresh state.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const activeEnv =
    graph.environments.find((e) => e.id === navEnv) ??
    graph.environments.find((e) => e.name.toLowerCase() === navEnv?.toLowerCase()) ??
    graph.environments[0] ??
    null;
  const deploymentMermaid = useMemo(
    () => activeEnv ? exportMermaidC4Deployment(graph, activeEnv.id) : null,
    [graph, activeEnv?.id],
  );

  useEffect(() => {
    if (activeEnv && navEnv !== activeEnv.id) nav({ architect: { env: activeEnv.id } });
  }, [activeEnv, navEnv, nav]);

  const resizeZone = useCallback(
    (
      id: string,
      position: { x: number; y: number },
      size: { width: number; height: number },
    ) => {
      onChange(updateNode(graphRef.current, id, { position, size }));
    },
    [onChange],
  );
  const removeZone = useCallback(
    (id: string) => {
      if (!activeEnv) return;
      onChange(removeInfraNodeFromEnvironment(graphRef.current, activeEnv.id, id));
      if (selectedId === id) select("zone", null);
    },
    [onChange, select, selectedId, activeEnv],
  );
  const removeInfraNode = useCallback(
    (id: string) => {
      if (!activeEnv) return;
      onChange(removeInfraNodeFromEnvironment(graphRef.current, activeEnv.id, id));
      if (selectedId === id) select("node", null);
    },
    [onChange, select, selectedId, activeEnv],
  );
  const zoneActions = useMemo(
    () => ({ resize: resizeZone, remove: removeZone }),
    [resizeZone, removeZone],
  );

  /* ---- traffic simulation (runs over the whole logical graph; the map
     decorates whatever is placed in the active environment) ---- */
  const [simOn, setSimOn] = useState(false);
  const [simIngress, setSimIngress] = useState(100);
  const [simChaos, setSimChaos] = useState<SimChaos>({
    spike: false,
    cacheMissStorm: false,
    retryStorm: false,
  });
  const [simKilled, setSimKilled] = useState<ReadonlySet<string>>(() => new Set());
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simHistory, setSimHistory] = useState<SimTotals[]>([]);
  const simState = useRef<SimTickState>(initialSimTickState());

  useEffect(() => {
    if (!simOn) {
      setSimResult(null);
      setSimHistory([]);
      simState.current = initialSimTickState();
      return;
    }
    const tick = () => {
      // Small wobble makes the numbers feel live without changing the story.
      const jitter = 0.92 + Math.random() * 0.16;
      const result = simulate(environmentSubgraph(graphRef.current, activeEnv?.id ?? ""), {
        ingressRps: simIngress * jitter,
        chaos: simChaos,
        killed: simKilled,
        state: simState.current,
      });
      simState.current = result.state;
      setSimResult(result);
      setSimHistory((prev) => [...prev.slice(-(SIM_HISTORY_TICKS - 1)), result.totals]);
    };
    tick();
    const handle = setInterval(tick, SIM_TICK_MS);
    return () => clearInterval(handle);
  }, [simOn, simIngress, simChaos, simKilled, activeEnv?.id]);

  const toggleSimKill = useCallback((id: string) => {
    setSimKilled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleSimKillTarget = useCallback((ids: string[]) => {
    setSimKilled((prev) => {
      // Restore only when the whole target is already down; otherwise finish it.
      const allDead = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (allDead) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);
  const simActions = useMemo(
    () => ({ toggleKill: toggleSimKill, toggleKillTarget: toggleSimKillTarget }),
    [toggleSimKill, toggleSimKillTarget],
  );

  const zones = useMemo(
    () => {
      const visible = new Set(activeEnv?.infraNodeIds ?? []);
      return topoOrderNodes(graph).filter((node) => isZoneKind(node.kind) && visible.has(node.id));
    },
    [graph, activeEnv],
  );
  const notes = useMemo(() => {
    const visible = new Set(activeEnv?.infraNodeIds ?? []);
    return graph.nodes.filter((node) => node.kind === "note" && visible.has(node.id));
  }, [graph, activeEnv]);

  const { groups, unplaced } = useMemo(
    () => infraGroups(graph, activeEnv?.id ?? ""),
    [graph, activeEnv?.id],
  );
  const targets = useMemo(() => activeEnv?.targets ?? [], [activeEnv]);

  /* ---- detected dependencies (service-map overlay from the live code map) ---- */
  const [depsOn, setDepsOn] = useState(true);
  const depsAvailable =
    summary != null && (summary.deps.length > 0 || (summary.externals?.length ?? 0) > 0);
  const detected = useMemo(() => {
    if (!depsOn || !summary || !activeEnv) return { externals: [], internal: [] };
    return {
      externals: detectedExternals(graph, activeEnv.id, summary).filter(({ dep }) =>
        !graph.nodes.find((node) => node.id === externalNodeId(dep))?.placements[activeEnv.id]?.targetId),
      internal: detectedInternalEdges(graph, activeEnv.id, summary),
    };
  }, [depsOn, summary, graph, activeEnv]);

  const addEnvironment = () => {
    const name = newEnvName.trim();
    if (!name) return;
    const env: ArchEnvironment = { id: uid("env"), name, kind: newEnvKind, infraNodeIds: [] };
    onChange({ ...graph, environments: [...graph.environments, env] });
    nav({ architect: { env: env.id } });
    setNewEnvName("");
    setAddingEnv(false);
  };

  const addLocalEnvironment = () => {
    const env = { ...createLocalEnvironment(), infraNodeIds: [] };
    onChange({ ...graph, environments: [...graph.environments, env] });
    nav({ architect: { env: env.id } });
  };

  const confirmRemoveEnvironment = () => {
    if (!removeEnvId) return;
    onChange(removeEnvironmentFromGraph(graph, removeEnvId));
    if (activeEnv?.id === removeEnvId) nav({ architect: { env: null, sel: null } });
    setRemoveEnvId(null);
  };

  const targetGeometries = useMemo(() => {
    if (!activeEnv) return [];
    const cellH = simOn ? CELL_H_SIM : CELL_H;
    return groups.map((group) => {
      const members = group.nodes.map((node) => {
        const placement = node.placements[activeEnv.id];
        const pinned = placement?.x != null && placement.y != null
          ? { x: placement.x, y: placement.y }
          : null;
        return { node, pinned };
      });
      const packedCount = members.filter((member) => !member.pinned).length;
      const viewportAspect = Math.max(0.75, canvasSize.width / Math.max(canvasSize.height, 1));
      const cols = targetMemberColumns(packedCount || 1, viewportAspect, { width: CELL_W, height: cellH });
      const rows = Math.ceil(packedCount / cols);
      let width = GROUP_PAD * 2 + cols * CELL_W + (cols - 1) * CELL_GAP;
      let height = GROUP_HEADER + GROUP_PAD + rows * cellH + Math.max(rows - 1, 0) * CELL_GAP + GROUP_PAD;
      for (const member of members) {
        if (!member.pinned) continue;
        width = Math.max(width, member.pinned.x + CELL_W + GROUP_PAD);
        height = Math.max(height, member.pinned.y + cellH + GROUP_PAD);
      }
      return { group, members, cols, width, height };
    });
  }, [activeEnv, groups, simOn, canvasSize]);

  const infraLayoutInput = useMemo(() => {
    if (!activeEnv) return null;
    const targetLayout = new Map((activeEnv.targets ?? []).map((target) => [target.id, target]));
    const targets = [];
    for (const geometry of targetGeometries) {
      const pin = targetLayout.get(geometry.group.target.id);
      if (pin?.x != null && pin.y != null) {
        continue;
      }
      targets.push({
        id: geometry.group.target.id,
        width: geometry.width,
        height: geometry.height,
        layer: groupLayer(geometry.group),
      });
    }
    return buildInfraTargetLayoutInput({
      targets,
      edges: infraTargetEdges(graph, activeEnv.id),
      aspectRatio: canvasSize.width / Math.max(canvasSize.height, 1),
      direction: "DOWN",
    });
  }, [activeEnv, graph, targetGeometries, canvasSize]);
  const infraLayout = useInfraTargetLayout(infraLayoutInput);

  /**
   * Place (or re-place) a component on a target, keeping any runtime detail.
   * `at` pins the card at a parent-relative position inside the target's
   * container; omitted, the grid packer owns the slot.
   */
  const placeOn = useCallback(
    (nodeId: string, target: ArchDeployTarget, at?: { x: number; y: number }, sourceGraph = graphRef.current) => {
      if (!activeEnv) return;
      const node = sourceGraph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const runtime = node.placements[activeEnv.id]?.runtime ?? "";
      const pin = at ? clampPin(at) : {};
      onChange(updateNodePlacement(sourceGraph, nodeId, activeEnv.id, { targetId: target.id, target: target.name, runtime, ...pin }));
      select("node", nodeId);
    },
    [onChange, activeEnv, select],
  );

  const scene = useMemo(() => {
    if (!activeEnv) return { nodes: [] as InfraRfNode[], edges: [] as RfEdge[] };

    const zoneNodes: ZoneRfNode[] = [];
    const noteNodes: NoteRfNode[] = [];
    const bandNodes: BandLabelRfNode[] = [];
    const targetNodes: GroupRfNode[] = [];
    const componentNodes: (CodeRfNode | ExternalRfNode)[] = [];
    const isLocal = activeEnv.kind === "local";
    const cellH = simOn ? CELL_H_SIM : CELL_H;
    const targetLayout = new Map((activeEnv.targets ?? []).map((target) => [target.id, target]));
    const zoneIds = new Set(zones.map((zone) => zone.id));
    let rootBottom = LAYOUT_TOP;

    // Deployment zones are manual architecture nodes. The core topological
    // order keeps parents before nested subnet/security-group children.
    for (const zone of zones) {
      if (!isZoneKind(zone.kind)) continue;
      const parentId = zone.parentId && zoneIds.has(zone.parentId) ? zone.parentId : undefined;
      const size = zone.size ?? zoneSize(zone.kind);
      const position = parentId ? zone.position : graphAbsolutePosition(graph, zone.id);
      zoneNodes.push({
        id: zone.id,
        type: "zone",
        ...(parentId ? { parentId } : {}),
        position,
        width: size.width,
        height: size.height,
        zIndex: -2,
        dragHandle: ".infra-zone-header",
        selected: selectedId === zone.id,
        data: {
          zoneId: zone.id,
          kind: zone.kind,
          label: zone.label,
          accent: accentOf(zone),
        },
      });
      const abs = graphAbsolutePosition(graph, zone.id);
      rootBottom = Math.max(rootBottom, abs.y + size.height);
    }

    for (const note of notes) {
      noteNodes.push({
        id: note.id,
        type: "note",
        position: graphAbsolutePosition(graph, note.id),
        draggable: true,
        selectable: true,
        deletable: false,
        selected: parsedSelection.kind === "node" && selectedId === note.id,
        data: { arch: note, diff: diffMarks?.[note.id] },
      });
    }

    const appendTarget = (
      geometry: (typeof targetGeometries)[number],
      position: { x: number; y: number },
      parentId?: string,
    ) => {
      const { group, members, cols, width, height } = geometry;
      const groupId = `target:${group.target.id}`;
      targetNodes.push({
        id: groupId,
        type: "infragroup",
        ...(parentId ? { parentId } : {}),
        position,
        width,
        height,
        zIndex: -1,
        draggable: true,
        selectable: true,
        selected: parsedSelection.kind === "target" && selectedId === group.target.id,
        deletable: false,
        dragHandle: ".infra-target-header",
        data: {
          targetId: group.target.id,
          target: group.target.name,
          count: group.nodes.length,
          local: isLocal,
          memberIds: group.nodes.map((node) => node.id),
          simActive: simOn,
          deadCount: 0,
        },
      });
      const parentAbs = parentId
        ? graphAbsolutePosition(graph, parentId)
        : { x: 0, y: 0 };
      rootBottom = Math.max(rootBottom, parentAbs.y + position.y + height);
      let slot = 0;
      for (const { node, pinned } of members) {
        const col = slot % cols;
        const row = Math.floor(slot / cols);
        if (!pinned) slot++;
        componentNodes.push({
          id: node.id,
          type: "code",
          parentId: groupId,
          draggable: true,
          deletable: false,
          position: pinned ?? {
            x: GROUP_PAD + col * (CELL_W + CELL_GAP),
            y: GROUP_HEADER + GROUP_PAD + row * (cellH + CELL_GAP),
          },
          selected: node.id === selectedId,
          data: {
            title: node.label,
            subtitle: node.placements[activeEnv.id]?.runtime || KIND_META[node.kind].label,
            accent: accentOf(node),
            icon: KIND_META[node.kind].icon,
            diff: diffMarks?.[node.id],
          },
        });
      }
    };

    // A pin opts a target out of fallback packing. Its coordinates are
    // parent-relative when it names a live zone.
    for (const group of groups) {
      const pin = targetLayout.get(group.target.id);
      if (pin?.x == null || pin.y == null) continue;
      const parentId = pin.zone && zoneIds.has(pin.zone) ? pin.zone : undefined;
      const geometry = targetGeometries.find((item) => item.group.target.id === group.target.id);
      if (geometry) appendTarget(geometry, { x: pin.x, y: pin.y }, parentId);
    }

    // Only free target rectangles enter ELK. Keep a deterministic first paint
    // (and fill any newly-added ids) while the asynchronous solve is pending.
    const fallbackBands = layerBands(groups)
      .map((band) => ({
        ...band,
        groups: band.groups.filter((group) => {
          const target = targetLayout.get(group.target.id);
          return target?.x == null || target.y == null;
        }),
      }))
      .filter((band) => band.groups.length > 0);
    const usableWidth = Math.max(680, canvasSize.width - 220);
    const solved = new Map(infraLayout?.positions.map((position) => [position.id, position]) ?? []);
    const occupied = zoneNodes
      .filter((node) => !node.parentId)
      .map((node) => ({ x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 }));
    for (const geometry of targetGeometries) {
      const pin = targetLayout.get(geometry.group.target.id);
      if (pin?.x != null && pin.y != null && (!pin.zone || !zoneIds.has(pin.zone))) {
        occupied.push({ x: pin.x, y: pin.y, width: geometry.width, height: geometry.height });
      }
    }
    const origin = infraFreeSpaceOrigin(occupied, 48, LAYOUT_TOP, BAND_GAP);
    let bandY = origin.y;
    for (const band of fallbackBands) {
      const geometries = band.groups.flatMap((group) => {
        const geometry = targetGeometries.find((item) => item.group.target.id === group.target.id);
        return geometry ? [geometry] : [];
      });
      const laidOut = geometries.map((geometry) => ({ geometry, position: solved.get(geometry.group.target.id) }));
      const solvedInBand = laidOut.filter((item) => item.position);
      const labelY = solvedInBand.length > 0
        ? origin.y + Math.min(...solvedInBand.map((item) => item.position!.y)) - 24
        : bandY - 24;
      bandNodes.push({
        id: `band:${band.layer ?? "other"}`,
        type: "bandlabel",
        position: { x: 24, y: labelY },
        draggable: false,
        selectable: false,
        deletable: false,
        data: { label: band.layer ?? "other" },
      });
      let cursorX = origin.x;
      let rowY = bandY;
      let fallbackBottom = bandY;
      for (const { geometry, position } of laidOut) {
        if (!position && cursorX > origin.x && cursorX + geometry.width > origin.x + usableWidth) {
          cursorX = origin.x;
          rowY = fallbackBottom + GROUP_GAP;
        }
        const targetPosition = position
          ? { x: origin.x + position.x, y: origin.y + position.y }
          : { x: cursorX, y: rowY };
        appendTarget(geometry, targetPosition);
        if (!position) {
          cursorX += geometry.width + GROUP_GAP;
          fallbackBottom = Math.max(fallbackBottom, targetPosition.y + geometry.height);
        }
        fallbackBottom = Math.max(fallbackBottom, targetPosition.y + geometry.height);
      }
      bandY = fallbackBottom + BAND_GAP;
    }

    // Detected external services follow every real root/zone arrangement so
    // they never cover a user pin.
    if (detected.externals.length > 0) {
      const externalY = Math.max(bandY, rootBottom + BAND_GAP);
      bandNodes.push({
        id: "band:external",
        type: "bandlabel",
        position: { x: 24, y: externalY - 24 },
        draggable: false,
        selectable: false,
        deletable: false,
        data: { label: "external" },
      });
      const n = detected.externals.length;
      const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))));
      const rows = Math.ceil(n / cols);
      const width = GROUP_PAD * 2 + cols * CELL_W + (cols - 1) * CELL_GAP;
      const height = GROUP_HEADER + GROUP_PAD + rows * CELL_H + (rows - 1) * CELL_GAP + GROUP_PAD;
      const groupId = "target:__detected__";
      targetNodes.push({
        id: groupId,
        type: "infragroup",
        position: { x: Math.max(48, (usableWidth - width) / 2), y: externalY },
        width,
        height,
        zIndex: -1,
        draggable: false,
        selectable: false,
        deletable: false,
        data: {
          targetId: "__detected__",
          target: "Detected from code",
          count: n,
          local: isLocal,
          memberIds: [],
          simActive: false,
          deadCount: 0,
          detected: true,
        },
      });
      detected.externals.forEach(({ dep }, j) => {
        const kind = ARCH_KIND_OF_CATEGORY[dep.category];
        componentNodes.push({
          id: externalNodeId(dep),
          type: "external",
          parentId: groupId,
          draggable: false,
          selectable: false,
          deletable: false,
          position: {
            x: GROUP_PAD + (j % cols) * (CELL_W + CELL_GAP),
            y: GROUP_HEADER + GROUP_PAD + Math.floor(j / cols) * (CELL_H + CELL_GAP),
          },
          data: {
            dep,
            kind,
            envName: activeEnv.name,
            diff: diffMarks?.[externalNodeId(dep)],
          },
        });
      });
    }

    // React-flow requires every parent before its children.
    const nodes: InfraRfNode[] = [
      ...zoneNodes,
      ...noteNodes,
      ...bandNodes,
      ...targetNodes,
      ...componentNodes,
    ];

    const edges: RfEdge[] = placedEdges(graph, activeEnv.id).map((e) => {
      const style = EDGE_KIND_STYLE[e.kind];
      const mark = diffMarks?.[e.id];
      const stroke = mark
        ? mark.kind === "added"
          ? "var(--color-ok)"
          : mark.kind === "removed"
            ? "var(--color-danger)"
            : "var(--color-warn)"
        : style.stroke;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: mark?.detail ?? (e.label || undefined),
        style: { stroke, strokeWidth: mark ? 2 : 1.4, strokeDasharray: style.dash, opacity: 0.9 },
        labelStyle: { fill: "var(--color-ink-muted)", fontSize: 9 },
        labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
      };
    });

    // Detected edges render dashed and muted — the code's testimony, visually
    // distinct from the user's drawn arrows.
    const detectedStyle = {
      stroke: "var(--color-accent-slate)",
      strokeWidth: 1.2,
      strokeDasharray: "3 3",
      opacity: 0.6,
    };
    const detectedEdge = (id: string, source: string, target: string, weight: number): RfEdge => ({
      id,
      source,
      target,
      label: `×${weight}`,
      style: detectedStyle,
      labelStyle: { fill: "var(--color-ink-faint)", fontSize: 8.5 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.85 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--color-accent-slate)",
        width: 12,
        height: 12,
      },
    });
    for (const e of detected.internal) {
      edges.push(detectedEdge(`det:${e.source}->${e.target}`, e.source, e.target, e.weight));
    }
    for (const { dep, clients } of detected.externals) {
      for (const client of clients) {
        edges.push(
          detectedEdge(
            `det:${client.nodeId}->${externalNodeId(dep)}`,
            client.nodeId,
            externalNodeId(dep),
            client.weight,
          ),
        );
      }
    }
    return { nodes, edges };
  }, [graph, groups, zones, notes, activeEnv, selectedId, parsedSelection.kind, simOn, detected, diffMarks, canvasSize, targetGeometries, infraLayout, infraLayoutInput]);

  // Drag needs live node state; the derived scene resets it (drop snaps back
  // unless the placement actually changed, in which case the scene moves it).
  const [nodes, setNodes, applyNodesChange] = useNodesState<InfraRfNode>(scene.nodes);
  useEffect(() => {
    setNodes(scene.nodes);
    const targetIds = scene.nodes
      .filter((node) => node.type === "infragroup")
      .map((node) => node.id);
    const frame = requestAnimationFrame(() => updateNodeInternals(targetIds));
    return () => cancelAnimationFrame(frame);
  }, [scene, setNodes, updateNodeInternals]);
  const sceneIds = useMemo(() => scene.nodes.map((node) => node.id).sort().join("\n"), [scene.nodes]);
  const previousSceneIds = useRef(sceneIds);
  useEffect(() => {
    if (previousSceneIds.current === sceneIds) return;
    previousSceneIds.current = sceneIds;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1.15 })));
    return () => cancelAnimationFrame(frame);
  }, [sceneIds, fitView]);

  const onNodesChange = useCallback(
    (changes: NodeChange<InfraRfNode>[]) => {
      applyNodesChange(changes);
    },
    [applyNodesChange],
  );

  // Sim decorations merge into live node state (never a scene rebuild), so a
  // tick landing mid-drag doesn't snap the dragged card back.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type === "infragroup") {
          const data = n.data as GroupData;
          const deadCount = data.memberIds.filter((id) => simKilled.has(id)).length;
          if (deadCount === data.deadCount) return n;
          return { ...n, data: { ...data, deadCount } } as InfraRfNode;
        }
        if (n.type !== "code" && n.type !== "external") return n;
        const sim = simResult?.nodes.get(n.id);
        if (!sim && !(n.data as CodeNodeData).sim) return n;
        return { ...n, data: { ...n.data, sim, simKilled: simKilled.has(n.id) } } as InfraRfNode;
      }),
    );
  }, [simResult, simKilled, setNodes]);

  // Global find (the Architecture header's box): cells whose component or
  // detected service misses the query dim. Merged into live node state like
  // the sim decorations — a scene rebuild would snap a drag back.
  const findQuery = (useNav((l) => l.architect?.find) ?? "").trim().toLowerCase();
  const findMatchIds = useMemo(() => {
    if (!findQuery) return null;
    const ids = new Set<string>();
    for (const n of graph.nodes) {
      const text = [
        n.label,
        n.description ?? "",
        ...n.tech,
        n.codeModule ?? "",
        n.codeFile ?? "",
        ...Object.values(n.placements).map((p) => p?.runtime ?? ""),
      ]
        .join("\n")
        .toLowerCase();
      if (text.includes(findQuery)) ids.add(n.id);
    }
    for (const { dep } of detected.externals) {
      if (`${dep.name} ${dep.packages.join(" ")}`.toLowerCase().includes(findQuery))
        ids.add(externalNodeId(dep));
    }
    return ids;
  }, [findQuery, graph, detected]);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type !== "code" && n.type !== "external") return n;
        const miss = findMatchIds != null && !findMatchIds.has(n.id);
        const marked = n.className?.includes("arch-find-miss") ?? false;
        if (miss === marked) return n;
        return {
          ...n,
          className: miss
            ? cn(n.className, "arch-find-miss")
            : n.className?.replace("arch-find-miss", "").trim(),
        } as InfraRfNode;
      }),
    );
    // `scene` re-applies the classes after a scene reset wipes them.
  }, [findMatchIds, setNodes, scene]);

  const edges = useMemo(
    () => (simResult ? applyTrafficToEdges(scene.edges, simResult) : scene.edges),
    [scene.edges, simResult],
  );

  /** Target group whose rect contains the point (flow coordinates). */
  const groupAtPoint = useCallback(
    (point: { x: number; y: number }): GroupRfNode | null => {
      for (const n of nodes) {
        if (n.type !== "infragroup") continue;
        if ((n.data as GroupData).detected) continue; // not a real deployment target
        const abs = rfAbsolutePosition(nodes, n.id);
        const w = n.width ?? 0;
        const h = n.height ?? 0;
        if (
          point.x >= abs.x &&
          point.x <= abs.x + w &&
          point.y >= abs.y &&
          point.y <= abs.y + h
        ) {
          return n as GroupRfNode;
        }
      }
      return null;
    },
    [nodes],
  );

  /** Deepest deployment zone whose absolute rect contains a point. */
  const zoneAtPoint = useCallback(
    (point: { x: number; y: number }, excludeId?: string): ZoneRfNode | null => {
      let best: ZoneRfNode | null = null;
      let bestDepth = -1;
      for (const candidate of nodes) {
        if (candidate.type !== "zone" || candidate.id === excludeId) continue;
        if (excludeId) {
          let parentId = candidate.parentId;
          let excludedDescendant = false;
          while (parentId) {
            if (parentId === excludeId) {
              excludedDescendant = true;
              break;
            }
            parentId = nodes.find((node) => node.id === parentId)?.parentId;
          }
          if (excludedDescendant) continue;
        }
        const abs = rfAbsolutePosition(nodes, candidate.id);
        const width = candidate.measured?.width ?? candidate.width ?? 0;
        const height = candidate.measured?.height ?? candidate.height ?? 0;
        if (
          point.x < abs.x ||
          point.x > abs.x + width ||
          point.y < abs.y ||
          point.y > abs.y + height
        ) {
          continue;
        }
        const depth = rfNestingDepth(nodes, candidate.id);
        if (depth > bestDepth) {
          best = candidate as ZoneRfNode;
          bestDepth = depth;
        }
      }
      return best;
    },
    [nodes],
  );

  const onNodeDragStop = useCallback(
    (evt: MouseEvent | globalThis.TouchEvent, node: RfNode) => {
      if (node.type === "note") {
        onChange(updateNode(graphRef.current, node.id, { parentId: null, position: rfAbsolutePosition(nodes, node.id) }));
        return;
      }
      if (node.type === "zone") {
        const arch = graphRef.current.nodes.find((candidate) => candidate.id === node.id);
        if (!arch || !isZoneKind(arch.kind)) return;
        const abs = rfAbsolutePosition(nodes, node.id);
        const center = {
          x: abs.x + (node.measured?.width ?? node.width ?? zoneSize(arch.kind).width) / 2,
          y: abs.y + (node.measured?.height ?? node.height ?? zoneSize(arch.kind).height) / 2,
        };
        const parent = zoneAtPoint(center, node.id);
        if (parent) {
          const rejection = zoneNestingRejection(arch.kind, (parent.data as ZoneData).kind);
          if (rejection) {
            setNotice(rejection);
            setNodes(scene.nodes);
            return;
          }
        }
        const parentAbs = parent ? rfAbsolutePosition(nodes, parent.id) : { x: 0, y: 0 };
        onChange(
          updateNode(graphRef.current, node.id, {
            parentId: parent?.id ?? null,
            position: { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y },
          }),
        );
        return;
      }
      if (node.type === "infragroup") {
        const data = node.data as GroupData;
        if (data.detected || !activeEnv) return;
        const abs = rfAbsolutePosition(nodes, node.id);
        const center = {
          x: abs.x + (node.measured?.width ?? node.width ?? CELL_W) / 2,
          y: abs.y + (node.measured?.height ?? node.height ?? CELL_H) / 2,
        };
        const zone = zoneAtPoint(center);
        const zoneAbs = zone ? rfAbsolutePosition(nodes, zone.id) : { x: 0, y: 0 };
        onChange(
          moveDeployTarget(graphRef.current, activeEnv.id, data.targetId, {
            x: Math.round(abs.x - zoneAbs.x),
            y: Math.round(abs.y - zoneAbs.y),
            ...(zone ? { zone: zone.id } : {}),
          }),
        );
        return;
      }
      if (node.type !== "code") return;
      const parent = nodes.find((n) => n.id === node.parentId);
      const abs = rfAbsolutePosition(nodes, node.id);
      const center = {
        x: abs.x + (node.measured?.width ?? node.width ?? CELL_W) / 2,
        y: abs.y + (node.measured?.height ?? node.height ?? CELL_H) / 2,
      };
      const hit = groupAtPoint(center);
      const targetId = hit ? (hit.data as GroupData).targetId : null;
      const currentId = parent ? (parent.data as GroupData).targetId : null;
      const target = activeEnv?.targets?.find((candidate) => candidate.id === targetId);
      if (target && hit && targetId !== currentId) {
        // Crossed into another target — re-place, pinned where it landed.
        const hitAbs = rfAbsolutePosition(nodes, hit.id);
        placeOn(node.id, target, { x: abs.x - hitAbs.x, y: abs.y - hitAbs.y });
        return;
      }
      if (target && targetId === currentId) {
        // Moved within its own target — pin the card where it was left; the
        // recomputed scene renders it there, so no snap-back.
        placeOn(node.id, target, node.position);
        return;
      }
      if (!target && "clientX" in evt) {
        // Dropped on empty canvas — name a new deployment target for it.
        setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId: node.id });
      }
      // Nothing changed — snap back to the derived layout.
      setNodes(scene.nodes);
    },
    [nodes, scene, setNodes, groupAtPoint, zoneAtPoint, placeOn, activeEnv, onChange],
  );

  /* ---- HTML5 drops: the "Unplaced" sidebar (existing node id) and the
     palette (a node kind — created on drop) ---- */

  const acceptsCanvasDrag = (e: DragEvent) =>
    e.dataTransfer.types.includes(INFRA_DRAG_MIME) || e.dataTransfer.types.includes(DRAG_MIME);

  /** Create a palette component; returns the new node's id (unplaced yet). */
  const addComponent = useCallback(
    (kind: ArchNodeKind): string => {
      const { graph: next, node } = opAddNode(
        graph,
        kind,
        `New ${KIND_META[kind].label.toLowerCase()}`,
        { x: 0, y: 0 },
      );
      onChange(next);
      select("node", node.id);
      return node.id;
    },
    [graph, onChange, select],
  );

  const addZoneAt = useCallback(
    (kind: ZoneKind, point: { x: number; y: number }, parent?: ZoneRfNode | null): string => {
      const size = zoneSize(kind);
      const parentAbs = parent ? rfAbsolutePosition(nodes, parent.id) : { x: 0, y: 0 };
      const position = {
        x: Math.round(point.x - size.width / 2 - parentAbs.x),
        y: Math.round(point.y - GROUP_HEADER - parentAbs.y),
      };
      const { graph: withNode, node } = opAddNode(
        graph,
        kind,
        `New ${KIND_META[kind].label.toLowerCase()}`,
        position,
        parent?.id ?? null,
      );
      const sized = updateNode(withNode, node.id, { size });
      onChange({
        ...sized,
        environments: sized.environments.map((environment) => environment.id === activeEnv?.id
          ? { ...environment, infraNodeIds: [...new Set([...(environment.infraNodeIds ?? []), node.id])] }
          : environment),
      });
      select("zone", node.id);
      return node.id;
    },
    [graph, nodes, onChange, activeEnv, select],
  );

  const addNoteAt = useCallback((point: { x: number; y: number }): string => {
    if (!activeEnv) return "";
    const { graph: withNode, node } = opAddNode(
      graphRef.current,
      "note",
      "New note",
      { x: Math.round(point.x - 104), y: Math.round(point.y - 36) },
    );
    onChange({
      ...withNode,
      environments: withNode.environments.map((environment) => environment.id === activeEnv.id
        ? { ...environment, infraNodeIds: [...new Set([...(environment.infraNodeIds ?? []), node.id])] }
        : environment),
    });
    select("node", node.id);
    return node.id;
  }, [activeEnv, onChange, select]);

  const onPaletteAdd = useCallback(
    (kind: ArchNodeKind) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const point = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      if (kind === "note") {
        addNoteAt(point);
        return;
      }
      if (!isZoneKind(kind)) {
        addComponent(kind);
        return;
      }
      addZoneAt(kind, point);
    },
    [addComponent, addZoneAt, addNoteAt, screenToFlowPosition],
  );

  const onCanvasDrop = useCallback(
    (evt: DragEvent) => {
      const point = screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
      const hit = groupAtPoint(point);
      const hitAbs = hit ? rfAbsolutePosition(nodes, hit.id) : null;
      const cardAt = hit
        ? {
            x: point.x - (hitAbs?.x ?? 0) - CELL_W / 2,
            y: point.y - (hitAbs?.y ?? 0) - CELL_H / 2,
          }
        : undefined;
      const nodeId = evt.dataTransfer.getData(INFRA_DRAG_MIME);
      if (nodeId) {
        evt.preventDefault();
        if (hit) {
          const target = activeEnv?.targets?.find((candidate) => candidate.id === (hit.data as GroupData).targetId);
          if (target) placeOn(nodeId, target, cardAt);
        }
        else setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId });
        return;
      }
      const kind = evt.dataTransfer.getData(DRAG_MIME) as ArchNodeKind;
      if (!kind || !INFRA_PALETTE_KINDS.includes(kind) || !activeEnv) return;
      evt.preventDefault();
      if (kind === "note") {
        addNoteAt(point);
        return;
      }
      if (isZoneKind(kind)) {
        const parent = zoneAtPoint(point);
        if (parent) {
          const rejection = zoneNestingRejection(kind, (parent.data as ZoneData).kind);
          if (rejection) {
            setNotice(rejection);
            return;
          }
        }
        addZoneAt(kind, point, parent);
        return;
      }
      // Create + place in ONE graph change so undo/persistence see a single edit.
      if (hit) {
        const { graph: next, node } = opAddNode(
          graphRef.current,
          kind,
          `New ${KIND_META[kind].label.toLowerCase()}`,
          { x: 0, y: 0 },
        );
        const pin = cardAt ? clampPin(cardAt) : undefined;
        onChange(
          updateNodePlacement(next, node.id, activeEnv.id, {
            targetId: (hit.data as GroupData).targetId,
            target: (hit.data as GroupData).target,
            runtime: "",
            ...pin,
          }),
        );
        select("node", node.id);
      } else {
        setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId: "", kind });
      }
    },
    [
      screenToFlowPosition,
      groupAtPoint,
      nodes,
      placeOn,
      graph,
      onChange,
      activeEnv,
      addZoneAt,
      addNoteAt,
      zoneAtPoint,
      select,
    ],
  );

  const adoptExternal = useCallback((dep: CodeExternalDep, x: number, y: number) => {
    if (!activeEnv) return;
    const id = externalNodeId(dep);
    setExternalPlacement({ x, y, nodeId: id, externalDep: dep });
  }, [activeEnv]);

  const materializePending = useCallback((prompt: TargetPrompt, source: ArchitectureGraph) => {
    if (prompt.kind) {
      const added = opAddNode(source, prompt.kind, `New ${KIND_META[prompt.kind].label.toLowerCase()}`, { x: 0, y: 0 });
      return { graph: added.graph, nodeId: added.node.id };
    }
    if (prompt.externalDep && !source.nodes.some((node) => node.id === prompt.nodeId)) {
      const kind = ARCH_KIND_OF_CATEGORY[prompt.externalDep.category];
      const node = { ...createArchNode(kind, prompt.externalDep.name, { x: 0, y: 0 }), id: prompt.nodeId };
      return { graph: { ...source, nodes: [...source.nodes, node] }, nodeId: node.id };
    }
    return { graph: source, nodeId: prompt.nodeId };
  }, []);

  const commitPendingPlacement = useCallback((prompt: TargetPrompt, target: ArchDeployTarget, createTarget = false) => {
    if (!activeEnv) return;
    const pending = materializePending(prompt, graphRef.current);
    const withTarget = createTarget ? upsertDeployTarget(pending.graph, activeEnv.id, target) : pending.graph;
    const node = withTarget.nodes.find((candidate) => candidate.id === pending.nodeId);
    if (!node) return;
    const runtime = node.placements[activeEnv.id]?.runtime ?? "";
    onChange(updateNodePlacement(withTarget, pending.nodeId, activeEnv.id, { targetId: target.id, target: target.name, runtime }));
    select("node", pending.nodeId);
  }, [activeEnv, materializePending, onChange, select]);

  const commitPaletteUnplaced = useCallback((prompt: TargetPrompt) => {
    if (!prompt.kind) return;
    const pending = materializePending(prompt, graphRef.current);
    onChange(pending.graph);
    select("node", pending.nodeId);
  }, [materializePending, onChange, select]);

  const selectedNode = parsedSelection.kind !== "target"
    ? graph.nodes.find((n) => n.id === selectedId) ?? null
    : null;
  const selectedTarget = parsedSelection.kind === "target"
    ? activeEnv?.targets?.find((target) => target.id === selectedId) ?? null
    : null;

  const requestTargetRemoval = useCallback((targetId: string) => {
    setConfirmTargetId(targetId);
    select("target", targetId);
  }, [select]);
  const confirmTarget = activeEnv?.targets?.find((target) => target.id === confirmTargetId) ?? null;
  const confirmTargetMembers = confirmTarget
    ? groups.find((group) => group.target.id === confirmTarget.id)?.nodes ?? []
    : [];
  const confirmRemoveTarget = useCallback(() => {
    if (!activeEnv || !confirmTargetId) return;
    onChange(deleteDeployTarget(graphRef.current, activeEnv.id, confirmTargetId));
    setConfirmTargetId(null);
    select("target", null);
  }, [activeEnv, confirmTargetId, onChange, select]);

  const componentMenuEntries = useCallback((node: ArchNode): MenuEntry[] => {
    if (!activeEnv) return [];
    const entries: MenuEntry[] = [
      { type: "item", label: "Edit placement", icon: MapPin, onSelect: () => select("node", node.id) },
      {
        type: "submenu",
        label: "Move to target",
        icon: ListChecks,
        entries: [
          { type: "item", label: "Unplaced", onSelect: () => onChange(updateNodePlacement(graphRef.current, node.id, activeEnv.id, null)) },
          ...targets.map((target) => ({ type: "item" as const, label: target.name, onSelect: () => placeOn(node.id, target) })),
        ],
      },
      {
        type: "item",
        label: `Remove from ${activeEnv.name}`,
        icon: Trash2,
        danger: true,
        disabled: !node.placements[activeEnv.id],
        onSelect: () => onChange(updateNodePlacement(graphRef.current, node.id, activeEnv.id, null)),
      },
    ];
    if (node.codeFile || node.codeModule) {
      entries.push(
        { type: "separator" },
        ...symbolMenu(
          {
            node: node.id,
            label: node.label,
            file: node.codeFile ?? undefined,
            module: node.codeModule ?? undefined,
          },
          {
            graph: graphRef.current,
            revealOnDiagram: () => {
              select("node", node.id);
              requestAnimationFrame(() => void fitView({ nodes: [{ id: node.id } as RfNode], padding: 0.4, maxZoom: 1.2 }));
            },
          },
        ),
      );
    }
    return entries;
  }, [activeEnv, targets, onChange, placeOn, select, symbolMenu, fitView]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, rfNode: InfraRfNode) => {
    if (!activeEnv) return;
    if (rfNode.type === "code") {
      const node = graphRef.current.nodes.find((candidate) => candidate.id === rfNode.id);
      if (node) menu.open(event, componentMenuEntries(node));
      return;
    }
    if (rfNode.type === "infragroup") {
      const data = rfNode.data as GroupData;
      if (data.detected) return;
      const target = activeEnv.targets?.find((candidate) => candidate.id === data.targetId);
      if (!target) return;
      menu.open(event, [
        { type: "item", label: "Rename", icon: Pencil, onSelect: () => setRenamePrompt({ id: target.id, kind: "target", x: event.clientX, y: event.clientY }) },
        { type: "item", label: "Edit details", icon: MapPin, onSelect: () => select("target", target.id) },
        {
          type: "submenu",
          label: "Select members",
          icon: ListChecks,
          disabled: data.memberIds.length === 0,
          entries: data.memberIds.map((id) => ({
            type: "item" as const,
            label: graphRef.current.nodes.find((node) => node.id === id)?.label ?? id,
            onSelect: () => select("node", id),
          })),
        },
        { type: "separator" },
        { type: "item", label: "Remove target", icon: Trash2, danger: true, onSelect: () => requestTargetRemoval(target.id) },
      ]);
      return;
    }
    if (rfNode.type === "zone" || rfNode.type === "note") {
      const node = graphRef.current.nodes.find((candidate) => candidate.id === rfNode.id);
      if (!node) return;
      menu.open(event, [
        { type: "item", label: node.kind === "note" ? "Rename / edit" : "Rename", icon: Pencil, onSelect: () => node.kind === "note" ? select("node", node.id) : setRenamePrompt({ id: node.id, kind: "node", x: event.clientX, y: event.clientY }) },
        { type: "item", label: `Remove from ${activeEnv.name}`, icon: Trash2, danger: true, onSelect: () => node.kind === "note" ? removeInfraNode(node.id) : removeZone(node.id) },
      ]);
      return;
    }
    if (rfNode.type === "external") {
      const dep = (rfNode.data as ExternalData).dep;
      menu.open(event, [{ type: "item", label: `Place in ${activeEnv.name}`, icon: MapPin, onSelect: () => adoptExternal(dep, event.clientX, event.clientY) }]);
    }
  }, [activeEnv, menu, componentMenuEntries, select, requestTargetRemoval, removeInfraNode, removeZone, adoptExternal]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    if (!activeEnv) return;
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    menu.open(event as React.MouseEvent, [
      ...ZONE_KINDS.map((kind) => ({
        type: "item" as const,
        label: `Add ${KIND_META[kind].label.toLowerCase()} here`,
        icon: KIND_META[kind].icon,
        onSelect: () => {
          const parent = zoneAtPoint(point);
          if (parent) {
            const rejection = zoneNestingRejection(kind, (parent.data as ZoneData).kind);
            if (rejection) return setNotice(rejection);
          }
          addZoneAt(kind, point, parent);
        },
      })),
      { type: "item", label: "Add note here", icon: StickyNote, onSelect: () => addNoteAt(point) },
      { type: "separator" },
      { type: "item", label: "New environment", icon: Plus, onSelect: () => setAddingEnv(true) },
    ]);
  }, [activeEnv, screenToFlowPosition, menu, zoneAtPoint, addZoneAt, addNoteAt]);

  useEffect(() => {
    const handleDelete = (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || event.defaultPrevented) return;
      if (!canvasRef.current?.contains(document.activeElement) || isEditableDeleteTarget(event.target)) return;
      if (!activeEnv || !selectedId) return;
      if (parsedSelection.kind === "target") requestTargetRemoval(selectedId);
      else {
        const node = graphRef.current.nodes.find((candidate) => candidate.id === selectedId);
        if (!node) return;
        if (isZoneKind(node.kind)) removeZone(node.id);
        else if (node.kind === "note") removeInfraNode(node.id);
        else {
          if (!node.placements[activeEnv.id]) return;
          onChange(updateNodePlacement(graphRef.current, node.id, activeEnv.id, null));
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", handleDelete);
    return () => window.removeEventListener("keydown", handleDelete);
  }, [activeEnv, selectedId, parsedSelection.kind, requestTargetRemoval, removeZone, removeInfraNode, onChange]);

  if (graph.environments.length === 0) {
    return (
      <EmptyState icon={Globe2} title="No environments yet">
        <div className="mb-3">
          Define where this architecture runs. Local development is the usual starting point;
          cloud environments come later, when it deploys.
        </div>
        <Button variant="primary" size="sm" className="mb-3" onClick={addLocalEnvironment}>
          <Laptop className="h-3.5 w-3.5" />
          Add local environment
        </Button>
        <div className="mb-2 text-[11px] text-ink-faint">or name one yourself:</div>
        <form
          className="mx-auto flex max-w-60 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addEnvironment();
          }}
        >
          <Input
            autoFocus
            value={newEnvName}
            onChange={(e) => setNewEnvName(e.target.value)}
            placeholder="production"
          />
          <Button type="submit" variant="primary" size="sm" disabled={!newEnvName.trim()}>
            Add
          </Button>
        </form>
      </EmptyState>
    );
  }

  return (
    <SimActionsContext.Provider value={simActions}>
    <div className="flex h-full min-h-0">
      <div ref={canvasRef} className="relative min-w-0 flex-1" tabIndex={-1}>
        {/* Compose-derived topology suggestions (renders null without compose files) */}
        <div className="absolute left-3 top-14 z-10">
          <ComposeSuggestions graph={graph} environment={activeEnv ?? null} onAdopt={onChange} />
        </div>
        {/* Environment switcher */}
        <div className="absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-xl border border-edge bg-surface-2/95 p-1 text-xs shadow-xl shadow-black/30 backdrop-blur">
          {graph.environments.map((env) => (
            <span
              key={env.id}
              className={cn(
                "group flex items-center gap-1 rounded-lg px-2 py-1",
                env.id === activeEnv?.id
                  ? "bg-surface-active text-ink"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              <button
                type="button"
                onClick={() => nav({ architect: { env: env.id, sel: null } })}
                className="flex items-center gap-1 font-medium"
              >
                {env.kind === "cloud" ? (
                  <Cloud className="h-3 w-3 shrink-0 opacity-70" />
                ) : (
                  <Laptop className="h-3 w-3 shrink-0 opacity-70" />
                )}
                <span className="max-w-32 truncate">{env.name}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const duplicated = duplicateEnvironment(graph, env.id);
                  const created = duplicated.environments.at(-1);
                  onChange(duplicated);
                  if (created) nav({ architect: { env: created.id, sel: null } });
                }}
                className="hidden text-ink-faint hover:text-ink group-hover:block"
                aria-label={`Duplicate environment ${env.name}`}
                title="Duplicate environment"
              >
                <Plus className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => setRemoveEnvId(env.id)}
                className="hidden text-ink-faint hover:text-danger group-hover:block"
                aria-label={`Remove environment ${env.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {addingEnv ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                addEnvironment();
              }}
            >
              <button
                type="button"
                onClick={() => setNewEnvKind(newEnvKind === "cloud" ? "local" : "cloud")}
                className="rounded-md p-1 text-ink-muted hover:text-ink"
                aria-label={`Environment kind: ${newEnvKind} (click to toggle)`}
                title={newEnvKind === "cloud" ? "Cloud environment" : "Local environment"}
              >
                {newEnvKind === "cloud" ? <Cloud className="h-3.5 w-3.5" /> : <Laptop className="h-3.5 w-3.5" />}
              </button>
              <input
                autoFocus
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onBlur={(e) => {
                  // Keep the form open while toggling the kind button.
                  if (e.relatedTarget instanceof HTMLElement && e.relatedTarget.closest("form") === e.currentTarget.form) return;
                  setAddingEnv(false);
                  setNewEnvName("");
                }}
                onKeyDown={(e) => e.key === "Escape" && setAddingEnv(false)}
                placeholder={newEnvKind === "cloud" ? "aws production" : "local dev"}
                className="w-24 rounded-lg border border-crystal-500/60 bg-surface-1 px-2 py-1 text-xs text-ink outline-none"
                aria-label="New environment name"
              />
            </form>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setAddingEnv(true)}
              aria-label="Add environment"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {depsAvailable ? (
            <>
              <div className="mx-0.5 h-4 w-px bg-edge" />
              <button
                type="button"
                aria-pressed={depsOn}
                onClick={() => setDepsOn(!depsOn)}
                title="Map dependencies detected from the code — module imports between placed components, plus the external services (databases, queues, APIs…) their packages imply"
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors",
                  depsOn ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <Waypoints className="h-3.5 w-3.5" />
                deps
              </button>
            </>
          ) : null}
          {groups.length > 0 ? (
            <>
              <div className="mx-0.5 h-4 w-px bg-edge" />
              <button
                type="button"
                aria-pressed={simOn}
                onClick={() => setSimOn(!simOn)}
                title="Simulate traffic — watch req/s flow through this environment, then break it with chaos switches"
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors",
                  simOn ? "bg-ok/15 text-ok" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <Play className={cn("h-3.5 w-3.5", simOn && "fill-current")} />
                simulate
              </button>
            </>
          ) : null}
          <div className="mx-0.5 h-4 w-px bg-edge" />
          <ExportMenu
            canvasRef={canvasRef}
            workspace={workspaceName}
            view="infra"
            mermaid={deploymentMermaid}
            onNotice={setNotice}
          />
        </div>

        {/* Palette — new components drag onto a target (or click to add, then
            place from the sidebar). Outside the flow so the empty state has it too. */}
        <div className="absolute left-3 top-1/2 z-10 -translate-y-1/2">
          <Palette groups={INFRA_PALETTE_GROUPS} onAdd={onPaletteAdd} />
        </div>

        <AdoptExternalContext.Provider value={adoptExternal}>
        <ZoneActionsContext.Provider value={zoneActions}>
          <ReactFlow
            key={activeEnv?.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            deleteKeyCode={null}
            onNodeClick={(_e, n) => {
              canvasRef.current?.focus();
              if (n.type === "code") select("node", n.id);
              else if (n.type === "note") select("node", n.id);
              else if (n.type === "zone") select("zone", n.id);
              else if (n.type === "infragroup" && !(n.data as GroupData).detected) select("target", (n.data as GroupData).targetId);
            }}
            onPaneClick={() => { canvasRef.current?.focus(); select("node", null); }}
            onDrop={onCanvasDrop}
            onDragOver={(e) => {
              if (!acceptsCanvasDrag(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
            minZoom={0.1}
            maxZoom={2}
            nodesConnectable={false}
            panOnScroll
            proOptions={{ hideAttribution: true }}
            className="bg-surface-0"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1.25}
              color="var(--color-edge-strong)"
            />
            <Controls
              position="bottom-left"
              showInteractive={false}
              className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
            />
            {simOn && simResult ? (
              <Panel position="bottom-center">
                <SimPanel
                  result={simResult}
                  history={simHistory}
                  ingressRps={simIngress}
                  onIngressChange={setSimIngress}
                  chaos={simChaos}
                  onChaosChange={setSimChaos}
                  killedCount={simKilled.size}
                  onRestoreAll={() => setSimKilled(new Set())}
                  onStop={() => setSimOn(false)}
                />
              </Panel>
            ) : null}
          </ReactFlow>
        </ZoneActionsContext.Provider>
        </AdoptExternalContext.Provider>
        {menu.element}

        {groups.length === 0 && zones.length === 0 && notes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 z-[5]">
            <EmptyState icon={Server} title={`Nothing placed in ${activeEnv?.name ?? "this environment"}`}>
              Drag a component or zone onto the canvas. Components dropped on empty space can
              name their first deployment target.
            </EmptyState>
          </div>
        ) : null}

        {targetPrompt ? (
          <InlineRename
            x={targetPrompt.x}
            y={targetPrompt.y}
            initial=""
            placeholder="New deployment target, e.g. aws us-east-1 / ecs"
            commitEmpty
            onCommit={(target) => {
              if (!activeEnv) {
                setTargetPrompt(null);
                return;
              }
              const name = target.trim();
              if (!name) {
                commitPaletteUnplaced(targetPrompt);
                setTargetPrompt(null);
                return;
              }
              const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
              const existing = (activeEnv.targets ?? []).find((candidate) => key(candidate.name) === key(name));
              const deployTarget: ArchDeployTarget = existing ?? { id: uid("tgt"), name, kind: "other" };
              commitPendingPlacement(targetPrompt, deployTarget, !existing);
              setTargetPrompt(null);
            }}
            onCancel={() => {
              commitPaletteUnplaced(targetPrompt);
              setTargetPrompt(null);
            }}
          />
        ) : null}
        {renamePrompt ? (
          <InlineRename
            x={renamePrompt.x}
            y={renamePrompt.y}
            initial={renamePrompt.kind === "target"
              ? activeEnv?.targets?.find((target) => target.id === renamePrompt.id)?.name ?? ""
              : graph.nodes.find((node) => node.id === renamePrompt.id)?.label ?? ""}
            onCommit={(label) => {
              onChange(renamePrompt.kind === "target" && activeEnv
                ? renameDeployTarget(graphRef.current, activeEnv.id, renamePrompt.id, label)
                : updateNode(graphRef.current, renamePrompt.id, { label }));
              setRenamePrompt(null);
            }}
            onCancel={() => setRenamePrompt(null)}
          />
        ) : null}
        {notice ? (
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-lg -translate-x-1/2 items-center gap-2 rounded-xl border border-warn/40 bg-surface-2/95 px-3 py-2 text-[11px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
            <span className="min-w-0">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 text-ink-faint hover:text-ink"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-surface-1">
        {selectedNode?.kind === "note" ? (
          <NoteEditor
            key={selectedNode.id}
            node={selectedNode}
            graph={graph}
            onChange={onChange}
            onClose={() => select("node", null)}
          />
        ) : selectedNode && activeEnv && !isZoneKind(selectedNode.kind) ? (
          <PlacementEditor
            key={`${selectedNode.id}:${activeEnv.id}`}
            node={selectedNode}
            envId={activeEnv.id}
            envName={activeEnv.name}
            targets={targets}
            graph={graph}
            onChange={onChange}
            onClose={() => select("node", null)}
          />
        ) : null}
        {selectedTarget && activeEnv ? (
          <TargetInspector
            target={selectedTarget}
            members={groups.find((group) => group.target.id === selectedTarget.id)?.nodes ?? []}
            envId={activeEnv.id}
            graph={graph}
            onChange={onChange}
            onSelectMember={(id) => select("node", id)}
            onRequestRemove={() => requestTargetRemoval(selectedTarget.id)}
            onClose={() => select("target", null)}
          />
        ) : null}
        {selectedNode && isSimKind(selectedNode.kind) ? (
          <div className="border-b border-edge p-3">
            <div className="mb-2 flex items-center gap-2">
              <Gauge className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
              <span className="text-xs font-semibold text-ink">Simulation</span>
            </div>
            <SimEditor
              node={selectedNode}
              onPatch={(p) => onChange(updateNode(graph, selectedNode.id, p))}
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Unplaced in {activeEnv?.name} ({unplaced.length})
          </div>
          {unplaced.length > 0 ? (
            <div className="mb-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-faint">
              Drag onto a target on the canvas — or onto empty space to name a new one.
            </div>
          ) : null}
          {unplaced.map((n) => {
            const Icon = KIND_META[n.kind].icon;
            return (
              <button
                key={n.id}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(INFRA_DRAG_MIME, n.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => select("node", n.id)}
                onContextMenu={(event) => menu.open(event, componentMenuEntries(n))}
                className={cn(
                  "flex w-full cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs active:cursor-grabbing",
                  selectedId === n.id
                    ? "bg-crystal-500/15 text-ink"
                    : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                )}
              >
                <GripVertical className="h-3 w-3 shrink-0 text-ink-faint" />
                <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: accentOf(n) }} />
                <span className="min-w-0 flex-1 truncate">{n.label}</span>
                <Badge tone="neutral">{KIND_META[n.kind].label}</Badge>
              </button>
            );
          })}
          {unplaced.length === 0 ? (
            <div className="py-1 text-[11px] text-ink-faint">
              Every component is placed. Nice.
            </div>
          ) : null}
        </div>
      </aside>
      <Dialog open={removeEnvId != null} onOpenChange={(open) => !open && setRemoveEnvId(null)}>
        <DialogContent
          title={`Remove environment “${graph.environments.find((environment) => environment.id === removeEnvId)?.name ?? ""}”?`}
          description={removeEnvId ? `This removes ${environmentPlacementCount(graph, removeEnvId)} placement${environmentPlacementCount(graph, removeEnvId) === 1 ? "" : "s"}.` : undefined}
        >
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
            <Button variant="danger" size="sm" onClick={confirmRemoveEnvironment}>Remove environment</Button>
          </div>
        </DialogContent>
      </Dialog>
      <RemoveTargetDialog
        target={confirmTarget}
        memberCount={confirmTargetMembers.length}
        open={confirmTarget != null}
        onOpenChange={(open) => !open && setConfirmTargetId(null)}
        onConfirm={confirmRemoveTarget}
      />
      <Dialog open={externalPlacement != null} onOpenChange={(open) => !open && setExternalPlacement(null)}>
        <DialogContent title={`Place detected service in ${activeEnv?.name ?? "environment"}`} description="Choose an existing deployment target or create a new one.">
          <div className="space-y-1">
            {targets.map((target) => (
              <button key={target.id} type="button" className="block w-full rounded-lg border border-edge bg-surface-1 px-3 py-2 text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink" onClick={() => {
                if (externalPlacement) commitPendingPlacement(externalPlacement, target);
                setExternalPlacement(null);
              }}>{target.name}</button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => {
              if (externalPlacement) setTargetPrompt(externalPlacement);
              setExternalPlacement(null);
            }}><Plus className="h-3.5 w-3.5" /> New target…</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
    </SimActionsContext.Provider>
  );
}

function NoteEditor({ node, graph, onChange, onClose }: {
  node: ArchNode;
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? "");
  const commit = (patch: Partial<Pick<ArchNode, "label" | "description">>) =>
    onChange(updateNode(graph, node.id, patch));
  return (
    <div className="border-b border-edge p-3">
      <div className="mb-2 flex items-center gap-2">
        <StickyNote className="h-3.5 w-3.5 shrink-0 text-accent-amber" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">Note</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close note editor"><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="space-y-2">
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Title</div>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} onBlur={() => commit({ label: label.trim() || node.label })} />
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Text</div>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => commit({ description: description.trim() || undefined })}
            className="min-h-20 w-full resize-y rounded-lg border border-edge bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-crystal-500/60"
          />
        </label>
      </div>
    </div>
  );
}

function PlacementEditor({
  node,
  envId,
  envName,
  targets,
  graph,
  onChange,
  onClose,
}: {
  node: ArchNode;
  envId: string;
  envName: string;
  targets: ArchDeployTarget[];
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  onClose: () => void;
}) {
  const placement = node.placements[envId];
  const [targetId, setTargetId] = useState(placement?.targetId ?? "");
  const [runtime, setRuntime] = useState(placement?.runtime ?? "");

  const commit = (id: string, r: string) => {
    const target = targets.find((candidate) => candidate.id === id);
    onChange(updateNodePlacement(graph, node.id, envId, target ? { targetId: target.id, target: target.name, runtime: r.trim() } : null));
  };

  return (
    <div className="border-b border-edge p-3">
      <div className="mb-2 flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{node.label}</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close placement editor">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-2">
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Target in {envName}
          </div>
          <select
            value={targetId}
            onChange={(event) => { setTargetId(event.target.value); commit(event.target.value, runtime); }}
            className="h-8 w-full rounded-lg border border-edge bg-surface-2 px-2 text-xs text-ink outline-none"
          >
            <option value="">Unplaced</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Runtime
          </div>
          <Input
            value={runtime}
            onChange={(e) => setRuntime(e.target.value)}
            onBlur={() => commit(targetId, runtime)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            placeholder="fargate ×3, k8s deployment, lambda…"
          />
        </label>
        {placement ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-danger"
            onClick={() => commit("", "")}
          >
            <X className="h-3 w-3" /> Remove from {envName}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

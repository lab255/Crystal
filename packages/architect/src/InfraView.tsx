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
  Laptop,
  MapPin,
  Play,
  Plus,
  Server,
  Skull,
  Unplug,
  Waypoints,
  X,
} from "lucide-react";
import {
  ARCH_KIND_OF_CATEGORY,
  createLocalEnvironment,
  isContainerKind,
  topoOrderNodes,
  uid,
  updateEnvironmentTargetLayout,
  updateNodePlacement,
  type ArchEnvironment,
  type ArchNode,
  type ArchNodeKind,
  type ArchitectureGraph,
  type CodeMapSummary,
  type DiffMarks,
} from "@crystal/core";
import { useNav } from "@crystal/client";
import { Badge, Button, EmptyState, Input, Tooltip, cn } from "@crystal/ui";
import { CodeNode, type CodeNodeData, type CodeRfNode } from "./codemap/CodeNode.js";
import { InlineRename } from "./ContextMenu.js";
import { absolutePosition as graphAbsolutePosition, addNode as opAddNode, updateNode } from "./graph-ops.js";
import { DRAG_MIME, PALETTE_KINDS, Palette } from "./Palette.js";
import { infraGroups, knownTargets, layerBands, placedEdges } from "./infra.js";
import { detectedExternals, detectedInternalEdges, externalNodeId } from "./infra-deps.js";
import { ACCENT_CSS, EDGE_KIND_STYLE, KIND_META, accentOf } from "./model.js";
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

const ZONE_KINDS = ["vpc", "subnet", "securitygroup"] as const satisfies readonly ArchNodeKind[];
type ZoneKind = (typeof ZONE_KINDS)[number];

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
];
const INFRA_PALETTE_GROUPS = [
  { label: "Components", kinds: INFRA_COMPONENT_KINDS },
  { label: "Zones", kinds: ZONE_KINDS },
] as const;

interface GroupData extends Record<string, unknown> {
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

const nodeTypes = {
  zone: ZoneNode,
  infragroup: InfraGroupNode,
  code: CodeNode,
  bandlabel: BandLabelNode,
};
type InfraRfNode = ZoneRfNode | GroupRfNode | CodeRfNode | BandLabelRfNode;

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
const GROUP_GAP = 56;
const BAND_GAP = 104;
const LAYOUT_TOP = 96;

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

function canNestZone(child: ZoneKind, parent: ZoneKind): boolean {
  return child === "subnet"
    ? parent === "vpc"
    : child === "securitygroup"
      ? parent === "vpc" || parent === "subnet"
      : false;
}

function adaptiveColumns(
  count: number,
  canvas: { width: number; height: number },
  bandCount: number,
  average: { width: number; height: number },
): number {
  if (count <= 1) return 1;
  const usableWidth = Math.max(680, canvas.width - 220);
  const bandHeight = Math.max(320, (canvas.height - LAYOUT_TOP) / Math.max(1, bandCount));
  const aspect = usableWidth / bandHeight;
  const target = Math.round(Math.sqrt(count * aspect * (average.height / average.width)));
  return Math.max(1, Math.min(count, target));
}

/** Keep a pinned card inside its container — clear of the left edge and header. */
function clampPin(at: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(Math.max(4, at.x)),
    y: Math.round(Math.max(GROUP_HEADER + 4, at.y)),
  };
}

/** Remove only the zone itself, preserving nested zones and assigned targets at root. */
function deleteZoneFromGraph(graph: ArchitectureGraph, zoneId: string): ArchitectureGraph {
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
    environments: graph.environments.map((environment) => {
      if (!environment.layout) return environment;
      let changed = false;
      const layout = Object.fromEntries(
        Object.entries(environment.layout).map(([target, pin]) => {
          if (pin.zone !== zoneId) return [target, pin];
          changed = true;
          return [target, { x: zoneAbs.x + pin.x, y: zoneAbs.y + pin.y }];
        }),
      );
      return changed ? { ...environment, layout } : environment;
    }),
  };
}

/** Pending "name a new deployment target" prompt from a drop on empty canvas. */
interface TargetPrompt {
  /** Screen coordinates for the floating input. */
  x: number;
  y: number;
  nodeId: string;
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
  const [envId, setEnvId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingEnv, setAddingEnv] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvKind, setNewEnvKind] = useState<ArchEnvironment["kind"]>("cloud");
  const [targetPrompt, setTargetPrompt] = useState<TargetPrompt | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1200, height: 760 });

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setCanvasSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph.environments.length]);

  // Keep a ref of the latest graph so the sim tick always reads fresh state.
  const graphRef = useRef(graph);
  graphRef.current = graph;

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
      onChange(deleteZoneFromGraph(graphRef.current, id));
      setSelectedId((selected) => (selected === id ? null : selected));
    },
    [onChange],
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
      const result = simulate(graphRef.current, {
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
  }, [simOn, simIngress, simChaos, simKilled]);

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

  // Local development is the default lens; cloud environments are opt-in.
  const activeEnv =
    graph.environments.find((e) => e.id === envId) ??
    graph.environments.find((e) => e.kind === "local") ??
    graph.environments[0] ??
    null;

  const zones = useMemo(
    () => topoOrderNodes(graph).filter((node) => isZoneKind(node.kind)),
    [graph],
  );

  const { groups, unplaced } = useMemo(
    () => infraGroups(graph, activeEnv?.id ?? ""),
    [graph, activeEnv?.id],
  );
  const targets = useMemo(() => knownTargets(graph), [graph]);

  /* ---- detected dependencies (service-map overlay from the live code map) ---- */
  const [depsOn, setDepsOn] = useState(true);
  const depsAvailable =
    summary != null && (summary.deps.length > 0 || (summary.externals?.length ?? 0) > 0);
  const detected = useMemo(() => {
    if (!depsOn || !summary || !activeEnv) return { externals: [], internal: [] };
    return {
      externals: detectedExternals(graph, activeEnv.id, summary),
      internal: detectedInternalEdges(graph, activeEnv.id, summary),
    };
  }, [depsOn, summary, graph, activeEnv]);

  const addEnvironment = () => {
    const name = newEnvName.trim();
    if (!name) return;
    const env: ArchEnvironment = { id: uid("env"), name, kind: newEnvKind };
    onChange({ ...graph, environments: [...graph.environments, env] });
    setEnvId(env.id);
    setNewEnvName("");
    setAddingEnv(false);
  };

  const addLocalEnvironment = () => {
    const env = createLocalEnvironment();
    onChange({ ...graph, environments: [...graph.environments, env] });
    setEnvId(env.id);
  };

  const removeEnvironment = (id: string) => {
    // Strip the environment and every placement keyed by it.
    onChange({
      ...graph,
      environments: graph.environments.filter((e) => e.id !== id),
      nodes: graph.nodes.map((n) => {
        if (!(id in n.placements)) return n;
        const { [id]: _, ...rest } = n.placements;
        return { ...n, placements: rest };
      }),
    });
    if (envId === id) setEnvId(null);
  };

  /**
   * Place (or re-place) a component on a target, keeping any runtime detail.
   * `at` pins the card at a parent-relative position inside the target's
   * container; omitted, the grid packer owns the slot.
   */
  const placeOn = useCallback(
    (nodeId: string, target: string, at?: { x: number; y: number }) => {
      if (!activeEnv) return;
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const runtime = node.placements[activeEnv.id]?.runtime ?? "";
      const pin = at ? clampPin(at) : {};
      onChange(updateNodePlacement(graph, nodeId, activeEnv.id, { target, runtime, ...pin }));
      setSelectedId(nodeId);
    },
    [graph, onChange, activeEnv],
  );

  const scene = useMemo(() => {
    if (!activeEnv) return { nodes: [] as InfraRfNode[], edges: [] as RfEdge[] };

    const zoneNodes: ZoneRfNode[] = [];
    const bandNodes: BandLabelRfNode[] = [];
    const targetNodes: GroupRfNode[] = [];
    const componentNodes: CodeRfNode[] = [];
    const isLocal = activeEnv.kind === "local";
    const cellH = simOn ? CELL_H_SIM : CELL_H;
    const targetLayout = activeEnv.layout ?? {};
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

    type SceneGroup = (typeof groups)[number];
    const geometryFor = (group: SceneGroup) => {
      // Cards the user dragged carry a pinned position on the placement;
      // the rest grid-pack. The container stretches to hold the pins.
      const members = group.nodes.map((node) => {
        const p = node.placements[activeEnv.id];
        const pinned = p?.x != null && p?.y != null ? { x: p.x, y: p.y } : null;
        return { node, pinned };
      });
      const packedCount = members.filter((m) => !m.pinned).length;
      const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(Math.max(packedCount, 1)))));
      const rows = Math.ceil(packedCount / cols);
      let width = GROUP_PAD * 2 + cols * CELL_W + (cols - 1) * CELL_GAP;
      let height =
        GROUP_HEADER + GROUP_PAD + rows * cellH + Math.max(rows - 1, 0) * CELL_GAP + GROUP_PAD;
      for (const m of members) {
        if (!m.pinned) continue;
        width = Math.max(width, m.pinned.x + CELL_W + GROUP_PAD);
        height = Math.max(height, m.pinned.y + cellH + GROUP_PAD);
      }
      return { group, members, cols, width, height };
    };

    const appendTarget = (
      geometry: ReturnType<typeof geometryFor>,
      position: { x: number; y: number },
      parentId?: string,
    ) => {
      const { group, members, cols, width, height } = geometry;
      const groupId = `target:${group.target}`;
      targetNodes.push({
        id: groupId,
        type: "infragroup",
        ...(parentId ? { parentId } : {}),
        position,
        width,
        height,
        zIndex: -1,
        draggable: true,
        selectable: false,
        deletable: false,
        dragHandle: ".infra-target-header",
        data: {
          target: group.target,
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
      const pin = targetLayout[group.target];
      if (!pin) continue;
      const parentId = pin.zone && zoneIds.has(pin.zone) ? pin.zone : undefined;
      appendTarget(geometryFor(group), { x: pin.x, y: pin.y }, parentId);
    }

    // Unpinned targets retain deterministic band/grid packing, with the
    // column count derived from the measured canvas aspect instead of fixed.
    const fallbackBands = layerBands(groups)
      .map((band) => ({
        ...band,
        groups: band.groups.filter((group) => !targetLayout[group.target]),
      }))
      .filter((band) => band.groups.length > 0);
    const usableWidth = Math.max(680, canvasSize.width - 220);
    let bandY = LAYOUT_TOP;
    for (const band of fallbackBands) {
      const geometries = band.groups.map(geometryFor);
      const average = {
        width: geometries.reduce((sum, item) => sum + item.width, 0) / geometries.length,
        height: geometries.reduce((sum, item) => sum + item.height, 0) / geometries.length,
      };
      const columns = adaptiveColumns(
        geometries.length,
        canvasSize,
        fallbackBands.length,
        average,
      );
      bandNodes.push({
        id: `band:${band.layer ?? "other"}`,
        type: "bandlabel",
        position: { x: 24, y: bandY - 24 },
        draggable: false,
        selectable: false,
        deletable: false,
        data: { label: band.layer ?? "other" },
      });
      let cursorY = bandY;
      for (let rowStart = 0; rowStart < geometries.length; rowStart += columns) {
        const row = geometries.slice(rowStart, rowStart + columns);
        const rowWidth =
          row.reduce((sum, item) => sum + item.width, 0) +
          Math.max(0, row.length - 1) * GROUP_GAP;
        const rowHeight = Math.max(...row.map((item) => item.height));
        let cursorX = Math.max(48, (usableWidth - rowWidth) / 2);
        for (const geometry of row) {
          appendTarget(geometry, { x: Math.round(cursorX), y: Math.round(cursorY) });
          cursorX += geometry.width + GROUP_GAP;
        }
        cursorY += rowHeight + GROUP_GAP;
      }
      bandY = cursorY - GROUP_GAP + BAND_GAP;
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
        const meta = KIND_META[kind];
        componentNodes.push({
          id: externalNodeId(dep),
          type: "code",
          parentId: groupId,
          draggable: false,
          selectable: false,
          deletable: false,
          position: {
            x: GROUP_PAD + (j % cols) * (CELL_W + CELL_GAP),
            y: GROUP_HEADER + GROUP_PAD + Math.floor(j / cols) * (CELL_H + CELL_GAP),
          },
          data: {
            title: dep.name,
            subtitle: dep.packages.slice(0, 3).join(", "),
            accent: ACCENT_CSS[meta.defaultAccent],
            icon: meta.icon,
            badge: `×${dep.weight}`,
            boundary: true,
            diff: diffMarks?.[externalNodeId(dep)],
          },
        });
      });
    }

    // React-flow requires every parent before its children.
    const nodes: InfraRfNode[] = [
      ...zoneNodes,
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
  }, [graph, groups, zones, activeEnv, selectedId, simOn, detected, diffMarks, canvasSize]);

  // Drag needs live node state; the derived scene resets it (drop snaps back
  // unless the placement actually changed, in which case the scene moves it).
  const [nodes, setNodes, applyNodesChange] = useNodesState<InfraRfNode>(scene.nodes);
  useEffect(() => setNodes(scene.nodes), [scene, setNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange<InfraRfNode>[]) => {
      applyNodesChange(changes);
      const removedZoneIds = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id)
        .filter((id) => {
          const node = graphRef.current.nodes.find((candidate) => candidate.id === id);
          return node != null && isZoneKind(node.kind);
        });
      if (removedZoneIds.length === 0) return;
      let next = graphRef.current;
      for (const id of removedZoneIds) next = deleteZoneFromGraph(next, id);
      onChange(next);
      setSelectedId((selected) => (selected && removedZoneIds.includes(selected) ? null : selected));
    },
    [applyNodesChange, onChange],
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
        if (n.type !== "code") return n;
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
        if (n.type !== "code") return n;
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

  /** Deepest eligible deployment zone whose absolute rect contains a point. */
  const zoneAtPoint = useCallback(
    (
      point: { x: number; y: number },
      childKind?: ZoneKind,
      excludeId?: string,
    ): ZoneRfNode | null => {
      let best: ZoneRfNode | null = null;
      let bestDepth = -1;
      for (const candidate of nodes) {
        if (candidate.type !== "zone" || candidate.id === excludeId) continue;
        const data = candidate.data as ZoneData;
        if (childKind && !canNestZone(childKind, data.kind)) continue;
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
      if (node.type === "zone") {
        const arch = graphRef.current.nodes.find((candidate) => candidate.id === node.id);
        if (!arch || !isZoneKind(arch.kind)) return;
        const abs = rfAbsolutePosition(nodes, node.id);
        const center = {
          x: abs.x + (node.measured?.width ?? node.width ?? zoneSize(arch.kind).width) / 2,
          y: abs.y + (node.measured?.height ?? node.height ?? zoneSize(arch.kind).height) / 2,
        };
        const parent = zoneAtPoint(center, arch.kind, node.id);
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
          updateEnvironmentTargetLayout(graphRef.current, activeEnv.id, data.target, {
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
      const target = hit ? (hit.data as GroupData).target : null;
      const current = parent ? (parent.data as GroupData).target : null;
      if (target && hit && target !== current) {
        // Crossed into another target — re-place, pinned where it landed.
        const hitAbs = rfAbsolutePosition(nodes, hit.id);
        placeOn(node.id, target, { x: abs.x - hitAbs.x, y: abs.y - hitAbs.y });
        return;
      }
      if (target && target === current) {
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
      setSelectedId(node.id);
      return node.id;
    },
    [graph, onChange],
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
      onChange(updateNode(withNode, node.id, { size }));
      setSelectedId(node.id);
      return node.id;
    },
    [graph, nodes, onChange],
  );

  const onPaletteAdd = useCallback(
    (kind: ArchNodeKind) => {
      if (!isZoneKind(kind)) {
        addComponent(kind);
        return;
      }
      const rect = canvasRef.current?.getBoundingClientRect();
      const point = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 0, y: 0 };
      addZoneAt(kind, point);
    },
    [addComponent, addZoneAt, screenToFlowPosition],
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
        if (hit) placeOn(nodeId, (hit.data as GroupData).target, cardAt);
        else setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId });
        return;
      }
      const kind = evt.dataTransfer.getData(DRAG_MIME) as ArchNodeKind;
      if (!kind || !INFRA_PALETTE_KINDS.includes(kind) || !activeEnv) return;
      evt.preventDefault();
      if (isZoneKind(kind)) {
        addZoneAt(kind, point, zoneAtPoint(point, kind));
        return;
      }
      // Create + place in ONE graph change so undo/persistence see a single edit.
      const { graph: next, node } = opAddNode(
        graph,
        kind,
        `New ${KIND_META[kind].label.toLowerCase()}`,
        { x: 0, y: 0 },
      );
      if (hit) {
        const pin = cardAt ? clampPin(cardAt) : undefined;
        onChange(
          updateNodePlacement(next, node.id, activeEnv.id, {
            target: (hit.data as GroupData).target,
            runtime: "",
            ...pin,
          }),
        );
        setSelectedId(node.id);
      } else {
        onChange(next);
        setSelectedId(node.id);
        setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId: node.id });
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
      zoneAtPoint,
    ],
  );

  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;

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
      <div ref={canvasRef} className="relative min-w-0 flex-1">
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
                onClick={() => setEnvId(env.id)}
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
                onClick={() => removeEnvironment(env.id)}
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
        </div>

        {/* Palette — new components drag onto a target (or click to add, then
            place from the sidebar). Outside the flow so the empty state has it too. */}
        <div className="absolute left-3 top-1/2 z-10 -translate-y-1/2">
          <Palette groups={INFRA_PALETTE_GROUPS} onAdd={onPaletteAdd} />
        </div>

        <ZoneActionsContext.Provider value={zoneActions}>
          <ReactFlow
            key={activeEnv?.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_e, n) => {
              if (n.type === "code" || n.type === "zone") setSelectedId(n.id);
            }}
            onPaneClick={() => setSelectedId(null)}
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

        {groups.length === 0 && zones.length === 0 ? (
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
              placeOn(targetPrompt.nodeId, target);
              setTargetPrompt(null);
            }}
            onCancel={() => setTargetPrompt(null)}
          />
        ) : null}
      </div>

      <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-surface-1">
        {selectedNode && activeEnv && !isZoneKind(selectedNode.kind) ? (
          <PlacementEditor
            key={`${selectedNode.id}:${activeEnv.id}`}
            node={selectedNode}
            envId={activeEnv.id}
            envName={activeEnv.name}
            targets={targets}
            graph={graph}
            onChange={onChange}
            onClose={() => setSelectedId(null)}
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
                onClick={() => setSelectedId(n.id)}
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
    </div>
    </SimActionsContext.Provider>
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
  targets: string[];
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  onClose: () => void;
}) {
  const placement = node.placements[envId];
  const [target, setTarget] = useState(placement?.target ?? "");
  const [runtime, setRuntime] = useState(placement?.runtime ?? "");

  const commit = (t: string, r: string) => {
    onChange(updateNodePlacement(graph, node.id, envId, t.trim() ? { target: t.trim(), runtime: r.trim() } : null));
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
          <Input
            list="crystal-infra-targets"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={() => commit(target, runtime)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            placeholder="aws us-east-1 / ecs"
          />
          <datalist id="crystal-infra-targets">
            {targets.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Runtime
          </div>
          <Input
            value={runtime}
            onChange={(e) => setRuntime(e.target.value)}
            onBlur={() => commit(target, runtime)}
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

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge as RfEdge,
  type Node as RfNode,
  type NodeProps,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Cloud, Gauge, Globe2, GripVertical, Laptop, MapPin, Play, Plus, Server, X } from "lucide-react";
import {
  createLocalEnvironment,
  uid,
  updateNodePlacement,
  type ArchEnvironment,
  type ArchNode,
  type ArchitectureGraph,
} from "@crystal/core";
import { Badge, Button, EmptyState, Input, cn } from "@crystal/ui";
import { CodeNode, type CodeNodeData, type CodeRfNode } from "./codemap/CodeNode.js";
import { InlineRename } from "./ContextMenu.js";
import { updateNode } from "./graph-ops.js";
import { infraGroups, knownTargets, layerBands, placedEdges } from "./infra.js";
import { EDGE_KIND_STYLE, KIND_META, accentOf } from "./model.js";
import { SimActionsContext, SimEditor, SimPanel, applyTrafficToEdges } from "./SimPanel.js";
import {
  isSimKind,
  simulate,
  type BreakerState,
  type SimChaos,
  type SimResult,
} from "./simulation.js";

/**
 * Infrastructure view — the same architecture projected per environment:
 * deployment targets become containers, components sit where they run, and
 * the logical edges connect them across targets (a lightweight service map).
 * Placement is drag-and-drop: drag components between targets, drag unplaced
 * components in from the sidebar, drop on empty canvas to name a new target.
 */

/** dataTransfer type for dragging an unplaced component from the sidebar. */
const INFRA_DRAG_MIME = "application/x-crystal-infra-node";

interface GroupData extends Record<string, unknown> {
  target: string;
  count: number;
  /** True when the active environment is local development. */
  local: boolean;
}
type GroupRfNode = RfNode<GroupData>;

const InfraGroupNode = memo(function InfraGroupNode({ data }: NodeProps<GroupRfNode>) {
  const Icon = data.local ? Laptop : Cloud;
  return (
    <div className="h-full w-full rounded-xl border border-dashed border-edge-strong bg-surface-1/60">
      <div className="flex items-center gap-1.5 border-b border-dashed border-edge px-2.5 py-1.5">
        <Icon className="h-3 w-3 shrink-0 text-crystal-300" />
        <span className="truncate text-[10.5px] font-semibold text-ink">{data.target}</span>
        <span className="ml-auto shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] leading-4 text-ink-faint">
          {data.count}
        </span>
      </div>
      {/* Handles keep react-flow quiet; edges attach to child nodes. */}
      <Handle type="target" position={Position.Top} className="!invisible" />
      <Handle type="source" position={Position.Bottom} className="!invisible" />
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

const nodeTypes = { infragroup: InfraGroupNode, code: CodeNode, bandlabel: BandLabelNode };
type InfraRfNode = GroupRfNode | CodeRfNode | BandLabelRfNode;

const CELL_W = 190;
const CELL_H = 58;
/** Taller cells while simulating — cards grow a live stats strip. */
const CELL_H_SIM = 104;
const CELL_GAP = 12;
/** Simulation tick cadence — slow enough to read, fast enough to feel live. */
const SIM_TICK_MS = 600;
const GROUP_PAD = 14;
const GROUP_HEADER = 32;
const GROUPS_PER_ROW = 3;
const GROUP_GAP = 56;

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
}: {
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
}) {
  const [envId, setEnvId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingEnv, setAddingEnv] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvKind, setNewEnvKind] = useState<ArchEnvironment["kind"]>("cloud");
  const [targetPrompt, setTargetPrompt] = useState<TargetPrompt | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  // Keep a ref of the latest graph so the sim tick always reads fresh state.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /* ---- traffic simulation (runs over the whole logical graph; the map
     decorates whatever is placed in the active environment) ---- */
  const [simOn, setSimOn] = useState(false);
  const [simIngress, setSimIngress] = useState(100);
  const [simChaos, setSimChaos] = useState<SimChaos>({ spike: false, cacheMissStorm: false });
  const [simKilled, setSimKilled] = useState<ReadonlySet<string>>(() => new Set());
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const simBreakers = useRef<ReadonlyMap<string, BreakerState>>(new Map());

  useEffect(() => {
    if (!simOn) {
      setSimResult(null);
      simBreakers.current = new Map();
      return;
    }
    const tick = () => {
      // Small wobble makes the numbers feel live without changing the story.
      const jitter = 0.92 + Math.random() * 0.16;
      const result = simulate(graphRef.current, {
        ingressRps: simIngress * jitter,
        chaos: simChaos,
        killed: simKilled,
        breakers: simBreakers.current,
      });
      simBreakers.current = result.breakers;
      setSimResult(result);
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
  const simActions = useMemo(() => ({ toggleKill: toggleSimKill }), [toggleSimKill]);

  // Local development is the default lens; cloud environments are opt-in.
  const activeEnv =
    graph.environments.find((e) => e.id === envId) ??
    graph.environments.find((e) => e.kind === "local") ??
    graph.environments[0] ??
    null;

  const { groups, unplaced } = useMemo(
    () => infraGroups(graph, activeEnv?.id ?? ""),
    [graph, activeEnv?.id],
  );
  const targets = useMemo(() => knownTargets(graph), [graph]);

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

  /** Place (or re-place) a component on a target, keeping any runtime detail. */
  const placeOn = useCallback(
    (nodeId: string, target: string) => {
      if (!activeEnv) return;
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const runtime = node.placements[activeEnv.id]?.runtime ?? "";
      onChange(updateNodePlacement(graph, nodeId, activeEnv.id, { target, runtime }));
      setSelectedId(nodeId);
    },
    [graph, onChange, activeEnv],
  );

  const scene = useMemo(() => {
    if (!activeEnv) return { nodes: [] as InfraRfNode[], edges: [] as RfEdge[] };

    const nodes: InfraRfNode[] = [];
    const isLocal = activeEnv.kind === "local";
    const cellH = simOn ? CELL_H_SIM : CELL_H;
    let bandY = 0;

    // Targets stack in the same top-down traffic bands as the layered layout.
    for (const band of layerBands(groups)) {
      nodes.push({
        id: `band:${band.layer ?? "other"}`,
        type: "bandlabel",
        position: { x: -110, y: bandY + 6 },
        draggable: false,
        selectable: false,
        data: { label: band.layer ?? "other" },
      });

      let cursorX = 0;
      let cursorY = bandY;
      let rowMaxH = 0;
      band.groups.forEach((group, i) => {
        const n = group.nodes.length;
        const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(n))));
        const rows = Math.ceil(n / cols);
        const width = GROUP_PAD * 2 + cols * CELL_W + (cols - 1) * CELL_GAP;
        const height = GROUP_HEADER + GROUP_PAD + rows * cellH + (rows - 1) * CELL_GAP + GROUP_PAD;

        if (i > 0 && i % GROUPS_PER_ROW === 0) {
          cursorX = 0;
          cursorY += rowMaxH + GROUP_GAP;
          rowMaxH = 0;
        }
        const groupId = `target:${group.target}`;
        nodes.push({
          id: groupId,
          type: "infragroup",
          position: { x: cursorX, y: cursorY },
          width,
          height,
          zIndex: -1,
          draggable: false,
          selectable: false,
          data: { target: group.target, count: n, local: isLocal },
        });
        group.nodes.forEach((node, j) => {
          const col = j % cols;
          const row = Math.floor(j / cols);
          nodes.push({
            id: node.id,
            type: "code",
            parentId: groupId,
            draggable: true,
            position: {
              x: GROUP_PAD + col * (CELL_W + CELL_GAP),
              y: GROUP_HEADER + GROUP_PAD + row * (cellH + CELL_GAP),
            },
            selected: node.id === selectedId,
            data: {
              title: node.label,
              subtitle: node.placements[activeEnv.id]?.runtime || KIND_META[node.kind].label,
              accent: accentOf(node),
              icon: KIND_META[node.kind].icon,
            },
          });
        });
        cursorX += width + GROUP_GAP;
        rowMaxH = Math.max(rowMaxH, height);
      });
      bandY = cursorY + rowMaxH + GROUP_GAP + 8;
    }

    const edges: RfEdge[] = placedEdges(graph, activeEnv.id).map((e) => {
      const style = EDGE_KIND_STYLE[e.kind];
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label || undefined,
        style: { stroke: style.stroke, strokeWidth: 1.4, strokeDasharray: style.dash, opacity: 0.9 },
        labelStyle: { fill: "var(--color-ink-muted)", fontSize: 9 },
        labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke, width: 14, height: 14 },
      };
    });
    return { nodes, edges };
  }, [graph, groups, activeEnv, selectedId, simOn]);

  // Drag needs live node state; the derived scene resets it (drop snaps back
  // unless the placement actually changed, in which case the scene moves it).
  const [nodes, setNodes, onNodesChange] = useNodesState<InfraRfNode>(scene.nodes);
  useEffect(() => setNodes(scene.nodes), [scene, setNodes]);

  // Sim decorations merge into live node state (never a scene rebuild), so a
  // tick landing mid-drag doesn't snap the dragged card back.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.type !== "code") return n;
        const sim = simResult?.nodes.get(n.id);
        if (!sim && !(n.data as CodeNodeData).sim) return n;
        return { ...n, data: { ...n.data, sim, simKilled: simKilled.has(n.id) } } as InfraRfNode;
      }),
    );
  }, [simResult, simKilled, setNodes]);

  const edges = useMemo(
    () => (simResult ? applyTrafficToEdges(scene.edges, simResult) : scene.edges),
    [scene.edges, simResult],
  );

  /** Target group whose rect contains the point (flow coordinates). */
  const groupAtPoint = useCallback(
    (point: { x: number; y: number }): string | null => {
      for (const n of nodes) {
        if (n.type !== "infragroup") continue;
        const w = n.width ?? 0;
        const h = n.height ?? 0;
        if (
          point.x >= n.position.x &&
          point.x <= n.position.x + w &&
          point.y >= n.position.y &&
          point.y <= n.position.y + h
        ) {
          return (n.data as GroupData).target;
        }
      }
      return null;
    },
    [nodes],
  );

  const onNodeDragStop = useCallback(
    (evt: MouseEvent | globalThis.TouchEvent, node: RfNode) => {
      if (node.type !== "code") return;
      const parent = nodes.find((n) => n.id === node.parentId);
      const abs = {
        x: (parent?.position.x ?? 0) + node.position.x,
        y: (parent?.position.y ?? 0) + node.position.y,
      };
      const center = {
        x: abs.x + (node.measured?.width ?? node.width ?? CELL_W) / 2,
        y: abs.y + (node.measured?.height ?? node.height ?? CELL_H) / 2,
      };
      const target = groupAtPoint(center);
      const current = parent ? (parent.data as GroupData).target : null;
      if (target && target !== current) {
        placeOn(node.id, target);
      } else if (!target && "clientX" in evt) {
        // Dropped on empty canvas — name a new deployment target for it.
        setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId: node.id });
      }
      // Always snap back to the derived layout; a real placement change moves
      // the node via the recomputed scene.
      setNodes(scene.nodes);
    },
    [nodes, scene, setNodes, groupAtPoint, placeOn],
  );

  /* ---- HTML5 drops from the "Unplaced" sidebar ---- */

  const acceptsSidebarDrag = (e: DragEvent) => e.dataTransfer.types.includes(INFRA_DRAG_MIME);

  const onCanvasDrop = useCallback(
    (evt: DragEvent) => {
      const nodeId = evt.dataTransfer.getData(INFRA_DRAG_MIME);
      if (!nodeId) return;
      evt.preventDefault();
      const point = screenToFlowPosition({ x: evt.clientX, y: evt.clientY });
      const target = groupAtPoint(point);
      if (target) placeOn(nodeId, target);
      else setTargetPrompt({ x: evt.clientX, y: evt.clientY, nodeId });
    },
    [screenToFlowPosition, groupAtPoint, placeOn],
  );

  /** Drop zone used by the empty states (no groups yet → first target). */
  const emptyDropProps = {
    onDragOver: (e: DragEvent) => {
      if (!acceptsSidebarDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: DragEvent) => {
      const nodeId = e.dataTransfer.getData(INFRA_DRAG_MIME);
      if (!nodeId) return;
      e.preventDefault();
      setTargetPrompt({ x: e.clientX, y: e.clientY, nodeId });
    },
  };

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
      <div className="relative min-w-0 flex-1">
        {/* Environment switcher */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 p-1 text-xs shadow-xl shadow-black/30 backdrop-blur">
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
                {env.name}
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

        {groups.length === 0 ? (
          <div className="h-full" {...emptyDropProps}>
            <EmptyState icon={Server} title={`Nothing placed in ${activeEnv?.name ?? "this environment"}`}>
              Drag a component in from the right (or drop it here to name its first deployment
              target) to start the service map.
            </EmptyState>
          </div>
        ) : (
          <ReactFlow
            key={activeEnv?.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_e, n) => {
              if (n.type === "code") setSelectedId(n.id);
            }}
            onPaneClick={() => setSelectedId(null)}
            onDrop={onCanvasDrop}
            onDragOver={(e) => {
              if (!acceptsSidebarDrag(e)) return;
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
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
            <Controls
              position="bottom-left"
              showInteractive={false}
              className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
            />
            {simOn && simResult ? (
              <Panel position="bottom-center">
                <SimPanel
                  result={simResult}
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
        )}

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
        {selectedNode && activeEnv ? (
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

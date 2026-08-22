import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useStore } from "zustand";
import { AlertTriangle, Boxes, Cloud, Link2, RotateCcw, Server, Unlink, X } from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { IdentityLink } from "@crystal/core";
import { crossInfraStoreFor, useCrystal } from "@crystal/client";
import { EmptyState, cn } from "@crystal/ui";
import {
  buildCrossInfraScene,
  type CrossSceneNodeData,
} from "./cross-scene.js";
import { LinkServicesDialog } from "./LinkServicesDialog.js";

export interface CrossInfraViewProps {
  onEnterWorkspace: (ws: string) => void;
}

type FlowNode = Node<CrossSceneNodeData, "crossInfra">;
const MAX_PROJECT_EXTERNAL_ROWS = 6;

const IdentityActionsContext = createContext<{
  link: (members: IdentityLink["members"], label?: string) => void;
  unlink: (id: string) => void;
}>({ link: () => {}, unlink: () => {} });

const CrossInfraNode = memo(function CrossInfraNode({ data }: NodeProps<FlowNode>) {
  const identityActions = useContext(IdentityActionsContext);
  if (data.kind === "project") {
    return (
      <div
        className={cn(
          "relative h-full w-full rounded-xl border bg-surface-1/95 shadow-lg",
          data.error ? "border-danger/60" : "border-edge-strong",
        )}
      >
        <Handle type="target" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
        <div className="flex min-h-[70px] items-start justify-between gap-2 border-b border-edge px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-ink">{data.label}</div>
            <div className="mt-1 text-[10px] text-ink-faint">
              {data.error
                ? "Infrastructure unavailable"
                : data.envName ?? (data.hasEnvironments ? "No environment selected" : "No environments")}
            </div>
          </div>
          {data.unsharedExternalCount > 0 ? (
            <span className="shrink-0 rounded-full border border-edge bg-surface-2 px-1.5 py-0.5 text-[9px] text-ink-muted">
              {data.unsharedExternalCount} external{data.unsharedExternalCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {data.error ? (
          <div className="flex items-start gap-2 px-3 py-3 text-[10px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="line-clamp-2">{data.error}</span>
          </div>
        ) : null}
        {data.externals.length ? (
          <div className="absolute bottom-2 left-3 right-3 space-y-1">
            {data.externals.slice(0, MAX_PROJECT_EXTERNAL_ROWS).map((external) => (
              <div key={external.key} className="flex items-center justify-between gap-2 rounded border border-edge bg-surface-2 px-2 py-1">
                <span className="min-w-0 truncate text-[9px] text-ink-muted">{external.label}</span>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); identityActions.link([{ ws: data.ws, key: external.key }], external.label); }}
                  className="nodrag flex shrink-0 items-center gap-1 rounded px-1 text-[9px] text-crystal-400 hover:bg-surface-3 hover:text-crystal-300"
                ><Link2 className="h-2.5 w-2.5" /> Link…</button>
              </div>
            ))}
            {data.externals.length > MAX_PROJECT_EXTERNAL_ROWS ? (
              <div className="px-2 py-1 text-[9px] text-ink-faint">
                +{data.externals.length - MAX_PROJECT_EXTERNAL_ROWS} more
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (data.kind === "target") {
    return (
      <div className="h-full w-full rounded-lg border border-edge bg-surface-2 px-2 py-1.5 shadow-sm">
        <div className="flex items-start justify-between gap-1">
          <span className="line-clamp-2 text-[10px] font-medium leading-tight text-ink">{data.label}</span>
          <span className="rounded-full bg-crystal-500/15 px-1.5 py-0.5 text-[8px] text-crystal-300">
            {data.placedCount}
          </span>
        </div>
        <div className="mt-1 truncate text-[8px] uppercase tracking-wide text-ink-faint">{data.targetKind}</div>
        {data.detail ? <div className="mt-0.5 truncate text-[9px] text-ink-muted">{data.detail}</div> : null}
      </div>
    );
  }
  return (
    <div className="relative h-full w-full rounded-xl border border-crystal-500/40 bg-surface-2 px-3 py-2 shadow-lg">
      <Handle type="source" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2">
        <Cloud className="h-3.5 w-3.5 text-crystal-400" />
        <span className="truncate text-[11px] font-semibold text-ink">{data.label}</span>
      </div>
      <div className="mt-1 truncate text-[9px] text-ink-muted">{data.framing}</div>
      <div className="mt-1 text-[8px] text-ink-faint">{data.consumerCount} consuming projects</div>
      {data.warning ? <div className="mt-1 truncate text-[8px] text-warn">{data.warning}</div> : null}
      {data.identityLinkId ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); identityActions.unlink(data.identityLinkId!); }}
          className="nodrag absolute bottom-1.5 right-2 flex items-center gap-1 rounded px-1 text-[8px] text-ink-muted hover:bg-surface-3 hover:text-ink"
        ><Unlink className="h-2.5 w-2.5" /> Unlink</button>
      ) : (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); identityActions.link(data.members ?? [], data.label); }}
          className="nodrag absolute bottom-1.5 right-2 flex items-center gap-1 rounded px-1 text-[8px] text-crystal-400 hover:bg-surface-3 hover:text-crystal-300"
        ><Link2 className="h-2.5 w-2.5" /> Link…</button>
      )}
    </div>
  );
});

const NODE_TYPES = { crossInfra: CrossInfraNode };

export function CrossInfraView(props: CrossInfraViewProps) {
  return (
    <ReactFlowProvider>
      <CrossInfraInner {...props} />
    </ReactFlowProvider>
  );
}

function CrossInfraInner({ onEnterWorkspace }: CrossInfraViewProps) {
  const { client } = useCrystal();
  const store = useMemo(() => crossInfraStoreFor(client), [client]);
  const map = useStore(store, (state) => state.map);
  const overlay = useStore(store, (state) => state.overlay);
  const loading = useStore(store, (state) => state.loading);
  const error = useStore(store, (state) => state.error);
  const scene = useMemo(
    () => (map ? buildCrossInfraScene(map, overlay) : { nodes: [], edges: [], warnings: [] }),
    [map, overlay],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(scene.nodes as FlowNode[]);
  const { fitView } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const lastIds = useRef("");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState<{ nonce: number; members: IdentityLink["members"]; label?: string } | null>(null);
  const linkDialogNonce = useRef(0);
  const identityActions = useMemo(() => ({
    link: (members: IdentityLink["members"], label?: string) =>
      setLinkDialog({ nonce: ++linkDialogNonce.current, members, label }),
    unlink: (id: string) => store.getState().removeIdentityLink(id),
  }), [store]);

  useEffect(() => {
    void store.getState().ensure();
  }, [store]);

  useEffect(() => {
    setNodes(scene.nodes as FlowNode[]);
    const ids = scene.nodes.map((node) => node.id).sort().join("\0");
    if (!ids || ids === lastIds.current) return;
    lastIds.current = ids;
    const timer = setTimeout(() => void fitView({ padding: 0.18, maxZoom: 1.1 }), 60);
    return () => clearTimeout(timer);
  }, [scene.nodes, setNodes, fitView]);

  const sceneNodeIds = useMemo(() => scene.nodes.map((node) => node.id), [scene.nodes]);
  useEffect(() => {
    updateNodeInternals(sceneNodeIds);
  }, [sceneNodeIds, updateNodeInternals]);

  const edges = useMemo<Edge[]>(
    () =>
      scene.edges.map((edge) => ({
        ...edge,
        style: { stroke: "var(--color-crystal-400)", strokeWidth: 1.5, opacity: 0.8 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-crystal-400)" },
      })),
    [scene.edges],
  );

  if (loading && !map) {
    return <div className="grid h-full place-items-center text-xs text-ink-faint">Loading cross-project infrastructure…</div>;
  }
  if (error && !map) {
    return (
      <EmptyState icon={AlertTriangle} title="Could not load infrastructure">
        {error}
      </EmptyState>
    );
  }
  if (!map || map.projects.length < 2) {
    return (
      <div className="relative h-full bg-surface-0">
        <div className="absolute left-3 top-3 rounded-lg border border-edge bg-surface-2/95 px-2 py-1 text-[10px] text-ink-faint">
          Open another workspace (status bar picker) to see cross-project infrastructure
        </div>
        <EmptyState icon={Boxes} title="Open another workspace">
          Cross-project infrastructure appears when at least two workspaces are open.
        </EmptyState>
      </div>
    );
  }

  return (
    <IdentityActionsContext.Provider value={identityActions}>
    <div className="relative flex h-full min-h-0 flex-col bg-surface-0">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-edge bg-surface-1 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink">
            <Server className="h-3.5 w-3.5 text-crystal-400" />
            {map.projects.length} projects · {scene.nodes.filter((node) => node.data.kind === "shared").length} shared services
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {[...map.projects]
              .sort((a, b) => a.name.localeCompare(b.name) || a.ws.localeCompare(b.ws))
              .map((project) => (
                <div key={project.ws} className="flex items-center gap-1">
                  <span className="mr-1 text-[9px] text-ink-faint">{project.name}</span>
                  {project.environments.map((env) => (
                    <button
                      key={env.id}
                      type="button"
                      onClick={() => store.getState().setEnvSelection(project.ws, env.id)}
                      className={cn(
                        "rounded-full border px-1.5 py-0.5 text-[9px] transition-colors",
                        overlay?.envSelection[project.ws] === env.id ||
                          (!overlay?.envSelection[project.ws] &&
                            scene.nodes.some(
                              (node) => node.data.kind === "project" && node.data.ws === project.ws && node.data.envId === env.id,
                            ))
                          ? "border-crystal-500/50 bg-crystal-500/15 text-crystal-300"
                          : "border-edge bg-surface-2 text-ink-muted hover:text-ink",
                      )}
                    >
                      {env.name}
                    </button>
                  ))}
                </div>
              ))}
          </div>
        </div>
        <div className="flex max-w-64 shrink-0 flex-col items-end gap-1.5">
          <button
            type="button"
            disabled={!overlay || Object.keys(overlay.pins).length === 0}
            onClick={() => store.getState().clearPins()}
            className="flex items-center gap-1 rounded-lg border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-muted hover:text-ink disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" /> Reset arrangement
          </button>
          {error && error !== dismissedError ? (
            <div className="flex max-w-full items-center gap-2 rounded-lg border border-danger/40 bg-surface-2 px-2 py-1 text-[10px] text-danger">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{error}</span>
              <button
                type="button"
                aria-label="Dismiss error"
                onClick={() => setDismissedError(error)}
                className="rounded p-0.5 text-ink-muted hover:bg-surface-1 hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, node) => store.getState().setPin(node.id, node.position)}
          onNodeDoubleClick={(_, node) => {
            if (node.data.kind === "project") onEnterWorkspace(node.data.ws);
          }}
          fitView
          fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }}
          minZoom={0.08}
          maxZoom={2}
          nodesConnectable={false}
          panOnScroll
          proOptions={{ hideAttribution: true }}
          className="bg-surface-0"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
          <Controls position="bottom-left" showInteractive={false} className="!overflow-hidden !rounded-lg !border !border-edge !bg-surface-2 !shadow-lg" />
        </ReactFlow>
      </div>
      <LinkServicesDialog
        key={linkDialog?.nonce ?? "closed"}
        open={linkDialog != null}
        map={map}
        initialMembers={linkDialog?.members ?? []}
        initialLabel={linkDialog?.label}
        onOpenChange={(open) => { if (!open) setLinkDialog(null); }}
        onConfirm={(members, label) => store.getState().addIdentityLink(members, label)}
      />
    </div>
    </IdentityActionsContext.Provider>
  );
}

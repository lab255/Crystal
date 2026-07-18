import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  Component as ComponentIcon,
  Copy,
  GitCompareArrows,
  Plug,
  Waypoints,
  Webhook,
  X,
} from "lucide-react";
import type {
  CodeTraceStep,
  ScreenApiCall,
  ScreenSurface,
  SurfacesRefBundle,
  SystemEndpoint,
  SystemLink,
  SystemModule,
} from "@crystal/core";
import {
  RefCombobox,
  useCrystal,
  useNav,
  useNavUpdate,
  useSymbolMenu,
  useWorkerMemo,
  useWorkspaces,
} from "@crystal/client";
import {
  Badge,
  EmptyState,
  Pane as SplitPane,
  Split,
  Spinner,
  Tooltip,
  cn,
  useContextMenu,
  useSidePaneLayout,
  type MenuEntry,
} from "@crystal/ui";
import { ROLE_META } from "@crystal/architect";
import { MethodChip } from "../ApiExplorer.js";
import { DetailSection, FileLink, copyText, useSurfaces } from "../common.js";
import { TraceSection, useEndpointTrace } from "../trace.js";
import {
  buildSystemMapLayout,
  decorateSystemMapScene,
  epKeyOf,
  epNodeId,
  screenNodeId,
  type MapBandRfNode,
  type MapDiffMark,
  type MapExternalsRfNode,
  type MapFeGroupRfNode,
  type MapScreenRfNode,
  type MapSystemRfNode,
  type SystemMapLayout,
  type SystemMapLayoutInput,
  type SystemMapNode,
} from "./scene.js";
import { diffSystemMap, type MapDiffEntry, type SystemMapDiff } from "./diff.js";

/**
 * System map — the whole stack on one navigable canvas: frontend screens,
 * backend systems with their API endpoints, data systems and integrations,
 * with edges showing which screens call which backend systems.
 *
 * Interaction follows the house convention: single click selects (neighbors
 * stay bright, the rest dims), double click navigates (screens view, API
 * explorer, architecture view), and the inspector is an embedded side pane —
 * never a mode jump. Selection is nav-held (`#/surfaces/map?node=…`).
 */

const EMPTY_CALLS: ScreenApiCall[] = [];

/** Off-thread layout build; null disables the worker path (tests). */
const makeSystemMapWorker =
  typeof Worker === "undefined"
    ? null
    : () => new Worker(new URL("./system-map.worker.ts", import.meta.url), { type: "module" });

const SOURCE_BADGE: Record<ScreenSurface["source"], string> = {
  "next-app": "next/app",
  "next-pages": "next/pages",
  "react-router": "router",
  convention: "conv",
};

/* ------------------------------------------------------------------ */
/* Node renderers                                                      */
/* ------------------------------------------------------------------ */

/** Ref-review chip: what happened to this card since the base ref. */
function MarkBadge({ mark }: { mark?: MapDiffMark }) {
  if (!mark) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-[9px]",
        mark === "added" && "bg-ok/15 text-ok",
        mark === "removed" && "bg-danger/15 text-danger",
        mark === "modified" && "bg-warn/15 text-warn",
      )}
    >
      {mark === "added" ? "new" : mark === "removed" ? "gone" : "changed"}
    </span>
  );
}

function MapBandNode({ data }: NodeProps<MapBandRfNode>) {
  return (
    <div className="h-full w-full rounded-2xl border border-edge/80 bg-surface-2/40">
      <div className="px-4 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {data.label}
      </div>
    </div>
  );
}

function MapScreenNode({ data }: NodeProps<MapScreenRfNode>) {
  const { screen, callCount, unmatchedCount, selected, dimmed, mark } = data;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center rounded-lg border bg-surface-1 px-2.5 py-1 shadow-sm transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        mark === "removed" && "border-dashed",
        dimmed && "opacity-25",
        !dimmed && mark === "removed" && "opacity-50",
      )}
      style={{ borderTopColor: "var(--color-accent-cyan)", borderTopWidth: 2 }}
    >
      <Handle id="b" type="source" position={Position.Bottom} className="!bg-edge" />
      <div className="flex items-center gap-1.5">
        <AppWindow className="h-3 w-3 shrink-0 text-accent-cyan" />
        <span className="min-w-0 truncate font-mono text-[11px] font-medium text-ink">
          {screen.route}
        </span>
        <MarkBadge mark={mark} />
        <span className="ml-auto shrink-0 rounded bg-surface-3 px-1 text-[8px] uppercase text-ink-faint">
          {SOURCE_BADGE[screen.source]}
        </span>
      </div>
      <div className="flex items-center gap-1 pl-[18px] text-[9px] text-ink-faint">
        <span className="min-w-0 truncate">{screen.component ?? screen.file}</span>
        {callCount > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <span>
              {callCount} call{callCount === 1 ? "" : "s"}
            </span>
            {unmatchedCount > 0 ? (
              <span
                title={`${unmatchedCount} call${unmatchedCount === 1 ? "" : "s"} with no serving route in this workspace`}
                className="flex items-center gap-0.5 text-warn"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                {unmatchedCount}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MapFeGroupNode({ data }: NodeProps<MapFeGroupRfNode>) {
  const { system, screenCount, selected, dimmed, mark } = data;
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border bg-surface-1/60 transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        mark === "removed" && "border-dashed",
        dimmed && "opacity-25",
      )}
      style={{ borderTopColor: "var(--color-accent-cyan)", borderTopWidth: 2 }}
    >
      <Handle id="t" type="target" position={Position.Top} className="!bg-edge" />
      <Handle id="b" type="source" position={Position.Bottom} className="!bg-edge" />
      <div className="flex items-center gap-2 px-3 pt-2">
        <AppWindow className="h-3.5 w-3.5 shrink-0 text-accent-cyan" />
        <span className="truncate text-[12px] font-semibold text-ink">{system.name}</span>
        <MarkBadge mark={mark} />
        <span className="shrink-0 text-[10px] text-ink-faint">
          {screenCount} screen{screenCount === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function MapSystemNode({ data }: NodeProps<MapSystemRfNode>) {
  const {
    system,
    endpointsShown,
    moreEndpoints,
    schemaCount,
    externals,
    compact,
    selected,
    dimmed,
    selectedEndpoint,
    mark,
    epMarks,
    onEndpointClick,
    onEndpointDoubleClick,
  } = data;
  const meta = ROLE_META[system.role];
  const Icon = system.layer === "frontend" ? AppWindow : meta.icon;
  const accent =
    system.layer === "database"
      ? "var(--color-accent-emerald)"
      : system.layer === "frontend"
        ? "var(--color-accent-cyan)"
        : meta.accent;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-surface-1 shadow-sm transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        mark === "removed" && "border-dashed",
        dimmed && "opacity-25",
        !dimmed && mark === "removed" && "opacity-50",
      )}
      style={{ borderTopColor: accent, borderTopWidth: 2 }}
    >
      <Handle id="t" type="target" position={Position.Top} className="!bg-edge" />
      <Handle id="l" type="target" position={Position.Left} className="!bg-edge" />
      <Handle id="r" type="source" position={Position.Right} className="!bg-edge" />
      <Handle id="b" type="source" position={Position.Bottom} className="!bg-edge" />
      <div className="flex items-start gap-2 px-3 pt-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-semibold text-ink">{system.name}</span>
            <MarkBadge mark={mark} />
          </div>
          <div className="truncate text-[10px] text-ink-faint">
            {system.fileCount} files
            {system.endpoints.length > 0
              ? ` · ${system.endpoints.length} route${system.endpoints.length === 1 ? "" : "s"}`
              : ""}
            {schemaCount > 0 ? ` · ${schemaCount} schema${schemaCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </div>
      {!compact && endpointsShown.length > 0 ? (
        <div className="mt-1.5 border-t border-edge/60 px-3 pt-1">
          <div className="text-[9px] font-medium uppercase tracking-wide text-ink-faint">API</div>
          {endpointsShown.map((ep) => {
            const key = epKeyOf(ep);
            const epMark = epMarks?.[key];
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                title={`${key} — click to inspect, double-click for the API explorer`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEndpointClick?.(system.id, ep);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onEndpointDoubleClick?.(system.id, ep);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    onEndpointClick?.(system.id, ep);
                  }
                }}
                className={cn(
                  "nodrag -mx-1 flex cursor-pointer items-center gap-1.5 rounded px-1 leading-[18px]",
                  selectedEndpoint === key
                    ? "bg-crystal-500/15"
                    : epMark === "added"
                      ? "bg-ok/10 hover:bg-ok/15"
                      : epMark === "removed"
                        ? "bg-danger/10 hover:bg-danger/15"
                        : "hover:bg-surface-2",
                )}
              >
                <MethodChip method={ep.method} className="!text-[8px]" />
                <span
                  className={cn(
                    "min-w-0 truncate font-mono text-[10px]",
                    epMark === "added"
                      ? "text-ok"
                      : epMark === "removed"
                        ? "text-danger line-through"
                        : "text-ink-muted",
                  )}
                >
                  {ep.path}
                </span>
              </div>
            );
          })}
          {moreEndpoints > 0 ? (
            <div className="text-[9px] leading-[16px] text-ink-faint">+{moreEndpoints} more</div>
          ) : null}
        </div>
      ) : null}
      {!compact && externals.length > 0 ? (
        <div className="mt-auto border-t border-edge/60 px-3 pb-2 pt-1">
          <div className="text-[9px] font-medium uppercase tracking-wide text-ink-faint">
            Talks to
          </div>
          <div className="truncate text-[10px] leading-[18px] text-accent-amber">
            {externals
              .slice(0, 3)
              .map((x) => x.name)
              .join(", ")}
            {externals.length > 3 ? ` +${externals.length - 3}` : ""}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MapExternalsNode({ data }: NodeProps<MapExternalsRfNode>) {
  const { externals, more, dimmed } = data;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border border-edge bg-surface-1 shadow-sm transition-opacity",
        dimmed && "opacity-25",
      )}
      style={{ borderTopColor: "var(--color-accent-amber)", borderTopWidth: 2 }}
    >
      {/* No handles: nothing draws edges to the aggregated externals card. */}
      <div className="flex items-start gap-2 px-3 pt-2">
        <Plug className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-amber" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-ink">External services</div>
          <div className="truncate text-[10px] text-ink-faint">across every system</div>
        </div>
      </div>
      {externals.length > 0 ? (
        <div className="mt-1.5 border-t border-edge/60 px-3 pt-1">
          {externals.map((x) => (
            <div key={x.id} className="flex items-baseline gap-1.5 leading-[18px]">
              <span className="min-w-0 truncate text-[10px] text-ink-muted">{x.name}</span>
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{x.weight}</span>
            </div>
          ))}
          {more > 0 ? (
            <div className="text-[9px] leading-[16px] text-ink-faint">+{more} more</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  mapBand: MapBandNode,
  mapScreen: MapScreenNode,
  mapFeGroup: MapFeGroupNode,
  mapSystem: MapSystemNode,
  mapExternals: MapExternalsNode,
};

/** Minimap swatch per node — the same accents the cards carry. */
function minimapColor(n: SystemMapNode): string {
  switch (n.type) {
    case "mapScreen":
      return "var(--color-accent-cyan)";
    case "mapFeGroup":
      return "var(--color-surface-3)";
    case "mapExternals":
      return "var(--color-accent-amber)";
    case "mapSystem": {
      const sys = (n.data as MapSystemRfNode["data"]).system;
      if (sys.layer === "database") return "var(--color-accent-emerald)";
      if (sys.layer === "frontend") return "var(--color-accent-cyan)";
      return ROLE_META[sys.role].accent;
    }
    default:
      return "var(--color-surface-2)";
  }
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function SystemMapView() {
  return (
    <ReactFlowProvider>
      <SystemMapInner />
    </ReactFlowProvider>
  );
}

function SystemMapInner() {
  const { report, overview, map, loading } = useSurfaces();
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const nav = useNavUpdate();
  const { fitView } = useReactFlow();
  const sidePane = useSidePaneLayout();
  const selected = useNav((l) => l.surfaces?.node ?? null);
  const find = useNav((l) => l.surfaces?.find) ?? "";
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();

  const calls = map?.calls ?? EMPTY_CALLS;
  const setSelected = useCallback(
    (id: string | null) => nav({ surfaces: { node: id } }),
    [nav],
  );

  /* ---- ref review: the map diffed against a git ref ---- */
  const [refBundle, setRefBundle] = useState<SurfacesRefBundle | null>(null);
  const [refInput, setRefInput] = useState("");
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  // The clicked change — the review panel scrolls to and spotlights this row.
  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  // Ref bundles are workspace-scoped snapshots — never diff one against
  // another workspace's live data.
  useEffect(() => {
    setRefBundle(null);
    setRefError(null);
    setDiffFocus(null);
  }, [activeWs]);
  const reviewRef = useCallback(
    async (ref: string) => {
      if (!ref.trim()) return;
      setRefLoading(true);
      setRefError(null);
      try {
        setRefBundle(await client.request("surfaces.atRef", { ref: ref.trim() }));
        setDiffFocus(null);
      } catch (err) {
        setRefError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefLoading(false);
      }
    },
    [client],
  );
  const exitReview = useCallback(() => {
    setRefBundle(null);
    setRefError(null);
    setDiffFocus(null);
  }, []);

  const diff = useMemo<SystemMapDiff | null>(
    () =>
      refBundle && report && overview
        ? diffSystemMap(
            { report: refBundle.report, overview: refBundle.overview, calls: refBundle.calls },
            { report, overview, calls },
          )
        : null,
    [refBundle, report, overview, calls],
  );

  // Two-phase build: dagre + attribution re-run only when the data moves;
  // clicking a node or typing in find just re-decorates the laid-out scene.
  // A ref review swaps in the ghost-merged inputs (removed things render).
  // The expensive phase runs in a module worker (falls back to sync where
  // Workers don't exist); the previous layout holds while a new one computes.
  const layoutInput = useMemo<SystemMapLayoutInput | null>(
    () => (diff ? diff.merged : report && overview ? { report, overview, calls } : null),
    [diff, report, overview, calls],
  );
  const { value: layout } = useWorkerMemo<SystemMapLayoutInput, SystemMapLayout>(
    makeSystemMapWorker,
    buildSystemMapLayout,
    layoutInput,
  );
  const scene = useMemo(
    () =>
      layout
        ? decorateSystemMapScene(layout, { selected, find, marks: diff?.marks ?? null })
        : null,
    [layout, selected, find, diff],
  );

  /** The review entry a canvas element anchors (nodes prefer node entries). */
  const focusEntryFor = useCallback(
    (kind: "node" | "edge", id: string): MapDiffEntry | null => {
      if (!diff) return null;
      return (
        diff.entries.find((e) => (kind === "node" ? e.nodeId === id && !e.edgeId : e.edgeId === id)) ??
        diff.entries.find((e) => (kind === "node" ? e.nodeId === id : false)) ??
        null
      );
    },
    [diff],
  );

  /* endpoint-row interactions, injected into system-card node data */
  const onEndpointClick = useCallback(
    (_sysId: string, ep: SystemEndpoint) => setSelected(epNodeId(ep)),
    [setSelected],
  );
  const onEndpointDoubleClick = useCallback(
    (sysId: string, ep: SystemEndpoint) =>
      nav({ surfaces: { view: "apis", api: epKeyOf(ep), system: sysId } }),
    [nav],
  );
  const nodes = useMemo<SystemMapNode[]>(
    () =>
      (scene?.nodes ?? []).map((n) =>
        n.type === "mapSystem"
          ? ({
              ...n,
              data: { ...n.data, onEndpointClick, onEndpointDoubleClick },
            } as SystemMapNode)
          : n,
      ),
    [scene, onEndpointClick, onEndpointDoubleClick],
  );

  // Esc clears the selection (the context menu consumes its own Escape).
  // Gated on the active mode — hidden-but-mounted modes must not swallow the
  // key (same pattern as the find shortcut) — and text inputs keep their own
  // Escape semantics.
  const activeMode = useNav((l) => l.mode) ?? "surfaces";
  useEffect(() => {
    if (activeMode !== "surfaces") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !selected) return;
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode, selected, setSelected]);

  // Refit when the data or the filter reshape the canvas (not on selection).
  // Entering/leaving a ref review reshapes it too (ghosts appear/vanish).
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.15, duration: 300 }), 120);
    return () => clearTimeout(t);
  }, [report, overview, map, find, refBundle, fitView]);

  /* navigation targets (double click / context menus / inspector) */
  const openScreen = useCallback(
    (s: ScreenSurface) => nav({ surfaces: { view: "screens", screen: s.id } }),
    [nav],
  );
  const openSystemInArchitect = useCallback(
    (sysId: string) =>
      nav({ mode: "architect", architect: { view: "systems", system: sysId, edge: null } }),
    [nav],
  );
  const openApi = useCallback(
    (epKey: string, sysId?: string) =>
      nav({ surfaces: { view: "apis", api: epKey, ...(sysId ? { system: sysId } : {}) } }),
    [nav],
  );

  const screenMenu = useCallback(
    (s: ScreenSurface): MenuEntry[] => [
      { type: "heading", label: s.route },
      {
        type: "item",
        label: "Open in screens view",
        icon: AppWindow,
        onSelect: () => openScreen(s),
      },
      ...(s.component
        ? [
            {
              type: "item" as const,
              label: "Show component",
              icon: ComponentIcon,
              hint: s.component,
              onSelect: () =>
                nav({
                  surfaces: {
                    view: "components",
                    component: `${s.componentFile ?? s.file}#${s.component}`,
                  },
                }),
            },
          ]
        : []),
      ...symbolMenu({ file: s.file, line: s.line, label: s.route }),
      {
        type: "item",
        label: "Copy route",
        icon: Copy,
        hint: s.route,
        onSelect: () => copyText(s.route),
      },
    ],
    [nav, openScreen, symbolMenu],
  );

  const systemMenu = useCallback(
    (sys: SystemModule): MenuEntry[] => [
      { type: "heading", label: sys.name },
      {
        type: "item",
        label: "Open in architecture view",
        icon: Boxes,
        onSelect: () => openSystemInArchitect(sys.id),
      },
      ...(sys.endpoints.length > 0
        ? [
            {
              type: "item" as const,
              label: "Explore APIs",
              icon: Webhook,
              hint: `${sys.endpoints.length}`,
              onSelect: () =>
                nav({ surfaces: { view: "apis", system: sys.id, api: null } }),
            },
          ]
        : []),
      ...symbolMenu({ module: sys.parts[0]?.pkg, label: sys.name }),
      {
        type: "item",
        label: "Copy system id",
        icon: Copy,
        hint: sys.id,
        onSelect: () => copyText(sys.id),
      },
    ],
    [nav, openSystemInArchitect, symbolMenu],
  );

  if (loading && (!report || !overview)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!scene || scene.empty) {
    return (
      <EmptyState icon={Waypoints} title="Nothing to map yet">
        The system map appears once the workspace has analyzable source — screens, backend
        routes and systems all land here.
      </EmptyState>
    );
  }

  const screens = report?.screens ?? [];
  // The builder resolved the deep link already (staleness- and fixture-aware);
  // re-deriving here would let the inspector and the canvas disagree.
  const selection = scene.selection;
  const selectedScreen = selection?.kind === "screen" ? selection.screen : null;
  const selectedSystem = selection?.kind === "system" ? selection.system : null;
  const selectedEp = selection?.kind === "endpoint" ? selection.epKey : null;
  const epOwner = selection?.kind === "endpoint" ? selection.owner : null;
  // A focused change keeps the review panel on top of the inspector — the
  // click's job is to spotlight the specific change, not the generic card.
  const diffPanelOpen = diff != null && (diffFocus != null || selection == null);
  const inspectorOpen = selection != null && !diffPanelOpen;

  return (
    <Split storageKey="surfaces:map" direction="horizontal">
      <SplitPane minSize="45%">
        <div className="relative h-full min-h-0">
          <ReactFlow
            nodes={nodes}
            edges={scene.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_evt, n) => {
              if (n.type !== "mapScreen" && n.type !== "mapSystem" && n.type !== "mapFeGroup")
                return;
              setSelected(n.id === selected ? null : n.id);
              // In a ref review, clicking a marked card spotlights its change.
              setDiffFocus(focusEntryFor("node", n.id)?.key ?? null);
            }}
            onEdgeClick={(_evt, e) => {
              // Edges only interact during a ref review: a marked (colored)
              // edge spotlights the specific change in the review panel.
              const entry = focusEntryFor("edge", e.id);
              if (entry) setDiffFocus(entry.key);
            }}
            onNodeDoubleClick={(_evt, n) => {
              if (n.type === "mapScreen") openScreen((n.data as MapScreenRfNode["data"]).screen);
              else if (n.type === "mapSystem" || n.type === "mapFeGroup")
                openSystemInArchitect(n.id);
            }}
            onPaneClick={() => {
              setSelected(null);
              setDiffFocus(null);
            }}
            onNodeContextMenu={(evt, n) => {
              evt.preventDefault();
              if (n.type === "mapScreen") {
                menu.open(evt, screenMenu((n.data as MapScreenRfNode["data"]).screen));
              } else if (n.type === "mapSystem" || n.type === "mapFeGroup") {
                const sys = (n.data as { system: SystemModule }).system;
                menu.open(evt, systemMenu(sys));
              }
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            fitView
            minZoom={0.1}
            panOnScroll
            zoomOnPinch
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls
              position="bottom-left"
              showInteractive={false}
              className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden"
            />
            <MiniMap
              pannable
              zoomable
              className="!bottom-3 !right-3 !h-32 !w-44 rounded-lg border border-edge !bg-surface-1"
              maskColor="color-mix(in srgb, var(--color-surface-0) 72%, transparent)"
              nodeStrokeWidth={0}
              nodeColor={minimapColor}
            />
          </ReactFlow>
          {/* Top-left: what the map is made of. */}
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 text-[10px] text-ink-faint shadow-sm">
            <Waypoints className="h-3 w-3 text-crystal-300" />
            <span>
              {scene.stats.screens} screen{scene.stats.screens === 1 ? "" : "s"} ·{" "}
              {scene.stats.systems} systems · {scene.edges.length} edges
            </span>
            {scene.fixturesHidden > 0 ? (
              <Tooltip content="Sample codebases (examples/, fixtures/…) stay off the map — open one as its own workspace to chart it">
                <span>· {scene.fixturesHidden} fixture units hidden</span>
              </Tooltip>
            ) : null}
            {scene.quietHidden > 0 ? (
              <Tooltip content="Shared/platform systems with no endpoints, screens, schemas or traced calls are trimmed — the architecture view shows everything">
                <span>
                  · {scene.quietHidden} platform system{scene.quietHidden === 1 ? "" : "s"} trimmed
                </span>
              </Tooltip>
            ) : null}
            {map?.truncated ? (
              <Tooltip content="Some call traces hit the traversal cap — screen edges may be missing">
                <span className="text-warn">capped</span>
              </Tooltip>
            ) : null}
          </div>
          {/* Legend — the map's visual language at a glance. */}
          <div className="absolute left-3 top-11 flex items-center gap-3 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 text-[9px] text-ink-faint shadow-sm">
            <span className="flex items-center gap-1">
              <svg width="18" height="6" aria-hidden>
                <line
                  x1="0"
                  y1="3"
                  x2="18"
                  y2="3"
                  stroke="var(--color-accent-amber)"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                />
              </svg>
              API traffic
            </span>
            <span className="flex items-center gap-1">
              <svg width="18" height="6" aria-hidden>
                <line
                  x1="0"
                  y1="3"
                  x2="18"
                  y2="3"
                  stroke="var(--color-edge-strong)"
                  strokeWidth="2"
                />
              </svg>
              imports ×N
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="h-2.5 w-2.5 text-warn" />
              call with no serving route
            </span>
            {diff ? (
              <>
                <span className="flex items-center gap-1 text-ok">
                  <svg width="14" height="6" aria-hidden>
                    <line x1="0" y1="3" x2="14" y2="3" stroke="var(--color-ok)" strokeWidth="2" />
                  </svg>
                  added
                </span>
                <span className="flex items-center gap-1 text-danger">
                  <svg width="14" height="6" aria-hidden>
                    <line
                      x1="0"
                      y1="3"
                      x2="14"
                      y2="3"
                      stroke="var(--color-danger)"
                      strokeWidth="2"
                      strokeDasharray="5 4"
                    />
                  </svg>
                  removed
                </span>
                <span className="flex items-center gap-1 text-warn">
                  <svg width="14" height="6" aria-hidden>
                    <line x1="0" y1="3" x2="14" y2="3" stroke="var(--color-warn)" strokeWidth="2" />
                  </svg>
                  changed
                </span>
              </>
            ) : null}
          </div>
          {/* Top-right: review the map against a git ref. */}
          <div className="absolute right-3 top-3 flex items-center gap-1.5">
            {refBundle ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 text-[10px] shadow-sm">
                <GitCompareArrows className="h-3 w-3 text-crystal-300" />
                <span className="text-ink">
                  vs {refBundle.ref}
                  <span className="ml-1 text-ink-faint">{refBundle.commit}</span>
                </span>
                <button
                  type="button"
                  onClick={exitReview}
                  aria-label="Exit ref review"
                  className="rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void reviewRef(refInput);
                }}
                className="flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm"
              >
                <GitCompareArrows className="h-3 w-3 shrink-0 text-ink-faint" />
                {/* The shared picker: branches, remotes, tags and recent
                    commits — free-typing still reaches anything git resolves. */}
                <RefCombobox
                  value={refInput}
                  onChange={setRefInput}
                  onSubmit={(v) => void reviewRef(v)}
                  placeholder="Review vs ref…"
                  className="w-44"
                  inputClassName="h-6 rounded-md border-0 bg-transparent px-1 text-[11px] focus:ring-0"
                />
                <button
                  type="submit"
                  disabled={refLoading || !refInput.trim()}
                  className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted hover:text-ink disabled:opacity-50"
                >
                  {refLoading ? "Analyzing…" : "Review"}
                </button>
              </form>
            )}
          </div>
          {refError ? (
            <div className="absolute right-3 top-12 max-w-72 rounded-lg border border-danger/40 bg-surface-1/95 px-2 py-1 text-[10px] text-danger shadow-sm">
              {refError}
            </div>
          ) : null}
        </div>
      </SplitPane>
      {diffPanelOpen && diff && refBundle ? (
        <SplitPane defaultSize={sidePane.defaultSize} minSize={320} maxSize="60%">
          <MapDiffPanel
            diff={diff}
            refName={refBundle.ref}
            commit={refBundle.commit}
            focus={diffFocus}
            onFocus={setDiffFocus}
            onSelect={setSelected}
            onClose={exitReview}
          />
        </SplitPane>
      ) : inspectorOpen ? (
        <SplitPane defaultSize={sidePane.defaultSize} minSize={320} maxSize="60%">
          <div className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-edge bg-surface-0">
            <InspectorHeader
              title={
                selectedScreen?.route ??
                selectedSystem?.name ??
                (selectedEp && epOwner ? selectedEp : "")
              }
              onClose={() => setSelected(null)}
            />
            {selectedScreen ? (
              <ScreenInspector
                screen={selectedScreen}
                calls={calls}
                onOpenScreen={openScreen}
                onOpenApi={openApi}
              />
            ) : selectedSystem ? (
              <SystemInspector
                system={selectedSystem}
                onSelectSystem={setSelected}
                onSelectEndpoint={(ep) => setSelected(epNodeId(ep))}
                onOpenApi={openApi}
                onOpenArchitect={openSystemInArchitect}
              />
            ) : selectedEp && epOwner ? (
              <EndpointInspector
                epKey={selectedEp}
                owner={epOwner}
                screens={screens}
                calls={calls}
                onSelectScreen={(s) => setSelected(screenNodeId(s.id))}
                onOpenApi={openApi}
              />
            ) : null}
          </div>
        </SplitPane>
      ) : null}
      {menu.element}
    </Split>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector panes                                                     */
/* ------------------------------------------------------------------ */

function InspectorHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-3">
      <Waypoints className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
      <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-ink">{title}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close inspector"
        className="ml-auto rounded-md p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** The ref review's change list — every row anchors a canvas element. */
function MapDiffPanel({
  diff,
  refName,
  commit,
  focus,
  onFocus,
  onSelect,
  onClose,
}: {
  diff: SystemMapDiff;
  refName: string;
  commit: string;
  /** `MapDiffEntry.key` to spotlight (set by canvas clicks on marked elements). */
  focus: string | null;
  onFocus: (key: string | null) => void;
  onSelect: (nodeId: string | null) => void;
  onClose: () => void;
}) {
  // Sections keep first-appearance order — the diff builder emits them
  // grouped (screens, systems, links, endpoints, flows).
  const sections = useMemo(() => {
    const out = new Map<string, MapDiffEntry[]>();
    for (const e of diff.entries) {
      const list = out.get(e.section) ?? [];
      list.push(e);
      out.set(e.section, list);
    }
    return out;
  }, [diff]);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-edge bg-surface-0">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-3">
        <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 truncate text-[12px] font-semibold text-ink">
          Review vs {refName}
        </span>
        <span className="shrink-0 text-[10px] text-ink-faint">
          {diff.total === 0
            ? "no surface changes"
            : `${diff.total} change${diff.total === 1 ? "" : "s"} · ${commit}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Exit ref review"
          className="ml-auto rounded-md p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {diff.total === 0 ? (
        <div className="px-4 py-3 text-[11px] text-ink-faint">
          The map looks the same at {refName} — screens, endpoints and call flows all match.
        </div>
      ) : (
        [...sections.entries()].map(([section, entries]) => (
          <div key={section} className="border-b border-edge/60 px-3 py-2">
            <div className="pb-1 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
              {section}
            </div>
            {entries.map((e) => {
              const highlighted = focus === e.key;
              return (
                <button
                  key={e.key}
                  type="button"
                  ref={(el) => {
                    if (highlighted) el?.scrollIntoView({ block: "nearest" });
                  }}
                  onClick={() => {
                    onFocus(e.key);
                    if (e.nodeId) onSelect(e.nodeId);
                  }}
                  className={cn(
                    "block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2",
                    highlighted && "bg-surface-2 ring-1 ring-inset ring-ink/25",
                  )}
                >
                  <div
                    className={cn(
                      "truncate font-mono text-[11px]",
                      e.mark === "added"
                        ? "text-ok"
                        : e.mark === "removed"
                          ? "text-danger"
                          : "text-warn",
                    )}
                  >
                    {e.label}
                  </div>
                  {e.detail ? (
                    <div className="truncate text-[9px] leading-snug text-ink-faint">{e.detail}</div>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}

function ScreenInspector({
  screen,
  calls,
  onOpenScreen,
  onOpenApi,
}: {
  screen: ScreenSurface;
  calls: readonly ScreenApiCall[];
  onOpenScreen: (s: ScreenSurface) => void;
  onOpenApi: (epKey: string, sysId?: string) => void;
}) {
  const nav = useNavUpdate();
  const { systemOfFile } = useSurfaces();
  const mine = calls.filter((c) => c.screen === screen.id);
  return (
    <>
      <div className="border-b border-edge/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <Badge tone="slate">screen</Badge>
          {screen.component ? (
            <button
              type="button"
              onClick={() =>
                nav({
                  surfaces: {
                    view: "components",
                    component: `${screen.componentFile ?? screen.file}#${screen.component}`,
                  },
                })
              }
              className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 hover:text-ink"
            >
              <ComponentIcon className="h-3 w-3 text-accent-violet" />
              {screen.component}
            </button>
          ) : null}
          <FileLink file={screen.file} line={screen.line} />
        </div>
        <button
          type="button"
          onClick={() => onOpenScreen(screen)}
          className="mt-2 flex items-center gap-1 text-[10px] text-crystal-300 hover:text-crystal-200"
        >
          <ArrowUpRight className="h-3 w-3" /> Open in screens view
        </button>
      </div>
      <DetailSection
        title={`Outgoing calls · ${mine.length}`}
        hint="HTTP calls reachable from this screen, matched to served endpoints"
      >
        {mine.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No API calls reach this screen's component graph.
          </div>
        ) : (
          <div className="space-y-0.5">
            {mine.map((c, i) => {
              const target = c.endpoint ? systemOfFile(c.endpoint.file) : null;
              return (
                <div
                  key={`${c.method} ${c.path} ${i}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (c.endpoint) onOpenApi(epKeyOf(c.endpoint), target?.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && c.endpoint) onOpenApi(epKeyOf(c.endpoint), target?.id);
                  }}
                  title={
                    c.endpoint
                      ? "Open in the API explorer"
                      : "No matching endpoint in this workspace"
                  }
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
                    c.endpoint ? "cursor-pointer hover:bg-surface-2" : "opacity-70",
                  )}
                >
                  <MethodChip method={c.method} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[10px] text-ink">{c.path}</span>
                    <span className="block truncate text-[9px] text-ink-faint">
                      {c.endpoint
                        ? `→ ${c.endpoint.file}${target ? ` · ${target.name}` : ""}`
                        : "no matching endpoint"}
                    </span>
                  </span>
                  {c.endpoint ? <Webhook className="h-3 w-3 shrink-0 text-ink-faint" /> : null}
                </div>
              );
            })}
          </div>
        )}
      </DetailSection>
    </>
  );
}

function SystemInspector({
  system,
  onSelectSystem,
  onSelectEndpoint,
  onOpenApi,
  onOpenArchitect,
}: {
  system: SystemModule;
  onSelectSystem: (sysId: string) => void;
  onSelectEndpoint: (ep: SystemEndpoint) => void;
  onOpenApi: (epKey: string, sysId?: string) => void;
  onOpenArchitect: (sysId: string) => void;
}) {
  const meta = ROLE_META[system.role];
  const { overview } = useSurfaces();
  // Relationship insight, same shape the architecture inspector shows:
  // who this system consumes and who consumes it, weighted by imports
  // (plus matched API calls, which carry weight-0 links).
  const relations = useMemo(() => {
    const links = overview?.links ?? [];
    const nameOf = (id: string) =>
      overview?.systems.find((s) => s.id === id)?.name ?? id.replace(/^sys:/, "");
    const describe = (l: SystemLink, otherId: string) => ({
      id: otherId,
      name: nameOf(otherId),
      weight: l.weight,
      apiCount: l.apis?.length ?? 0,
    });
    return {
      uses: links.filter((l) => l.source === system.id).map((l) => describe(l, l.target)),
      usedBy: links.filter((l) => l.target === system.id).map((l) => describe(l, l.source)),
    };
  }, [overview, system.id]);
  return (
    <>
      <div className="border-b border-edge/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <span
            className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px]"
            style={{ color: meta.accent }}
          >
            <meta.icon className="h-3 w-3" />
            {meta.label}
          </span>
          <span className="text-[10px] text-ink-faint">
            {system.fileCount} files · {system.layer}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onOpenArchitect(system.id)}
          className="mt-2 flex items-center gap-1 text-[10px] text-crystal-300 hover:text-crystal-200"
        >
          <Boxes className="h-3 w-3" /> Open in architecture view
        </button>
      </div>
      {relations.uses.length > 0 || relations.usedBy.length > 0 ? (
        <DetailSection
          title="Connections"
          hint="import/API links from the code map · click selects the system"
        >
          <div className="space-y-0.5">
            {(["uses", "usedBy"] as const).flatMap((dir) =>
              relations[dir].map((r) => (
                <div
                  key={`${dir}:${r.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectSystem(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelectSystem(r.id);
                  }}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
                >
                  {dir === "uses" ? (
                    <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
                  ) : (
                    <ArrowDownLeft className="h-3 w-3 shrink-0 text-ink-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[10px] text-ink">
                    {dir === "uses" ? `uses ${r.name}` : `used by ${r.name}`}
                  </span>
                  <span className="shrink-0 text-[9px] text-ink-faint">
                    {r.weight > 0 ? `×${r.weight}` : ""}
                    {r.apiCount > 0 ? `${r.weight > 0 ? " · " : ""}${r.apiCount} API` : ""}
                  </span>
                </div>
              )),
            )}
          </div>
        </DetailSection>
      ) : null}
      {system.endpoints.length > 0 ? (
        <DetailSection
          title={`Endpoints · ${system.endpoints.length}`}
          hint="click selects on the map · webhook opens the API explorer"
        >
          <div className="space-y-0.5">
            {system.endpoints.map((ep) => {
              const key = epKeyOf(ep);
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEndpoint(ep)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelectEndpoint(ep);
                  }}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
                >
                  <MethodChip method={ep.method} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                    {ep.path}
                  </span>
                  <Tooltip content="Open in the API explorer">
                    <button
                      type="button"
                      aria-label={`Open ${key} in the API explorer`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenApi(key, system.id);
                      }}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                    >
                      <Webhook className="h-3 w-3" />
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        </DetailSection>
      ) : null}
      {system.exports.length > 0 ? (
        <DetailSection title="Top exports" hint="most-consumed first">
          <div className="space-y-0.5">
            {system.exports.slice(0, 6).map((e) => (
              <div key={`${e.file}#${e.name}`} className="flex items-baseline gap-1.5 px-1.5">
                <span className="min-w-0 truncate font-mono text-[10px] text-ink-muted">
                  {e.name}
                </span>
                <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
      {system.externals.length > 0 ? (
        <DetailSection title="Talks to" hint="external services, by import weight">
          <div className="space-y-0.5">
            {system.externals.map((x) => (
              <div key={x.id} className="flex items-baseline gap-1.5 px-1.5">
                <Plug className="h-3 w-3 shrink-0 self-center text-accent-amber" />
                <span className="min-w-0 truncate text-[10px] text-ink-muted">{x.name}</span>
                <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{x.weight}</span>
              </div>
            ))}
          </div>
        </DetailSection>
      ) : null}
      <DetailSection title="Parts" hint="directory subtrees forming this system">
        <div className="space-y-1">
          {system.parts.map((p) => (
            <div key={p.path} className="flex items-center gap-2 px-1.5">
              <FileLink file={p.path} />
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">{p.fileCount}</span>
            </div>
          ))}
        </div>
      </DetailSection>
    </>
  );
}

function EndpointInspector({
  epKey,
  owner,
  screens,
  calls,
  onSelectScreen,
  onOpenApi,
}: {
  epKey: string;
  owner: SystemModule;
  screens: readonly ScreenSurface[];
  calls: readonly ScreenApiCall[];
  onSelectScreen: (s: ScreenSurface) => void;
  onOpenApi: (epKey: string, sysId?: string) => void;
}) {
  const ep = owner.endpoints.find((e) => epKeyOf(e) === epKey) ?? null;
  const { systemOfFile } = useSurfaces();
  const { fitView } = useReactFlow();
  // The same handler-resolution + flamegraph the API explorer shows — the map
  // is the architecture here, so a single click pans the canvas to the frame's
  // owning system (the endpoint stays selected, keeping the trace open);
  // double click opens the code.
  const traceState = useEndpointTrace(ep);
  const spotlightStep = useCallback(
    (step: CodeTraceStep) => {
      const sys = systemOfFile(step.ref.file);
      if (sys) void fitView({ nodes: [{ id: sys.id }], duration: 400, padding: 0.3, maxZoom: 1 });
    },
    [systemOfFile, fitView],
  );
  const callers = screens.filter((s) =>
    calls.some((c) => c.screen === s.id && c.endpoint && epKeyOf(c.endpoint) === epKey),
  );
  return (
    <>
      <div className="border-b border-edge/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <Badge tone="slate">endpoint</Badge>
          <span className="text-[10px] text-ink-faint">served by {owner.name}</span>
          {ep ? <FileLink file={ep.file} line={ep.line} /> : null}
        </div>
        <button
          type="button"
          onClick={() => onOpenApi(epKey, owner.id)}
          className="mt-2 flex items-center gap-1 text-[10px] text-crystal-300 hover:text-crystal-200"
        >
          <Webhook className="h-3 w-3" /> Open in API explorer
        </button>
      </div>
      {ep ? <TraceSection state={traceState} onSelectStep={spotlightStep} /> : null}
      <DetailSection
        title={`Callers · ${callers.length}`}
        hint="screens whose call graph reaches this endpoint"
      >
        {callers.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No screen reaches this endpoint (server-side or external callers may exist).
          </div>
        ) : (
          <div className="space-y-0.5">
            {callers.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectScreen(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelectScreen(s);
                }}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <AppWindow className="h-3 w-3 shrink-0 text-accent-cyan" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {s.route}
                </span>
                {s.component ? (
                  <span className="max-w-24 shrink-0 truncate text-[9px] text-ink-faint">
                    {s.component}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </>
  );
}

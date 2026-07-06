import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge as RfEdge,
  type Node as RfNode,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Boxes,
  ChevronRight,
  Copy as CopyIcon,
  ExternalLink,
  FolderGit2,
  Layers,
  LayoutGrid,
  Package,
  RadioTower,
  Route,
  Rows3,
  Shrink,
  X,
} from "lucide-react";
import {
  createArchDraft as newArchDraft,
  createMoveFileIntent,
  createMoveIntent,
  type ArchDraft,
  type CodeFileDetail,
  type CodeMapLevelLink,
  type CodeMapSummary,
  type CodeModuleDetail,
  type CrossWorkspaceEdge,
  type CrossWorkspaceMap,
  type HoistIntent,
  type RefactorIntent,
} from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useWorkspace, useWorkspaces } from "@crystal/client";
import { Badge, Button, EmptyState, Pane, Split, Spinner, Tooltip, cn } from "@crystal/ui";
import { SymbolSnippet } from "../snippets.js";
import { CodeNode, SYMBOL_DRAG_MIME, type CodeRfNode, type SymbolDragPayload } from "./CodeNode.js";
import { DuplicatesPanel } from "./DuplicatesPanel.js";
import {
  absolutePositionOf,
  accentFor,
  buildMapScene,
  codeKey,
  dropTargetAt,
  fileDropTargetAt,
  fileId,
  moduleId,
  moduleOfPath,
  type DropTarget,
  type FileNodeData,
  type MapRfNode,
  type MapScene,
  type ModuleNodeData,
  type MoveLikeIntent,
  type SymbolNodeData,
} from "./map-model.js";
import { MapActionsContext, SYMBOL_TONES, mapNodeTypes, type MapActions } from "./map-nodes.js";

const crossNodeTypes = { code: CodeNode };

// The drill level is deep-linkable — core owns the shape.
type Level = CodeMapLevelLink;

/** dagre pass for the (flat) cross-workspace level. */
function layoutCross(nodes: CodeRfNode[], edges: RfEdge[]): CodeRfNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 180, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: 190, height: n.data.subtitle ? 52 : 40 });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - 95, y: pos.y - 20 } };
  });
}

/** Fires a cross-mode "open this file in the editor" request handled by the shell. */
export function requestOpenFile(path: string): void {
  window.dispatchEvent(new CustomEvent("crystal:open-file", { detail: { path } }));
}

export interface CodeMapViewProps {
  /** Start at this module instead of the workspace overview ("zoom in" entry). */
  initialModule?: string;
  /** Start at this file (within `initialModule`) — file-level "zoom in" entry. */
  initialFile?: string;
  /** Where the user came from (e.g. an architecture diagram) — rendered as a leading breadcrumb. */
  origin?: { label: string; onExit: () => void };
  /** "Start journey here…" on a symbol — opens the journey dialog in Diagrams. */
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /**
   * Path of the draft plan open in Diagrams, if any. Dropping a symbol on a
   * module/file records a move intent on it; without one, the first drop
   * auto-creates a draft (plan mode) and this is how the shell learns about it.
   */
  activeDraftPath?: string | null;
  /** A drop auto-created a draft — the shell should track it as the open draft. */
  onOpenDraft?: (path: string) => void;
}

export function CodeMapView(props: CodeMapViewProps = {}) {
  return (
    <ReactFlowProvider>
      <CodeMapInner {...props} />
    </ReactFlowProvider>
  );
}

const EMPTY_DRAFTS: never[] = [];
const EMPTY_REFACTORS: RefactorIntent[] = [];
const EMPTY_ARCHITECTURES: never[] = [];

interface CacheEntry<T> {
  gen: number;
  detail: T;
}

function CodeMapInner({
  initialModule,
  initialFile,
  origin,
  onStartJourney,
  activeDraftPath,
  onOpenDraft,
}: CodeMapViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);
  const archDrafts = useWorkspace((s) => s.info?.archDrafts ?? EMPTY_DRAFTS);
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const updateArchDraft = useWorkspace((s) => s.updateArchDraft);
  const createDraftFile = useWorkspace((s) => s.createArchDraft);

  // The drill level lives in the nav store so it deep-links and follows
  // back/forward. Null until we know the workspace to start from.
  const nav = useNavUpdate();
  const level = useNav((l) => l.architect?.codemap ?? null);
  const setLevelRaw = useCallback(
    (next: Level) => nav({ architect: { codemap: next } }),
    [nav],
  );
  const [summary, setSummary] = useState<CodeMapSummary | null>(null);
  const [cross, setCross] = useState<CrossWorkspaceMap | null>(null);
  const [crossEdge, setCrossEdge] = useState<CrossWorkspaceEdge | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(false);
  // Bumped by codemap.changed — every cached detail keyed below re-fetches.
  const [generation, setGeneration] = useState(0);

  const [moduleDetails, setModuleDetails] = useState<Map<string, CacheEntry<CodeModuleDetail>>>(
    () => new Map(),
  );
  const [fileDetails, setFileDetails] = useState<Map<string, CacheEntry<CodeFileDetail>>>(
    () => new Map(),
  );
  const [expandedModules, setExpandedModules] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [openCode, setOpenCode] = useState<ReadonlySet<string>>(() => new Set());
  const [modulePositions, setModulePositions] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    () => new Map(),
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    if (!level && activeWs) {
      setLevelRaw(
        initialFile
          ? { kind: "file", ws: activeWs, path: initialFile }
          : initialModule
            ? { kind: "module", ws: activeWs, path: initialModule }
            : { kind: "workspace", ws: activeWs },
      );
    }
  }, [level, activeWs, initialModule, initialFile, setLevelRaw]);

  const setLevel = useCallback(
    (next: Level) => {
      setCrossEdge(null);
      setLevelRaw(next);
    },
    [setLevelRaw],
  );

  const levelKind = level?.kind ?? null;
  const wsKey = level && level.kind !== "all" ? level.ws : null;
  const levelPath = level && (level.kind === "module" || level.kind === "file") ? level.path : null;

  // Reset the derived-map state when the browsed workspace actually changes.
  const lastWs = useRef<string | null>(null);
  useEffect(() => {
    if (!wsKey || lastWs.current === wsKey) return;
    lastWs.current = wsKey;
    setSummary(null);
    setModuleDetails(new Map());
    setFileDetails(new Map());
    setExpandedModules(new Set());
    setExpandedFiles(new Set());
    setOpenCode(new Set());
    setModulePositions(new Map());
    setSelectedFile(null);
    setFocus(null);
  }, [wsKey]);

  /* ---- fetching ---- */

  useEffect(() => {
    if (!levelKind) return;
    let cancelled = false;
    setLoading(true);
    const run = async () => {
      try {
        if (levelKind === "all") setCross(await client.request("codemap.cross", {}));
        else if (wsKey) setSummary(await client.request("codemap.get", { ws: wsKey }));
      } catch {
        // Analyzer may briefly race a delete; the next codemap.changed refetches.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [client, levelKind === "all", wsKey, generation]);

  // On-demand module details for every expanded module (re-fetched per generation).
  useEffect(() => {
    if (!wsKey) return;
    for (const path of expandedModules) {
      if (moduleDetails.get(path)?.gen === generation) continue;
      const key = `${wsKey}|m|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.module", { ws: wsKey, path })
        .then((detail) =>
          setModuleDetails((m) => new Map(m).set(path, { gen: generation, detail })),
        )
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, wsKey, expandedModules, generation, moduleDetails]);

  // File details: expanded files + the selected file + the drilled file.
  const wantedFiles = useMemo(() => {
    const set = new Set(expandedFiles);
    if (selectedFile) set.add(selectedFile);
    if (levelKind === "file" && levelPath) set.add(levelPath);
    return set;
  }, [expandedFiles, selectedFile, levelKind, levelPath]);

  useEffect(() => {
    if (!wsKey) return;
    for (const path of wantedFiles) {
      if (fileDetails.get(path)?.gen === generation) continue;
      const key = `${wsKey}|f|${path}|${generation}`;
      if (inflight.current.has(key)) continue;
      inflight.current.add(key);
      client
        .request("codemap.file", { ws: wsKey, path })
        .then((detail) => setFileDetails((m) => new Map(m).set(path, { gen: generation, detail })))
        .catch(() => {})
        .finally(() => inflight.current.delete(key));
    }
  }, [client, wsKey, wantedFiles, generation, fileDetails]);

  // Live updates: the server re-analyzes when code changes on disk.
  useEffect(() => {
    return client.events.on("codemap.changed", ({ ws }) => {
      if (level && level.kind !== "all" && ws !== level.ws) return;
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      setGeneration((g) => g + 1);
    });
  }, [client, level]);

  // The open-workspace set changed — the cross map is stale.
  useEffect(() => {
    return client.events.on("workspaces.changed", () => {
      if (level?.kind === "all") setGeneration((g) => g + 1);
    });
  }, [client, level]);

  /* ---- level → expansion/focus (drilling zooms into the nested map) ---- */

  const levelKey = level ? `${level.kind}:${wsKey ?? ""}:${levelPath ?? ""}` : "";
  useEffect(() => {
    if (!level || !summary) return;
    if (level.kind === "module") {
      setExpandedModules((prev) => (prev.has(level.path) ? prev : new Set(prev).add(level.path)));
      setFocus({ id: moduleId(level.path), nonce: ++focusNonce.current });
    } else if (level.kind === "file") {
      const mod = moduleOfPath(level.path, summary.modules);
      setExpandedModules((prev) => (prev.has(mod) ? prev : new Set(prev).add(mod)));
      setExpandedFiles((prev) => (prev.has(level.path) ? prev : new Set(prev).add(level.path)));
      setSelectedFile(level.path);
      setFocus({ id: fileId(level.path), nonce: ++focusNonce.current });
    }
    // levelKey captures kind+ws+path; re-run once the summary is in.
  }, [levelKey, summary != null]);

  /* ---- drag-a-symbol refactor intents (plan mode) ---- */

  const activeDraft = archDrafts.find((d) => d.path === activeDraftPath) ?? null;
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!dropNotice) return;
    const t = setTimeout(() => setDropNotice(null), 8000);
    return () => clearTimeout(t);
  }, [dropNotice]);

  /**
   * The draft plan intents ride on. Dropping with no draft open *enters plan
   * mode*: a draft is auto-created against the first architecture.
   */
  const ensureDraft = useCallback(async (): Promise<{ path: string; draft: ArchDraft } | null> => {
    if (activeDraft) return activeDraft;
    const arch = architectures[0];
    if (!arch) {
      setDropNotice("Create an architecture in Diagrams first — refactor plans ride on draft plans.");
      return null;
    }
    const draft = newArchDraft("Refactor plan", arch.path, arch.graph, new Date().toISOString());
    const created = await createDraftFile(draft);
    onOpenDraft?.(created.path);
    return created;
  }, [activeDraft, architectures, createDraftFile, onOpenDraft]);

  const recordMove = useCallback(
    async (payload: SymbolDragPayload, target: DropTarget) => {
      if (target.file === payload.file) return;
      const holder = await ensureDraft();
      if (!holder) return;
      const intent = createMoveIntent(payload.symbol, payload.file, target.module, target.file ?? null);
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(
        `${activeDraft ? `Draft "${holder.draft.name}"` : `Plan mode — draft "${holder.draft.name}" created`}: move ${payload.symbol} → ${target.file ?? target.module}. Apply it from Diagrams to run the refactor.`,
      );
    },
    [ensureDraft, activeDraft, updateArchDraft],
  );

  const recordFileMove = useCallback(
    async (fromFile: string, toModule: string) => {
      const holder = await ensureDraft();
      if (!holder) return;
      const intent = createMoveFileIntent(fromFile, toModule);
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(
        `${activeDraft ? `Draft "${holder.draft.name}"` : `Plan mode — draft "${holder.draft.name}" created`}: move file ${fromFile.split("/").pop()} → ${toModule}. Apply it from Diagrams to run the refactor.`,
      );
    },
    [ensureDraft, activeDraft, updateArchDraft],
  );

  const recordHoist = useCallback(
    async (intent: HoistIntent) => {
      const holder = await ensureDraft();
      if (!holder) return;
      updateArchDraft(holder.path, {
        ...holder.draft,
        refactors: [...holder.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(
        `${activeDraft ? `Draft "${holder.draft.name}"` : `Plan mode — draft "${holder.draft.name}" created`}: hoist → ${intent.targetModule}. Apply it from Diagrams to run it.`,
      );
    },
    [ensureDraft, activeDraft, updateArchDraft],
  );

  const showDuplicates = useNav((l) => l.architect?.duplicates) ?? false;
  const setShowDuplicates = useCallback(
    (on: boolean) => nav({ architect: { duplicates: on } }),
    [nav],
  );

  /* ---- scenes ---- */

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

  const refactors = activeDraft?.draft.refactors ?? EMPTY_REFACTORS;
  const moves = useMemo(
    () => refactors.filter((r): r is MoveLikeIntent => r.kind === "move" || r.kind === "moveFile"),
    [refactors],
  );

  const scene = useMemo<MapScene | null>(() => {
    if (!summary || !level || level.kind === "all") return null;
    return buildMapScene({
      summary,
      moduleDetails: moduleDetailMap,
      fileDetails: fileDetailMap,
      expandedModules,
      expandedFiles,
      openCode,
      moves,
      selectedFile,
      focusId: focus?.id ?? null,
      positions: modulePositions,
    });
  }, [
    summary,
    level,
    moduleDetailMap,
    fileDetailMap,
    expandedModules,
    expandedFiles,
    openCode,
    moves,
    selectedFile,
    focus,
    modulePositions,
  ]);

  const crossScene = useMemo(() => {
    if (level?.kind !== "all" || !cross) return { nodes: [] as CodeRfNode[], edges: [] as RfEdge[] };
    const nodes: CodeRfNode[] = cross.workspaces.map((w) => ({
      id: w.id,
      type: "code",
      position: { x: 0, y: 0 },
      data: {
        title: w.name,
        subtitle: w.root,
        accent: accentFor(w.id),
        icon: Layers,
        badge: `${w.fileTotal} files`,
        emphasis: w.id === activeWs,
      },
    }));
    const edges: RfEdge[] = cross.edges.map((e) => ({
      id: `${e.source}->${e.target}`,
      source: e.source,
      target: e.target,
      label: `${e.packages.length} pkg / ${e.weight} imports`,
      style: {
        stroke: "var(--color-crystal-400)",
        strokeWidth: Math.min(1.2 + Math.log2(e.weight + 1), 4),
        opacity: 0.9,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-crystal-400)", width: 14, height: 14 },
      labelStyle: { fill: "var(--color-crystal-400)", fontSize: 9 },
      labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
    }));
    return { nodes: layoutCross(nodes, edges), edges };
  }, [level, cross, activeWs]);

  /* ---- interactions ---- */

  const moduleName = (p: string) =>
    summary?.modules.find((m) => m.path === p)?.name ?? (p === "." ? "(root)" : p);
  const wsName = (id: string) =>
    workspaces.find((w) => w.id === id)?.name ??
    cross?.workspaces.find((w) => w.id === id)?.name ??
    id;

  // Opening a file in the editor targets the active workspace — switch first
  // when the map is browsing a different one.
  const openInEditor = useCallback(
    (path: string) => {
      if (wsKey && wsKey !== activeWs) setActive(wsKey);
      requestOpenFile(path);
    },
    [wsKey, activeWs, setActive],
  );

  const toggleModule = useCallback((path: string) => {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const toggleFile = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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

  const actions = useMemo<MapActions>(
    () => ({
      ws: wsKey ?? undefined,
      toggleModule,
      toggleFile,
      toggleCode,
      startJourney: onStartJourney,
      dropSymbol: (payload, target) => void recordMove(payload, target),
    }),
    [wsKey, toggleModule, toggleFile, toggleCode, onStartJourney, recordMove],
  );

  const onCrossNodeClick = useCallback(
    (_evt: unknown, node: CodeRfNode) => setLevel({ kind: "workspace", ws: node.id }),
    [setLevel],
  );
  const onCrossEdgeClick = useCallback(
    (_evt: unknown, edge: RfEdge) => {
      if (!cross) return;
      const hit = cross.edges.find((e) => `${e.source}->${e.target}` === edge.id);
      setCrossEdge(hit ?? null);
    },
    [cross],
  );

  const drilledFileDetail = levelKind === "file" && levelPath ? (fileDetailMap.get(levelPath) ?? null) : null;

  return (
    <MapActionsContext.Provider value={actions}>
    <div className="h-full min-h-0">
      <Split storageKey="architect:codemap" direction="horizontal">
        <Pane minSize="40%">
          <div className="relative h-full w-full min-w-0">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
          {origin ? (
            <>
              <button
                type="button"
                className="flex items-center gap-1 font-semibold text-crystal-300 hover:text-crystal-200"
                onClick={origin.onExit}
                title="Back to the architecture diagram"
              >
                <Boxes className="h-3 w-3" />
                {origin.label}
              </button>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
            </>
          ) : null}
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 font-semibold",
              level?.kind === "all" ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
            onClick={() => setLevel({ kind: "all" })}
            title="All open workspaces and their cross-imports"
          >
            <Layers className="h-3 w-3" />
            Workspaces
          </button>
          {level && level.kind !== "all" ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                type="button"
                className={cn(level.kind === "workspace" ? "text-ink" : "text-ink-muted hover:text-ink")}
                onClick={() => setLevel({ kind: "workspace", ws: level.ws })}
              >
                {wsName(level.ws)}
              </button>
            </>
          ) : null}
          {level && (level.kind === "module" || level.kind === "file") ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                type="button"
                className={cn(level.kind === "module" ? "text-ink" : "text-ink-muted hover:text-ink")}
                onClick={() =>
                  setLevel({
                    kind: "module",
                    ws: level.ws,
                    path:
                      level.kind === "module"
                        ? level.path
                        : moduleOfPath(level.path, summary?.modules ?? []),
                  })
                }
              >
                {moduleName(
                  level.kind === "module" ? level.path : moduleOfPath(level.path, summary?.modules ?? []),
                )}
              </button>
            </>
          ) : null}
          {level?.kind === "file" ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <span className="text-ink">{level.path.split("/").pop()}</span>
            </>
          ) : null}
          <Tooltip content="Derived from source — updates automatically as code changes">
            <span className="ml-2 flex items-center gap-1 text-[10px] text-ink-faint">
              <RadioTower className={cn("h-3 w-3", pulse ? "animate-pulse text-ok" : "text-ok/60")} />
              live
            </span>
          </Tooltip>
          {level && level.kind !== "all" ? (
            <Tooltip content="Duplicated functions — identical implementations across the workspace">
              <button
                type="button"
                aria-pressed={showDuplicates}
                onClick={() => setShowDuplicates(!showDuplicates)}
                className={cn(
                  "ml-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                  showDuplicates ? "bg-warn/15 text-warn" : "text-ink-faint hover:text-ink-muted",
                )}
              >
                <CopyIcon className="h-3 w-3" />
                dupes
              </button>
            </Tooltip>
          ) : null}
          {loading ? <Spinner className="ml-1 h-3 w-3" /> : null}
        </div>

        {level?.kind === "all" && cross && cross.workspaces.length < 2 && !loading ? (
          <div className="absolute left-3 top-12 z-10 rounded-lg border border-edge bg-surface-2/95 px-2 py-1 text-[10px] text-ink-faint">
            Open another workspace (status bar picker) to see cross-workspace imports
          </div>
        ) : null}

        {dropNotice ? (
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-lg -translate-x-1/2 items-center gap-2 rounded-xl border border-warn/40 bg-surface-2/95 px-3 py-2 text-[11px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
            <span className="min-w-0">{dropNotice}</span>
            <button
              type="button"
              onClick={() => setDropNotice(null)}
              className="shrink-0 text-ink-faint hover:text-ink"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        {level?.kind === "all" ? (
          crossScene.nodes.length === 0 && !loading ? (
            <EmptyState icon={FolderGit2} title="Nothing to map yet">
              No analyzable TypeScript/JavaScript found in the open workspaces.
            </EmptyState>
          ) : (
            <ReactFlow
              key="cross"
              nodes={crossScene.nodes}
              edges={crossScene.edges}
              nodeTypes={crossNodeTypes}
              onNodeClick={onCrossNodeClick}
              onEdgeClick={onCrossEdgeClick}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
              minZoom={0.08}
              maxZoom={2}
              nodesConnectable={false}
              panOnScroll
              proOptions={{ hideAttribution: true }}
              className="bg-surface-0"
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
              <Controls position="bottom-left" showInteractive={false} className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden" />
            </ReactFlow>
          )
        ) : scene && scene.nodes.length === 0 && !loading ? (
          <EmptyState icon={FolderGit2} title="Nothing to map yet">
            No analyzable TypeScript/JavaScript found in this workspace.
          </EmptyState>
        ) : scene ? (
          <WorkspaceMapCanvas
            key={wsKey ?? "map"}
            scene={scene}
            focus={focus}
            onModuleMoved={(path, pos) =>
              setModulePositions((prev) => new Map(prev).set(path, pos))
            }
            onSymbolMoved={(payload, target) => void recordMove(payload, target)}
            onFileMoved={(fromFile, toModule) => void recordFileMove(fromFile, toModule)}
            onSelectFile={setSelectedFile}
            onDrillModule={(path) => wsKey && setLevel({ kind: "module", ws: wsKey, path })}
            onDrillFile={(path) => wsKey && setLevel({ kind: "file", ws: wsKey, path })}
            onRelayout={() => setModulePositions(new Map())}
            onCollapseAll={() => {
              setExpandedModules(new Set());
              setExpandedFiles(new Set());
              setOpenCode(new Set());
              setSelectedFile(null);
            }}
          />
        ) : null}
      </div>
        </Pane>

        {level?.kind === "file" && drilledFileDetail ? (
          <Pane defaultSize={320} minSize={224} maxSize={560}>
            <FilePanel
              detail={drilledFileDetail}
              ws={level.ws}
              onNavigate={(p) => setLevel({ kind: "file", ws: level.ws, path: p })}
              onOpenFile={openInEditor}
              onStartJourney={onStartJourney}
              draftActive={activeDraft != null}
            />
          </Pane>
        ) : null}
        {level?.kind === "all" && crossEdge ? (
          <Pane defaultSize={320} minSize={224} maxSize={560}>
            <CrossEdgePanel
              edge={crossEdge}
              sourceName={wsName(crossEdge.source)}
              targetName={wsName(crossEdge.target)}
              onClose={() => setCrossEdge(null)}
            />
          </Pane>
        ) : null}
        {showDuplicates && level && level.kind !== "all" ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <DuplicatesPanel
              ws={level.ws}
              moduleFilter={level.kind === "module" ? level.path : undefined}
              modules={summary?.modules ?? []}
              hasActiveDraft={activeDraft != null}
              onHoist={(intent) => void recordHoist(intent)}
              onClose={() => setShowDuplicates(false)}
            />
          </Pane>
        ) : null}
      </Split>
    </div>
    </MapActionsContext.Provider>
  );
}

/* ------------------------- nested workspace canvas ------------------------ */

const SNAP_STORAGE_KEY = "crystal:codemap:snap";

function WorkspaceMapCanvas({
  scene,
  focus,
  onModuleMoved,
  onSymbolMoved,
  onFileMoved,
  onSelectFile,
  onDrillModule,
  onDrillFile,
  onRelayout,
  onCollapseAll,
}: {
  scene: MapScene;
  focus: { id: string; nonce: number } | null;
  onModuleMoved: (path: string, pos: { x: number; y: number }) => void;
  onSymbolMoved: (payload: SymbolDragPayload, target: DropTarget) => void;
  onFileMoved: (fromFile: string, toModule: string) => void;
  onSelectFile: (path: string | null) => void;
  onDrillModule: (path: string) => void;
  onDrillFile: (path: string) => void;
  onRelayout: () => void;
  onCollapseAll: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MapRfNode>(scene.nodes);
  const [snap, setSnap] = useState(() => {
    try {
      return localStorage.getItem(SNAP_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSnap = useCallback(() => {
    setSnap((s) => {
      try {
        localStorage.setItem(SNAP_STORAGE_KEY, s ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !s;
    });
  }, []);

  useEffect(() => {
    setNodes(scene.nodes);
  }, [scene, setNodes]);

  // Drill targets zoom into view once their node exists (details may lag).
  const { fitView } = useReactFlow();
  const focusReady = focus != null && scene.nodes.some((n) => n.id === focus.id);
  useEffect(() => {
    if (!focus || !focusReady) return;
    const t = setTimeout(() => {
      void fitView({ nodes: [{ id: focus.id }], padding: 0.35, duration: 450, maxZoom: 1.15 });
    }, 60);
    return () => clearTimeout(t);
  }, [focus?.nonce, focusReady, fitView]);

  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "module") {
        onModuleMoved((data as ModuleNodeData).path, node.position);
        return;
      }
      const abs = absolutePositionOf(nodes, node.id);
      const center = abs
        ? { x: abs.x + (node.width ?? 0) / 2, y: abs.y + (node.height ?? 0) / 2 }
        : null;
      if (data.nodeKind === "symbol") {
        const d = data as SymbolNodeData;
        if (center && !d.planned) {
          const target = dropTargetAt(nodes, center, { file: d.file, module: d.module });
          if (target) onSymbolMoved({ file: d.file, symbol: d.name }, target);
        }
      } else if (data.nodeKind === "file") {
        const d = data as FileNodeData;
        if (center && !d.planned) {
          const target = fileDropTargetAt(nodes, center, d.path, d.module);
          if (target) onFileMoved(d.path, target.module);
        }
      }
      // The node's real home is derived — snap it back (planned ghosts render
      // in the target once the intent lands on the draft).
      setNodes(scene.nodes);
    },
    [nodes, scene, setNodes, onModuleMoved, onSymbolMoved, onFileMoved],
  );

  const onNodeClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "file") onSelectFile((data as FileNodeData).path);
    },
    [onSelectFile],
  );

  const onNodeDoubleClick = useCallback(
    (_evt: unknown, node: RfNode) => {
      const data = node.data as MapRfNode["data"];
      if (data.nodeKind === "module") onDrillModule((data as ModuleNodeData).path);
      else if (data.nodeKind === "file") onDrillFile((data as FileNodeData).path);
    },
    [onDrillModule, onDrillFile],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={scene.edges}
      nodeTypes={mapNodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={() => onSelectFile(null)}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2}
      nodesConnectable={false}
      panOnScroll
      snapToGrid={snap}
      snapGrid={[16, 16]}
      proOptions={{ hideAttribution: true }}
      className="bg-surface-0"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.25} color="var(--color-edge-strong)" />
      <Controls position="bottom-left" showInteractive={false} className="!rounded-lg !border !border-edge !bg-surface-2 !shadow-lg overflow-hidden" />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        className="!h-28 !w-40 !rounded-lg !border !border-edge !bg-surface-2"
        nodeColor={(n) =>
          (n.data as MapRfNode["data"]).nodeKind === "module"
            ? "var(--color-surface-3)"
            : "var(--color-crystal-500)"
        }
        maskColor="color-mix(in srgb, var(--color-surface-0) 75%, transparent)"
      />
      <Panel position="top-right" className="flex items-center gap-0.5 rounded-xl border border-edge bg-surface-2/95 p-1 shadow-xl shadow-black/30 backdrop-blur">
        <Tooltip content={snap ? "Snap to grid: on" : "Snap to grid: off"}>
          <button
            type="button"
            aria-pressed={snap}
            onClick={toggleSnap}
            className={cn(
              "rounded-lg p-1.5 transition-colors",
              snap ? "bg-crystal-500/15 text-crystal-300" : "text-ink-faint hover:text-ink",
            )}
            aria-label="Toggle snap to grid"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Re-layout — clear manual positions and pack everything neatly">
          <button
            type="button"
            onClick={onRelayout}
            className="rounded-lg p-1.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="Auto-layout"
          >
            <Rows3 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Collapse everything back to modules">
          <button
            type="button"
            onClick={onCollapseAll}
            className="rounded-lg p-1.5 text-ink-faint transition-colors hover:text-ink"
            aria-label="Collapse all"
          >
            <Shrink className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </Panel>
    </ReactFlow>
  );
}

/** Package-level breakdown of one workspace-pair import edge. */
function CrossEdgePanel({
  edge,
  sourceName,
  targetName,
  onClose,
}: {
  edge: CrossWorkspaceEdge;
  sourceName: string;
  targetName: string;
  onClose: () => void;
}) {
  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
          <div className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
            {sourceName} <span className="text-ink-faint">imports from</span> {targetName}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="mt-0.5 text-[10px] text-ink-faint">
          {edge.weight} import{edge.weight !== 1 ? "s" : ""} across {edge.packages.length} package
          {edge.packages.length !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {edge.packages.map((pkg) => (
          <div key={pkg.pkg}>
            <div className="flex items-center gap-2">
              <Package className="h-3 w-3 shrink-0 text-crystal-300" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{pkg.pkg}</span>
              <Badge tone="cyan">{pkg.count}×</Badge>
            </div>
            <div className="mb-1 mt-0.5 pl-5 text-[9.5px] text-ink-faint">
              exported by <span className="font-mono">{pkg.toModule}</span>
            </div>
            <div className="space-y-1 pl-5">
              {pkg.uses.map((use) => (
                <div key={use.fromModule} className="rounded-lg border border-edge bg-surface-2 px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-muted">
                      {use.fromModule}
                    </span>
                    <span className="shrink-0 text-[9px] text-ink-faint">{use.count}×</span>
                  </div>
                  {use.names.length > 0 ? (
                    <div className="mt-0.5 truncate text-[9.5px] text-prism-400" title={use.names.join(", ")}>
                      {use.names.join(", ")}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        {edge.packages.length === 0 ? (
          <div className="py-2 text-[11px] text-ink-faint">No package-level detail</div>
        ) : null}
      </div>
    </aside>
  );
}

function FilePanel({
  detail,
  ws,
  onNavigate,
  onOpenFile,
  onStartJourney,
  draftActive,
}: {
  detail: CodeFileDetail;
  ws?: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** A draft plan is open — moves land on it instead of starting a new one. */
  draftActive?: boolean;
}) {
  const externals = detail.imports.filter((i) => i.external);
  const internals = detail.imports.filter((i) => i.resolved);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Older servers don't send `symbols`; fall back to the export list.
  const symbols = detail.symbols ?? detail.exports;

  return (
    <aside className="flex h-full w-full flex-col bg-surface-1">
      <div className="border-b border-edge px-3 py-2.5">
        <div className="truncate text-xs font-semibold text-ink">{detail.path}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
          <span>{detail.loc} lines</span>
          <span>{detail.exports.length} exports</span>
          <span>{detail.imports.length} imports</span>
        </div>
        <Button
          variant="secondary"
          size="xs"
          className="mt-2"
          onClick={() => onOpenFile(detail.path)}
        >
          <ExternalLink className="h-3 w-3" /> Open in editor
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Section title={`Symbols (${symbols.length})`}>
          <div className="mb-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1 text-[10px] text-ink-faint">
            {draftActive
              ? "Draft plan active — drag a symbol onto a file or module node to plan a move."
              : "Drag a symbol onto a file or module node to start a refactor plan."}
          </div>
          {symbols.map((sym, i) => (
            <div key={`${sym.name}${i}`}>
              <div
                className={cn(
                  "flex items-center gap-1.5 py-0.5 text-[11.5px]",
                  sym.kind !== "reexport" && "cursor-grab active:cursor-grabbing",
                )}
                draggable={sym.kind !== "reexport"}
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    SYMBOL_DRAG_MIME,
                    JSON.stringify({ file: detail.path, symbol: sym.name }),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === sym.name ? null : sym.name)}
                  className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
                  aria-label={`${expanded === sym.name ? "Hide" : "Show"} source of ${sym.name}`}
                >
                  <ChevronRight
                    className={cn("h-3 w-3 transition-transform", expanded === sym.name && "rotate-90")}
                  />
                </button>
                <Badge tone={SYMBOL_TONES[sym.kind].tone} className="w-8 justify-center font-mono">
                  {SYMBOL_TONES[sym.kind].label}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-ink">{sym.name}</span>
                {sym.exported === false ? <Badge tone="neutral">int</Badge> : null}
                {onStartJourney && sym.kind !== "reexport" && sym.kind !== "default" ? (
                  <Tooltip content="Start journey here — trace this symbol's dataflow on the diagram">
                    <button
                      type="button"
                      onClick={() => onStartJourney({ file: detail.path, symbol: sym.name })}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:text-crystal-300"
                      aria-label={`Start journey at ${sym.name}`}
                    >
                      <Route className="h-3 w-3" />
                    </button>
                  </Tooltip>
                ) : null}
                <span className="text-[9px] text-ink-faint">:{sym.line}</span>
              </div>
              {expanded === sym.name ? (
                <SymbolSnippet file={detail.path} symbol={sym.name} ws={ws} className="mb-1.5 ml-5" />
              ) : null}
            </div>
          ))}
          {symbols.length === 0 ? <Empty label="No top-level symbols" /> : null}
        </Section>
        <Section title={`Imports — internal (${internals.length})`}>
          {internals.map((imp, i) => (
            <button
              key={i}
              type="button"
              onClick={() => imp.resolved && onNavigate(imp.resolved)}
              className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-prism-400 hover:underline"
              title={imp.names.join(", ")}
            >
              {imp.resolved}
            </button>
          ))}
          {internals.length === 0 ? <Empty label="None" /> : null}
        </Section>
        <Section title={`Imports — external (${externals.length})`}>
          {externals.map((imp, i) => (
            <div key={i} className="truncate py-0.5 font-mono text-[11px] text-ink-muted" title={imp.names.join(", ")}>
              {imp.specifier}
            </div>
          ))}
          {externals.length === 0 ? <Empty label="None" /> : null}
        </Section>
        <Section title={`Imported by (${detail.importedBy.length})`}>
          {detail.importedBy.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onNavigate(p)}
              className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-prism-400 hover:underline"
            >
              {p}
            </button>
          ))}
          {detail.importedBy.length === 0 ? <Empty label="Nothing imports this file" /> : null}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{title}</div>
      {children}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="py-0.5 text-[11px] text-ink-faint">{label}</div>;
}

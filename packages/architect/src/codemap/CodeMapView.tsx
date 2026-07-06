import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RfEdge,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Boxes,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FolderGit2,
  Layers,
  Package,
  RadioTower,
  Route,
  X,
} from "lucide-react";
import {
  createMoveIntent,
  type CodeFileDetail,
  type CodeMapSummary,
  type CodeModuleDetail,
  type CodeSymbolKind,
  type CrossWorkspaceEdge,
  type CrossWorkspaceMap,
  type RefactorIntent,
} from "@crystal/core";
import { useCrystal, useWorkspace, useWorkspaces } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";
import { SymbolSnippet } from "../snippets.js";
import {
  CodeNode,
  SYMBOL_DRAG_MIME,
  type CodeNodeData,
  type CodeRfNode,
  type SymbolDragPayload,
} from "./CodeNode.js";

const nodeTypes = { code: CodeNode };

type Level =
  | { kind: "all" }
  | { kind: "workspace"; ws: string }
  | { kind: "module"; ws: string; path: string }
  | { kind: "file"; ws: string; path: string };

const ACCENTS = [
  "var(--color-accent-violet)",
  "var(--color-accent-cyan)",
  "var(--color-accent-emerald)",
  "var(--color-accent-amber)",
  "var(--color-accent-blue)",
  "var(--color-accent-rose)",
  "var(--color-accent-slate)",
];

function accentFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return ACCENTS[Math.abs(hash) % ACCENTS.length]!;
}

function layout(
  nodes: CodeRfNode[],
  edges: RfEdge[],
  opts: { ranksep?: number } = {},
): CodeRfNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: opts.ranksep ?? 110, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: 190, height: n.data.subtitle ? 52 : 40 });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - 95, y: pos.y - 20 } };
  });
}

function edgeStyle(weight?: number): Partial<RfEdge> {
  return {
    style: {
      stroke: "var(--color-edge-strong)",
      strokeWidth: weight ? Math.min(1 + Math.log2(weight + 1), 4) : 1.2,
      opacity: 0.85,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-edge-strong)", width: 14, height: 14 },
    label: weight && weight > 1 ? String(weight) : undefined,
    labelStyle: { fill: "var(--color-ink-faint)", fontSize: 9 },
    labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.9 },
  };
}

/** Fires a cross-mode "open this file in the editor" request handled by the shell. */
export function requestOpenFile(path: string): void {
  window.dispatchEvent(new CustomEvent("crystal:open-file", { detail: { path } }));
}

export interface CodeMapViewProps {
  /** Start at this module instead of the workspace overview ("zoom in" entry). */
  initialModule?: string;
  /** Where the user came from (e.g. an architecture diagram) — rendered as a leading breadcrumb. */
  origin?: { label: string; onExit: () => void };
  /** "Start journey here…" on a symbol — opens the journey dialog in Diagrams. */
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /**
   * Path of the draft plan open in Diagrams, if any. With a draft active,
   * FilePanel symbols become draggable and drops on module/file nodes record
   * move intents on the draft.
   */
  activeDraftPath?: string | null;
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

function CodeMapInner({ initialModule, origin, onStartJourney, activeDraftPath }: CodeMapViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);
  const archDrafts = useWorkspace((s) => s.info?.archDrafts ?? EMPTY_DRAFTS);
  const updateArchDraft = useWorkspace((s) => s.updateArchDraft);

  // Level is null until we know the active workspace to start from.
  const [level, setLevelRaw] = useState<Level | null>(null);
  const [summary, setSummary] = useState<CodeMapSummary | null>(null);
  const [moduleDetail, setModuleDetail] = useState<CodeModuleDetail | null>(null);
  const [fileDetail, setFileDetail] = useState<CodeFileDetail | null>(null);
  const [cross, setCross] = useState<CrossWorkspaceMap | null>(null);
  const [crossEdge, setCrossEdge] = useState<CrossWorkspaceEdge | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!level && activeWs) {
      setLevelRaw(
        initialModule
          ? { kind: "module", ws: activeWs, path: initialModule }
          : { kind: "workspace", ws: activeWs },
      );
    }
  }, [level, activeWs, initialModule]);

  const setLevel = useCallback((next: Level) => {
    setCrossEdge(null);
    setLevelRaw(next);
  }, []);

  const refetch = useCallback(async () => {
    if (!level) return;
    setLoading(true);
    try {
      if (level.kind === "all") {
        setCross(await client.request("codemap.cross", {}));
      } else if (level.kind === "workspace") {
        setSummary(await client.request("codemap.get", { ws: level.ws }));
      } else if (level.kind === "module") {
        setModuleDetail(await client.request("codemap.module", { ws: level.ws, path: level.path }));
      } else {
        setFileDetail(await client.request("codemap.file", { ws: level.ws, path: level.path }));
      }
    } catch {
      // Analyzer may briefly race a delete; the next codemap.changed refetches.
    } finally {
      setLoading(false);
    }
  }, [client, level]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Live updates: the server re-analyzes when code changes on disk.
  useEffect(() => {
    return client.events.on("codemap.changed", ({ ws }) => {
      if (level && level.kind !== "all" && ws !== level.ws) return;
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      void refetch();
    });
  }, [client, refetch, level]);

  // The open-workspace set changed — the cross map is stale.
  useEffect(() => {
    return client.events.on("workspaces.changed", () => {
      if (level?.kind === "all") void refetch();
    });
  }, [client, refetch, level]);

  const { nodes, edges } = useMemo(() => {
    if (!level) return { nodes: [] as CodeRfNode[], edges: [] as RfEdge[] };

    if (level.kind === "all" && cross) {
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
        ...edgeStyle(e.weight),
        label: `${e.packages.length} pkg / ${e.weight} imports`,
        style: { stroke: "var(--color-crystal-400)", strokeWidth: Math.min(1.2 + Math.log2(e.weight + 1), 4), opacity: 0.9 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-crystal-400)", width: 14, height: 14 },
        labelStyle: { fill: "var(--color-crystal-400)", fontSize: 9 },
      }));
      return { nodes: layout(nodes, edges, { ranksep: 180 }), edges };
    }

    if (level.kind === "workspace" && summary) {
      const nodes: CodeRfNode[] = summary.modules
        .filter((m) => m.fileCount > 0 || summary.deps.some((d) => d.source === m.path || d.target === m.path))
        .map((m) => ({
          id: m.path,
          type: "code",
          position: { x: 0, y: 0 },
          data: {
            title: m.name,
            subtitle: m.path === "." ? "workspace root" : m.path,
            accent: accentFor(m.path),
            icon: Package,
            badge: `${m.fileCount}`,
          },
        }));
      const edges: RfEdge[] = summary.deps.map((d) => ({
        id: `${d.source}->${d.target}`,
        source: d.source,
        target: d.target,
        ...edgeStyle(d.weight),
      }));
      return { nodes: layout(nodes, edges, { ranksep: 140 }), edges };
    }

    if (level.kind === "module" && moduleDetail) {
      const nodes: CodeRfNode[] = moduleDetail.files.map((f) => ({
        id: f.path,
        type: "code",
        position: { x: 0, y: 0 },
        data: {
          title: f.name,
          subtitle: f.dir || undefined,
          accent: accentFor(f.dir),
          icon: FileCode2,
          badge: f.exportCount ? `${f.exportCount} exp` : undefined,
        },
      }));
      const edges: RfEdge[] = moduleDetail.edges.map((e, i) => ({
        id: `e${i}`,
        source: e.source,
        target: e.target,
        ...edgeStyle(),
      }));
      // Boundary nodes for modules this one depends on.
      for (const dep of moduleDetail.moduleDeps) {
        nodes.push({
          id: `mod:${dep.target}`,
          type: "code",
          position: { x: 0, y: 0 },
          data: {
            title: dep.target === "." ? "(root)" : dep.target,
            subtitle: "module",
            accent: accentFor(dep.target),
            icon: Package,
            boundary: true,
            badge: `${dep.weight}`,
          },
        });
        edges.push({
          id: `dep:${dep.target}`,
          source: "__module__",
          target: `mod:${dep.target}`,
          ...edgeStyle(dep.weight),
        });
      }
      // Anchor node representing the module itself for boundary edges.
      if (moduleDetail.moduleDeps.length) {
        nodes.push({
          id: "__module__",
          type: "code",
          position: { x: 0, y: 0 },
          data: {
            title: moduleDetail.module.name,
            subtitle: "this module",
            accent: accentFor(moduleDetail.module.path),
            icon: Boxes,
            emphasis: true,
          },
        });
      }
      return { nodes: layout(nodes, edges), edges };
    }

    if (level.kind === "file" && fileDetail) {
      const nodes: CodeRfNode[] = [
        {
          id: fileDetail.path,
          type: "code",
          position: { x: 0, y: 0 },
          data: {
            title: fileDetail.path.split("/").pop()!,
            subtitle: fileDetail.path,
            accent: "var(--color-crystal-400)",
            icon: FileCode2,
            emphasis: true,
            badge: `${fileDetail.loc} loc`,
          },
        },
      ];
      const edges: RfEdge[] = [];
      for (const by of fileDetail.importedBy) {
        nodes.push({
          id: by,
          type: "code",
          position: { x: 0, y: 0 },
          data: { title: by.split("/").pop()!, subtitle: by, accent: accentFor(by), icon: FileCode2 },
        });
        edges.push({ id: `in:${by}`, source: by, target: fileDetail.path, ...edgeStyle() });
      }
      const seen = new Set<string>();
      for (const imp of fileDetail.imports) {
        if (!imp.resolved || seen.has(imp.resolved) || imp.resolved === fileDetail.path) continue;
        seen.add(imp.resolved);
        if (!nodes.some((n) => n.id === imp.resolved)) {
          nodes.push({
            id: imp.resolved,
            type: "code",
            position: { x: 0, y: 0 },
            data: {
              title: imp.resolved.split("/").pop()!,
              subtitle: imp.resolved,
              accent: accentFor(imp.resolved),
              icon: FileCode2,
            },
          });
        }
        edges.push({ id: `out:${imp.resolved}`, source: fileDetail.path, target: imp.resolved, ...edgeStyle() });
      }
      return { nodes: layout(nodes, edges), edges };
    }

    return { nodes: [] as CodeRfNode[], edges: [] as RfEdge[] };
  }, [level, summary, moduleDetail, fileDetail, cross, activeWs]);

  const onNodeClick = useCallback(
    (_evt: unknown, node: CodeRfNode) => {
      if (!level) return;
      if (level.kind === "all") {
        setLevel({ kind: "workspace", ws: node.id });
      } else if (level.kind === "workspace") {
        setLevel({ kind: "module", ws: level.ws, path: node.id });
      } else if (level.kind === "module") {
        if (node.id.startsWith("mod:")) setLevel({ kind: "module", ws: level.ws, path: node.id.slice(4) });
        else if (node.id !== "__module__") setLevel({ kind: "file", ws: level.ws, path: node.id });
      } else if (node.id !== level.path) {
        setLevel({ kind: "file", ws: level.ws, path: node.id });
      }
    },
    [level, setLevel],
  );

  const onEdgeClick = useCallback(
    (_evt: unknown, edge: RfEdge) => {
      if (level?.kind !== "all" || !cross) return;
      const hit = cross.edges.find((e) => `${e.source}->${e.target}` === edge.id);
      setCrossEdge(hit ?? null);
    },
    [level, cross],
  );

  const moduleName = (p: string) =>
    summary?.modules.find((m) => m.path === p)?.name ?? (p === "." ? "(root)" : p);
  const wsName = (id: string) =>
    workspaces.find((w) => w.id === id)?.name ??
    cross?.workspaces.find((w) => w.id === id)?.name ??
    id;

  const levelWs = level && level.kind !== "all" ? level.ws : null;

  // Opening a file in the editor targets the active workspace — switch first
  // when the map is browsing a different one.
  const openInEditor = useCallback(
    (path: string) => {
      if (levelWs && levelWs !== activeWs) setActive(levelWs);
      requestOpenFile(path);
    },
    [levelWs, activeWs, setActive],
  );

  /* ---- drag-a-symbol refactor intents (draft plan mode) ---- */
  const activeDraft = archDrafts.find((d) => d.path === activeDraftPath) ?? null;
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!dropNotice) return;
    const t = setTimeout(() => setDropNotice(null), 6000);
    return () => clearTimeout(t);
  }, [dropNotice]);

  const recordMove = useCallback(
    async (payload: SymbolDragPayload, target: { module?: string; file?: string }) => {
      if (!activeDraft) {
        setDropNotice("Open a draft plan in Diagrams first — symbol moves are recorded on the draft.");
        return;
      }
      if (target.file === payload.file) return;
      let toModule = target.module ?? null;
      const toFile = target.file ?? null;
      if (!toModule && toFile) {
        try {
          toModule = (await client.request("codemap.file", { ws: levelWs ?? undefined, path: toFile })).module;
        } catch {
          toModule = ".";
        }
      }
      const intent = createMoveIntent(payload.symbol, payload.file, toModule ?? ".", toFile);
      updateArchDraft(activeDraft.path, {
        ...activeDraft.draft,
        refactors: [...activeDraft.draft.refactors, intent],
        updatedAt: new Date().toISOString(),
      });
      setDropNotice(`Draft "${activeDraft.draft.name}": move ${payload.symbol} → ${toFile ?? toModule}`);
    },
    [activeDraft, client, levelWs, updateArchDraft],
  );

  // Drop targets + pending-intent badges, layered onto the level's nodes.
  const refactors = activeDraft?.draft.refactors ?? EMPTY_REFACTORS;
  const decoratedNodes = useMemo(() => {
    if (!level || level.kind === "all") return nodes;
    const moves = refactors.filter((r) => r.kind === "move");
    return nodes.map((n) => {
      let onSymbolDrop: CodeNodeData["onSymbolDrop"];
      let intentMark: CodeNodeData["intentMark"];
      if (level.kind === "workspace") {
        const module = n.id;
        onSymbolDrop = (p) => void recordMove(p, { module });
        if (moves.some((m) => m.toModule === module)) intentMark = "target";
        else if (module !== "." && moves.some((m) => m.fromFile.startsWith(module + "/"))) intentMark = "source";
      } else if (level.kind === "module") {
        if (n.id.startsWith("mod:")) {
          const module = n.id.slice(4);
          onSymbolDrop = (p) => void recordMove(p, { module });
          if (moves.some((m) => m.toModule === module)) intentMark = "target";
        } else if (n.id !== "__module__") {
          const file = n.id;
          onSymbolDrop = (p) => void recordMove(p, { module: level.path, file });
          if (moves.some((m) => m.fromFile === file)) intentMark = "source";
          else if (moves.some((m) => m.toFile === file)) intentMark = "target";
        }
      } else {
        const file = n.id;
        onSymbolDrop = (p) => void recordMove(p, { file });
        if (moves.some((m) => m.fromFile === file)) intentMark = "source";
        else if (moves.some((m) => m.toFile === file)) intentMark = "target";
      }
      if (!onSymbolDrop && !intentMark) return n;
      return { ...n, data: { ...n.data, onSymbolDrop, intentMark } };
    });
  }, [nodes, level, refactors, recordMove]);

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
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
                    path: level.kind === "module" ? level.path : (fileDetail?.module ?? "."),
                  })
                }
              >
                {level.kind === "module" ? moduleName(level.path) : moduleName(fileDetail?.module ?? ".")}
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
          {loading ? <Spinner className="ml-1 h-3 w-3" /> : null}
        </div>

        {moduleDetail?.truncated && level?.kind === "module" ? (
          <div className="absolute left-3 top-12 z-10 rounded-lg border border-warn/30 bg-warn/10 px-2 py-1 text-[10px] text-warn">
            Large module — showing the {moduleDetail.files.length} most connected files
          </div>
        ) : null}

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

        {nodes.length === 0 && !loading ? (
          <EmptyState icon={FolderGit2} title="Nothing to map yet">
            No analyzable TypeScript/JavaScript found in this workspace.
          </EmptyState>
        ) : (
          <ReactFlow
            key={level ? `${level.kind}:${"ws" in level ? level.ws : ""}:${"path" in level ? level.path : ""}` : "empty"}
            nodes={decoratedNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
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
        )}
      </div>

      {level?.kind === "file" && fileDetail ? (
        <FilePanel
          detail={fileDetail}
          ws={level.ws}
          onNavigate={(p) => setLevel({ kind: "file", ws: level.ws, path: p })}
          onOpenFile={openInEditor}
          onStartJourney={onStartJourney}
          dragSymbols={activeDraft != null}
        />
      ) : null}
      {level?.kind === "all" && crossEdge ? (
        <CrossEdgePanel
          edge={crossEdge}
          sourceName={wsName(crossEdge.source)}
          targetName={wsName(crossEdge.target)}
          onClose={() => setCrossEdge(null)}
        />
      ) : null}
    </div>
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
    <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-surface-1">
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

const SYMBOL_TONES: Record<CodeSymbolKind, { label: string; tone: "violet" | "cyan" | "emerald" | "amber" | "blue" | "rose" | "slate" | "neutral" }> = {
  function: { label: "ƒ", tone: "blue" },
  component: { label: "⟨/⟩", tone: "cyan" },
  class: { label: "C", tone: "amber" },
  interface: { label: "I", tone: "emerald" },
  enum: { label: "E", tone: "rose" },
  type: { label: "T", tone: "violet" },
  const: { label: "•", tone: "slate" },
  default: { label: "d", tone: "neutral" },
  reexport: { label: "↪", tone: "neutral" },
};

function FilePanel({
  detail,
  ws,
  onNavigate,
  onOpenFile,
  onStartJourney,
  dragSymbols,
}: {
  detail: CodeFileDetail;
  ws?: string;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onStartJourney?: (seed: { file: string; symbol: string }) => void;
  /** Draft plan active — symbols can be dragged onto files/modules to record moves. */
  dragSymbols?: boolean;
}) {
  const externals = detail.imports.filter((i) => i.external);
  const internals = detail.imports.filter((i) => i.resolved);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Older servers don't send `symbols`; fall back to the export list.
  const symbols = detail.symbols ?? detail.exports;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-surface-1">
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
          {dragSymbols ? (
            <div className="mb-1.5 rounded-lg border border-warn/30 bg-warn/10 px-2 py-1 text-[10px] text-warn">
              Draft plan active — drag a symbol onto a file or module node to plan a move.
            </div>
          ) : null}
          {symbols.map((sym, i) => (
            <div key={`${sym.name}${i}`}>
              <div
                className={cn(
                  "flex items-center gap-1.5 py-0.5 text-[11.5px]",
                  dragSymbols && sym.kind !== "reexport" && "cursor-grab active:cursor-grabbing",
                )}
                draggable={dragSymbols && sym.kind !== "reexport"}
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

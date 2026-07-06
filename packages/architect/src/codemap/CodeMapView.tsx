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
  X,
} from "lucide-react";
import type {
  CodeFileDetail,
  CodeMapSummary,
  CodeModuleDetail,
  CodeSymbolKind,
  CrossWorkspaceEdge,
  CrossWorkspaceMap,
} from "@crystal/core";
import { useCrystal, useWorkspaces } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";
import { CodeNode, type CodeRfNode } from "./CodeNode.js";

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

export function CodeMapView() {
  return (
    <ReactFlowProvider>
      <CodeMapInner />
    </ReactFlowProvider>
  );
}

function CodeMapInner() {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);

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
    if (!level && activeWs) setLevelRaw({ kind: "workspace", ws: activeWs });
  }, [level, activeWs]);

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

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
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

        {nodes.length === 0 && !loading ? (
          <EmptyState icon={FolderGit2} title="Nothing to map yet">
            No analyzable TypeScript/JavaScript found in this workspace.
          </EmptyState>
        ) : (
          <ReactFlow
            key={level ? `${level.kind}:${"ws" in level ? level.ws : ""}:${"path" in level ? level.path : ""}` : "empty"}
            nodes={nodes}
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
          onNavigate={(p) => setLevel({ kind: "file", ws: level.ws, path: p })}
          onOpenFile={openInEditor}
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
  onNavigate,
  onOpenFile,
}: {
  detail: CodeFileDetail;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const externals = detail.imports.filter((i) => i.external);
  const internals = detail.imports.filter((i) => i.resolved);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-surface-1">
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
        <Section title={`Exports (${detail.exports.length})`}>
          {detail.exports.map((sym, i) => (
            <div key={`${sym.name}${i}`} className="flex items-center gap-2 py-0.5 text-[11.5px]">
              <Badge tone={SYMBOL_TONES[sym.kind].tone} className="w-8 justify-center font-mono">
                {SYMBOL_TONES[sym.kind].label}
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{sym.name}</span>
              <span className="text-[9px] text-ink-faint">:{sym.line}</span>
            </div>
          ))}
          {detail.exports.length === 0 ? <Empty label="No exports" /> : null}
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

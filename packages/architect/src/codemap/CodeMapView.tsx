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
  Boxes,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FolderGit2,
  Package,
  RadioTower,
} from "lucide-react";
import type {
  CodeFileDetail,
  CodeMapSummary,
  CodeModuleDetail,
  CodeSymbolKind,
} from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";
import { CodeNode, type CodeRfNode } from "./CodeNode.js";

const nodeTypes = { code: CodeNode };

type Level =
  | { kind: "workspace" }
  | { kind: "module"; path: string }
  | { kind: "file"; path: string };

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
  const [level, setLevel] = useState<Level>({ kind: "workspace" });
  const [summary, setSummary] = useState<CodeMapSummary | null>(null);
  const [moduleDetail, setModuleDetail] = useState<CodeModuleDetail | null>(null);
  const [fileDetail, setFileDetail] = useState<CodeFileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      if (level.kind === "workspace") {
        setSummary(await client.request("codemap.get", {}));
      } else if (level.kind === "module") {
        setModuleDetail(await client.request("codemap.module", { path: level.path }));
      } else {
        setFileDetail(await client.request("codemap.file", { path: level.path }));
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
    return client.events.on("codemap.changed", () => {
      setPulse(true);
      setTimeout(() => setPulse(false), 1200);
      void refetch();
    });
  }, [client, refetch]);

  const { nodes, edges } = useMemo(() => {
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
  }, [level.kind, summary, moduleDetail, fileDetail]);

  const onNodeClick = useCallback(
    (_evt: unknown, node: CodeRfNode) => {
      if (level.kind === "workspace") {
        setLevel({ kind: "module", path: node.id });
      } else if (level.kind === "module") {
        if (node.id.startsWith("mod:")) setLevel({ kind: "module", path: node.id.slice(4) });
        else if (node.id !== "__module__") setLevel({ kind: "file", path: node.id });
      } else if (node.id !== (level as { path: string }).path) {
        setLevel({ kind: "file", path: node.id });
      }
    },
    [level],
  );

  const moduleName = (p: string) =>
    summary?.modules.find((m) => m.path === p)?.name ?? (p === "." ? "(root)" : p);

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-edge bg-surface-2/95 px-2.5 py-1.5 text-xs shadow-xl shadow-black/30 backdrop-blur">
          <button
            type="button"
            className={cn("font-semibold", level.kind === "workspace" ? "text-ink" : "text-ink-muted hover:text-ink")}
            onClick={() => setLevel({ kind: "workspace" })}
          >
            Code map
          </button>
          {level.kind !== "workspace" ? (
            <>
              <ChevronRight className="h-3 w-3 text-ink-faint" />
              <button
                type="button"
                className={cn(level.kind === "module" ? "text-ink" : "text-ink-muted hover:text-ink")}
                onClick={() =>
                  setLevel({
                    kind: "module",
                    path:
                      level.kind === "module"
                        ? level.path
                        : (fileDetail?.module ?? "."),
                  })
                }
              >
                {level.kind === "module" ? moduleName(level.path) : moduleName(fileDetail?.module ?? ".")}
              </button>
            </>
          ) : null}
          {level.kind === "file" ? (
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

        {moduleDetail?.truncated && level.kind === "module" ? (
          <div className="absolute left-3 top-12 z-10 rounded-lg border border-warn/30 bg-warn/10 px-2 py-1 text-[10px] text-warn">
            Large module — showing the {moduleDetail.files.length} most connected files
          </div>
        ) : null}

        {nodes.length === 0 && !loading ? (
          <EmptyState icon={FolderGit2} title="Nothing to map yet">
            No analyzable TypeScript/JavaScript found in this workspace.
          </EmptyState>
        ) : (
          <ReactFlow
            key={`${level.kind}:${"path" in level ? level.path : ""}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
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

      {level.kind === "file" && fileDetail ? (
        <FilePanel detail={fileDetail} onNavigate={(p) => setLevel({ kind: "file", path: p })} />
      ) : null}
    </div>
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
}: {
  detail: CodeFileDetail;
  onNavigate: (path: string) => void;
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
          onClick={() => requestOpenFile(detail.path)}
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

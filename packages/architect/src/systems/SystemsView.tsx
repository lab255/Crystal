import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge as RfEdge,
  type Node as RfNode,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Database,
  DoorOpen,
  ExternalLink,
  GitCompare,
  Layers,
  PencilRuler,
  Plug,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  computeSystemInsights,
  createArchNode,
  uid,
  type ArchEdge,
  type ArchNode,
  type ArchNodeKind,
  type SystemInsights,
  type SystemLink,
  type SystemModule,
  type SystemOverview,
  type SystemOverviewDiff,
  type SystemRole,
} from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";

/**
 * Systems view — the logical architecture overview, built for making calls:
 *
 *  - one card per system (authentication, submission, integrations…) with the
 *    consumed export surface, consumed systems/services and weighted links;
 *  - *insights*: dependency cycles (tinted on the canvas), layering
 *    violations, hubs and orphans — the review checklist, precomputed;
 *  - *ref review*: diff the overview against a branch/commit — systems and
 *    links that a change adds, drops or reshapes, before it merges;
 *  - *materialize*: snapshot the visible systems into an editable diagram.
 *
 * Data is the pure `codemap.overview` projection; the view re-fetches as the
 * code or the semantic index change.
 */

const ROLE_META: Record<SystemRole, { label: string; accent: string; icon: typeof Boxes }> = {
  domain: { label: "Domain", accent: "var(--color-accent-violet)", icon: Boxes },
  integration: { label: "Integration", accent: "var(--color-accent-amber)", icon: Plug },
  data: { label: "Data", accent: "var(--color-accent-emerald)", icon: Database },
  shared: { label: "Shared", accent: "var(--color-accent-slate)", icon: Layers },
  entry: { label: "Entry", accent: "var(--color-accent-cyan)", icon: DoorOpen },
};

/** Diagram node kind a materialized system gets, by role. */
const ARCH_KIND_OF_ROLE: Record<SystemRole, ArchNodeKind> = {
  domain: "service",
  integration: "external",
  data: "datastore",
  shared: "package",
  entry: "gateway",
};

/** Roles hidden by default — platform noise the overview exists to trim. */
const QUIET_ROLES: readonly SystemRole[] = ["shared", "entry"];

const CARD_W = 252;
const HEADER_H = 54;
const ROW_H = 18;
const SECTION_PAD = 26;

type DiffMark = "added" | "removed";

interface SystemNodeData extends Record<string, unknown> {
  system: SystemModule;
  consumes: string[];
  selected: boolean;
  dimmed: boolean;
  exportsShown: number;
  mark?: DiffMark;
}
type SystemRfNode = RfNode<SystemNodeData>;

function cardHeight(system: SystemModule, exportsShown: number, consumes: string[]): number {
  let h = HEADER_H;
  if (exportsShown > 0) h += SECTION_PAD + exportsShown * ROW_H;
  if (consumes.length > 0 || system.externals.length > 0) h += SECTION_PAD + ROW_H;
  return h;
}

function SystemNode({ data }: NodeProps<SystemRfNode>) {
  const { system, consumes, selected, dimmed, exportsShown, mark } = data;
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  const packages = [...new Set(system.parts.map((p) => p.pkg))];
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-surface-1 shadow-sm transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        mark === "removed" && "border-dashed",
        dimmed && "opacity-25",
        !dimmed && mark === "removed" && "opacity-50",
      )}
      style={{ borderTopColor: meta.accent, borderTopWidth: 2 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-edge" />
      <Handle type="source" position={Position.Right} className="!bg-edge" />
      <div className="flex items-start gap-2 px-3 pt-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: meta.accent }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-semibold text-ink">{system.name}</span>
            {mark === "added" && (
              <span className="shrink-0 rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">new</span>
            )}
            {mark === "removed" && (
              <span className="shrink-0 rounded-full bg-danger/15 px-1.5 text-[9px] text-danger">
                gone
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-ink-faint">
            {system.fileCount} files
            {packages.length > 1
              ? ` · ${packages.length} packages`
              : packages[0] && packages[0] !== "."
                ? ` · ${packages[0]}`
                : ""}
          </div>
        </div>
      </div>
      {exportsShown > 0 && (
        <div className="mt-1.5 border-t border-edge/60 px-3 pt-1">
          <div className="text-[9px] font-medium uppercase tracking-wide text-ink-faint">
            Exports
          </div>
          {system.exports.slice(0, exportsShown).map((e) => (
            <div key={`${e.file}#${e.name}`} className="flex items-baseline gap-1.5 leading-[18px]">
              <span className="truncate font-mono text-[10px] text-ink-muted">{e.name}</span>
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
            </div>
          ))}
        </div>
      )}
      {(consumes.length > 0 || system.externals.length > 0) && (
        <div className="mt-auto border-t border-edge/60 px-3 pb-2 pt-1">
          <div className="text-[9px] font-medium uppercase tracking-wide text-ink-faint">
            Consumes
          </div>
          <div className="truncate text-[10px] leading-[18px] text-ink-muted">
            {consumes.slice(0, 3).join(", ")}
            {consumes.length > 3 ? ` +${consumes.length - 3}` : ""}
            {system.externals.length > 0 && (
              <span className="text-accent-amber">
                {consumes.length > 0 ? " · " : ""}
                {system.externals
                  .slice(0, 2)
                  .map((x) => x.name)
                  .join(", ")}
                {system.externals.length > 2 ? ` +${system.externals.length - 2}` : ""}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = { system: SystemNode };

function layout(nodes: SystemRfNode[], edges: RfEdge[]): SystemRfNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: CARD_W, height: (n.style?.height as number) ?? 120 });
  }
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    const h = (n.style?.height as number) ?? 120;
    return { ...n, position: { x: pos.x - CARD_W / 2, y: pos.y - h / 2 } };
  });
}

interface RefDiffState {
  ref: string;
  commit: string;
  base: SystemOverview;
  head: SystemOverview;
  diff: SystemOverviewDiff;
}

export interface SystemsViewProps {
  /** "Show this system's code" — drills into the code map / diagram canvas. */
  onOpenCode?: (module: string) => void;
}

export function SystemsView(props: SystemsViewProps = {}) {
  return (
    <ReactFlowProvider>
      <SystemsInner {...props} />
    </ReactFlowProvider>
  );
}

type SidePanel = "system" | "edge" | "insights" | "diff" | null;

function SystemsInner({ onOpenCode }: SystemsViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const nav = useNavUpdate();
  const selectedId = useNav((l) => l.architect?.system ?? null);
  const setSelected = useCallback(
    (id: string | null) => nav({ architect: { system: id } }),
    [nav],
  );

  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [hiddenRoles, setHiddenRoles] = useState<ReadonlySet<SystemRole>>(
    () => new Set(QUIET_ROLES),
  );
  const [search, setSearch] = useState("");
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [refDiff, setRefDiff] = useState<RefDiffState | null>(null);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    setLoading(overview === null);
    client
      .request("codemap.overview", {})
      .then((res) => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetches when the code map or the semantic index move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, activeWs, generation]);

  useEffect(() => {
    const bump = ({ ws }: { ws: string }) => {
      if (ws === activeWs) setGeneration((g) => g + 1);
    };
    const d1 = client.events.on("codemap.changed", bump);
    const d2 = client.events.on("codeindex.changed", bump);
    return () => {
      d1();
      d2();
    };
  }, [client, activeWs]);

  // Reset per-workspace state when switching workspaces.
  useEffect(() => {
    setOverview(null);
    setLoading(true);
    setRefDiff(null);
    setDiffOpen(false);
    setSelectedEdge(null);
    setGeneration((g) => g + 1);
  }, [activeWs]);

  // Esc walks back: edge → system → review mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedEdge) setSelectedEdge(null);
      else if (selectedId) setSelected(null);
      else if (refDiff) setRefDiff(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdge, selectedId, refDiff, setSelected]);

  const reviewRef = useCallback(
    async (ref: string) => {
      if (!ref.trim()) return;
      setRefLoading(true);
      setRefError(null);
      try {
        const res = await client.request("codemap.overviewDiff", { ref: ref.trim() });
        setRefDiff(res);
        setDiffOpen(true);
        setSelectedEdge(null);
      } catch (err) {
        setRefError(err instanceof Error ? err.message : String(err));
      } finally {
        setRefLoading(false);
      }
    },
    [client],
  );

  /** The overview being rendered: live, or head + ghosts of what the ref had. */
  const rendered = useMemo(() => {
    if (!refDiff) {
      return overview
        ? { overview, marks: new Map<string, DiffMark>(), edgeMarks: new Map<string, DiffMark>() }
        : null;
    }
    const marks = new Map<string, DiffMark>();
    const edgeMarks = new Map<string, DiffMark>();
    for (const s of refDiff.diff.addedSystems) marks.set(s.id, "added");
    const removedSystems = refDiff.base.systems.filter((s) =>
      refDiff.diff.removedSystems.some((r) => r.id === s.id),
    );
    for (const s of removedSystems) marks.set(s.id, "removed");
    for (const l of refDiff.diff.addedLinks) edgeMarks.set(`${l.source}->${l.target}`, "added");
    const removedLinks: SystemLink[] = refDiff.diff.removedLinks.map((l) => {
      edgeMarks.set(`${l.source}->${l.target}`, "removed");
      return { source: l.source, target: l.target, weight: l.weight, symbols: l.symbols };
    });
    return {
      overview: {
        ...refDiff.head,
        systems: [...refDiff.head.systems, ...removedSystems],
        links: [...refDiff.head.links, ...removedLinks],
      },
      marks,
      edgeMarks,
    };
  }, [overview, refDiff]);

  // Insights always describe the live overview, not the review ghosts.
  const insights: SystemInsights | null = useMemo(
    () => (overview ? computeSystemInsights(overview) : null),
    [overview],
  );
  // Only tight cycles tint the canvas — painting a giant tangle's every edge
  // rose says nothing; the insights panel carries the big SCCs instead.
  const cycleEdges = useMemo(() => {
    const set = new Set<string>();
    for (const c of insights?.cycles ?? []) {
      if (c.ids.length > 6) continue;
      for (const e of c.edges) set.add(`${e.source}->${e.target}`);
    }
    return set;
  }, [insights]);

  const nameOf = useMemo(() => {
    const map = new Map(rendered?.overview.systems.map((s) => [s.id, s.name]) ?? []);
    return (id: string) => map.get(id) ?? id;
  }, [rendered]);

  const visible = useMemo(
    () =>
      new Set(
        (rendered?.overview.systems ?? [])
          .filter((s) => !hiddenRoles.has(s.role))
          .map((s) => s.id),
      ),
    [rendered, hiddenRoles],
  );

  const { nodes, edges } = useMemo(() => {
    if (!rendered) return { nodes: [] as SystemRfNode[], edges: [] as RfEdge[] };
    const { overview: data, marks, edgeMarks } = rendered;
    const query = search.trim().toLowerCase();
    const links = data.links.filter((l) => visible.has(l.source) && visible.has(l.target));
    const connected = new Set(
      selectedId
        ? links.flatMap((l) =>
            l.source === selectedId || l.target === selectedId ? [l.source, l.target] : [],
          )
        : [],
    );
    const consumesOf = new Map<string, string[]>();
    for (const l of data.links) {
      if (!visible.has(l.source)) continue;
      const list = consumesOf.get(l.source) ?? [];
      list.push(nameOf(l.target));
      consumesOf.set(l.source, list);
    }
    const nodes: SystemRfNode[] = data.systems
      .filter((s) => visible.has(s.id))
      .map((s) => {
        const consumes = consumesOf.get(s.id) ?? [];
        const exportsShown = Math.min(s.exports.length, 4);
        const searchMiss = query.length > 0 && !s.name.toLowerCase().includes(query);
        return {
          id: s.id,
          type: "system",
          position: { x: 0, y: 0 },
          data: {
            system: s,
            consumes,
            selected: s.id === selectedId,
            dimmed:
              searchMiss ||
              (selectedId != null && s.id !== selectedId && !connected.has(s.id)),
            exportsShown,
            mark: marks.get(s.id),
          },
          style: { width: CARD_W, height: cardHeight(s, exportsShown, consumes) },
        };
      });
    const maxWeight = links.reduce((m, l) => Math.max(m, l.weight), 1);
    const edges: RfEdge[] = links.map((l) => {
      const key = `${l.source}->${l.target}`;
      const mark = edgeMarks.get(key);
      const inCycle = cycleEdges.has(key);
      const active =
        key === selectedEdge ||
        (selectedId != null && (l.source === selectedId || l.target === selectedId));
      const faded = (selectedId != null || selectedEdge != null) && !active;
      const stroke = mark === "added"
        ? "var(--color-ok)"
        : mark === "removed"
          ? "var(--color-danger)"
          : inCycle
            ? "var(--color-accent-rose)"
            : active
              ? "var(--color-accent-violet)"
              : "var(--color-edge-strong)";
      return {
        id: key,
        source: l.source,
        target: l.target,
        label: `×${l.weight}`,
        labelStyle: { fontSize: 9, fill: "var(--color-ink-faint)" },
        labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
        style: {
          stroke,
          strokeWidth: 1 + 2 * Math.sqrt(l.weight / maxWeight),
          strokeDasharray: mark === "removed" ? "5 4" : undefined,
          opacity: faded ? 0.1 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
    });
    return { nodes: layout(nodes, edges), edges };
  }, [rendered, visible, selectedId, selectedEdge, nameOf, search, cycleEdges]);

  /** Snapshot the visible systems into a hand-editable diagram. */
  const materialize = useCallback(async () => {
    if (!rendered) return;
    const created = await client.request("arch.create", { name: "Systems overview" });
    const idMap = new Map<string, ArchNode>();
    const archNodes: ArchNode[] = [];
    for (const n of nodes) {
      const s = n.data.system;
      if (n.data.mark === "removed") continue;
      const node = createArchNode(ARCH_KIND_OF_ROLE[s.role], s.name, { ...n.position });
      archNodes.push({
        ...node,
        description: `${s.fileCount} files · ${ROLE_META[s.role].label.toLowerCase()}`,
        size: { width: CARD_W, height: (n.style?.height as number) ?? 120 },
      });
      idMap.set(s.id, archNodes[archNodes.length - 1]!);
    }
    const archEdges: ArchEdge[] = [];
    for (const e of edges) {
      const source = idMap.get(e.source);
      const target = idMap.get(e.target);
      if (!source || !target) continue;
      archEdges.push({
        id: uid("edge"),
        source: source.id,
        target: target.id,
        kind: "dependency",
        label: typeof e.label === "string" ? e.label : "",
      });
    }
    await client.request("arch.save", {
      path: created.path,
      graph: { ...created.graph, nodes: archNodes, edges: archEdges },
    });
    nav({ architect: { view: "diagrams", diagram: created.path } });
  }, [rendered, nodes, edges, client, nav]);

  const selected = rendered?.overview.systems.find((s) => s.id === selectedId) ?? null;
  const selectedLink = selectedEdge
    ? (rendered?.overview.links.find((l) => `${l.source}->${l.target}` === selectedEdge) ?? null)
    : null;
  const roleCounts = useMemo(() => {
    const counts = new Map<SystemRole, number>();
    for (const s of rendered?.overview.systems ?? [])
      counts.set(s.role, (counts.get(s.role) ?? 0) + 1);
    return counts;
  }, [rendered]);

  if (loading && !rendered) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!rendered || rendered.overview.systems.length === 0) {
    return (
      <EmptyState icon={Boxes} title="No systems yet">
        The systems overview appears once the workspace has analyzable source.
      </EmptyState>
    );
  }

  const panel: SidePanel = selectedLink
    ? "edge"
    : selected
      ? "system"
      : diffOpen && refDiff
        ? "diff"
        : insightsOpen
          ? "insights"
          : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => {
            setSelectedEdge(null);
            setSelected(n.id === selectedId ? null : n.id);
          }}
          onEdgeClick={(_, e) => {
            setSelected(null);
            setSelectedEdge(e.id === selectedEdge ? null : e.id);
          }}
          onPaneClick={() => {
            setSelected(null);
            setSelectedEdge(null);
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-surface-1" />
        </ReactFlow>

        {/* Top-left: role legend + search + stats. */}
        <div className="absolute left-3 top-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm">
            {(Object.keys(ROLE_META) as SystemRole[]).map((role) => {
              const meta = ROLE_META[role];
              const count = roleCounts.get(role) ?? 0;
              if (count === 0) return null;
              const hidden = hiddenRoles.has(role);
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() =>
                    setHiddenRoles((prev) => {
                      const next = new Set(prev);
                      if (next.has(role)) next.delete(role);
                      else next.add(role);
                      return next;
                    })
                  }
                  className={cn(
                    "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
                    hidden ? "text-ink-faint opacity-60" : "text-ink-muted hover:text-ink",
                  )}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: meta.accent, opacity: hidden ? 0.35 : 1 }}
                  />
                  {meta.label}
                  <span className="text-ink-faint">{count}</span>
                </button>
              );
            })}
            <span className="mx-1 h-3 w-px bg-edge" />
            <span className="px-1 text-[10px] text-ink-faint">
              {rendered.overview.systems.length} systems · {rendered.overview.links.length} links ·{" "}
              {rendered.overview.fileTotal} files
            </span>
          </div>
          <div className="flex w-56 items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 shadow-sm">
            <Search className="h-3 w-3 shrink-0 text-ink-faint" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter systems…"
              className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")}>
                <X className="h-3 w-3 text-ink-faint hover:text-ink" />
              </button>
            )}
          </div>
        </div>

        {/* Top-right: review-vs-ref + insights + materialize. */}
        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          {refDiff ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 shadow-sm">
              <GitCompare className="h-3 w-3 text-accent-violet" />
              <span className="text-[10px] text-ink">
                vs <span className="font-mono">{refDiff.ref}</span>
                <span className="text-ink-faint"> ({refDiff.commit})</span>
              </span>
              <span className="rounded-full bg-surface-3 px-1.5 text-[9px] text-ink-muted">
                {refDiff.diff.total} changes
              </span>
              <button
                type="button"
                onClick={() => {
                  setRefDiff(null);
                  setDiffOpen(false);
                }}
                aria-label="Exit review"
              >
                <X className="h-3 w-3 text-ink-faint hover:text-ink" />
              </button>
            </div>
          ) : (
            <form
              className="flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void reviewRef(refInput);
              }}
            >
              <GitCompare className="ml-0.5 h-3 w-3 shrink-0 text-ink-faint" />
              <input
                value={refInput}
                onChange={(e) => setRefInput(e.target.value)}
                placeholder="Review vs ref…"
                className="w-32 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
              />
              <Button type="submit" size="sm" variant="ghost" disabled={refLoading}>
                {refLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Go"}
              </Button>
            </form>
          )}
          <button
            type="button"
            onClick={() => {
              setInsightsOpen((v) => !v);
              setDiffOpen(false);
              setSelected(null);
              setSelectedEdge(null);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1.5 text-[11px] shadow-sm transition-colors",
              insightsOpen ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <AlertTriangle
              className={cn("h-3 w-3", (insights?.total ?? 0) > 0 ? "text-warn" : "text-ink-faint")}
            />
            Insights
            {(insights?.total ?? 0) > 0 && (
              <span className="rounded-full bg-warn/15 px-1.5 text-[9px] text-warn">
                {insights?.total}
              </span>
            )}
          </button>
          <Tooltip content="Snapshot the visible systems into an editable diagram">
            <button
              type="button"
              onClick={() => void materialize()}
              className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1.5 text-[11px] text-ink-muted shadow-sm transition-colors hover:text-ink"
            >
              <PencilRuler className="h-3 w-3" />
              To diagram
            </button>
          </Tooltip>
        </div>
        {refError && (
          <div className="absolute right-3 top-12 rounded-lg border border-danger/40 bg-surface-1/95 px-2 py-1 text-[10px] text-danger shadow-sm">
            {refError}
          </div>
        )}
      </div>

      {panel === "edge" && selectedLink && (
        <EdgeDetail
          link={selectedLink}
          nameOf={nameOf}
          onSelect={(id) => {
            setSelectedEdge(null);
            setSelected(id);
          }}
          onClose={() => setSelectedEdge(null)}
        />
      )}
      {panel === "system" && selected && (
        <SystemDetail
          system={selected}
          links={rendered.overview.links}
          nameOf={nameOf}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onOpenCode={onOpenCode}
        />
      )}
      {panel === "diff" && refDiff && (
        <DiffPanel state={refDiff} onSelect={setSelected} onClose={() => setDiffOpen(false)} />
      )}
      {panel === "insights" && insights && (
        <InsightsPanel
          insights={insights}
          onSelect={(id) => setSelected(id)}
          onClose={() => setInsightsOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Side panes                                                          */
/* ------------------------------------------------------------------ */

function Pane({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface-1">
      <div className="flex items-start gap-2 border-b border-edge px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          {subtitle && <div className="text-[10px] text-ink-faint">{subtitle}</div>}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {children}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge/60 px-1.5 py-2">
      <div className="px-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
        {title}
      </div>
      {children}
    </div>
  );
}

function EdgeDetail({
  link,
  nameOf,
  onSelect,
  onClose,
}: {
  link: SystemLink;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Pane
      title={
        <span className="flex items-center gap-1">
          <button type="button" className="hover:underline" onClick={() => onSelect(link.source)}>
            {nameOf(link.source)}
          </button>
          <ArrowUpRight className="h-3 w-3 text-ink-faint" />
          <button type="button" className="hover:underline" onClick={() => onSelect(link.target)}>
            {nameOf(link.target)}
          </button>
        </span>
      }
      subtitle={`${link.weight} import${link.weight === 1 ? "" : "s"} across the boundary`}
      onClose={onClose}
    >
      <Section title={`Symbols travelling this edge · top ${link.symbols.length}`}>
        {link.symbols.length === 0 && (
          <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
            Side-effect or namespace imports only.
          </div>
        )}
        {link.symbols.map((s) => (
          <div key={s} className="px-1.5 py-0.5 font-mono text-[10px] text-ink">
            {s}
          </div>
        ))}
      </Section>
    </Pane>
  );
}

function SystemDetail({
  system,
  links,
  nameOf,
  onClose,
  onSelect,
  onOpenCode,
}: {
  system: SystemModule;
  links: SystemLink[];
  nameOf: (id: string) => string;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onOpenCode?: (module: string) => void;
}) {
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  const outbound = links.filter((l) => l.source === system.id);
  const inbound = links.filter((l) => l.target === system.id);

  const linkRow = (link: SystemLink, other: string, dir: "out" | "in") => (
    <button
      key={`${dir}:${other}`}
      type="button"
      onClick={() => onSelect(other)}
      className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
    >
      {dir === "out" ? (
        <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
      ) : (
        <ArrowDownRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-ink">{nameOf(other)}</span>
        {link.symbols.length > 0 && (
          <span className="block truncate font-mono text-[9px] text-ink-faint">
            {link.symbols.join(", ")}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[10px] text-ink-faint">×{link.weight}</span>
    </button>
  );

  return (
    <Pane
      title={
        <span className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 shrink-0" style={{ color: meta.accent }} />
          {system.name}
        </span>
      }
      subtitle={`${meta.label} · ${system.fileCount} files${system.concept ? ` · intent:${system.concept}` : ""}`}
      onClose={onClose}
    >
      <Section title="Parts">
        {system.parts.map((p) => (
          <div key={p.path} className="flex items-center gap-1.5 px-1.5 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
              {p.path}
            </span>
            <span className="shrink-0 text-[9px] text-ink-faint">{p.fileCount}</span>
            {onOpenCode && (
              <Tooltip content="Open in the architecture canvas">
                <button
                  type="button"
                  onClick={() => onOpenCode(p.pkg)}
                  className="text-ink-faint hover:text-ink"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              </Tooltip>
            )}
          </div>
        ))}
      </Section>

      {system.intents.length > 0 && (
        <Section title="Intents">
          <div className="flex flex-wrap gap-1 px-1.5 py-0.5">
            {system.intents.map((i) => (
              <Badge key={i.value} className="text-[9px]">
                {i.value} <span className="ml-0.5 text-ink-faint">{i.weight}</span>
              </Badge>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Exports · ${system.exports.length} consumed of ${system.exportedTotal}`}>
        {system.exports.length === 0 && (
          <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
            Nothing outside this system imports from it.
          </div>
        )}
        {system.exports.map((e) => (
          <button
            key={`${e.file}#${e.name}`}
            type="button"
            onClick={() => requestOpenFile(e.file)}
            className="flex w-full items-baseline gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
            title={e.file}
          >
            <span className="shrink-0 text-[9px] uppercase text-ink-faint">{e.kind.slice(0, 2)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">{e.name}</span>
            <span className="shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
          </button>
        ))}
      </Section>

      {(outbound.length > 0 || system.externals.length > 0) && (
        <Section title="Consumes">
          {outbound.map((l) => linkRow(l, l.target, "out"))}
          {system.externals.map((x) => (
            <div key={x.id} className="flex items-center gap-1.5 px-1.5 py-1">
              <Plug className="h-3 w-3 shrink-0 text-accent-amber" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{x.name}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">×{x.weight}</span>
            </div>
          ))}
        </Section>
      )}

      {inbound.length > 0 && (
        <Section title="Consumed by">{inbound.map((l) => linkRow(l, l.source, "in"))}</Section>
      )}
    </Pane>
  );
}

function InsightsPanel({
  insights,
  onSelect,
  onClose,
}: {
  insights: SystemInsights;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Pane
      title="Insights"
      subtitle={
        insights.total === 0
          ? "No cycles or layering violations"
          : `${insights.cycles.length} cycle${insights.cycles.length === 1 ? "" : "s"} · ${insights.violations.length} violation${insights.violations.length === 1 ? "" : "s"}`
      }
      onClose={onClose}
    >
      {insights.cycles.length > 0 && (
        <Section title="Dependency cycles">
          {insights.cycles.map((c) => (
            <div key={c.ids.join()} className="px-1.5 py-1">
              <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink">
                {c.names.slice(0, 8).map((n, i) => (
                  <span key={c.ids[i]} className="flex items-center gap-1">
                    {i > 0 && <span className="text-accent-rose">⇄</span>}
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => onSelect(c.ids[i]!)}
                    >
                      {n}
                    </button>
                  </span>
                ))}
                {c.names.length > 8 && (
                  <span className="text-ink-faint">+{c.names.length - 8} more</span>
                )}
              </div>
              <div className="text-[9px] text-ink-faint">
                {c.ids.length} systems · {c.edges.length} edges · ×{c.weight} imports entangled
              </div>
            </div>
          ))}
        </Section>
      )}
      {insights.violations.length > 0 && (
        <Section title="Layering violations">
          {insights.violations.map((v) => (
            <button
              key={`${v.source}->${v.target}`}
              type="button"
              onClick={() => onSelect(v.source)}
              className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
            >
              <div className="text-[11px] text-ink">
                {v.sourceName} → {v.targetName}
                <span className="ml-1 text-[9px] text-ink-faint">×{v.weight}</span>
              </div>
              <div className="text-[9px] leading-snug text-ink-faint">{v.detail}</div>
            </button>
          ))}
        </Section>
      )}
      {insights.hubs.length > 0 && (
        <Section title="Coupling hot-spots">
          {insights.hubs.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => onSelect(h.id)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{h.name}</span>
              <span className="shrink-0 text-[9px] text-ink-faint">{h.degree} neighbours</span>
            </button>
          ))}
        </Section>
      )}
      {insights.orphans.length > 0 && (
        <Section title="Disconnected">
          {insights.orphans.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => onSelect(o.id)}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{o.name}</span>
              <span className="shrink-0 text-[9px] text-ink-faint">{o.fileCount} files</span>
            </button>
          ))}
        </Section>
      )}
      <Section title="Coupling (fan-in / fan-out / instability)">
        {insights.metrics.slice(0, 12).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{m.name}</span>
            <span className="shrink-0 font-mono text-[9px] text-ink-faint">
              {m.fanIn}/{m.fanOut}
              {m.instability != null ? ` · I=${m.instability}` : ""}
            </span>
          </button>
        ))}
      </Section>
    </Pane>
  );
}

function DiffPanel({
  state,
  onSelect,
  onClose,
}: {
  state: RefDiffState;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { diff } = state;
  const row = (key: string, id: string, label: string, detail: string, tone?: "ok" | "danger") => (
    <button
      key={key}
      type="button"
      onClick={() => onSelect(id)}
      className="block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
    >
      <div
        className={cn(
          "text-[11px]",
          tone === "ok" ? "text-ok" : tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {label}
      </div>
      {detail && <div className="text-[9px] leading-snug text-ink-faint">{detail}</div>}
    </button>
  );

  return (
    <Pane
      title={`Review vs ${state.ref}`}
      subtitle={
        diff.total === 0
          ? "No structural change to the systems"
          : `${diff.total} structural change${diff.total === 1 ? "" : "s"} · ${state.commit}`
      }
      onClose={onClose}
    >
      {diff.addedSystems.length > 0 && (
        <Section title="New systems">
          {diff.addedSystems.map((s) =>
            row(s.id, s.id, s.name, `${s.role} · ${s.fileCount} files`, "ok"),
          )}
        </Section>
      )}
      {diff.removedSystems.length > 0 && (
        <Section title="Removed systems">
          {diff.removedSystems.map((s) =>
            row(s.id, s.id, s.name, `${s.role} · was ${s.fileCount} files`, "danger"),
          )}
        </Section>
      )}
      {diff.addedLinks.length > 0 && (
        <Section title="New dependencies">
          {diff.addedLinks.map((l) =>
            row(
              `${l.source}->${l.target}`,
              l.source,
              `${l.sourceName} → ${l.targetName} ×${l.weight}`,
              l.symbols.join(", "),
              "ok",
            ),
          )}
        </Section>
      )}
      {diff.removedLinks.length > 0 && (
        <Section title="Dropped dependencies">
          {diff.removedLinks.map((l) =>
            row(
              `${l.source}->${l.target}`,
              l.source,
              `${l.sourceName} → ${l.targetName}`,
              l.symbols.join(", "),
              "danger",
            ),
          )}
        </Section>
      )}
      {diff.reweighted.length > 0 && (
        <Section title="Coupling shifts">
          {diff.reweighted.map((l) =>
            row(
              `${l.source}->${l.target}`,
              l.source,
              `${l.sourceName} → ${l.targetName}: ×${l.before} → ×${l.after}`,
              l.symbols.join(", "),
            ),
          )}
        </Section>
      )}
      {diff.resized.length > 0 && (
        <Section title="Size shifts">
          {diff.resized.map((s) =>
            row(s.id, s.id, s.name, `${s.before} → ${s.after} files`),
          )}
        </Section>
      )}
      {diff.addedExternals.length > 0 && (
        <Section title="New external services">
          {diff.addedExternals.map((x) =>
            row(`${x.system}:${x.name}`, x.system, `${x.systemName} now talks to ${x.name}`, "", "ok"),
          )}
        </Section>
      )}
      {diff.removedExternals.length > 0 && (
        <Section title="Dropped external services">
          {diff.removedExternals.map((x) =>
            row(
              `${x.system}:${x.name}`,
              x.system,
              `${x.systemName} no longer talks to ${x.name}`,
              "",
              "danger",
            ),
          )}
        </Section>
      )}
    </Pane>
  );
}

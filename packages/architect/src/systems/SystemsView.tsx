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
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Database,
  DoorOpen,
  ExternalLink,
  Layers,
  Plug,
  X,
} from "lucide-react";
import type { SystemLink, SystemModule, SystemOverview, SystemRole } from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import { Badge, Button, EmptyState, Spinner, Tooltip, cn } from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";

/**
 * Systems view — the logical architecture overview. One card per system
 * (authentication, submission, external integrations…), showing the exports
 * the rest of the codebase consumes, the systems and external services it
 * leans on, and weighted links between them. Data is the pure projection
 * from `codemap.overview`; the view re-fetches as code or index change.
 */

const ROLE_META: Record<
  SystemRole,
  { label: string; accent: string; icon: typeof Boxes }
> = {
  domain: { label: "Domain", accent: "var(--color-accent-violet)", icon: Boxes },
  integration: { label: "Integration", accent: "var(--color-accent-amber)", icon: Plug },
  data: { label: "Data", accent: "var(--color-accent-emerald)", icon: Database },
  shared: { label: "Shared", accent: "var(--color-accent-slate)", icon: Layers },
  entry: { label: "Entry", accent: "var(--color-accent-cyan)", icon: DoorOpen },
};

/** Roles hidden by default — platform noise the overview exists to trim. */
const QUIET_ROLES: readonly SystemRole[] = ["shared", "entry"];

const CARD_W = 252;
const HEADER_H = 54;
const ROW_H = 18;
const SECTION_PAD = 26;

interface SystemNodeData extends Record<string, unknown> {
  system: SystemModule;
  /** Names of visible systems this one consumes (for the footer chips). */
  consumes: string[];
  selected: boolean;
  dimmed: boolean;
  exportsShown: number;
}
type SystemRfNode = RfNode<SystemNodeData>;

function cardHeight(system: SystemModule, exportsShown: number, consumes: string[]): number {
  let h = HEADER_H;
  if (exportsShown > 0) h += SECTION_PAD + exportsShown * ROW_H;
  if (consumes.length > 0 || system.externals.length > 0) h += SECTION_PAD + ROW_H;
  return h;
}

function SystemNode({ data }: NodeProps<SystemRfNode>) {
  const { system, consumes, selected, dimmed, exportsShown } = data;
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  const packages = [...new Set(system.parts.map((p) => p.pkg))];
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-surface-1 shadow-sm transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        dimmed && "opacity-30",
      )}
      style={{ borderTopColor: meta.accent, borderTopWidth: 2 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-edge" />
      <Handle type="source" position={Position.Right} className="!bg-edge" />
      <div className="flex items-start gap-2 px-3 pt-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: meta.accent }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-ink">{system.name}</div>
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

  // Reset per-workspace view state when switching workspaces.
  useEffect(() => {
    setOverview(null);
    setLoading(true);
    setGeneration((g) => g + 1);
  }, [activeWs]);

  const nameOf = useMemo(() => {
    const map = new Map(overview?.systems.map((s) => [s.id, s.name]) ?? []);
    return (id: string) => map.get(id) ?? id;
  }, [overview]);

  const visible = useMemo(
    () => new Set((overview?.systems ?? []).filter((s) => !hiddenRoles.has(s.role)).map((s) => s.id)),
    [overview, hiddenRoles],
  );

  const { nodes, edges } = useMemo(() => {
    if (!overview) return { nodes: [] as SystemRfNode[], edges: [] as RfEdge[] };
    const links = overview.links.filter((l) => visible.has(l.source) && visible.has(l.target));
    const connected = new Set(
      selectedId ? links.flatMap((l) => (l.source === selectedId || l.target === selectedId ? [l.source, l.target] : [])) : [],
    );
    const consumesOf = new Map<string, string[]>();
    for (const l of overview.links) {
      if (!visible.has(l.source)) continue;
      const list = consumesOf.get(l.source) ?? [];
      list.push(nameOf(l.target));
      consumesOf.set(l.source, list);
    }
    const nodes: SystemRfNode[] = overview.systems
      .filter((s) => visible.has(s.id))
      .map((s) => {
        const consumes = consumesOf.get(s.id) ?? [];
        const exportsShown = Math.min(s.exports.length, 4);
        return {
          id: s.id,
          type: "system",
          position: { x: 0, y: 0 },
          data: {
            system: s,
            consumes,
            selected: s.id === selectedId,
            dimmed: selectedId != null && s.id !== selectedId && !connected.has(s.id),
            exportsShown,
          },
          style: { width: CARD_W, height: cardHeight(s, exportsShown, consumes) },
        };
      });
    const maxWeight = links.reduce((m, l) => Math.max(m, l.weight), 1);
    const edges: RfEdge[] = links.map((l) => {
      const active = selectedId != null && (l.source === selectedId || l.target === selectedId);
      const faded = selectedId != null && !active;
      return {
        id: `${l.source}->${l.target}`,
        source: l.source,
        target: l.target,
        label: `×${l.weight}`,
        labelStyle: { fontSize: 9, fill: "var(--color-ink-faint)" },
        labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
        style: {
          stroke: active ? "var(--color-accent-violet)" : "var(--color-edge-strong)",
          strokeWidth: 1 + 2 * Math.sqrt(l.weight / maxWeight),
          opacity: faded ? 0.12 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
    });
    return { nodes: layout(nodes, edges), edges };
  }, [overview, visible, selectedId, nameOf]);

  const selected = overview?.systems.find((s) => s.id === selectedId) ?? null;
  const roleCounts = useMemo(() => {
    const counts = new Map<SystemRole, number>();
    for (const s of overview?.systems ?? []) counts.set(s.role, (counts.get(s.role) ?? 0) + 1);
    return counts;
  }, [overview]);

  if (loading && !overview) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!overview || overview.systems.length === 0) {
    return (
      <EmptyState icon={Boxes} title="No systems yet">
        The systems overview appears once the workspace has analyzable source.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSelected(n.id === selectedId ? null : n.id)}
          onPaneClick={() => setSelected(null)}
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
        {/* Role filter legend */}
        <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm">
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
        </div>
      </div>
      {selected && (
        <SystemDetail
          system={selected}
          links={overview.links}
          nameOf={nameOf}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onOpenCode={onOpenCode}
        />
      )}
    </div>
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
  onSelect: (id: string) => void;
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
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-edge bg-surface-1">
      <div className="flex items-start gap-2 border-b border-edge px-3 py-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: meta.accent }} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{system.name}</div>
          <div className="text-[10px] text-ink-faint">
            {meta.label} · {system.fileCount} files
            {system.concept ? ` · intent:${system.concept}` : ""}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

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

      <Section
        title={`Exports · ${system.exports.length} consumed of ${system.exportedTotal}`}
      >
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

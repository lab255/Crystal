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
  useReactFlow,
  type Edge as RfEdge,
  type Node as RfNode,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowRightLeft,
  ArrowUpRight,
  Boxes,
  Copy,
  Expand,
  ExternalLink,
  Folder,
  FolderGit2,
  GitCompare,
  Layers,
  Maximize,
  PencilRuler,
  Plug,
  RefreshCw,
  Search,
  Shrink,
  Sparkles,
  X,
} from "lucide-react";
import {
  SYSTEM_LAYERS,
  SYSTEM_LAYER_LABELS,
  computeSystemInsights,
  conceptDisplayName,
  createArchNode,
  indexFacetVisibility,
  parseLensTags,
  tagValue,
  uid,
  type ArchEdge,
  type ArchNode,
  type ArchNodeKind,
  type CodeIndex,
  type GitCommit,
  type GitRefsResult,
  type SystemInsights,
  type SystemLayer,
  type SystemLink,
  type SystemModule,
  type SystemPart,
  type SystemOverview,
  type SystemOverviewDiff,
  type SystemRole,
} from "@crystal/core";
import { useCrystal, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import {
  Badge,
  Button,
  Combobox,
  ContextMenu,
  EmptyState,
  Pane as SplitPane,
  Split,
  Spinner,
  Tooltip,
  cn,
  type ComboboxOption,
  type MenuEntry,
} from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";
import { FacetsPanel } from "../codemap/FacetsPanel.js";
import { ContractInspector, linkKeyOf } from "./ContractInspector.js";
import { ROLE_META } from "./role-meta.js";

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

/* ---- expanded systems (components + dependencies in place) ---- */

const PART_W = 190;
const PART_H = 46;
const GROUP_HEADER_H = 40;
const GROUP_PAD = 14;

interface SystemGroupData extends Record<string, unknown> {
  system: SystemModule;
  selected: boolean;
  dimmed: boolean;
  mark?: DiffMark;
  onCollapse: (id: string) => void;
}
type SystemGroupRfNode = RfNode<SystemGroupData>;

interface SystemPartData extends Record<string, unknown> {
  sysId: string;
  part: SystemPart;
  accent: string;
  dimmed: boolean;
}
type SystemPartRfNode = RfNode<SystemPartData>;

/** A system opened in place: header + its parts as child nodes. */
function SystemGroupNode({ data }: NodeProps<SystemGroupRfNode>) {
  const { system, selected, dimmed, mark, onCollapse } = data;
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border bg-surface-1/60 transition-opacity",
        selected ? "border-ink/40 ring-2 ring-ink/20" : "border-edge",
        mark === "removed" && "border-dashed",
        dimmed && "opacity-25",
      )}
      style={{ borderTopColor: meta.accent, borderTopWidth: 2 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-edge" />
      <Handle type="source" position={Position.Right} className="!bg-edge" />
      <div className="flex items-center gap-2 px-3 pt-2">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.accent }} />
        <span className="truncate text-[12px] font-semibold text-ink">{system.name}</span>
        {mark === "added" && (
          <span className="shrink-0 rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">new</span>
        )}
        {mark === "removed" && (
          <span className="shrink-0 rounded-full bg-danger/15 px-1.5 text-[9px] text-danger">gone</span>
        )}
        <span className="text-[10px] text-ink-faint">
          {system.parts.length} components · {system.fileCount} files
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCollapse(system.id);
          }}
          aria-label="Collapse system"
          className="ml-auto text-ink-faint hover:text-ink"
        >
          <Shrink className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/** One component (structural part) of an expanded system. */
function SystemPartNode({ data }: NodeProps<SystemPartRfNode>) {
  const { part, accent, dimmed } = data;
  const name = part.path.split("/").at(-1) ?? part.path;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center rounded-md border border-edge bg-surface-2 px-2 py-1 shadow-sm transition-opacity",
        dimmed && "opacity-25",
      )}
      style={{ borderLeftColor: accent, borderLeftWidth: 2 }}
    >
      <Handle type="target" position={Position.Left} className="!bg-edge" />
      <Handle type="source" position={Position.Right} className="!bg-edge" />
      <div className="flex items-center gap-1.5">
        <Folder className="h-3 w-3 shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate text-[11px] font-medium text-ink">{name}</span>
        <span className="ml-auto shrink-0 text-[9px] text-ink-faint">{part.fileCount}</span>
      </div>
      <div className="truncate pl-4.5 font-mono text-[9px] text-ink-faint" title={part.path}>
        {part.path}
      </div>
    </div>
  );
}

/* ---- layer-band grouping (group-by: layers) ---- */

const BAND_HEADER = 34;
const BAND_PAD = 20;
const BAND_GAP = 48;

type LayerBandData = { layer: SystemLayer } & Record<string, unknown>;
type LayerBandRfNode = RfNode<LayerBandData>;
/** A top-level system card: collapsed, or expanded into a component group. */
type SysCardNode = SystemRfNode | SystemGroupRfNode;
/** What the canvas renders: system cards/groups, their parts, layer bands. */
type ViewNode = SysCardNode | SystemPartRfNode | LayerBandRfNode;

function LayerBandNode({ data }: NodeProps<LayerBandRfNode>) {
  return (
    <div className="h-full w-full rounded-2xl border border-edge/80 bg-surface-2/40">
      <div className="px-4 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {SYSTEM_LAYER_LABELS[data.layer]}
      </div>
    </div>
  );
}

const nodeTypes = {
  system: SystemNode,
  systemGroup: SystemGroupNode,
  systemPart: SystemPartNode,
  layerBand: LayerBandNode,
};

/** System-level dependency pairs — the layout skeleton (part edges excluded). */
interface SysPair {
  source: string;
  target: string;
}

function layout(nodes: SysCardNode[], pairs: readonly SysPair[]): SysCardNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    g.setNode(n.id, {
      width: (n.style?.width as number) ?? CARD_W,
      height: (n.style?.height as number) ?? 120,
    });
  }
  for (const e of pairs) {
    if (e.source !== e.target && ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    const w = (n.style?.width as number) ?? CARD_W;
    const h = (n.style?.height as number) ?? 120;
    return { ...n, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

/**
 * Layer mode: dagre runs per layer (same LR options as `layout`), each
 * non-empty layer becomes a labelled band node and its systems become
 * children positioned relative to the band. Bands stack vertically in
 * frontend → backend → database → integrations order. Parents precede
 * children in the returned array — react-flow requires it, the same
 * convention `topoOrderNodes` enforces for the diagram model.
 */
function layeredLayout(nodes: SysCardNode[], pairs: readonly SysPair[]): ViewNode[] {
  const byLayer = new Map<SystemLayer, SysCardNode[]>();
  for (const n of nodes) {
    const layer = n.data.system.layer;
    const list = byLayer.get(layer);
    if (list) list.push(n);
    else byLayer.set(layer, [n]);
  }
  const out: ViewNode[] = [];
  let y = 0;
  for (const layer of SYSTEM_LAYERS) {
    const members = byLayer.get(layer);
    if (!members || members.length === 0) continue;
    const ids = new Set(members.map((n) => n.id));
    const laid = layout(
      members,
      pairs.filter((e) => ids.has(e.source) && ids.has(e.target)),
    );
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of laid) {
      const w = (n.style?.width as number) ?? CARD_W;
      const h = (n.style?.height as number) ?? 120;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    const bandId = `layer:${layer}`;
    const width = maxX - minX + BAND_PAD * 2;
    const height = maxY - minY + BAND_HEADER + BAND_PAD;
    out.push({
      id: bandId,
      type: "layerBand",
      position: { x: 0, y },
      data: { layer },
      style: { width, height },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    });
    for (const n of laid) {
      out.push({
        ...n,
        parentId: bandId,
        position: { x: n.position.x - minX + BAND_PAD, y: n.position.y - minY + BAND_HEADER },
      });
    }
    y += height + BAND_GAP;
  }
  return out;
}

/** Stable node id of one part inside an expanded system. */
const partNodeId = (sysId: string, partPath: string): string => `part|${sysId}|${partPath}`;

/**
 * Inner layout of an expanded system: dagre (LR) over its parts wired by the
 * intra-system part links. Returns band-relative child positions and the
 * container size the group node needs.
 */
function expandLayout(system: SystemModule): {
  width: number;
  height: number;
  children: { part: SystemPart; x: number; y: number }[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 16, ranksep: 46, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const p of system.parts) g.setNode(p.path, { width: PART_W, height: PART_H });
  for (const l of system.partLinks ?? []) {
    if (l.source !== l.target) g.setEdge(l.source, l.target);
  }
  dagre.layout(g);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = system.parts.map((part) => {
    const pos = g.node(part.path);
    const x = pos.x - PART_W / 2;
    const y = pos.y - PART_H / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + PART_W);
    maxY = Math.max(maxY, y + PART_H);
    return { part, x, y };
  });
  return {
    width: Math.max(maxX - minX + GROUP_PAD * 2, CARD_W),
    height: maxY - minY + GROUP_HEADER_H + GROUP_PAD,
    children: raw.map((c) => ({
      part: c.part,
      x: c.x - minX + GROUP_PAD,
      y: c.y - minY + GROUP_HEADER_H,
    })),
  };
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

type SidePanel = "system" | "edge" | "insights" | "diff" | "facets" | "contracts" | null;

type MenuState =
  | { kind: "node"; x: number; y: number; id: string }
  | { kind: "part"; x: number; y: number; sys: string; path: string; pkg: string }
  | { kind: "edge"; x: number; y: number; id: string }
  | { kind: "pane"; x: number; y: number };

const EMPTY_STALE_FILES: string[] = [];

function SystemsInner({ onOpenCode }: SystemsViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const nav = useNavUpdate();
  const { fitView } = useReactFlow();
  const selectedId = useNav((l) => l.architect?.system ?? null);
  const setSelected = useCallback(
    (id: string | null) => nav({ architect: { system: id } }),
    [nav],
  );
  const sysGroup = useNav((l) => (l.architect?.sysGroup === "layers" ? "layers" : "modules"));
  const setSysGroup = useCallback(
    (g: "modules" | "layers") => nav({ architect: { sysGroup: g === "layers" ? "layers" : null } }),
    [nav],
  );
  const lensParam = useNav((l) => l.architect?.lens ?? null);
  const lensCtx = useNav((l) => l.architect?.lensCtx) ?? false;

  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [hiddenRoles, setHiddenRoles] = useState<ReadonlySet<SystemRole>>(
    () => new Set(QUIET_ROLES),
  );
  const [search, setSearch] = useState("");
  // Edge selection, panel toggles and in-place expansion are navigational —
  // they live in the nav store so back/forward and shared links restore the
  // exact screen, panels included.
  const selectedEdge = useNav((l) => l.architect?.edge ?? null);
  const setSelectedEdge = useCallback(
    (key: string | null) => nav({ architect: { edge: key } }),
    [nav],
  );
  const insightsOpen = useNav((l) => l.architect?.insights) ?? false;
  const facetsOpen = useNav((l) => l.architect?.facets) ?? false;
  const contractsOpen = useNav((l) => l.architect?.contracts) ?? false;
  const expandedIds = useNav((l) => l.architect?.expanded ?? null);
  const expandedSystems = useMemo<ReadonlySet<string>>(
    () => new Set(expandedIds ? expandedIds.split(",") : []),
    [expandedIds],
  );
  const setExpandedSystems = useCallback(
    (next: ReadonlySet<string>) =>
      nav({ architect: { expanded: next.size > 0 ? [...next].join(",") : null } }),
    [nav],
  );
  const [codeIndex, setCodeIndex] = useState<{ index: CodeIndex; staleFiles: string[] } | null>(
    null,
  );
  const [diffOpen, setDiffOpen] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [refDiff, setRefDiff] = useState<RefDiffState | null>(null);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [refs, setRefs] = useState<GitRefsResult | null>(null);
  const [refCommits, setRefCommits] = useState<GitCommit[] | null>(null);
  const refsFetched = useRef(false);
  const reviewBoxRef = useRef<HTMLDivElement | null>(null);

  /** A component (part) → the deep-linked code map, drilled into its package. */
  const openCodemapModule = useCallback(
    (pkg: string) => {
      if (!activeWs) return;
      nav({ architect: { view: "codemap", codemap: { kind: "module", ws: activeWs, path: pkg } } });
    },
    [nav, activeWs],
  );

  /**
   * "Expand" a system → the deep-linked code map, lens-filtered to the
   * system's exact boundary (its id is the lens tag) with first-degree
   * dependency context around it, focused on its dominant module.
   */
  const openSystemInCodemap = useCallback(
    (sys: SystemModule) => {
      const pkg = sys.parts[0]?.pkg;
      if (!activeWs || !pkg) return;
      nav({
        architect: {
          view: "codemap",
          codemap: { kind: "module", ws: activeWs, path: pkg },
          lens: sys.id,
          lensCtx: true,
        },
      });
    },
    [nav, activeWs],
  );

  const toggleExpanded = useCallback(
    (id: string) => {
      const next = new Set(expandedSystems);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpandedSystems(next);
    },
    [expandedSystems, setExpandedSystems],
  );
  const collapseSystem = useCallback(
    (id: string) => {
      if (!expandedSystems.has(id)) return;
      const next = new Set(expandedSystems);
      next.delete(id);
      setExpandedSystems(next);
    },
    [expandedSystems, setExpandedSystems],
  );

  const toggleRole = useCallback((role: SystemRole) => {
    setHiddenRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }, []);

  /** Ref-picker options — fetched once per mount, when the control first gains focus. */
  const loadRefs = useCallback(() => {
    if (refsFetched.current) return;
    refsFetched.current = true;
    client
      .request("git.refs", {})
      .then(setRefs)
      .catch(() => {});
    client
      .request("git.log", { limit: 20 })
      .then((r) => setRefCommits(r.commits))
      .catch(() => {});
  }, [client]);

  const refOptions = useMemo<ComboboxOption[]>(() => {
    const opts: ComboboxOption[] = [];
    if (refs) {
      const branches = refs.current
        ? [refs.current, ...refs.branches.filter((b) => b !== refs.current)]
        : refs.branches;
      for (const b of branches)
        opts.push({ value: b, group: "Branches", hint: b === refs.current ? "current" : undefined });
      for (const b of refs.remoteBranches) opts.push({ value: b, group: "Remote" });
      for (const t of refs.tags) opts.push({ value: t, group: "Tags" });
    }
    for (const c of refCommits ?? [])
      opts.push({
        value: c.shortHash,
        group: "Commits",
        hint: c.subject.length > 42 ? `${c.subject.slice(0, 41)}…` : c.subject,
      });
    return opts;
  }, [refs, refCommits]);

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

  // Reset per-workspace *local* state when switching workspaces. Nav-held
  // state (selection, edge, panels, expansion) is left alone — this effect
  // also fires on mount, where clearing it would defeat deep links.
  useEffect(() => {
    setOverview(null);
    setLoading(true);
    setRefDiff(null);
    setDiffOpen(false);
    setMenu(null);
    setCodeIndex(null);
    setRefs(null);
    setRefCommits(null);
    refsFetched.current = false;
    setGeneration((g) => g + 1);
  }, [activeWs]);

  // Esc walks back: edge → system → review mode. (An open context menu
  // consumes Escape itself.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menu) return;
      if (selectedEdge) setSelectedEdge(null);
      else if (selectedId) setSelected(null);
      else if (refDiff) setRefDiff(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdge, selectedId, refDiff, menu, setSelected]);

  /* ---- code index + facet lens (shares the codemap's `lens` deep link) ---- */

  const lensTags = useMemo(() => (lensParam ? parseLensTags(lensParam) : []), [lensParam]);
  // "sys:*" tags are system ids — resolved right here against the overview;
  // everything else is an intent facet resolved through the semantic index.
  const sysTags = useMemo(() => lensTags.filter((t) => t.startsWith("sys:")), [lensTags]);
  const intentTags = useMemo(() => lensTags.filter((t) => !t.startsWith("sys:")), [lensTags]);
  const wantIndex = facetsOpen || intentTags.length > 0;
  useEffect(() => {
    if (!activeWs || !wantIndex) return;
    let cancelled = false;
    const fetchIndex = () => {
      client
        .request("codeindex.get", {})
        .then((res) => {
          if (!cancelled) setCodeIndex(res);
        })
        .catch(() => {});
    };
    fetchIndex();
    const dispose = client.events.on("codeindex.changed", ({ ws }) => {
      if (ws === activeWs) fetchIndex();
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [client, activeWs, wantIndex]);

  const lensVis = useMemo(
    () =>
      codeIndex && intentTags.length > 0 ? indexFacetVisibility(codeIndex.index, intentTags) : null,
    [codeIndex, intentTags],
  );
  const lensName = useMemo(
    () =>
      lensTags
        .map((t) =>
          t.startsWith("intent:")
            ? conceptDisplayName(tagValue(t))
            : (overview?.systems.find((s) => s.id === t)?.name ?? t),
        )
        .join(" + "),
    [lensTags, overview],
  );

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

  /**
   * Systems the active facet lens covers. SystemModule exposes parts (dirs),
   * not files, so a system is "in the lens" when any member file falls under
   * one of its part paths. Null while no lens (or the index hasn't loaded).
   */
  const lensSystems = useMemo(() => {
    if (!rendered || (!lensVis && sysTags.length === 0)) return null;
    const inLens = new Set<string>(
      sysTags.filter((t) => rendered.overview.systems.some((s) => s.id === t)),
    );
    if (lensVis) {
      const files = [...lensVis.files.keys()];
      for (const s of rendered.overview.systems) {
        if (s.parts.some((p) => files.some((f) => f === p.path || f.startsWith(`${p.path}/`))))
          inLens.add(s.id);
      }
    }
    return inLens;
  }, [lensVis, sysTags, rendered]);

  // First-degree neighbors of the lens systems — the "+N connected" context
  // ring (same gesture as the code map's lens context, same deep link).
  const lensNeighborSystems = useMemo(() => {
    if (!lensSystems || !rendered) return null;
    const neighbors = new Set<string>();
    for (const l of rendered.overview.links) {
      const sourceIn = lensSystems.has(l.source);
      const targetIn = lensSystems.has(l.target);
      if (sourceIn && !targetIn) neighbors.add(l.target);
      else if (targetIn && !sourceIn) neighbors.add(l.source);
    }
    return neighbors;
  }, [lensSystems, rendered]);

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
    if (!rendered) return { nodes: [] as ViewNode[], edges: [] as RfEdge[] };
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
    // Only multi-part systems open — a single part is the card itself.
    const expanded = new Set(
      [...expandedSystems].filter((id) => {
        if (!visible.has(id)) return false;
        return (data.systems.find((s) => s.id === id)?.parts.length ?? 0) > 1;
      }),
    );

    const cards: SysCardNode[] = [];
    const partNodes: SystemPartRfNode[] = [];
    for (const s of data.systems) {
      if (!visible.has(s.id)) continue;
      const searchMiss = query.length > 0 && !s.name.toLowerCase().includes(query);
      const lensMiss =
        lensSystems != null &&
        !lensSystems.has(s.id) &&
        !(lensCtx && lensNeighborSystems?.has(s.id));
      const dimmed =
        searchMiss ||
        lensMiss ||
        (selectedId != null && s.id !== selectedId && !connected.has(s.id));
      const mark = marks.get(s.id);
      if (expanded.has(s.id)) {
        const inner = expandLayout(s);
        cards.push({
          id: s.id,
          type: "systemGroup",
          position: { x: 0, y: 0 },
          data: {
            system: s,
            selected: s.id === selectedId,
            dimmed,
            mark,
            onCollapse: collapseSystem,
          },
          style: { width: inner.width, height: inner.height },
        });
        const accent = ROLE_META[s.role].accent;
        for (const c of inner.children) {
          partNodes.push({
            id: partNodeId(s.id, c.part.path),
            type: "systemPart",
            parentId: s.id,
            position: { x: c.x, y: c.y },
            draggable: false,
            data: { sysId: s.id, part: c.part, accent, dimmed },
            style: { width: PART_W, height: PART_H },
          });
        }
        continue;
      }
      const consumes = consumesOf.get(s.id) ?? [];
      const exportsShown = Math.min(s.exports.length, 4);
      cards.push({
        id: s.id,
        type: "system",
        position: { x: 0, y: 0 },
        data: {
          system: s,
          consumes,
          selected: s.id === selectedId,
          dimmed,
          exportsShown,
          mark,
        },
        style: { width: CARD_W, height: cardHeight(s, exportsShown, consumes) },
      });
    }

    const maxWeight = links.reduce((m, l) => Math.max(m, l.weight), 1);
    const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const edges: RfEdge[] = [];
    for (const l of links) {
      const key = `${l.source}->${l.target}`;
      const mark = edgeMarks.get(key);
      const inCycle = cycleEdges.has(key);
      const apis = l.apis ?? [];
      // No imports cross this edge — the systems talk over the wire only.
      const apiOnly = l.weight === 0 && apis.length > 0;
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
              : apiOnly
                ? "var(--color-accent-amber)"
                : "var(--color-edge-strong)";
      const shared = {
        data: { linkKey: key },
        labelStyle: {
          fontSize: 9,
          fill: apiOnly ? "var(--color-accent-amber)" : "var(--color-ink-faint)",
        },
        labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
      // With an expanded endpoint, the edge splits along its part attribution.
      const splitEnds =
        !apiOnly && l.parts && (expanded.has(l.source) || expanded.has(l.target))
          ? [
              ...l.parts
                .reduce((agg, p) => {
                  const source = expanded.has(l.source)
                    ? partNodeId(l.source, p.sourcePart)
                    : l.source;
                  const target = expanded.has(l.target)
                    ? partNodeId(l.target, p.targetPart)
                    : l.target;
                  const k = `${source}->${target}`;
                  const entry = agg.get(k) ?? { source, target, weight: 0 };
                  entry.weight += p.weight;
                  return agg.set(k, entry);
                }, new Map<string, { source: string; target: string; weight: number }>())
                .values(),
            ]
          : null;
      if (splitEnds) {
        splitEnds.forEach((sp, i) => {
          edges.push({
            ...shared,
            id: `${key}#${i}`,
            source: sp.source,
            target: sp.target,
            zIndex: 1,
            label: `×${sp.weight}`,
            style: {
              stroke,
              strokeWidth: 1 + 2 * Math.sqrt(sp.weight / maxWeight),
              strokeDasharray: mark === "removed" ? "5 4" : undefined,
              opacity: faded ? 0.1 : 1,
            },
          });
        });
        continue;
      }
      const topSymbol = l.symbols[0];
      const label = apiOnly
        ? `${apis[0]!.method} ${apis[0]!.path}${apis.length > 1 ? ` +${apis.length - 1}` : ""}`
        : topSymbol
          ? `${trunc(topSymbol, 18)} ×${l.weight}`
          : `×${l.weight}`;
      edges.push({
        ...shared,
        id: key,
        source: l.source,
        target: l.target,
        label,
        style: {
          stroke,
          strokeWidth: 1 + 2 * Math.sqrt(l.weight / maxWeight),
          strokeDasharray: mark === "removed" ? "5 4" : apiOnly ? "4 3" : undefined,
          opacity: faded ? 0.1 : 1,
        },
      });
    }
    // Internal wiring of each expanded system.
    for (const id of expanded) {
      const s = data.systems.find((x) => x.id === id);
      for (const pl of s?.partLinks ?? []) {
        const faded = (selectedId != null || selectedEdge != null) && selectedId !== id;
        edges.push({
          id: `intra#${id}#${pl.source}->${pl.target}`,
          source: partNodeId(id, pl.source),
          target: partNodeId(id, pl.target),
          data: { sysId: id },
          zIndex: 1,
          label: `×${pl.weight}`,
          labelStyle: { fontSize: 8, fill: "var(--color-ink-faint)" },
          labelBgStyle: { fill: "var(--color-surface-1)", fillOpacity: 0.85 },
          style: {
            stroke: "var(--color-edge-strong)",
            strokeWidth: 1,
            opacity: faded ? 0.1 : 0.9,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        });
      }
    }

    const pairs: SysPair[] = links.map((l) => ({ source: l.source, target: l.target }));
    const top = sysGroup === "layers" ? layeredLayout(cards, pairs) : layout(cards, pairs);
    return { nodes: [...top, ...partNodes] as ViewNode[], edges };
  }, [
    rendered,
    visible,
    selectedId,
    selectedEdge,
    nameOf,
    search,
    cycleEdges,
    sysGroup,
    lensSystems,
    lensNeighborSystems,
    lensCtx,
    expandedSystems,
    collapseSystem,
  ]);

  /** Snapshot the visible systems into a hand-editable diagram. */
  const materialize = useCallback(async () => {
    if (!rendered) return;
    const created = await client.request("arch.create", { name: "Systems overview" });
    const idMap = new Map<string, ArchNode>();
    const archNodes: ArchNode[] = [];
    // Layer-band children carry band-relative positions — flatten to absolute.
    const bandPos = new Map<string, { x: number; y: number }>();
    for (const n of nodes) if (n.type === "layerBand") bandPos.set(n.id, n.position);
    for (const n of nodes) {
      if (n.type !== "system" && n.type !== "systemGroup") continue;
      const data = n.data as SystemNodeData | SystemGroupData;
      const s = data.system;
      if (data.mark === "removed") continue;
      const band = n.parentId ? bandPos.get(n.parentId) : undefined;
      const position = band
        ? { x: band.x + n.position.x, y: band.y + n.position.y }
        : { ...n.position };
      const node = createArchNode(ARCH_KIND_OF_ROLE[s.role], s.name, position);
      archNodes.push({
        ...node,
        description: `${s.fileCount} files · ${ROLE_META[s.role].label.toLowerCase()}`,
        size: { width: CARD_W, height: (n.style?.height as number) ?? 120 },
      });
      idMap.set(s.id, archNodes[archNodes.length - 1]!);
    }
    const archEdges: ArchEdge[] = [];
    // Split part-level edges fold back into one system-level dependency.
    const seenPairs = new Set<string>();
    for (const e of edges) {
      const linkKey = (e.data as { linkKey?: string } | undefined)?.linkKey;
      if (!linkKey || seenPairs.has(linkKey)) continue;
      const [src, tgt] = linkKey.split("->") as [string, string];
      const source = idMap.get(src);
      const target = idMap.get(tgt);
      if (!source || !target) continue;
      seenPairs.add(linkKey);
      archEdges.push({
        id: uid("edge"),
        source: source.id,
        target: target.id,
        kind: "dependency",
        label: e.id === linkKey && typeof e.label === "string" ? e.label : "",
      });
    }
    await client.request("arch.save", {
      path: created.path,
      graph: { ...created.graph, nodes: archNodes, edges: archEdges },
    });
    nav({ architect: { view: "diagrams", diagram: created.path } });
  }, [rendered, nodes, edges, client, nav]);

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu || !rendered) return [];
    if (menu.kind === "node") {
      const sys = rendered.overview.systems.find((s) => s.id === menu.id);
      if (!sys) return [];
      const pkg = sys.parts[0]?.pkg;
      const entries: MenuEntry[] = [
        {
          type: "item",
          label: "Open details",
          icon: Boxes,
          onSelect: () => nav({ architect: { edge: null, system: sys.id } }),
        },
      ];
      if (sys.parts.length > 1)
        entries.push({
          type: "item",
          label: expandedSystems.has(sys.id) ? "Collapse components" : "Expand components",
          icon: expandedSystems.has(sys.id) ? Shrink : Expand,
          onSelect: () => toggleExpanded(sys.id),
        });
      if (pkg)
        entries.push({
          type: "item",
          label: "Show in code map",
          icon: FolderGit2,
          disabled: !activeWs,
          onSelect: () => openSystemInCodemap(sys),
        });
      if (onOpenCode && pkg)
        entries.push({
          type: "item",
          label: "Open in code",
          icon: ExternalLink,
          onSelect: () => onOpenCode(pkg),
        });
      entries.push(
        { type: "separator" },
        {
          type: "item",
          label: `Hide ${ROLE_META[sys.role].label.toLowerCase()} systems`,
          icon: ROLE_META[sys.role].icon,
          onSelect: () => toggleRole(sys.role),
        },
        {
          type: "item",
          label: "Copy system id",
          icon: Copy,
          hint: sys.id,
          onSelect: () => void navigator.clipboard.writeText(sys.id),
        },
      );
      return entries;
    }
    if (menu.kind === "part") {
      const entries: MenuEntry[] = [
        {
          type: "item",
          label: "Show in code map",
          icon: FolderGit2,
          disabled: !activeWs,
          onSelect: () => openCodemapModule(menu.pkg),
        },
      ];
      if (onOpenCode)
        entries.push({
          type: "item",
          label: "Open in code",
          icon: ExternalLink,
          onSelect: () => onOpenCode(menu.pkg),
        });
      entries.push(
        {
          type: "item",
          label: "Copy path",
          icon: Copy,
          hint: menu.path,
          onSelect: () => void navigator.clipboard.writeText(menu.path),
        },
        { type: "separator" },
        {
          type: "item",
          label: "Collapse system",
          icon: Shrink,
          onSelect: () => collapseSystem(menu.sys),
        },
      );
      return entries;
    }
    if (menu.kind === "edge") {
      const link = rendered.overview.links.find((l) => `${l.source}->${l.target}` === menu.id);
      if (!link) return [];
      return [
        {
          type: "item",
          label: "Open edge details",
          icon: ArrowUpRight,
          onSelect: () => nav({ architect: { system: null, edge: menu.id } }),
        },
        {
          type: "item",
          label: "Copy symbols",
          icon: Copy,
          disabled: link.symbols.length === 0,
          onSelect: () => void navigator.clipboard.writeText(link.symbols.join(", ")),
        },
      ];
    }
    return [
      {
        type: "item",
        label: "Group by module",
        checked: sysGroup === "modules",
        onSelect: () => setSysGroup("modules"),
      },
      {
        type: "item",
        label: "Group by layer",
        checked: sysGroup === "layers",
        onSelect: () => setSysGroup("layers"),
      },
      { type: "separator" },
      {
        type: "submenu",
        label: "Roles",
        icon: Layers,
        entries: (Object.keys(ROLE_META) as SystemRole[]).map((role) => ({
          type: "item",
          label: ROLE_META[role].label,
          checked: !hiddenRoles.has(role),
          onSelect: () => toggleRole(role),
        })),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Contracts…",
        icon: ArrowRightLeft,
        onSelect: () => {
          nav({ architect: { contracts: true, insights: null, facets: null } });
          setDiffOpen(false);
        },
      },
      {
        type: "item",
        label: "Materialize as diagram",
        icon: PencilRuler,
        onSelect: () => void materialize(),
      },
      {
        type: "item",
        label: refDiff ? "Review changes…" : "Review vs ref…",
        icon: GitCompare,
        onSelect: () => {
          if (refDiff) setDiffOpen(true);
          else reviewBoxRef.current?.querySelector("input")?.focus();
        },
      },
      {
        type: "item",
        label: "Fit view",
        icon: Maximize,
        onSelect: () => void fitView({ padding: 0.2, duration: 300 }),
      },
    ];
  }, [
    menu,
    rendered,
    onOpenCode,
    openCodemapModule,
    openSystemInCodemap,
    activeWs,
    toggleRole,
    sysGroup,
    setSysGroup,
    hiddenRoles,
    materialize,
    refDiff,
    fitView,
    nav,
    expandedSystems,
    toggleExpanded,
    collapseSystem,
  ]);

  const selected = rendered?.overview.systems.find((s) => s.id === selectedId) ?? null;
  const selectedLink = selectedEdge
    ? (rendered?.overview.links.find((l) => `${l.source}->${l.target}` === selectedEdge) ?? null)
    : null;

  /** Visible boundaries, heaviest traffic first — the contract inspector's nav order. */
  const boundaryLinks = useMemo(() => {
    if (!rendered) return [];
    const traffic = (l: SystemLink) =>
      l.weight + (l.apis ?? []).reduce((n, a) => n + a.weight, 0);
    return rendered.overview.links
      .filter((l) => visible.has(l.source) && visible.has(l.target))
      .sort((a, b) => traffic(b) - traffic(a) || linkKeyOf(a).localeCompare(linkKeyOf(b)));
  }, [rendered, visible]);
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
        : contractsOpen
          ? "contracts"
          : facetsOpen
            ? "facets"
            : insightsOpen
              ? "insights"
              : null;

  return (
    <Split storageKey="architect:systems" direction="horizontal">
      <SplitPane minSize="45%">
        <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => {
            if (n.type === "systemPart") {
              const d = n.data as SystemPartData;
              nav({ architect: { edge: null, system: d.sysId === selectedId ? null : d.sysId } });
              return;
            }
            if (n.type !== "system" && n.type !== "systemGroup") return;
            nav({ architect: { edge: null, system: n.id === selectedId ? null : n.id } });
          }}
          onNodeDoubleClick={(_, n) => {
            if (n.type !== "system" && n.type !== "systemGroup") return;
            const sys = (n.data as SystemNodeData | SystemGroupData).system;
            if (sys.parts[0]?.pkg && activeWs) openSystemInCodemap(sys);
            else toggleExpanded(n.id);
          }}
          onEdgeClick={(_, e) => {
            const d = e.data as { linkKey?: string; sysId?: string } | undefined;
            if (d?.sysId) {
              // Internal wiring — open the owning system instead.
              nav({ architect: { edge: null, system: d.sysId } });
              return;
            }
            const key = d?.linkKey ?? e.id;
            nav({ architect: { system: null, edge: key === selectedEdge ? null : key } });
          }}
          onPaneClick={() => nav({ architect: { system: null, edge: null } })}
          onNodeContextMenu={(evt, n) => {
            evt.preventDefault();
            if (n.type === "systemPart") {
              const d = n.data as SystemPartData;
              setMenu({
                kind: "part",
                x: evt.clientX,
                y: evt.clientY,
                sys: d.sysId,
                path: d.part.path,
                pkg: d.part.pkg,
              });
              return;
            }
            if (n.type !== "system" && n.type !== "systemGroup") return;
            setMenu({ kind: "node", x: evt.clientX, y: evt.clientY, id: n.id });
          }}
          onEdgeContextMenu={(evt, e) => {
            evt.preventDefault();
            const d = e.data as { linkKey?: string } | undefined;
            if (!d?.linkKey) return;
            setMenu({ kind: "edge", x: evt.clientX, y: evt.clientY, id: d.linkKey });
          }}
          onPaneContextMenu={(evt) => {
            evt.preventDefault();
            setMenu({ kind: "pane", x: evt.clientX, y: evt.clientY });
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
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-edge bg-surface-1/95 p-0.5 shadow-sm">
            {(["modules", "layers"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={sysGroup === g}
                onClick={() => setSysGroup(g)}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] transition-colors",
                  sysGroup === g
                    ? "bg-surface-3 text-ink"
                    : "text-ink-faint hover:text-ink-muted",
                )}
              >
                {g === "modules" ? "By module" : "By layer"}
              </button>
            ))}
          </div>
          {lensTags.length > 0 && (
            <div className="flex w-fit items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 shadow-sm">
              <Sparkles className="h-3 w-3 shrink-0 text-crystal-300" />
              <span className="max-w-40 truncate text-[10px] font-medium text-ink">
                {lensName}
              </span>
              <span className="text-[9px] text-ink-faint">
                {lensSystems
                  ? `${lensSystems.size} systems${lensVis ? ` · ${lensVis.memberCount} members` : ""}`
                  : "reading index…"}
              </span>
              {lensNeighborSystems && lensNeighborSystems.size > 0 ? (
                <Tooltip content="Also light up first-degree neighbor systems — everything the lens touches">
                  <button
                    type="button"
                    aria-pressed={lensCtx}
                    onClick={() => nav({ architect: { lensCtx: !lensCtx } })}
                    className={cn(
                      "rounded px-1 py-0.5 text-[9px] transition-colors",
                      lensCtx
                        ? "bg-crystal-500/15 text-crystal-300"
                        : "text-ink-faint hover:text-ink-muted",
                    )}
                  >
                    +{lensNeighborSystems.size} connected
                  </button>
                </Tooltip>
              ) : null}
              <button
                type="button"
                onClick={() => nav({ architect: { lens: null, lensCtx: false } })}
                aria-label="Clear facet lens"
              >
                <X className="h-3 w-3 text-ink-faint hover:text-ink" />
              </button>
            </div>
          )}
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
            <div
              ref={reviewBoxRef}
              onFocusCapture={loadRefs}
              className="flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm"
            >
              <GitCompare className="ml-0.5 h-3 w-3 shrink-0 text-ink-faint" />
              <Combobox
                value={refInput}
                onChange={setRefInput}
                onSubmit={(v) => void reviewRef(v)}
                options={refOptions}
                placeholder="Review vs ref…"
                className="w-44"
                inputClassName="h-6 rounded-md border-0 bg-transparent px-1 text-[11px] focus:ring-0"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={refLoading}
                onClick={() => void reviewRef(refInput)}
              >
                {refLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Go"}
              </Button>
            </div>
          )}
          <button
            type="button"
            aria-pressed={contractsOpen}
            onClick={() => {
              nav({ architect: { contracts: !contractsOpen, insights: null, facets: null } });
              setDiffOpen(false);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1.5 text-[11px] shadow-sm transition-colors",
              contractsOpen ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <ArrowRightLeft className="h-3 w-3 text-ink-faint" />
            Contracts
          </button>
          <button
            type="button"
            aria-pressed={facetsOpen}
            onClick={() => {
              nav({ architect: { facets: !facetsOpen, insights: null, contracts: null } });
              setDiffOpen(false);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1.5 text-[11px] shadow-sm transition-colors",
              facetsOpen ? "text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            <Sparkles
              className={cn("h-3 w-3", lensTags.length > 0 ? "text-crystal-300" : "text-ink-faint")}
            />
            Facets
          </button>
          <button
            type="button"
            onClick={() => {
              nav({ architect: { insights: !insightsOpen, contracts: null, system: null, edge: null } });
              setDiffOpen(false);
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
        {menu && (
          <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />
        )}
      </div>

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
      {panel === "contracts" && (
        <ContractsPanel
          links={rendered.overview.links.filter(
            (l) => visible.has(l.source) && visible.has(l.target),
          )}
          nameOf={nameOf}
          onSelectEdge={(key) => nav({ architect: { system: null, edge: key } })}
          onClose={() => nav({ architect: { contracts: null } })}
        />
      )}
      {panel === "facets" && (
        <div className="flex w-72 shrink-0 flex-col border-l border-edge">
          <FacetsPanel
            index={codeIndex?.index ?? null}
            staleFiles={codeIndex?.staleFiles ?? EMPTY_STALE_FILES}
            activeTags={lensTags}
            onSelect={(s) => nav({ architect: { lens: s.tags.join(",") } })}
            onClear={() => nav({ architect: { lens: null } })}
            onClose={() => nav({ architect: { facets: null } })}
          />
        </div>
      )}
      {panel === "insights" && insights && (
        <InsightsPanel
          insights={insights}
          onSelect={(id) => setSelected(id)}
          onClose={() => nav({ architect: { insights: null } })}
        />
      )}
        </div>
      </SplitPane>

      {/* The contract inspector rides a real split — resizable, code inline. */}
      {panel === "edge" && selectedLink ? (
        <SplitPane defaultSize={440} minSize={320} maxSize={760}>
          <ContractInspector
            link={selectedLink}
            links={boundaryLinks}
            systems={rendered.overview.systems}
            nameOf={nameOf}
            onSelectEdge={(key) => nav({ architect: { system: null, edge: key } })}
            onSelectSystem={(id) => nav({ architect: { edge: null, system: id } })}
            onClose={() => setSelectedEdge(null)}
          />
        </SplitPane>
      ) : null}
    </Split>
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

function ContractsPanel({
  links,
  nameOf,
  onSelectEdge,
  onClose,
}: {
  links: SystemLink[];
  nameOf: (id: string) => string;
  onSelectEdge: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return links
      .filter((l) => {
        if (!q) return true;
        return (
          nameOf(l.source).toLowerCase().includes(q) ||
          nameOf(l.target).toLowerCase().includes(q) ||
          l.symbols.some((s) => s.toLowerCase().includes(q)) ||
          (l.apis ?? []).some((a) => a.path.toLowerCase().includes(q))
        );
      })
      .map((l) => ({
        link: l,
        key: `${l.source}->${l.target}`,
        traffic: l.weight + (l.apis ?? []).reduce((n, a) => n + a.weight, 0),
      }))
      .sort((a, b) => b.traffic - a.traffic || a.key.localeCompare(b.key));
  }, [links, nameOf, query]);
  return (
    <Pane
      title="Contracts"
      subtitle={`${links.length} boundar${links.length === 1 ? "y" : "ies"} between systems`}
      onClose={onClose}
    >
      <div className="border-b border-edge/60 px-3 py-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="System, symbol or route…"
            className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>
      {rows.length === 0 && (
        <div className="px-3 py-2 text-[10px] text-ink-faint">No boundary matches.</div>
      )}
      {rows.map(({ link, key }) => {
        const apis = link.apis ?? [];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelectEdge(key)}
            className="block w-full border-b border-edge/40 px-3 py-1.5 text-left hover:bg-surface-2"
          >
            <span className="flex items-center gap-1 text-[11px] text-ink">
              <span className="truncate">{nameOf(link.source)}</span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="truncate">{nameOf(link.target)}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {link.weight > 0 && (
                  <span className="rounded bg-surface-3 px-1 text-[9px] text-ink-muted">
                    ×{link.weight}
                  </span>
                )}
                {apis.length > 0 && (
                  <span className="rounded bg-accent-amber/15 px-1 text-[9px] text-accent-amber">
                    {apis.length} API
                  </span>
                )}
              </span>
            </span>
            {link.symbols.length > 0 ? (
              <span className="block truncate font-mono text-[9px] text-ink-faint">
                {link.symbols.slice(0, 3).join(", ")}
                {link.symbols.length > 3 ? ` +${link.symbols.length - 3}` : ""}
              </span>
            ) : apis.length > 0 ? (
              <span className="block truncate font-mono text-[9px] text-accent-amber">
                {apis
                  .slice(0, 2)
                  .map((a) => `${a.method} ${a.path}`)
                  .join(" · ")}
              </span>
            ) : null}
          </button>
        );
      })}
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

      {(system.partLinks?.length ?? 0) > 0 && (
        <Section title="Internal wiring">
          {system.partLinks!.map((pl) => (
            <div
              key={`${pl.source}->${pl.target}`}
              className="flex items-center gap-1 px-1.5 py-0.5"
            >
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={pl.source}
              >
                {pl.source.split("/").at(-1)}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
              <span
                className="min-w-0 truncate font-mono text-[10px] text-ink-muted"
                title={pl.target}
              >
                {pl.target.split("/").at(-1)}
              </span>
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{pl.weight}</span>
            </div>
          ))}
        </Section>
      )}

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
            className="w-full rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
            title={e.file}
          >
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[9px] uppercase text-ink-faint">{e.kind.slice(0, 2)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">{e.name}</span>
              <span className="shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
            </span>
            {e.signature && (
              <span
                className="block truncate pl-4 font-mono text-[9px] text-ink-faint"
                title={e.signature}
              >
                {e.signature}
              </span>
            )}
          </button>
        ))}
      </Section>

      {system.endpoints.length > 0 && (
        <Section title={`Serves · ${system.endpoints.length} route${system.endpoints.length === 1 ? "" : "s"}`}>
          {system.endpoints.map((ep) => (
            <button
              key={`${ep.method} ${ep.path}@${ep.file}`}
              type="button"
              onClick={() => requestOpenFile(ep.file)}
              title={ep.file}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2"
            >
              <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                {ep.method}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                {ep.path}
              </span>
            </button>
          ))}
        </Section>
      )}

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

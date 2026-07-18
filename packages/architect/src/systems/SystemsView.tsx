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
  useNodesState,
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
  Component,
  Copy,
  Expand,
  ExternalLink,
  Folder,
  FolderGit2,
  GitCompare,
  Group,
  Layers,
  ListFilter,
  Maximize,
  MoveRight,
  Package,
  PanelsTopLeft,
  PencilRuler,
  Plug,
  RefreshCw,
  Search,
  Shrink,
  Sparkles,
  Ungroup,
  Webhook,
  X,
} from "lucide-react";
import {
  SYSTEM_LAYERS,
  SYSTEM_LAYER_LABELS,
  autoGroupSystems,
  formatHighlightSel,
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
  type SystemInsights,
  type SystemLayer,
  type SystemLink,
  type SystemModule,
  type SystemPart,
  type SystemOverview,
  type SystemOverviewDiff,
  type SystemRole,
  type SystemsGroup,
  type SystemsLayout,
} from "@crystal/core";
import {
  RefCombobox,
  useCrystal,
  useNav,
  useNavUpdate,
  useSymbolMenu,
  useWorkspaces,
} from "@crystal/client";
import {
  Badge,
  Button,
  ContextMenu,
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

type DiffMark = "added" | "removed" | "modified";

interface SystemNodeData extends Record<string, unknown> {
  system: SystemModule;
  consumes: string[];
  selected: boolean;
  dimmed: boolean;
  /** Member of the focus filter — the endpoints whose traffic is animated. */
  focused: boolean;
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
  const { system, consumes, selected, dimmed, focused, exportsShown, mark } = data;
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  const packages = [...new Set(system.parts.map((p) => p.pkg))];
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-surface-1 shadow-sm transition-opacity",
        selected
          ? "border-ink/40 ring-2 ring-ink/20"
          : focused
            ? "border-crystal-500/70 ring-2 ring-crystal-500/25"
            : "border-edge",
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
            {mark === "modified" && (
              <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-[9px] text-warn">
                changed
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-ink-faint">
            {system.fileCount} files
            {system.componentCount > 0
              ? ` · ${system.componentCount} component${system.componentCount === 1 ? "" : "s"}`
              : ""}
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
              {e.kind === "component" && (
                <Component className="h-2.5 w-2.5 shrink-0 self-center text-accent-violet" />
              )}
              <span className="truncate font-mono text-[10px] text-ink-muted">{e.name}</span>
              <span className="ml-auto shrink-0 text-[9px] text-ink-faint">×{e.consumers}</span>
            </div>
          ))}
        </div>
      )}
      {(consumes.length > 0 || system.externals.length > 0 || system.libraries.length > 0) && (
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
            {system.libraries.length > 0 && (
              <span className="text-ink-faint">
                {consumes.length > 0 || system.externals.length > 0 ? " · " : ""}
                {system.libraries
                  .slice(0, 2)
                  .map((l) => l.pkg)
                  .join(", ")}
                {system.libraries.length > 2 ? ` +${system.libraries.length - 2}` : ""}
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
  /** Member of the focus filter — the endpoints whose traffic is animated. */
  focused: boolean;
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
  const { system, selected, dimmed, focused, mark, onCollapse } = data;
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        "h-full w-full rounded-lg border bg-surface-1/60 transition-opacity",
        selected
          ? "border-ink/40 ring-2 ring-ink/20"
          : focused
            ? "border-crystal-500/70 ring-2 ring-crystal-500/25"
            : "border-edge",
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
        {mark === "modified" && (
          <span className="shrink-0 rounded-full bg-warn/15 px-1.5 text-[9px] text-warn">changed</span>
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

/* ---- user grouping (movable, persisted clusters) ---- */

const CLUSTER_HEADER = 40;
const CLUSTER_PAD = 18;

interface SysClusterData extends Record<string, unknown> {
  group: SystemsGroup;
  /** Members currently on the canvas (filters can hide some). */
  memberCount: number;
  /** Inline-rename mode (entered from the context menu or a double-click). */
  renaming: boolean;
  onStartRename: (id: string) => void;
  /** Commit (trimmed name) or cancel (null) an inline rename. */
  onRename: (id: string, name: string | null) => void;
}
type SysClusterRfNode = RfNode<SysClusterData>;

/** A user group: a movable container the systems inside ride along with. */
function SysClusterNode({ data }: NodeProps<SysClusterRfNode>) {
  const { group, memberCount, renaming, onStartRename, onRename } = data;
  const [draft, setDraft] = useState(group.name);
  useEffect(() => {
    setDraft(group.name);
  }, [group.name, renaming]);
  return (
    <div className="h-full w-full rounded-2xl border border-edge bg-surface-2/50 shadow-sm">
      <div className="flex items-center gap-1.5 px-4 pt-2.5">
        <Group className="h-3 w-3 shrink-0 text-ink-faint" />
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onRename(group.id, draft.trim() || null)}
            onKeyDown={(e) => {
              // Enter/Escape are the rename's, not the canvas shortcuts'.
              e.stopPropagation();
              if (e.key === "Enter") onRename(group.id, draft.trim() || null);
              else if (e.key === "Escape") onRename(group.id, null);
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label="Group name"
            className="nodrag w-40 rounded border border-edge bg-surface-1 px-1 py-0.5 text-[10px] font-semibold text-ink outline-none focus:border-crystal-400"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              onStartRename(group.id);
            }}
            title="Double-click to rename"
            className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint"
          >
            {group.name}
          </span>
        )}
        <span className="text-[9px] text-ink-faint">{memberCount}</span>
      </div>
    </div>
  );
}

/** What the canvas renders: system cards/groups, their parts, layer bands, user clusters. */
type ViewNode = SysCardNode | SystemPartRfNode | LayerBandRfNode | SysClusterRfNode;

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
  sysCluster: SysClusterNode,
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

/**
 * Default (module) mode layout with user groups and manual positions. Each
 * group lays out its members with dagre and becomes a movable container;
 * groups + ungrouped cards then dagre at the top level (edges collapsed onto
 * the containers). Manual positions — absolute for top-level nodes, group-
 * relative for members — override the computed spot, so a hand arrangement
 * survives re-renders and data refreshes. Parents precede children in the
 * returned array (react-flow requires it).
 */
function groupedLayout(
  cards: SysCardNode[],
  pairs: readonly SysPair[],
  groups: readonly SystemsGroup[],
  positions: Readonly<Record<string, { x: number; y: number }>>,
  clusterExtras: Pick<SysClusterData, "onStartRename" | "onRename"> & {
    renamingId: string | null;
  },
): ViewNode[] {
  const memberOf = new Map<string, string>();
  for (const g of groups) for (const m of g.members) if (!memberOf.has(m)) memberOf.set(m, g.id);

  const byGroup = new Map<string, SysCardNode[]>();
  const loose: SysCardNode[] = [];
  for (const card of cards) {
    const gid = memberOf.get(card.id);
    if (gid) {
      const list = byGroup.get(gid);
      if (list) list.push(card);
      else byGroup.set(gid, [card]);
    } else loose.push(card);
  }

  // Inner layout per group: dagre over the members, manual (group-relative)
  // positions winning; the container sizes to the result.
  const shells: { group: SystemsGroup; width: number; height: number; children: SysCardNode[] }[] =
    [];
  for (const group of groups) {
    const members = byGroup.get(group.id);
    if (!members || members.length === 0) continue;
    const ids = new Set(members.map((n) => n.id));
    const laid = layout(
      members,
      pairs.filter((e) => ids.has(e.source) && ids.has(e.target)),
    );
    let minX = Infinity;
    let minY = Infinity;
    for (const n of laid) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
    }
    const children = laid.map((n) => ({
      ...n,
      parentId: group.id,
      position:
        positions[n.id] ??
        { x: n.position.x - minX + CLUSTER_PAD, y: n.position.y - minY + CLUSTER_HEADER },
    }));
    let maxX = 0;
    let maxY = 0;
    for (const n of children) {
      maxX = Math.max(maxX, n.position.x + ((n.style?.width as number) ?? CARD_W));
      maxY = Math.max(maxY, n.position.y + ((n.style?.height as number) ?? 120));
    }
    shells.push({
      group,
      width: Math.max(maxX + CLUSTER_PAD, CARD_W + CLUSTER_PAD * 2),
      height: maxY + CLUSTER_PAD,
      children,
    });
  }

  // Top level: groups as super-nodes, ungrouped cards as themselves.
  const superOf = (id: string): string => {
    const gid = memberOf.get(id);
    return gid && shells.some((s) => s.group.id === gid) ? gid : id;
  };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 44, ranksep: 110, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const shell of shells) g.setNode(shell.group.id, { width: shell.width, height: shell.height });
  for (const n of loose) {
    g.setNode(n.id, {
      width: (n.style?.width as number) ?? CARD_W,
      height: (n.style?.height as number) ?? 120,
    });
  }
  const topIds = new Set([...shells.map((s) => s.group.id), ...loose.map((n) => n.id)]);
  const seenPairs = new Set<string>();
  for (const e of pairs) {
    const source = superOf(e.source);
    const target = superOf(e.target);
    if (source === target || !topIds.has(source) || !topIds.has(target)) continue;
    const key = `${source}->${target}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    g.setEdge(source, target);
  }
  dagre.layout(g);
  const topPos = (id: string, width: number, height: number): { x: number; y: number } => {
    const manual = positions[id];
    if (manual) return { ...manual };
    const pos = g.node(id);
    return { x: pos.x - width / 2, y: pos.y - height / 2 };
  };

  const out: ViewNode[] = [];
  for (const shell of shells) {
    out.push({
      id: shell.group.id,
      type: "sysCluster",
      position: topPos(shell.group.id, shell.width, shell.height),
      data: {
        group: shell.group,
        memberCount: shell.children.length,
        renaming: clusterExtras.renamingId === shell.group.id,
        onStartRename: clusterExtras.onStartRename,
        onRename: clusterExtras.onRename,
      },
      style: { width: shell.width, height: shell.height },
      selectable: false,
      focusable: false,
      zIndex: -1,
    });
    out.push(...shell.children);
  }
  for (const n of loose) {
    out.push({
      ...n,
      position: topPos(n.id, (n.style?.width as number) ?? CARD_W, (n.style?.height as number) ?? 120),
    });
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

/**
 * The slice of code a systems-view jump carries into the diagram canvas —
 * materialized there as a facet so the code view highlights exactly the files
 * the user was looking at (and the facet id deep-links in the URL).
 */
export interface OpenCodeFacet {
  /** Facet name — the system (or component) being looked at. */
  name: string;
  /** Code-map module paths; diagram nodes match on `codeModule`. */
  modules: string[];
  /** Workspace-relative dirs; file-linked nodes match by prefix. */
  paths: string[];
}

export interface SystemsViewProps {
  /** "Show this system's code" — drills into the code map / diagram canvas. */
  onOpenCode?: (module: string, facet?: OpenCodeFacet) => void;
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
  | { kind: "group"; x: number; y: number; id: string }
  | { kind: "pane"; x: number; y: number };

const EMPTY_STALE_FILES: string[] = [];
const EMPTY_POSITIONS: Readonly<Record<string, { x: number; y: number }>> = {};

function SystemsInner({ onOpenCode }: SystemsViewProps) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const nav = useNavUpdate();
  const { fitView } = useReactFlow();
  const sidePane = useSidePaneLayout();
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
  // Global find (the Architecture header's box) — dims systems that miss.
  const search = useNav((l) => l.architect?.find) ?? "";
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
  // Focus filter — the canvas trimmed to one or two systems plus their
  // first-degree neighbors, with the traffic between the focused systems
  // animated. Nav-held (deep-linkable) like every other selection.
  const focusParam = useNav((l) => l.architect?.focus ?? null);
  const focusSolo = useNav((l) => l.architect?.focusSolo) ?? false;
  const focusSystems = useMemo<ReadonlySet<string>>(
    () => new Set(focusParam ? focusParam.split(",") : []),
    [focusParam],
  );
  const setFocusSystems = useCallback(
    (next: ReadonlySet<string>) =>
      nav({
        architect: {
          focus: next.size > 0 ? [...next].join(",") : null,
          ...(next.size > 0 ? {} : { focusSolo: null }),
        },
      }),
    [nav],
  );
  const toggleFocus = useCallback(
    (id: string) => {
      const next = new Set(focusSystems);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setFocusSystems(next);
    },
    [focusSystems, setFocusSystems],
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
  const reviewBoxRef = useRef<HTMLDivElement | null>(null);

  /* ---- hand arrangement: manual positions + user groups ---- */

  // Saved layout (`.crystal/systems-layout.json`); null = never touched, so
  // the overview auto-groups itself (by layer) until the user edits.
  const [savedLayout, setSavedLayout] = useState<SystemsLayout | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    client
      .request("syslayout.get", {})
      .then((res) => {
        if (!cancelled) setSavedLayout(res.layout);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, activeWs]);

  /** Apply + debounce-save a layout edit. `ws` is captured at schedule time —
   *  the flush can land after the user switches workspaces. */
  const persistLayout = useCallback(
    (next: SystemsLayout) => {
      setSavedLayout(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const ws = activeWs ?? undefined;
      saveTimer.current = setTimeout(() => {
        client.request("syslayout.save", { ws, layout: next }).catch(() => {});
      }, 600);
    },
    [client, activeWs],
  );

  // Groups on the canvas: the saved arrangement, or (untouched) the automatic
  // layer grouping the overview suggests — which the first edit materializes.
  const effectiveGroups = useMemo<SystemsGroup[]>(() => {
    if (savedLayout) return savedLayout.groups;
    return overview ? autoGroupSystems(overview) : [];
  }, [savedLayout, overview]);
  const manualPositions = savedLayout?.positions ?? EMPTY_POSITIONS;

  /** The layout an edit starts from — the first edit adopts the auto groups. */
  const layoutForEdit = useCallback(
    (): SystemsLayout =>
      savedLayout ?? {
        positions: {},
        groups: effectiveGroups.map((g) => ({ ...g, members: [...g.members] })),
      },
    [savedLayout, effectiveGroups],
  );

  const renameGroup = useCallback(
    (id: string, name: string | null) => {
      setRenamingGroup(null);
      if (!name) return;
      const base = layoutForEdit();
      persistLayout({
        ...base,
        groups: base.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      });
    },
    [layoutForEdit, persistLayout],
  );

  const dissolveGroup = useCallback(
    (id: string) => {
      const base = layoutForEdit();
      const group = base.groups.find((g) => g.id === id);
      // Member positions were group-relative — they'd land near the origin.
      const positions = { ...base.positions };
      delete positions[id];
      for (const m of group?.members ?? []) delete positions[m];
      persistLayout({ positions, groups: base.groups.filter((g) => g.id !== id) });
    },
    [layoutForEdit, persistLayout],
  );

  /** Move a system into a group (null = out of any group). */
  const moveToGroup = useCallback(
    (sysId: string, groupId: string | null) => {
      const base = layoutForEdit();
      const positions = { ...base.positions };
      delete positions[sysId]; // stale relative/absolute position either way
      let groups = base.groups.map((g) => ({
        ...g,
        members: g.members.filter((m) => m !== sysId),
      }));
      if (groupId)
        groups = groups.map((g) =>
          g.id === groupId ? { ...g, members: [...g.members, sysId] } : g,
        );
      persistLayout({ positions, groups });
    },
    [layoutForEdit, persistLayout],
  );

  const newGroupWith = useCallback(
    (sysId: string) => {
      const base = layoutForEdit();
      const positions = { ...base.positions };
      delete positions[sysId];
      const group: SystemsGroup = { id: uid("grp"), name: "New group", members: [sysId] };
      persistLayout({
        positions,
        groups: [
          ...base.groups.map((g) => ({ ...g, members: g.members.filter((m) => m !== sysId) })),
          group,
        ],
      });
      setRenamingGroup(group.id);
    },
    [layoutForEdit, persistLayout],
  );

  const autoGroupNow = useCallback(() => {
    if (!overview) return;
    // Re-derived groups invalidate every stored position (members go relative).
    persistLayout({ positions: {}, groups: autoGroupSystems(overview) });
  }, [overview, persistLayout]);

  const clearGroups = useCallback(() => {
    persistLayout({ positions: {}, groups: [] });
  }, [persistLayout]);

  const resetPositions = useCallback(() => {
    const base = layoutForEdit();
    persistLayout({ positions: {}, groups: base.groups });
  }, [layoutForEdit, persistLayout]);

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
    setSavedLayout(null);
    setRenamingGroup(null);
    setGeneration((g) => g + 1);
  }, [activeWs]);

  // Esc walks back: edge → system → focus filter → review mode. (An open
  // context menu consumes Escape itself.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menu) return;
      if (selectedEdge) setSelectedEdge(null);
      else if (selectedId) setSelected(null);
      else if (focusSystems.size > 0) setFocusSystems(new Set());
      else if (refDiff) setRefDiff(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedEdge, selectedId, focusSystems, setFocusSystems, refDiff, menu, setSelected]);

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
        ? {
            overview,
            marks: new Map<string, DiffMark>(),
            edgeMarks: new Map<string, DiffMark>(),
            reweights: new Map<string, { before: number; after: number }>(),
          }
        : null;
    }
    const marks = new Map<string, DiffMark>();
    const edgeMarks = new Map<string, DiffMark>();
    for (const s of refDiff.diff.addedSystems) marks.set(s.id, "added");
    const removedSystems = refDiff.base.systems.filter((s) =>
      refDiff.diff.removedSystems.some((r) => r.id === s.id),
    );
    for (const s of removedSystems) marks.set(s.id, "removed");
    for (const s of refDiff.diff.resized) if (!marks.has(s.id)) marks.set(s.id, "modified");
    // Externals shifts are modifications too — but never demote a whole-system
    // add/remove (an added system's externals are all "new" by definition).
    for (const x of [...refDiff.diff.addedExternals, ...refDiff.diff.removedExternals]) {
      if (!marks.has(x.system)) marks.set(x.system, "modified");
    }
    for (const l of refDiff.diff.addedLinks) edgeMarks.set(`${l.source}->${l.target}`, "added");
    const reweights = new Map<string, { before: number; after: number }>();
    for (const l of refDiff.diff.reweighted) {
      edgeMarks.set(`${l.source}->${l.target}`, "modified");
      reweights.set(`${l.source}->${l.target}`, { before: l.before, after: l.after });
    }
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
      reweights,
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

  // Everything the facet lens keeps on the canvas — the same mechanism as the
  // code map: the canvas compacts to the lens members, plus (with the chip's
  // "+N connected" toggle) their first-degree neighbors rendered dimmed.
  // Null = no lens filter.
  const lensVisible = useMemo(() => {
    if (!lensSystems) return null;
    const keep = new Set(lensSystems);
    if (lensCtx) for (const id of lensNeighborSystems ?? []) keep.add(id);
    return keep;
  }, [lensSystems, lensCtx, lensNeighborSystems]);

  // First-degree neighbors of the focused systems — shown by default so the
  // filter answers "what do these touch", hidden via the chip's toggle.
  const focusNeighbors = useMemo(() => {
    if (focusSystems.size === 0 || !rendered) return null;
    const neighbors = new Set<string>();
    for (const l of rendered.overview.links) {
      const sourceIn = focusSystems.has(l.source);
      const targetIn = focusSystems.has(l.target);
      if (sourceIn && !targetIn) neighbors.add(l.target);
      else if (targetIn && !sourceIn) neighbors.add(l.source);
    }
    return neighbors;
  }, [focusSystems, rendered]);

  // Everything the focus filter keeps on the canvas; null = no filter.
  const focusVisible = useMemo(() => {
    if (focusSystems.size === 0) return null;
    const keep = new Set(focusSystems);
    if (!focusSolo) for (const id of focusNeighbors ?? []) keep.add(id);
    return keep;
  }, [focusSystems, focusSolo, focusNeighbors]);

  // Refit the viewport when the focus filter or the facet lens reshapes the
  // canvas — the laid out graph can shrink to a corner of the old extents.
  useEffect(() => {
    const t = setTimeout(() => void fitView({ padding: 0.2, duration: 300 }), 80);
    return () => clearTimeout(t);
  }, [focusParam, focusSolo, lensParam, lensCtx, fitView]);

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
    const { overview: data, marks, edgeMarks, reweights } = rendered;
    const query = search.trim().toLowerCase();
    // The focus filter and the facet lens both *remove* everything outside
    // their slice (lens: members + optional neighbor ring) — dagre then lays
    // out just what's left, the same compaction the code map's lens does.
    const links = data.links.filter(
      (l) =>
        visible.has(l.source) &&
        visible.has(l.target) &&
        (!focusVisible || (focusVisible.has(l.source) && focusVisible.has(l.target))) &&
        (!lensVisible || (lensVisible.has(l.source) && lensVisible.has(l.target))),
    );
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
    // Search covers the whole card, not just the title: exported symbols,
    // component paths/packages, external services, consumed systems — and the
    // system's boundary traffic (crossing symbols, served API routes), so a
    // route or interface name lights up both ends of the contract.
    const boundaryText = new Map<string, string[]>();
    if (query.length > 0) {
      for (const l of data.links) {
        const texts = [
          ...l.symbols,
          ...(l.apis ?? []).map((a) => `${a.method} ${a.path}`.toLowerCase()),
        ].map((t) => t.toLowerCase());
        if (texts.length === 0) continue;
        for (const id of [l.source, l.target]) {
          const list = boundaryText.get(id) ?? [];
          list.push(...texts);
          boundaryText.set(id, list);
        }
      }
    }
    const matchesSearch = (s: SystemModule): boolean =>
      s.name.toLowerCase().includes(query) ||
      s.parts.some(
        (p) => p.path.toLowerCase().includes(query) || p.pkg.toLowerCase().includes(query),
      ) ||
      s.exports.some(
        (e) => e.name.toLowerCase().includes(query) || e.file.toLowerCase().includes(query),
      ) ||
      s.externals.some((x) => x.name.toLowerCase().includes(query)) ||
      s.libraries.some((l) => l.pkg.toLowerCase().includes(query)) ||
      s.components.some((c) => c.name.toLowerCase().includes(query)) ||
      (consumesOf.get(s.id) ?? []).some((n) => n.toLowerCase().includes(query)) ||
      (boundaryText.get(s.id) ?? []).some((t) => t.includes(query));
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
      if (focusVisible && !focusVisible.has(s.id)) continue;
      if (lensVisible && !lensVisible.has(s.id)) continue;
      const focused = focusSystems.has(s.id);
      const searchMiss = query.length > 0 && !matchesSearch(s);
      // Lens neighbors survive the filter as dimmed context (the "+N
      // connected" ring); members render at full strength.
      const lensNeighbor = lensSystems != null && !lensSystems.has(s.id);
      const dimmed =
        searchMiss ||
        lensNeighbor ||
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
            focused,
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
          focused,
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
      // Information flow the focus filter is asking about: traffic between
      // focused systems — or, with a single system focused, all its traffic.
      const flow =
        focusSystems.size > 0 &&
        ((focusSystems.has(l.source) && focusSystems.has(l.target)) ||
          (focusSystems.size === 1 &&
            (focusSystems.has(l.source) || focusSystems.has(l.target))));
      const markColor =
        mark === "added"
          ? "var(--color-ok)"
          : mark === "removed"
            ? "var(--color-danger)"
            : mark === "modified"
              ? "var(--color-warn)"
              : null;
      const stroke =
        markColor ??
        (flow
          ? "var(--color-accent-cyan)"
          : inCycle
            ? "var(--color-accent-rose)"
            : active
              ? "var(--color-accent-violet)"
              : apiOnly
                ? "var(--color-accent-amber)"
                : "var(--color-edge-strong)");
      const shared = {
        data: { linkKey: key },
        // Flow edges march (xyflow's animated dash) toward the consumer, with
        // a matching arrowhead — the "moving arrows" of the focus filter.
        animated: flow,
        labelStyle: {
          fontSize: 9,
          fill:
            markColor ??
            (flow
              ? "var(--color-accent-cyan)"
              : apiOnly
                ? "var(--color-accent-amber)"
                : "var(--color-ink-faint)"),
        },
        labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: flow ? 16 : 14,
          height: flow ? 16 : 14,
          color: flow ? "var(--color-accent-cyan)" : undefined,
        },
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
              strokeWidth: Math.max(flow ? 2 : 0, 1 + 2 * Math.sqrt(sp.weight / maxWeight)),
              strokeDasharray: mark === "removed" ? "5 4" : undefined,
              opacity: faded ? 0.1 : 1,
            },
          });
        });
        continue;
      }
      const topSymbol = l.symbols[0];
      // A reweighted edge labels the shift itself — the "what changed" is
      // readable on the canvas, not just in the review panel.
      const reweight = mark === "modified" ? reweights.get(key) : undefined;
      const label = apiOnly
        ? `${apis[0]!.method} ${apis[0]!.path}${apis.length > 1 ? ` +${apis.length - 1}` : ""}`
        : reweight
          ? `${topSymbol ? `${trunc(topSymbol, 14)} ` : ""}×${reweight.before}→×${reweight.after}`
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
          strokeWidth: Math.max(flow ? 2 : 0, 1 + 2 * Math.sqrt(l.weight / maxWeight)),
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
    const top =
      sysGroup === "layers"
        ? layeredLayout(cards, pairs)
        : groupedLayout(cards, pairs, effectiveGroups, manualPositions, {
            renamingId: renamingGroup,
            onStartRename: setRenamingGroup,
            onRename: renameGroup,
          });
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
    lensVisible,
    focusSystems,
    focusVisible,
    expandedSystems,
    collapseSystem,
    effectiveGroups,
    manualPositions,
    renamingGroup,
    renameGroup,
  ]);

  // Dragging needs live node state; the computed scene re-syncs it whenever
  // the data (or the persisted arrangement) changes.
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<ViewNode>(nodes);
  useEffect(() => {
    setRfNodes(nodes);
  }, [nodes, setRfNodes]);

  /**
   * Drop handling: group containers persist their new spot; a system card
   * dropped inside a group joins it (position stored group-relative), dropped
   * on open canvas it leaves any group (position stored absolute). The first
   * drag materializes the automatic grouping into the saved layout.
   */
  const onNodeDragStop = useCallback(
    (_evt: unknown, node: RfNode) => {
      if (sysGroup === "layers") return;
      const base = layoutForEdit();
      const positions = { ...base.positions };
      if (node.type === "sysCluster") {
        positions[node.id] = { x: node.position.x, y: node.position.y };
        persistLayout({ ...base, positions });
        return;
      }
      if (node.type !== "system" && node.type !== "systemGroup") return;
      const parent = node.parentId ? rfNodes.find((n) => n.id === node.parentId) : undefined;
      const abs = parent
        ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y }
        : { ...node.position };
      const w = node.measured?.width ?? (node.style?.width as number) ?? CARD_W;
      const h = node.measured?.height ?? (node.style?.height as number) ?? 120;
      const center = { x: abs.x + w / 2, y: abs.y + h / 2 };
      // Group containers are top-level — hit-test their rects at the center.
      let drop: SysClusterRfNode | null = null;
      for (const n of rfNodes) {
        if (n.type !== "sysCluster") continue;
        const gw = (n.style?.width as number) ?? 0;
        const gh = (n.style?.height as number) ?? 0;
        if (
          center.x >= n.position.x &&
          center.x <= n.position.x + gw &&
          center.y >= n.position.y &&
          center.y <= n.position.y + gh
        ) {
          drop = n as SysClusterRfNode;
          break;
        }
      }
      let groups = base.groups;
      const currentGroup = groups.find((g) => g.members.includes(node.id))?.id ?? null;
      if ((drop?.id ?? null) !== currentGroup) {
        groups = groups.map((g) => ({
          ...g,
          members: g.members.filter((m) => m !== node.id),
        }));
        if (drop)
          groups = groups.map((g) =>
            g.id === drop!.id ? { ...g, members: [...g.members, node.id] } : g,
          );
      }
      positions[node.id] = drop
        ? {
            x: Math.max(CLUSTER_PAD, abs.x - drop.position.x),
            y: Math.max(CLUSTER_HEADER, abs.y - drop.position.y),
          }
        : abs;
      persistLayout({ ...base, positions, groups });
    },
    [sysGroup, rfNodes, layoutForEdit, persistLayout],
  );

  /** Snapshot the visible systems into a hand-editable diagram. */
  const materialize = useCallback(async () => {
    if (!rendered) return;
    const created = await client.request("arch.create", { name: "Systems overview" });
    const idMap = new Map<string, ArchNode>();
    const archNodes: ArchNode[] = [];
    // Band/group children carry parent-relative positions — flatten to absolute.
    const bandPos = new Map<string, { x: number; y: number }>();
    for (const n of nodes)
      if (n.type === "layerBand" || n.type === "sysCluster") bandPos.set(n.id, n.position);
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
        focusSystems.has(sys.id)
          ? {
              type: "item",
              label: "Remove from filter",
              icon: ListFilter,
              onSelect: () => toggleFocus(sys.id),
            }
          : focusSystems.size > 0
            ? {
                type: "item",
                label: "Add to filter",
                icon: ListFilter,
                hint: "⌘/ctrl-click",
                onSelect: () => toggleFocus(sys.id),
              }
            : {
                type: "item",
                label: "Filter — show with neighbors",
                icon: ListFilter,
                hint: "⌘/ctrl-click",
                onSelect: () => setFocusSystems(new Set([sys.id])),
              },
      ];
      if (sys.parts.length > 1)
        entries.push({
          type: "item",
          label: expandedSystems.has(sys.id) ? "Collapse components" : "Expand components",
          icon: expandedSystems.has(sys.id) ? Shrink : Expand,
          onSelect: () => toggleExpanded(sys.id),
        });
      if (sysGroup === "modules") {
        const inGroup = effectiveGroups.find((g) => g.members.includes(sys.id)) ?? null;
        entries.push({
          type: "submenu",
          label: "Group",
          icon: Group,
          entries: [
            ...effectiveGroups.map((g): MenuEntry => ({
              type: "item",
              label: g.name,
              checked: g.id === inGroup?.id,
              onSelect: () => moveToGroup(sys.id, g.id),
            })),
            ...(effectiveGroups.length > 0 ? [{ type: "separator" } as MenuEntry] : []),
            { type: "item", label: "New group…", onSelect: () => newGroupWith(sys.id) },
            ...(inGroup
              ? [
                  {
                    type: "item",
                    label: "Remove from group",
                    onSelect: () => moveToGroup(sys.id, null),
                  } as MenuEntry,
                ]
              : []),
          ],
        });
      }
      if (sys.endpoints.length > 0)
        entries.push({
          type: "item",
          label: "Explore APIs",
          icon: Webhook,
          hint: `${sys.endpoints.length}`,
          onSelect: () =>
            nav({ mode: "surfaces", surfaces: { view: "apis", system: sys.id, api: null } }),
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
          onSelect: () =>
            onOpenCode(pkg, {
              name: sys.name,
              modules: [...new Set(sys.parts.map((p) => p.pkg))],
              paths: sys.parts.map((p) => p.path),
            }),
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
      if (onOpenCode) {
        const sysName = rendered.overview.systems.find((s) => s.id === menu.sys)?.name;
        const partName = menu.path.split("/").at(-1) ?? menu.path;
        entries.push({
          type: "item",
          label: "Open in code",
          icon: ExternalLink,
          onSelect: () =>
            onOpenCode(menu.pkg, {
              name: sysName ? `${sysName} · ${partName}` : partName,
              modules: [menu.pkg],
              paths: [menu.path],
            }),
        });
      }
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
    if (menu.kind === "group") {
      const group = effectiveGroups.find((g) => g.id === menu.id);
      if (!group) return [];
      return [
        {
          type: "item",
          label: "Rename group",
          icon: Group,
          hint: "double-click",
          onSelect: () => setRenamingGroup(group.id),
        },
        {
          type: "item",
          label: "Ungroup",
          icon: Ungroup,
          onSelect: () => dissolveGroup(group.id),
        },
      ];
    }
    if (menu.kind === "edge") {
      const link = rendered.overview.links.find((l) => `${l.source}->${l.target}` === menu.id);
      if (!link) return [];
      const firstApi = link.apis?.[0];
      return [
        {
          type: "item",
          label: "Open edge details",
          icon: ArrowUpRight,
          onSelect: () => nav({ architect: { system: null, edge: menu.id } }),
        },
        ...(firstApi
          ? [
              {
                type: "item",
                label: "Open in API explorer",
                icon: Webhook,
                hint: `${link.apis!.length} route${link.apis!.length === 1 ? "" : "s"}`,
                onSelect: () =>
                  nav({
                    mode: "surfaces",
                    surfaces: {
                      view: "apis",
                      system: link.target,
                      api: `${firstApi.method} ${firstApi.path}`,
                    },
                    architect: { edge: null },
                  }),
              } as MenuEntry,
            ]
          : []),
        {
          type: "item",
          label: "Filter both systems",
          icon: ListFilter,
          onSelect: () => setFocusSystems(new Set([link.source, link.target])),
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
    const paneEntries: MenuEntry[] = [];
    if (focusSystems.size > 0)
      paneEntries.push(
        {
          type: "item",
          label: "Clear focus filter",
          icon: ListFilter,
          hint: "esc",
          onSelect: () => setFocusSystems(new Set()),
        },
        { type: "separator" },
      );
    return [
      ...paneEntries,
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
      ...(sysGroup === "modules"
        ? ([
            { type: "separator" },
            {
              type: "item",
              label: "Auto-group by layer",
              icon: Group,
              onSelect: autoGroupNow,
            },
            ...(effectiveGroups.length > 0
              ? [{ type: "item", label: "Clear groups", icon: Ungroup, onSelect: clearGroups }]
              : []),
            ...(Object.keys(manualPositions).length > 0
              ? [
                  {
                    type: "item",
                    label: "Reset positions",
                    icon: RefreshCw,
                    onSelect: resetPositions,
                  },
                ]
              : []),
          ] as MenuEntry[])
        : []),
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
    focusSystems,
    toggleFocus,
    setFocusSystems,
    effectiveGroups,
    manualPositions,
    moveToGroup,
    newGroupWith,
    dissolveGroup,
    autoGroupNow,
    clearGroups,
    resetPositions,
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

  // With a ref review open, clicking a marked (green/red/yellow) element keeps
  // the review panel up and highlights the specific change instead of swapping
  // to the generic system/edge detail.
  const diffHighlight =
    diffOpen && refDiff
      ? selectedEdge != null && rendered.edgeMarks.has(selectedEdge)
        ? selectedEdge
        : selectedId != null && rendered.marks.has(selectedId)
          ? selectedId
          : null
      : null;

  const panel: SidePanel = diffHighlight
    ? "diff"
    : selectedLink
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
      {/* @container: the overlay toolbars compact by pane width, not viewport —
          this view embeds in side panes (surfaces arch pane) at ~400-800px. */}
      <div className="@container relative min-w-0 flex-1">
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={(evt, n) => {
            const sysId =
              n.type === "systemPart"
                ? (n.data as SystemPartData).sysId
                : n.type === "system" || n.type === "systemGroup"
                  ? n.id
                  : null;
            if (!sysId) return;
            // Ctrl/⌘-click builds the focus filter instead of selecting.
            if (evt.ctrlKey || evt.metaKey) {
              toggleFocus(sysId);
              return;
            }
            nav({ architect: { edge: null, system: sysId === selectedId ? null : sysId } });
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
            if (n.type === "sysCluster") {
              setMenu({ kind: "group", x: evt.clientX, y: evt.clientY, id: n.id });
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
          nodesDraggable={sysGroup !== "layers"}
          nodesConnectable={false}
          fitView
          minZoom={0.1}
          panOnScroll
          zoomOnPinch
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-surface-1" />
        </ReactFlow>

        {/* The lens filtered everything out — same dead-end the code map shows. */}
        {lensVisible && !nodes.some((n) => n.type === "system" || n.type === "systemGroup") ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto">
              <EmptyState icon={Sparkles} title="Nothing matches this facet">
                No systems carry {lensName || "this facet"} — exit the lens or index more files.
              </EmptyState>
            </div>
          </div>
        ) : null}

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
            <span className="@max-[640px]:hidden mx-1 h-3 w-px bg-edge" />
            <span className="@max-[640px]:hidden px-1 text-[10px] text-ink-faint">
              {rendered.overview.systems.length} systems · {rendered.overview.links.length} links ·{" "}
              {rendered.overview.fileTotal} files
            </span>
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
          {focusSystems.size > 0 && (
            <div className="flex w-fit items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1 shadow-sm">
              <ListFilter className="h-3 w-3 shrink-0 text-accent-cyan" />
              <span className="max-w-52 truncate text-[10px] font-medium text-ink">
                {[...focusSystems].map(nameOf).join(" + ")}
              </span>
              {focusNeighbors && focusNeighbors.size > 0 ? (
                <Tooltip content="Also show first-degree neighbor systems — everything the focused systems touch">
                  <button
                    type="button"
                    aria-pressed={!focusSolo}
                    onClick={() => nav({ architect: { focusSolo: focusSolo ? null : true } })}
                    className={cn(
                      "rounded px-1 py-0.5 text-[9px] transition-colors",
                      !focusSolo
                        ? "bg-accent-cyan/15 text-accent-cyan"
                        : "text-ink-faint hover:text-ink-muted",
                    )}
                  >
                    +{focusNeighbors.size} connected
                  </button>
                </Tooltip>
              ) : null}
              <button
                type="button"
                onClick={() => setFocusSystems(new Set())}
                aria-label="Clear focus filter"
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
              className="@max-[900px]:hidden flex items-center gap-1 rounded-lg border border-edge bg-surface-1/95 px-1.5 py-1 shadow-sm"
            >
              <GitCompare className="ml-0.5 h-3 w-3 shrink-0 text-ink-faint" />
              <RefCombobox
                value={refInput}
                onChange={setRefInput}
                onSubmit={(v) => void reviewRef(v)}
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
          <Tooltip content="Boundary contracts">
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
              <span className="@max-[900px]:hidden">Contracts</span>
            </button>
          </Tooltip>
          <Tooltip content="Facet lenses">
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
              <span className="@max-[900px]:hidden">Facets</span>
            </button>
          </Tooltip>
          <Tooltip content="Architecture insights">
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
              <span className="@max-[900px]:hidden">Insights</span>
              {(insights?.total ?? 0) > 0 && (
                <span className="rounded-full bg-warn/15 px-1.5 text-[9px] text-warn">
                  {insights?.total}
                </span>
              )}
            </button>
          </Tooltip>
          <Tooltip content="Snapshot the visible systems into an editable diagram">
            <button
              type="button"
              onClick={() => void materialize()}
              className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-1/95 px-2 py-1.5 text-[11px] text-ink-muted shadow-sm transition-colors hover:text-ink"
            >
              <PencilRuler className="h-3 w-3" />
              <span className="@max-[900px]:hidden">To diagram</span>
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
          onSelectEdge={(key) => nav({ architect: { system: null, edge: key } })}
          onOpenCode={onOpenCode}
        />
      )}
      {panel === "diff" && refDiff && (
        <DiffPanel
          state={refDiff}
          highlight={diffHighlight}
          onSelect={setSelected}
          onSelectEdge={(key) => nav({ architect: { system: null, edge: key } })}
          onClose={() => setDiffOpen(false)}
        />
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
        <SplitPane defaultSize={sidePane.defaultSize} minSize={320} maxSize="70%">
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
  onSelectEdge,
  onOpenCode,
}: {
  system: SystemModule;
  links: SystemLink[];
  nameOf: (id: string) => string;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  /** Open the contract inspector on a boundary (`source->target`). */
  onSelectEdge: (key: string) => void;
  onOpenCode?: (module: string, facet?: OpenCodeFacet) => void;
}) {
  const meta = ROLE_META[system.role];
  const Icon = meta.icon;
  const outbound = links.filter((l) => l.source === system.id);
  const inbound = links.filter((l) => l.target === system.id);
  const apiOutbound = outbound.filter((l) => (l.apis?.length ?? 0) > 0);
  // Right-click on exports/components/endpoints: the shared symbol menu.
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const nav = useNavUpdate();
  // A highlight pinned from elsewhere (e.g. a surfaces component) marks its
  // row here — the surfaces→architecture side of the bidirectional link.
  const pinnedSel = useNav((l) => l.architect?.sel ?? null);
  const isPinned = (file: string, symbol: string) =>
    pinnedSel != null && pinnedSel === formatHighlightSel({ file, symbol });

  // Clicking a boundary row inspects the contract — the intersection of what
  // this system consumes and the other exports — in place; the explicit
  // arrow link is the only way the row leaves for the other system's detail.
  const linkRow = (link: SystemLink, other: string, dir: "out" | "in") => (
    <div
      key={`${dir}:${other}`}
      className="group flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-2"
    >
      <Tooltip content="Inspect the boundary contract">
        <button
          type="button"
          onClick={() => onSelectEdge(linkKeyOf(link))}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
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
      </Tooltip>
      <Tooltip content={`Go to ${nameOf(other)}`}>
        <button
          type="button"
          onClick={() => onSelect(other)}
          aria-label={`Go to ${nameOf(other)}`}
          className="mt-0.5 shrink-0 rounded text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <MoveRight className="h-3 w-3" />
        </button>
      </Tooltip>
    </div>
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
                  onClick={() =>
                    onOpenCode(p.pkg, {
                      name: `${system.name} · ${p.path.split("/").at(-1) ?? p.path}`,
                      modules: [p.pkg],
                      paths: [p.path],
                    })
                  }
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
            onContextMenu={(evt) =>
              menu.open(evt, [
                { type: "heading", label: e.name },
                ...symbolMenu({ file: e.file, symbol: e.name, label: e.name }),
              ])
            }
            className={cn(
              "w-full rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2",
              isPinned(e.file, e.name) && "bg-crystal-500/15 ring-1 ring-crystal-500/40",
            )}
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

      {system.componentCount > 0 && (
        <Section title={`Components · ${system.componentCount}`}>
          {system.components.map((c) => (
            <div
              key={`${c.file}#${c.name}`}
              onContextMenu={(evt) =>
                menu.open(evt, [
                  { type: "heading", label: c.name },
                  ...symbolMenu({ file: c.file, symbol: c.name, label: c.name }),
                ])
              }
              className={cn(
                "group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-2",
                isPinned(c.file, c.name) && "bg-crystal-500/15 ring-1 ring-crystal-500/40",
              )}
            >
              <button
                type="button"
                onClick={() => requestOpenFile(c.file)}
                title={c.file}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <Component className="h-3 w-3 shrink-0 text-accent-violet" />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {c.name}
                </span>
                {c.consumers > 0 && (
                  <Tooltip content={`${c.consumers} file${c.consumers === 1 ? "" : "s"} outside this system import it`}>
                    <span className="shrink-0 text-[9px] text-ink-faint">×{c.consumers}</span>
                  </Tooltip>
                )}
              </button>
              <Tooltip content="Open in the surfaces view — definition, usages and API calls">
                <button
                  type="button"
                  onClick={() =>
                    nav({
                      mode: "surfaces",
                      surfaces: { view: "components", component: `${c.file}#${c.name}` },
                    })
                  }
                  aria-label={`Open ${c.name} in the surfaces view`}
                  className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <PanelsTopLeft className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          ))}
          {system.componentCount > system.components.length && (
            <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
              +{system.componentCount - system.components.length} more — open the code map for
              the full inventory
            </div>
          )}
        </Section>
      )}

      {system.endpoints.length > 0 && (
        <Section title={`Serves · ${system.endpoints.length} route${system.endpoints.length === 1 ? "" : "s"}`}>
          {system.endpoints.map((ep) => (
            <div
              key={`${ep.method} ${ep.path}@${ep.file}`}
              onContextMenu={(evt) =>
                menu.open(evt, [
                  { type: "heading", label: `${ep.method} ${ep.path}` },
                  {
                    type: "item",
                    label: "Open in API explorer",
                    icon: Webhook,
                    onSelect: () =>
                      nav({
                        mode: "surfaces",
                        surfaces: { view: "apis", api: `${ep.method} ${ep.path}` },
                      }),
                  },
                  ...symbolMenu({
                    file: ep.file,
                    line: ep.line,
                    symbol: ep.handler,
                    label: `${ep.method} ${ep.path}`,
                  }),
                  {
                    type: "item",
                    label: "Copy route",
                    icon: Copy,
                    onSelect: () =>
                      void navigator.clipboard?.writeText(`${ep.method} ${ep.path}`),
                  },
                ])
              }
              className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-2"
            >
              <button
                type="button"
                onClick={() => requestOpenFile(ep.file)}
                title={ep.file}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                  {ep.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {ep.path}
                </span>
              </button>
              <Tooltip content="Open in the API explorer — handler, trace and callers">
                <button
                  type="button"
                  onClick={() =>
                    nav({
                      mode: "surfaces",
                      surfaces: { view: "apis", api: `${ep.method} ${ep.path}` },
                    })
                  }
                  aria-label={`Open ${ep.method} ${ep.path} in the API explorer`}
                  className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Webhook className="h-3 w-3" />
                </button>
              </Tooltip>
            </div>
          ))}
        </Section>
      )}

      {apiOutbound.length > 0 && (
        <Section title="Calls APIs">
          {apiOutbound.flatMap((l) =>
            (l.apis ?? []).map((a) => (
              <div
                key={`${l.target}:${a.method} ${a.path}`}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-2"
              >
                <Tooltip content="Inspect the boundary contract">
                  <button
                    type="button"
                    onClick={() => onSelectEdge(linkKeyOf(l))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                      {a.method}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                      {a.path}
                    </span>
                    <span className="max-w-24 shrink-0 truncate text-[9px] text-ink-faint">
                      {nameOf(l.target)}
                    </span>
                    <span className="shrink-0 text-[9px] text-ink-faint">×{a.weight}</span>
                  </button>
                </Tooltip>
                <Tooltip content="Open in the API explorer — handler, trace and callers">
                  <button
                    type="button"
                    onClick={() =>
                      nav({
                        mode: "surfaces",
                        surfaces: { view: "apis", api: `${a.method} ${a.path}` },
                      })
                    }
                    aria-label={`Open ${a.method} ${a.path} in the API explorer`}
                    className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Webhook className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            )),
          )}
        </Section>
      )}

      {(outbound.length > 0 || system.externals.length > 0 || system.libraries.length > 0) && (
        <Section title="Consumes">
          {outbound.map((l) => linkRow(l, l.target, "out"))}
          {system.externals.map((x) => (
            <div key={x.id} className="flex items-center gap-1.5 px-1.5 py-1">
              <Plug className="h-3 w-3 shrink-0 text-accent-amber" />
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{x.name}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">×{x.weight}</span>
            </div>
          ))}
          {system.libraries.map((l) => (
            <div key={l.pkg} className="flex items-center gap-1.5 px-1.5 py-1">
              <Package className="h-3 w-3 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">{l.pkg}</span>
              <span className="shrink-0 text-[10px] text-ink-faint">×{l.weight}</span>
            </div>
          ))}
        </Section>
      )}

      {inbound.length > 0 && (
        <Section title="Consumed by">{inbound.map((l) => linkRow(l, l.source, "in"))}</Section>
      )}
      {menu.element}
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
  highlight,
  onSelect,
  onSelectEdge,
  onClose,
}: {
  state: RefDiffState;
  /** Canvas selection to spotlight: a system id or a `src->tgt` link key. */
  highlight: string | null;
  onSelect: (id: string) => void;
  onSelectEdge: (key: string) => void;
  onClose: () => void;
}) {
  const { diff } = state;
  const row = (
    key: string,
    select: () => void,
    label: string,
    detail: string,
    tone?: "ok" | "danger" | "warn",
  ) => {
    // System rows match the id exactly; a system's externals rows
    // (`<sysId>:<service>`) light up with their owner.
    const highlighted =
      highlight != null && (key === highlight || key.startsWith(`${highlight}:`));
    return (
      <button
        key={key}
        type="button"
        ref={(el) => {
          if (highlighted) el?.scrollIntoView({ block: "nearest" });
        }}
        onClick={select}
        className={cn(
          "block w-full rounded-md px-1.5 py-1 text-left hover:bg-surface-2",
          highlighted && "bg-surface-2 ring-1 ring-inset ring-ink/25",
        )}
      >
        <div
          className={cn(
            "text-[11px]",
            tone === "ok"
              ? "text-ok"
              : tone === "danger"
                ? "text-danger"
                : tone === "warn"
                  ? "text-warn"
                  : "text-ink",
          )}
        >
          {label}
        </div>
        {detail && <div className="text-[9px] leading-snug text-ink-faint">{detail}</div>}
      </button>
    );
  };

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
            row(s.id, () => onSelect(s.id), s.name, `${s.role} · ${s.fileCount} files`, "ok"),
          )}
        </Section>
      )}
      {diff.removedSystems.length > 0 && (
        <Section title="Removed systems">
          {diff.removedSystems.map((s) =>
            row(s.id, () => onSelect(s.id), s.name, `${s.role} · was ${s.fileCount} files`, "danger"),
          )}
        </Section>
      )}
      {diff.addedLinks.length > 0 && (
        <Section title="New dependencies">
          {diff.addedLinks.map((l) => {
            const key = `${l.source}->${l.target}`;
            return row(
              key,
              () => onSelectEdge(key),
              `${l.sourceName} → ${l.targetName} ×${l.weight}`,
              l.symbols.join(", "),
              "ok",
            );
          })}
        </Section>
      )}
      {diff.removedLinks.length > 0 && (
        <Section title="Dropped dependencies">
          {diff.removedLinks.map((l) => {
            const key = `${l.source}->${l.target}`;
            return row(
              key,
              () => onSelectEdge(key),
              `${l.sourceName} → ${l.targetName}`,
              l.symbols.join(", "),
              "danger",
            );
          })}
        </Section>
      )}
      {diff.reweighted.length > 0 && (
        <Section title="Coupling shifts">
          {diff.reweighted.map((l) => {
            const key = `${l.source}->${l.target}`;
            return row(
              key,
              () => onSelectEdge(key),
              `${l.sourceName} → ${l.targetName}: ×${l.before} → ×${l.after}`,
              l.symbols.join(", "),
              "warn",
            );
          })}
        </Section>
      )}
      {diff.resized.length > 0 && (
        <Section title="Size shifts">
          {diff.resized.map((s) =>
            row(s.id, () => onSelect(s.id), s.name, `${s.before} → ${s.after} files`, "warn"),
          )}
        </Section>
      )}
      {diff.addedExternals.length > 0 && (
        <Section title="New external services">
          {diff.addedExternals.map((x) =>
            row(
              `${x.system}:${x.name}`,
              () => onSelect(x.system),
              `${x.systemName} now talks to ${x.name}`,
              "",
              "ok",
            ),
          )}
        </Section>
      )}
      {diff.removedExternals.length > 0 && (
        <Section title="Dropped external services">
          {diff.removedExternals.map((x) =>
            row(
              `${x.system}:${x.name}`,
              () => onSelect(x.system),
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

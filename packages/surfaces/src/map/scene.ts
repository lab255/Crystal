import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge as RfEdge, type Node as RfNode } from "@xyflow/react";
import type {
  ScreenApiCall,
  ScreenSurface,
  SurfacesReport,
  SystemEndpoint,
  SystemExternal,
  SystemModule,
  SystemOverview,
} from "@crystal/core";

/**
 * System map scene builder — the full stack on one canvas: frontend screens,
 * backend systems with their API endpoints, data systems and integrations,
 * with edges showing which screens call which backend systems.
 *
 * Pure and deterministic: same `(report, overview, calls, selected, find)` in,
 * same react-flow nodes/edges out. No React — the view supplies node renderers
 * for the `type` strings emitted here.
 *
 * Node ids (the deep link's `node` param uses the same ids):
 *   - `screen:<ScreenSurface.id>`  — one card per screen
 *   - `<SystemModule.id>`          — system cards/groups ("sys:…" already)
 *   - `ep:<METHOD> <path>`        — endpoint *rows* inside system cards
 *                                    (selection-only; not react-flow nodes)
 *   - `band:<MapBandId>` / `externals` — canvas furniture, not selectable
 */

/* ------------------------------------------------------------------ */
/* Bands                                                               */
/* ------------------------------------------------------------------ */

export const MAP_BANDS = ["screens", "backend", "data", "integrations"] as const;
export type MapBandId = (typeof MAP_BANDS)[number];

export const MAP_BAND_LABELS: Record<MapBandId, string> = {
  screens: "Screens",
  backend: "Backend",
  data: "Data",
  integrations: "Integrations",
};

/* ------------------------------------------------------------------ */
/* Node data                                                           */
/* ------------------------------------------------------------------ */

export interface MapBandData extends Record<string, unknown> {
  band: MapBandId;
  label: string;
}

export interface MapScreenData extends Record<string, unknown> {
  screen: ScreenSurface;
  /** Outgoing HTTP calls reachable from this screen (matched or not). */
  callCount: number;
  selected: boolean;
  dimmed: boolean;
}

/** Container for one frontend system's screens (multi-frontend workspaces). */
export interface MapFeGroupData extends Record<string, unknown> {
  system: SystemModule;
  screenCount: number;
  selected: boolean;
  dimmed: boolean;
}

/** Endpoint-row interactions the view injects (the builder never sets these). */
export interface MapEndpointHandlers {
  onEndpointClick?: (sysId: string, ep: SystemEndpoint) => void;
  onEndpointDoubleClick?: (sysId: string, ep: SystemEndpoint) => void;
}

export interface MapSystemData extends Record<string, unknown>, MapEndpointHandlers {
  system: SystemModule;
  /** Endpoint rows shown on the card (capped — see `moreEndpoints`). */
  endpointsShown: SystemEndpoint[];
  /** Endpoints beyond the cap ("+N more"). */
  moreEndpoints: number;
  /** Schemas attributed to this system by file prefix (data band). */
  schemaCount: number;
  externals: SystemExternal[];
  /** Header-only rendering (frontend systems without screens). */
  compact: boolean;
  selected: boolean;
  dimmed: boolean;
  /** "METHOD path" of the selected endpoint when it lives on this card. */
  selectedEndpoint: string | null;
}

/** Aggregated external services across every system (integrations band). */
export interface MapExternalsData extends Record<string, unknown> {
  externals: SystemExternal[];
  more: number;
  dimmed: boolean;
}

export type MapBandRfNode = RfNode<MapBandData>;
export type MapScreenRfNode = RfNode<MapScreenData>;
export type MapFeGroupRfNode = RfNode<MapFeGroupData>;
export type MapSystemRfNode = RfNode<MapSystemData>;
export type MapExternalsRfNode = RfNode<MapExternalsData>;

export type SystemMapNode =
  | MapBandRfNode
  | MapScreenRfNode
  | MapFeGroupRfNode
  | MapSystemRfNode
  | MapExternalsRfNode;

export type MapEdgeKind = "call" | "feapi" | "link";

export interface MapEdgeData extends Record<string, unknown> {
  kind: MapEdgeKind;
  /** Endpoint keys ("METHOD path") the edge carries (call edges). */
  epKeys?: string[];
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

export const SCREEN_W = 212;
export const SCREEN_H = 58;
const SCREEN_GAP = 14;
export const SYS_CARD_W = 252;
const SYS_HEADER_H = 54;
const ROW_H = 18;
const SECTION_PAD = 24;
const MORE_H = 16;
const COMPACT_H = 54;
const FE_HEADER_H = 38;
const FE_PAD = 14;
const BAND_HEADER = 34;
const BAND_PAD = 20;
const BAND_GAP = 56;
const BLOCK_GAP = 32;
/** Endpoint rows shown on a system card before "+N more". */
export const ENDPOINT_ROWS_SHOWN = 6;
const EXTERNALS_SHOWN = 6;

export const screenNodeId = (screenId: string): string => `screen:${screenId}`;
export const epKeyOf = (ep: { method: string; path: string }): string =>
  `${ep.method} ${ep.path}`;
export const epNodeId = (ep: { method: string; path: string }): string => `ep:${epKeyOf(ep)}`;

function sysCardHeight(data: Pick<MapSystemData, "endpointsShown" | "moreEndpoints" | "externals" | "compact">): number {
  if (data.compact) return COMPACT_H;
  let h = SYS_HEADER_H;
  if (data.endpointsShown.length > 0) {
    h += SECTION_PAD + data.endpointsShown.length * ROW_H + (data.moreEndpoints > 0 ? MORE_H : 0);
  }
  if (data.externals.length > 0) h += SECTION_PAD + ROW_H;
  return h;
}

function externalsCardHeight(shown: number, more: number): number {
  return SYS_HEADER_H + (shown > 0 ? SECTION_PAD + shown * ROW_H + (more > 0 ? MORE_H : 0) : 0);
}

/** Deterministic wrap-grid for screen cards (block-relative positions). */
function screenGrid(screens: readonly ScreenSurface[]): {
  w: number;
  h: number;
  pos: Map<string, { x: number; y: number }>;
} {
  const n = screens.length;
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))));
  const rows = Math.max(1, Math.ceil(n / cols));
  const pos = new Map<string, { x: number; y: number }>();
  screens.forEach((s, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(s.id, { x: c * (SCREEN_W + SCREEN_GAP), y: r * (SCREEN_H + SCREEN_GAP) });
  });
  return {
    w: cols * SCREEN_W + (cols - 1) * SCREEN_GAP,
    h: rows * SCREEN_H + (rows - 1) * SCREEN_GAP,
    pos,
  };
}

/** Dagre (LR) over one band's cards — same options the systems view uses. */
function dagreBand(
  items: readonly { id: string; w: number; h: number }[],
  pairs: readonly { source: string; target: string }[],
): { w: number; h: number; pos: Map<string, { x: number; y: number }> } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 90, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(items.map((i) => i.id));
  for (const item of items) g.setNode(item.id, { width: item.w, height: item.h });
  for (const p of pairs) {
    if (p.source !== p.target && ids.has(p.source) && ids.has(p.target)) g.setEdge(p.source, p.target);
  }
  dagre.layout(g);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const raw = items.map((item) => {
    const n = g.node(item.id);
    const x = n.x - item.w / 2;
    const y = n.y - item.h / 2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + item.w);
    maxY = Math.max(maxY, y + item.h);
    return { id: item.id, x, y };
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const r of raw) pos.set(r.id, { x: r.x - minX, y: r.y - minY });
  return { w: maxX - minX, h: maxY - minY, pos };
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export interface SystemMapSceneInput {
  report: SurfacesReport;
  overview: SystemOverview;
  /** Screen→endpoint reachability (`surfaces.map`); empty until it lands. */
  calls: readonly ScreenApiCall[];
  /** Selected node id (`SurfacesLink.node`) — see the id scheme above. */
  selected: string | null;
  /** Case-insensitive substring filter; misses dim. */
  find: string;
}

export interface SystemMapScene {
  nodes: SystemMapNode[];
  edges: RfEdge[];
  /** Nothing analyzable — the view shows an empty state. */
  empty: boolean;
}

export function buildSystemMapScene(input: SystemMapSceneInput): SystemMapScene {
  const { report, overview, calls, selected, find } = input;
  const systems = overview.systems;
  const screens = [...report.screens].sort(
    (a, b) => a.route.localeCompare(b.route) || a.id.localeCompare(b.id),
  );
  if (systems.length === 0 && screens.length === 0) {
    return { nodes: [], edges: [], empty: true };
  }

  /* ---- file → system attribution (longest part-path prefix wins) ---- */
  const partIndex: { path: string; system: SystemModule }[] = [];
  for (const s of systems) for (const p of s.parts) partIndex.push({ path: p.path, system: s });
  partIndex.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const sysOfFile = (file: string): SystemModule | null =>
    partIndex.find((p) => file === p.path || file.startsWith(`${p.path}/`))?.system ?? null;

  const feSystems = systems.filter((s) => s.layer === "frontend");
  const backendSystems = systems.filter((s) => s.layer === "backend");
  const dataSystems = systems.filter((s) => s.layer === "database");
  const integrationSystems = systems.filter((s) => s.layer === "integrations");

  /* ---- screens: attribution + grouping decision ---- */
  const grouping = feSystems.length > 1;
  const screenIds = new Set(screens.map((s) => s.id));
  const screensBySystem = new Map<string, ScreenSurface[]>();
  const looseScreens: ScreenSurface[] = [];
  for (const s of screens) {
    const owner = sysOfFile(s.file);
    if (grouping && owner && owner.layer === "frontend") {
      const list = screensBySystem.get(owner.id) ?? [];
      list.push(s);
      screensBySystem.set(owner.id, list);
    } else {
      looseScreens.push(s);
    }
  }
  const screenOwner = new Map<string, string>();
  for (const [sysId, list] of screensBySystem) for (const s of list) screenOwner.set(s.id, sysId);

  /* ---- per-screen call counts + call aggregation into edges ---- */
  const callCountOf = new Map<string, number>();
  for (const c of calls) callCountOf.set(c.screen, (callCountOf.get(c.screen) ?? 0) + 1);

  interface CallAgg {
    screenId: string;
    sysId: string;
    count: number;
    first: ScreenApiCall;
    epKeys: Set<string>;
  }
  const callAgg = new Map<string, CallAgg>();
  for (const c of calls) {
    if (!c.endpoint || !screenIds.has(c.screen)) continue;
    const target = sysOfFile(c.endpoint.file);
    if (!target || target.layer === "frontend") continue;
    const key = `${screenNodeId(c.screen)}->${target.id}`;
    const agg = callAgg.get(key) ?? {
      screenId: c.screen,
      sysId: target.id,
      count: 0,
      first: c,
      epKeys: new Set<string>(),
    };
    agg.count += 1;
    agg.epKeys.add(epKeyOf(c.endpoint));
    callAgg.set(key, agg);
  }

  /* ---- schemas attributed per system (data cards) ---- */
  const schemaCountOf = new Map<string, number>();
  for (const schema of report.schemas) {
    const owner = sysOfFile(schema.file);
    if (owner) schemaCountOf.set(owner.id, (schemaCountOf.get(owner.id) ?? 0) + 1);
  }

  /* ---- aggregated externals (integrations band content) ---- */
  const externalAgg = new Map<string, SystemExternal>();
  for (const s of systems) {
    for (const x of s.externals) {
      const entry = externalAgg.get(x.id) ?? { id: x.id, name: x.name, weight: 0 };
      entry.weight += x.weight;
      externalAgg.set(x.id, entry);
    }
  }
  const externalsAll = [...externalAgg.values()].sort(
    (a, b) => b.weight - a.weight || a.name.localeCompare(b.name),
  );

  /* ---- edge skeletons ---- */
  interface EdgeSkeleton {
    id: string;
    source: string;
    target: string;
    kind: MapEdgeKind;
    label: string;
    weight: number;
    epKeys: string[];
    apiOnly: boolean;
  }
  const skeletons: EdgeSkeleton[] = [];

  // (a) screen → backend system, aggregated from matched calls.
  for (const [key, agg] of [...callAgg.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    skeletons.push({
      id: `call:${key}`,
      source: screenNodeId(agg.screenId),
      target: agg.sysId,
      kind: "call",
      label:
        agg.count === 1
          ? trunc(`${agg.first.method} ${agg.first.path}`, 26)
          : `${agg.count} calls`,
      weight: agg.count,
      epKeys: [...agg.epKeys].sort(),
      apiOnly: true,
    });
  }

  // Frontend systems represented by their own node (group or compact card).
  const feNodeIds = new Set<string>();
  if (grouping) for (const s of feSystems) feNodeIds.add(s.id);
  else for (const s of feSystems) if (screens.length === 0) feNodeIds.add(s.id);

  const nonFeIds = new Set(systems.filter((s) => s.layer !== "frontend").map((s) => s.id));

  // (b) frontend-system → backend-system fallback from `SystemLink.apis`
  // for pairs with no screen-level edge (only when the frontend system has
  // a node of its own to hang the edge on).
  for (const l of overview.links) {
    if (!feNodeIds.has(l.source) || !nonFeIds.has(l.target)) continue;
    const apis = l.apis ?? [];
    if (apis.length === 0) continue;
    const covered = [...callAgg.values()].some(
      (agg) => agg.sysId === l.target && screenOwner.get(agg.screenId) === l.source,
    );
    if (covered) continue;
    const first = apis[0]!;
    skeletons.push({
      id: `feapi:${l.source}->${l.target}`,
      source: l.source,
      target: l.target,
      kind: "feapi",
      label: trunc(
        `${first.method} ${first.path}${apis.length > 1 ? ` +${apis.length - 1}` : ""}`,
        30,
      ),
      weight: apis.reduce((n, a) => n + a.weight, 0) || 1,
      epKeys: apis.map(epKeyOf).sort(),
      apiOnly: true,
    });
  }

  // (c) system → system links between visible non-frontend systems.
  for (const l of overview.links) {
    if (!nonFeIds.has(l.source) || !nonFeIds.has(l.target)) continue;
    const apis = l.apis ?? [];
    const apiOnly = l.weight === 0 && apis.length > 0;
    const first = apis[0];
    skeletons.push({
      id: `link:${l.source}->${l.target}`,
      source: l.source,
      target: l.target,
      kind: "link",
      label:
        apiOnly && first
          ? trunc(`${first.method} ${first.path}${apis.length > 1 ? ` +${apis.length - 1}` : ""}`, 30)
          : `×${l.weight}`,
      weight: Math.max(1, l.weight),
      epKeys: apis.map(epKeyOf).sort(),
      apiOnly,
    });
  }

  /* ---- selection: bright set + edge fading ---- */
  const sel = selected && selected.trim().length > 0 ? selected : null;
  const selEp = sel?.startsWith("ep:") ? sel.slice(3) : null;
  // A stale deep link (renamed system, removed screen) must not dim the world.
  const knownIds = new Set<string>([
    ...screens.map((s) => screenNodeId(s.id)),
    ...systems.map((s) => s.id),
  ]);
  const selNodeId = !selEp && sel && knownIds.has(sel) ? sel : null;
  const epOwner = selEp
    ? (systems.find((s) => s.endpoints.some((e) => epKeyOf(e) === selEp)) ?? null)
    : null;

  const adjacency = new Map<string, Set<string>>();
  const addAdj = (a: string, b: string) => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of skeletons) addAdj(e.source, e.target);

  const bright = new Set<string>();
  if (selNodeId) {
    bright.add(selNodeId);
    for (const n of adjacency.get(selNodeId) ?? []) bright.add(n);
    // A selected frontend group keeps its screens bright (and vice versa).
    if (feNodeIds.has(selNodeId)) {
      for (const s of screensBySystem.get(selNodeId) ?? []) bright.add(screenNodeId(s.id));
    }
  } else if (selEp && epOwner) {
    bright.add(epOwner.id);
    for (const c of calls) {
      if (c.endpoint && epKeyOf(c.endpoint) === selEp && screenIds.has(c.screen)) {
        bright.add(screenNodeId(c.screen));
      }
    }
  }
  // A bright screen keeps its containing group readable.
  for (const [screenId, sysId] of screenOwner) {
    if (bright.has(screenNodeId(screenId))) bright.add(sysId);
  }
  const selectionActive = bright.size > 0;

  /* ---- find matching ---- */
  const q = find.trim().toLowerCase();
  const screenMatches = (s: ScreenSurface): boolean =>
    !q ||
    s.route.toLowerCase().includes(q) ||
    s.file.toLowerCase().includes(q) ||
    (s.component ?? "").toLowerCase().includes(q);
  const sysMatches = (s: SystemModule): boolean =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.parts.some((p) => p.path.toLowerCase().includes(q)) ||
    s.endpoints.some((e) => epKeyOf(e).toLowerCase().includes(q)) ||
    s.externals.some((x) => x.name.toLowerCase().includes(q));
  const externalsMatch = (): boolean =>
    !q || externalsAll.some((x) => x.name.toLowerCase().includes(q));

  const dimmedOf = (id: string, matches: boolean): boolean =>
    (q.length > 0 && !matches) || (selectionActive && !bright.has(id));

  /* ---- node construction (unpositioned) ---- */
  const makeScreenNode = (s: ScreenSurface): MapScreenRfNode => {
    const id = screenNodeId(s.id);
    return {
      id,
      type: "mapScreen",
      position: { x: 0, y: 0 },
      data: {
        screen: s,
        callCount: callCountOf.get(s.id) ?? 0,
        selected: id === selNodeId,
        dimmed: dimmedOf(id, screenMatches(s)),
      },
      style: { width: SCREEN_W, height: SCREEN_H },
      draggable: false,
    };
  };

  const makeSystemNode = (s: SystemModule, compact: boolean): MapSystemRfNode => {
    const endpointsShown = compact ? [] : s.endpoints.slice(0, ENDPOINT_ROWS_SHOWN);
    const data: MapSystemData = {
      system: s,
      endpointsShown,
      moreEndpoints: compact ? 0 : Math.max(0, s.endpoints.length - endpointsShown.length),
      schemaCount: schemaCountOf.get(s.id) ?? 0,
      externals: compact ? [] : s.externals,
      compact,
      selected: s.id === selNodeId || (selEp != null && epOwner?.id === s.id),
      dimmed: dimmedOf(s.id, sysMatches(s)),
      selectedEndpoint: selEp != null && epOwner?.id === s.id ? selEp : null,
    };
    return {
      id: s.id,
      type: "mapSystem",
      position: { x: 0, y: 0 },
      data,
      style: { width: SYS_CARD_W, height: sysCardHeight(data) },
      draggable: false,
    };
  };

  /* ---- assembly: bands stacked vertically, parents before children ---- */
  const nodes: SystemMapNode[] = [];
  let bandY = 0;

  const pushBand = (
    band: MapBandId,
    width: number,
    height: number,
  ): string => {
    const id = `band:${band}`;
    nodes.push({
      id,
      type: "mapBand",
      position: { x: 0, y: bandY },
      data: { band, label: MAP_BAND_LABELS[band] },
      style: { width, height },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
    });
    bandY += height + BAND_GAP;
    return id;
  };

  /* -- screens band -- */
  type ScreensBlock =
    | { kind: "group"; system: SystemModule; screens: ScreenSurface[] }
    | { kind: "card"; system: SystemModule }
    | { kind: "loose"; screens: ScreenSurface[] };
  const screenBlocks: ScreensBlock[] = [];
  if (grouping) {
    for (const s of feSystems) {
      const members = screensBySystem.get(s.id);
      if (members && members.length > 0) screenBlocks.push({ kind: "group", system: s, screens: members });
      else screenBlocks.push({ kind: "card", system: s });
    }
    if (looseScreens.length > 0) screenBlocks.push({ kind: "loose", screens: looseScreens });
  } else {
    if (looseScreens.length > 0) screenBlocks.push({ kind: "loose", screens: looseScreens });
    if (screens.length === 0) for (const s of feSystems) screenBlocks.push({ kind: "card", system: s });
  }

  if (screenBlocks.length > 0) {
    const measured = screenBlocks.map((block) => {
      if (block.kind === "group") {
        const grid = screenGrid(block.screens);
        return {
          block,
          grid,
          w: Math.max(grid.w + FE_PAD * 2, SYS_CARD_W),
          h: FE_HEADER_H + grid.h + FE_PAD,
        };
      }
      if (block.kind === "card") return { block, grid: null, w: SYS_CARD_W, h: COMPACT_H };
      const grid = screenGrid(block.screens);
      return { block, grid, w: grid.w, h: grid.h };
    });
    const bandW =
      measured.reduce((n, m) => n + m.w, 0) + (measured.length - 1) * BLOCK_GAP + BAND_PAD * 2;
    const bandH = BAND_HEADER + Math.max(...measured.map((m) => m.h)) + BAND_PAD;
    const bandId = pushBand("screens", bandW, bandH);

    let x = BAND_PAD;
    for (const m of measured) {
      const { block } = m;
      if (block.kind === "group") {
        const groupId = block.system.id;
        const dim = dimmedOf(groupId, sysMatches(block.system));
        nodes.push({
          id: groupId,
          type: "mapFeGroup",
          parentId: bandId,
          position: { x, y: BAND_HEADER },
          data: {
            system: block.system,
            screenCount: block.screens.length,
            selected: groupId === selNodeId,
            dimmed: dim,
          },
          style: { width: m.w, height: m.h },
          draggable: false,
        });
        for (const s of block.screens) {
          const p = m.grid!.pos.get(s.id)!;
          nodes.push({
            ...makeScreenNode(s),
            parentId: groupId,
            position: { x: p.x + FE_PAD, y: p.y + FE_HEADER_H },
          });
        }
      } else if (block.kind === "card") {
        nodes.push({
          ...makeSystemNode(block.system, true),
          parentId: bandId,
          position: { x, y: BAND_HEADER },
        });
      } else {
        for (const s of block.screens) {
          const p = m.grid!.pos.get(s.id)!;
          nodes.push({
            ...makeScreenNode(s),
            parentId: bandId,
            position: { x: x + p.x, y: BAND_HEADER + p.y },
          });
        }
      }
      x += m.w + BLOCK_GAP;
    }
  }

  /* -- backend / data / integrations bands (dagre inside each) -- */
  const sysPairs = skeletons
    .filter((e) => e.kind === "link")
    .map((e) => ({ source: e.source, target: e.target }));

  const systemBand = (band: MapBandId, members: SystemModule[], withExternals: boolean) => {
    const cards = members.map((s) => makeSystemNode(s, false));
    const items = cards.map((c) => ({
      id: c.id,
      w: SYS_CARD_W,
      h: (c.style?.height as number) ?? COMPACT_H,
    }));
    const externalsShown = externalsAll.slice(0, EXTERNALS_SHOWN);
    const externalsNode: MapExternalsRfNode | null =
      withExternals && externalsAll.length > 0
        ? {
            id: "externals",
            type: "mapExternals",
            position: { x: 0, y: 0 },
            data: {
              externals: externalsShown,
              more: externalsAll.length - externalsShown.length,
              dimmed: dimmedOf("externals", externalsMatch()),
            },
            style: {
              width: SYS_CARD_W,
              height: externalsCardHeight(
                externalsShown.length,
                externalsAll.length - externalsShown.length,
              ),
            },
            draggable: false,
            selectable: false,
          }
        : null;
    if (externalsNode) {
      items.push({
        id: externalsNode.id,
        w: SYS_CARD_W,
        h: (externalsNode.style?.height as number) ?? COMPACT_H,
      });
    }
    if (items.length === 0) return;
    const laid = dagreBand(items, sysPairs);
    const bandId = pushBand(
      band,
      laid.w + BAND_PAD * 2,
      BAND_HEADER + laid.h + BAND_PAD,
    );
    for (const card of externalsNode ? [...cards, externalsNode] : cards) {
      const p = laid.pos.get(card.id)!;
      nodes.push({
        ...card,
        parentId: bandId,
        position: { x: p.x + BAND_PAD, y: p.y + BAND_HEADER },
      });
    }
  };

  systemBand("backend", backendSystems, false);
  systemBand("data", dataSystems, false);
  systemBand("integrations", integrationSystems, true);

  /* ---- styled edges ---- */
  const nodeIds = new Set(nodes.map((n) => n.id));
  const maxLinkWeight = skeletons.reduce((m, e) => (e.kind === "link" ? Math.max(m, e.weight) : m), 1);
  const maxCallCount = skeletons.reduce((m, e) => (e.kind === "call" ? Math.max(m, e.weight) : m), 1);
  const edges: RfEdge[] = [];
  for (const e of skeletons) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const active = selNodeId
      ? e.source === selNodeId || e.target === selNodeId
      : selEp
        ? e.kind === "call" && e.epKeys.includes(selEp)
        : false;
    const faded = selectionActive && !active;
    const stroke = e.apiOnly
      ? "var(--color-accent-amber)"
      : active
        ? "var(--color-accent-violet)"
        : "var(--color-edge-strong)";
    const width =
      e.kind === "link" && !e.apiOnly
        ? 1 + 2 * Math.sqrt(e.weight / maxLinkWeight)
        : 1 + Math.min(1.5, Math.sqrt(e.weight / maxCallCount));
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      data: { kind: e.kind, epKeys: e.epKeys } satisfies MapEdgeData,
      animated: e.apiOnly && e.kind !== "call" && !faded,
      zIndex: 1,
      labelStyle: {
        fontSize: 9,
        fill: e.apiOnly ? "var(--color-accent-amber)" : "var(--color-ink-faint)",
      },
      labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      style: {
        stroke,
        strokeWidth: width,
        strokeDasharray: e.apiOnly ? "4 3" : undefined,
        opacity: faded ? 0.08 : 1,
      },
    });
  }

  return { nodes, edges, empty: false };
}

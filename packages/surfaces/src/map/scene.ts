import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge as RfEdge, type Node as RfNode } from "@xyflow/react";
import {
  endpointKey,
  isFixtureScopedPath,
  type ScreenApiCall,
  type ScreenSurface,
  type SurfacesReport,
  type SystemEndpoint,
  type SystemExternal,
  type SystemModule,
  type SystemOverview,
  type SystemRole,
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
  // "Frontend", not "Screens" — the band holds frontend *systems* (with their
  // screens inside) and stays honest when a workspace has modules but no
  // routed screens.
  screens: "Frontend",
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

/** How a ref review marks a node/edge/endpoint-row: green / red / yellow. */
export type MapDiffMark = "added" | "removed" | "modified";

/** The ref review's marks, applied during decoration (geometry-blind). */
export interface SystemMapMarks {
  /** react-flow node id (`screen:…`, system id) → mark. */
  node: ReadonlyMap<string, MapDiffMark>;
  /** react-flow edge id (`call:…`, `feapi:…`, `link:…`) → mark. */
  edge: ReadonlyMap<string, MapDiffMark>;
  /** `${systemId}|${epKey}` → mark for endpoint rows on system cards. */
  ep: ReadonlyMap<string, MapDiffMark>;
}

export interface MapScreenData extends Record<string, unknown> {
  screen: ScreenSurface;
  /** Outgoing HTTP calls reachable from this screen (matched or not). */
  callCount: number;
  /** Calls with no serving route in the workspace — drift worth surfacing. */
  unmatchedCount: number;
  selected: boolean;
  dimmed: boolean;
  /** Ref-review mark ("new" / "gone" / "changed" badge). */
  mark?: MapDiffMark;
}

/** Container for one frontend system's screens (multi-frontend workspaces). */
export interface MapFeGroupData extends Record<string, unknown> {
  system: SystemModule;
  screenCount: number;
  selected: boolean;
  dimmed: boolean;
  /** Ref-review mark ("new" / "gone" / "changed" badge). */
  mark?: MapDiffMark;
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
  /** Ref-review mark ("new" / "gone" / "changed" badge). */
  mark?: MapDiffMark;
  /** Ref-review marks for this card's endpoint rows, keyed by epKey. */
  epMarks?: Readonly<Record<string, MapDiffMark>>;
  /**
   * Lens dimming for this card's endpoint rows, keyed by epKey. Injected by
   * the view at render time (like the endpoint handlers) — never set by the
   * builder, so worker inputs/outputs stay lens-free and structured-clonable.
   */
  epDimmed?: Readonly<Record<string, true>>;
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
}

/** What the deep-linked `node` id resolved to — the inspector renders this. */
export type SystemMapSelection =
  | { kind: "screen"; screen: ScreenSurface }
  | { kind: "system"; system: SystemModule }
  | { kind: "endpoint"; epKey: string; owner: SystemModule };

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
/** Screens-band blocks wrap into rows past this width. */
const MAX_BAND_ROW_W = 1080;
/** Endpoint rows shown on a system card before "+N more". */
export const ENDPOINT_ROWS_SHOWN = 6;
const EXTERNALS_SHOWN = 6;

export const screenNodeId = (screenId: string): string => `screen:${screenId}`;
/** Canonical "METHOD path" — the shared core helper, re-exported for the map. */
export const epKeyOf = endpointKey;
export const epNodeId = (ep: { method: string; path: string }): string => `ep:${epKeyOf(ep)}`;

/**
 * file → owning system by longest part-path prefix (ties broken
 * lexicographically), memoized per file. The single attribution rule for the
 * whole surfaces mode — the provider's `systemOfFile` and the map's edge
 * targeting must agree or the canvas and the panes tell different stories.
 */
export function makeSystemAttributor(
  systems: readonly SystemModule[],
): (file: string) => SystemModule | null {
  const partIndex: { path: string; system: SystemModule }[] = [];
  for (const s of systems) for (const p of s.parts) partIndex.push({ path: p.path, system: s });
  partIndex.sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const memo = new Map<string, SystemModule | null>();
  return (file: string): SystemModule | null => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    const found =
      partIndex.find((p) => file === p.path || file.startsWith(`${p.path}/`))?.system ?? null;
    memo.set(file, found);
    return found;
  };
}

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
  g.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 96, marginx: 0, marginy: 0 });
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

/** Data inputs — everything the expensive layout phase depends on. */
export interface SystemMapLayoutInput {
  report: SurfacesReport;
  overview: SystemOverview;
  /** Screen→endpoint reachability (`surfaces.map`); empty until it lands. */
  calls: readonly ScreenApiCall[];
}

export interface SystemMapSceneInput extends SystemMapLayoutInput {
  /** Selected node id (`SurfacesLink.node`) — see the id scheme above. */
  selected: string | null;
  /** Case-insensitive substring filter; misses dim. */
  find: string;
  /** Ref-review marks; when present every node/edge is re-decorated. */
  marks?: SystemMapMarks | null;
}

export interface SystemMapScene {
  nodes: SystemMapNode[];
  edges: RfEdge[];
  /** Nothing analyzable — the view shows an empty state. */
  empty: boolean;
  /** Fixture-scoped systems + screens excluded from the map (`examples/…`). */
  fixturesHidden: number;
  /** Quiet-role platform systems trimmed from the backend band. */
  quietHidden: number;
  /** What the map actually shows (post filtering) — the stats chip. */
  stats: { screens: number; systems: number };
  /**
   * The resolved selection — null for stale ids (renamed system, removed
   * screen, fixture-hidden unit). The view's inspector must key off this, not
   * re-derive from the raw deep link, so canvas dimming and the inspector
   * can never disagree.
   */
  selection: SystemMapSelection | null;
}

/** Roles the map trims by default — platform noise, same set the systems view hides. */
const QUIET_ROLES: readonly SystemRole[] = ["shared", "entry"];

/** One laid-out edge at rest, plus what decoration needs to re-style it. */
interface MapEdgeBase {
  edge: RfEdge;
  kind: MapEdgeKind;
  source: string;
  target: string;
  epKeys: string[];
  apiOnly: boolean;
  restingOpacity: number;
}

/**
 * The expensive, selection-independent phase: filtering, attribution, dagre,
 * geometry, resting edge styles. The view memoizes this on the data inputs
 * alone — clicking a node or typing in find only re-runs the cheap
 * `decorateSystemMapScene` pass.
 */
export interface SystemMapLayout {
  nodes: SystemMapNode[];
  bases: MapEdgeBase[];
  empty: boolean;
  fixturesHidden: number;
  quietHidden: number;
  stats: { screens: number; systems: number };
  /** Decoration context — resolved once here, reused per selection change. */
  ctx: {
    screens: ScreenSurface[];
    systems: SystemModule[];
    screenIds: Set<string>;
    screensBySystem: Map<string, ScreenSurface[]>;
    screenOwner: Map<string, string>;
    feNodeIds: Set<string>;
    adjacency: Map<string, Set<string>>;
    calls: readonly ScreenApiCall[];
    externalsAll: SystemExternal[];
  };
}

export function buildSystemMapScene(input: SystemMapSceneInput): SystemMapScene {
  return decorateSystemMapScene(buildSystemMapLayout(input), input);
}

export function buildSystemMapLayout(input: SystemMapLayoutInput): SystemMapLayout {
  const { report, overview, calls } = input;
  // Node construction below is selection-blind — every card comes out at
  // rest (selected/dimmed false) and `decorateSystemMapScene` patches the
  // flags per selection/find change.
  // Fixture codebases are someone else's product — their screens and systems
  // would drown the host repo's map (the overview alone keeps them, scoped).
  const unscoped = overview.systems.filter(
    (s) => !s.parts.every((p) => isFixtureScopedPath(p.path)),
  );
  const screens = report.screens
    .filter((s) => !isFixtureScopedPath(s.file))
    .sort((a, b) => a.route.localeCompare(b.route) || a.id.localeCompare(b.id));
  const fixturesHidden =
    overview.systems.length - unscoped.length + (report.screens.length - screens.length);

  // Quiet-role backend systems (shared utils, entry shells) are the overview's
  // platform noise — at FormSG scale they turn the backend band into a
  // hairball. A quiet system stays whenever it participates in the product
  // story: it serves endpoints, owns screens, or receives a traced call.
  const preAttributor = makeSystemAttributor(unscoped);
  const involved = new Set<string>();
  for (const s of screens) {
    const owner = preAttributor(s.file);
    if (owner) involved.add(owner.id);
  }
  for (const c of calls) {
    const target = c.endpoint ? preAttributor(c.endpoint.file) : null;
    if (target) involved.add(target.id);
  }
  // Schema owners stay too — a shared "core" holding the domain's zod/prisma
  // shapes is part of the product story, not platform noise.
  for (const schema of report.schemas) {
    if (isFixtureScopedPath(schema.file)) continue;
    const owner = preAttributor(schema.file);
    if (owner) involved.add(owner.id);
  }
  const quiet = (s: SystemModule): boolean =>
    QUIET_ROLES.includes(s.role) &&
    s.layer === "backend" &&
    s.endpoints.length === 0 &&
    !involved.has(s.id);
  let systems = unscoped.filter((s) => !quiet(s));
  // A workspace made only of quiet systems still deserves a map.
  if (systems.length === 0) systems = unscoped;
  const quietHidden = unscoped.length - systems.length;

  const stats = { screens: screens.length, systems: systems.length };
  if (systems.length === 0 && screens.length === 0) {
    return {
      nodes: [],
      bases: [],
      empty: true,
      fixturesHidden,
      quietHidden,
      stats,
      ctx: {
        screens: [],
        systems: [],
        screenIds: new Set(),
        screensBySystem: new Map(),
        screenOwner: new Map(),
        feNodeIds: new Set(),
        adjacency: new Map(),
        calls,
        externalsAll: [],
      },
    };
  }

  /* ---- file → system attribution (longest part-path prefix wins) ---- */
  const sysOfFile = makeSystemAttributor(systems);

  const feSystems = systems.filter((s) => s.layer === "frontend");
  const backendSystems = systems.filter((s) => s.layer === "backend");
  const dataSystems = systems.filter((s) => s.layer === "database");
  const integrationSystems = systems.filter((s) => s.layer === "integrations");

  /* ---- screens: attribution + grouping ---- */
  // Frontend systems are first-class on the map: whenever the overview knows
  // one, its screens ride inside a labelled container (the module identity the
  // architecture overview shows) instead of floating loose in the band.
  const screenIds = new Set(screens.map((s) => s.id));
  const screensBySystem = new Map<string, ScreenSurface[]>();
  const looseScreens: ScreenSurface[] = [];
  for (const s of screens) {
    const owner = sysOfFile(s.file);
    if (owner && owner.layer === "frontend") {
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
  const unmatchedCountOf = new Map<string, number>();
  for (const c of calls) {
    callCountOf.set(c.screen, (callCountOf.get(c.screen) ?? 0) + 1);
    if (!c.endpoint) unmatchedCountOf.set(c.screen, (unmatchedCountOf.get(c.screen) ?? 0) + 1);
  }

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
    // Frontend-served routes (Next `app/api`, BFFs) draw like any other
    // target — except the screen's own container, where a screen→its-own-
    // system edge would just be a loop on the card it sits in. (Those calls
    // still count on the screen card and list in the inspector.)
    if (!target || screenOwner.get(c.screen) === target.id) continue;
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

  // Every frontend system gets its own node (group or compact card).
  const feNodeIds = new Set(feSystems.map((s) => s.id));
  const nonFeIds = new Set(systems.filter((s) => s.layer !== "frontend").map((s) => s.id));

  // (frontend system, target) pairs a screen-level edge already covers.
  const coveredPairs = new Set<string>();
  for (const agg of callAgg.values()) {
    const owner = screenOwner.get(agg.screenId);
    if (owner) coveredPairs.add(`${owner}->${agg.sysId}`);
  }

  // (b) frontend-system → backend-system fallback from `SystemLink.apis`
  // for pairs with no screen-level edge (only when the frontend system has
  // a node of its own to hang the edge on).
  for (const l of overview.links) {
    if (!feNodeIds.has(l.source) || !nonFeIds.has(l.target)) continue;
    const apis = l.apis ?? [];
    if (apis.length === 0) continue;
    if (coveredPairs.has(`${l.source}->${l.target}`)) continue;
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

  // Adjacency (for decoration's bright-set walk) — selection-independent.
  const adjacency = new Map<string, Set<string>>();
  const addAdj = (a: string, b: string) => {
    (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
    (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
  };
  for (const e of skeletons) addAdj(e.source, e.target);

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
        unmatchedCount: unmatchedCountOf.get(s.id) ?? 0,
        selected: false,
        dimmed: false,
      },
      // Explicit dimension props (never `style`) — the nodes are a controlled
      // prop, so react-flow can't write `measured` back onto them, and the
      // minimap only draws nodes whose dimensions it can read. react-flow
      // applies width/height as inline styles itself.
      width: SCREEN_W,
      height: SCREEN_H,
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
      selected: false,
      dimmed: false,
      selectedEndpoint: null,
    };
    return {
      id: s.id,
      type: "mapSystem",
      position: { x: 0, y: 0 },
      data,
      width: SYS_CARD_W,
      height: sysCardHeight(data),
      draggable: false,
    };
  };

  /* ---- assembly: bands stacked vertically, parents before children ---- */
  const nodes: SystemMapNode[] = [];
  // Which band a node landed in — cross-band edges leave the source's bottom
  // and enter the target's top so traffic reads as a vertical flow instead of
  // looping around to the side handles.
  const bandOfNode = new Map<string, MapBandId>();
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
      width,
      height,
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
  for (const s of feSystems) {
    const members = screensBySystem.get(s.id);
    if (members && members.length > 0)
      screenBlocks.push({ kind: "group", system: s, screens: members });
    else screenBlocks.push({ kind: "card", system: s });
  }
  if (looseScreens.length > 0) screenBlocks.push({ kind: "loose", screens: looseScreens });

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
    // Wrap blocks into rows — a workspace with many frontend systems must not
    // stretch the band into one endless strip.
    type Measured = (typeof measured)[number];
    const rows: { members: { m: Measured; x: number }[]; w: number; h: number }[] = [];
    {
      let row: { m: Measured; x: number }[] = [];
      let x = 0;
      const flush = () => {
        if (row.length === 0) return;
        rows.push({ members: row, w: x, h: Math.max(...row.map((r) => r.m.h)) });
        row = [];
        x = 0;
      };
      for (const m of measured) {
        if (row.length > 0 && x + BLOCK_GAP + m.w > MAX_BAND_ROW_W) flush();
        if (row.length > 0) x += BLOCK_GAP;
        row.push({ m, x });
        x += m.w;
      }
      flush();
    }
    const bandW = Math.max(...rows.map((r) => r.w)) + BAND_PAD * 2;
    const bandH =
      BAND_HEADER + rows.reduce((n, r) => n + r.h, 0) + (rows.length - 1) * BLOCK_GAP + BAND_PAD;
    const bandId = pushBand("screens", bandW, bandH);

    let rowY = BAND_HEADER;
    for (const row of rows) {
      for (const { m, x: rowX } of row.members) {
        const { block } = m;
        const x = BAND_PAD + rowX;
        if (block.kind === "group") {
          const groupId = block.system.id;
          bandOfNode.set(groupId, "screens");
          for (const s of block.screens) bandOfNode.set(screenNodeId(s.id), "screens");
          nodes.push({
            id: groupId,
            type: "mapFeGroup",
            parentId: bandId,
            position: { x, y: rowY },
            data: {
              system: block.system,
              screenCount: block.screens.length,
              selected: false,
              dimmed: false,
            },
            width: m.w,
            height: m.h,
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
          bandOfNode.set(block.system.id, "screens");
          nodes.push({
            ...makeSystemNode(block.system, true),
            parentId: bandId,
            position: { x, y: rowY },
          });
        } else {
          for (const s of block.screens) {
            bandOfNode.set(screenNodeId(s.id), "screens");
            const p = m.grid!.pos.get(s.id)!;
            nodes.push({
              ...makeScreenNode(s),
              parentId: bandId,
              position: { x: x + p.x, y: rowY + p.y },
            });
          }
        }
      }
      rowY += row.h + BLOCK_GAP;
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
      h: c.height ?? COMPACT_H,
    }));
    const externalsShown = externalsAll.slice(0, EXTERNALS_SHOWN);
    const externalsH = externalsCardHeight(
      externalsShown.length,
      externalsAll.length - externalsShown.length,
    );
    const externalsNode: MapExternalsRfNode | null =
      withExternals && externalsAll.length > 0
        ? {
            id: "externals",
            type: "mapExternals",
            position: { x: 0, y: 0 },
            data: {
              externals: externalsShown,
              more: externalsAll.length - externalsShown.length,
              dimmed: false,
            },
            width: SYS_CARD_W,
            height: externalsH,
            draggable: false,
            selectable: false,
          }
        : null;
    if (externalsNode) {
      items.push({
        id: externalsNode.id,
        w: SYS_CARD_W,
        h: externalsNode.height ?? COMPACT_H,
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
      bandOfNode.set(card.id, band);
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
  const bases: MapEdgeBase[] = [];
  for (const e of skeletons) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    // Screen/frontend API traffic and downward cross-band links flow
    // bottom → top; same-band and upward links keep the side handles.
    const sourceBand = MAP_BANDS.indexOf(bandOfNode.get(e.source) ?? "backend");
    const targetBand = MAP_BANDS.indexOf(bandOfNode.get(e.target) ?? "backend");
    const vertical = e.kind !== "link" || targetBand > sourceBand;
    const width =
      e.kind === "link" && !e.apiOnly
        ? 1 + 2 * Math.sqrt(e.weight / maxLinkWeight)
        : 1 + Math.min(1.5, Math.sqrt(e.weight / maxCallCount));
    // Plain import links recede with their weight so API traffic and the
    // heavy structural spines carry the eye on busy workspaces.
    const restingOpacity =
      e.kind === "link" && !e.apiOnly
        ? 0.35 + 0.65 * Math.sqrt(e.weight / maxLinkWeight)
        : 1;
    bases.push({
      kind: e.kind,
      source: e.source,
      target: e.target,
      epKeys: e.epKeys,
      apiOnly: e.apiOnly,
      restingOpacity,
      edge: {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: vertical ? "b" : "r",
        targetHandle: vertical ? "t" : "l",
        label: e.label,
        data: { kind: e.kind } satisfies MapEdgeData,
        animated: e.apiOnly && e.kind !== "call",
        zIndex: 1,
        labelStyle: {
          fontSize: 9,
          fill: e.apiOnly ? "var(--color-accent-amber)" : "var(--color-ink-faint)",
        },
        labelBgStyle: { fill: "var(--color-surface-0)", fillOpacity: 0.8 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: {
          stroke: e.apiOnly ? "var(--color-accent-amber)" : "var(--color-edge-strong)",
          strokeWidth: width,
          strokeDasharray: e.apiOnly ? "4 3" : undefined,
          opacity: restingOpacity,
        },
      },
    });
  }

  return {
    nodes,
    bases,
    empty: false,
    fixturesHidden,
    quietHidden,
    stats,
    ctx: {
      screens,
      systems,
      screenIds,
      screensBySystem,
      screenOwner,
      feNodeIds,
      adjacency,
      calls,
      externalsAll,
    },
  };
}

/**
 * The cheap per-interaction phase: resolve the deep-linked selection, walk the
 * bright set, apply find matching, and patch node/edge flags onto the laid-out
 * scene. Untouched nodes and edges keep their object identity so react-flow
 * reconciles only what actually changed.
 */
export function decorateSystemMapScene(
  layout: SystemMapLayout,
  opts: { selected: string | null; find: string; marks?: SystemMapMarks | null },
): SystemMapScene {
  const { nodes, bases, empty, fixturesHidden, quietHidden, stats, ctx } = layout;
  const { screens, systems, screenIds, screensBySystem, screenOwner, feNodeIds, adjacency, calls } =
    ctx;

  /* ---- selection resolution (stale ids resolve to nothing) ---- */
  const sel = opts.selected && opts.selected.trim().length > 0 ? opts.selected : null;
  const selEp = sel?.startsWith("ep:") ? sel.slice(3) : null;
  const knownIds = new Set<string>([
    ...screens.map((s) => screenNodeId(s.id)),
    ...systems.map((s) => s.id),
  ]);
  const selNodeId = !selEp && sel && knownIds.has(sel) ? sel : null;
  const epOwner = selEp
    ? (systems.find((s) => s.endpoints.some((e) => epKeyOf(e) === selEp)) ?? null)
    : null;
  const selection: SystemMapSelection | null = selNodeId?.startsWith("screen:")
    ? { kind: "screen", screen: screens.find((s) => screenNodeId(s.id) === selNodeId)! }
    : selNodeId
      ? { kind: "system", system: systems.find((s) => s.id === selNodeId)! }
      : selEp && epOwner
        ? { kind: "endpoint", epKey: selEp, owner: epOwner }
        : null;

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
  const q = opts.find.trim().toLowerCase();
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
    !q || ctx.externalsAll.some((x) => x.name.toLowerCase().includes(q));
  const dimmedOf = (id: string, matches: boolean): boolean =>
    (q.length > 0 && !matches) || (selectionActive && !bright.has(id));

  const marks = opts.marks ?? null;

  // At rest the laid-out scene is already correct — reuse it wholesale.
  // (A ref review re-decorates everything: marks touch nodes and edges.)
  if (!selectionActive && q.length === 0 && !marks) {
    return { nodes, edges: bases.map((b) => b.edge), empty, fixturesHidden, quietHidden, stats, selection };
  }

  /** This system card's endpoint-row marks, keyed by epKey. */
  const epMarksOf = (sysId: string): Readonly<Record<string, MapDiffMark>> | undefined => {
    if (!marks || marks.ep.size === 0) return undefined;
    const prefix = `${sysId}|`;
    let out: Record<string, MapDiffMark> | undefined;
    for (const [key, mark] of marks.ep) {
      if (!key.startsWith(prefix)) continue;
      (out ??= {})[key.slice(prefix.length)] = mark;
    }
    return out;
  };

  const decorated = nodes.map((n): SystemMapNode => {
    switch (n.type) {
      case "mapScreen": {
        const d = (n as MapScreenRfNode).data;
        return {
          ...(n as MapScreenRfNode),
          data: {
            ...d,
            selected: n.id === selNodeId,
            dimmed: dimmedOf(n.id, screenMatches(d.screen)),
            mark: marks?.node.get(n.id),
          },
        };
      }
      case "mapFeGroup": {
        const d = (n as MapFeGroupRfNode).data;
        return {
          ...(n as MapFeGroupRfNode),
          data: {
            ...d,
            selected: n.id === selNodeId,
            dimmed: dimmedOf(n.id, sysMatches(d.system)),
            mark: marks?.node.get(n.id),
          },
        };
      }
      case "mapSystem": {
        const d = (n as MapSystemRfNode).data;
        const epHere = selEp != null && epOwner?.id === n.id;
        return {
          ...(n as MapSystemRfNode),
          data: {
            ...d,
            selected: n.id === selNodeId || epHere,
            dimmed: dimmedOf(n.id, sysMatches(d.system)),
            selectedEndpoint: epHere ? selEp : null,
            mark: marks?.node.get(n.id),
            epMarks: epMarksOf(n.id),
          },
        };
      }
      case "mapExternals": {
        const d = (n as MapExternalsRfNode).data;
        return {
          ...(n as MapExternalsRfNode),
          data: { ...d, dimmed: dimmedOf("externals", externalsMatch()) },
        };
      }
      default:
        return n;
    }
  });

  const edges = bases.map((b): RfEdge => {
    const active = selNodeId
      ? b.source === selNodeId || b.target === selNodeId
      : selEp
        ? b.kind === "call" && b.epKeys.includes(selEp)
        : false;
    const faded = selectionActive && !active;
    const mark = marks?.edge.get(b.edge.id);
    const markColor =
      mark === "added"
        ? "var(--color-ok)"
        : mark === "removed"
          ? "var(--color-danger)"
          : mark === "modified"
            ? "var(--color-warn)"
            : null;
    if (!active && !faded && !markColor) return b.edge;
    return {
      ...b.edge,
      animated: b.apiOnly && b.kind !== "call" && !faded && !markColor,
      labelStyle: markColor ? { ...b.edge.labelStyle, fill: markColor } : b.edge.labelStyle,
      style: {
        ...b.edge.style,
        stroke:
          markColor ??
          (b.apiOnly
            ? "var(--color-accent-amber)"
            : active
              ? "var(--color-accent-violet)"
              : "var(--color-edge-strong)"),
        strokeDasharray: mark === "removed" ? "5 4" : b.edge.style?.strokeDasharray,
        // Marked edges stay readable even outside the selection's bright set.
        opacity: faded ? (markColor ? 0.45 : 0.08) : b.restingOpacity,
      },
    };
  });

  return { nodes: decorated, edges, empty, fixturesHidden, quietHidden, stats, selection };
}

/**
 * Deep links — every Crystal view is addressable as a URL hash so users can
 * share exactly what they're looking at and drive back/forward navigation.
 *
 * Shape: `#/<mode>[/<subview>]?<params>`, e.g.
 *   #/architect/architecture?ws=1a2b3c&system=sys%3Aauth&insights=1
 *   #/architect/codebase?ws=1a2b3c&at=module&path=packages/core&dups=1
 *   #/threads?ws=1a2b3c&thread=r-42
 *   #/code?ws=1a2b3c&file=packages/core/src/bridge.ts
 *
 * The URL encodes the *current* view only; the client nav store keeps every
 * mode's state so switching back restores it. Pure TS — parse/format are the
 * single source of truth for the format, used by both the SDK shell (URL
 * sync) and anything that wants to mint a link.
 */

import { C4_LEVELS, type C4Level } from "./c4.js";
import { CODE_LOD_LEVELS, type CodeLodLevel } from "./codemap.js";
import type { QualityViewId } from "./quality.js";
import type { SurfaceViewId } from "./surfaces.js";

/**
 * The fleet client's id for the bootstrapped connection (page-origin bridge /
 * desktop sidecar). Deep links never spell it out: a bare workspace id always
 * means "on the default server", which is what keeps every pre-fleet URL valid.
 */
export const DEFAULT_SERVER_SID = "default";

/**
 * A parsed `ws` deep-link param: which server (`sid`, the fleet client's
 * *stable connection id*, not the per-boot serverId) and which workspace.
 */
export interface WsRef {
  sid: string;
  ws: string;
}

/**
 * Parse a `ws` param. Bare workspace ids (every URL minted before the fleet
 * layer, and every URL pointing at the default server) resolve to the default
 * sid; `sid:wsId` targets an added server. Workspace ids are hex hashes and
 * sids are `default`/hex-derived, so the first `:` is an unambiguous split.
 */
export function parseWsRef(ref: string): WsRef {
  const idx = ref.indexOf(":");
  if (idx <= 0) return { sid: DEFAULT_SERVER_SID, ws: idx === 0 ? ref.slice(1) : ref };
  return { sid: ref.slice(0, idx), ws: ref.slice(idx + 1) };
}

/** Format a `ws` param; the default server stays bare (backward compatible). */
export function formatWsRef(sid: string | null | undefined, ws: string): string {
  return !sid || sid === DEFAULT_SERVER_SID ? ws : `${sid}:${ws}`;
}

export type CrystalModeId =
  | "projects"
  | "architect"
  | "threads"
  | "code"
  | "jobs"
  | "surfaces"
  | "quality";
/**
 * Architect subviews — the consolidated trio. The legacy ids (`systems`,
 * `diagrams`, `codemap`) are permanent parse aliases onto their successors,
 * never emitted.
 */
export type ArchitectViewId = "architecture" | "codebase" | "infra";

/** Mirrors the code map's drill levels (all workspaces → workspace → module → file). */
export type CodeMapLevelLink =
  | { kind: "all" }
  | { kind: "workspace"; ws: string }
  | { kind: "module"; ws: string; path: string }
  | { kind: "file"; ws: string; path: string };

export interface ArchitectLink {
  view?: ArchitectViewId;
  /**
   * Focus this system's node on the architecture canvas (e.g. "sys:auth") —
   * consumed once and settled into `sel`. Minted by surfaces/hub links.
   */
  system?: string;
  /** Selected architecture `.crystal` file path (diagrams + infra views). */
  diagram?: string;
  /** Active facet id — a named lens over the selected diagram. */
  facet?: string;
  /** Open draft plan `.crystal` file path. */
  draft?: string;
  /** Split-pane review of the open draft (diff against its base). */
  review?: boolean;
  /** Active journey id (dataflow lens). */
  journey?: string;
  /** Live code-map overlay toggle. */
  overlay?: boolean;
  /** Code map drill level. */
  codemap?: CodeMapLevelLink;
  /**
   * Code map level of detail — how much of the repositories → packages →
   * modules → members ladder is exposed globally (the LoD slider).
   */
  lod?: CodeLodLevel;
  /** Show connected modules/systems around the global lens (first-degree neighbors). */
  lensCtx?: boolean;
  /** Duplicates panel open. */
  duplicates?: boolean;
  /** Review-findings panel open (code map). */
  findings?: boolean;
  /** Working-set changes panel open (code map). */
  changes?: boolean;
  /** Facets panel open (architecture + codebase views). */
  facets?: boolean;
  /** Insights panel open (architecture view). */
  insights?: boolean;
  /** Contracts panel open (architecture view). */
  contracts?: boolean;
  /** Selected boundary edge on the architecture view ("source->target"). */
  edge?: string;
  /**
   * Architecture focus filter: comma-separated system ids. When set, the
   * canvas shows only these systems (plus their first-degree neighbors) and
   * animates the traffic between them.
   */
  focus?: string;
  /** Hide the focus filter's neighbor ring (neighbors show by default). */
  focusSolo?: boolean;
  /** Selected file card on the code map canvas. */
  file?: string;
  /**
   * Pinned cross-view highlight — a clicked component, encoded via
   * `formatHighlightSel` (highlight.ts) so the selection survives reloads
   * and travels in shared links. All architect subviews honor it.
   */
  sel?: string;
  /**
   * Global find query — one search shared by every architect subview
   * (systems, code diagrams, infrastructure); each view dims what misses.
   */
  find?: string;
  /**
   * Ref review — the git ref this view is being compared against ("vs
   * <ref>"). One shared mechanism across all architect subviews: the view
   * renders head state with added/removed/changed marks and ghosts.
   */
  vs?: string;
  /**
   * Architecture-view optional layers, comma-separated ("screens,endpoints").
   * Unset renders the module/system altitude only.
   */
  layers?: string;
  /**
   * C4 altitude of the architecture view (unset = "containers", the level
   * closest to the classic canvas and the C4 diagram most teams live on).
   */
  level?: C4Level;
  /** Scoped container id at the components level ("ctr:apps-server"). */
  scope?: string;
}

/**
 * The Threads mode — first-class agent chats. A thread is a resume chain
 * (manager turn + its resumed turns + nested workers), addressed by any run
 * id in the chain; the view resolves the id to its thread, which is what
 * keeps every old `?run=` link working.
 */
export interface ThreadsLink {
  /** Any run id in the target chain (unset = no thread selected). */
  thread?: string;
  /** Thread-rail text filter. */
  find?: string;
  /** New-thread composer open. */
  compose?: boolean;
}

export interface CodeLink {
  /** Active file path in the editor. */
  file?: string;
}

export interface SurfacesLink {
  view?: SurfaceViewId;
  /** Selected screen id (`ScreenSurface.id`). */
  screen?: string;
  /** Selected component, `${file}#${name}`. */
  component?: string;
  /** Selected story id (`StorySurface.id`). */
  story?: string;
  /** Selected endpoint in the APIs view, "METHOD /path". */
  api?: string;
  /** Focused system/project for the APIs or schemas view. */
  system?: string;
  /** Selected schema id (`SchemaSurface.id`). */
  schema?: string;
  /** Selected saved request in the API surface view. */
  request?: string;
  /** Live demo pane open (screens + stories views). */
  demo?: boolean;
  /**
   * Architecture side pane open — the canonical architecture canvas embedded
   * so every surfaces subview can highlight into it (callers, callees,
   * integrations). Selection inside the pane rides the `architect` section,
   * so expanding to the full architecture view keeps it.
   */
  arch?: boolean;
  /** Find query shared by every surfaces subview. */
  find?: string;
}

export interface QualityLink {
  view?: QualityViewId;
  /** Selected test file (tests view). */
  file?: string;
  /** Selected test full name within `file`. */
  test?: string;
  /** Selected run id (tests view; latest when unset). */
  run?: string;
  /** Selected path in the coverage tree — a directory or file. */
  covPath?: string;
  /** Find query shared by both quality subviews. */
  find?: string;
}

/** Overview subviews: the dashboard, the coordinator chat, the questions inbox. */
export type OverviewViewId = "dashboard" | "chat" | "inbox";

/**
 * The Overview — cross-workspace dashboard plus the absorbed hub surfaces
 * (coordinator chat, questions inbox). Unlike every other section this one is
 * *not* scoped to `ws`: programs span workspaces, so its links stay valid
 * whichever workspace is active (`ws` still rides along, marking where to
 * return when the user leaves the Overview).
 */
export interface ProjectsLink {
  view?: OverviewViewId;
  /** Selected program id (coordinator chat). */
  program?: string;
  /** Selected program-manager turn (coordinator chat; unset follows latest). */
  turn?: string;
  /** Find query (inbox). */
  find?: string;
}

export interface DeepLink {
  /**
   * Active workspace ref: a bare workspace id (`workspaceIdFor(root)` — stable
   * across restarts) on the default server, or `sid:wsId` for a workspace on
   * an added bridge connection. See `parseWsRef`/`formatWsRef`.
   */
  ws?: string;
  /**
   * Active global lens (see lens.ts): dimensional tags ("intent:auth,sys:forms"),
   * a saved workspace facet ("facet:<id>") or a review diff ("diff:worktree",
   * "diff:base", "diff:ref:<ref>"). Top-level like `ws` — every mode renders
   * through it, so it survives mode switches and rides shared links.
   */
  lens?: string;
  mode?: CrystalModeId;
  projects?: ProjectsLink;
  architect?: ArchitectLink;
  threads?: ThreadsLink;
  code?: CodeLink;
  surfaces?: SurfacesLink;
  quality?: QualityLink;
}

// encodeURIComponent, but keep `/` and `,` readable — file/module paths and
// comma-separated lists (lens tags, focus ids) dominate these URLs and
// %2F/%2C soup makes links hostile to eyeball and diff.
function enc(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/").replace(/%2C/gi, ",");
}

/**
 * Serialize to a `#/...` hash. Emits only the active mode's params so shared
 * links stay focused; returns "" when there is no mode to point at. Output is
 * canonical (fixed param order) so string equality doubles as link equality.
 */
export function formatDeepLink(link: DeepLink): string {
  const mode = link.mode;
  if (!mode) return "";
  const pairs: string[] = [];
  const add = (key: string, value: string) => pairs.push(`${key}=${enc(value)}`);
  if (link.ws) add("ws", link.ws);
  if (link.lens) add("lens", link.lens);

  let path = `/${mode}`;
  if (mode === "architect") {
    const a = link.architect ?? {};
    // Default view — must match what ArchitectMode renders when unset, or a
    // back-navigation onto this URL lands on a different screen.
    const view = a.view ?? "architecture";
    path += `/${view}`;
    if (view === "architecture") {
      // Default must match what DiagramsView renders when unset ("containers").
      if (a.level && a.level !== "containers") add("level", a.level);
      if (a.level === "components" && a.scope) add("scope", a.scope);
      if (a.system) add("system", a.system);
      if (link.lens && a.lensCtx) add("lensctx", "1");
      if (a.edge) add("edge", a.edge);
      if (a.focus) add("focus", a.focus);
      if (a.focus && a.focusSolo) add("solo", "1");
      if (a.insights) add("insights", "1");
      if (a.contracts) add("contracts", "1");
      if (a.facets) add("facets", "1");
      if (a.layers) add("layers", a.layers);
      if (a.facet) add("facet", a.facet);
      if (a.draft) add("draft", a.draft);
      if (a.draft && a.review) add("review", "1");
      if (a.journey) add("journey", a.journey);
      if (a.overlay) add("overlay", "1");
      if (a.duplicates) add("dups", "1");
      if (a.findings) add("findings", "1");
      if (a.changes) add("changes", "1");
    } else if (view === "codebase") {
      const cm = a.codemap;
      if (cm) {
        add("at", cm.kind);
        if (cm.kind !== "all") {
          // `link.ws` may be a `sid:wsId` ref; the code map's ws is always a
          // bare workspace id (of the active server), so compare bare-to-bare.
          if (cm.ws !== (link.ws ? parseWsRef(link.ws).ws : undefined)) add("mws", cm.ws);
          if (cm.kind === "module" || cm.kind === "file") add("path", cm.path);
        }
      }
      if (a.lod) add("lod", a.lod);
      if (link.lens && a.lensCtx) add("lensctx", "1");
      if (a.duplicates) add("dups", "1");
      if (a.findings) add("findings", "1");
      if (a.changes) add("changes", "1");
      if (a.facets) add("facets", "1");
      if (a.file) add("file", a.file);
    } else {
      // infra
      if (a.facet) add("facet", a.facet);
      if (a.draft) add("draft", a.draft);
      if (a.draft && a.review) add("review", "1");
      if (a.journey) add("journey", a.journey);
      if (a.overlay) add("overlay", "1");
    }
    if (a.sel) add("sel", a.sel);
    if (a.find) add("find", a.find);
    if (a.vs) add("vs", a.vs);
  } else if (mode === "threads") {
    const t = link.threads ?? {};
    if (t.thread) add("thread", t.thread);
    if (t.find) add("find", t.find);
    if (t.compose) add("compose", "1");
  } else if (mode === "code") {
    if (link.code?.file) add("file", link.code.file);
  } else if (mode === "surfaces") {
    const s = link.surfaces ?? {};
    // Default must match what SurfacesMode renders when unset ("screens" —
    // the system map moved into the architecture view).
    const view = s.view ?? "screens";
    path += `/${view}`;
    if (view === "screens") {
      if (s.screen) add("screen", s.screen);
      if (s.demo) add("demo", "1");
    } else if (view === "components") {
      if (s.component) add("component", s.component);
    } else if (view === "stories") {
      if (s.story) add("story", s.story);
      if (s.demo) add("demo", "1");
    } else if (view === "apis") {
      if (s.system) add("system", s.system);
      if (s.api) add("api", s.api);
      if (s.request) add("request", s.request);
    } else if (view === "schemas") {
      if (s.system) add("system", s.system);
      if (s.schema) add("schema", s.schema);
    }
    if (s.arch) add("arch", "1");
    if (s.find) add("find", s.find);
  } else if (mode === "quality") {
    const q = link.quality ?? {};
    const view = q.view ?? "tests";
    path += `/${view}`;
    if (view === "tests") {
      if (q.file) add("file", q.file);
      if (q.test) add("test", q.test);
      if (q.run) add("run", q.run);
    } else {
      if (q.covPath) add("path", q.covPath);
    }
    if (q.find) add("find", q.find);
  } else if (mode === "projects") {
    const p = link.projects ?? {};
    const view = p.view ?? "dashboard";
    if (view !== "dashboard") path += `/${view}`;
    if (view === "chat" && p.program) add("program", p.program);
    if (view === "chat" && p.turn) add("turn", p.turn);
    if (p.find) add("find", p.find);
  }
  // "jobs" (agent job hub) is stateless — nothing to encode beyond ws.

  return `#${path}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

/**
 * Intuitive names people type or guess map onto the real mode ids (and a
 * subview when the name implies one), so a hand-edited hash lands somewhere
 * sensible instead of silently no-opping.
 */
const MODE_ALIASES: Record<string, [CrystalModeId, string?]> = {
  overview: ["projects"],
  // The hub merged into the Overview: programs became the coordinator chat,
  // questions the inbox. Old hub links are permanent parse aliases.
  hub: ["projects", "chat"],
  programs: ["projects", "chat"],
  portfolio: ["projects", "chat"],
  inbox: ["projects", "inbox"],
  questions: ["projects", "inbox"],
  // The Orchestrate tabs people bookmarked or type from muscle memory.
  sessions: ["threads"],
  runs: ["threads"],
  chats: ["threads"],
  editor: ["code"],
  arch: ["architect"],
  architecture: ["architect"],
  tests: ["quality", "tests"],
  coverage: ["quality", "coverage"],
  api: ["surfaces", "apis"],
  apis: ["surfaces", "apis"],
  screens: ["surfaces", "screens"],
};

/** Parse a location hash (with or without leading `#`). Unknown or malformed input yields {}. */
export function parseDeepLink(hash: string): DeepLink {
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (s.startsWith("/")) s = s.slice(1);
  const qIdx = s.indexOf("?");
  const segments = (qIdx === -1 ? s : s.slice(0, qIdx)).split("/").filter(Boolean);
  const params = new URLSearchParams(qIdx === -1 ? "" : s.slice(qIdx + 1));

  const link: DeepLink = {};
  const ws = params.get("ws");
  if (ws) link.ws = ws;
  // Top-level global lens. Old architect URLs carried `lens=` as a view-local
  // param with the same tag grammar — they parse into the same lens here.
  const globalLens = params.get("lens");
  if (globalLens) link.lens = globalLens;

  const aliased = MODE_ALIASES[segments[0] ?? ""];
  if (aliased) {
    segments[0] = aliased[0];
    if (aliased[1] && !segments[1]) segments[1] = aliased[1];
  }
  const mode = segments[0];
  // The API explorer moved from architecture to surfaces — old links redirect.
  if (mode === "architect" && segments[1] === "apis") {
    link.mode = "surfaces";
    const s: SurfacesLink = { view: "apis" };
    const api = params.get("api");
    if (api) s.api = api;
    const system = params.get("system");
    if (system) s.system = system;
    const find = params.get("find");
    if (find) s.find = find;
    link.surfaces = s;
    return link;
  }
  if (mode === "architect") {
    link.mode = "architect";
    const a: ArchitectLink = {};
    const view = segments[1];
    if (view === "architecture" || view === "codebase" || view === "infra") a.view = view;
    // Permanent aliases: the code map became the codebase view; the systems
    // overview and the editable diagrams canvas both unified into the
    // architecture view.
    else if (view === "codemap") a.view = "codebase";
    else if (view === "diagrams" || view === "systems") a.view = "architecture";
    const level = params.get("level");
    if (level && (C4_LEVELS as readonly string[]).includes(level)) a.level = level as C4Level;
    const scope = params.get("scope");
    if (scope) a.scope = scope;
    const system = params.get("system");
    if (system) a.system = system;
    const diagram = params.get("diagram");
    if (diagram) a.diagram = diagram;
    const facet = params.get("facet");
    if (facet) a.facet = facet;
    const draft = params.get("draft");
    if (draft) a.draft = draft;
    if (draft && params.get("review") === "1") a.review = true;
    const journey = params.get("journey");
    if (journey) a.journey = journey;
    if (params.get("overlay") === "1") a.overlay = true;
    if (params.get("dups") === "1") a.duplicates = true;
    if (params.get("findings") === "1") a.findings = true;
    if (params.get("changes") === "1") a.changes = true;
    if (params.get("facets") === "1") a.facets = true;
    if (params.get("insights") === "1") a.insights = true;
    if (params.get("contracts") === "1") a.contracts = true;
    const edge = params.get("edge");
    if (edge) a.edge = edge;
    const focus = params.get("focus");
    if (focus) a.focus = focus;
    if (focus && params.get("solo") === "1") a.focusSolo = true;
    const file = params.get("file");
    if (file) a.file = file;
    const sel = params.get("sel");
    if (sel) a.sel = sel;
    const find = params.get("find");
    if (find) a.find = find;
    const at = params.get("at");
    // The `ws` param may carry a server prefix; codemap levels hold bare ids.
    const mws = params.get("mws") ?? (ws ? parseWsRef(ws).ws : null);
    const path = params.get("path");
    if (at === "all") a.codemap = { kind: "all" };
    else if (at === "workspace" && mws) a.codemap = { kind: "workspace", ws: mws };
    else if ((at === "module" || at === "file") && mws && path)
      a.codemap = { kind: at, ws: mws, path };
    const lod = params.get("lod");
    if (lod && (CODE_LOD_LEVELS as readonly string[]).includes(lod)) a.lod = lod as CodeLodLevel;
    if (params.get("lensctx") === "1") a.lensCtx = true;
    const vs = params.get("vs");
    if (vs) a.vs = vs;
    const layers = params.get("layers");
    if (layers) a.layers = layers;
    if (Object.keys(a).length) link.architect = a;
  } else if (mode === "orchestrate") {
    // The Orchestrate mode retired into Threads (permanent parse aliases).
    // Costs/insights tabs land on the Overview dashboard — FleetPulse is the
    // surviving spend surface; every run-carrying tab lands on its thread.
    const tab = segments[1];
    if (tab === "costs" || tab === "insights") {
      link.mode = "projects";
      return link;
    }
    link.mode = "threads";
    const t: ThreadsLink = {};
    const run = params.get("run");
    if (run) t.thread = run;
    if (Object.keys(t).length) link.threads = t;
  } else if (mode === "threads") {
    link.mode = "threads";
    const t: ThreadsLink = {};
    const thread = params.get("thread");
    if (thread) t.thread = thread;
    const find = params.get("find");
    if (find) t.find = find;
    if (params.get("compose") === "1") t.compose = true;
    if (Object.keys(t).length) link.threads = t;
  } else if (mode === "code") {
    link.mode = "code";
    const file = params.get("file");
    if (file) link.code = { file };
  } else if (mode === "surfaces" && segments[1] === "map") {
    // The system map moved into the architecture view — screens + flows land
    // there (same precedent as architect/apis → surfaces/apis). Endpoint
    // selections belong to the API explorer, which owns endpoint identity.
    const node = params.get("node");
    if (node?.startsWith("ep:")) {
      link.mode = "surfaces";
      link.surfaces = { view: "apis", api: node.slice(3) };
      return link;
    }
    link.mode = "architect";
    const a: ArchitectLink = { view: "architecture", layers: "screens" };
    if (node) a.sel = `node:${node}`;
    const find = params.get("find");
    if (find) a.find = find;
    link.architect = a;
    return link;
  } else if (mode === "surfaces") {
    link.mode = "surfaces";
    const s: SurfacesLink = {};
    const view = segments[1];
    if (view === "client") s.view = "apis";
    else if (
      view === "screens" ||
      view === "components" ||
      view === "stories" ||
      view === "apis" ||
      view === "schemas"
    )
      s.view = view;
    const screen = params.get("screen");
    if (screen) s.screen = screen;
    const component = params.get("component");
    if (component) s.component = component;
    const story = params.get("story");
    if (story) s.story = story;
    const api = params.get("api");
    if (api) s.api = api;
    const system = params.get("system");
    if (system) s.system = system;
    const schema = params.get("schema");
    if (schema) s.schema = schema;
    const request = params.get("request");
    if (request) s.request = request;
    if (params.get("demo") === "1") s.demo = true;
    if (params.get("arch") === "1") s.arch = true;
    const find = params.get("find");
    if (find) s.find = find;
    if (Object.keys(s).length) link.surfaces = s;
  } else if (mode === "quality") {
    link.mode = "quality";
    const q: QualityLink = {};
    const view = segments[1];
    if (view === "tests" || view === "coverage") q.view = view;
    const file = params.get("file");
    if (file) q.file = file;
    const test = params.get("test");
    if (test) q.test = test;
    const run = params.get("run");
    if (run) q.run = run;
    const covPath = params.get("path");
    if (covPath) q.covPath = covPath;
    const find = params.get("find");
    if (find) q.find = find;
    if (Object.keys(q).length) link.quality = q;
  } else if (mode === "projects") {
    link.mode = "projects";
    const p: ProjectsLink = {};
    const view = segments[1];
    if (view === "dashboard" || view === "chat" || view === "inbox") p.view = view;
    // Legacy hub subviews parse onto their Overview successors (the `hub`
    // segment itself is a MODE_ALIAS): programs → chat, questions → inbox,
    // the hub's projects portfolio → the dashboard.
    else if (view === "programs") p.view = "chat";
    else if (view === "questions") p.view = "inbox";
    const program = params.get("program");
    if (program) p.program = program;
    const turn = params.get("turn");
    if (p.view === "chat" && turn) p.turn = turn;
    const find = params.get("find");
    if (find) p.find = find;
    if (Object.keys(p).length) link.projects = p;
  } else if (mode === "jobs") {
    link.mode = "jobs";
  }
  return link;
}

/**
 * Which section fields each subview's URL can express — the mirror of the
 * `formatDeepLink` branches above. `applyDeepLink` replaces exactly these on
 * back/forward and leaves the rest of the section alone, so state the URL
 * never carried (another subview's drill level, selection, panels) survives
 * history navigation.
 */
const ARCHITECT_VIEW_FIELDS: Record<ArchitectViewId, readonly (keyof ArchitectLink)[]> = {
  architecture: ["view", "system", "diagram", "lensCtx", "edge", "focus", "focusSolo", "insights", "contracts", "facets", "facet", "draft", "review", "journey", "overlay", "layers", "duplicates", "findings", "changes", "sel", "find", "vs"],
  codebase: ["view", "codemap", "lod", "lensCtx", "duplicates", "findings", "changes", "facets", "file", "sel", "find", "vs"],
  infra: ["view", "diagram", "facet", "draft", "review", "journey", "overlay", "sel", "find", "vs"],
};

const SURFACES_VIEW_FIELDS: Record<SurfaceViewId, readonly (keyof SurfacesLink)[]> = {
  screens: ["view", "screen", "demo", "arch", "find"],
  components: ["view", "component", "arch", "find"],
  stories: ["view", "story", "demo", "arch", "find"],
  apis: ["view", "api", "request", "system", "arch", "find"],
  schemas: ["view", "schema", "system", "arch", "find"],
};

const QUALITY_VIEW_FIELDS: Record<QualityViewId, readonly (keyof QualityLink)[]> = {
  tests: ["view", "file", "test", "run", "find"],
  coverage: ["view", "covPath", "find"],
};

const PROJECTS_VIEW_FIELDS: Record<OverviewViewId, readonly (keyof ProjectsLink)[]> = {
  dashboard: ["view", "find"],
  chat: ["view", "program", "turn", "find"],
  inbox: ["view", "find"],
};

/** Replace the owned fields with the incoming section's; keep everything else. */
function replaceOwned<T extends object>(
  current: T | undefined,
  incoming: T | undefined,
  owned: readonly (keyof T)[],
): T | undefined {
  const merged = { ...(current ?? {}) } as T;
  for (const key of owned) delete merged[key];
  Object.assign(merged, incoming ?? {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge a parsed URL into the current link (the back/forward path). Mode and
 * ws win when present. The incoming mode's section replaces only the fields
 * its subview's URL actually encodes — a systems URL says nothing about the
 * code-map drill level, so popping back to it must not erase that state.
 * Absent owned fields clear (a bare `#/architect/systems` really means
 * "systems, nothing selected"); other modes' sections are untouched.
 */
export function applyDeepLink(current: DeepLink, next: DeepLink): DeepLink {
  const link: DeepLink = { ...current };
  if (next.ws) link.ws = next.ws;
  if (!next.mode) return link;
  link.mode = next.mode;
  // Every URL encodes the global lens when one is active, so on a real
  // navigation its absence genuinely means "no lens".
  if (next.lens) link.lens = next.lens;
  else delete link.lens;
  if (next.mode === "architect") {
    const view = next.architect?.view ?? "architecture";
    const merged = replaceOwned(current.architect, next.architect, ARCHITECT_VIEW_FIELDS[view]);
    if (merged) link.architect = merged;
    else delete link.architect;
  } else if (next.mode === "threads") {
    // The threads URL encodes the whole section, so it replaces wholesale.
    if (next.threads) link.threads = next.threads;
    else delete link.threads;
  } else if (next.mode === "code") {
    if (next.code) link.code = next.code;
    else delete link.code;
  } else if (next.mode === "surfaces") {
    const view = next.surfaces?.view ?? "screens";
    const merged = replaceOwned(current.surfaces, next.surfaces, SURFACES_VIEW_FIELDS[view]);
    if (merged) link.surfaces = merged;
    else delete link.surfaces;
  } else if (next.mode === "quality") {
    const view = next.quality?.view ?? "tests";
    const merged = replaceOwned(current.quality, next.quality, QUALITY_VIEW_FIELDS[view]);
    if (merged) link.quality = merged;
    else delete link.quality;
  } else if (next.mode === "projects") {
    const view = next.projects?.view ?? "dashboard";
    const merged = replaceOwned(current.projects, next.projects, PROJECTS_VIEW_FIELDS[view]);
    if (merged) link.projects = merged;
    else delete link.projects;
  }
  return link;
}

/**
 * The *place* a link points at, ignoring selections and panels: mode, subview,
 * and the drilled document (code-map level, diagram/draft, orchestrator
 * project, editor file). The URL sync pushes a history entry when this
 * changes and rewrites in place when it doesn't, so the back button walks
 * screens — not every click.
 */
export function deepLinkNavIdentity(link: DeepLink): string {
  const mode = link.mode;
  if (!mode) return "";
  if (mode === "architect") {
    const a = link.architect ?? {};
    const view = a.view ?? "architecture";
    if (view === "codebase") {
      const cm = a.codemap;
      const at = !cm
        ? ""
        : cm.kind === "all"
          ? "all"
          : cm.kind === "workspace"
            ? `workspace:${cm.ws}`
            : `${cm.kind}:${cm.ws}:${cm.path}`;
      return `architect/${view}/${at}`;
    }
    if (view === "infra") return `architect/${view}/${a.draft ?? ""}`;
    return `architect/architecture/${a.facet ?? ""}|${a.draft ?? ""}`;
  }
  if (mode === "threads") {
    // Each thread is a place of its own: back walks thread → thread, not
    // every selection click inside one.
    return `threads/${link.threads?.thread ?? ""}`;
  }
  if (mode === "code") return `code/${link.code?.file ?? ""}`;
  if (mode === "surfaces") return `surfaces/${link.surfaces?.view ?? "screens"}`;
  if (mode === "quality") return `quality/${link.quality?.view ?? "tests"}`;
  // Opening a program's chat is a place of its own — the back button should
  // walk dashboard → chat → program, not every click inside one. Only the
  // chat view owns `program`: reading it elsewhere (where it survives in the
  // store but never reaches the URL) made every keystroke in the find box
  // push a history entry.
  if (mode === "projects") {
    const p = link.projects ?? {};
    const view = p.view ?? "dashboard";
    return `projects/${view}/${view === "chat" ? (p.program ?? "") : ""}`;
  }
  return mode;
}

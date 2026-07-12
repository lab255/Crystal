/**
 * Deep links — every Crystal view is addressable as a URL hash so users can
 * share exactly what they're looking at and drive back/forward navigation.
 *
 * Shape: `#/<mode>[/<subview>]?<params>`, e.g.
 *   #/architect/diagrams?ws=1a2b3c&diagram=.crystal/architecture/api.crystal
 *   #/architect/codemap?ws=1a2b3c&at=module&path=packages/core&dups=1
 *   #/orchestrate/board?ws=1a2b3c&project=.crystal/projects/q3.crystal&task=t-42
 *   #/code?ws=1a2b3c&file=packages/core/src/bridge.ts
 *
 * The URL encodes the *current* view only; the client nav store keeps every
 * mode's state so switching back restores it. Pure TS — parse/format are the
 * single source of truth for the format, used by both the SDK shell (URL
 * sync) and anything that wants to mint a link.
 */

import { CODE_LOD_LEVELS, type CodeLodLevel } from "./codemap.js";

export type CrystalModeId = "projects" | "architect" | "orchestrate" | "code" | "jobs";
export type ArchitectViewId = "systems" | "diagrams" | "infra" | "codemap";
export type OrchestratorTabId = "board" | "runs" | "agents";

/** Mirrors the code map's drill levels (all workspaces → workspace → module → file). */
export type CodeMapLevelLink =
  | { kind: "all" }
  | { kind: "workspace"; ws: string }
  | { kind: "module"; ws: string; path: string }
  | { kind: "file"; ws: string; path: string };

export interface ArchitectLink {
  view?: ArchitectViewId;
  /** Selected logical system id on the systems overview (e.g. "sys:auth"). */
  system?: string;
  /** Systems overview grouping: module clusters (default) or layer bands. */
  sysGroup?: "modules" | "layers";
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
  /**
   * Active code-map facet lens: comma-separated dimensional tags (e.g.
   * "intent:auth") filtering the map down to the members that carry them.
   */
  lens?: string;
  /** Duplicates panel open. */
  duplicates?: boolean;
  /** Review-findings panel open (code map). */
  findings?: boolean;
  /**
   * Pinned cross-view highlight — a clicked component, encoded via
   * `formatHighlightSel` (highlight.ts) so the selection survives reloads
   * and travels in shared links. All architect subviews honor it.
   */
  sel?: string;
}

export interface OrchestrateLink {
  tab?: OrchestratorTabId;
  /** Selected project `.crystal` file path. */
  project?: string;
  /** Selected task id (board tab). */
  task?: string;
  /** Selected agent run id (runs tab). */
  run?: string;
  /** Board grouping: "status" (default), "epic", or "tag:<dimension>". */
  group?: string;
  /** Board sort key: "manual" (default), "priority", "size", "tokens" or "cost". */
  sort?: string;
}

export interface CodeLink {
  /** Active file path in the editor. */
  file?: string;
}

export interface DeepLink {
  /** Active workspace id (`workspaceIdFor(root)` — stable across restarts). */
  ws?: string;
  mode?: CrystalModeId;
  architect?: ArchitectLink;
  orchestrate?: OrchestrateLink;
  code?: CodeLink;
}

// encodeURIComponent, but keep `/` readable — file and module paths dominate
// these URLs and %2F soup makes links hostile to eyeball and diff.
function enc(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
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

  let path = `/${mode}`;
  if (mode === "architect") {
    const a = link.architect ?? {};
    const view = a.view ?? "diagrams";
    path += `/${view}`;
    if (view === "systems") {
      if (a.system) add("system", a.system);
      if (a.sysGroup) add("group", a.sysGroup);
      if (a.lens) add("lens", a.lens);
    } else if (view === "codemap") {
      const cm = a.codemap;
      if (cm) {
        add("at", cm.kind);
        if (cm.kind !== "all") {
          if (cm.ws !== link.ws) add("mws", cm.ws);
          if (cm.kind === "module" || cm.kind === "file") add("path", cm.path);
        }
      }
      if (a.lod) add("lod", a.lod);
      if (a.lens) add("lens", a.lens);
      if (a.duplicates) add("dups", "1");
      if (a.findings) add("findings", "1");
    } else {
      if (a.diagram) add("diagram", a.diagram);
      if (a.facet) add("facet", a.facet);
      if (a.draft) add("draft", a.draft);
      if (a.draft && a.review) add("review", "1");
      if (a.journey) add("journey", a.journey);
      if (a.overlay) add("overlay", "1");
    }
    if (a.sel) add("sel", a.sel);
  } else if (mode === "orchestrate") {
    const o = link.orchestrate ?? {};
    const tab = o.tab ?? "board";
    path += `/${tab}`;
    if (o.project) add("project", o.project);
    if (tab === "board" && o.task) add("task", o.task);
    if (tab === "board" && o.group) add("group", o.group);
    if (tab === "board" && o.sort) add("sort", o.sort);
    if ((tab === "runs" || tab === "agents") && o.run) add("run", o.run);
  } else if (mode === "code") {
    if (link.code?.file) add("file", link.code.file);
  }
  // "projects" (cross-workspace overview) and "jobs" (agent job hub) are
  // stateless — nothing to encode beyond ws.

  return `#${path}${pairs.length ? `?${pairs.join("&")}` : ""}`;
}

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

  const mode = segments[0];
  if (mode === "architect") {
    link.mode = "architect";
    const a: ArchitectLink = {};
    const view = segments[1];
    if (view === "systems" || view === "diagrams" || view === "infra" || view === "codemap")
      a.view = view;
    const system = params.get("system");
    if (system) a.system = system;
    const sysGroup = params.get("group");
    if (sysGroup === "modules" || sysGroup === "layers") a.sysGroup = sysGroup;
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
    const sel = params.get("sel");
    if (sel) a.sel = sel;
    const at = params.get("at");
    const mws = params.get("mws") ?? ws;
    const path = params.get("path");
    if (at === "all") a.codemap = { kind: "all" };
    else if (at === "workspace" && mws) a.codemap = { kind: "workspace", ws: mws };
    else if ((at === "module" || at === "file") && mws && path)
      a.codemap = { kind: at, ws: mws, path };
    const lod = params.get("lod");
    if (lod && (CODE_LOD_LEVELS as readonly string[]).includes(lod)) a.lod = lod as CodeLodLevel;
    const lens = params.get("lens");
    if (lens) a.lens = lens;
    if (Object.keys(a).length) link.architect = a;
  } else if (mode === "orchestrate") {
    link.mode = "orchestrate";
    const o: OrchestrateLink = {};
    const tab = segments[1];
    if (tab === "board" || tab === "runs" || tab === "agents") o.tab = tab;
    const project = params.get("project");
    if (project) o.project = project;
    const task = params.get("task");
    if (task) o.task = task;
    const group = params.get("group");
    if (group) o.group = group;
    const sort = params.get("sort");
    if (sort) o.sort = sort;
    const run = params.get("run");
    if (run) o.run = run;
    if (Object.keys(o).length) link.orchestrate = o;
  } else if (mode === "code") {
    link.mode = "code";
    const file = params.get("file");
    if (file) link.code = { file };
  } else if (mode === "projects") {
    link.mode = "projects";
  } else if (mode === "jobs") {
    link.mode = "jobs";
  }
  return link;
}

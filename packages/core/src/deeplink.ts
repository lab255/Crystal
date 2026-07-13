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
  /** Show connected modules/systems around the lens (first-degree neighbors). */
  lensCtx?: boolean;
  /** Duplicates panel open. */
  duplicates?: boolean;
  /** Review-findings panel open (code map). */
  findings?: boolean;
  /** Facets panel open (systems overview + code map). */
  facets?: boolean;
  /** Insights panel open (systems overview). */
  insights?: boolean;
  /** Contracts panel open (systems overview). */
  contracts?: boolean;
  /** Selected boundary edge on the systems overview ("source->target"). */
  edge?: string;
  /** Systems expanded in place into their components — comma-separated ids. */
  expanded?: string;
  /** Selected file card on the code map canvas. */
  file?: string;
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

// encodeURIComponent, but keep `/` and `,` readable — file/module paths and
// comma-separated lists (lens tags, expanded ids) dominate these URLs and
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

  let path = `/${mode}`;
  if (mode === "architect") {
    const a = link.architect ?? {};
    // Default view — must match what ArchitectMode renders when unset, or a
    // back-navigation onto this URL lands on a different screen.
    const view = a.view ?? "systems";
    path += `/${view}`;
    if (view === "systems") {
      if (a.system) add("system", a.system);
      if (a.sysGroup) add("group", a.sysGroup);
      if (a.lens) add("lens", a.lens);
      if (a.lens && a.lensCtx) add("lensctx", "1");
      if (a.edge) add("edge", a.edge);
      if (a.expanded) add("expand", a.expanded);
      if (a.insights) add("insights", "1");
      if (a.contracts) add("contracts", "1");
      if (a.facets) add("facets", "1");
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
      if (a.lens && a.lensCtx) add("lensctx", "1");
      if (a.duplicates) add("dups", "1");
      if (a.findings) add("findings", "1");
      if (a.facets) add("facets", "1");
      if (a.file) add("file", a.file);
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
    if (params.get("facets") === "1") a.facets = true;
    if (params.get("insights") === "1") a.insights = true;
    if (params.get("contracts") === "1") a.contracts = true;
    const edge = params.get("edge");
    if (edge) a.edge = edge;
    const expanded = params.get("expand");
    if (expanded) a.expanded = expanded;
    const file = params.get("file");
    if (file) a.file = file;
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
    if (params.get("lensctx") === "1") a.lensCtx = true;
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

/**
 * Which section fields each subview's URL can express — the mirror of the
 * `formatDeepLink` branches above. `applyDeepLink` replaces exactly these on
 * back/forward and leaves the rest of the section alone, so state the URL
 * never carried (another subview's drill level, selection, panels) survives
 * history navigation.
 */
const ARCHITECT_VIEW_FIELDS: Record<ArchitectViewId, readonly (keyof ArchitectLink)[]> = {
  systems: ["view", "system", "sysGroup", "lens", "lensCtx", "edge", "expanded", "insights", "contracts", "facets", "sel"],
  codemap: ["view", "codemap", "lod", "lens", "lensCtx", "duplicates", "findings", "facets", "file", "sel"],
  diagrams: ["view", "diagram", "facet", "draft", "review", "journey", "overlay", "sel"],
  infra: ["view", "diagram", "facet", "draft", "review", "journey", "overlay", "sel"],
};

const ORCHESTRATE_TAB_FIELDS: Record<OrchestratorTabId, readonly (keyof OrchestrateLink)[]> = {
  board: ["tab", "project", "task", "group", "sort"],
  runs: ["tab", "project", "run"],
  agents: ["tab", "project", "run"],
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
  if (next.mode === "architect") {
    const view = next.architect?.view ?? "systems";
    const merged = replaceOwned(current.architect, next.architect, ARCHITECT_VIEW_FIELDS[view]);
    if (merged) link.architect = merged;
    else delete link.architect;
  } else if (next.mode === "orchestrate") {
    const tab = next.orchestrate?.tab ?? "board";
    const merged = replaceOwned(current.orchestrate, next.orchestrate, ORCHESTRATE_TAB_FIELDS[tab]);
    if (merged) link.orchestrate = merged;
    else delete link.orchestrate;
  } else if (next.mode === "code") {
    if (next.code) link.code = next.code;
    else delete link.code;
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
    const view = a.view ?? "systems";
    if (view === "codemap") {
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
    if (view === "diagrams" || view === "infra")
      return `architect/${view}/${a.diagram ?? ""}|${a.draft ?? ""}`;
    return `architect/${view}`;
  }
  if (mode === "orchestrate") {
    const o = link.orchestrate ?? {};
    return `orchestrate/${o.tab ?? "board"}/${o.project ?? ""}`;
  }
  if (mode === "code") return `code/${link.code?.file ?? ""}`;
  return mode;
}

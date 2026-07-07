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

export type CrystalModeId = "architect" | "orchestrate" | "code";
export type ArchitectViewId = "diagrams" | "infra" | "codemap";
export type OrchestratorTabId = "board" | "runs";

/** Mirrors the code map's drill levels (all workspaces → workspace → module → file). */
export type CodeMapLevelLink =
  | { kind: "all" }
  | { kind: "workspace"; ws: string }
  | { kind: "module"; ws: string; path: string }
  | { kind: "file"; ws: string; path: string };

export interface ArchitectLink {
  view?: ArchitectViewId;
  /** Selected architecture `.crystal` file path (diagrams + infra views). */
  diagram?: string;
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
  /** Duplicates panel open. */
  duplicates?: boolean;
}

export interface OrchestrateLink {
  tab?: OrchestratorTabId;
  /** Selected project `.crystal` file path. */
  project?: string;
  /** Selected task id (board tab). */
  task?: string;
  /** Selected agent run id (runs tab). */
  run?: string;
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
    if (view === "codemap") {
      const cm = a.codemap;
      if (cm) {
        add("at", cm.kind);
        if (cm.kind !== "all") {
          if (cm.ws !== link.ws) add("mws", cm.ws);
          if (cm.kind === "module" || cm.kind === "file") add("path", cm.path);
        }
      }
      if (a.duplicates) add("dups", "1");
    } else {
      if (a.diagram) add("diagram", a.diagram);
      if (a.draft) add("draft", a.draft);
      if (a.draft && a.review) add("review", "1");
      if (a.journey) add("journey", a.journey);
      if (a.overlay) add("overlay", "1");
    }
  } else if (mode === "orchestrate") {
    const o = link.orchestrate ?? {};
    const tab = o.tab ?? "board";
    path += `/${tab}`;
    if (o.project) add("project", o.project);
    if (tab === "board" && o.task) add("task", o.task);
    if (tab === "runs" && o.run) add("run", o.run);
  } else {
    if (link.code?.file) add("file", link.code.file);
  }

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
    if (view === "diagrams" || view === "infra" || view === "codemap") a.view = view;
    const diagram = params.get("diagram");
    if (diagram) a.diagram = diagram;
    const draft = params.get("draft");
    if (draft) a.draft = draft;
    if (draft && params.get("review") === "1") a.review = true;
    const journey = params.get("journey");
    if (journey) a.journey = journey;
    if (params.get("overlay") === "1") a.overlay = true;
    if (params.get("dups") === "1") a.duplicates = true;
    const at = params.get("at");
    const mws = params.get("mws") ?? ws;
    const path = params.get("path");
    if (at === "all") a.codemap = { kind: "all" };
    else if (at === "workspace" && mws) a.codemap = { kind: "workspace", ws: mws };
    else if ((at === "module" || at === "file") && mws && path)
      a.codemap = { kind: at, ws: mws, path };
    if (Object.keys(a).length) link.architect = a;
  } else if (mode === "orchestrate") {
    link.mode = "orchestrate";
    const o: OrchestrateLink = {};
    const tab = segments[1];
    if (tab === "board" || tab === "runs") o.tab = tab;
    const project = params.get("project");
    if (project) o.project = project;
    const task = params.get("task");
    if (task) o.task = task;
    const run = params.get("run");
    if (run) o.run = run;
    if (Object.keys(o).length) link.orchestrate = o;
  } else if (mode === "code") {
    link.mode = "code";
    const file = params.get("file");
    if (file) link.code = { file };
  }
  return link;
}

import type { AgentRoster } from "./agent-profile.js";
import type { ArchDraft } from "./arch-draft.js";
import type { ArchitectureGraph } from "./architecture.js";
import type { AgentRole, AgentRun, RunEvent, RunPurpose, WorkerSpec } from "./agent.js";
import type { CodeIndex, FacetSuggestion } from "./code-index.js";
import type { ReviewFinding } from "./code-review.js";
import type {
  CodeFileDetail,
  CodeMapSummary,
  CodeModuleDetail,
  CodeSymbolSites,
  CodeSymbolSource,
  CodeTrace,
  CrossWorkspaceMap,
  DuplicateCluster,
  JourneySuggestion,
  PartCrossings,
  SymbolSearchHit,
} from "./codemap.js";
import type { Project } from "./project.js";
import type { CoverageReport, QualityRun, TestRunnerInfo } from "./quality.js";
import type { RefactorApplyResult, RefactorIntent, RefactorPlan } from "./refactor.js";
import type { SurfacesReport } from "./surfaces.js";
import type { SystemOverview } from "./system-overview.js";
import type { SystemOverviewDiff } from "./system-insights.js";
import type { SystemsLayout } from "./systems-layout.js";
import type { TerminalChunk, TerminalInfo } from "./terminal.js";
import type { TodoList } from "./todo.js";
import type { WorkspaceManifest } from "./workspace.js";

/**
 * Bridge protocol — the JSON message contract between a Crystal UI and a
 * platform host (the Node bridge server over WebSocket today; a Tauri
 * transport can implement the same contract).
 *
 * Requests:  { id, type: "req", method, params }
 * Responses: { id, type: "res", ok: true, result } | { id, type: "res", ok: false, error }
 * Events:    { type: "evt", event, payload }
 *
 * The server can host several workspaces at once. Workspace-scoped methods
 * accept an optional `ws` (workspace id from `workspaces.list`); omitting it
 * targets the server's default workspace. `BridgeClient.setScope` injects the
 * active workspace automatically, so call sites only pass `ws` explicitly
 * when reaching across workspaces.
 */

/** Optional workspace scope, present on every workspace-scoped method. */
export interface WsScope {
  ws?: string;
}

/** One open workspace on the bridge server. */
export interface WorkspaceDescriptor {
  /** Stable id derived from the canonical root path. */
  id: string;
  /** Absolute root path on the host. */
  root: string;
  /** Manifest name (falls back to the root directory name). */
  name: string;
}

/** A workspace that was open at some point — the reopen list. */
export interface RecentWorkspace {
  /** Canonical absolute root path on the host. */
  root: string;
  /** Name at the time it was last open. */
  name: string;
  /** ISO-8601 timestamp of the last open. */
  lastOpenedAt: string;
  /** The directory no longer exists on the host (cannot be reopened). */
  missing?: boolean;
}

/** One directory in a `workspaces.browse` listing. */
export interface BrowseEntry {
  name: string;
  /** Absolute host path. */
  path: string;
  /** What makes this directory workspace-shaped, if anything. */
  marker?: "crystal" | "repo" | "package";
}

export interface FileEntry {
  name: string;
  /** Workspace-relative path, always forward-slash separated. */
  path: string;
  kind: "file" | "dir";
  size?: number;
}

export interface GitFileStatus {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??". */
  code: string;
}

export interface GitStatusResult {
  repoPath: string;
  branch: string | null;
  files: GitFileStatus[];
}

/**
 * Which changed-file set a diff-scoped agent job runs on: "worktree" =
 * uncommitted changes (from `git status`); "base" = this branch's diff against
 * the main branch (merge-base). "full" (no diff) is expressed by not calling
 * `git.changedFiles` at all.
 */
export type ChangeScope = "worktree" | "base";

/** Everything a ref picker can offer (see `git.refs`). */
export interface GitRefsResult {
  /** Local branch names. */
  branches: string[];
  /** Remote-tracking branches in short form ("origin/main"), HEADs dropped. */
  remoteBranches: string[];
  tags: string[];
  /** Currently checked-out branch, null when detached. */
  current: string | null;
  /** Linked worktrees (the main worktree included), with their branch. */
  worktrees: { path: string; branch: string | null }[];
}

/** One commit from `git.log` — enough to pick a review point. */
export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  /** Branch/tag decorations pointing at this commit (e.g. "origin/main"). */
  refs: string[];
}

export interface WorkspaceInfo {
  /** Workspace id (matches `WorkspaceDescriptor.id`). */
  id: string;
  /** Absolute root path on the host. */
  root: string;
  manifest: WorkspaceManifest;
  architectures: { path: string; graph: ArchitectureGraph }[];
  /** Saved architecture drafts (`.crystal/architecture/drafts/`). */
  archDrafts: { path: string; draft: ArchDraft }[];
  projects: { path: string; project: Project }[];
}

/** Method name → { params, result }. The single source of truth for both sides. */
export interface BridgeMethods {
  "workspaces.list": {
    params: Record<string, never>;
    result: {
      workspaces: WorkspaceDescriptor[];
      defaultWs: string;
      /** Most-recently-opened first; includes currently-open workspaces. */
      recents: RecentWorkspace[];
    };
  };
  "workspaces.open": { params: { root: string }; result: { workspace: WorkspaceDescriptor } };
  "workspaces.close": { params: { ws: string }; result: { ok: true } };
  /**
   * List the sub-directories of an absolute host path (home dir when omitted) —
   * powers the open-workspace folder browser. Never fails on permission errors;
   * unreadable entries are simply absent.
   */
  "workspaces.browse": {
    params: { path?: string };
    result: { path: string; parent: string | null; entries: BrowseEntry[] };
  };
  "workspace.get": { params: WsScope; result: WorkspaceInfo };
  "workspace.saveManifest": {
    params: WsScope & { manifest: WorkspaceManifest };
    result: { ok: true };
  };
  "arch.save": { params: WsScope & { path: string; graph: ArchitectureGraph }; result: { ok: true } };
  "arch.create": { params: WsScope & { name: string }; result: { path: string; graph: ArchitectureGraph } };
  "arch.delete": { params: WsScope & { path: string }; result: { ok: true } };
  "archdraft.create": {
    params: WsScope & { draft: ArchDraft };
    result: { path: string; draft: ArchDraft };
  };
  "archdraft.save": { params: WsScope & { path: string; draft: ArchDraft }; result: { ok: true } };
  /**
   * Review a git ref (commit / branch / PR head) architecturally: snapshot the
   * module + import graph at the ref, project it onto the architecture, and
   * persist the result as a draft (base = current graph) for split-pane review.
   */
  "archdraft.fromRef": {
    params: WsScope & { archPath: string; ref: string; repoPath?: string };
    result: { path: string; draft: ArchDraft };
  };
  "archdraft.delete": { params: WsScope & { path: string }; result: { ok: true } };
  "project.save": { params: WsScope & { path: string; project: Project }; result: { ok: true } };
  "project.create": { params: WsScope & { name: string }; result: { path: string; project: Project } };
  /** The workspace's todo list (`.crystal/todos.json`; empty list if the file is absent). */
  "todos.get": { params: WsScope; result: { todos: TodoList } };
  "todos.save": { params: WsScope & { todos: TodoList }; result: { ok: true } };
  /** The agent roster (`.crystal/agents.json`; seeded defaults when absent). */
  "agents.get": { params: WsScope; result: { roster: AgentRoster } };
  "agents.save": { params: WsScope & { roster: AgentRoster }; result: { ok: true } };
  /**
   * Hand arrangement of the systems overview (`.crystal/systems-layout.json`).
   * `layout` is null until the user first edits the canvas — views auto-group
   * a fresh overview client-side (see systems-layout.ts).
   */
  "syslayout.get": { params: WsScope; result: { layout: SystemsLayout | null } };
  "syslayout.save": { params: WsScope & { layout: SystemsLayout }; result: { ok: true } };
  "fs.list": { params: WsScope & { path: string }; result: { entries: FileEntry[] } };
  "fs.read": { params: WsScope & { path: string }; result: { content: string; truncated: boolean } };
  "fs.write": { params: WsScope & { path: string; content: string }; result: { ok: true } };
  "fs.mkdir": { params: WsScope & { path: string }; result: { ok: true } };
  "fs.rename": { params: WsScope & { from: string; to: string }; result: { ok: true } };
  "fs.delete": { params: WsScope & { path: string }; result: { ok: true } };
  "git.status": { params: WsScope & { repoPath: string }; result: GitStatusResult };
  /** Recent commits of a repo (newest first) — the pick list for arch review. */
  "git.log": {
    params: WsScope & { repoPath?: string; limit?: number };
    result: { commits: GitCommit[]; branch: string | null };
  };
  /**
   * Changed files for a scope — feeds diff-scoped agent jobs (indexing,
   * survey) so they read only what changed. `base` is the resolved main ref
   * for the "base" scope (null when it couldn't be resolved).
   */
  "git.changedFiles": {
    params: WsScope & { repoPath?: string; scope: ChangeScope };
    result: { files: string[]; base: string | null };
  };
  /** Branches / tags / worktrees of a repo — powers ref pickers and the branch switcher. */
  "git.refs": { params: WsScope & { repoPath?: string }; result: GitRefsResult };
  /**
   * Switch the repo to a branch (or detach on a tag/commit). Fails — with
   * git's own message — when the working tree would conflict.
   */
  "git.checkout": {
    params: WsScope & { repoPath?: string; ref: string };
    result: { ok: true; branch: string | null };
  };
  "agent.start": {
    params: WsScope & {
      prompt: string;
      cwd?: string;
      taskId?: string | null;
      projectId?: string | null;
      repoId?: string | null;
      /** Resume a previous Claude Code session. */
      resumeSessionId?: string | null;
      /** "worktree" executes the run in a disposable git worktree. */
      isolation?: "none" | "worktree";
      /** Agent profile to dispatch to — the server resolves model + skills from the roster. */
      agentId?: string | null;
      /** Manager run that dispatched this worker (sets role to "worker"). */
      parentRunId?: string | null;
      /** Place in the manager/worker hierarchy (unset = standalone run). */
      role?: AgentRole | null;
      /** Attribution: why this run touches its task (implement, code-review, merge, …). */
      purpose?: RunPurpose | null;
      /** Dimensional tags stamped onto the run for attribution (see tags.ts). */
      tags?: string[];
    };
    result: { run: AgentRun };
  };
  /**
   * Spawn a worker run on behalf of a manager run, parented to it. The manager
   * itself calls this (via the MCP `dispatch_worker` tool, or the server acts
   * on a CRYSTAL_DISPATCH marker); a UI can also fan out under a manager. The
   * worker inherits the manager's cwd/repo/task unless the spec overrides them.
   * `run` is null when a guard rejects the dispatch (unknown/worker manager or
   * fan-out cap reached).
   */
  "agent.dispatchWorker": {
    params: WsScope & { managerRunId: string; spec: WorkerSpec };
    result: { run: AgentRun | null };
  };
  "agent.cancel": { params: WsScope & { runId: string }; result: { ok: true } };
  "agent.list": { params: WsScope; result: { runs: AgentRun[] } };
  "agent.events": { params: WsScope & { runId: string }; result: { events: RunEvent[] } };
  "agent.diff": {
    params: WsScope & { runId: string };
    result: { diff: string; stat: string; worktreePath: string | null };
  };
  "agent.cleanupWorktree": { params: WsScope & { runId: string }; result: { ok: true } };
  /** Spawn a PTY shell terminal in the workspace (cwd relative to the root). */
  "terminal.create": {
    params: WsScope & { cwd?: string; cols?: number; rows?: number };
    result: { terminal: TerminalInfo };
  };
  "terminal.list": { params: WsScope; result: { terminals: TerminalInfo[] } };
  /** Write raw bytes to the PTY (keystrokes, control chars like \x03, or whole lines ending in \r). */
  "terminal.input": { params: WsScope & { terminalId: string; data: string }; result: { ok: true } };
  /** Resize the PTY (last writer wins — the new size broadcasts via `terminal.changed`). */
  "terminal.resize": {
    params: WsScope & { terminalId: string; cols: number; rows: number };
    result: { ok: true };
  };
  /** Kill the terminal's process (if running) and drop it from the list. */
  "terminal.kill": { params: WsScope & { terminalId: string }; result: { ok: true } };
  /** Replay buffer of a terminal (capped) — catch up before listening to `terminal.data`. */
  "terminal.buffer": {
    params: WsScope & { terminalId: string };
    result: { chunks: TerminalChunk[] };
  };
  "codemap.get": { params: WsScope; result: CodeMapSummary };
  /**
   * `prefer`: workspace-relative files or directory prefixes that must survive
   * the module's file-list truncation — the active facet lens's membership.
   * Without it a drilled system whose files rank below the truncation cap
   * renders as an empty shell.
   */
  "codemap.module": {
    params: WsScope & { path: string; prefer?: string[] };
    result: CodeModuleDetail;
  };
  "codemap.file": { params: WsScope & { path: string }; result: CodeFileDetail };
  /**
   * Bulk expansion for the LoD slider: details of every listed module (all
   * modules when omitted) plus every file inside them, in one round-trip —
   * the member level would otherwise be hundreds of requests.
   */
  "codemap.details": {
    params: WsScope & { modules?: string[]; prefer?: string[] };
    result: { modules: CodeModuleDetail[]; files: CodeFileDetail[] };
  };
  /** Import/export graph across every open workspace. */
  "codemap.cross": { params: Record<string, never>; result: CrossWorkspaceMap };
  /**
   * The logical system overview: the codebase clustered into architecture
   * modules (authentication, submission, external integrations…) with the
   * exports each one serves, the systems and external services it consumes,
   * and weighted inter-system links (see system-overview.ts).
   */
  "codemap.overview": { params: WsScope; result: SystemOverview };
  /**
   * Systems-level ref review: the overview at a git ref (branch / commit / PR
   * head) diffed against the working tree — which systems appeared, which
   * links and external services changed. `repoPath` scopes to a nested repo.
   */
  "codemap.overviewDiff": {
    params: WsScope & { ref: string; repoPath?: string };
    result: {
      ref: string;
      commit: string;
      base: SystemOverview;
      head: SystemOverview;
      diff: SystemOverviewDiff;
    };
  };
  /** Source text of one top-level symbol (capped). */
  "codemap.symbolSource": {
    params: WsScope & { file: string; symbol: string };
    result: CodeSymbolSource;
  };
  /**
   * Everywhere one symbol crosses into consumers: the import statements that
   * bring it in (barrel re-exports followed) and the call sites invoking it,
   * each with its source line inline (capped).
   */
  "codemap.symbolSites": {
    params: WsScope & { file: string; symbol: string };
    result: CodeSymbolSites;
  };
  /**
   * The concrete integration points of one part-pair on a system boundary:
   * every import statement from files owned by `sourcePart` into files owned
   * by `targetPart`, with its source line inline (capped). `sourceParts` /
   * `targetParts` are the ownership universe — pass every system's part
   * paths so longest-prefix attribution matches the overview's (a file under
   * any nested part, even another system's, must not count as this part's).
   */
  "codemap.partCrossings": {
    params: WsScope & {
      sourcePart: string;
      targetPart: string;
      sourceParts?: string[];
      targetParts?: string[];
    };
    result: PartCrossings;
  };
  /** BFS call-graph trace from an entry symbol (syntax-resolved, capped). */
  "codemap.trace": {
    params: WsScope & { file: string; symbol: string; maxDepth?: number };
    result: CodeTrace;
  };
  /** Clusters of functions with identical normalized token streams. */
  "codemap.duplicates": {
    params: WsScope & { minTokens?: number };
    result: { clusters: DuplicateCluster[]; generatedAt: string };
  };
  /** Entry points whose call graphs span the most modules — suggested journeys. */
  "codemap.journeys": {
    params: WsScope & { limit?: number };
    result: { suggestions: JourneySuggestion[]; generatedAt: string };
  };
  /** Case-insensitive substring search over top-level symbol names. */
  "codemap.symbols": {
    params: WsScope & { query: string; limit?: number };
    result: { symbols: SymbolSearchHit[] };
  };
  /**
   * All call sites addressing a served route (the API explorer's callers
   * list) — method-compatible calls whose path the served path matches, or
   * suffix-matches through unseen router mounts.
   */
  "codemap.apiSites": {
    params: WsScope & { method: string; path: string };
    result: { sites: { file: string; line?: number; method: string; path: string }[] };
  };
  /**
   * The semantic code index: deterministic heuristic tags rebuilt live from
   * the code map, merged with agent enrichments from `.crystal/index/`.
   * `staleFiles` lists files no fresh enrichment covers (see code-index.ts).
   */
  "codeindex.get": {
    params: WsScope;
    result: { index: CodeIndex; staleFiles: string[] };
  };
  /**
   * Dispatch a small, cheap indexing agent over the stale files (or an
   * explicit list): it reads them and writes an enrichment file under
   * `.crystal/index/`; the index refreshes when the file lands. One call
   * dispatches one capped batch; `full` keeps dispatching follow-up batches
   * server-side until nothing dispatchable is stale. The result carries the
   * first run and `remaining`, the dispatchable stale files beyond its batch.
   */
  "codeindex.enrich": {
    params: WsScope & { files?: string[]; full?: boolean; agentId?: string | null };
    result: { run: AgentRun; files: string[]; remaining: number };
  };
  /** Facet suggestions for one architecture, derived from the code index. */
  "arch.suggestFacets": {
    params: WsScope & { path: string };
    result: { suggestions: FacetSuggestion[] };
  };
  /**
   * The deterministic review sweep: unused exports (barrel-aware), dead
   * files, duplicate implementations, boundary leaks, misplaced utilities.
   */
  "review.findings": {
    params: WsScope;
    result: { findings: ReviewFinding[]; generatedAt: string };
  };
  /**
   * The workspace's product surfaces: frontend screens/components/stories and
   * backend routes/schemas, derived from the code map's syntax analysis (see
   * surfaces.ts). Recomputed lazily; `codemap.changed` signals staleness.
   */
  "surfaces.get": { params: WsScope; result: SurfacesReport };
  /** How (and whether) this workspace can run tests — see quality.ts. */
  "quality.detect": { params: WsScope; result: TestRunnerInfo };
  /**
   * Start a test run (optionally scoped to a file / name filter, optionally
   * with coverage). One run at a time per workspace; starting while one is
   * live fails. Progress streams as `quality.runChanged` events.
   */
  "quality.run": {
    params: WsScope & { file?: string; testName?: string; coverage?: boolean };
    result: { run: QualityRun };
  };
  "quality.cancel": { params: WsScope & { runId: string }; result: { ok: true } };
  /** Recent runs, newest first (capped) — the live run included. */
  "quality.runs": { params: WsScope; result: { runs: QualityRun[] } };
  /**
   * The latest coverage report — parsed from the workspace's istanbul output
   * (`coverage/coverage-final.json`), whether Crystal or the user produced
   * it. Null until a coverage run (or an external one) exists.
   */
  "quality.coverage": { params: WsScope; result: { coverage: CoverageReport | null } };
  /** Dry-run of refactor intents — per-intent engine + change summaries. */
  "refactor.preview": {
    params: WsScope & { intents: RefactorIntent[] };
    result: { plans: RefactorPlan[] };
  };
  /** Execute mechanical move intents (hoists are rejected — they run via agent.start). */
  "refactor.apply": {
    params: WsScope & { intents: RefactorIntent[] };
    result: RefactorApplyResult;
  };
}

export type BridgeMethodName = keyof BridgeMethods;

/** Methods that ignore workspace scope (registry-level operations). */
export const UNSCOPED_METHODS: readonly BridgeMethodName[] = [
  "workspaces.list",
  "workspaces.open",
  "workspaces.close",
  "workspaces.browse",
  "codemap.cross",
];

export interface BridgeRequest<M extends BridgeMethodName = BridgeMethodName> {
  id: string;
  type: "req";
  method: M;
  params: BridgeMethods[M]["params"];
}

export type BridgeResponse<M extends BridgeMethodName = BridgeMethodName> =
  | { id: string; type: "res"; ok: true; result: BridgeMethods[M]["result"] }
  | { id: string; type: "res"; ok: false; error: { message: string; code?: string } };

/** Server → client push events. `ws` identifies the workspace they concern. */
export interface BridgeEvents {
  "agent.event": RunEvent;
  "agent.runChanged": { ws: string; run: AgentRun };
  "fs.changed": { ws: string; paths: string[] };
  "workspace.changed": { ws: string };
  /** A workspace's todo list was saved (payload carries the new list). */
  "todos.changed": { ws: string; todos: TodoList };
  /** A workspace's agent roster was saved (payload carries the new roster). */
  "agents.changed": { ws: string; roster: AgentRoster };
  /** Terminal output/echo chunk (sequenced per terminal). */
  "terminal.data": { ws: string; chunk: TerminalChunk };
  /** A terminal was created, resized, exited or killed. */
  "terminal.changed": { ws: string; terminal: TerminalInfo };
  /** The derived code map was re-analyzed after source changes. */
  "codemap.changed": { ws: string };
  /** The code index changed (code re-analyzed or an enrichment file landed). */
  "codeindex.changed": { ws: string };
  /** A test run started, streamed new results, or settled (payload = full run). */
  "quality.runChanged": { ws: string; run: QualityRun };
  /** New coverage data landed (a coverage run finished or external output changed). */
  "quality.coverageChanged": { ws: string };
  /** The set of open workspaces changed (opened/closed/renamed). */
  "workspaces.changed": Record<string, never>;
}

export type BridgeEventName = keyof BridgeEvents;

export interface BridgeEventMessage<E extends BridgeEventName = BridgeEventName> {
  type: "evt";
  event: E;
  payload: BridgeEvents[E];
}

export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEventMessage;

export const DEFAULT_BRIDGE_PORT = 4517;
export const BRIDGE_PATH = "/crystal";

/**
 * Bearer-token wiring for a remotely-exposed bridge. The token rides on the
 * console/ws URL as `?token=…` and, once the console page loads, is promoted
 * to an HttpOnly cookie so subsequent asset loads and the WS upgrade carry it
 * without leaking it in every URL. Both server and client import these so the
 * param/cookie names never drift.
 */
export const BRIDGE_TOKEN_PARAM = "token";
export const BRIDGE_TOKEN_COOKIE = "crystal_token";

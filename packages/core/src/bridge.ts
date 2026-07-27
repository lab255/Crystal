import type { AgentProfile, AgentProfileScope, AgentRoster } from "./agent-profile.js";
import type { ArchDraft } from "./arch-draft.js";
import type { ArchitectureGraph } from "./architecture.js";
import type { AgentRole, AgentRun, RunEvent, RunPurpose, WorkerSpec } from "./agent.js";
import type { CodeIndex, FacetSuggestion } from "./code-index.js";
import type { ReviewFinding } from "./code-review.js";
import type { WorkspaceFacet } from "./lens.js";
import type {
  ApiTrace,
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
  WorkingSetReport,
} from "./codemap.js";
import type { Project, TaskItem } from "./project.js";
import type { ClaimResult, TaskPatch } from "./orchestration.js";
import type { CoverageReport, QualityRun, TestRunnerInfo } from "./quality.js";
import type { RefactorApplyResult, RefactorIntent, RefactorPlan } from "./refactor.js";
import type { SurfaceMapReport, SurfacesRefBundle, SurfacesReport } from "./surfaces.js";
import type { SystemOverview } from "./system-overview.js";
import type { SystemOverviewDiff } from "./system-insights.js";
import type { SystemsLayout } from "./systems-layout.js";
import type { TerminalChunk, TerminalInfo } from "./terminal.js";
import type { TodoList } from "./todo.js";
import type { TemplateScope, Workflow, WorkflowSpend, WorkflowTemplate } from "./workflow.js";
import type {
  HubDispatchReport,
  HubProject,
  HubQuestion,
  HubRecentProject,
  Program,
  ProgramDelivery,
  ProgramSpend,
} from "./hub.js";
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
  /** False when `repoPath` is not inside a git repository (a state, not an error). */
  isRepo: boolean;
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
      /**
       * Identity of the answering server: `serverId` is minted per boot (the
       * fleet layer keys per-server state on it), `name` is human-readable
       * (hostname + primary root basename). Optional so responses from older
       * servers still typecheck.
       */
      server?: { serverId: string; name: string };
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
  /**
   * Claim an exclusive write lease on a task (the board's borrow checker —
   * one writer per task). Succeeds on unleased/stale tasks; passing the
   * current `claimId` heartbeats the lease instead.
   */
  "task.claim": {
    params: WsScope & {
      path: string;
      taskId: string;
      holder: string;
      holderRunId?: string | null;
      claimId?: string;
      ttlSeconds?: number;
    };
    result: ClaimResult;
  };
  "task.release": {
    params: WsScope & { path: string; taskId: string; claimId?: string | null; force?: boolean };
    result: { ok: true } | { ok: false; reason: string };
  };
  /** Lease-checked task mutation. `force` is the human owner's override. */
  /**
   * Answer a question an agent raised on a task: recorded on the board and
   * handed back to the run that asked, which resumes where it stopped
   * (queued if that run is still mid-turn). Uncontended — the asker is by
   * definition waiting — so it needs no claim.
   */
  "task.answer": {
    params: WsScope & { path: string; taskId: string; questionId: string; answer: string };
    result: { ok: true; resumedRunId: string | null } | { ok: false; reason: string };
  };
  "task.update": {
    params: WsScope & {
      path: string;
      taskId: string;
      patch: TaskPatch;
      claimId?: string | null;
      force?: boolean;
    };
    result: { ok: true; task: TaskItem } | { ok: false; reason: string };
  };
  /** The workspace's todo list (`.crystal/todos.json`; empty list if the file is absent). */
  "todos.get": { params: WsScope; result: { todos: TodoList } };
  "todos.save": { params: WsScope & { todos: TodoList }; result: { ok: true } };
  /**
   * Saved workspace facets (`.crystal/facets.json`; empty when absent) — the
   * named global lenses every mode can render through (see lens.ts).
   */
  "facets.get": { params: WsScope; result: { facets: WorkspaceFacet[] } };
  "facets.save": { params: WsScope & { facets: WorkspaceFacet[] }; result: { ok: true } };
  /**
   * The agent roster: the project's own profiles (`.crystal/agents.json`,
   * seeded defaults when absent) merged with the shared `~/.crystal/agents`
   * library — each profile carries its resolved `scope`, and a project
   * profile shadows a library one with the same id.
   */
  "agents.get": { params: WsScope; result: { roster: AgentRoster } };
  /**
   * Save roster-level fields (defaultAgentId, managerAgentId, defaultHuman)
   * and the *project* profiles. Library-scoped profiles in the payload are
   * ignored — echoing the merged view back must not copy the library into
   * the project file; use `agents.saveProfile` to edit those.
   */
  "agents.save": { params: WsScope & { roster: AgentRoster }; result: { ok: true } };
  /**
   * Create or update one profile. `scope` decides where it lands (default:
   * where it already lives, else project); saving with a different scope
   * *moves* it — one id must never live in both stores.
   */
  "agents.saveProfile": {
    params: WsScope & { profile: AgentProfile; scope?: AgentProfileScope };
    result: { profile: AgentProfile };
  };
  /** Delete a profile from whichever scope holds it (the default agent is refused). */
  "agents.removeProfile": { params: WsScope & { id: string }; result: { ok: true } };
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
    params: WsScope & {
      repoPath?: string;
      scope: ChangeScope;
      /** Diff the working tree against this ref instead (overrides `scope`) — diff lenses. */
      ref?: string;
      /**
       * The opposite direction (overrides both): committed changes the ref
       * itself introduced since it forked from HEAD (`git diff HEAD...ref`) —
       * what a workflow track branch would merge.
       */
      ofRef?: string;
    };
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
      /** Model override — an explicit model wins over the profile's. */
      model?: string | null;
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
  /**
   * Dispatch a run as a native *interactive* Claude session: a PTY terminal
   * (surfaced in the terminal panel) running the Claude TUI with the same
   * per-run MCP config a headless run would get, so board tools (my_task,
   * ask_question…) still work while the owner answers questions natively —
   * AskUserQuestion in the terminal, with ask_question logging each decision
   * on the board for a later answer if the owner steps away.
   */
  "agent.interactive": {
    params: WsScope & {
      prompt: string;
      cwd?: string;
      taskId?: string | null;
      projectId?: string | null;
      repoId?: string | null;
      /** Agent profile to dispatch to — the server resolves model + skills from the roster. */
      agentId?: string | null;
      /** Model override — an explicit model wins over the profile's. */
      model?: string | null;
      /** "manager" scopes the run's MCP endpoint to the board/dispatch toolset. */
      role?: AgentRole | null;
      purpose?: RunPurpose | null;
      tags?: string[];
      cols?: number;
      rows?: number;
    };
    result: { run: AgentRun; terminal: TerminalInfo };
  };
  /**
   * The generic steer: deliver `text` into the chain of any run, via the
   * same machinery worker results use — typed into a live interactive TUI,
   * resumed as a fresh turn when the chain is idle, queued (and flushed on
   * settlement) when a turn is live. Delivered verbatim — no manager-notice
   * framing (workflow.message / hub.message add that on their routes).
   */
  "agent.message": {
    params: WsScope & { runId: string; text: string };
    result: { queued: boolean };
  };
  "agent.cancel": { params: WsScope & { runId: string }; result: { ok: true } };
  "agent.list": { params: WsScope; result: { runs: AgentRun[] } };
  "agent.events": { params: WsScope & { runId: string }; result: { events: RunEvent[] } };
  "agent.diff": {
    params: WsScope & { runId: string };
    result: { diff: string; stat: string; worktreePath: string | null };
  };
  "agent.cleanupWorktree": { params: WsScope & { runId: string }; result: { ok: true } };
  /**
   * Land an isolated run's changes as a branch + commit (worktrees share
   * refs, so the branch is immediately mergeable from the repo). A detached
   * worktree moves onto `branch` (default `crystal/<runId>`); a track
   * worktree commits onto its own branch. The worktree survives for review.
   */
  "agent.applyWorktree": {
    params: WsScope & { runId: string; branch?: string | null; message?: string | null };
    result: { ok: true; branch: string; commit: string } | { ok: false; reason: string };
  };
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
  /**
   * Frontend→backend API trace: every outgoing HTTP call reachable from an
   * entry component/hook through the call graph (or the whole file when
   * `symbol` is omitted), matched to the served route registrations — the
   * component → hook → API call → endpoint chain.
   */
  "codemap.apiTrace": {
    params: WsScope & { file: string; symbol?: string; maxDepth?: number };
    result: ApiTrace;
  };
  /** Clusters of functions with identical normalized token streams. */
  "codemap.changes": {
    params: WsScope & { sinceHours?: number };
    result: WorkingSetReport;
  };
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
  /**
   * Per-screen API reachability for the system map — every screen's outgoing
   * HTTP calls matched to served routes (batched `codemap.apiTrace` over the
   * surfaces report's screens). Recomputed lazily with the code map.
   */
  "surfaces.map": { params: WsScope; result: SurfaceMapReport };
  /**
   * The product surfaces at a git ref (report + overview + screen→endpoint
   * calls), rebuilt from a snapshot of the ref's tree by the same analyzer
   * the live data uses. Powers the system map's ref review — the client
   * diffs the bundle against its live data. `repoPath` scopes to a nested
   * repo (same contract as `codemap.overviewDiff`).
   */
  "surfaces.atRef": {
    params: WsScope & { ref: string; repoPath?: string };
    result: SurfacesRefBundle;
  };
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
  /**
   * Start a multi-agent workflow: creates the durable workflow record and
   * spawns its manager — a long-lived, interactive Claude session (resume-
   * chained) that refines requirements, plans onto the board, dispatches
   * stage workers, and accounts cost against `budgetUsd`.
   */
  "workflow.start": {
    params: WsScope & {
      name: string;
      goal: string;
      /** Template id (defaults to "standard"). */
      templateId?: string;
      /**
       * A graph for this workflow only — "customise for this run" in the
       * start panel. Snapshotted into the record and never written to the
       * template library, so a one-off tweak cannot drift the template other
       * workflows start from. Wins over `templateId` when both are sent.
       */
      template?: WorkflowTemplate | null;
      projectId?: string | null;
      cwd?: string;
      /**
       * Host the manager as a native interactive Claude session in the
       * terminal panel (AskUserQuestion works; steering is typed in live)
       * instead of a headless run. The returned run carries `terminalId`.
       */
      interactive?: boolean;
      /** Agent profile for the manager (model + skills resolve server-side). */
      agentId?: string | null;
      /** Spend ceiling in USD; dispatches are refused once crossed. */
      budgetUsd?: number | null;
    };
    result: { workflow: Workflow; run: AgentRun };
  };
  "workflow.list": { params: WsScope; result: { workflows: Workflow[] } };
  "workflow.get": {
    params: WsScope & { workflowId: string };
    result: { workflow: Workflow; spend: WorkflowSpend };
  };
  /**
   * Remote control: deliver a user message into the manager's interactive
   * session. Delivered immediately as a resumed turn when the manager chain
   * is idle; queued and delivered on settlement when a turn is live. `run` is
   * the resumed manager run when delivery was immediate, null when queued.
   */
  "workflow.message": {
    params: WsScope & { workflowId: string; text: string };
    result: { run: AgentRun | null; queued: boolean };
  };
  /** Pause (hold new dispatches) or resume a workflow. */
  "workflow.setPaused": {
    params: WsScope & { workflowId: string; paused: boolean; reason?: string | null };
    result: { workflow: Workflow };
  };
  /** Raise/lower/clear the budget (auto-resumes a budget-exhausted pause when it now fits). */
  "workflow.setBudget": {
    params: WsScope & { workflowId: string; budgetUsd: number | null };
    result: { workflow: Workflow };
  };
  /** Cancel a workflow: kills its live runs and marks it cancelled. */
  "workflow.cancel": {
    params: WsScope & { workflowId: string };
    result: { workflow: Workflow };
  };
  /**
   * Every selectable template: built-ins first, then the shared global
   * library, then this project's own (see `TemplateScope`).
   */
  "workflow.templates": { params: WsScope; result: { templates: WorkflowTemplate[] } };
  /**
   * Create or update a custom template (visual builder). Validated
   * server-side (`validateWorkflowTemplate`); a blank id mints a fresh one;
   * built-in ids are refused — derive from them instead. Running workflows
   * are unaffected: each holds its own snapshot.
   */
  "workflow.saveTemplate": {
    params: WsScope & {
      template: WorkflowTemplate;
      /**
       * Where to store it, overriding the template's own scope. Passing a
       * different scope than it currently has *moves* it between the global
       * library and this project.
       */
      scope?: Exclude<TemplateScope, "builtin">;
    };
    result: { template: WorkflowTemplate };
  };
  /** Delete a custom template (built-ins are refused). */
  "workflow.deleteTemplate": {
    params: WsScope & { templateId: string };
    result: { ok: true };
  };
  /* ---------------- hub: cross-project programs ---------------- */

  /**
   * Every program the hub knows, newest first, with rolled-up spend. Registry
   * scoped — programs span workspaces, so this method carries no `ws`.
   */
  "hub.list": {
    params: Record<string, never>;
    result: { programs: Program[]; spend: Record<string, ProgramSpend> };
  };
  "hub.get": {
    params: { programId: string };
    result: { program: Program; spend: ProgramSpend };
  };
  /** Projects the hub can dispatch to: open workspaces + the reopen list. */
  "hub.projects": {
    params: Record<string, never>;
    result: { open: HubProject[]; recent: HubRecentProject[] };
  };
  "hub.createProgram": {
    params: { name: string; goal: string; budgetUsd?: number | null };
    result: { program: Program };
  };
  /** Add one project's share of a program (opens the project to resolve it). */
  "hub.addDelivery": {
    params: {
      programId: string;
      projectRoot: string;
      brief: string;
      dependsOn?: string[];
      templateId?: string | null;
      budgetUsd?: number | null;
    };
    result: { delivery: ProgramDelivery };
  };
  /** Drop a delivery that has not been dispatched and that nothing depends on. */
  "hub.removeDelivery": {
    params: { programId: string; deliveryId: string };
    result: { ok: true };
  };
  /**
   * Put a finished delivery back in the queue. Its previous attempt stays in
   * the project; this gives it a fresh workflow — the way out of a failed
   * delivery that would otherwise block its dependents forever.
   */
  "hub.retryDelivery": {
    params: { programId: string; deliveryId: string };
    result: { program: Program };
  };
  /**
   * Start every ready delivery (or just `deliveryIds`) as a workflow in its own
   * project — from here each project's orchestrator owns its development flow.
   */
  "hub.dispatch": {
    params: { programId: string; deliveryIds?: string[] };
    result: { report: HubDispatchReport };
  };
  /** One-shot: create a single-project program and dispatch it immediately. */
  "hub.dispatchEpic": {
    params: {
      projectRoot: string;
      name: string;
      goal: string;
      templateId?: string | null;
      budgetUsd?: number | null;
    };
    result: { program: Program; report: HubDispatchReport };
  };
  /** Steer one delivery's project orchestrator (queued when it is mid-turn). */
  "hub.messageDelivery": {
    params: { programId: string; deliveryId: string; text: string };
    result: { queued: boolean };
  };
  /** Hold or release a program — every live delivery workflow follows. */
  "hub.setPaused": {
    params: { programId: string; paused: boolean; reason?: string | null };
    result: { program: Program };
  };
  "hub.setBudget": {
    params: { programId: string; budgetUsd: number | null };
    result: { program: Program };
  };
  "hub.setDeliveryBudget": {
    params: { programId: string; deliveryId: string; budgetUsd: number | null };
    result: { program: Program };
  };
  "hub.cancel": { params: { programId: string }; result: { program: Program } };
  /**
   * Forget a finished program (terminal ones only). The project workflows it
   * dispatched — and their runs — stay where they ran; this drops the hub's
   * index of them.
   */
  "hub.remove": { params: { programId: string }; result: { ok: true } };
  /**
   * Spawn the program manager: an interactive session that owns the program
   * through the hub's MCP tools (splitting, dispatching, sequencing).
   */
  "hub.startManager": {
    params: {
      programId: string;
      model?: string | null;
      /**
       * Library agent profile the manager runs as (resolved against
       * `~/.crystal/agents` — the hub is cross-project, so workspace rosters
       * don't apply). An explicit `model` wins over the profile's.
       */
      agentId?: string | null;
      /**
       * Run the manager as a native interactive Claude session in a PTY
       * terminal hosted by workspace `ws` (the manager still coordinates via
       * the hub MCP endpoint; the terminal is just where it lives). Omit for
       * the classic headless resume-chained session.
       */
      terminal?: { ws: string; cols?: number; rows?: number } | null;
    };
    result: { program: Program; run: AgentRun };
  };
  /** Deliver an owner message into the program manager's session. */
  "hub.message": {
    params: { programId: string; text: string };
    result: { run: AgentRun | null; queued: boolean };
  };
  /**
   * Open questions across every live program, keyed by program id: a project
   * whose orchestrator stopped to ask something only a human (or the program
   * owner) can settle.
   */
  "hub.questions": {
    params: Record<string, never>;
    result: { questions: Record<string, HubQuestion[]> };
  };
  /**
   * Answer a question one of a program's projects raised: recorded on that
   * project's board and handed back to the run that asked, which resumes.
   */
  "hub.answerQuestion": {
    params: { programId: string; questionId: string; answer: string };
    result: { ok: true; resumedRunId: string | null } | { ok: false; reason: string };
  };
  /** The MCP endpoint a central agent points at to drive the hub. */
  "hub.endpoint": {
    params: Record<string, never>;
    result: { url: string; mcpConfig: string };
  };
  /** Program-manager runs (hub-scoped, so they are not in any workspace's list). */
  "hub.runs": { params: Record<string, never>; result: { runs: AgentRun[] } };
  "hub.runEvents": { params: { runId: string }; result: { events: RunEvent[] } };
  "hub.cancelRun": { params: { runId: string }; result: { ok: true } };

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
  // The hub sits above workspaces: its programs span them, so none of its
  // methods may have the active workspace injected.
  "hub.list",
  "hub.get",
  "hub.projects",
  "hub.createProgram",
  "hub.addDelivery",
  "hub.removeDelivery",
  "hub.retryDelivery",
  "hub.dispatch",
  "hub.dispatchEpic",
  "hub.messageDelivery",
  "hub.setPaused",
  "hub.setBudget",
  "hub.setDeliveryBudget",
  "hub.cancel",
  "hub.remove",
  "hub.questions",
  "hub.answerQuestion",
  "hub.startManager",
  "hub.message",
  "hub.endpoint",
  "hub.runs",
  "hub.runEvents",
  "hub.cancelRun",
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
  /** A workflow was created or changed (stage advanced, spend, pause, settle). */
  "workflow.changed": { ws: string; workflow: Workflow };
  /** The custom template set changed (saved or deleted in the builder). */
  "workflow.templatesChanged": { ws: string };
  /** The set of open workspaces changed (opened/closed/renamed). */
  "workspaces.changed": Record<string, never>;
  /**
   * A program was created or changed (delivery dispatched or settled, spend,
   * pause, completion). Hub events carry no `ws` — programs span workspaces.
   */
  "hub.changed": { program: Program };
  /** A program was forgotten (see `hub.remove`). */
  "hub.removed": { programId: string };
  /** A program's set of open project questions changed (raised or answered). */
  "hub.questionsChanged": { programId: string; questions: HubQuestion[] };
  /** A program-manager run changed (status, usage, result). */
  "hub.runChanged": { run: AgentRun };
  /** A streamed event from a program-manager run. */
  "hub.event": RunEvent;
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

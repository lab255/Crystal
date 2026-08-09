import type { AgentProfile, AgentProfileScope, AgentRoster } from "./agent-profile.js";
import type { GrantsLedger } from "./grants.js";
import type { ArchDraft } from "./arch-draft.js";
import type { ArchOverlay } from "./arch-overlay.js";
import type { ArchitectureGraph } from "./architecture.js";
import type { ChangedRefFile } from "./code-map-diff.js";
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
import type { DevServerInfo } from "./dev-server.js";
import type { ApiClientState, ApiHeader, ApiHttpResponse } from "./api-client.js";
import type { RefactorApplyResult, RefactorIntent, RefactorPlan } from "./refactor.js";
import type {
  ScreenApiCall,
  SurfaceMapReport,
  SurfacesReport,
} from "./surfaces.js";
import type { SystemOverview } from "./system-overview.js";
import type { ServiceInfo, ServiceLogChunk, ServicesFile, WatchInfo } from "./service.js";
import type { StandingTaskInfo, StandingTasksFile } from "./standing-task.js";
import type { TerminalChunk, TerminalInfo } from "./terminal.js";
import type { TodoList } from "./todo.js";
import type {
  SteerReceipt,
  TemplateScope,
  Workflow,
  WorkflowSpend,
  WorkflowTemplate,
} from "./workflow.js";
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
import type { PublishStatus } from "./publish.js";

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

/** Additive quality-run state carried by bridge responses and progress events. */
export type QualityRunUpdate = QualityRun & {
  scope: QualityRun["scope"] & {
    /** Run only the detected package at this workspace-relative directory. */
    packageDir?: string;
    /** Exact describe/test hierarchy used to build the runner name pattern. */
    testNamePath?: string[];
  };
  /** The package job currently executing; indexes are one-based. */
  progress?: { packageDir: string; jobIndex: number; jobCount: number };
  /** A requested coverage run settled without producing fresh Istanbul JSON. */
  coverageMissing?: true;
  /** Workspace-relative Istanbul paths checked for this coverage run. */
  coveragePathsProbed?: string[];
};

/** One headless tool call parked while it waits for an explicit owner decision. */
export interface PendingPermission {
  id: string;
  runId: string;
  /** Tool name as the CLI reported it (for example `Bash` or `WebFetch`). */
  tool: string;
  /** Bounded one-line call description, including the primary argument when available. */
  summary: string;
  requestedAt: string;
}

/** Live progress for one workspace's full code-map analysis pass. */
export interface CodeMapProgress {
  ws: string;
  phase: "discovering" | "parsing" | "resolving" | "done";
  done?: number;
  total?: number;
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
  /** Upstream tracking branch in short form ("origin/main"), null when none is set. */
  upstream: string | null;
  /** Commits ahead of / behind the upstream (0 when no upstream). */
  ahead: number;
  behind: number;
}

/** Remote sync verbs for `git.sync`. */
export type GitSyncOp = "fetch" | "pull" | "push";

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

/**
 * Merge prediction for an isolated run's worktree (`agent.mergePreview`).
 * The server's git layer produces this; nothing here is destructive.
 */
export interface MergePreviewResult {
  /** Branch the merge would land on (null = no target resolvable). */
  target: string | null;
  /** Tip commit of the target branch. */
  baseTip: string | null;
  /** The worktree's HEAD commit. */
  head: string | null;
  /** Commits on the worktree not on target. */
  ahead: number;
  /** Commits on target not on the worktree (a true merge, not a FF). */
  behind: number;
  /** Uncommitted changes in the worktree (auto-committed by merge). */
  dirty: boolean;
  /** Predicted conflicted paths (committed state only). */
  conflicts: string[];
  /** A conflict resolution (reverse merge) is in progress in the worktree. */
  resolving: boolean;
  /** git < 2.38 — conflict prediction unavailable. */
  predictionUnavailable: boolean;
  canMerge: boolean;
  reason: string | null;
}

/** Result of landing a run's worktree (`agent.merge`). */
export interface MergeResult {
  target: string;
  mergedCommit: string;
  fastForward: boolean;
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
      /**
       * Safe mode: roots the server held back because the previous boot's
       * workspace restore never completed (it most likely crashed opening one
       * of them). Clients should prompt — `workspaces.restorePending` opens
       * them, `workspaces.dismissRestore` starts without them. Optional so
       * responses from older servers still typecheck.
       */
      pendingRestore?: string[];
    };
  };
  "workspaces.open": { params: { root: string }; result: { workspace: WorkspaceDescriptor } };
  "workspaces.close": { params: { ws: string }; result: { ok: true } };
  /** Safe mode: reopen the roots a crashed restore held back (see `workspaces.list`). */
  "workspaces.restorePending": { params: Record<string, never>; result: { ok: true } };
  /** Safe mode: start without the held-back roots (they stay in recents). */
  "workspaces.dismissRestore": { params: Record<string, never>; result: { ok: true } };
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
  /**
   * The workspace's architecture overlay — the user-authored half of the one
   * canonical architecture diagram (overrides on derived nodes, manual
   * nodes/edges, environments, journeys, facets). Created on first read; the
   * first read also migrates legacy per-diagram `.crystal` files and
   * `systems-layout.json` into it (losslessly — old files are left in place).
   */
  "arch.getOverlay": { params: WsScope; result: { overlay: ArchOverlay } };
  "arch.saveOverlay": { params: WsScope & { overlay: ArchOverlay }; result: { ok: true } };
  "archdraft.create": {
    params: WsScope & { draft: ArchDraft };
    result: { path: string; draft: ArchDraft };
  };
  "archdraft.save": { params: WsScope & { path: string; draft: ArchDraft }; result: { ok: true } };
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
   * The workspace's grants ledger: tool patterns granted to every agent run
   * (applied additively at spawn) plus the permission-denial tally — which
   * run/workflow requested which tool and was refused, how many times.
   */
  "grants.get": { params: WsScope; result: { ledger: GrantsLedger } };
  /** Replace the granted tool list (denials are recorded, not edited). */
  "grants.setTools": {
    params: WsScope & { tools: string[] };
    result: { ledger: GrantsLedger };
  };
  /** Flip allow-all mode: the broker auto-approves every headless permission prompt. */
  "grants.setAllowAll": {
    params: WsScope & { on: boolean };
    result: { ledger: GrantsLedger };
  };
  /** Tool calls currently parked on an owner decision in this workspace. */
  "permissions.pending": {
    params: WsScope;
    result: { pending: PendingPermission[] };
  };
  /** Resolve one parked call; `alwaysAllow` also grants its tool workspace-wide. */
  "permissions.decide": {
    params: WsScope & {
      id: string;
      decision: "allow" | "deny";
      alwaysAllow?: boolean;
    };
    result: { ok: boolean };
  };
  "fs.list": { params: WsScope & { path: string }; result: { entries: FileEntry[] } };
  /** `sha` identifies the whole on-disk file — hand it back to `fs.write` as `baseSha`. */
  "fs.read": {
    params: WsScope & { path: string };
    result: { content: string; truncated: boolean; sha: string };
  };
  /**
   * `baseSha` (from the `fs.read` that loaded the buffer) makes the write
   * conflict-guarded: if the file changed on disk since, the write fails
   * loudly instead of clobbering the newer content. Omit for unguarded writes.
   */
  "fs.write": {
    params: WsScope & { path: string; content: string; baseSha?: string };
    result: { ok: true };
  };
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
  /**
   * One file's content at a ref — the base side of a textual diff, and the
   * only way to inspect what a deleted (ghost) file contained. `content: null`
   * means absent at that ref (`truncated: false`) or over the size cap
   * (`truncated: true`). Throws on unknown refs and binary files.
   */
  "git.showFile": {
    params: WsScope & { repoPath?: string; path: string; ref: string };
    result: { content: string | null; truncated: boolean };
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
  /**
   * Sync with the remote: "fetch" (`--prune`), "pull" (fast-forward only — a
   * divergence fails with git's message rather than minting a surprise merge)
   * or "push" (sets upstream on the first push of a branch). Credential
   * prompts are disabled server-side, so a repo that needs interactive auth
   * fails fast instead of hanging.
   */
  "git.sync": {
    params: WsScope & { repoPath?: string; op: GitSyncOp };
    result: { ok: true; summary: string; status: GitStatusResult };
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
    /**
     * `runId` is the run now carrying the conversation: the freshly resumed
     * turn, or the live interactive run the text was typed into (null
     * otherwise). `status` is the delivery truth surfaces must not collapse:
     * `resumed` = delivered now, `queued` = held server-side and flushed on
     * the next settlement, `recorded` = this chain can never receive it
     * (cancelled, or no session ever materialized) — the text was NOT
     * delivered and the caller must say so.
     */
    result: { status: "resumed" | "queued" | "recorded"; runId: string | null };
  };
  "agent.cancel": { params: WsScope & { runId: string }; result: { ok: true } };
  /** All runs plus the instance-wide login-health flag (see `agent.authChanged`). */
  "agent.list": {
    params: WsScope;
    result: { runs: AgentRun[]; auth: { broken: boolean; detail: string | null } };
  };
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
  /**
   * Non-destructive merge prediction for an isolated run's worktree: target
   * branch (repo's current branch unless `target` overrides), ahead/behind,
   * dirty state and — via `git merge-tree` — the conflicts a merge would hit.
   */
  "agent.mergePreview": {
    params: WsScope & { runId: string; target?: string | null };
    result: MergePreviewResult;
  };
  /**
   * Land the run's worktree on the target branch. Dirty state is auto-
   * committed first. Fails with the conflict list when the merge would
   * conflict — resolve via `agent.resolveConflicts` and merge again.
   */
  "agent.merge": {
    params: WsScope & { runId: string; target?: string | null; message?: string | null };
    result: MergeResult;
  };
  /**
   * Start AI conflict resolution: the target branch is merged INTO the run's
   * worktree (standard conflict markers) and an agent run is dispatched in
   * that worktree to resolve and commit. Once it settles, `agent.merge` lands
   * as a fast-forward.
   */
  "agent.resolveConflicts": {
    params: WsScope & { runId: string; target?: string | null };
    result: { run: AgentRun; conflicts: string[] };
  };
  /** Abort an in-progress conflict resolution (restores the pre-merge tree). */
  "agent.abortResolve": { params: WsScope & { runId: string }; result: { ok: true } };
  /**
   * Context handoff: summarize the (settled) session's transcript and start a
   * fresh session seeded with the note — same worktree when one exists, so
   * uncommitted work carries over. The recovery for context-overflow
   * failures, and a deliberate reset for any long session.
   */
  "agent.handoff": {
    params: WsScope & {
      runId: string;
      /**
       * Hand the continuation to a DIFFERENT agent profile (multi-agent
       * handoff) — possibly another CLI vendor; the summarize-and-reseed
       * mechanism carries the context across. Absent = same profile.
       */
      targetAgentId?: string | null;
    };
    result: { run: AgentRun };
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
  /** Managed services: definitions (from `.crystal/services.json`) + live state + watches. */
  "service.list": {
    params: WsScope;
    result: { services: ServiceInfo[]; watches: WatchInfo[] };
  };
  /** Replace the service definitions (validated; running removals keep their process). */
  "service.save": {
    params: WsScope & { services: ServicesFile };
    result: { services: ServiceInfo[]; watches: WatchInfo[] };
  };
  /** Start a service (port pre-probed; desired state persists across restarts). */
  "service.start": { params: WsScope & { serviceId: string }; result: { service: ServiceInfo } };
  /** Stop a service (SIGTERM the process group, SIGKILL after a grace window). */
  "service.stop": { params: WsScope & { serviceId: string }; result: { service: ServiceInfo } };
  "service.restart": { params: WsScope & { serviceId: string }; result: { service: ServiceInfo } };
  /** Log ring replay (capped) — catch up before listening to `service.log`. */
  "service.logs": {
    params: WsScope & { serviceId: string };
    result: { chunks: ServiceLogChunk[] };
  };
  /** Standing tasks: definitions (`.crystal/standing-tasks.json`) + schedule state. */
  "standing.list": { params: WsScope; result: { tasks: StandingTaskInfo[] } };
  /** Replace the standing-task definitions (validated server-side). */
  "standing.save": {
    params: WsScope & { tasks: StandingTasksFile };
    result: { tasks: StandingTaskInfo[] };
  };
  /**
   * Fire a standing task now, schedule notwithstanding. `runId` is null when
   * the fire was suppressed (`reason`: the previous fire is still running, or
   * the spawn failed).
   */
  "standing.fire": {
    params: WsScope & { taskId: string };
    result: { runId: string | null; reason: string | null };
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
   * The unified ref snapshot behind every "vs <ref>" review: the codebase
   * state at a git ref, in whichever projections the caller needs. `summary`
   * and `surfaces` require materializing the ref's tree and running the full
   * analyzer (LRU-cached per commit); a `need` of exactly `["overview"]`
   * takes the cheap in-memory blob-parse path. `changedFiles` (working tree
   * vs merge-base with the ref) always rides along so file-level "changed"
   * marks come from the same resolution as the structural diff. Diffing
   * itself is client-side (`diffCodeMaps`, `diffSystemOverviews`) — the
   * server only snapshots.
   */
  "codemap.snapshotAtRef": {
    params: WsScope & {
      ref: string;
      repoPath?: string;
      need?: ("summary" | "overview" | "surfaces")[];
    };
    result: {
      ref: string;
      commit: string;
      changedFiles: ChangedRefFile[];
      summary?: CodeMapSummary;
      overview?: SystemOverview;
      surfaces?: { report: SurfacesReport; calls: ScreenApiCall[] };
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
   * `projection: "facets"` returns the facet-suggestion slice (tag strings
   * only — no symbol names, no evidence, no untagged symbols); large repos
   * must request it from webviews instead of the full index.
   */
  "codeindex.get": {
    params: WsScope & { projection?: "facets" };
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
   * Detected dev-server candidates (every workspace package's scripts) merged
   * with their live state — see dev-server.ts. Changes broadcast as
   * `devservers.changed`.
   */
  "devservers.list": { params: WsScope; result: { servers: DevServerInfo[] } };
  /**
   * Run a candidate on a PTY terminal (visible in the terminal panel; its
   * real URL is sniffed from the output). Fails when already running.
   */
  "devservers.start": { params: WsScope & { id: string }; result: { server: DevServerInfo } };
  /** Kill a running candidate's terminal (tree-kill, same as closing the tab). */
  "devservers.stop": { params: WsScope & { id: string }; result: { ok: true } };
  /** Stop (when running) and start again — the restart button. */
  "devservers.restart": { params: WsScope & { id: string }; result: { server: DevServerInfo } };
  /** The workspace's API-client workbench (requests + per-env config) — see api-client.ts. */
  "apiclient.get": { params: WsScope; result: { state: ApiClientState } };
  /** Whole-state save (app data, never the repo). Broadcasts `apiclient.changed`. */
  "apiclient.save": { params: WsScope & { state: ApiClientState }; result: { ok: true } };
  /**
   * Execute one HTTP request server-side (the browser can't reach localhost
   * APIs cross-origin) and return the response. Templates are resolved by
   * the caller; transport failures come back as status 0 + error, never a
   * rejection.
   */
  "apiclient.send": {
    params: WsScope & {
      method: string;
      url: string;
      headers?: ApiHeader[];
      body?: string | null;
    };
    result: ApiHttpResponse;
  };
  /** How (and whether) this workspace can run tests — see quality.ts. */
  "quality.detect": { params: WsScope; result: TestRunnerInfo };
  /**
   * Start a test run (optionally scoped to a package / file / name filter,
   * optionally with coverage). One run at a time per workspace; starting
   * while one is live fails. Progress streams as `quality.runChanged` events.
   */
  "quality.run": {
    params: WsScope & {
      file?: string;
      testName?: string;
      testNamePath?: string[];
      packageDir?: string;
      coverage?: boolean;
    };
    result: { run: QualityRunUpdate };
  };
  "quality.cancel": { params: WsScope & { runId: string }; result: { ok: true } };
  /** Recent runs, newest first (capped) — the live run included. */
  "quality.runs": { params: WsScope; result: { runs: QualityRunUpdate[] } };
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
      /**
       * Model override for THIS workflow's manager — beats the profile and
       * the roster preset (e.g. lift one dispatch to fable without changing
       * the project setting).
       */
      managerModel?: string | null;
      /** Spend ceiling in USD; dispatches are refused once crossed. */
      budgetUsd?: number | null;
      /** Per-run spend ceiling: any single run crossing it is killed live. */
      runCapUsd?: number | null;
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
    params: WsScope & {
      workflowId: string;
      text: string;
      /** false = park for the next natural wake instead of a paid resume. */
      wake?: boolean;
    };
    result: { run: AgentRun | null; queued: boolean } & SteerReceipt;
  };
  /** Checkpoint the manager into a fresh session (refused while runs are live). */
  "workflow.compact": {
    params: WsScope & { workflowId: string };
    result: { workflow: Workflow; run: AgentRun };
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
  /** Set/clear the per-run cost cap (applies to runs spawned from now on). */
  "workflow.setRunCap": {
    params: WsScope & { workflowId: string; runCapUsd: number | null };
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
      /** Per-run cap handed to the delivery's workflow at dispatch. */
      runCapUsd?: number | null;
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
    params: { programId: string; deliveryId: string; text: string; wake?: boolean };
    result: { queued: boolean } & SteerReceipt;
  };
  /** Settle a delivery externally: record the outcome, cancel its workflow, unblock dependents. */
  "hub.closeDelivery": {
    params: {
      programId: string;
      deliveryId: string;
      outcome: "completed" | "failed";
      note: string;
    };
    result: { program: Program };
  };
  /** Checkpoint a delivery's orchestrator into a fresh session. */
  "hub.compactDelivery": {
    params: { programId: string; deliveryId: string };
    result: Record<string, never>;
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
  /**
   * Close the program-manager session: cancel any live manager run (headless
   * or interactive) and detach it from the program, so a fresh session can be
   * started. The run history stays in `hub.runs`; the program itself is
   * untouched — deliveries keep running and notices queue until a new
   * manager picks them up.
   */
  "hub.closeManager": { params: { programId: string }; result: { program: Program } };
  /** Deliver an owner message into the program manager's session. */
  "hub.message": {
    params: { programId: string; text: string };
    result: { run: AgentRun | null; queued: boolean } & SteerReceipt;
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
    params: {
      programId: string;
      questionId: string;
      answer: string;
      /**
       * Where the caller saw the question (`HubQuestion.deliveryId`/`taskId`).
       * Pass both when known: the server then answers that exact board task
       * instead of re-deriving from live deliveries — which goes stale the
       * moment a delivery settles with its question still open.
       */
      deliveryId?: string | null;
      taskId?: string | null;
    };
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

  /** Current publish-server state (relay connection, share URL). */
  "publish.status": { params: Record<string, never>; result: PublishStatus };
  /**
   * Change the publish configuration. Omitted fields are left alone; a
   * `password` (min 8 chars) is forwarded to the relay so remote clients must
   * present it — it is applied immediately when the host is connected and
   * rides the next (re)connect otherwise. Enabling for the first time mints
   * the instance id and host token server-side; the token never leaves the
   * server.
   */
  "publish.configure": {
    params: { enabled?: boolean; relayUrl?: string | null; password?: string | null };
    result: PublishStatus;
  };

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
  "workspaces.restorePending",
  "workspaces.dismissRestore",
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
  "hub.closeDelivery",
  "hub.compactDelivery",
  "hub.setPaused",
  "hub.setBudget",
  "hub.setDeliveryBudget",
  "hub.cancel",
  "hub.remove",
  "hub.questions",
  "hub.answerQuestion",
  "hub.startManager",
  "hub.closeManager",
  "hub.message",
  "hub.endpoint",
  "hub.runs",
  "hub.runEvents",
  "hub.cancelRun",
  // Publishing is server-level: one relay connection exposes every workspace.
  "publish.status",
  "publish.configure",
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
  /**
   * The workspace's CLI login broke (auth-classified failure) or healed (any
   * successful run). While broken, chain deliveries park server-side.
   */
  "agent.authChanged": { ws: string; broken: boolean; detail: string | null };
  "fs.changed": { ws: string; paths: string[] };
  "workspace.changed": { ws: string };
  /**
   * The architecture overlay was saved (any client, any window). Listeners
   * refetch via `arch.getOverlay` — without this, a second window's stale
   * full-document save silently clobbers everything authored elsewhere.
   */
  "arch.overlayChanged": { ws: string };
  /** A workspace's todo list was saved (payload carries the new list). */
  "todos.changed": { ws: string; todos: TodoList };
  /** A workspace's agent roster was saved (payload carries the new roster). */
  "agents.changed": { ws: string; roster: AgentRoster };
  /** The grants ledger changed (tools edited, or a denial was recorded). */
  "grants.changed": { ws: string; ledger: GrantsLedger };
  /** The workspace's set of parked tool-permission requests changed. */
  "permissions.changed": { ws: string };
  /** Terminal output/echo chunk (sequenced per terminal). */
  "terminal.data": { ws: string; chunk: TerminalChunk };
  /** A terminal was created, resized, exited or killed. */
  "terminal.changed": { ws: string; terminal: TerminalInfo };
  /** A managed service started, stopped, crashed or was redefined. */
  "service.changed": { ws: string; service: ServiceInfo };
  /** One log line from a managed service (sequenced per service). */
  "service.log": { ws: string; chunk: ServiceLogChunk };
  /** A watch fired (its agent dispatch may still be suppressed by a live run). */
  "service.watchFired": { ws: string; watch: WatchInfo };
  /** The standing-task set or schedule state changed (fired, saved). */
  "standing.changed": { ws: string };
  /** The derived code map was re-analyzed after source changes. */
  "codemap.changed": { ws: string };
  /** A full code-map pass advanced (file counts are present while parsing). */
  "codemap.progress": CodeMapProgress;
  /** The code index changed (code re-analyzed or an enrichment file landed). */
  "codeindex.changed": { ws: string };
  /** A dev server started, stopped, or learned its URL from process output. */
  "devservers.changed": { ws: string };
  /** The API-client state was saved (another client, or this one). */
  "apiclient.changed": { ws: string };
  /** A test run started, streamed new results, or settled (payload = full run). */
  "quality.runChanged": { ws: string; run: QualityRunUpdate };
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
  /**
   * The publish-server state changed (configured, relay connected or lost, a
   * remote client attached). Server-level, so no `ws`.
   */
  "publish.changed": PublishStatus;
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

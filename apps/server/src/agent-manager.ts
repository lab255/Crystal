import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Emitter,
  LineBuffer,
  chainRootId,
  claudeProjectDirName,
  classifyRunFailure,
  createAgentRun,
  emptyUsage,
  isPermissionDenial,
  isWorkflowTag,
  nowIso,
  parseClaudeStreamLine,
  CodexStreamParser,
  promptHeadline,
  runCostUsd,
  runFailureHint,
  touchedFileFromToolUse,
  transcriptUsage,
  applyProfileOverlay,
  resolvePresetModel,
  type AgentEvent,
  type AgentIsolation,
  type AgentPermissionMode,
  type AgentProfileOverlay,
  type AgentProvider,
  type AgentRole,
  type AgentRun,
  type AskOptions,
  type CreatePrResult,
  type ModelPreset,
  type ProfileResolutionInput,
  type RunEvent,
  type RunPurpose,
  type WorkerSpec,
} from "@crystal/core";
import { envWithBinDir, envWithToolchain, resolveClaudeBin } from "./claude-bin.js";
import { codexExecArgs, codexInteractiveArgs, resolveCodexBin } from "./codex.js";
import { runGit } from "./git.js";
import { HUB_MCP_ID } from "./mcp/http.js";
import { exists, resolveInRoot } from "./paths.js";
import { PendingQueue } from "./pending-queue.js";
import { createPr as createPullRequest, PrStore } from "./pr-manager.js";
import { killProcessTree } from "./process-tree.js";
import {
  abortConflictResolution,
  buildConflictPrompt,
  mergePreview,
  mergeWorktree,
  prepareConflictResolution,
  syncPreview,
  syncWorktree,
  type MergePreview,
  type MergeResult,
  type SyncPreview,
  type SyncResult,
} from "./worktree-merge.js";
import { WorktreeOperationMutex } from "./worktree-operation-mutex.js";

export interface AgentStartParams {
  prompt: string;
  cwd?: string;
  taskId?: string | null;
  projectId?: string | null;
  repoId?: string | null;
  resumeSessionId?: string | null;
  isolation?: AgentIsolation;
  /** Agent profile attribution (model/skills are resolved by the caller). */
  agentId?: string | null;
  /** Manager run that dispatched this worker (sets role to "worker"). */
  parentRunId?: string | null;
  /** Earlier run of the same logical session this run resumes (chains manager turns). */
  resumedFromRunId?: string | null;
  /** Run this one continues in a fresh session (context handoff — see handoff()). */
  handoffFromRunId?: string | null;
  /**
   * Continue in the named (settled) run's existing worktree instead of
   * acquiring a fresh one — conflict-resolution and follow-up runs work on
   * the same tree. Refused while any live run shares that worktree.
   */
  worktreeOfRunId?: string | null;
  /** Place in the manager/worker hierarchy (unset = standalone run). */
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
  /** CLI vendor for this run (from the profile); null/absent = claude. */
  provider?: AgentProvider | null;
  /** Model alias/id for `--model` (from the dispatched agent profile). */
  model?: string | null;
  /** Skill names woven into the prompt (from the dispatched agent profile). */
  skills?: string[];
  /**
   * Standing instructions passed as `--append-system-prompt` (from the agent
   * profile) — a flag, not prompt concatenation, so they survive `--resume`.
   */
  appendSystemPrompt?: string | null;
  /** Extra pre-allowed tools, merged (deduped) over the dev-loop allowlist. */
  allowedTools?: string[];
  /** Tools the run may never use (`--disallowedTools`, comma-joined). */
  disallowedTools?: string[];
  /** Overrides the default acceptEdits `--permission-mode` when set. */
  permissionMode?: AgentPermissionMode | null;
  /** Git branch for the run's worktree (implies worktree isolation). */
  branch?: string | null;
  /**
   * Existing worktree this run continues in (resume-chain continuity: a
   * resumed turn must see the same working copy its session edited, not the
   * plain repo). Server-internal — never exposed over the bridge; the caller
   * (resumeChain) has verified the directory still exists.
   */
  adoptWorktreePath?: string | null;
  /**
   * Per-run spend ceiling in USD, enforced live: once the run's streamed
   * usage estimates past the cap, the run is killed (see enforceCostCap).
   */
  costCapUsd?: number | null;
}

/** What an interactive dispatch needs from the caller. */
export interface InteractiveStartParams {
  prompt: string;
  /** Relaunch the named run's resolved resume chain in a fresh PTY. */
  resumeRunId?: string | null;
  cwd?: string;
  taskId?: string | null;
  projectId?: string | null;
  repoId?: string | null;
  agentId?: string | null;
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
  provider?: AgentProvider | null;
  model?: string | null;
  skills?: string[];
  appendSystemPrompt?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: AgentPermissionMode | null;
  /** Server-internal policy inherited by interactive resume turns. */
  costCapUsd?: number | null;
}

/**
 * Everything needed to host a prepared interactive run on a PTY: the program
 * to spawn, and the opening prompt to type into it (prompts travel as PTY
 * input, never argv — same rule as stdin on headless runs).
 */
export interface InteractiveSpawn {
  run: AgentRun;
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Server-resolved absolute cwd inside the workspace or an adopted worktree. */
  cwd: string;
  prompt: string;
}

interface ResumeChainResolution {
  rootId: string;
  chain: AgentRun[];
  root: AgentRun;
  latest: AgentRun;
  sessionId: string | null;
  worktreeHolder: AgentRun | null;
}

interface ResumeWorktreeResolution {
  sourcePath: string | null;
  adoptPath: string | null;
  contested: boolean;
}

/**
 * The trailing protocol for an interactive task session. On top of the
 * headless board tools, it pairs the native AskUserQuestion flow with the
 * board's question log — ask_question first so the decision is answerable
 * later from the hub/board, AskUserQuestion for the owner at the terminal,
 * resolve_question to close the board copy once the interactive answer lands.
 */
const INTERACTIVE_TASK_NOTE =
  "\n\nYour work is tracked on a Crystal board task. Use your mcp__crystal__* tools: " +
  "my_task (its details and acceptance criteria) and update_my_task (move its status as " +
  "you progress — in_progress when you start, review when done and green).\n\n" +
  "You are running interactively, with the task's owner at the terminal. When you need " +
  "their decision: first file it with ask_question (that logs it on the board, where the " +
  "owner can answer later if they step away), then ask the same thing natively with your " +
  "AskUserQuestion tool. When the interactive answer arrives, act on it and call " +
  "resolve_question with the outcome so the board copy closes. If no answer comes, keep " +
  "working everything not gated on it — board answers are typed into this session.";

const MAX_DIFF_BYTES = 1024 * 1024;

/** In-memory replay-buffer cap per run (full history stays on disk until finish). */
const MAX_RUN_EVENTS = 5000;

/** Coalescing window for non-terminal runChanged broadcasts. */
const RUN_CHANGED_DEBOUNCE_MS = 100;

/** One stream-json line larger than this is flushed (and recorded as stderr). */
const MAX_STREAM_LINE_BYTES = 16 * 1024 * 1024;

/** Fan-out cap: how many workers one manager (across its whole resume chain) may dispatch. */
const MAX_WORKERS_PER_MANAGER = 12;

/**
 * Fan-out cap for workflow managers (runs tagged `workflow:*`). A full
 * workflow — plan, design, N develop tracks, their reviews, fixes, merge,
 * release — legitimately outgrows the standalone-manager cap.
 */
const MAX_WORKERS_PER_WORKFLOW = 40;

/** How much of a worker's result text rides along in the manager wake-up prompt. */
const NOTICE_RESULT_CHARS = 1500;

/**
 * How long after spawning the Claude TUI its opening prompt is typed in. The
 * TUI must have mounted (and enabled bracketed paste) before raw input means
 * anything; too early and the paste markers land as literal escapes.
 */
export const INTERACTIVE_PROMPT_DELAY_MS = 2500;

/** Model for the handoff summarizer — condensing a transcript is light work. */
const HANDOFF_SUMMARY_MODEL = "haiku";
/** Transcript digest cap fed to the summarizer (head + tail split below). */
const HANDOFF_DIGEST_CHARS = 24_000;
const HANDOFF_DIGEST_HEAD_CHARS = 4_000;
/** Raw-tail fallback carried into the continuation when summarization fails. */
const HANDOFF_FALLBACK_CHARS = 4_000;

/**
 * When an interactive session is considered ready for *deliveries* (answers,
 * notices typed into the PTY): after the opening prompt has gone in, plus a
 * margin. Before this, deliveries queue — typing into a mounting TUI mangles
 * the paste and would still be reported as delivered.
 */
const INTERACTIVE_READY_MS = INTERACTIVE_PROMPT_DELAY_MS + 1500;

/**
 * Env for a spawned agent. Crystal's agents are top-level Claude sessions,
 * never nested children of whatever session happened to launch the bridge
 * server — an inherited child-session marker makes the CLI disable transcript
 * saving ("⚠ Transcript saving is off"), which silently breaks `--resume`
 * of an interactive session after its terminal closes AND transcript-based
 * usage harvesting. Found live: a dev server started from inside a Claude
 * session passed the marker straight through.
 */
export function agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLAUDE_CODE_CHILD_SESSION;
  return env;
}

/**
 * Billing safety for every agent spawn (headless and interactive): an
 * inherited `ANTHROPIC_API_KEY` silently switches the CLI from the user's
 * subscription login to per-token API billing — strip it unless the user
 * opts in with CRYSTAL_ALLOW_API_KEY=1 (borrowed from operator-oss, their
 * issue #4).
 */
export function stripApiKey(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  if (base.CRYSTAL_ALLOW_API_KEY !== "1") delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Env for a *headless* Claude CLI run: the API-key billing guard
 * ({@link stripApiKey}) plus color off — stream-json output must stay
 * escape-free. Interactive TUIs keep color and apply stripApiKey directly.
 */
export function claudeSpawnEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...stripApiKey(base), FORCE_COLOR: "0" };
}

/** How to invoke the Claude CLI: a direct executable, or through cmd.exe. */
export interface ClaudeSpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
}

/**
 * Quote one arg for a `shell: true` Windows spawn, which CONCATENATES argv
 * into a single cmd.exe command line without any escaping (DEP0190) — an
 * unquoted path like `C:\Users\Eliot Lim\...` splits at the space. Values
 * here are internal (paths, session ids, model ids), so embedded quotes are
 * stripped rather than escaped.
 */
function winShellQuote(arg: string): string {
  const clean = arg.replace(/"/g, "");
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

/**
 * Plan the Claude CLI spawn. A real executable (POSIX binary, or the native
 * installer's claude.exe on Windows) is spawned directly — argv passes
 * through untouched. Only .cmd/.bat npm shims need cmd.exe (`shell: true`),
 * and on that path every arg must be hand-quoted (see winShellQuote).
 */
/**
 * Dev-loop commands every headless run is pre-allowed to execute. `-p` runs
 * have no one to answer permission prompts, and `acceptEdits` covers only
 * file edits — without these rules a worker cannot `git commit` its track
 * branch or run the test suite, and the work dies uncommitted in a
 * disposable worktree (found the hard way). Scoped per verb, not
 * `Bash(git *)`: everything outward-facing (push, publish, remote, clone)
 * and history-destroying (reset, clean) stays gated behind a human.
 */
export const ALLOWED_RUN_TOOLS = [
  "Bash(git status*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show *)",
  "Bash(git branch*)",
  "Bash(git switch *)",
  "Bash(git checkout *)",
  "Bash(git merge *)",
  "Bash(git worktree *)",
  "Bash(git rev-parse *)",
  "Bash(git stash*)",
  "Bash(git restore *)",
  "Bash(git tag *)",
  "Bash(git rm *)",
  "Bash(git mv *)",
  "Bash(npm test*)",
  "Bash(npm run *)",
  "Bash(npm ci*)",
  "Bash(npm install*)",
  "Bash(pnpm test*)",
  "Bash(pnpm run *)",
  "Bash(pnpm install*)",
  "Bash(pnpm typecheck*)",
  "Bash(pnpm vitest*)",
  "Bash(yarn test*)",
  "Bash(yarn run *)",
  "Bash(yarn install*)",
  "Bash(node *)",
  "Bash(npx *)",
  "Bash(tsx *)",
] as const;

/**
 * The MCP tool headless runs are told to route permission prompts through
 * (`--permission-prompt-tool`). Served by the workspace dispatch endpoint
 * (mcp/dispatch-mcp.ts `request_permission`), brokered server-side against
 * the grants ledger (permission-broker.ts). Confirmed contract (CLI 2.1.220):
 * the CLI calls the tool with `{tool_name, input, tool_use_id}` and expects a
 * single text content block whose text is a JSON
 * `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`.
 */
export const PERMISSION_PROMPT_TOOL = "mcp__crystal__request_permission";

/**
 * The Claude CLI argv for one run. When an mcp-config rides along, the
 * crystal server's tools are pre-allowed: headless (-p) runs have no one to
 * answer permission prompts, so without this every `mcp__crystal__*` call is
 * declined ("requested permissions … but you haven't granted it"). A bare
 * `mcp__crystal` rule allows the whole server; the endpoint already scopes
 * the actual toolset per run (see mcp/http.ts). The dev-loop allowlist
 * ({@link ALLOWED_RUN_TOOLS}) rides on every run for the same reason.
 */
export function claudeRunArgs(opts: {
  model?: string | null;
  resumeSessionId?: string | null;
  mcpConfigPath?: string | null;
  /** Profile standing prompt (`--append-system-prompt`); prompt text stays on stdin. */
  appendSystemPrompt?: string | null;
  /** Profile allowlist additions, merged (deduped) over {@link ALLOWED_RUN_TOOLS}. */
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  /** Replaces the default acceptEdits when set. */
  permissionMode?: AgentPermissionMode | null;
  /**
   * MCP tool the CLI routes permission prompts to (`--permission-prompt-tool`,
   * print-mode only). Only meaningful with an mcp-config that actually serves
   * the tool — the CLI refuses to start when the named tool doesn't exist.
   */
  permissionPromptTool?: string | null;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode ?? "acceptEdits",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.mcpConfigPath) {
    // --strict-mcp-config loads ONLY the crystal server from our config and
    // ignores the user's global/project MCP servers, so a scoped headless run
    // can't pick up unrelated (or conflicting) MCP tools. It scopes MCP
    // servers only — login, hooks and other settings stay active. Interactive
    // sessions keep the owner's own MCP setup (they are at the terminal).
    args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    if (opts.permissionPromptTool) {
      args.push("--permission-prompt-tool", opts.permissionPromptTool);
    }
  }
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  const allowed = [
    ...new Set([
      ...(opts.mcpConfigPath ? ["mcp__crystal"] : []),
      ...ALLOWED_RUN_TOOLS,
      ...(opts.allowedTools ?? []),
    ]),
  ];
  args.push("--allowedTools", allowed.join(","));
  if (opts.disallowedTools?.length) {
    args.push("--disallowedTools", [...new Set(opts.disallowedTools)].join(","));
  }
  return args;
}

/**
 * Argv for an *interactive* Claude session (the native TUI on a PTY). No
 * `-p`/stream-json — the TUI renders itself; the PTY's raw byte stream is the
 * transcript. `--session-id` pins a known id so the chain stays resumable
 * headlessly after the terminal closes (a queued answer can still reach the
 * session); `--resume` instead reopens an existing chain in a fresh PTY. The
 * MCP + dev-loop pre-allows mirror headless runs: the owner is present, but
 * routine git/test/board calls shouldn't nag them either.
 */
export function claudeInteractiveArgs(opts: {
  model?: string | null;
  sessionId?: string | null;
  resumeSessionId?: string | null;
  mcpConfigPath?: string | null;
  appendSystemPrompt?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
  permissionMode?: AgentPermissionMode | null;
}): string[] {
  const args = ["--permission-mode", opts.permissionMode ?? "acceptEdits"];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  else if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  const allowed = [
    ...new Set([
      ...(opts.mcpConfigPath ? ["mcp__crystal"] : []),
      ...ALLOWED_RUN_TOOLS,
      ...(opts.allowedTools ?? []),
    ]),
  ];
  args.push("--allowedTools", allowed.join(","));
  if (opts.disallowedTools?.length) {
    args.push("--disallowedTools", [...new Set(opts.disallowedTools)].join(","));
  }
  return args;
}

export function planClaudeSpawn(
  bin: string,
  args: string[],
  win: boolean = process.platform === "win32",
): ClaudeSpawnPlan {
  if (!win || /\.exe$/i.test(bin)) return { file: bin, args, shell: false };
  return { file: winShellQuote(bin), args: args.map(winShellQuote), shell: true };
}

/**
 * The wake-up prompt for a chain's queued notices. Pure so the composition is
 * testable: it once stringified the notice *objects* (`[object Object]`),
 * which silently broke every manager wake-up.
 *
 * The board-keeping tail belongs to settlement only — a queued message (a
 * question's answer, owner steering) speaks for itself and must not be
 * wrapped in "you were resumed because dispatched work settled".
 */
export function composeNoticePrompt(notices: readonly PendingNotice[]): string {
  const settled = notices.filter((n) => n.kind === "worker").length;
  const head = settled > 1 ? `${settled} workers settled while you were away.\n\n` : "";
  const tail = settled
    ? "\n\nYou were resumed because dispatched work settled. Review the results, update the " +
      "board (claim → update_task → release), dispatch follow-up or review workers for " +
      "anything done, and start the next READY tasks. If everything is done and the board " +
      "reflects it, say so briefly and stop. You will be resumed again when more workers " +
      "settle — do not busy-poll worker_status."
    : "";
  return head + notices.map((n) => n.text).join("\n\n---\n\n") + tail;
}

/**
 * Something waiting to be said to a session that is mid-turn: a worker's
 * result, or a message delivered through {@link AgentManager.deliver}.
 */
export interface PendingNotice {
  kind: "worker" | "message";
  text: string;
}

interface ActiveProcess {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
}

/**
 * Owns agent runs: spawns the Claude Code CLI per run, normalizes its
 * stream-json output into RunEvents, keeps an in-memory replay buffer and
 * persists finished runs to the per-workspace app-data directory.
 */
export class AgentManager {
  readonly events = new Emitter<{
    event: RunEvent;
    runChanged: { run: AgentRun };
    /** The CLI login broke (an auth-classified failure) or healed (any success). */
    authChanged: { broken: boolean; detail: string | null };
  }>();

  private runs = new Map<string, AgentRun>();
  /** tag → run ids carrying it (see indexTags). */
  private runsByTag = new Map<string, Set<string>>();
  private runEvents = new Map<string, RunEvent[]>();
  /** Monotonic per-run event seq — survives the replay buffer being trimmed. */
  private runSeqs = new Map<string, number>();
  /** Trailing debounce per run for non-terminal runChanged broadcasts. */
  private runChangedTimers = new Map<string, NodeJS.Timeout>();
  private procs = new Map<string, ActiveProcess>();
  /** Concurrent history readers share the same in-flight load. */
  private loading: Promise<void> | null = null;
  /** Terminal status reported by the CLI, applied only when the process closes. */
  private resultStatuses = new Map<string, Extract<AgentRun["status"], "completed" | "failed">>();
  /** Set by disposeAll (workspace close): no new spawns from this manager. */
  private disposed = false;
  private resolvedBin: string | null = null;
  private resolvedCodexBin: string | null = null;
  private readonly codexBin = process.env.CRYSTAL_CODEX_BIN ?? "codex";
  /**
   * Worker-settlement notices queued per manager chain root, delivered by
   * resuming the manager's session as soon as no chain run is live. This is
   * what closes the delegation loop: managers end their turn after
   * dispatching and are woken with results instead of busy-polling.
   */
  private pendingNotices = new PendingQueue<PendingNotice>();
  /** Per-chain-root serialization of resume attempts (see resumeChain). */
  private resumeLocks = new Map<string, Promise<unknown>>();
  /** Per-branch serialization of track-worktree adopt-or-create (see start). */
  private branchLocks = new Map<string, Promise<unknown>>();
  /** Mutating merge/sync/PR/cleanup operations, serialized per worktree path. */
  private readonly worktreeOperations = new WorktreeOperationMutex();
  /** Workspace-owned PR identities; run records deliberately carry no URL. */
  private readonly prStore: PrStore;
  /**
   * Set while the CLI login is broken (an auth-classified failure with no
   * later success). Every delivery would fail identically, so queued chain
   * messages park until a successful run proves the login healed — stronger
   * evidence than any auth-status probe.
   */
  private authBrokenDetail: string | null = null;
  /** Set by the workspace runtime: a dispatched worker inherits its task's lease. */
  onWorkerDispatched: ((worker: AgentRun) => void) | null = null;
  /**
   * Set by the workflow engine: a context handoff replaced a session with a
   * fresh one — anything pointing at the old chain (a workflow's manager run)
   * must repoint at the continuation or lose its remote control.
   */
  onHandoff: ((from: AgentRun, to: AgentRun) => void) | null = null;
  /**
   * Set by the workflow engine: veto a manager's dispatch (paused workflow,
   * exhausted budget). Returns a human-readable rejection reason, or null to
   * allow. Rejections surface to the manager as thrown dispatch errors.
   */
  dispatchGuard: ((manager: AgentRun, spec: WorkerSpec) => Promise<string | null>) | null = null;
  /**
   * Set by the workflow engine: the per-run cost cap a manager's dispatched
   * workers inherit (the workflow's `runCapUsd`). Null/absent = uncapped.
   */
  dispatchCostCap: ((manager: AgentRun) => Promise<number | null>) | null = null;
  /**
   * Set by the workspace runtime: extra `--allowedTools` patterns the
   * workspace has granted every agent run (the grants ledger). Additive over
   * whatever the profile/dispatch already allows — read per spawn, so an
   * edit applies to the next run without a restart.
   */
  grantsResolver: (() => Promise<string[]>) | null = null;
  /**
   * Set by the workspace runtime: a run's tool call bounced off permissions.
   * Feeds the grants ledger's denial tally — the difference between "delivery
   * X requested tool Y, denied 4 times" being readable in the IDE and being
   * archaeology across run transcripts.
   */
  onToolDenied: ((run: AgentRun, tool: string) => void) | null = null;
  /** toolUseId → tool name per run, so an error result can name its tool. */
  private toolNamesByRun = new Map<string, Map<string, string>>();
  /**
   * Set by the host: type `text` into the PTY hosting an interactive run
   * (bracketed paste + Enter). Returns false when the terminal is gone —
   * delivery then falls back to the headless queue/resume path.
   */
  interactiveInput: ((run: AgentRun, text: string) => boolean) | null = null;
  /** Set by the host: kill the PTY hosting an interactive run (cancel path). */
  interactiveKill: ((run: AgentRun) => void) | null = null;
  /**
   * Set by the host: resolve an agent profile id to its dispatch overlay
   * (workspace runtimes back it with the project+library AgentLibrary, the
   * hub with the global store). It is what lets a manager dispatch workers by
   * `agentId`, and what re-applies a profile's standing prompt / tool policy
   * on every `--resume` turn — flags are per-invocation, so without this the
   * profile would silently fall off the chain's second turn. Resolution input
   * selects manager/merge preset roles at the spawn seam.
   */
  profileResolver:
    | ((
        agentId: string,
        input?: ProfileResolutionInput | null,
      ) => Promise<AgentProfileOverlay | null>)
    | null = null;
  /**
   * Set by the host: the workspace's model preset (roster `preset` field).
   * It answers only when nothing else named a model/provider — explicit
   * params and profile overlays always win — and only for orchestration roles:
   * managers, dispatched workers, and merge-purpose runs. Plain runs (jobs,
   * consoles) keep the CLI's own default, as before.
   */
  presetResolver: (() => Promise<ModelPreset>) | null = null;
  /**
   * Set by the host: whether this workspace consented to
   * `permissionMode: "bypassPermissions"` (the roster's
   * `allowBypassPermissions` flag). Unset or false, a bypass request is
   * downgraded to acceptEdits at the spawn choke points — profiles and
   * dispatch params can *ask* for bypass, only workspace policy grants it.
   */
  bypassResolver: (() => Promise<boolean>) | null = null;
  /**
   * Set by the workspace runtime: the roster's `defaultPermissionMode` — the
   * mode for spawns where neither the dispatch params nor the profile named
   * one. Read per spawn (resumed turns re-resolve), and still subject to the
   * bypass gate above: a workspace default of bypassPermissions without
   * `allowBypassPermissions` consent downgrades like any other request.
   */
  defaultModeResolver: (() => Promise<AgentPermissionMode | null>) | null = null;
  /** Mount window before an interactive session takes deliveries (test seam). */
  interactiveReadyMs = INTERACTIVE_READY_MS;

  /** The permission mode a spawn may actually use (workspace bypass gate). */
  private async gatedPermissionMode(
    run: AgentRun,
    requested: AgentPermissionMode | null | undefined,
  ): Promise<AgentPermissionMode | null> {
    const effective =
      requested ?? (await this.defaultModeResolver?.().catch(() => null)) ?? null;
    if (effective !== "bypassPermissions") return effective;
    const allowed = await this.bypassResolver?.().catch(() => false);
    if (allowed) return effective;
    this.record(run, {
      type: "stderr",
      text: "bypassPermissions requested but not enabled for this workspace — running with acceptEdits.",
    });
    return "acceptEdits";
  }

  /** The preset-fallback model/provider for a run with none: managers/workers/merge. */
  private async presetModelFor(params: {
    model?: string | null;
    provider?: AgentProvider | null;
    role?: string | null;
    purpose?: RunPurpose | null;
  }): Promise<{ model: string; provider: AgentProvider } | null> {
    // A direct provider override without a model should use that CLI's own
    // default; pairing it with another provider's preset model is unsafe.
    if (params.model || params.provider || !this.presetResolver) return null;
    const presetRole =
      params.role === "manager"
        ? "manager"
        : params.purpose === "merge"
          ? "merge"
          : params.role === "worker"
            ? "worker"
            : null;
    if (!presetRole) return null;
    const preset = await this.presetResolver().catch(() => null);
    if (!preset) return null;
    return resolvePresetModel(preset, presetRole);
  }

  /** Absolute workspace root — engines run deterministic git against it. */
  get workspaceRoot(): string {
    return this.root;
  }

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly claudeBin = process.env.CRYSTAL_CLAUDE_BIN ?? "claude",
    /**
     * In-process MCP endpoint for manager runs. When set, a manager-role run is
     * launched with an mcp-config pointing at `<baseUrl>/mcp/<scope>/<runId>`,
     * so its tools land parented to that run. `scope` is a workspace id for
     * project runs and the reserved hub segment for program managers — the
     * router decides which toolset that means. Absent → managers fall back to
     * the CRYSTAL_DISPATCH marker.
     */
    private readonly mcp: { baseUrl: string; scope: string } | null = null,
  ) {
    this.prStore = new PrStore(dataDir);
  }

  private runsDir(): string {
    return path.join(this.dataDir, "runs");
  }

  /**
   * Resolve a bare CLI name to a real file once (see claude-bin.ts): PATH,
   * then well-known install dirs, then the login shell — the desktop
   * sidecar inherits a GUI launch environment where "claude" isn't on PATH
   * at all. Knowing the real path/extension also lets `planClaudeSpawn`
   * bypass cmd.exe for native .exe installs; when every lookup misses the
   * bare name survives, and the spawn surfaces a failed run, not a crash.
   */
  private async claudePath(): Promise<string> {
    if (!this.resolvedBin) {
      this.resolvedBin = await resolveClaudeBin(this.claudeBin);
      // One line per manager lifetime: the resolved path is the difference
      // between diagnosing "spawn claude ENOENT" in seconds and in hours.
      console.log(`[crystal] claude CLI: "${this.claudeBin}" resolved to "${this.resolvedBin}"`);
    }
    return this.resolvedBin;
  }

  /** Same ladder for the OpenAI Codex CLI (codex-provider profiles). */
  private async codexPath(): Promise<string> {
    if (!this.resolvedCodexBin) {
      this.resolvedCodexBin = await resolveCodexBin(this.codexBin);
      console.log(
        `[crystal] codex CLI: "${this.codexBin}" resolved to "${this.resolvedCodexBin}"`,
      );
    }
    return this.resolvedCodexBin;
  }

  /**
   * Write a per-run mcp-config pointing the manager's Claude CLI at this
   * server's in-process MCP endpoint, and return its path (null when no MCP
   * endpoint is configured). The URL carries the workspace and manager run id
   * so tool calls land parented to this run.
   */
  private async writeMcpConfig(runId: string): Promise<string | null> {
    if (!this.mcp) return null;
    const dir = path.join(this.dataDir, "mcp");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    const config = {
      mcpServers: {
        crystal: { type: "http", url: `${this.mcp.baseUrl}/mcp/${this.mcp.scope}/${runId}` },
      },
    };
    await fs.writeFile(file, JSON.stringify(config), "utf8");
    return file;
  }

  /** Load persisted run history (metadata + events) once. */
  private ensureLoaded(): Promise<void> {
    return (this.loading ??= this.loadHistory());
  }

  private async loadHistory(): Promise<void> {
    const dir = this.runsDir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as AgentRun;
        run.filesTouched ??= []; // records predating the field
        // Same vintage problem: a missing tags array crashed every workflow
        // spend computation (`r.tags.includes` in runsForWorkflow), which
        // took workflow_status down with it — the manager lost its meter.
        run.tags ??= [];
        // A run that was live when the server died can never complete.
        if (run.status === "running" || run.status === "queued") {
          run.status = "failed";
          run.resultText = run.resultText ?? "Server stopped while run was active";
        }
        this.runs.set(run.id, run);
        this.indexTags(run);
      } catch {
        // Ignore corrupt history entries.
      }
    }
  }

  /**
   * Tags are set once at creation and never mutated, so this index is
   * maintained only where a run enters `this.runs` and can never go stale.
   * It exists for the spend hot path: budget guards run on *every* dispatch
   * and settlement, and a full-history scan there grows with the workspace's
   * lifetime, not with the workflow being metered.
   */
  private indexTags(run: AgentRun): void {
    for (const tag of run.tags) {
      let ids = this.runsByTag.get(tag);
      if (!ids) this.runsByTag.set(tag, (ids = new Set()));
      ids.add(run.id);
    }
  }

  /** Runs carrying `tag`, newest first. */
  async runsWithTag(tag: string): Promise<AgentRun[]> {
    await this.ensureLoaded();
    const ids = this.runsByTag.get(tag);
    if (!ids?.size) return [];
    return [...ids]
      .map((id) => this.runs.get(id))
      .filter((r): r is AgentRun => !!r)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async list(): Promise<AgentRun[]> {
    await this.ensureLoaded();
    // Plain < on ISO-8601 strings — an ICU collation per comparison is pure
    // overhead on the hottest list in the workspace.
    return [...this.runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async eventsFor(runId: string): Promise<RunEvent[]> {
    await this.ensureLoaded();
    const inMemory = this.runEvents.get(runId);
    if (inMemory) return inMemory;
    try {
      const text = await fs.readFile(path.join(this.runsDir(), `${runId}.events.jsonl`), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RunEvent);
    } catch {
      return [];
    }
  }

  async start(params: AgentStartParams): Promise<AgentRun> {
    if (this.disposed) throw new Error("Workspace is closed — no new agent runs.");
    await this.ensureLoaded();
    // Resuming a session that still has a live run would FORK the Claude
    // session — two concurrent turns on one conversation. Internal paths go
    // through resumeChain (which serializes and re-checks); this guards the
    // raw API surface. Synchronous check, no await before the throw.
    if (params.resumeSessionId) {
      const live = [...this.runs.values()].find(
        (r) =>
          r.sessionId === params.resumeSessionId &&
          (r.status === "running" || r.status === "queued"),
      );
      if (live) {
        throw new Error(
          `Session ${params.resumeSessionId} has a live run (${live.id}) — resuming now would fork it. ` +
            `Deliver via agent.message instead, or wait for the run to settle.`,
        );
      }
    }
    const presetModel = await this.presetModelFor(params);
    if (presetModel) params = { ...params, ...presetModel };
    const run = createAgentRun(params);
    // A resumed run's session is known up front — stamping it now (instead of
    // waiting for the init event) makes the fork guard above airtight for
    // back-to-back resumes.
    if (params.resumeSessionId) run.sessionId = params.resumeSessionId;
    // The dispatched model, visible while the run is queued (the stream-json
    // init event overwrites it with the resolved model id) — same convention
    // as prepareInteractive.
    run.model = params.model ?? null;
    let cwdAbs = resolveInRoot(this.root, params.cwd ?? ".");
    // The requested cwd in the real repo, before any worktree redirect. A
    // worktree has no node_modules/.bin of its own, so the spawn env must
    // also reach the ORIGINAL package's toolchain — for a sub-package cwd
    // that is neither the worktree nor the workspace root.
    const repoCwdAbs = cwdAbs;

    this.runs.set(run.id, run);
    this.indexTags(run);
    this.runEvents.set(run.id, []);

    if (params.worktreeOfRunId) {
      try {
        cwdAbs = this.adoptRunWorktree(run, params.worktreeOfRunId);
      } catch (err) {
        return this.finish(run, "failed", (err as Error).message);
      }
    } else if (params.adoptWorktreePath) {
      // A resumed turn continues in its chain's worktree — the session's
      // earlier edits live there, not in the repo checkout.
      run.worktreePath = params.adoptWorktreePath;
      cwdAbs = params.adoptWorktreePath;
      this.record(run, {
        type: "status",
        status: "queued",
        message: `Continuing in worktree: ${params.adoptWorktreePath}${run.branch ? ` (branch ${run.branch})` : ""}`,
      });
    } else if (run.isolation === "worktree") {
      try {
        cwdAbs = await this.acquireWorktree(run, cwdAbs);
      } catch (err) {
        return this.finish(
          run,
          "failed",
          `Could not create worktree (is "${run.cwd}" a git repo with at least one commit?): ${(err as Error).message}`,
        );
      }
    }

    // Workspace-scoped headless runs ALWAYS get an mcp-config: beyond the
    // role-scoped toolsets (managers: dispatch + board; task runs: my_task),
    // the endpoint serves `request_permission` — the permission-prompt broker
    // that lets a `-p` run ask instead of silently failing an ungranted tool
    // — and `ask_question` for every run. The hub's manager keeps the old
    // manager/task gate: its endpoint (mcp/hub-mcp.ts) has neither tool, and
    // a bare /mcp/hub config on a plain run (handoff summarizer) would expose
    // the whole external portfolio surface to it.
    const hubScoped = this.mcp?.scope === HUB_MCP_ID;
    const provider = params.provider === "codex" ? "codex" : "claude";
    // Codex consumes no Claude-format mcp-config and has no permission-prompt
    // flag — its sandbox IS its permission model (codexSandboxArgs); board
    // questions still work via the CRYSTAL_QUESTION line protocol the parser
    // extracts from agent messages.
    const mcpConfig =
      provider === "codex"
        ? null
        : !hubScoped || run.role === "manager" || run.taskId
          ? await this.writeMcpConfig(run.id)
          : null;
    // Workspace grants ride every spawn, additively — an approval recorded in
    // the ledger applies to the next run without touching profiles.
    const granted = (await this.grantsResolver?.().catch(() => [])) ?? [];
    const permissionMode = await this.gatedPermissionMode(run, params.permissionMode);
    const args =
      provider === "codex"
        ? codexExecArgs({
            model: params.model,
            resumeSessionId: params.resumeSessionId,
            permissionMode,
          })
        : claudeRunArgs({
            model: params.model,
            resumeSessionId: params.resumeSessionId,
            mcpConfigPath: mcpConfig,
            appendSystemPrompt: params.appendSystemPrompt,
            allowedTools: granted.length
              ? [...(params.allowedTools ?? []), ...granted]
              : params.allowedTools,
            disallowedTools: params.disallowedTools,
            permissionMode,
            // Only where the endpoint actually serves the tool — the CLI validates
            // the name against the MCP config at startup and refuses to run.
            permissionPromptTool: mcpConfig && !hubScoped ? PERMISSION_PROMPT_TOOL : null,
          });

    const binName = provider === "codex" ? this.codexBin : this.claudeBin;
    const bin = provider === "codex" ? await this.codexPath() : await this.claudePath();
    const plan = planClaudeSpawn(bin, args);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: cwdAbs,
        shell: plan.shell,
        // Under the desktop app the server has no console — an unhidden
        // cmd.exe would open a visible window per run.
        windowsHide: true,
        // A CLI resolved from outside the inherited PATH (GUI-launched
        // sidecar) must still find its own helpers — put its dir on PATH.
        // The project toolchain rides along too: the agent's own commands
        // (pnpm/node/node_modules/.bin) must resolve from the run's cwd and
        // the workspace root, wherever the server was launched from.
        // claudeSpawnEnv strips only ANTHROPIC_API_KEY — a codex spawn keeps
        // its OPENAI_API_KEY (that is a legitimate way to run the Codex CLI).
        env: envWithBinDir(
          envWithToolchain(agentEnv(claudeSpawnEnv(process.env)), [
            cwdAbs,
            repoCwdAbs,
            this.root,
          ]),
          bin,
        ),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return this.finish(run, "failed", `Failed to spawn ${binName}: ${(err as Error).message}`);
    }

    this.procs.set(run.id, { child, cancelled: false });

    // Wire every handler synchronously, before any await: a failed spawn
    // (nonexistent cwd, missing binary) emits 'error' on the NEXT TICK, and
    // an unhandled 'error' event kills the whole server — this is exactly
    // how the desktop bridge used to die on agent.start.
    child.on("error", (err) => {
      void this.finish(run, "failed", `Failed to spawn ${binName}: ${err.message}`);
    });
    // The CLI exiting before the prompt flushes (instant startup errors)
    // EPIPEs stdin; without a listener that is fatal too. 'close' settles.
    child.stdin.on("error", (err) => {
      this.record(run, { type: "stderr", text: `stdin: ${err.message}` });
    });

    const stdout = new LineBuffer(MAX_STREAM_LINE_BYTES);
    const stderr = new LineBuffer(MAX_STREAM_LINE_BYTES);
    // Codex streams a different JSONL vocabulary — one stateful parser per
    // run normalizes it into the same AgentEvent union Claude's parser emits.
    const codexParser = provider === "codex" ? new CodexStreamParser() : null;
    const parseLine = (line: string) =>
      codexParser ? codexParser.push(line) : parseClaudeStreamLine(line);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of stdout.push(chunk)) {
        for (const event of parseLine(line)) this.record(run, event);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of stderr.push(chunk)) {
        this.record(run, { type: "stderr", text: line });
      }
    });

    child.on("close", (code) => {
      for (const line of stdout.flush()) {
        for (const event of parseLine(line)) this.record(run, event);
      }
      const proc = this.procs.get(run.id);
      // finish() always runs on close: it records the terminal status event and
      // persists the run. The fallback status only applies if no `result` event
      // already settled the run.
      const fallback: AgentRun["status"] = proc?.cancelled
        ? "cancelled"
        : code === 0
          ? "completed"
          : "failed";
      void this.finish(run, fallback, run.resultText ?? `${binName} exited with code ${code}`);
    });

    // Prompt goes over stdin — no shell quoting of user text, ever. Specialist
    // skills ride along as a trailing directive.
    let prompt = params.prompt;
    if (params.skills?.length) {
      prompt += `\n\nUse these skills where relevant: ${params.skills.map((s) => `/${s}`).join(", ")}.`;
    }
    if (mcpConfig && run.role !== "manager" && run.taskId) {
      prompt +=
        "\n\nYour work is tracked on a Crystal board task. Use your mcp__crystal__* tools: " +
        "my_task (its details and acceptance criteria), update_my_task (move its status as " +
        "you progress — in_progress when you start, review when done and green), and " +
        "ask_question (escalate a decision to the human owner without stopping other work).";
    }
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      // Stream already torn down by a failed spawn — 'error'/'close' settle.
      this.record(run, { type: "stderr", text: `stdin: ${(err as Error).message}` });
    }

    run.status = "running";
    run.startedAt = nowIso();
    this.emitRunChanged(run);
    // Persist the live run now: if the server dies mid-run, ensureLoaded()
    // still finds the record and settles it as failed instead of the run
    // (and any chained work watching it) vanishing without a trace.
    await this.persist(run);

    return run;
  }

  /**
   * Register an interactive run and plan its spawn — the native Claude TUI on
   * a PTY instead of a headless `-p` process. The caller (server.ts) creates
   * the hosting terminal from the returned plan, binds it with
   * {@link bindInteractive}, and types the returned prompt into it. The run
   * record exists before the TUI boots so its MCP endpoint resolves from the
   * first tool call.
   */
  async prepareInteractive(params: InteractiveStartParams): Promise<InteractiveSpawn> {
    if (this.disposed) throw new Error("Workspace is closed — no new agent runs.");
    await this.ensureLoaded();
    if (!params.resumeRunId) return this.prepareInteractiveRun(params, null, null);

    const fromRunId = params.resumeRunId;
    const initial = this.resolveResumeChain(fromRunId);
    const rootId = initial?.rootId ?? this.forwardedChainRoot(chainRootId(fromRunId, this.runs));
    return this.serializeResume(rootId, async () => {
      const resolution = this.resolveResumeChain(fromRunId);
      if (!resolution) throw new Error(`Unknown run: ${fromRunId}`);
      const live = resolution.sessionId
        ? [...this.runs.values()].find(
            (run) =>
              run.sessionId === resolution.sessionId &&
              (run.status === "running" || run.status === "queued"),
          )
        : resolution.chain.find((run) => run.status === "running" || run.status === "queued");
      if (live) {
        throw new Error(
          `Session ${resolution.sessionId ?? resolution.rootId} has a live run (${live.id}) — resuming now would fork it. ` +
            `Deliver via agent.message instead, or wait for the run to settle.`,
        );
      }
      if (resolution.latest.status === "cancelled") {
        throw new Error(`Run ${fromRunId}'s session was cancelled and cannot be resumed.`);
      }
      if (!resolution.sessionId) {
        throw new Error(`Run ${fromRunId} has no session id to resume.`);
      }

      // Re-resolve the chain's profile because its flags are per invocation.
      // The caller's prompt/profile fields are deliberately ignored: this is
      // the same conversation reopening in a PTY, not a freshly seeded task.
      const overlay = resolution.root.agentId
        ? await this.profileResolver?.(resolution.root.agentId).catch(() => null)
        : null;
      const resumedParams: InteractiveStartParams = {
        prompt: resolution.root.prompt,
        cwd: resolution.root.cwd,
        taskId: resolution.root.taskId,
        projectId: resolution.root.projectId,
        repoId: resolution.root.repoId,
        agentId: resolution.root.agentId,
        provider: resolution.latest.provider ?? resolution.root.provider ?? null,
        model: resolution.latest.model ?? resolution.root.model ?? null,
        appendSystemPrompt: overlay?.appendPrompt ?? null,
        allowedTools: overlay?.allowedTools,
        disallowedTools: overlay?.disallowedTools,
        permissionMode: overlay?.permissionMode ?? null,
        role: resolution.root.role === "manager" ? "manager" : null,
        purpose: resolution.root.purpose,
        tags: resolution.root.tags,
        costCapUsd: resolution.latest.costCapUsd ?? resolution.root.costCapUsd ?? null,
      };
      return this.withResumeWorktree(resolution, (worktree) =>
        this.prepareInteractiveRun(resumedParams, resolution, worktree),
      );
    });
  }

  private async prepareInteractiveRun(
    params: InteractiveStartParams,
    resume: ResumeChainResolution | null,
    worktree: ResumeWorktreeResolution | null,
  ): Promise<InteractiveSpawn> {
    const presetModel = await this.presetModelFor(params);
    if (presetModel) params = { ...params, ...presetModel };
    const run = createAgentRun({
      ...params,
      resumedFromRunId: resume?.latest.id ?? null,
      costCapUsd: params.costCapUsd ?? null,
    });
    const provider = params.provider === "codex" ? "codex" : "claude";
    // A known session id (--session-id) keeps the chain resumable headlessly
    // once the terminal closes — the TUI emits no stream-json to learn it
    // from. Codex has no such flag: its thread id is never learnable from the
    // TUI, so an interactive codex chain is not headlessly resumable after
    // its terminal exits (recorded on the run by the null sessionId).
    if (resume?.sessionId) run.sessionId = resume.sessionId;
    else if (provider !== "codex") run.sessionId = randomUUID();
    run.model = params.model ?? null;
    if (worktree?.adoptPath) {
      run.isolation = "worktree";
      run.worktreePath = worktree.adoptPath;
      run.branch = resume?.worktreeHolder?.branch ?? null;
    }
    this.runs.set(run.id, run);
    this.indexTags(run);
    this.runEvents.set(run.id, []);
    if (worktree?.adoptPath) {
      this.record(run, {
        type: "status",
        status: "queued",
        message: `Continuing in worktree: ${worktree.adoptPath}${run.branch ? ` (branch ${run.branch})` : ""}`,
      });
    } else if (worktree?.sourcePath) {
      this.record(run, {
        type: "stderr",
        text: worktree.contested
          ? `Chain worktree ${worktree.sourcePath} is in use by a live run — this turn resumed in the repo checkout instead.`
          : `Chain worktree ${worktree.sourcePath} no longer exists — this turn resumed in the repo checkout.`,
      });
    }

    const mcpConfig =
      provider !== "codex" && (run.role === "manager" || run.taskId)
        ? await this.writeMcpConfig(run.id)
        : null;
    // Same grants injection as headless spawns — the ledger is workspace
    // policy, and an interactive session is still an agent run.
    const grantedInteractive = (await this.grantsResolver?.().catch(() => [])) ?? [];
    const args =
      provider === "codex"
        ? codexInteractiveArgs({
            model: params.model,
            resumeSessionId: resume?.sessionId,
            permissionMode: await this.gatedPermissionMode(run, params.permissionMode),
          })
        : claudeInteractiveArgs({
            model: params.model,
            sessionId: resume ? null : run.sessionId,
            resumeSessionId: resume?.sessionId,
            mcpConfigPath: mcpConfig,
            appendSystemPrompt: params.appendSystemPrompt,
            allowedTools: grantedInteractive.length
              ? [...(params.allowedTools ?? []), ...grantedInteractive]
              : params.allowedTools,
            disallowedTools: params.disallowedTools,
            permissionMode: await this.gatedPermissionMode(run, params.permissionMode),
          });
    const bin = provider === "codex" ? await this.codexPath() : await this.claudePath();

    let prompt = resume ? "" : params.prompt;
    if (!resume && params.skills?.length) {
      prompt += `\n\nUse these skills where relevant: ${params.skills.map((s) => `/${s}`).join(", ")}.`;
    }
    if (!resume && mcpConfig && run.role !== "manager" && run.taskId) {
      prompt += INTERACTIVE_TASK_NOTE;
    }

    const cwdAbs = worktree?.adoptPath ?? resolveInRoot(this.root, run.cwd ?? ".");

    return {
      run: { ...run },
      file: bin,
      args,
      env: envWithBinDir(
        envWithToolchain(agentEnv(stripApiKey(process.env)), [
          cwdAbs,
          this.root,
        ]),
        bin,
      ),
      cwd: cwdAbs,
      prompt,
    };
  }

  /** Attach a prepared interactive run to the terminal now hosting it. */
  async bindInteractive(
    runId: string,
    terminalId: string,
    terminalWs: string | null = null,
  ): Promise<AgentRun> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    run.terminalId = terminalId;
    run.terminalWs = terminalWs;
    run.status = "running";
    run.startedAt = nowIso();
    this.record(run, {
      type: "status",
      status: "running",
      message: `Interactive session in terminal ${terminalId}`,
    });
    this.emitRunChanged(run);
    await this.persist(run);
    // Deliveries queued during the TUI's mount window flush once it is ready.
    const flushTimer = setTimeout(
      () => void this.flushInteractiveQueue(run.id),
      this.interactiveReadyMs + 100,
    );
    flushTimer.unref?.();
    return { ...run };
  }

  /**
   * A terminal hosting an interactive run exited — settle the run. Exit code 0
   * (the owner ended the session) completes it; anything else failed. Settling
   * flushes the chain's queued notices, which now resume it *headlessly* via
   * the session id the terminal was launched with.
   */
  async settleInteractive(terminalId: string, exitCode: number | null): Promise<void> {
    await this.ensureLoaded();
    for (const run of this.runs.values()) {
      if (run.terminalId !== terminalId || run.endedAt) continue;
      // Harvest BEFORE finish: the terminal runChanged from finish() is what
      // the settle hooks claim (once) to bill the task/epic — usage arriving
      // after it would never reach a cost rollup.
      const transcriptFound = await this.harvestInteractiveUsage(run);
      // A TUI that failed without ever writing a transcript never became a
      // session: the pinned --session-id points at nothing, and a `--resume`
      // of it would consume queued deliveries into a turn that can only die.
      // Unpin so the chain reads as unresumable and deliveries stay queued
      // (exit 0 keeps today's benefit of the doubt — a clean exit with a
      // cleaned-up transcript is still a session the CLI may know).
      if (!transcriptFound && exitCode !== 0) run.sessionId = null;
      await this.finish(
        run,
        exitCode === 0 ? "completed" : "failed",
        `Interactive session ended (exit ${exitCode ?? "?"})`,
      );
    }
  }

  /**
   * Best-effort: fill an interactive run's usage/model from its Claude
   * transcript. Returns whether a transcript existed at all — absence after
   * the terminal exits is the one signal that the session never materialized.
   */
  private async harvestInteractiveUsage(run: AgentRun): Promise<boolean> {
    if (!run.sessionId) return false;
    // Codex writes no ~/.claude transcript — nothing to harvest, and absence
    // must not be read as "the session never existed".
    if (run.provider === "codex") return true;
    try {
      const projectsDir = path.join(os.homedir(), ".claude", "projects");
      const name = `${run.sessionId}.jsonl`;
      const cwdAbs = resolveInRoot(this.root, run.cwd);
      let text = await fs
        .readFile(path.join(projectsDir, claudeProjectDirName(cwdAbs), name), "utf8")
        .catch(() => null);
      // A hub manager's terminal runs cwd'd in a *workspace* while this
      // manager's root is the hub dir — when the direct guess misses, scan:
      // session ids are unique, so the first hit is the transcript.
      if (text == null) {
        for (const dir of await fs.readdir(projectsDir).catch(() => [] as string[])) {
          text = await fs.readFile(path.join(projectsDir, dir, name), "utf8").catch(() => null);
          if (text != null) break;
        }
      }
      if (text == null) return false;
      const { usage, model } = transcriptUsage(text);
      if (usage.apiCalls) {
        run.usage = usage;
        run.model ??= model;
      }
      // No emit/persist here — this runs just before finish(), whose terminal
      // broadcast and persist carry the harvested usage along.
      return true;
    } catch {
      // No transcript (stub binary in tests, cleaned history) — the run
      // simply reads as costless rather than failing settlement.
      return false;
    }
  }

  /**
   * Type `text` into the live interactive terminal of the chain containing
   * `runId`, if there is one. Returns that run on success, null otherwise —
   * the caller falls back to queue/resume delivery. Landing input in the TUI
   * is the whole point of interactive sessions: the TUI queues input arriving
   * mid-turn itself, so unlike `--resume` this can never fork the session.
   */
  async deliverInteractive(runId: string, text: string): Promise<AgentRun | null> {
    await this.ensureLoaded();
    for (const id of this.chainIds(chainRootId(runId, this.runs))) {
      const run = this.runs.get(id);
      if (!run?.terminalId || run.endedAt || run.status !== "running") continue;
      // A TUI still mounting would mangle the paste (and swallow it while
      // claiming delivery) — before the ready gate, callers queue instead;
      // bindInteractive schedules a flush for the moment the gate opens.
      if (run.startedAt && Date.now() - Date.parse(run.startedAt) < this.interactiveReadyMs) {
        return null;
      }
      if (this.interactiveInput?.({ ...run }, text)) return { ...run };
    }
    return null;
  }

  /**
   * Deliver anything queued on an interactive chain the moment its TUI is
   * ready — messages arriving in the mount window (a hub question sweep fires
   * on any board write) queue rather than mangle, and without this they would
   * wait for session end.
   */
  private async flushInteractiveQueue(runId: string): Promise<void> {
    const rootId = chainRootId(runId, this.runs);
    await this.pendingNotices.drain(rootId, (notices) =>
      this.deliverInteractive(rootId, composeNoticePrompt(notices)),
    );
  }

  /**
   * Give a worktree-isolated run its working directory. Branchless runs get
   * a fresh detached worktree. Branch-bound runs (workflow tracks) treat the
   * branch as an identity: successive workers on the same branch
   * (develop → fix → fix) continue in the *same* worktree so uncommitted
   * work carries over and the checked-out branch can't block a follow-up —
   * with only ever one live worker per branch, and acquisition serialized
   * per repo+branch so two concurrent dispatches can't both race
   * `git worktree add` for the same branch.
   */
  private async acquireWorktree(run: AgentRun, repoAbs: string): Promise<string> {
    const acquire = async (): Promise<string> => {
      const adopted = run.branch ? await this.adoptTrackWorktree(run) : null;
      if (adopted) {
        run.worktreePath = adopted;
        this.record(run, {
          type: "status",
          status: "queued",
          message: `Continuing in track worktree: ${adopted} (branch ${run.branch})`,
        });
        return adopted;
      }
      const worktree = path.join(this.dataDir, "worktrees", run.id);
      await fs.mkdir(path.dirname(worktree), { recursive: true });
      if (run.branch) {
        // Named-branch worktree: check the branch out if it exists, create
        // it at HEAD otherwise.
        try {
          await runGit(repoAbs, ["worktree", "add", worktree, run.branch]);
        } catch {
          await runGit(repoAbs, ["worktree", "add", "-b", run.branch, worktree]);
        }
      } else {
        await runGit(repoAbs, ["worktree", "add", "--detach", worktree]);
      }
      run.worktreePath = worktree;
      this.record(run, {
        type: "status",
        status: "queued",
        message: `Isolated worktree: ${worktree}${run.branch ? ` (branch ${run.branch})` : ""}`,
      });
      return worktree;
    };
    if (!run.branch) return acquire();
    const key = `${run.cwd}\0${run.branch}`;
    const prev = this.branchLocks.get(key) ?? Promise.resolve();
    const task = prev.then(acquire, acquire);
    this.branchLocks.set(key, task.catch(() => {}));
    return task;
  }

  /**
   * The existing worktree a branch-bound run should continue in: the most
   * recent run on the same repo+branch whose worktree still exists (a branch
   * name is only an identity within one repo — same-named branches in other
   * repos must not cross-adopt). Throws when a live run holds the branch —
   * two concurrent workers must never share a track. Null when there is
   * nothing to adopt (fresh track).
   */
  private async adoptTrackWorktree(run: AgentRun): Promise<string | null> {
    const holders = [...this.runs.values()]
      .filter(
        (r) =>
          r.id !== run.id && r.branch === run.branch && r.cwd === run.cwd && r.worktreePath,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const live = holders.find((r) => r.status === "running" || r.status === "queued");
    if (live) {
      throw new Error(`Branch ${run.branch} is in use by live worker ${live.id}`);
    }
    for (const holder of holders) {
      if (await fs.access(holder.worktreePath!).then(() => true, () => false)) {
        return holder.worktreePath!;
      }
    }
    return null;
  }

  /**
   * Continue in another run's existing worktree (conflict resolution,
   * follow-up work on the same tree). Synchronous on purpose: the check for a
   * live sharer and the adoption must not be separated by an await, or two
   * concurrent starts could both adopt the same tree.
   */
  private adoptRunWorktree(run: AgentRun, ofRunId: string): string {
    const owner = this.runs.get(ofRunId);
    if (!owner?.worktreePath) {
      throw new Error(`Run ${ofRunId} has no worktree to continue in.`);
    }
    const live = this.liveWorktreeSharer(owner.worktreePath, run.id);
    if (live) {
      throw new Error(`Worktree is in use by live run ${live.id} — wait for it to settle.`);
    }
    run.isolation = "worktree";
    run.worktreePath = owner.worktreePath;
    run.branch = owner.branch ?? null;
    this.record(run, {
      type: "status",
      status: "queued",
      message: `Continuing in worktree of run ${ofRunId}: ${owner.worktreePath}`,
    });
    return owner.worktreePath;
  }

  /** A live run using `worktreePath` (excluding `excludeRunId`), if any. */
  private liveWorktreeSharer(worktreePath: string, excludeRunId?: string): AgentRun | null {
    return (
      [...this.runs.values()].find(
        (r) =>
          r.id !== excludeRunId &&
          r.worktreePath === worktreePath &&
          (r.status === "running" || r.status === "queued"),
      ) ?? null
    );
  }

  /** Run ids in one logical manager's resume chain (root + every wake-up turn). */
  private chainIds(rootId: string): Set<string> {
    const ids = new Set<string>([rootId]);
    for (const r of this.runs.values()) {
      if (chainRootId(r.id, this.runs) === rootId) ids.add(r.id);
    }
    return ids;
  }

  /**
   * Workers dispatched by a manager across its whole resume chain — a worker
   * dispatched before a wake-up still belongs to the woken manager.
   */
  async listWorkersFor(managerRunId: string): Promise<AgentRun[]> {
    await this.ensureLoaded();
    const chain = this.chainIds(chainRootId(managerRunId, this.runs));
    return [...this.runs.values()]
      .filter((r) => r.parentRunId && chain.has(r.parentRunId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** The runs of one chain root, oldest first (see chainRuns). */
  private orderedChain(rootId: string): AgentRun[] {
    return [...this.chainIds(rootId)]
      .map((id) => this.runs.get(id))
      .filter((r): r is AgentRun => !!r)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Resolve every spawn-critical value of a resume chain in one place. */
  private resolveResumeChain(fromRunId: string): ResumeChainResolution | null {
    const rootId = this.forwardedChainRoot(chainRootId(fromRunId, this.runs));
    const chain = this.orderedChain(rootId);
    const root = chain[0];
    const latest = chain[chain.length - 1];
    if (!root || !latest) return null;
    return {
      rootId,
      chain,
      root,
      latest,
      sessionId: [...chain].reverse().find((run) => run.sessionId)?.sessionId ?? null,
      worktreeHolder: [...chain].reverse().find((run) => run.worktreePath) ?? null,
    };
  }

  /** Serialize any fresh invocation of one session, headless or interactive. */
  private serializeResume<T>(rootId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.resumeLocks.get(rootId) ?? Promise.resolve();
    const attempt = previous.then(action, action);
    this.resumeLocks.set(rootId, attempt.catch(() => {}));
    return attempt;
  }

  /**
   * Resolve and lock the working copy used by a resume. Branch worktrees are
   * shared track identities, so their adopt check and run registration must
   * happen under the same lock used by fresh track dispatches.
   */
  private withResumeWorktree<T>(
    resolution: ResumeChainResolution,
    action: (worktree: ResumeWorktreeResolution) => Promise<T>,
  ): Promise<T> {
    const resolveAndRun = async (): Promise<T> => {
      const sourcePath = resolution.worktreeHolder?.worktreePath ?? null;
      const contested = sourcePath
        ? [...this.runs.values()].some(
            (run) =>
              run.worktreePath === sourcePath &&
              (run.status === "running" || run.status === "queued"),
          )
        : false;
      const worktreeExists =
        sourcePath != null && (await fs.access(sourcePath).then(() => true, () => false));
      return action({
        sourcePath,
        adoptPath: sourcePath && worktreeExists && !contested ? sourcePath : null,
        contested,
      });
    };

    const holder = resolution.worktreeHolder;
    if (!holder?.branch) return resolveAndRun();
    const key = `${holder.cwd}\0${holder.branch}`;
    const previous = this.branchLocks.get(key) ?? Promise.resolve();
    const task = previous.then(resolveAndRun, resolveAndRun);
    this.branchLocks.set(key, task.catch(() => {}));
    return task;
  }

  /**
   * Every run of one logical session's resume chain (root and each wake-up /
   * user-message turn), oldest first — the workflow engine reads a manager's
   * interactive session through this.
   */
  async chainRuns(runId: string): Promise<AgentRun[]> {
    await this.ensureLoaded();
    return this.orderedChain(chainRootId(runId, this.runs));
  }

  /** True while any run of the chain containing `runId` is queued/running. */
  async isChainLive(runId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.chainLive(chainRootId(runId, this.runs));
  }

  /**
   * Resume a logical session's chain with a new turn — the single primitive
   * every wake-up path uses (worker-settlement notices here, workflow user
   * messages in the WorkflowEngine). Attempts are serialized per chain root
   * and liveness is re-checked inside the lock, so two callers racing one
   * settlement event can never fork the Claude session with concurrent
   * `--resume`s. Returns the resumed run, or null when the chain cannot be
   * resumed right now (a turn is live, no session id yet, or the latest turn
   * was cancelled) — callers keep their payload queued and retry on the next
   * settlement.
   */
  async resumeChain(fromRunId: string, prompt: string): Promise<AgentRun | null> {
    await this.ensureLoaded();
    const initial = this.resolveResumeChain(fromRunId);
    const rootId = initial?.rootId ?? this.forwardedChainRoot(chainRootId(fromRunId, this.runs));
    return this.serializeResume(rootId, async (): Promise<AgentRun | null> => {
      const resolution = this.resolveResumeChain(fromRunId);
      if (
        !resolution ||
        this.chainLive(resolution.rootId) ||
        resolution.latest.status === "cancelled" ||
        !resolution.sessionId
      ) {
        return null;
      }
      // Re-resolve the chain's profile policy: --append-system-prompt and the
      // tool flags are per-invocation, so a resumed turn that omitted them
      // would silently shed the profile's standing behavior mid-conversation.
      const overlay = resolution.root.agentId
        ? await this.profileResolver?.(resolution.root.agentId).catch(() => null)
        : null;
      return this.withResumeWorktree(resolution, async (worktree): Promise<AgentRun | null> => {
        const { root, latest, sessionId } = resolution;
        const run = await this.start({
          prompt,
          cwd: root.cwd,
          taskId: root.taskId,
          projectId: root.projectId,
          repoId: root.repoId,
          resumeSessionId: sessionId,
          resumedFromRunId: latest.id,
          agentId: root.agentId,
          // A resumed turn re-enters the SAME session — it must stay on the
          // chain's CLI vendor (codex resumes via `codex exec resume`).
          provider: latest.provider ?? root.provider ?? null,
          // Resumed turns stay on the chain's model — the CLI would otherwise
          // fall back to its configured default mid-conversation.
          model: latest.model ?? root.model ?? null,
          appendSystemPrompt: overlay?.appendPrompt ?? null,
          allowedTools: overlay?.allowedTools,
          disallowedTools: overlay?.disallowedTools,
          permissionMode: overlay?.permissionMode ?? null,
          role: root.role === "manager" ? "manager" : null,
          purpose: root.purpose,
          tags: root.tags,
          isolation: worktree.adoptPath ? "worktree" : undefined,
          adoptWorktreePath: worktree.adoptPath,
          branch: worktree.adoptPath ? (resolution.worktreeHolder?.branch ?? null) : null,
          // A resumed turn is the same conversation under the same policy —
          // the cap the chain started with binds every later turn too.
          costCapUsd: latest.costCapUsd ?? root.costCapUsd ?? null,
        });
        if (worktree.sourcePath && !worktree.adoptPath) {
          // Falling back to the repo checkout is visible, never silent — the
          // session's earlier edits stay in the worktree it could not enter.
          this.record(run, {
            type: "stderr",
            text: worktree.contested
              ? `Chain worktree ${worktree.sourcePath} is in use by a live run — this turn resumed in the repo checkout instead.`
              : `Chain worktree ${worktree.sourcePath} no longer exists — this turn resumed in the repo checkout.`,
          });
        }
        return run;
      });
    });
  }

  /* ---------------- context handoff (session lineage) ---------------- */

  /**
   * Hand a finished (typically context-overflowed) session's work off to a
   * FRESH session: a cheap summarizer run condenses the transcript into a
   * handoff note, then a continuation run starts with the original prompt +
   * the note — in the same worktree when the old run had one, so uncommitted
   * work carries over. Summaries accumulate across generations because each
   * continuation's prompt embeds all prior notes.
   *
   * Returns the continuation run (the summarizer run is tracked but not
   * returned — it exists to be billed and inspectable, not followed).
   */
  async handoff(runId: string, opts: { targetAgentId?: string | null } = {}): Promise<AgentRun> {
    await this.ensureLoaded();
    const rootId = chainRootId(runId, this.runs);
    if (this.chainLive(rootId)) {
      throw new Error("The session is still live — cancel it or wait before handing off.");
    }
    const chain = this.orderedChain(rootId);
    const root = chain[0];
    const latest = chain[chain.length - 1];
    if (!root || !latest) throw new Error(`Unknown run: ${runId}`);

    const digest = await this.transcriptDigest(chain);
    let summary = "";
    if (digest) {
      const summarizer = await this.start({
        prompt:
          "Condense this agent-session transcript into a handoff note for the fresh session " +
          "that will continue the work. Cover, as terse bullet lists: WHAT WAS DONE (files " +
          "changed, commands run), CURRENT STATE (works / broken / untested), DECISIONS MADE " +
          "(and why), and WHAT REMAINS. No preamble — output only the note.\n\n" +
          "Transcript:\n\n" + digest,
        cwd: root.cwd,
        taskId: root.taskId,
        projectId: root.projectId,
        repoId: root.repoId,
        model: HANDOFF_SUMMARY_MODEL,
        purpose: "manage",
        tags: root.tags,
      });
      const settled = await this.waitForSettled(summarizer.id);
      summary = settled.status === "completed" ? (settled.resultText ?? "").trim() : "";
    }
    if (!summary) {
      // A summary that failed must not block recovery — fall back to the tail.
      summary = `(automatic summary unavailable — transcript tail)\n${digest.slice(-HANDOFF_FALLBACK_CHARS)}`;
    }

    // The chain was idle when we started, but the summarizer's settlement could
    // have woken a worker-notice resume of this same chain while we waited.
    // Starting the continuation now would briefly fork the logical session.
    if (this.chainLive(rootId)) {
      throw new Error("The session became active again while preparing the handoff — retry.");
    }

    // A fresh session is a fresh set of CLI invocations — the chain's profile
    // policy (standing prompt, tool rules) must ride along or fall off here.
    // A TARGET profile reroutes the continuation to a different agent —
    // possibly a different CLI vendor entirely; the summarize-and-reseed shape
    // is exactly what makes that safe (no session continuity is assumed).
    const targetId = opts.targetAgentId ?? root.agentId ?? null;
    const overlay = targetId
      ? await this.profileResolver?.(targetId).catch(() => null)
      : null;
    const retargeted = Boolean(opts.targetAgentId && opts.targetAgentId !== root.agentId);
    if (opts.targetAgentId && !overlay) {
      throw new Error(`Unknown agent profile: ${opts.targetAgentId}`);
    }
    const continuation = await this.start({
      prompt:
        `${root.prompt}\n\n---\n[Context handoff] A previous session worked on this task` +
        (retargeted ? " and it is now being handed to you" : " until its context filled up") +
        `. Its handoff note:\n\n${summary}\n\n` +
        `Continue from where it left off. Verify the current state (files, git status) before ` +
        `redoing anything — work may already be complete on disk.`,
      cwd: root.cwd,
      taskId: root.taskId,
      projectId: root.projectId,
      repoId: root.repoId,
      agentId: targetId,
      provider: retargeted ? (overlay?.provider ?? null) : (latest.provider ?? root.provider ?? null),
      model: retargeted ? (overlay?.model ?? null) : (latest.model ?? root.model ?? null),
      appendSystemPrompt: overlay?.appendPrompt ?? null,
      allowedTools: overlay?.allowedTools,
      disallowedTools: overlay?.disallowedTools,
      permissionMode: overlay?.permissionMode ?? null,
      role: root.role === "manager" ? "manager" : null,
      purpose: root.purpose,
      tags: root.tags,
      costCapUsd: latest.costCapUsd ?? root.costCapUsd ?? null,
      handoffFromRunId: latest.id,
      // Same tree: uncommitted work survives the generation boundary.
      ...(latest.worktreePath ? { worktreeOfRunId: latest.id } : {}),
    });
    const continuationRoot = chainRootId(continuation.id, this.runs);
    this.pendingNotices.move(rootId, continuationRoot);
    if (this.pendingNotices.size(continuationRoot) && !this.chainLive(continuationRoot)) {
      void this.flushNotices(continuationRoot);
    }
    this.onHandoff?.(latest, continuation);
    return continuation;
  }

  /** Flatten a chain's persisted events into a capped transcript digest. */
  private async transcriptDigest(chain: AgentRun[]): Promise<string> {
    const parts: string[] = [];
    for (const run of chain) {
      for (const { event } of await this.eventsFor(run.id)) {
        if (event.type === "text") parts.push(event.text);
        else if (event.type === "tool_use") parts.push(`[tool: ${event.name}]`);
        else if (event.type === "result" && event.resultText) parts.push(`[result] ${event.resultText}`);
      }
    }
    const full = parts.join("\n");
    if (full.length <= HANDOFF_DIGEST_CHARS) return full;
    // Head + tail: the opening context frames the task, the tail is the state.
    const head = full.slice(0, HANDOFF_DIGEST_HEAD_CHARS);
    const tail = full.slice(-(HANDOFF_DIGEST_CHARS - HANDOFF_DIGEST_HEAD_CHARS));
    return `${head}\n… (transcript truncated) …\n${tail}`;
  }

  /**
   * Deliver `prompt` into a session, whatever it is doing. Idle chains take it
   * immediately; a chain mid-turn has it queued and flushed the moment the
   * turn settles — two concurrent `--resume`s of one session would fork it.
   *
   * This is the primitive behind every "tell an agent something" path (worker
   * results, workflow steering, a question's answer). Using it instead of a
   * bare `resumeChain` is what keeps a message from being silently dropped
   * because the agent happened to be busy — agents are explicitly told not to
   * block waiting for answers, so busy is the *normal* case.
   */
  async deliver(runId: string, prompt: string): Promise<AgentRun | null> {
    return (await this.deliverToChain(runId, prompt)).run;
  }

  /**
   * {@link deliver}, with the outcome made explicit for callers that surface
   * it (question answers, run steering). `resumed` covers both a fresh
   * `--resume` turn and a live interactive TUI taking the text directly;
   * `queued` means the settle flush will carry it; `recorded` means the text
   * can never be delivered (cancelled chain, or a settled session that never
   * materialized) and the caller should treat the durable record (board
   * answer) as the outcome.
   *
   * LOCKSTEP: `questionDeliverability` in core/question-liveness.ts is the
   * pure read-side twin of this resolution (chain root via resumedFromRunId,
   * handoff forwarding via forwardedChainRoot, the same "recorded" verdicts).
   * A change to the chain walk here must be mirrored there.
   */
  async deliverToChain(
    fromRunId: string,
    text: string,
  ): Promise<{ run: AgentRun | null; status: "resumed" | "queued" | "recorded" }> {
    await this.ensureLoaded();
    const rootId = this.forwardedChainRoot(chainRootId(fromRunId, this.runs));
    const chain = this.orderedChain(rootId);
    const latest = chain[chain.length - 1];
    if (
      !latest ||
      latest.status === "cancelled" ||
      (!this.chainLive(rootId) && !chain.some((r) => r.sessionId))
    ) {
      return { run: null, status: "recorded" };
    }
    // A live interactive terminal takes the message directly — typed into the
    // TUI, which handles mid-turn input by queueing it natively.
    const interactive = await this.deliverInteractive(rootId, text);
    if (interactive) return { run: interactive, status: "resumed" };
    // A broken login means the resume attempt would just burn a failed run —
    // park immediately; the queue flushes when a success clears the flag.
    if (this.authBrokenDetail == null) {
      const run = await this.resumeChain(rootId, text);
      if (run) return { run, status: "resumed" };
      if (!this.chainLive(rootId)) return { run: null, status: "recorded" };
    }
    this.pendingNotices.push(rootId, { kind: "message", text });
    return { run: null, status: "queued" };
  }

  /**
   * User steering for any run — frames the text and delivers it into the
   * run's session via {@link deliverToChain} (the workflow manager has its
   * own framing in workflow-engine.ts; this is the generic-run counterpart).
   */
  messageRun(
    runId: string,
    text: string,
  ): Promise<{ run: AgentRun | null; status: "resumed" | "queued" | "recorded" }> {
    return this.deliverToChain(
      runId,
      `USER MESSAGE:\n${text.trim()}\n\nThis is steering from the run's owner. Address it and continue the task.`,
    );
  }

  /**
   * Surface an MCP-raised question on the run's live event stream (the board
   * copy is filed separately by the caller — see mcp/http.ts).
   */
  noteQuestion(runId: string, text: string, ask?: AskOptions): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.record(run, {
      type: "question",
      text,
      ...(ask?.options?.length ? { options: ask.options } : {}),
      ...(ask?.recommended ? { recommended: ask.recommended } : {}),
    });
  }

  /**
   * Surface a permission-broker state change on the run's live event stream
   * (pending → the UI shows "run X wants tool Y"; allowed/denied closes it).
   */
  notePermission(
    runId: string,
    event: { tool: string; state: "pending" | "allowed" | "denied"; detail?: string },
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.record(run, { type: "permission", ...event });
  }

  /** True while any live run carries `tag` — no copy, no sort, early exit. */
  async hasLiveRunTagged(tag: string): Promise<boolean> {
    await this.ensureLoaded();
    const ids = this.runsByTag.get(tag);
    if (!ids) return false;
    for (const id of ids) {
      const status = this.runs.get(id)?.status;
      if (status === "running" || status === "queued") return true;
    }
    return false;
  }

  /** A run record by id (workers hand their results to managers through this). */
  async get(runId: string): Promise<AgentRun | null> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  /**
   * Spawn a worker run on behalf of a manager. The worker is parented to the
   * manager (`parentRunId` + role "worker") and inherits its cwd/repo/task when
   * the spec omits them. Two guards keep a runaway manager from fork-bombing:
   * only manager/standalone runs may dispatch (workers can't, so the tree stays
   * one level deep), and each manager chain is capped at
   * {@link MAX_WORKERS_PER_MANAGER}. Returns null when a guard rejects the
   * dispatch.
   */
  async dispatchWorker(managerRunId: string, spec: WorkerSpec): Promise<AgentRun | null> {
    await this.ensureLoaded();
    const manager = this.runs.get(managerRunId);
    if (!manager || manager.role === "worker") return null;
    // Workflow attribution is inherited, not opt-in: every worker a workflow
    // manager dispatches bills the workflow, whatever tags the spec carried.
    // Inherited tags come FIRST and spec-supplied workflow tags are dropped —
    // attribution resolves to the first `workflow:` tag, and a stray one in
    // the spec must not divert the worker's spend to another workflow.
    const inherited = manager.tags.filter(isWorkflowTag);
    const tags = [
      ...new Set([...inherited, ...(spec.tags ?? []).filter((t) => !isWorkflowTag(t))]),
    ];
    const cap = inherited.length ? MAX_WORKERS_PER_WORKFLOW : MAX_WORKERS_PER_MANAGER;
    if ((await this.listWorkersFor(managerRunId)).length >= cap) return null;
    // The guard (workflow pause / exhausted budget) throws so the manager
    // sees *why* the dispatch was refused, not just that it was.
    const veto = await this.dispatchGuard?.(manager, spec);
    if (veto) throw new Error(veto);
    // A spec naming an agentId runs as that profile; anything the spec sets
    // explicitly (model above all) wins over the profile's own values, and
    // the manager's purpose stays the last fallback exactly as before.
    const overlay =
      spec.agentId && this.profileResolver
        ? await this.profileResolver(spec.agentId, {
            purpose: spec.purpose ?? null,
          }).catch(() => null)
        : null;
    const merged = applyProfileOverlay(
      {
        prompt: spec.prompt,
        cwd: spec.cwd ?? manager.cwd,
        repoId: manager.repoId,
        taskId: spec.taskId ?? manager.taskId,
        projectId: manager.projectId,
        isolation: spec.isolation ?? undefined,
        branch: spec.branch ?? null,
        model: spec.model ?? null,
        agentId: spec.agentId ?? null,
        parentRunId: managerRunId,
        role: "worker" as const,
        purpose: spec.purpose ?? null,
        tags,
      },
      overlay,
    );
    // The workflow's per-run cap (when one is set) rides every dispatch — a
    // worker is exactly the kind of run the cap exists to bound.
    const costCapUsd = (await this.dispatchCostCap?.(manager).catch(() => null)) ?? null;
    // Policy can change while profile and cap resolution await (most notably
    // workflow.cancel). The last asynchronous step before start must re-check
    // it so a cancelled workflow cannot buy one more worker.
    const finalVeto = await this.dispatchGuard?.(manager, spec);
    if (finalVeto) throw new Error(finalVeto);
    const worker = await this.start({
      ...merged,
      isolation: merged.isolation ?? "none",
      purpose: merged.purpose ?? manager.purpose,
      costCapUsd,
    });
    // Hand the task's lease to the run doing the work (see OrchestrationService).
    this.onWorkerDispatched?.(worker);
    return worker;
  }

  /** Diff of the run's worktree vs its base commit (includes untracked files). */
  async diff(runId: string): Promise<{ diff: string; stat: string; worktreePath: string | null }> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    const worktree = run?.worktreePath;
    if (!run || !worktree || !(await fs.access(worktree).then(() => true, () => false))) {
      return { diff: "", stat: "", worktreePath: null };
    }
    // Register untracked files so they show up in git diff; the worktree is
    // disposable, so touching its index is fine.
    await runGit(worktree, ["add", "--intent-to-add", "-A"]).catch(() => {});
    const [diff, stat] = await Promise.all([
      runGit(worktree, ["diff"]),
      runGit(worktree, ["diff", "--stat"]),
    ]);
    const capped =
      diff.length > MAX_DIFF_BYTES ? diff.slice(0, MAX_DIFF_BYTES) + "\n… diff truncated …" : diff;
    return { diff: capped, stat, worktreePath: worktree };
  }

  /**
   * Land an isolated run's changes as a branch + commit — one click instead
   * of hand-rolled git in a hidden worktree dir. Everything (tracked edits
   * and new files) is committed in the worktree onto `branch`; worktrees
   * share refs with the repo, so the branch is immediately visible there for
   * merge/PR. A detached worktree is moved onto the new branch; a track
   * worktree (already branch-bound) just gets the commit — its branch IS the
   * apply target. The worktree survives (review the branch first; discard is
   * a separate click).
   */
  async applyWorktree(
    runId: string,
    init: { branch?: string | null; message?: string | null } = {},
  ): Promise<{ ok: true; branch: string; commit: string } | { ok: false; reason: string }> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    const worktree = run?.worktreePath;
    if (!run || !worktree || !(await fs.access(worktree).then(() => true, () => false))) {
      return { ok: false, reason: "This run has no worktree (already cleaned up?)." };
    }
    // Same guard as cleanup: a live sharer of the worktree is mid-edit —
    // committing under it would snapshot a half-written tree.
    const live = [...this.runs.values()].find(
      (r) =>
        r.worktreePath === worktree && (r.status === "running" || r.status === "queued"),
    );
    if (live) {
      return { ok: false, reason: `Worktree is in use by live run ${live.id} — wait for it to settle.` };
    }
    try {
      await runGit(worktree, ["add", "-A"]);
      const staged = await runGit(worktree, ["diff", "--cached", "--name-only"]);
      if (!staged.trim()) return { ok: false, reason: "No changes to apply." };
      // A branchless (detached) worktree moves onto the new branch; a track
      // worktree keeps its own branch — that branch is what "apply" means.
      let branch = run.branch ?? null;
      if (!branch) {
        branch = (init.branch ?? "").trim() || `crystal/${run.id}`;
        await runGit(worktree, ["checkout", "-b", branch]);
        run.branch = branch;
      }
      const message =
        (init.message ?? "").trim() ||
        `${run.prompt.split("\n")[0]!.slice(0, 72)}\n\nApplied from Crystal run ${run.id}.`;
      await runGit(worktree, ["commit", "-m", message]);
      const commit = (await runGit(worktree, ["rev-parse", "--short", "HEAD"])).trim();
      this.emitRunChanged(run);
      await this.persist(run);
      return { ok: true, branch, commit };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  /** Remove a run's worktree (discards any unapplied changes in it). */
  async cleanupWorktree(runId: string): Promise<void> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    if (!run?.worktreePath) return;
    const worktreePath = run.worktreePath;
    await this.worktreeOperations.run(worktreePath, async () => {
      // Track worktrees are shared across a branch's successive workers — the
      // directory may be another run's live cwd, and removing it would pull
      // the floor out from under that process.
      const sharers = [...this.runs.values()].filter(
        (r) => r.id !== run.id && r.worktreePath === worktreePath,
      );
      const live = sharers.find((r) => r.status === "running" || r.status === "queued");
      if (live) {
        throw new Error(`Worktree is in use by live run ${live.id} — cancel it first.`);
      }
      const base = resolveInRoot(this.root, run.cwd);
      await runGit(base, ["worktree", "remove", "--force", worktreePath]).catch(async () => {
        // Fall back to manual removal + prune if git refuses (e.g. locked files).
        await fs.rm(worktreePath, { recursive: true, force: true });
        await runGit(base, ["worktree", "prune"]).catch(() => {});
      });
      // Clear every record pointing at the removed directory, not just this
      // run's — a dangling worktreePath would offer diffs of a deleted dir.
      for (const r of [run, ...sharers]) {
        r.worktreePath = null;
        this.emitRunChanged(r);
        await this.persist(r);
      }
    });
  }

  /* ---------------- worktree merge-back ---------------- */

  /** The run's worktree + repo dirs, with existence checks shared by the merge surface. */
  private async worktreeDirs(runId: string): Promise<{ run: AgentRun; repoAbs: string; worktreeAbs: string }> {
    await this.ensureLoaded();
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (!run.worktreePath) throw new Error(`Run ${runId} has no worktree.`);
    if (!(await exists(run.worktreePath))) {
      throw new Error(`Worktree ${run.worktreePath} no longer exists.`);
    }
    return { run, repoAbs: resolveInRoot(this.root, run.cwd), worktreeAbs: run.worktreePath };
  }

  /** Resolve the path, queue behind its current mutation, then revalidate it. */
  private async withWorktreeOperation<T>(
    runId: string,
    operation: (dirs: { run: AgentRun; repoAbs: string; worktreeAbs: string }) => Promise<T>,
  ): Promise<T> {
    const { worktreeAbs } = await this.worktreeDirs(runId);
    return this.worktreeOperations.run(worktreeAbs, async () =>
      operation(await this.worktreeDirs(runId)),
    );
  }

  /** Non-destructive merge prediction for a run's worktree (see worktree-merge.ts). */
  async mergePreview(runId: string, target?: string | null): Promise<MergePreview> {
    const { repoAbs, worktreeAbs } = await this.worktreeDirs(runId);
    return mergePreview(repoAbs, worktreeAbs, target);
  }

  /** Non-destructive target-into-worktree prediction. */
  async syncPreview(runId: string): Promise<SyncPreview> {
    const { repoAbs, worktreeAbs } = await this.worktreeDirs(runId);
    return syncPreview(repoAbs, worktreeAbs);
  }

  /**
   * Land a run's worktree on the target branch (repo's current branch by
   * default). Refused while a live run shares the worktree — landing a tree
   * out from under a working agent invites half-written commits.
   */
  async mergeWorktreeOf(
    runId: string,
    opts: { target?: string | null; message?: string | null },
  ): Promise<MergeResult> {
    return this.withWorktreeOperation(runId, async ({ run, repoAbs, worktreeAbs }) => {
      const live = this.liveWorktreeSharer(worktreeAbs);
      if (live) throw new Error(`Worktree is in use by live run ${live.id} — wait or cancel it.`);
      const headline = promptHeadline(run.prompt, 72) || run.id;
      const result = await mergeWorktree(repoAbs, worktreeAbs, {
        message: opts.message?.trim() || `Merge agent run: ${headline}`,
        commitMessage: `Agent run ${run.id}: ${headline}`,
        target: opts.target,
      });
      this.record(run, {
        type: "status",
        status: run.status,
        message: `Merged into ${result.target} as ${result.mergedCommit.slice(0, 10)}${result.fastForward ? " (fast-forward)" : ""}`,
      });
      this.emitRunChanged(run);
      await this.persist(run);
      return result;
    });
  }

  /** Explicitly sync the merge target into the run's branch/worktree. */
  async syncWorktreeOf(runId: string): Promise<SyncResult> {
    return this.withWorktreeOperation(runId, async ({ run, repoAbs, worktreeAbs }) => {
      const live = this.liveWorktreeSharer(worktreeAbs);
      if (live) throw new Error(`Worktree is in use by live run ${live.id} — wait or cancel it.`);
      const result = await syncWorktree(repoAbs, worktreeAbs);
      if (result.ok) {
        const detail = result.conflicts.length
          ? `Sync from ${result.target} needs resolution in ${result.conflicts.length} file${result.conflicts.length === 1 ? "" : "s"}.`
          : `Synced ${result.target} into the worktree${result.fastForward ? " (fast-forward)" : ""}.`;
        this.record(run, { type: "status", status: run.status, message: detail });
        this.emitRunChanged(run);
        await this.persist(run);
      }
      return result;
    });
  }

  /** Push the run's branch and create or update its open PR. */
  async createPr(runId: string): Promise<CreatePrResult> {
    return this.withWorktreeOperation(runId, async ({ run, repoAbs, worktreeAbs }) => {
      const live = this.liveWorktreeSharer(worktreeAbs);
      if (live) throw new Error(`Worktree is in use by live run ${live.id} — wait or cancel it.`);
      const preview = await mergePreview(repoAbs, worktreeAbs);
      if (!preview.target) {
        return { ok: false, error: preview.reason ?? "Could not resolve the pull request base." };
      }
      const result = await createPullRequest(this.prStore, {
        worktreeAbs,
        base: preview.target,
        runId: run.id,
        prompt: run.prompt,
      });
      if (result.ok) {
        this.record(run, {
          type: "status",
          status: run.status,
          message: `${result.existing ? "Updated" : "Created"} pull request #${result.number}: ${result.url}`,
        });
        this.emitRunChanged(run);
        await this.persist(run);
      }
      return result;
    });
  }

  /**
   * Start AI conflict resolution for a run's worktree: replay the merge the
   * other direction (target into the worktree, standard conflict markers) and
   * dispatch an agent run *in that worktree* to resolve and commit it. After
   * the resolution run settles, the merge lands as a fast-forward.
   */
  async resolveConflicts(
    runId: string,
    target?: string | null,
  ): Promise<{ run: AgentRun; conflicts: string[] }> {
    return this.withWorktreeOperation(runId, async ({ run, repoAbs, worktreeAbs }) => {
      const live = this.liveWorktreeSharer(worktreeAbs);
      if (live) throw new Error(`Worktree is in use by live run ${live.id} — wait or cancel it.`);
      const prep = await prepareConflictResolution(repoAbs, worktreeAbs, {
        commitMessage: `Agent run ${run.id}: work in progress`,
        target,
      });
      if (prep.conflicts.length === 0) {
        // The reverse merge applied clean — nothing for an agent to resolve.
        throw new Error(
          `No conflicts after merging ${prep.target} into the worktree — merge normally now.`,
        );
      }
      const overlay =
        run.agentId && this.profileResolver
          ? await this.profileResolver(run.agentId, { purpose: "merge" }).catch(() => null)
          : null;
      const resolver = await this.start(
        applyProfileOverlay(
          {
            prompt: buildConflictPrompt(prep.target, prep.conflicts),
            cwd: run.cwd,
            taskId: run.taskId,
            projectId: run.projectId,
            repoId: run.repoId,
            agentId: run.agentId,
            purpose: "merge" as const,
            tags: run.tags,
            worktreeOfRunId: runId,
          },
          overlay,
        ),
      );
      return { run: resolver, conflicts: prep.conflicts };
    });
  }

  /** Abort an in-progress conflict resolution in the run's worktree. */
  async abortResolve(runId: string): Promise<void> {
    await this.withWorktreeOperation(runId, async ({ worktreeAbs }) => {
      const live = this.liveWorktreeSharer(worktreeAbs);
      if (live) throw new Error(`Resolution run ${live.id} is live — cancel it first.`);
      await abortConflictResolution(worktreeAbs);
    });
  }

  async cancel(runId: string): Promise<void> {
    const proc = this.procs.get(runId);
    const run = this.runs.get(runId);
    // Interactive runs have no child process of ours — kill their terminal.
    // Settle first: the terminal's exit event must find `endedAt` set, so the
    // run reads cancelled rather than failed.
    if (!proc && run?.terminalId && !run.endedAt) {
      await this.finish(run, "cancelled", "Interactive session cancelled");
      this.interactiveKill?.({ ...run });
      return;
    }
    if (!proc || !run) throw new Error(`No active run ${runId}`);
    proc.cancelled = true;
    // Tree kill: on Windows a shell spawn puts claude under cmd.exe.
    if (proc.child.pid) void killProcessTree(proc.child.pid, { child: proc.child });
    else proc.child.kill("SIGTERM");
  }

  /**
   * Workspace close / server shutdown: kill every live run. Leaving the
   * Claude CLI children alive was how a "cancelled" delivery could still have
   * an orchestrator committing to the repo — and how a later retry put two
   * orchestrators in one project.
   *
   * Runs settle as FAILED, not cancelled — the same rescue `ensureLoaded`
   * applies after a server crash, and deliberately so: `resumeChain` refuses
   * a cancelled chain forever, which would wedge every workflow manager (and
   * its hub delivery's project lock) the moment its workspace closed. A
   * failed chain stays resumable after the workspace reopens. The manager
   * itself stops spawning: `disposed` refuses new starts, so settling
   * workers can't resurrect their manager into a closed workspace.
   */
  disposeAll(): void {
    this.disposed = true;
    for (const [, proc] of this.procs) {
      // Not marked cancelled: the 'close' handler's fallback then reads
      // failed ("claude exited with code …"), keeping the chain resumable.
      if (proc.child.pid) void killProcessTree(proc.child.pid, { child: proc.child });
      else proc.child.kill("SIGTERM");
    }
    for (const run of this.runs.values()) {
      if (!run.terminalId || run.endedAt) continue;
      void this.finish(run, "failed", "Workspace closed").catch(() => {});
      this.interactiveKill?.({ ...run });
    }
  }

  /**
   * Resolve once the run leaves the live states (an already-settled run
   * resolves immediately). A CLI result carries the outcome, but the run is
   * not settled until the process closes and `finish()` publishes it.
   */
  waitForSettled(runId: string): Promise<AgentRun> {
    const current = this.runs.get(runId);
    if (current && current.status !== "running" && current.status !== "queued") {
      return Promise.resolve({ ...current });
    }
    return new Promise((resolve) => {
      const dispose = this.events.on("runChanged", ({ run }) => {
        if (run.id !== runId || run.status === "running" || run.status === "queued") return;
        dispose();
        resolve(run);
      });
    });
  }

  private record(run: AgentRun, event: AgentEvent): void {
    if (event.type === "init") {
      run.sessionId = event.sessionId;
      run.model = event.model;
      this.emitRunChanged(run);
    } else if (event.type === "usage") {
      // One usage event per assistant turn — the run's bill is their sum.
      const u = run.usage ?? emptyUsage();
      run.usage = {
        inputTokens: u.inputTokens + event.inputTokens,
        outputTokens: u.outputTokens + event.outputTokens,
        cacheReadTokens: u.cacheReadTokens + event.cacheReadTokens,
        cacheCreationTokens: u.cacheCreationTokens + event.cacheCreationTokens,
        apiCalls: u.apiCalls + 1,
      };
      this.emitRunChanged(run);
      this.enforceCostCap(run);
    } else if (event.type === "result") {
      run.costUsd = event.costUsd;
      run.turns = event.turns;
      run.durationMs = event.durationMs;
      run.resultText = event.resultText;
      run.sessionId = event.sessionId ?? run.sessionId;
      this.resultStatuses.set(run.id, event.ok ? "completed" : "failed");
      if (!event.ok) run.failure = classifyRunFailure(event.resultText);
      this.emitRunChanged(run);
    } else if (event.type === "tool_use") {
      const file = touchedFileFromToolUse(event.name, event.input);
      if (file && !run.filesTouched.includes(file)) {
        run.filesTouched.push(file);
        this.emitRunChanged(run);
      }
      // Remember the tool behind each call id so a permission denial in its
      // result can be attributed by name. Bounded per run; cleared at finish.
      let names = this.toolNamesByRun.get(run.id);
      if (!names) this.toolNamesByRun.set(run.id, (names = new Map()));
      if (names.size > 2000) names.clear();
      names.set(event.toolUseId, event.name);
    } else if (event.type === "tool_result") {
      if (event.isError && isPermissionDenial(event.content)) {
        const tool =
          this.toolNamesByRun.get(run.id)?.get(event.toolUseId) ?? "(unknown tool)";
        this.onToolDenied?.({ ...run }, tool);
      }
    } else if (event.type === "dispatch") {
      // A manager delegated a unit of work — spawn it as a tracked worker run
      // parented to this run. The worker streams on its own; a dispatch that
      // cannot start must surface on the manager, not as an unhandled rejection.
      this.dispatchWorker(run.id, event.spec).catch((err) => {
        this.record(run, { type: "stderr", text: `dispatch failed: ${(err as Error).message}` });
      });
    }

    const buffer = this.runEvents.get(run.id);
    if (!buffer) return;
    const seq = this.runSeqs.get(run.id) ?? buffer.length;
    this.runSeqs.set(run.id, seq + 1);
    const runEvent: RunEvent = {
      runId: run.id,
      seq,
      ts: nowIso(),
      event,
    };
    buffer.push(runEvent);
    // A chatty run must not grow memory without bound; drop the oldest chunk
    // (in blocks — a front splice per event would be quadratic). The
    // persisted history keeps only what's in memory at finish, so the cap is
    // generous.
    if (buffer.length > MAX_RUN_EVENTS) buffer.splice(0, Math.ceil(MAX_RUN_EVENTS / 5));
    this.events.emit("event", runEvent);
  }

  /**
   * Kill a live run whose streamed usage has crossed its cost cap. Runs off
   * the usage-event path; the settle message is written before the kill so
   * the run's terminal state says *why* it died, not just that it did.
   */
  private enforceCostCap(run: AgentRun): void {
    if (run.costCapUsd == null || run.endedAt) return;
    const proc = this.procs.get(run.id);
    if (!proc || proc.cancelled) return;
    const cost = runCostUsd(run);
    if (cost < run.costCapUsd) return;
    run.resultText =
      `Run cost cap hit: ~$${cost.toFixed(2)} streamed against a $${run.costCapUsd.toFixed(2)} cap — run killed. ` +
      `Scope the work smaller, or raise the workflow's per-run cap.`;
    // Outside record()'s current event: the note and the kill land as their
    // own events, in order, after the usage line that tripped the cap.
    queueMicrotask(() => {
      this.record(run, { type: "stderr", text: run.resultText! });
      void this.cancel(run.id).catch(() => {
        // Already settling — the resultText above still tells the story.
      });
    });
  }

  private async finish(run: AgentRun, status: AgentRun["status"], message: string): Promise<AgentRun> {
    // A failed spawn fires both 'error' and 'close' — the first settles, the
    // second must not append a duplicate terminal event or move endedAt.
    if (run.endedAt) return run;
    this.procs.delete(run.id);
    this.toolNamesByRun.delete(run.id);
    if (run.status === "running" || run.status === "queued") {
      run.status = this.resultStatuses.get(run.id) ?? status;
      run.resultText = run.resultText ?? message;
    }
    this.resultStatuses.delete(run.id);
    run.endedAt = nowIso();
    // Recoverable-failure classification: the result text usually carries the
    // provider error, but CLI-level failures (dead login, instant exits) only
    // ever reach stderr — scan the tail of the stream as a fallback.
    if (run.status === "failed" && !run.failure) {
      run.failure =
        classifyRunFailure(run.resultText) ??
        classifyRunFailure(message) ??
        classifyRunFailure(this.stderrTail(run.id));
    }
    // Before the terminal broadcast: whoever reacts to settlement (tests,
    // notice flushes, UI banners) must already see the updated auth flag.
    this.trackAuthHealth(run);
    const hint = run.failure ? runFailureHint(run.failure) : null;
    this.record(run, {
      type: "status",
      status: run.status,
      message: hint ? `${message}\n${hint}` : message,
    });
    this.emitRunChanged(run);
    // finish() is fired-and-forgotten from 'close'/'error' handlers — a
    // persist rejection (disk full, AV lock) must not become an unhandled
    // rejection, and the run should still land on disk if the hiccup passes.
    try {
      await this.persist(run);
    } catch (err) {
      console.warn(`[crystal] persist failed for run ${run.id}, retrying:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, 500));
      await this.persist(run).catch((err2) =>
        console.error(`[crystal] could not persist run ${run.id}:`, (err2 as Error).message),
      );
    }
    this.notifyOnSettle(run);
    return run;
  }

  /** Current login-health flag (served with `agent.list`). */
  authState(): { broken: boolean; detail: string | null } {
    return { broken: this.authBrokenDetail != null, detail: this.authBrokenDetail };
  }

  /**
   * Flip the instance-wide auth flag on settlement evidence: an
   * auth-classified failure raises it; any successful run clears it and
   * releases every parked chain message.
   */
  private trackAuthHealth(run: AgentRun): void {
    if (run.status === "failed" && run.failure?.kind === "auth") {
      const detail = run.failure.detail ?? "The Claude CLI login is broken.";
      if (this.authBrokenDetail !== detail) {
        this.authBrokenDetail = detail;
        this.events.emit("authChanged", { broken: true, detail });
      }
      return;
    }
    if (run.status === "completed" && this.authBrokenDetail != null) {
      this.authBrokenDetail = null;
      this.events.emit("authChanged", { broken: false, detail: null });
      // The login healed — everything parked can deliver now.
      for (const rootId of this.pendingNotices.keys()) {
        void this.flushNotices(rootId);
      }
    }
  }

  /** Recent stderr lines of a run (classification fallback for CLI-level failures). */
  private stderrTail(runId: string): string {
    const events = this.runEvents.get(runId) ?? [];
    return events
      .slice(-30)
      .map((e) => e.event)
      .filter((e): e is Extract<AgentEvent, { type: "stderr" }> => e.type === "stderr")
      .map((e) => e.text)
      .join("\n");
  }

  /* ---------------- manager wake-ups ---------------- */

  /** True while any run of the chain is still live (a wake-up would race it). */
  private chainLive(rootId: string): boolean {
    for (const id of this.chainIds(rootId)) {
      const status = this.runs.get(id)?.status;
      if (status === "running" || status === "queued") return true;
    }
    return false;
  }

  /** Follow fresh-session handoffs so retired chains can never be resumed. */
  private forwardedChainRoot(rootId: string): string {
    let current = rootId;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const ids = this.chainIds(current);
      const continuation = [...this.runs.values()]
        .filter((run) => run.handoffFromRunId != null && ids.has(run.handoffFromRunId))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (!continuation) break;
      current = chainRootId(continuation.id, this.runs);
    }
    return current;
  }

  /**
   * Close the delegation loop on settlement. A settling worker queues a
   * result notice for its manager chain; a settling manager turn flushes
   * anything queued while it ran. Either way the notices are delivered by
   * resuming the manager's session the moment no chain run is live — the
   * manager never has to busy-poll `worker_status`.
   */
  private notifyOnSettle(run: AgentRun): void {
    if (run.role === "worker" && run.parentRunId) {
      const managerRoot = this.forwardedChainRoot(chainRootId(run.parentRunId, this.runs));
      this.pendingNotices.push(managerRoot, { kind: "worker", text: this.workerNotice(run) });
      if (!this.chainLive(managerRoot)) void this.flushNotices(managerRoot);
      // An interactive manager stays live for its whole TUI session, so the
      // gate above would hold every worker result until the terminal closes.
      // Type them into the terminal instead (no-op without a ready TUI).
      else void this.flushInteractiveQueue(managerRoot);
      // Fall through: a worker has a queue of its own. Anything delivered to
      // it while it was busy — most often the answer to a question it asked —
      // would otherwise sit there forever, because a worker's settlement only
      // ever looked at its *manager's* queue.
    }
    const own = chainRootId(run.id, this.runs);
    if (this.pendingNotices.size(own)) {
      if (!this.chainLive(own)) void this.flushNotices(own);
      else void this.flushInteractiveQueue(own);
    }
  }

  private workerNotice(worker: AgentRun): string {
    const head = `Worker ${worker.id} settled: ${worker.status}` +
      (worker.purpose ? ` (purpose: ${worker.purpose})` : "") +
      (worker.taskId ? ` (task: ${worker.taskId})` : "");
    const result = (worker.resultText ?? "").trim();
    const body = result.length > NOTICE_RESULT_CHARS
      ? `${result.slice(0, NOTICE_RESULT_CHARS)}\n… (truncated — worker_result ${worker.id} has the rest)`
      : result || "(no result text)";
    const files = worker.filesTouched.length
      ? `\nFiles touched: ${worker.filesTouched.slice(0, 10).join(", ")}` +
        (worker.filesTouched.length > 10 ? ` … +${worker.filesTouched.length - 10} more` : "")
      : "";
    return `${head}\n${body}${files}`;
  }

  /**
   * Deliver queued worker notices by resuming the manager's session as a new
   * chained run. Skips (and drops the notices of) chains whose latest turn
   * the user cancelled — a killed manager must stay dead.
   */
  private async flushNotices(rootId: string): Promise<void> {
    if (!this.pendingNotices.size(rootId)) return;
    // Parked: a broken login would fail this delivery (and every retry)
    // identically. trackAuthHealth flushes everything when a success proves
    // the login healed.
    if (this.authBrokenDetail != null) return;
    // A killed manager must stay dead — drop its notices instead of retrying.
    const latest = this.orderedChain(rootId).at(-1);
    if (latest?.status === "cancelled") {
      this.pendingNotices.clear(rootId);
      return;
    }
    try {
      // A null from resumeChain means something else resumed the chain first
      // (or no session yet): the queue keeps everything for the next settle
      // instead of forking the session.
      await this.pendingNotices.drain(rootId, (notices) =>
        this.resumeChain(rootId, composeNoticePrompt(notices)),
      );
    } catch (err) {
      console.warn(`[crystal] could not wake manager ${rootId}:`, (err as Error).message);
    }
  }

  /**
   * Terminal states broadcast immediately (settlement and wake-ups hang off
   * them); while a run is live, high-frequency updates (usage per turn,
   * tool_use per file) coalesce into one trailing broadcast — each broadcast
   * re-serializes the whole run for every connected client.
   */
  private emitRunChanged(run: AgentRun): void {
    const terminal = run.status !== "running" && run.status !== "queued";
    const timer = this.runChangedTimers.get(run.id);
    if (terminal) {
      if (timer) {
        clearTimeout(timer);
        this.runChangedTimers.delete(run.id);
      }
      this.events.emit("runChanged", { run: { ...run } });
      return;
    }
    if (timer) return; // trailing emit already scheduled; run is mutated in place
    this.runChangedTimers.set(
      run.id,
      setTimeout(() => {
        this.runChangedTimers.delete(run.id);
        this.events.emit("runChanged", { run: { ...run } });
      }, RUN_CHANGED_DEBOUNCE_MS),
    );
  }

  private async persist(run: AgentRun): Promise<void> {
    const dir = this.runsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");
    const events = this.runEvents.get(run.id) ?? [];
    await fs.writeFile(
      path.join(dir, `${run.id}.events.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
  }
}

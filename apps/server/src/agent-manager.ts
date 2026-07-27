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
  createAgentRun,
  emptyUsage,
  isWorkflowTag,
  nowIso,
  parseClaudeStreamLine,
  touchedFileFromToolUse,
  transcriptUsage,
  type AgentEvent,
  type AgentIsolation,
  type AgentRole,
  type AgentRun,
  type RunEvent,
  type RunPurpose,
  type WorkerSpec,
} from "@crystal/core";
import { envWithBinDir, resolveClaudeBin } from "./claude-bin.js";
import { runGit } from "./git.js";
import { resolveInRoot } from "./paths.js";
import { PendingQueue } from "./pending-queue.js";

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
  /** Place in the manager/worker hierarchy (unset = standalone run). */
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
  /** Claude model alias/id for `--model` (from the dispatched agent profile). */
  model?: string | null;
  /** Skill names woven into the prompt (from the dispatched agent profile). */
  skills?: string[];
  /** Git branch for the run's worktree (implies worktree isolation). */
  branch?: string | null;
}

/** What an interactive dispatch needs from the caller (no resume, no worktrees). */
export interface InteractiveStartParams {
  prompt: string;
  cwd?: string;
  taskId?: string | null;
  projectId?: string | null;
  repoId?: string | null;
  agentId?: string | null;
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
  model?: string | null;
  skills?: string[];
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
  /** Workspace-relative cwd for the hosting terminal. */
  cwd: string;
  prompt: string;
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
const ALLOWED_RUN_TOOLS = [
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
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  const allowed = [...(opts.mcpConfigPath ? ["mcp__crystal"] : []), ...ALLOWED_RUN_TOOLS];
  args.push("--allowedTools", allowed.join(","));
  return args;
}

/**
 * Argv for an *interactive* Claude session (the native TUI on a PTY). No
 * `-p`/stream-json — the TUI renders itself; the PTY's raw byte stream is the
 * transcript. `--session-id` pins a known id so the chain stays resumable
 * headlessly after the terminal closes (a queued answer can still reach the
 * session). The MCP + dev-loop pre-allows mirror headless runs: the owner is
 * present, but routine git/test/board calls shouldn't nag them either.
 */
export function claudeInteractiveArgs(opts: {
  model?: string | null;
  sessionId?: string | null;
  mcpConfigPath?: string | null;
}): string[] {
  const args = ["--permission-mode", "acceptEdits"];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  const allowed = [...(opts.mcpConfigPath ? ["mcp__crystal"] : []), ...ALLOWED_RUN_TOOLS];
  args.push("--allowedTools", allowed.join(","));
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
  private loaded = false;
  /** Set by disposeAll (workspace close): no new spawns from this manager. */
  private disposed = false;
  private resolvedBin: string | null = null;
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
  /** Set by the workspace runtime: a dispatched worker inherits its task's lease. */
  onWorkerDispatched: ((worker: AgentRun) => void) | null = null;
  /**
   * Set by the workflow engine: veto a manager's dispatch (paused workflow,
   * exhausted budget). Returns a human-readable rejection reason, or null to
   * allow. Rejections surface to the manager as thrown dispatch errors.
   */
  dispatchGuard: ((manager: AgentRun, spec: WorkerSpec) => Promise<string | null>) | null = null;
  /**
   * Set by the host: type `text` into the PTY hosting an interactive run
   * (bracketed paste + Enter). Returns false when the terminal is gone —
   * delivery then falls back to the headless queue/resume path.
   */
  interactiveInput: ((run: AgentRun, text: string) => boolean) | null = null;
  /** Set by the host: kill the PTY hosting an interactive run (cancel path). */
  interactiveKill: ((run: AgentRun) => void) | null = null;
  /** Mount window before an interactive session takes deliveries (test seam). */
  interactiveReadyMs = INTERACTIVE_READY_MS;

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
  ) {}

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
    return (this.resolvedBin ??= await resolveClaudeBin(this.claudeBin));
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
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
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
    const run = createAgentRun(params);
    let cwdAbs = resolveInRoot(this.root, params.cwd ?? ".");

    this.runs.set(run.id, run);
    this.indexTags(run);
    this.runEvents.set(run.id, []);

    if (run.isolation === "worktree") {
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

    // Managers get dispatch + board tools; any run attached to a board task
    // (workers, task runs from the board) gets the self-service task tools.
    // The endpoint scopes the toolset by the run's role (see mcp/http.ts).
    const mcpConfig =
      run.role === "manager" || run.taskId ? await this.writeMcpConfig(run.id) : null;
    const args = claudeRunArgs({
      model: params.model,
      resumeSessionId: params.resumeSessionId,
      mcpConfigPath: mcpConfig,
    });

    const claudeBin = await this.claudePath();
    const plan = planClaudeSpawn(claudeBin, args);
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
        env: envWithBinDir(agentEnv({ ...process.env, FORCE_COLOR: "0" }), claudeBin),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return this.finish(run, "failed", `Failed to spawn ${this.claudeBin}: ${(err as Error).message}`);
    }

    this.procs.set(run.id, { child, cancelled: false });

    // Wire every handler synchronously, before any await: a failed spawn
    // (nonexistent cwd, missing binary) emits 'error' on the NEXT TICK, and
    // an unhandled 'error' event kills the whole server — this is exactly
    // how the desktop bridge used to die on agent.start.
    child.on("error", (err) => {
      void this.finish(run, "failed", `Failed to spawn ${this.claudeBin}: ${err.message}`);
    });
    // Claude exiting before the prompt flushes (instant CLI startup errors)
    // EPIPEs stdin; without a listener that is fatal too. 'close' settles.
    child.stdin.on("error", (err) => {
      this.record(run, { type: "stderr", text: `stdin: ${err.message}` });
    });

    const stdout = new LineBuffer(MAX_STREAM_LINE_BYTES);
    const stderr = new LineBuffer(MAX_STREAM_LINE_BYTES);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of stdout.push(chunk)) {
        for (const event of parseClaudeStreamLine(line)) this.record(run, event);
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
        for (const event of parseClaudeStreamLine(line)) this.record(run, event);
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
      void this.finish(run, fallback, run.resultText ?? `claude exited with code ${code}`);
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
    const run = createAgentRun(params);
    // A known session id (--session-id) keeps the chain resumable headlessly
    // once the terminal closes — the TUI emits no stream-json to learn it from.
    run.sessionId = randomUUID();
    run.model = params.model ?? null;
    this.runs.set(run.id, run);
    this.indexTags(run);
    this.runEvents.set(run.id, []);

    const mcpConfig =
      run.role === "manager" || run.taskId ? await this.writeMcpConfig(run.id) : null;
    const args = claudeInteractiveArgs({
      model: params.model,
      sessionId: run.sessionId,
      mcpConfigPath: mcpConfig,
    });
    const claudeBin = await this.claudePath();

    let prompt = params.prompt;
    if (params.skills?.length) {
      prompt += `\n\nUse these skills where relevant: ${params.skills.map((s) => `/${s}`).join(", ")}.`;
    }
    if (mcpConfig && run.role !== "manager" && run.taskId) prompt += INTERACTIVE_TASK_NOTE;

    return {
      run: { ...run },
      file: claudeBin,
      args,
      env: envWithBinDir(agentEnv({ ...process.env }), claudeBin),
      cwd: run.cwd,
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
    const key = `${run.cwd} ${run.branch}`;
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
    const rootId = chainRootId(fromRunId, this.runs);
    const prev = this.resumeLocks.get(rootId) ?? Promise.resolve();
    const attempt = prev.then(async (): Promise<AgentRun | null> => {
      if (this.chainLive(rootId)) return null;
      const chain = this.orderedChain(rootId);
      const root = chain[0];
      const latest = chain[chain.length - 1];
      if (!root || !latest || latest.status === "cancelled") return null;
      const session = [...chain].reverse().find((r) => r.sessionId)?.sessionId;
      if (!session) return null;
      return this.start({
        prompt,
        cwd: root.cwd,
        taskId: root.taskId,
        projectId: root.projectId,
        repoId: root.repoId,
        resumeSessionId: session,
        resumedFromRunId: latest.id,
        agentId: root.agentId,
        // Resumed turns stay on the chain's model — the CLI would otherwise
        // fall back to its configured default mid-conversation.
        model: latest.model ?? root.model ?? null,
        role: root.role === "manager" ? "manager" : null,
        purpose: root.purpose,
        tags: root.tags,
      });
    });
    this.resumeLocks.set(rootId, attempt.catch(() => {}));
    return attempt;
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
    await this.ensureLoaded();
    const rootId = chainRootId(runId, this.runs);
    // A live interactive terminal takes the message directly — typed into the
    // TUI, which handles mid-turn input by queueing it natively.
    const interactive = await this.deliverInteractive(rootId, prompt);
    if (interactive) return interactive;
    const run = await this.resumeChain(rootId, prompt);
    if (run) return run;
    this.pendingNotices.push(rootId, { kind: "message", text: prompt });
    return null;
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
    const worker = await this.start({
      prompt: spec.prompt,
      cwd: spec.cwd ?? manager.cwd,
      repoId: manager.repoId,
      taskId: spec.taskId ?? manager.taskId,
      projectId: manager.projectId,
      isolation: spec.isolation ?? "none",
      branch: spec.branch ?? null,
      model: spec.model ?? null,
      parentRunId: managerRunId,
      role: "worker",
      purpose: spec.purpose ?? manager.purpose,
      tags,
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
    // Track worktrees are shared across a branch's successive workers — the
    // directory may be another run's live cwd, and removing it would pull
    // the floor out from under that process.
    const sharers = [...this.runs.values()].filter(
      (r) => r.id !== run.id && r.worktreePath === run.worktreePath,
    );
    const live = sharers.find((r) => r.status === "running" || r.status === "queued");
    if (live) {
      throw new Error(`Worktree is in use by live run ${live.id} — cancel it first.`);
    }
    const base = resolveInRoot(this.root, run.cwd);
    await runGit(base, ["worktree", "remove", "--force", run.worktreePath]).catch(async () => {
      // Fall back to manual removal + prune if git refuses (e.g. locked files).
      await fs.rm(run.worktreePath!, { recursive: true, force: true });
      await runGit(base, ["worktree", "prune"]).catch(() => {});
    });
    // Clear every record pointing at the removed directory, not just this
    // run's — a dangling worktreePath would offer diffs of a deleted dir.
    for (const r of [run, ...sharers]) {
      r.worktreePath = null;
      this.emitRunChanged(r);
      await this.persist(r);
    }
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
    // On Windows kill the whole tree (a shell spawn puts claude under cmd.exe).
    if (process.platform === "win32" && proc.child.pid) {
      const killer = spawn("taskkill", ["/pid", String(proc.child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
      });
      // taskkill unavailable must not crash the server — fall back to a plain kill.
      killer.on("error", () => proc.child.kill());
    } else {
      proc.child.kill("SIGTERM");
    }
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
      if (process.platform === "win32" && proc.child.pid) {
        const killer = spawn("taskkill", ["/pid", String(proc.child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
        });
        killer.on("error", () => proc.child.kill());
      } else {
        proc.child.kill("SIGTERM");
      }
    }
    for (const run of this.runs.values()) {
      if (!run.terminalId || run.endedAt) continue;
      void this.finish(run, "failed", "Workspace closed").catch(() => {});
      this.interactiveKill?.({ ...run });
    }
  }

  /**
   * Resolve once the run leaves the live states (an already-settled run
   * resolves immediately). Settles on the first terminal status — a `result`
   * event may land before the process closes; `finish()` still runs after.
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
    } else if (event.type === "result") {
      run.costUsd = event.costUsd;
      run.turns = event.turns;
      run.durationMs = event.durationMs;
      run.resultText = event.resultText;
      run.sessionId = event.sessionId ?? run.sessionId;
      run.status = event.ok ? "completed" : "failed";
      this.emitRunChanged(run);
    } else if (event.type === "tool_use") {
      const file = touchedFileFromToolUse(event.name, event.input);
      if (file && !run.filesTouched.includes(file)) {
        run.filesTouched.push(file);
        this.emitRunChanged(run);
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

  private async finish(run: AgentRun, status: AgentRun["status"], message: string): Promise<AgentRun> {
    // A failed spawn fires both 'error' and 'close' — the first settles, the
    // second must not append a duplicate terminal event or move endedAt.
    if (run.endedAt) return run;
    this.procs.delete(run.id);
    if (run.status === "running" || run.status === "queued") {
      run.status = status;
      run.resultText = run.resultText ?? message;
    }
    run.endedAt = nowIso();
    this.record(run, { type: "status", status: run.status, message });
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

  /* ---------------- manager wake-ups ---------------- */

  /** True while any run of the chain is still live (a wake-up would race it). */
  private chainLive(rootId: string): boolean {
    for (const id of this.chainIds(rootId)) {
      const status = this.runs.get(id)?.status;
      if (status === "running" || status === "queued") return true;
    }
    return false;
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
      const managerRoot = chainRootId(run.parentRunId, this.runs);
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

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  Emitter,
  LineBuffer,
  chainRootId,
  createAgentRun,
  emptyUsage,
  isWorkflowTag,
  nowIso,
  parseClaudeStreamLine,
  touchedFileFromToolUse,
  type AgentEvent,
  type AgentIsolation,
  type AgentRole,
  type AgentRun,
  type RunEvent,
  type RunPurpose,
  type WorkerSpec,
} from "@crystal/core";
import { runGit } from "./git.js";
import { resolveInRoot } from "./paths.js";

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

const execFileAsync = promisify(execFile);

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

export function planClaudeSpawn(
  bin: string,
  args: string[],
  win: boolean = process.platform === "win32",
): ClaudeSpawnPlan {
  if (!win || /\.exe$/i.test(bin)) return { file: bin, args, shell: false };
  return { file: winShellQuote(bin), args: args.map(winShellQuote), shell: true };
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
  private runEvents = new Map<string, RunEvent[]>();
  /** Monotonic per-run event seq — survives the replay buffer being trimmed. */
  private runSeqs = new Map<string, number>();
  /** Trailing debounce per run for non-terminal runChanged broadcasts. */
  private runChangedTimers = new Map<string, NodeJS.Timeout>();
  private procs = new Map<string, ActiveProcess>();
  private loaded = false;
  private resolvedBin: string | null = null;
  /**
   * Worker-settlement notices queued per manager chain root, delivered by
   * resuming the manager's session as soon as no chain run is live. This is
   * what closes the delegation loop: managers end their turn after
   * dispatching and are woken with results instead of busy-polling.
   */
  private pendingNotices = new Map<string, string[]>();
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

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly claudeBin = process.env.CRYSTAL_CLAUDE_BIN ?? "claude",
    /**
     * In-process MCP endpoint for manager runs. When set, a manager-role run is
     * launched with an mcp-config pointing at `<baseUrl>/mcp/<wsId>/<runId>`, so
     * its `dispatch_worker` tool spawns tracked workers. Absent → managers fall
     * back to the CRYSTAL_DISPATCH marker.
     */
    private readonly mcp: { baseUrl: string; wsId: string } | null = null,
  ) {}

  private runsDir(): string {
    return path.join(this.dataDir, "runs");
  }

  /**
   * Resolve a bare CLI name to its on-PATH file once (Windows only). Knowing
   * the real extension lets `planClaudeSpawn` bypass cmd.exe for native .exe
   * installs; when resolution fails the bare name survives, and the shell
   * spawn surfaces "not recognized" as a failed run instead of a crash.
   */
  private async claudePath(): Promise<string> {
    if (this.resolvedBin) return this.resolvedBin;
    let bin = this.claudeBin;
    if (process.platform === "win32" && !/[\\/.]/.test(bin)) {
      try {
        const { stdout } = await execFileAsync("where.exe", [bin], { windowsHide: true });
        bin = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? bin;
      } catch {
        /* not on PATH — leave the bare name */
      }
    }
    return (this.resolvedBin = bin);
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
        crystal: { type: "http", url: `${this.mcp.baseUrl}/mcp/${this.mcp.wsId}/${runId}` },
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
        // A run that was live when the server died can never complete.
        if (run.status === "running" || run.status === "queued") {
          run.status = "failed";
          run.resultText = run.resultText ?? "Server stopped while run was active";
        }
        this.runs.set(run.id, run);
      } catch {
        // Ignore corrupt history entries.
      }
    }
  }

  async list(): Promise<AgentRun[]> {
    await this.ensureLoaded();
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    await this.ensureLoaded();
    const run = createAgentRun(params);
    let cwdAbs = resolveInRoot(this.root, params.cwd ?? ".");

    this.runs.set(run.id, run);
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

    const plan = planClaudeSpawn(await this.claudePath(), args);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: cwdAbs,
        shell: plan.shell,
        // Under the desktop app the server has no console — an unhidden
        // cmd.exe would open a visible window per run.
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" },
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
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The runs of one chain root, oldest first (see chainRuns). */
  private orderedChain(rootId: string): AgentRun[] {
    return [...this.chainIds(rootId)]
      .map((id) => this.runs.get(id))
      .filter((r): r is AgentRun => !!r)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      const rootId = chainRootId(run.parentRunId, this.runs);
      const notices = this.pendingNotices.get(rootId) ?? [];
      notices.push(this.workerNotice(run));
      this.pendingNotices.set(rootId, notices);
      if (!this.chainLive(rootId)) void this.flushNotices(rootId);
      return;
    }
    const rootId = chainRootId(run.id, this.runs);
    if (this.pendingNotices.get(rootId)?.length && !this.chainLive(rootId)) {
      void this.flushNotices(rootId);
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
    const notices = this.pendingNotices.get(rootId);
    if (!notices?.length) return;
    // A killed manager must stay dead — drop its notices instead of retrying.
    const latest = this.orderedChain(rootId).at(-1);
    if (latest?.status === "cancelled") {
      this.pendingNotices.delete(rootId);
      return;
    }
    const prompt =
      `${notices.length > 1 ? `${notices.length} workers settled while you were away.\n\n` : ""}` +
      notices.join("\n\n---\n\n") +
      "\n\nYou were resumed because dispatched work settled. Review the results, update the " +
      "board (claim → update_task → release), dispatch follow-up or review workers for " +
      "anything done, and start the next READY tasks. If everything is done and the board " +
      "reflects it, say so briefly and stop. You will be resumed again when more workers " +
      "settle — do not busy-poll worker_status.";
    const delivered = notices.length;
    try {
      const run = await this.resumeChain(rootId, prompt);
      // A null means something else resumed the chain first (or no session
      // yet): the notices stay queued and flush on the next settlement
      // instead of forking the session. On delivery, drop exactly what the
      // prompt carried — notices appended while resuming must survive.
      if (run) {
        const rest = (this.pendingNotices.get(rootId) ?? []).slice(delivered);
        if (rest.length) this.pendingNotices.set(rootId, rest);
        else this.pendingNotices.delete(rootId);
      }
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

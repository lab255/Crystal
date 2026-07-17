import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  Emitter,
  LineBuffer,
  createAgentRun,
  emptyUsage,
  nowIso,
  parseClaudeStreamLine,
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
  /** Place in the manager/worker hierarchy (unset = standalone run). */
  role?: AgentRole | null;
  purpose?: RunPurpose | null;
  tags?: string[];
  /** Claude model alias/id for `--model` (from the dispatched agent profile). */
  model?: string | null;
  /** Skill names woven into the prompt (from the dispatched agent profile). */
  skills?: string[];
}

const MAX_DIFF_BYTES = 1024 * 1024;

/** Fan-out cap: how many workers a single manager run may dispatch. */
const MAX_WORKERS_PER_MANAGER = 12;

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
  private procs = new Map<string, ActiveProcess>();
  private loaded = false;
  private resolvedBin: string | null = null;

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
        const worktree = path.join(this.dataDir, "worktrees", run.id);
        await fs.mkdir(path.dirname(worktree), { recursive: true });
        await runGit(cwdAbs, ["worktree", "add", "--detach", worktree]);
        run.worktreePath = worktree;
        cwdAbs = worktree;
        this.record(run, {
          type: "status",
          status: "queued",
          message: `Isolated worktree: ${worktree}`,
        });
      } catch (err) {
        return this.finish(
          run,
          "failed",
          `Could not create worktree (is "${run.cwd}" a git repo with at least one commit?): ${(err as Error).message}`,
        );
      }
    }

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ];
    if (params.model) args.push("--model", params.model);
    if (params.resumeSessionId) args.push("--resume", params.resumeSessionId);
    // Managers get the dispatch_worker MCP tool; workers never do.
    const mcpConfig = run.role === "manager" ? await this.writeMcpConfig(run.id) : null;
    if (mcpConfig) args.push("--mcp-config", mcpConfig);

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

    const stdout = new LineBuffer();
    const stderr = new LineBuffer();

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
   * Spawn a worker run on behalf of a manager. The worker is parented to the
   * manager (`parentRunId` + role "worker") and inherits its cwd/repo/task when
   * the spec omits them. Two guards keep a runaway manager from fork-bombing:
   * only manager/standalone runs may dispatch (workers can't, so the tree stays
   * one level deep), and each manager is capped at {@link MAX_WORKERS_PER_MANAGER}.
   * Returns null when a guard rejects the dispatch.
   */
  async dispatchWorker(managerRunId: string, spec: WorkerSpec): Promise<AgentRun | null> {
    await this.ensureLoaded();
    const manager = this.runs.get(managerRunId);
    if (!manager || manager.role === "worker") return null;
    const dispatched = [...this.runs.values()].filter(
      (r) => r.parentRunId === managerRunId,
    ).length;
    if (dispatched >= MAX_WORKERS_PER_MANAGER) return null;
    return this.start({
      prompt: spec.prompt,
      cwd: spec.cwd ?? manager.cwd,
      repoId: manager.repoId,
      taskId: manager.taskId,
      projectId: manager.projectId,
      isolation: spec.isolation ?? "none",
      parentRunId: managerRunId,
      role: "worker",
      purpose: spec.purpose ?? manager.purpose,
      tags: spec.tags ?? [],
    });
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
    const base = resolveInRoot(this.root, run.cwd);
    await runGit(base, ["worktree", "remove", "--force", run.worktreePath]).catch(async () => {
      // Fall back to manual removal + prune if git refuses (e.g. locked files).
      await fs.rm(run.worktreePath!, { recursive: true, force: true });
      await runGit(base, ["worktree", "prune"]).catch(() => {});
    });
    run.worktreePath = null;
    this.emitRunChanged(run);
    await this.persist(run);
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
    const runEvent: RunEvent = {
      runId: run.id,
      seq: buffer.length,
      ts: nowIso(),
      event,
    };
    buffer.push(runEvent);
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
    await this.persist(run);
    return run;
  }

  private emitRunChanged(run: AgentRun): void {
    this.events.emit("runChanged", { run: { ...run } });
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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
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

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly claudeBin = process.env.CRYSTAL_CLAUDE_BIN ?? "claude",
  ) {}

  private runsDir(): string {
    return path.join(this.dataDir, "runs");
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

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.claudeBin, args, {
        cwd: cwdAbs,
        // The Claude Code CLI is a .cmd shim on Windows npm installs.
        shell: process.platform === "win32",
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return this.finish(run, "failed", `Failed to spawn ${this.claudeBin}: ${(err as Error).message}`);
    }

    this.procs.set(run.id, { child, cancelled: false });
    run.status = "running";
    run.startedAt = nowIso();
    this.emitRunChanged(run);

    // Prompt goes over stdin — no shell quoting of user text, ever. Specialist
    // skills ride along as a trailing directive.
    let prompt = params.prompt;
    if (params.skills?.length) {
      prompt += `\n\nUse these skills where relevant: ${params.skills.map((s) => `/${s}`).join(", ")}.`;
    }
    child.stdin.write(prompt);
    child.stdin.end();

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

    child.on("error", (err) => {
      void this.finish(run, "failed", `Failed to spawn ${this.claudeBin}: ${err.message}`);
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
    // On Windows kill the whole tree (the .cmd shim spawns node underneath).
    if (process.platform === "win32" && proc.child.pid) {
      spawn("taskkill", ["/pid", String(proc.child.pid), "/T", "/F"], { shell: false });
    } else {
      proc.child.kill("SIGTERM");
    }
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
      // parented to this run. Fire-and-forget: the worker streams on its own.
      void this.dispatchWorker(run.id, event.spec);
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

import {
  checkWrite,
  claimLease,
  createEpic,
  createTask,
  createTaskQuestion,
  leaseValid,
  mergeProjectSave,
  nowIso,
  openQuestions,
  readyTasks,
  rollupCost,
  sumCostRollups,
  transferLease,
  TaskPatchSchema,
  type AgentRun,
  type ClaimResult,
  type Epic,
  type Project,
  type TaskItem,
  type TaskPatch,
} from "@crystal/core";
import type { AgentManager } from "./agent-manager.js";
import type { WorkspaceStore } from "./workspace-store.js";

/**
 * The enforcement half of the orchestration layer (rules live in
 * `@crystal/core` orchestration.ts). Owns every board mutation:
 *
 *  - Serializes them through one queue per workspace, so read-modify-write on
 *    the project file can't interleave (two agents claiming at once).
 *  - Runs the borrow check on task writes: a valid lease + matching claim id,
 *    or the human owner's `force`.
 *  - Preserves the server-owned columns (lease, cost) across whole-project
 *    saves from the UI — a stale client must not clobber a live claim.
 *  - Attributes cost when runs settle: the task's rollup is recomputed from
 *    every run that touched it, then its epic's from its member tasks.
 */
export class OrchestrationService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly agents: AgentManager,
    /** Called after any board write so clients refetch. */
    private readonly onChanged: () => void = () => {},
  ) {}

  /** Serialize one project read-modify-write; `fn` may mutate and must return the result. */
  private mutate<T>(projectPath: string, fn: (project: Project) => T | Promise<T>): Promise<T> {
    const step = this.queue.then(async () => {
      const project = await this.loadProjectAt(projectPath);
      const result = await fn(project);
      // Every write bumps the save revision — whole-project saves carry the
      // rev they loaded, so a stale snapshot merges instead of clobbering.
      project.rev = (project.rev ?? 0) + 1;
      await this.store.saveProject(projectPath, project);
      this.onChanged();
      return result;
    });
    // The queue survives failures; the caller still sees the rejection.
    this.queue = step.catch(() => {});
    return step;
  }

  private async loadProjectAt(projectPath: string): Promise<Project> {
    const info = await this.store.load();
    const entry = info.projects.find((p) => p.path === projectPath);
    if (!entry) throw new Error(`Unknown project: ${projectPath}`);
    return entry.project;
  }

  /**
   * Project path for a `projectId`. A known id resolves exactly; an unknown id
   * throws (misattributing work to another board is worse than failing); null
   * falls back to the workspace's first board — the right default for board
   * *tools* on runs launched without project context.
   */
  async projectPathFor(projectId: string | null | undefined): Promise<string> {
    const info = await this.store.load();
    if (projectId) {
      const entry = info.projects.find((p) => p.project.id === projectId);
      if (!entry) throw new Error(`Unknown project: ${projectId}`);
      return entry.path;
    }
    const first = info.projects[0];
    if (!first) throw new Error("Workspace has no project board");
    return first.path;
  }

  /**
   * Project path for a run, preferring the board that actually contains the
   * run's task — billing follows the task, not a possibly-stale `projectId`.
   */
  async projectPathForRun(run: {
    taskId?: string | null;
    projectId?: string | null;
  }): Promise<string> {
    if (run.taskId) {
      const info = await this.store.load();
      const byTask = info.projects.find((p) =>
        p.project.tasks.some((t) => t.id === run.taskId),
      );
      if (byTask) return byTask.path;
    }
    return this.projectPathFor(run.projectId);
  }

  private taskIn(project: Project, taskId: string): TaskItem {
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  /* ---------------- leases ---------------- */

  claimTask(
    projectPath: string,
    taskId: string,
    init: { holder: string; holderRunId?: string | null; claimId?: string; ttlMs?: number },
  ): Promise<ClaimResult> {
    return this.mutate(projectPath, (project) => {
      const task = this.taskIn(project, taskId);
      const result = claimLease(task.lease, init);
      if (result.ok) {
        task.lease = result.lease;
        task.updatedAt = nowIso();
      }
      return result;
    });
  }

  /**
   * A manager dispatched a worker against a task whose lease it holds: move
   * the lease's `holderRunId` to the worker so the lease lives exactly as long
   * as the work (settlement releases it) instead of dying with the manager's
   * turn. No-op when the task isn't leased to the dispatching run.
   */
  async transferLeaseToRun(worker: AgentRun): Promise<void> {
    if (!worker.taskId || !worker.parentRunId) return;
    const projectPath = await this.projectPathForRun(worker).catch(() => null);
    if (!projectPath) return;
    await this.mutate(projectPath, (project) => {
      const task = project.tasks.find((t) => t.id === worker.taskId);
      if (!task) return;
      const moved = transferLease(task.lease, worker.parentRunId!, { runId: worker.id });
      if (moved) {
        task.lease = moved;
        task.updatedAt = nowIso();
      }
    }).catch(() => {
      // Lease handover must never fail a dispatch.
    });
  }

  /** Release a lease. Only the claim holder (or `force`) may release. */
  releaseTask(
    projectPath: string,
    taskId: string,
    opts: { claimId?: string | null; force?: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.mutate(projectPath, (project) => {
      const task = this.taskIn(project, taskId);
      if (!task.lease) return { ok: true as const };
      const check = checkWrite(task.lease, opts.claimId, { force: opts.force });
      // A stale lease is releasable by anyone — that's the healing path.
      if (!check.ok && leaseValid(task.lease)) return { ok: false as const, reason: check.reason };
      task.lease = null;
      task.updatedAt = nowIso();
      return { ok: true as const };
    });
  }

  /* ---------------- task writes (borrow-checked) ---------------- */

  updateTask(
    projectPath: string,
    taskId: string,
    patch: TaskPatch,
    opts: { claimId?: string | null; force?: boolean },
  ): Promise<{ ok: true; task: TaskItem } | { ok: false; reason: string }> {
    const parsed = TaskPatchSchema.parse(patch);
    return this.mutate(projectPath, (project) => {
      const task = this.taskIn(project, taskId);
      const check = checkWrite(task.lease, opts.claimId, { force: opts.force });
      if (!check.ok) return { ok: false as const, reason: check.reason };
      Object.assign(task, parsed);
      task.updatedAt = nowIso();
      return { ok: true as const, task: { ...task } };
    });
  }

  /**
   * A worker updating *its own* task. Holding run identity is the capability:
   * if the task's lease names this run (claimed by it, or handed over at
   * dispatch), the write goes through without a claim id. An unleased task is
   * auto-claimed for the run first; a task leased to someone else is refused.
   *
   * "This run" spans the whole resume chain: a run resumed to continue a task
   * (a queued answer, a follow-up turn) is a fresh record of the *same*
   * logical session, and the lease its predecessor held must not lock its
   * successor out — that stranded workers unable to move their task to
   * review. The lease is re-pointed at the current run on the way through.
   */
  async updateTaskAsRun(
    projectPath: string,
    taskId: string,
    run: { id: string; holder?: string | null },
    patch: TaskPatch,
  ): Promise<{ ok: true; task: TaskItem } | { ok: false; reason: string }> {
    const parsed = TaskPatchSchema.parse(patch);
    // Resolve the chain outside the board lock (it reads run history). A
    // history that cannot be read degrades to "just this run id".
    const chainIds = new Set<string>([run.id]);
    try {
      for (const r of await this.agents.chainRuns(run.id)) chainIds.add(r.id);
    } catch {
      // run identity alone still works
    }
    return this.mutate(projectPath, (project) => {
      const task = this.taskIn(project, taskId);
      const mine =
        leaseValid(task.lease) &&
        task.lease!.holderRunId != null &&
        chainIds.has(task.lease!.holderRunId);
      if (leaseValid(task.lease) && !mine) {
        return {
          ok: false as const,
          reason: `Task is leased to ${task.lease!.holder} until ${task.lease!.expiresAt} — it is not your task.`,
        };
      }
      // Auto-claim (or heartbeat the run's own lease) — run identity is the capability.
      const claim = claimLease(task.lease, {
        holder: run.holder ?? run.id,
        holderRunId: run.id,
        claimId: mine ? task.lease!.claimId : undefined,
      });
      if (!claim.ok) return { ok: false as const, reason: claim.reason };
      task.lease = claim.lease;
      Object.assign(task, parsed);
      task.updatedAt = nowIso();
      return { ok: true as const, task: { ...task } };
    });
  }

  /** File an async question for a task's human owner (deduped per run+text). */
  addQuestion(
    projectPath: string,
    taskId: string,
    text: string,
    runId?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.mutate(projectPath, (project) => {
      const task = project.tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false as const, reason: `Unknown task: ${taskId}` };
      if (!task.questions.some((q) => q.runId === runId && q.text === text)) {
        task.questions.push(createTaskQuestion(text, runId));
        task.updatedAt = nowIso();
      }
      return { ok: true as const };
    });
  }

  /**
   * A run closes its own open question: the owner answered it out-of-band
   * (interactively, in the run's terminal), so the board copy must stop
   * reading as "waiting on you". By `questionId` when given, else the run's
   * newest open question. No resume — the asker already has the answer.
   */
  async resolveQuestion(
    projectPath: string,
    taskId: string,
    runId: string,
    resolution: string,
    questionId?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Same chain identity as updateTaskAsRun: a headless resume of an
    // interactive session must be able to close the question its earlier
    // turn filed — a fresh run id is the same logical worker.
    const chainIds = new Set<string>([runId]);
    try {
      for (const r of await this.agents.chainRuns(runId)) chainIds.add(r.id);
    } catch {
      // run identity alone still works
    }
    return this.mutate(projectPath, (project) => {
      const task = project.tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false as const, reason: `Unknown task: ${taskId}` };
      const open = task.questions.filter(
        (q) => q.answer == null && q.runId != null && chainIds.has(q.runId),
      );
      const question = questionId ? open.find((q) => q.id === questionId) : open.at(-1);
      if (!question) {
        return {
          ok: false as const,
          reason: questionId
            ? `No open question ${questionId} raised by this run.`
            : "You have no open question to resolve.",
        };
      }
      question.answer = `(answered interactively) ${resolution}`;
      question.answeredAt = nowIso();
      task.updatedAt = question.answeredAt;
      return { ok: true as const };
    });
  }

  /**
   * Record the answer to a question and hand it back to whoever asked: the
   * asking run's session is resumed with the answer so it carries on where it
   * stopped. Answering is uncontended — it is the human side of the exchange,
   * and the asker is by definition waiting — so it needs no lease.
   *
   * Returns the raising run id when one was resumed, so callers can surface
   * "the agent is going again" separately from "recorded for later".
   */
  async answerQuestion(
    projectPath: string,
    taskId: string,
    questionId: string,
    answer: string,
  ): Promise<{ ok: true; resumedRunId: string | null } | { ok: false; reason: string }> {
    // Record inside the lock; resume *outside* it. `resumeChain` spawns a
    // Claude process, and `mutate` serializes the whole board — holding the
    // lock across a spawn would queue every claim/update/release behind it.
    const recorded = await this.mutate(projectPath, (project) => {
      const task = project.tasks.find((t) => t.id === taskId);
      if (!task) return { ok: false as const, reason: `Unknown task: ${taskId}` };
      const question = task.questions.find((q) => q.id === questionId);
      if (!question) return { ok: false as const, reason: `Unknown question: ${questionId}` };
      if (question.answer != null) {
        return { ok: false as const, reason: `Question ${questionId} was already answered.` };
      }
      question.answer = answer;
      question.answeredAt = nowIso();
      task.updatedAt = question.answeredAt;
      return { ok: true as const, runId: question.runId ?? null, text: question.text };
    });
    if (!recorded.ok) return recorded;
    if (!recorded.runId) return { ok: true, resumedRunId: null };

    // Hand the answer back to whoever asked. `deliver`, not `resumeChain`:
    // agents are told not to block on an answer, so the asker is usually still
    // working — a bare resume would return null and the answer would be lost.
    const resumed = await this.agents
      .deliver(
        recorded.runId,
        `Answer to your question "${recorded.text}":\n\n${answer}\n\nContinue the task.`,
      )
      .catch(() => null);
    if (resumed) {
      await this.mutate(projectPath, (project) => {
        const task = project.tasks.find((t) => t.id === taskId);
        if (task && !task.runIds.includes(resumed.id)) task.runIds.push(resumed.id);
      });
    }
    return { ok: true, resumedRunId: resumed?.id ?? null };
  }

  /** Creating a task is uncontended (fresh id) — no lease required. */
  createTask(
    projectPath: string,
    init: {
      title: string;
      description?: string;
      epicId?: string | null;
      priority?: TaskItem["priority"];
      size?: TaskItem["size"];
      blockedBy?: string[];
      agentPrompt?: string | null;
    },
  ): Promise<TaskItem> {
    return this.mutate(projectPath, (project) => {
      const task = createTask(init.title);
      task.description = init.description ?? "";
      task.epicId = init.epicId ?? null;
      if (init.priority) task.priority = init.priority;
      task.size = init.size ?? null;
      const known = new Set(project.tasks.map((t) => t.id));
      task.blockedBy = (init.blockedBy ?? []).filter((id) => known.has(id));
      task.agentPrompt = init.agentPrompt ?? null;
      project.tasks.push(task);
      return { ...task };
    });
  }

  createEpicOn(projectPath: string, name: string, description = ""): Promise<Epic> {
    return this.mutate(projectPath, (project) => {
      const epic = createEpic(name);
      epic.description = description;
      project.epics.push(epic);
      return { ...epic };
    });
  }

  /* ---------------- whole-project saves (UI path) ---------------- */

  /**
   * Save a client's whole-project edit. Server-owned columns (lease, cost)
   * always come from disk; beyond that the save-rev decides how much of the
   * snapshot to trust — a fresh rev applies wholesale, a stale one merges per
   * task so agent writes made after the client's snapshot survive (see
   * {@link mergeProjectSave}).
   */
  saveProjectGuarded(projectPath: string, incoming: Project): Promise<void> {
    return this.mutate(projectPath, (onDisk) => {
      const merged = mergeProjectSave(onDisk, incoming);
      onDisk.name = merged.name;
      onDisk.description = merged.description;
      onDisk.wipLimits = merged.wipLimits;
      onDisk.epics = merged.epics;
      onDisk.tasks = merged.tasks;
    });
  }

  /* ---------------- cost attribution ---------------- */

  /**
   * A run reached a terminal state: bill its task (rollup across every run
   * that touched it), refresh the epic's sum, release any lease the run still
   * holds, and make sure the run id is recorded on the task.
   */
  async settleRun(run: AgentRun): Promise<void> {
    if (!run.taskId) return;
    const projectPath = await this.projectPathForRun(run).catch(() => null);
    if (!projectPath) return;
    const taskRuns = (await this.agents.list()).filter((r) => r.taskId === run.taskId);
    await this.mutate(projectPath, (project) => {
      const task = project.tasks.find((t) => t.id === run.taskId);
      if (!task) return;
      if (!task.runIds.includes(run.id)) task.runIds.push(run.id);
      task.cost = rollupCost(taskRuns);
      if (task.lease?.holderRunId === run.id) task.lease = null;
      task.updatedAt = nowIso();
      if (task.epicId) {
        const epic = project.epics.find((e) => e.id === task.epicId);
        if (epic) {
          epic.cost = sumCostRollups(
            project.tasks.filter((t) => t.epicId === epic.id).map((t) => t.cost),
          );
        }
      }
    }).catch(() => {
      // Billing must never take down run settlement.
    });
  }

  /* ---------------- board snapshot (agent-facing) ---------------- */

  /** Compact board view for agent tools — claim ids are never included. */
  async snapshot(projectPath: string): Promise<string> {
    const project = await this.loadProjectAt(projectPath);
    const ready = new Set(readyTasks(project).map((t) => t.id));
    const lines: string[] = [`Board: ${project.name} (${project.id})`];
    const epicName = new Map(project.epics.map((e) => [e.id, e.name]));
    for (const epic of project.epics) {
      const cost = epic.cost ? ` — ${Math.round(epic.cost.totalTokens / 1000)}k tok, $${epic.cost.costUsd.toFixed(2)}` : "";
      lines.push(`Epic ${epic.id}: ${epic.name}${cost}`);
    }
    for (const task of project.tasks) {
      const open = openQuestions(task).length;
      const bits = [
        `[${task.status}]`,
        task.priority !== "medium" ? `(${task.priority})` : null,
        task.title,
        task.epicId ? `· epic ${epicName.get(task.epicId) ?? task.epicId}` : null,
        task.blockedBy.length ? `· blocked by ${task.blockedBy.join(", ")}` : null,
        leaseValid(task.lease) ? `· leased to ${task.lease!.holder} until ${task.lease!.expiresAt}` : null,
        ready.has(task.id) ? "· READY" : null,
        open ? `· ${open} open question${open > 1 ? "s" : ""}` : null,
        task.cost ? `· ${Math.round(task.cost.totalTokens / 1000)}k tok $${task.cost.costUsd.toFixed(2)}` : null,
      ].filter(Boolean);
      lines.push(`- ${task.id} ${bits.join(" ")}`);
      // Acceptance criteria live in the description — the snapshot must show
      // enough of them that a manager can check work against them.
      const desc = task.description.trim().replace(/\s+/g, " ");
      if (desc) lines.push(`  ${desc.length > 160 ? `${desc.slice(0, 160)}…` : desc}`);
    }
    if (project.tasks.length === 0) lines.push("(no tasks yet)");
    return lines.join("\n");
  }

  /** Full single-task view for agent tools (get_task / my_task). */
  async taskDetail(projectPath: string, taskId: string): Promise<string> {
    const project = await this.loadProjectAt(projectPath);
    const task = this.taskIn(project, taskId);
    const epic = task.epicId ? project.epics.find((e) => e.id === task.epicId) : null;
    const byId = new Map(project.tasks.map((t) => [t.id, t]));
    const lines = [
      `Task ${task.id}: ${task.title}`,
      `Status: ${task.status} · priority: ${task.priority}${task.size ? ` · size: ${task.size}` : ""}${epic ? ` · epic: ${epic.name}` : ""}`,
    ];
    if (task.labels.length) lines.push(`Tags: ${task.labels.join(", ")}`);
    if (task.blockedBy.length) {
      lines.push(
        `Blocked by: ${task.blockedBy
          .map((id) => `${id} [${byId.get(id)?.status ?? "missing"}]`)
          .join(", ")}`,
      );
    }
    if (leaseValid(task.lease)) {
      lines.push(`Leased to ${task.lease!.holder} until ${task.lease!.expiresAt}`);
    }
    lines.push("", "Description (acceptance criteria):", task.description.trim() || "(none)");
    if (task.questions.length) {
      lines.push("", "Questions:");
      for (const q of task.questions) {
        lines.push(`- ${q.answer != null ? `answered: "${q.text}" → ${q.answer}` : `OPEN: "${q.text}"`}`);
      }
    }
    if (task.runIds.length) lines.push("", `Runs so far: ${task.runIds.join(", ")}`);
    if (task.cost) {
      lines.push(`Cost to date: ${Math.round(task.cost.totalTokens / 1000)}k tok, $${task.cost.costUsd.toFixed(2)} across ${task.cost.runCount} runs`);
    }
    return lines.join("\n");
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import {
  Emitter,
  WORKFLOW_TEMPLATES,
  WorkflowSchema,
  WorkflowTemplateSchema,
  addTrack,
  budgetState,
  buildWorkflowManagerPrompt,
  createWorkflow,
  formatUserMessage,
  nowIso,
  setStageStatus,
  setTrackStatus as setTrackStatusPure,
  uid,
  validateWorkflowTemplate,
  workflowIdOfRun,
  workflowSpend,
  workflowStatusText,
  workflowTag,
  type AgentRun,
  type Workflow,
  type WorkflowSpend,
  type WorkflowStageStatus,
  type WorkflowTemplate,
  type WorkflowTrack,
  type WorkflowTrackStatus,
} from "@crystal/core";
import type { AgentManager } from "./agent-manager.js";
import type { WorkspaceStore } from "./workspace-store.js";

/** Settled-run ids remembered for settle-once dedup before pruning oldest. */
const MAX_SETTLED_REMEMBERED = 500;

/**
 * The enforcement half of the workflow layer (rules live in `@crystal/core`
 * workflow.ts). Owns durable workflow records (persisted per workspace under
 * app data) and the lifecycle of each workflow's **manager session** — an
 * interactive, resume-chained Claude run:
 *
 *  - `start` spawns the manager with the standing workflow prompt and the
 *    `workflow:<id>` attribution tag (inherited by every dispatched worker).
 *  - `message` is the remote control: user text is delivered into the
 *    manager's session as a resumed turn — immediately when the chain is
 *    idle, queued and flushed on settlement when a turn is live.
 *  - A dispatch guard refuses new workers while the workflow is paused or
 *    its budget is exhausted; budget exhaustion pauses the workflow.
 *  - Run settlements recompute spend and broadcast `workflow.changed`.
 */
export class WorkflowEngine {
  readonly events = new Emitter<{
    changed: { workflow: Workflow };
    templatesChanged: Record<string, never>;
  }>();

  private workflows = new Map<string, Workflow>();
  /** Custom (builder-authored) templates by id; built-ins stay in core. */
  private templates = new Map<string, WorkflowTemplate>();
  private loaded = false;
  /** User messages waiting for the manager chain to go idle, per workflow. */
  private pendingMessages = new Map<string, string[]>();
  /** Serializes workflow mutations (settle events race user calls). */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Runs whose settlement was already handled — a run emits several terminal
   * runChanged events (result, then finish), and the settle hook must fire
   * once (same convention as WorkspaceRuntime's settledRuns).
   */
  private settledRuns = new Set<string>();
  private readonly disposeListener: () => void;

  constructor(
    private readonly dataDir: string,
    private readonly agents: AgentManager,
    private readonly store: WorkspaceStore,
  ) {
    agents.dispatchGuard = (manager, _spec) => this.guardDispatch(manager);
    this.disposeListener = agents.events.on("runChanged", ({ run }) => {
      const terminal =
        run.status === "completed" || run.status === "failed" || run.status === "cancelled";
      if (!terminal || !workflowIdOfRun(run) || this.settledRuns.has(run.id)) return;
      this.settledRuns.add(run.id);
      while (this.settledRuns.size > MAX_SETTLED_REMEMBERED) {
        const oldest = this.settledRuns.values().next().value;
        if (oldest === undefined) break;
        this.settledRuns.delete(oldest);
      }
      void this.onRunSettled(run);
    });
  }

  /**
   * Detach from the AgentManager (workspace close). Without this a replaced
   * engine would keep handling settlements and writing workflow files after
   * the workspace reopens with a fresh engine on the same app-data dir.
   */
  dispose(): void {
    this.disposeListener();
    if (this.agents.dispatchGuard != null) this.agents.dispatchGuard = null;
  }

  private dir(): string {
    return path.join(this.dataDir, "workflows");
  }

  private templatesDir(): string {
    return path.join(this.dir(), "templates");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const names = await fs.readdir(this.dir()).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir(), name), "utf8"));
        const wf = WorkflowSchema.parse(raw);
        this.workflows.set(wf.id, wf);
      } catch {
        // Ignore corrupt records — a bad file must not take the engine down.
      }
    }
    const templateNames = await fs.readdir(this.templatesDir()).catch(() => [] as string[]);
    for (const name of templateNames) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.templatesDir(), name), "utf8"));
        const template = WorkflowTemplateSchema.parse(raw);
        this.templates.set(template.id, template);
      } catch {
        // Same policy as workflow records: a corrupt template is skipped.
      }
    }
  }

  private async persist(workflow: Workflow): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    await fs.writeFile(
      path.join(this.dir(), `${workflow.id}.json`),
      JSON.stringify(workflow, null, 2),
      "utf8",
    );
  }

  /** Serialize one read-modify-write against a workflow record. */
  private mutate<T>(
    workflowId: string,
    fn: (workflow: Workflow) => { workflow: Workflow; result: T } | Promise<{ workflow: Workflow; result: T }>,
  ): Promise<T> {
    const step = this.queue.then(async () => {
      await this.ensureLoaded();
      const current = this.workflows.get(workflowId);
      if (!current) throw new Error(`Unknown workflow: ${workflowId}`);
      const { workflow, result } = await fn(current);
      workflow.updatedAt = nowIso();
      this.workflows.set(workflow.id, workflow);
      await this.persist(workflow);
      this.events.emit("changed", { workflow: { ...workflow } });
      return result;
    });
    this.queue = step.catch(() => {});
    return step;
  }

  async list(): Promise<Workflow[]> {
    await this.ensureLoaded();
    return [...this.workflows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(workflowId: string): Promise<Workflow | null> {
    await this.ensureLoaded();
    const wf = this.workflows.get(workflowId);
    return wf ? { ...wf } : null;
  }

  /** The workflow a run belongs to (via its `workflow:` tag), or null. */
  async workflowForRun(run: Pick<AgentRun, "tags">): Promise<Workflow | null> {
    const id = workflowIdOfRun(run);
    return id ? this.get(id) : null;
  }

  async spend(workflowId: string): Promise<WorkflowSpend> {
    return workflowSpend(workflowId, await this.agents.list());
  }

  /* ---------------- templates ---------------- */

  /** Built-ins first (stable order), then customs sorted by name. */
  async listTemplates(): Promise<WorkflowTemplate[]> {
    await this.ensureLoaded();
    const custom = [...this.templates.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [...Object.values(WORKFLOW_TEMPLATES), ...custom];
  }

  /**
   * Create or update a custom template. A blank id mints a fresh one;
   * built-in ids are read-only (duplicate them client-side instead). Running
   * workflows are unaffected — each holds its own snapshot.
   */
  async saveTemplate(input: WorkflowTemplate): Promise<WorkflowTemplate> {
    await this.ensureLoaded();
    const template = WorkflowTemplateSchema.parse({
      ...input,
      id: input.id.trim() || uid("wft"),
    });
    if (WORKFLOW_TEMPLATES[template.id]) {
      throw new Error(`Template "${template.id}" is built-in and read-only — duplicate it instead.`);
    }
    const errors = validateWorkflowTemplate(template);
    if (errors.length) throw new Error(`Invalid template: ${errors.join(" ")}`);
    await fs.mkdir(this.templatesDir(), { recursive: true });
    await fs.writeFile(
      path.join(this.templatesDir(), `${template.id}.json`),
      JSON.stringify(template, null, 2),
      "utf8",
    );
    this.templates.set(template.id, template);
    this.events.emit("templatesChanged", {});
    return template;
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.ensureLoaded();
    if (WORKFLOW_TEMPLATES[templateId]) {
      throw new Error(`Template "${templateId}" is built-in and cannot be deleted.`);
    }
    if (!this.templates.delete(templateId)) {
      throw new Error(`Unknown template: ${templateId}`);
    }
    await fs.rm(path.join(this.templatesDir(), `${templateId}.json`), { force: true });
    this.events.emit("templatesChanged", {});
  }

  /* ---------------- lifecycle ---------------- */

  async start(init: {
    name: string;
    goal: string;
    templateId?: string;
    projectId?: string | null;
    cwd?: string;
    agentId?: string | null;
    budgetUsd?: number | null;
  }): Promise<{ workflow: Workflow; run: AgentRun }> {
    await this.ensureLoaded();
    // A custom template id resolves to its current definition and is
    // snapshotted into the record; built-ins resolve by id forever.
    const custom = init.templateId ? this.templates.get(init.templateId) : undefined;
    if (init.templateId && !custom && !WORKFLOW_TEMPLATES[init.templateId]) {
      throw new Error(`Unknown workflow template: ${init.templateId}`);
    }
    const workflow = createWorkflow({ ...init, template: custom ?? null });

    // Resolve the manager's model + skills from the roster on disk, like
    // agent.start does. The manager defaults to a heavyweight model — it
    // makes every coordination and review-routing decision; workers are
    // where cost routing happens (per-stage models in the template).
    let model: string | null = "opus";
    let skills: string[] = [];
    if (init.agentId) {
      const roster = await this.store.loadAgents();
      const profile = roster.agents.find((a) => a.id === init.agentId);
      if (profile) {
        model = profile.model;
        skills = profile.skills;
      }
    }

    const run = await this.agents.start({
      prompt: buildWorkflowManagerPrompt(workflow),
      cwd: workflow.cwd,
      projectId: workflow.projectId,
      agentId: workflow.agentId,
      role: "manager",
      purpose: "manage",
      tags: [workflowTag(workflow.id)],
      model,
      skills,
    });
    workflow.managerRunId = run.id;
    this.workflows.set(workflow.id, workflow);
    await this.persist(workflow);
    this.events.emit("changed", { workflow: { ...workflow } });
    return { workflow: { ...workflow }, run };
  }

  /**
   * Remote control: deliver a user message into the manager's interactive
   * session. Queued (and flushed on settlement) while a chain turn is live —
   * two concurrent resumes of one Claude session would fork it.
   */
  async message(workflowId: string, text: string): Promise<{ run: AgentRun | null; queued: boolean }> {
    await this.ensureLoaded();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    if (!workflow.managerRunId) throw new Error(`Workflow ${workflowId} has no manager session`);
    // resumeChain serializes attempts per chain and re-checks liveness inside
    // its lock — a null (turn live, or no session yet) means queue-and-retry.
    const run = await this.agents.resumeChain(workflow.managerRunId, formatUserMessage(text));
    if (!run) {
      const queued = this.pendingMessages.get(workflowId) ?? [];
      queued.push(text);
      this.pendingMessages.set(workflowId, queued);
      return { run: null, queued: true };
    }
    return { run, queued: false };
  }

  /** Pause (hold new dispatches) or resume. Terminal workflows stay terminal. */
  setPaused(workflowId: string, paused: boolean, reason?: string | null): Promise<Workflow> {
    return this.mutate(workflowId, (wf) => {
      if (wf.status !== "running" && wf.status !== "paused") {
        throw new Error(`Workflow is ${wf.status} — cannot ${paused ? "pause" : "resume"} it.`);
      }
      const workflow: Workflow = {
        ...wf,
        status: paused ? "paused" : "running",
        pausedBy: paused ? "user" : null,
        pausedReason: paused ? (reason ?? "Paused by the user") : null,
      };
      return { workflow, result: workflow };
    });
  }

  /** Raise/lower/clear the budget (clears a budget-exhausted pause when it now fits). */
  setBudget(workflowId: string, budgetUsd: number | null): Promise<Workflow> {
    return this.mutate(workflowId, async (wf) => {
      const workflow: Workflow = { ...wf, budgetUsd };
      // Only budget pauses auto-clear — a deliberate user hold stays held.
      if (workflow.status === "paused" && wf.pausedBy === "budget") {
        const budget = budgetState(workflow, await this.spend(workflowId));
        if (!budget.exhausted) {
          workflow.status = "running";
          workflow.pausedBy = null;
          workflow.pausedReason = null;
        }
      }
      return { workflow, result: workflow };
    });
  }

  /** Cancel: kill every live run of the workflow and mark it cancelled. */
  async cancel(workflowId: string): Promise<Workflow> {
    await this.ensureLoaded();
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
    this.pendingMessages.delete(workflowId);
    const tag = workflowTag(workflowId);
    const live = (await this.agents.list()).filter(
      (r) => r.tags.includes(tag) && (r.status === "running" || r.status === "queued"),
    );
    for (const run of live) {
      await this.agents.cancel(run.id).catch(() => {
        // A run that settled while we iterated is already dead — fine.
      });
    }
    return this.mutate(workflowId, (current) => {
      // Idempotent under the queue: a workflow that reached another terminal
      // state while we were killing runs keeps that state.
      const terminal =
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled";
      const workflow: Workflow = terminal
        ? current
        : { ...current, status: "cancelled", pausedBy: null, pausedReason: null };
      return { workflow, result: workflow };
    });
  }

  /* ---------------- manager-facing tools (MCP) ---------------- */

  async statusText(workflowId: string): Promise<string> {
    const workflow = await this.get(workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    return workflowStatusText(workflow, await this.spend(workflowId));
  }

  advanceStage(
    workflowId: string,
    stageId: string,
    status: WorkflowStageStatus,
    note?: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.mutate<{ ok: true } | { ok: false; reason: string }>(workflowId, (wf) => {
      const result = setStageStatus(wf, stageId, status, note);
      if (!result.ok) return { workflow: wf, result };
      return { workflow: result.workflow, result: { ok: true } };
    });
  }

  addTrack(
    workflowId: string,
    init: { name: string; branch?: string | null; taskIds?: string[] },
  ): Promise<WorkflowTrack> {
    return this.mutate(workflowId, (wf) => {
      const { workflow, track } = addTrack(wf, init);
      return { workflow, result: track };
    });
  }

  setTrackStatus(
    workflowId: string,
    trackId: string,
    status: WorkflowTrackStatus,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.mutate<{ ok: true } | { ok: false; reason: string }>(workflowId, (wf) => {
      const result = setTrackStatusPure(wf, trackId, status);
      if (!result.ok) return { workflow: wf, result };
      return { workflow: result.workflow, result: { ok: true } };
    });
  }

  /** Record the epic the manager created for this workflow. */
  bindEpic(workflowId: string, epicId: string): Promise<Workflow> {
    return this.mutate(workflowId, (wf) => {
      const workflow: Workflow = { ...wf, epicId };
      return { workflow, result: workflow };
    });
  }

  /** The manager declares the workflow finished (or genuinely stuck). */
  complete(workflowId: string, outcome: "completed" | "failed", summary: string): Promise<Workflow> {
    return this.mutate(workflowId, (wf) => {
      const workflow: Workflow = {
        ...wf,
        status: outcome,
        summary,
        pausedBy: null,
        pausedReason: null,
      };
      return { workflow, result: workflow };
    });
  }

  /* ---------------- enforcement ---------------- */

  /** Dispatch veto for workflow managers: paused, terminal, or over budget. */
  private async guardDispatch(manager: AgentRun): Promise<string | null> {
    const workflow = await this.workflowForRun(manager);
    if (!workflow) return null; // not a workflow run — no veto
    if (workflow.status === "paused") {
      return `Workflow is paused (${workflow.pausedReason ?? "on hold"}) — no new workers until it resumes.`;
    }
    if (workflow.status !== "running") {
      return `Workflow is ${workflow.status} — it no longer dispatches workers.`;
    }
    const budget = budgetState(workflow, await this.spend(workflow.id));
    if (budget.exhausted) {
      return (
        `Budget exhausted: $${budget.spentUsd.toFixed(2)} spent of $${budget.budgetUsd!.toFixed(2)}. ` +
        `Report to the user with ask_question; the user can raise the budget or resume.`
      );
    }
    return null;
  }

  /**
   * A workflow-tagged run settled: enforce the budget (exhaustion pauses the
   * workflow), flush queued user messages once the manager chain is idle, and
   * poke listeners so UIs refresh spend.
   */
  private async onRunSettled(run: AgentRun): Promise<void> {
    const id = workflowIdOfRun(run);
    if (!id) return;
    await this.ensureLoaded();
    const workflow = this.workflows.get(id);
    if (!workflow) return;

    try {
      if (workflow.status === "running" && workflow.budgetUsd != null) {
        const budget = budgetState(workflow, await this.spend(id));
        if (budget.exhausted) {
          await this.mutate(id, (wf) => {
            // Re-check under the queue — a user resume may have raced us.
            if (wf.status !== "running") return { workflow: wf, result: null };
            const paused: Workflow = {
              ...wf,
              status: "paused",
              pausedBy: "budget",
              pausedReason: `Budget exhausted ($${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd!.toFixed(2)})`,
            };
            return { workflow: paused, result: null };
          });
        }
      }
      await this.flushMessages(id);
      // Spend changed even when nothing above did — let UIs refresh.
      const fresh = this.workflows.get(id);
      if (fresh) this.events.emit("changed", { workflow: { ...fresh } });
    } catch (err) {
      console.warn(`[crystal] workflow settle hook failed for ${id}:`, (err as Error).message);
    }
  }

  /** Deliver queued (raw) user messages once no chain run is live. */
  private async flushMessages(workflowId: string): Promise<void> {
    const pending = this.pendingMessages.get(workflowId);
    if (!pending?.length) return;
    const workflow = this.workflows.get(workflowId);
    if (!workflow?.managerRunId) return;
    const text =
      pending.length === 1
        ? formatUserMessage(pending[0]!)
        : `${pending.length} user messages arrived while you were working.\n\n` +
          pending.map((m) => formatUserMessage(m)).join("\n\n---\n\n");
    const delivered = pending.length;
    const run = await this.agents.resumeChain(workflow.managerRunId, text);
    // Delivered — drop exactly what the prompt carried (messages queued while
    // resuming survive). A null keeps everything queued for the next settle.
    if (run) {
      const rest = (this.pendingMessages.get(workflowId) ?? []).slice(delivered);
      if (rest.length) this.pendingMessages.set(workflowId, rest);
      else this.pendingMessages.delete(workflowId);
    }
  }
}

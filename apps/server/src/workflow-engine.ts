import path from "node:path";
import {
  Emitter,
  WORKFLOW_TEMPLATES,
  WorkflowSchema,
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
import { SettledRuns } from "./settled-runs.js";
import { JsonRecordStore } from "./record-store.js";
import {
  TemplateLibrary,
  type GlobalTemplateStore,
  type WritableScope,
} from "./template-library.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { PendingQueue } from "./pending-queue.js";
import { runGit } from "./git.js";

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
/**
 * Trailing protocol for an interactive workflow manager (native Claude TUI in
 * the terminal panel, owner present). The generated manager prompt already
 * covers the MCP protocol; this adds the terminal-native question etiquette —
 * same pairing the hub's interactive manager uses.
 */
const WORKFLOW_INTERACTIVE_NOTE =
  "\n\nYou are running interactively, in a terminal the workflow's owner can see. When a " +
  "decision needs the owner: file it with ask_question (passing the task's id — that logs " +
  "it on the board, answerable later if they step away), then put it to them directly with " +
  "your AskUserQuestion tool. When the interactive answer arrives, act on it and close the " +
  "board copy with resolve_question (same taskId). Worker settlements and owner messages " +
  "are typed into this session as they happen.";

export class WorkflowEngine {
  readonly events = new Emitter<{
    changed: { workflow: Workflow };
    templatesChanged: Record<string, never>;
  }>();

  /**
   * Set by the workspace runtime: host a manager as a native interactive
   * Claude session on one of this workspace's PTYs (see launchInteractiveRun).
   * Null (tests, headless embeddings) means `start` always spawns headless.
   */
  interactiveLauncher:
    | ((params: {
        prompt: string;
        cwd?: string;
        projectId?: string | null;
        agentId?: string | null;
        role: "manager";
        purpose: "manage";
        tags: string[];
        model?: string | null;
        skills?: string[];
        title?: string | null;
      }) => Promise<{ run: AgentRun; terminal: unknown }>)
    | null = null;

  /** Persisted workflows, with the serialized read-modify-write (see JsonRecordStore). */
  private readonly records: JsonRecordStore<Workflow>;
  /** Built-in + global + this project's templates (see TemplateLibrary). */
  private readonly library: TemplateLibrary;
  /** User messages waiting for the manager chain to go idle, per workflow. */
  private pendingMessages = new PendingQueue<string>();
  /** Runs whose settlement was already handled (see SettledRuns). */
  private readonly settledRuns = new SettledRuns();
  private readonly disposeListener: () => void;
  private readonly disposeLibrary: () => void;

  constructor(
    private readonly dataDir: string,
    private readonly agents: AgentManager,
    private readonly store: WorkspaceStore,
    globalTemplates: GlobalTemplateStore,
  ) {
    this.records = new JsonRecordStore<Workflow>(
      path.join(dataDir, "workflows"),
      (raw) => WorkflowSchema.parse(raw),
      (workflow) => this.events.emit("changed", { workflow }),
      nowIso,
    );
    this.library = new TemplateLibrary(path.join(dataDir, "workflows", "templates"), globalTemplates);
    this.disposeLibrary = this.library.events.on("changed", () =>
      this.events.emit("templatesChanged", {}),
    );
    agents.dispatchGuard = (manager, _spec) => this.guardDispatch(manager);
    this.disposeListener = agents.events.on("runChanged", ({ run }) => {
      if (!workflowIdOfRun(run) || !this.settledRuns.claim(run)) return;
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
    this.disposeLibrary();
    this.library.dispose();
    if (this.agents.dispatchGuard != null) this.agents.dispatchGuard = null;
  }

  private async ensureLoaded(): Promise<void> {
    await this.records.ensureLoaded();
  }

  /** Serialize one read-modify-write against a workflow record. */
  private mutate<T>(
    workflowId: string,
    fn: (workflow: Workflow) => { workflow: Workflow; result: T } | Promise<{ workflow: Workflow; result: T }>,
  ): Promise<T> {
    return this.records.mutate(workflowId, async (record) => {
      const { workflow, result } = await fn(record);
      return { record: workflow, result };
    });
  }

  list(): Promise<Workflow[]> {
    return this.records.list();
  }

  get(workflowId: string): Promise<Workflow | null> {
    return this.records.get(workflowId);
  }

  /** The workflow a run belongs to (via its `workflow:` tag), or null. */
  async workflowForRun(run: Pick<AgentRun, "tags">): Promise<Workflow | null> {
    const id = workflowIdOfRun(run);
    return id ? this.get(id) : null;
  }

  async spend(workflowId: string): Promise<WorkflowSpend> {
    // The tag index, not a full-history scan — this runs on every dispatch
    // (budget guard) and every settlement.
    return workflowSpend(workflowId, await this.agents.runsWithTag(workflowTag(workflowId)));
  }

  /* ---------------- templates ---------------- */

  /** Built-ins first, then the global library, then this project's. */
  listTemplates(): Promise<WorkflowTemplate[]> {
    return this.library.list();
  }

  /**
   * Create or update a custom template, optionally moving it between the
   * global library and this project. Running workflows are unaffected — each
   * holds its own snapshot.
   */
  saveTemplate(input: WorkflowTemplate, scope?: WritableScope): Promise<WorkflowTemplate> {
    return this.library.save(input, scope);
  }

  deleteTemplate(templateId: string): Promise<void> {
    return this.library.remove(templateId);
  }

  /* ---------------- lifecycle ---------------- */

  async start(init: {
    name: string;
    goal: string;
    templateId?: string;
    /**
     * A one-off graph for this workflow only — the start panel's "customise
     * for this run". Snapshotted into the record and never persisted to the
     * library, so tweaking a run cannot drift the template other runs use.
     */
    template?: WorkflowTemplate | null;
    projectId?: string | null;
    cwd?: string;
    agentId?: string | null;
    budgetUsd?: number | null;
    /**
     * Host the manager as a native interactive Claude session in the terminal
     * panel instead of a headless run — the owner answers its questions
     * (AskUserQuestion) right there, and steering messages are typed in live.
     */
    interactive?: boolean;
  }): Promise<{ workflow: Workflow; run: AgentRun }> {
    await this.ensureLoaded();
    // A custom template id resolves to its current definition and is
    // snapshotted into the record; built-ins resolve by id forever. An
    // inline template wins outright — it is already the tweaked copy.
    let template = init.template ?? null;
    if (!template && init.templateId) {
      const found = await this.library.get(init.templateId);
      if (!found) throw new Error(`Unknown workflow template: ${init.templateId}`);
      template = WORKFLOW_TEMPLATES[init.templateId] ? null : found;
    }
    const workflow = createWorkflow({ ...init, template });

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

    let run: AgentRun;
    if (init.interactive && this.interactiveLauncher) {
      const launched = await this.interactiveLauncher({
        prompt: buildWorkflowManagerPrompt(workflow) + WORKFLOW_INTERACTIVE_NOTE,
        cwd: workflow.cwd,
        projectId: workflow.projectId,
        agentId: workflow.agentId,
        role: "manager",
        purpose: "manage",
        tags: [workflowTag(workflow.id)],
        model,
        skills,
        title: `workflow · ${workflow.name}`,
      });
      run = launched.run;
    } else {
      run = await this.agents.start({
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
    }
    workflow.managerRunId = run.id;
    await this.records.put(workflow);
    return { workflow: { ...workflow }, run };
  }

  /**
   * Remote control: deliver a user message into the manager's interactive
   * session. Queued (and flushed on settlement) while a chain turn is live —
   * two concurrent resumes of one Claude session would fork it.
   */
  async message(workflowId: string, text: string): Promise<{ run: AgentRun | null; queued: boolean }> {
    await this.ensureLoaded();
    const workflow = this.records.peek(workflowId);
    if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
    if (!workflow.managerRunId) throw new Error(`Workflow ${workflowId} has no manager session`);
    // An interactive manager takes the message in its terminal, mid-turn or
    // not — the TUI queues input itself, so this can never fork the session.
    const interactive = await this.agents
      .deliverInteractive(workflow.managerRunId, formatUserMessage(text))
      .catch(() => null);
    if (interactive) return { run: interactive, queued: false };
    // resumeChain serializes attempts per chain and re-checks liveness inside
    // its lock — a null (turn live, or no session yet) means queue-and-retry.
    const run = await this.agents.resumeChain(workflow.managerRunId, formatUserMessage(text));
    if (!run) {
      this.pendingMessages.push(workflowId, text);
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
    const wf = this.records.peek(workflowId);
    if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
    this.pendingMessages.clear(workflowId);
    const tag = workflowTag(workflowId);
    const live = (await this.agents.runsWithTag(tag)).filter(
      (r) => r.status === "running" || r.status === "queued",
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

  /**
   * Deterministically merge a track's branch into the line checked out at the
   * workspace root (`git merge --no-ff`) and mark the track merged. The merge
   * stage used to be prompt-driven git — the least reliable step of every
   * workflow; this makes the happy path a lookup. On conflict nothing is left
   * half-merged: the merge is aborted and the conflicted paths returned, so
   * the manager dispatches a resolution worker for exactly those files
   * instead of redoing the whole merge by prompt.
   */
  async mergeTrack(
    workflowId: string,
    trackId: string,
  ): Promise<{ ok: true; summary: string } | { ok: false; reason: string; conflicts?: string[] }> {
    await this.ensureLoaded();
    const wf = this.records.peek(workflowId);
    if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
    const track = wf.tracks.find((t) => t.id === trackId);
    if (!track) return { ok: false, reason: `Unknown track: ${trackId}` };
    if (!track.branch) return { ok: false, reason: `Track ${trackId} has no branch to merge.` };
    if (track.status === "merged") return { ok: false, reason: `Track ${trackId} is already merged.` };
    const branch = track.branch;
    // A live worker on the branch has uncommitted work in flight — merging
    // under it would land a torso and race its later commits.
    const live = (await this.agents.runsWithTag(workflowTag(workflowId))).find(
      (r) => r.branch === branch && (r.status === "running" || r.status === "queued"),
    );
    if (live) {
      return {
        ok: false,
        reason: `Branch ${branch} has a live worker (${live.id}) — wait for it to settle (or cancel it) before merging.`,
      };
    }
    const cwd = this.agents.workspaceRoot;
    try {
      await runGit(cwd, ["rev-parse", "--verify", "--quiet", branch]);
    } catch {
      return { ok: false, reason: `Branch ${branch} does not exist — nothing to merge.` };
    }
    try {
      const out = await runGit(cwd, ["merge", "--no-ff", "--no-edit", branch]);
      const set = await this.setTrackStatus(workflowId, trackId, "merged");
      if (!set.ok) return set;
      const stat = out.trim().split("\n").at(-1) ?? "";
      return { ok: true, summary: `Merged ${branch} into the main line. ${stat}`.trim() };
    } catch (err) {
      const conflicts = (
        await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
      )
        .split("\n")
        .filter(Boolean);
      if (conflicts.length) {
        await runGit(cwd, ["merge", "--abort"]).catch(() => {
          // Nothing in progress to abort — the tree is already clean.
        });
        return {
          ok: false,
          reason: `Merging ${branch} hit conflicts (merge aborted, the tree is clean again).`,
          conflicts,
        };
      }
      const stderr = (err as { stderr?: string }).stderr?.trim();
      return { ok: false, reason: `git merge ${branch} failed: ${stderr || (err as Error).message}` };
    }
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
    const workflow = this.records.peek(id);
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
      const fresh = this.records.peek(id);
      if (fresh) this.events.emit("changed", { workflow: { ...fresh } });
    } catch (err) {
      console.warn(`[crystal] workflow settle hook failed for ${id}:`, (err as Error).message);
    }
  }

  /** Deliver queued (raw) user messages once no chain run is live. */
  private async flushMessages(workflowId: string): Promise<void> {
    const workflow = this.records.peek(workflowId);
    if (!workflow?.managerRunId) return;
    const managerRunId = workflow.managerRunId;
    await this.pendingMessages.drain(workflowId, (pending) => {
      const text =
        pending.length === 1
          ? formatUserMessage(pending[0]!)
          : `${pending.length} user messages arrived while you were working.\n\n` +
            pending.map((m) => formatUserMessage(m)).join("\n\n---\n\n");
      return this.agents.resumeChain(managerRunId, text);
    });
  }
}

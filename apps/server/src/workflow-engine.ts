import path from "node:path";
import {
  Emitter,
  STALL_TURN_LIMIT,
  WORKFLOW_TEMPLATES,
  WorkflowSchema,
  addTrack,
  appendTurnLog,
  runCostUsd,
  budgetState,
  budgetWarningDue,
  budgetWarningText,
  buildWorkflowManagerPrompt,
  createWorkflow,
  formatUserMessage,
  nowIso,
  setStageStatus,
  setTrackStatus as setTrackStatusPure,
  uid,
  validateWorkflowTemplate,
  workflowIdOfRun,
  workflowProgressFingerprint,
  workflowSpend,
  workflowStatusText,
  workflowTag,
  applyProfileOverlay,
  presetById,
  profileOverlay,
  resolvePresetModel,
  type AgentPermissionMode,
  type AgentProvider,
  type AgentRoster,
  type AgentRun,
  type SteerReceipt,
  type TaskItem,
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
import { probeAssertions, probeEnvironment } from "./preflight.js";
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

interface PendingWorkflowMessage {
  text: string;
  at: string;
}

interface PendingWorkflowMessages {
  id: string;
  messages: PendingWorkflowMessage[];
  updatedAt: string;
}

function parsePendingWorkflowMessages(raw: unknown): PendingWorkflowMessages {
  if (!raw || typeof raw !== "object") throw new Error("pending workflow messages must be an object");
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.updatedAt !== "string") {
    throw new Error("pending workflow messages need id and updatedAt");
  }
  if (!Array.isArray(record.messages)) throw new Error("pending workflow messages need an array");
  const messages = record.messages.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid pending workflow message");
    const message = item as Record<string, unknown>;
    if (typeof message.text !== "string" || typeof message.at !== "string") {
      throw new Error("pending workflow message needs text and at");
    }
    return { text: message.text, at: message.at };
  });
  return { id: record.id, updatedAt: record.updatedAt, messages };
}

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
  /**
   * Set by the workspace runtime: close the open board questions a settling
   * workflow originated (`origin.workflowId`), with the terminal status as
   * the evidence — see OrchestrationService.expireWorkflowQuestions. Invoked
   * after every terminal write commits, and again from the startup reconcile
   * (`reconcileQuestionExpiry`) so a transition missed while the server was
   * down is still honoured. Null (tests, headless embeddings) skips expiry.
   */
  questionExpiry:
    | ((workflowId: string, status: "completed" | "failed" | "cancelled") => Promise<unknown>)
    | null = null;

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
        appendSystemPrompt?: string | null;
        allowedTools?: string[];
        disallowedTools?: string[];
        permissionMode?: AgentPermissionMode | null;
        title?: string | null;
      }) => Promise<{ run: AgentRun; terminal: unknown }>)
    | null = null;

  /** Persisted workflows, with the serialized read-modify-write (see JsonRecordStore). */
  private readonly records: JsonRecordStore<Workflow>;
  /** Durable accepted steering, kept outside the core-owned workflow schema. */
  private readonly pendingRecords: JsonRecordStore<PendingWorkflowMessages>;
  /** Built-in + global + this project's templates (see TemplateLibrary). */
  private readonly library: TemplateLibrary;
  /** Restored durable messages waiting for the manager chain to go idle. */
  private pendingMessages = new PendingQueue<PendingWorkflowMessage>();
  /** Workflow-local lifecycle serialization (compact, wake delivery, completion). */
  private workflowLocks = new Map<string, Promise<unknown>>();
  /** Record and pending-message restoration share one in-flight load. */
  private loading: Promise<void> | null = null;
  /** Runs whose settlement was already handled (see SettledRuns). */
  private readonly settledRuns = new SettledRuns();
  private readonly disposeListener: () => void;
  private readonly disposeLibrary: () => void;

  constructor(
    private readonly dataDir: string,
    private readonly agents: AgentManager,
    private readonly store: WorkspaceStore,
    globalTemplates: GlobalTemplateStore,
    /**
     * The merged project+library roster view. Optional so headless
     * embeddings/tests fall back to the project roster alone.
     */
    private readonly agentLibrary: { roster(): Promise<AgentRoster> } | null = null,
  ) {
    this.records = new JsonRecordStore<Workflow>(
      path.join(dataDir, "workflows"),
      (raw) => WorkflowSchema.parse(raw),
      (workflow) => this.events.emit("changed", { workflow }),
      nowIso,
    );
    this.pendingRecords = new JsonRecordStore<PendingWorkflowMessages>(
      path.join(dataDir, "workflow-pending-messages"),
      parsePendingWorkflowMessages,
      () => {},
      nowIso,
    );
    this.library = new TemplateLibrary(path.join(dataDir, "workflows", "templates"), globalTemplates);
    this.disposeLibrary = this.library.events.on("changed", () =>
      this.events.emit("templatesChanged", {}),
    );
    agents.dispatchGuard = (manager, _spec) => this.guardDispatch(manager);
    // Workers inherit their workflow's per-run cost cap at dispatch — set
    // beside the guard so both halves of dispatch policy come from one place.
    agents.dispatchCostCap = async (manager) =>
      (await this.workflowForRun(manager))?.runCapUsd ?? null;
    // A context handoff replaces a manager session with a fresh chain — the
    // workflow's remote control (message/queue delivery) must follow it.
    agents.onHandoff = (from, to) => {
      const id = workflowIdOfRun(from);
      if (!id || from.role !== "manager") return;
      void this.mutate(id, (workflow) => ({
        workflow: { ...workflow, managerRunId: to.id },
        result: undefined,
      })).catch((err) =>
        console.warn(`[crystal] could not repoint workflow ${id} after handoff:`, (err as Error).message),
      );
    };
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
    if (this.agents.dispatchCostCap != null) this.agents.dispatchCostCap = null;
    if (this.agents.onHandoff != null) this.agents.onHandoff = null;
  }

  private ensureLoaded(): Promise<void> {
    return (this.loading ??= this.loadRecords());
  }

  private async loadRecords(): Promise<void> {
    await Promise.all([this.records.ensureLoaded(), this.pendingRecords.ensureLoaded()]);
    for (const record of this.pendingRecords.all()) {
      for (const message of record.messages) this.pendingMessages.push(record.id, message);
    }
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

  /** Serialize lifecycle operations whose liveness checks must stay adjacent to their spawn. */
  private serializeWorkflow<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    const step = (this.workflowLocks.get(workflowId) ?? Promise.resolve()).then(fn);
    this.workflowLocks.set(workflowId, step.catch(() => {}));
    return step;
  }

  /** Persist before exposing a queued receipt. Caller holds the workflow lock. */
  private async queueMessageLocked(workflowId: string, text: string): Promise<void> {
    const message = { text, at: nowIso() };
    const current = this.pendingRecords.peek(workflowId);
    if (current) {
      await this.pendingRecords.mutate(workflowId, (record) => ({
        record: { ...record, messages: [...record.messages, message] },
        result: undefined,
      }));
    } else {
      await this.pendingRecords.put({ id: workflowId, messages: [message], updatedAt: message.at });
    }
    this.pendingMessages.push(workflowId, message);
  }

  private queueMessage(workflowId: string, text: string): Promise<void> {
    return this.serializeWorkflow(workflowId, () => this.queueMessageLocked(workflowId, text));
  }

  /** The delivery has spawned; remove exactly the snapshot it carried. */
  private async acknowledgeMessagesLocked(workflowId: string, count: number): Promise<void> {
    const current = this.pendingRecords.peek(workflowId);
    if (!current) return;
    const messages = current.messages.slice(count);
    if (!messages.length) {
      await this.pendingRecords.remove(workflowId);
      return;
    }
    await this.pendingRecords.mutate(workflowId, (record) => ({
      record: { ...record, messages },
      result: undefined,
    }));
  }

  private async clearMessagesLocked(workflowId: string): Promise<void> {
    this.pendingMessages.clear(workflowId);
    if (this.pendingRecords.peek(workflowId)) await this.pendingRecords.remove(workflowId);
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
    /** Per-dispatch manager model — beats the profile and the roster preset. */
    managerModel?: string | null;
    budgetUsd?: number | null;
    /** Per-run spend ceiling stamped onto every run of the workflow. */
    runCapUsd?: number | null;
    /**
     * Host the manager as a native interactive Claude session in the terminal
     * panel instead of a headless run — the owner answers its questions
     * (AskUserQuestion) right there, and steering messages are typed in live.
     * DEFAULT when an interactive launcher is wired (a workspace with a
     * terminal host); pass `false` explicitly for an unattended headless
     * manager (the hub's cross-project dispatches always do).
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
    // Pre-flight before the first expensive run: what the repo's markers say
    // the work needs vs what the agents' spawn PATH can resolve. Set before
    // the prompt is built — gaps belong in the kickoff, not in a worker's
    // "command not found" three stages later. Never blocks a start: an
    // unprobeable environment is itself a fact the report can't improve on.
    const root = this.agents.workspaceRoot;
    if (root) {
      workflow.env = await probeEnvironment(path.resolve(root, workflow.cwd)).catch(() => null);
      // Premise check, same timing and for the same reason: the brief's
      // `assert:` claims are verified against the real repo before the first
      // paid run, and failures ride the kickoff prompt + dispatch report.
      workflow.premise = await probeAssertions(
        path.resolve(root, workflow.cwd),
        workflow.goal,
      ).catch(() => null);
    }
    // Baseline for the typed-turn-outcome contract: the first manager turn is
    // judged against the workflow as started, same as every later turn.
    workflow.progressFingerprint = workflowProgressFingerprint(workflow, 0, await this.boardTasks());

    const { params, roster, preset } = await this.managerParams(workflow, {
      agentId: init.agentId ?? null,
      managerModel: init.managerModel ?? null,
    });

    // Settlement hooks must be able to find the workflow even when the first
    // manager exits synchronously inside start(). The later manager-id patch
    // is a mutation so it cannot overwrite work the settle hook recorded.
    await this.records.put(workflow);

    let run: AgentRun;
    // Interactive is the default wherever it is possible: the launcher is
    // wired only when the workspace can host a PTY. Only an explicit
    // `interactive: false` (unattended workflows, hub dispatches) opts out.
    if (init.interactive !== false && this.interactiveLauncher) {
      const launched = await this.interactiveLauncher({
        ...params,
        prompt: buildWorkflowManagerPrompt(workflow, roster.agents, preset) + WORKFLOW_INTERACTIVE_NOTE,
        title: `workflow · ${workflow.name}`,
      });
      run = launched.run;
    } else {
      run = await this.agents.start({
        ...params,
        // Interactive managers can't be capped live (no usage stream while the
        // TUI runs) — headless manager turns are, same as their workers.
        costCapUsd: workflow.runCapUsd ?? null,
        prompt: buildWorkflowManagerPrompt(workflow, roster.agents, preset),
      });
    }
    const stored = await this.mutate(workflow.id, (current) => {
      const next = { ...current, managerRunId: run.id };
      return { workflow: next, result: next };
    });
    return { workflow: stored, run };
  }

  /**
   * Resolve spawn parameters for a manager session of `workflow` — shared by
   * `start` and `compact`, which must agree on profile/model/tag resolution
   * or a compacted manager would come back as a different agent. An explicit
   * agentId wins, else the roster names its manager (managerAgentId ??
   * defaultAgentId); only when nothing resolves does the hardcoded default
   * apply — the manager runs heavyweight; workers are where cost routing
   * happens (per-stage agents/models).
   */
  private async managerParams(
    workflow: Workflow,
    init: { agentId?: string | null; managerModel?: string | null },
  ) {
    const roster = this.agentLibrary ? await this.agentLibrary.roster() : await this.store.loadAgents();
    const managerAgentId =
      init.agentId ?? roster.managerAgentId ?? roster.defaultAgentId ?? null;
    const profile = managerAgentId
      ? (roster.agents.find((a) => a.id === managerAgentId) ?? null)
      : null;
    const preset = presetById(roster.preset);
    const overlay = profile ? profileOverlay(profile, preset, { role: "manager" }) : null;
    const params = applyProfileOverlay(
      {
        cwd: workflow.cwd,
        projectId: workflow.projectId,
        // The resolved profile is the run's attribution (agent:<id> tag,
        // resume-time policy), even when it came from the roster's default.
        agentId: overlay ? overlay.agentId : workflow.agentId,
        role: "manager" as const,
        purpose: "manage" as const,
        tags: [workflowTag(workflow.id)],
        provider: null as AgentProvider | null,
        model: (init.managerModel ?? null) as string | null,
        skills: [] as string[],
      },
      overlay,
    );
    // No explicit model, no profile pin → the project's preset names the
    // orchestrator model and provider (Delegated: Fable on Claude).
    if (!params.model) {
      const resolved = resolvePresetModel(preset, "manager");
      params.model = resolved.model;
      params.provider ??= resolved.provider;
    }
    // The manager coordinates in place — a profile's worktree default is a
    // worker policy, and an isolated manager could not keep the board honest.
    (params as { isolation?: unknown }).isolation = undefined;
    return { params, roster, preset };
  }

  /**
   * Checkpoint/compact: retire the manager's transcript and respawn it from
   * durable state. Every resume of a long chain re-ingests the whole session
   * — six wakes of a big orchestrator can burn dollars on pure context. The
   * workflow record and the board are the durable memory *by design* (the
   * prompt tells the manager so), which is what makes this safe: a fresh
   * session seeded with the standing prompt + current status text restores
   * coordination without the transcript. Refused while any run is live —
   * a settling worker resumes the chain that dispatched it, and a retired
   * chain being resumed would fork coordination across two sessions. An
   * interactive manager compacts into a headless one (steering still works
   * via `message`).
   */
  async compact(workflowId: string): Promise<{ workflow: Workflow; run: AgentRun }> {
    await this.ensureLoaded();
    return this.serializeWorkflow(workflowId, async () => {
      const wf = this.records.peek(workflowId);
      if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
      if (wf.status !== "running" && wf.status !== "paused") {
        throw new Error(`Workflow is ${wf.status} — nothing to compact.`);
      }
      const live = (await this.agents.runsWithTag(workflowTag(workflowId))).filter(
        (r) => r.status === "running" || r.status === "queued",
      );
      if (live.length) {
        throw new Error(
          `Workflow has ${live.length} live run(s) — compact between waves, after everything settles.`,
        );
      }
      const { params, roster, preset } = await this.managerParams(wf, { agentId: wf.agentId });
      const status = workflowStatusText(wf, await this.spend(workflowId));
      const prompt =
        buildWorkflowManagerPrompt(wf, roster.agents, preset) +
        "\n\nCOMPACTED SESSION: you are a fresh manager session taking over this workflow mid-flight — " +
        "your predecessor's transcript was retired to cut resume cost. The status below and the board " +
        "are the durable memory; read board_status before acting, and do NOT redo settled stages.\n\n" +
        status;
      const run = await this.agents.start({
        ...params,
        costCapUsd: wf.runCapUsd ?? null,
        prompt,
      });
      const workflow = await this.mutate(workflowId, (current) => {
        const next: Workflow = { ...current, managerRunId: run.id };
        return { workflow: next, result: next };
      });
      return { workflow, run };
    });
  }

  /**
   * Remote control: deliver a user message into the manager's interactive
   * session, returning a typed {@link SteerReceipt} — the caller learns
   * whether it was typed into a live terminal (free), delivered by waking
   * the session (a paid full-context resume), or queued. Queued while a
   * chain turn is live — two concurrent resumes of one Claude session would
   * fork it — and also when `wake: false` asks for the cheap path: parked
   * for the next natural wake, since every settlement flushes the queue
   * into a turn that was being paid for anyway.
   */
  async message(
    workflowId: string,
    text: string,
    opts: { wake?: boolean } = {},
  ): Promise<{ run: AgentRun | null; queued: boolean } & SteerReceipt> {
    await this.ensureLoaded();
    return this.serializeWorkflow(workflowId, async () => {
      const workflow = this.records.peek(workflowId);
      if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
      if (!workflow.managerRunId) throw new Error(`Workflow ${workflowId} has no manager session`);
      const framed = formatUserMessage(text);
      // An interactive manager takes the message in its terminal, mid-turn or
      // not — the TUI queues input itself, so this can never fork the session.
      const interactive = await this.agents
        .deliverInteractive(workflow.managerRunId, framed)
        .catch(() => null);
      if (interactive) {
        return { run: interactive, queued: false, mode: "interactive" as const, wakeExpected: true };
      }
      await this.assertManagerCanReceive(workflowId, workflow.managerRunId);
      if (opts.wake === false) {
        await this.queueMessageLocked(workflowId, framed);
        return {
          run: null,
          queued: true,
          mode: "queued" as const,
          wakeExpected: await this.wakeExpected(workflowId),
        };
      }
      // The workflow lock keeps a compaction from retiring this chain between
      // the manager-id read and the resume attempt.
      const run = await this.agents.resumeChain(workflow.managerRunId, framed);
      if (!run) {
        await this.assertManagerCanReceive(workflowId, workflow.managerRunId);
        await this.queueMessageLocked(workflowId, framed);
        return {
          run: null,
          queued: true,
          mode: "queued" as const,
          wakeExpected: await this.wakeExpected(workflowId),
        };
      }
      return { run, queued: false, mode: "resumed" as const, wakeExpected: true };
    });
  }

  /** Refuse a receipt for a manager chain whose session can never be resumed. */
  private async assertManagerCanReceive(workflowId: string, managerRunId: string): Promise<void> {
    const chain = await this.agents.chainRuns(managerRunId);
    const latest = chain[chain.length - 1];
    const live = chain.some((run) => run.status === "running" || run.status === "queued");
    if (latest?.status !== "cancelled" && (live || chain.some((run) => run.sessionId))) return;
    throw new Error(`Workflow ${workflowId}'s manager session has ended and cannot receive messages.`);
  }

  /** Is any run of the workflow live — i.e. will a settlement flush the queue? */
  private async wakeExpected(workflowId: string): Promise<boolean> {
    const runs = await this.agents.runsWithTag(workflowTag(workflowId));
    return runs.some((r) => r.status === "running" || r.status === "queued");
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
        // Resuming forgives an accumulated stall streak — without this, one
        // more quiet turn after a stall-pause resume would re-pause instantly.
        noProgressTurns: paused ? wf.noProgressTurns : 0,
      };
      return { workflow, result: workflow };
    });
  }

  /** Raise/lower/clear the budget (clears a budget-exhausted pause when it now fits). */
  setBudget(workflowId: string, budgetUsd: number | null): Promise<Workflow> {
    return this.mutate(workflowId, async (wf) => {
      // A re-armed tripwire: raising (or clearing) the budget makes the old
      // warning stale, and the manager deserves a fresh one near the new edge.
      const workflow: Workflow = { ...wf, budgetUsd, budgetWarnedAt: null };
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

  /**
   * Set/clear the per-run cost cap. Applies to runs spawned from now on —
   * live runs keep the cap they were stamped with at start.
   */
  setRunCap(workflowId: string, runCapUsd: number | null): Promise<Workflow> {
    return this.mutate(workflowId, (wf) => {
      const workflow: Workflow = { ...wf, runCapUsd };
      return { workflow, result: workflow };
    });
  }

  /** Cancel: kill every live run of the workflow and mark it cancelled. */
  async cancel(workflowId: string): Promise<Workflow> {
    await this.ensureLoaded();
    return this.serializeWorkflow(workflowId, async () => {
      const wf = this.records.peek(workflowId);
      if (!wf) throw new Error(`Unknown workflow: ${workflowId}`);
      await this.clearMessagesLocked(workflowId);
      const tag = workflowTag(workflowId);
      const live = (await this.agents.runsWithTag(tag)).filter(
        (r) => r.status === "running" || r.status === "queued",
      );
      for (const run of live) {
        await this.agents.cancel(run.id).catch(() => {
          // A run that settled while we iterated is already dead — fine.
        });
      }
      const workflow = await this.mutate(workflowId, (current) => {
        // Idempotent under the queue: a workflow that reached another terminal
        // state while we were killing runs keeps that state.
        const terminal =
          current.status === "completed" ||
          current.status === "failed" ||
          current.status === "cancelled";
        const next: Workflow = terminal
          ? current
          : { ...current, status: "cancelled", pausedBy: null, pausedReason: null };
        return { workflow: next, result: next };
      });
      // Terminal write committed — expire the questions it stranded.
      await this.expireQuestions(workflowId, workflow.status);
      return workflow;
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
  async complete(
    workflowId: string,
    outcome: "completed" | "failed",
    summary: string,
  ): Promise<Workflow> {
    await this.ensureLoaded();
    return this.serializeWorkflow(workflowId, async () => {
      const current = this.records.peek(workflowId);
      if (!current) throw new Error(`Unknown workflow: ${workflowId}`);
      const managerIds = new Set(
        current.managerRunId
          ? (await this.agents.chainRuns(current.managerRunId)).map((run) => run.id)
          : [],
      );
      const liveWorkers = (await this.agents.runsWithTag(workflowTag(workflowId))).filter(
        (run) =>
          (run.status === "running" || run.status === "queued") && !managerIds.has(run.id),
      );
      if (liveWorkers.length) {
        throw new Error(
          `Workflow has ${liveWorkers.length} live worker run(s). Wait for them to settle or cancel ` +
          `the workers before completing it.`,
        );
      }
      const workflow = await this.mutate(workflowId, (wf) => {
        const next: Workflow = {
          ...wf,
          status: outcome,
          summary,
          pausedBy: null,
          pausedReason: null,
        };
        return { workflow: next, result: next };
      });
      // Terminal write committed — expire the questions it stranded.
      await this.expireQuestions(workflowId, workflow.status);
      return workflow;
    });
  }

  /**
   * Close open origin questions of a settled workflow — after the terminal
   * write is durable, never before (the record IS the evidence). A failed
   * closure is logged, not fatal: the startup reconcile repairs it.
   */
  private async expireQuestions(workflowId: string, status: Workflow["status"]): Promise<void> {
    if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
    try {
      await this.questionExpiry?.(workflowId, status);
    } catch (err) {
      console.warn(
        `[crystal] question expiry failed for workflow ${workflowId}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Startup reconcile: every PERSISTED workflow record that is terminal runs
   * the same idempotent question closure — a transition that happened while
   * the server was down (or whose closure write failed) is still honoured.
   * The absence of a record never expires anything, by design: only a
   * durable terminal status is evidence of death. No periodic GC.
   */
  async reconcileQuestionExpiry(): Promise<void> {
    await this.ensureLoaded();
    for (const workflow of await this.list()) {
      await this.expireQuestions(workflow.id, workflow.status);
    }
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
        } else if (budgetWarningDue(budget) && !workflow.budgetWarnedAt) {
          // Pre-exhaustion tripwire, once: warn while there is still money to
          // wrap up with. Rides the pending queue so it lands on this very
          // settlement's flush (or the next idle moment), pre-framed — it is
          // an engine notice, not words the owner said.
          const warned = await this.mutate(id, (wf) => {
            if (wf.budgetWarnedAt || wf.budgetUsd == null) return { workflow: wf, result: false };
            return { workflow: { ...wf, budgetWarnedAt: nowIso() }, result: true };
          });
          if (warned) await this.queueMessage(id, budgetWarningText(budget));
        }
      }
      // Typed turn outcomes: a settled MANAGER turn must have changed
      // something — dispatched, advanced, moved the board, asked, or
      // completed. Judged by fingerprint so the definition of "something"
      // lives in one pure function; consecutive unchanged turns past the
      // limit pause the workflow, because resuming an orchestrator against
      // an unchanged board only converts money into nothing.
      if (run.role === "manager") {
        const runs = await this.agents.runsWithTag(workflowTag(id));
        const workerCount = runs.filter((r) => r.role !== "manager").length;
        const tasks = await this.boardTasks();
        await this.mutate(id, (wf) => {
          if (wf.status !== "running" && wf.status !== "paused") {
            return { workflow: wf, result: null };
          }
          const fingerprint = workflowProgressFingerprint(wf, workerCount, tasks);
          const progressed =
            wf.progressFingerprint == null || fingerprint !== wf.progressFingerprint;
          // Marginal value per turn: what this settled turn cost, next to
          // whether it changed anything — the UI's "a run that changes
          // nothing should be visually loud" is read straight off this log.
          const turnLog = appendTurnLog(wf.turnLog, {
            runId: run.id,
            at: nowIso(),
            costUsd: runCostUsd(run),
            progressed,
          });
          if (progressed) {
            return {
              workflow: { ...wf, turnLog, progressFingerprint: fingerprint, noProgressTurns: 0 },
              result: null,
            };
          }
          const turns = wf.noProgressTurns + 1;
          const stall = turns >= STALL_TURN_LIMIT && wf.status === "running";
          const workflow: Workflow = {
            ...wf,
            turnLog,
            noProgressTurns: turns,
            ...(stall
              ? {
                  status: "paused" as const,
                  pausedBy: "stall" as const,
                  pausedReason:
                    `Stalled: ${turns} consecutive manager turns ended without settling anything ` +
                    `(no dispatch, stage/board movement, question, or completion). ` +
                    `Resume it after steering, or cancel it.`,
                }
              : {}),
          };
          return { workflow, result: null };
        });
      }
      await this.flushMessages(id);
      // Spend changed even when nothing above did — let UIs refresh.
      const fresh = this.records.peek(id);
      if (fresh) this.events.emit("changed", { workflow: { ...fresh } });
    } catch (err) {
      console.warn(`[crystal] workflow settle hook failed for ${id}:`, (err as Error).message);
    }
  }

  /**
   * Every board task in the workspace — input to the progress fingerprint
   * (which filters to the workflow's own). Degrades to empty when the store
   * can't serve projects (tests, headless embeddings): the fingerprint then
   * still tracks stages/tracks/dispatches, just not board movement.
   */
  private async boardTasks(): Promise<TaskItem[]> {
    try {
      const projects = await this.store.loadProjects();
      return projects.flatMap((p) => p.project.tasks);
    } catch {
      return [];
    }
  }

  /**
   * Deliver queued messages once no chain run is live. The queue holds
   * *pre-framed* text (owner steering wears its USER MESSAGE wrapper from
   * `message`; engine notices like the budget warning carry their own) so
   * this can join them verbatim — a system tripwire must not be dressed up
   * as words the owner never said.
   */
  private async flushMessages(workflowId: string): Promise<void> {
    await this.serializeWorkflow(workflowId, async () => {
      const workflow = this.records.peek(workflowId);
      if (!workflow?.managerRunId) return;
      const managerRunId = workflow.managerRunId;
      await this.pendingMessages.drain(workflowId, async (pending) => {
        const text =
          pending.length === 1
            ? pending[0]!.text
            : `${pending.length} messages arrived while you were working.\n\n` +
              pending.map((message) => message.text).join("\n\n---\n\n");
        const run = await this.agents.resumeChain(managerRunId, text);
        if (!run) return null;
        await this.acknowledgeMessagesLocked(workflowId, pending.length);
        return run;
      });
    });
  }
}

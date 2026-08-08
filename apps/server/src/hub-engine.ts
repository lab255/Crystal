import path from "node:path";
import {
  Emitter,
  ProgramSchema,
  addDelivery,
  buildProgramManagerPrompt,
  createProgram,
  deliveryById,
  deliveryGoalText,
  deliveryReadiness,
  deliverySettledNotice,
  emptyDeliverySpend,
  formatProgramMessage,
  isDeliveryTerminal,
  isProgramLive,
  isProgramTerminal,
  questionsNotice,
  managerSpend,
  sumDeliverySpend,
  nowIso,
  patchDelivery,
  portfolioStatusText,
  programBudgetState,
  programIdOfRun,
  programOutcome,
  programSpend,
  programStatusText,
  programTag,
  readyDeliveries,
  applyProfileOverlay,
  presetById,
  profileOverlay,
  resolvePresetModel,
  type AgentProfile,
  type AgentProfileOverlay,
  type AgentProvider,
  type AgentRun,
  type DeliveryInit,
  type DeliverySpend,
  type DeliveryStatus,
  type HubDispatchReport,
  type HubProject,
  type HubQuestion,
  type HubRecentProject,
  type Program,
  type ProgramDelivery,
  type ProgramSpend,
  type RunEvent,
  type SteerReceipt,
  type Workflow,
} from "@crystal/core";
import type { AgentManager, InteractiveSpawn } from "./agent-manager.js";
import type { GlobalAgentStore } from "./agent-library.js";
import { JsonRecordStore } from "./record-store.js";
import { SettledRuns } from "./settled-runs.js";
import { PendingQueue } from "./pending-queue.js";

/**
 * The cross-project half of the orchestration stack (rules live in
 * `@crystal/core` hub.ts). Where a WorkflowEngine owns one project's workflows,
 * the HubEngine sits *above* every workspace this server hosts and owns
 * **programs**: one high-level epic, split into per-project deliveries, each
 * handed to that project's own orchestrator as a workflow.
 *
 *  - `dispatch` opens the target workspace (if it isn't already) and starts a
 *    workflow there whose goal is the delivery brief plus the program's
 *    cross-project context. From that moment the project drives its own
 *    development flow; the hub only watches.
 *  - `onWorkflowChanged` is the feedback edge: a project workflow settling
 *    moves its delivery, unblocks and auto-dispatches dependents, enforces the
 *    program budget, and wakes the program manager with the result.
 *  - `startManager` spawns the optional **program manager** — an interactive,
 *    resume-chained session that owns the program through the hub's MCP tools,
 *    exactly as a workflow manager owns one project's workflow.
 *
 * Programs are stored centrally (`~/.crystal/hub/programs`), not per workspace:
 * a program outlives any single project and routinely spans several.
 */

/**
 * Trailing protocol for an interactive program manager (a native Claude TUI
 * in a workspace terminal, owner present). The headless prompt already covers
 * the MCP protocol; this adds the terminal-native question etiquette.
 */
const INTERACTIVE_MANAGER_NOTE =
  "\n\nYou are running interactively, in a terminal the program owner can see. When a " +
  "decision needs the owner, put it to them directly with your AskUserQuestion tool — " +
  "they answer right here (or from their phone). Project questions listed under NEEDS AN " +
  "ANSWER still close only via answer_question; relay the owner's decision through it so " +
  "the asking project resumes. Notices (settlements, new questions, owner messages) are " +
  "typed into this session as they happen.";

/** One project the hub can address (the protocol type lives in core). */
export type HubProjectRef = HubProject;
export type { HubRecentProject };

/**
 * Everything the hub needs from the workspace layer, as a narrow port: the
 * engine never touches WorkspaceRegistry directly, so the whole cross-project
 * lifecycle is testable without opening real workspaces or spawning agents.
 * The production adapter is `registryProjects` in server.ts.
 */
export interface HubProjects {
  /** Open (or return the already-open) workspace at `root`. */
  open(root: string): Promise<HubProjectRef>;
  /** Currently-open workspaces. */
  list(): HubProjectRef[];
  /** Previously-opened workspaces (the reopen list), most recent first. */
  recents(): Promise<HubRecentProject[]>;
  /** Start a workflow in one project — its orchestrator takes over from here. */
  startWorkflow(
    ws: string,
    init: {
      name: string;
      goal: string;
      templateId?: string;
      budgetUsd?: number | null;
      runCapUsd?: number | null;
      /** Hub dispatches always pass false — nobody sits at a delivery's terminal. */
      interactive?: boolean;
    },
  ): Promise<Workflow>;
  /**
   * A project workflow's record; null when it is gone. Separate from
   * {@link workflowSpend} because spend costs a full run-history scan and most
   * callers (question sweeps, answer routing) only want the record.
   */
  workflow(ws: string, workflowId: string): Promise<Workflow | null>;
  /** A workflow's live spend — the delivery's spend *is* its workflow's. */
  workflowSpend(ws: string, workflowId: string): Promise<DeliverySpend | null>;
  /**
   * Deliver a steering message into a project orchestrator's session.
   * `wake: false` parks it for the next natural wake instead of forcing a
   * paid resume; the receipt says which of the three actually happened.
   */
  messageWorkflow(
    ws: string,
    workflowId: string,
    text: string,
    opts?: { wake?: boolean },
  ): Promise<{ queued: boolean } & SteerReceipt>;
  /** Checkpoint a workflow's manager into a fresh session (see WorkflowEngine.compact). */
  compactWorkflow(ws: string, workflowId: string): Promise<void>;
  setWorkflowPaused(ws: string, workflowId: string, paused: boolean, reason?: string | null): Promise<void>;
  setWorkflowBudget(ws: string, workflowId: string, budgetUsd: number | null): Promise<void>;
  cancelWorkflow(ws: string, workflowId: string): Promise<void>;
  /** The project's task board, rendered for an agent. */
  boardSnapshot(ws: string): Promise<string>;
  /**
   * Unanswered questions raised on the board tasks belonging to `workflow` —
   * a delivery that stopped to ask. Derived from the project, never stored.
   */
  openQuestions(ws: string, workflowId: string): Promise<ProjectQuestion[]>;
  /**
   * Answer one — recorded on the board *and* handed back to the run that
   * asked, so the delivery carries on instead of staying stopped.
   */
  answerQuestion(
    ws: string,
    workflowId: string,
    taskId: string,
    questionId: string,
    answer: string,
  ): Promise<{ ok: true; resumedRunId: string | null } | { ok: false; reason: string }>;
}

/** Outcome of one dispatch wave (the protocol type lives in core). */
export type DispatchReport = HubDispatchReport;
type DispatchItem =
  | { kind: "dispatched"; value: DispatchReport["dispatched"][number] }
  | { kind: "skipped"; value: DispatchReport["skipped"][number] };

/**
 * One open question on a project's board, before the hub attributes it to a
 * delivery — exactly {@link HubQuestion} minus what only the hub knows.
 */
export type ProjectQuestion = Omit<HubQuestion, "deliveryId" | "projectName" | "ws">;

/** Trailing window that collapses a burst of board writes into one sweep. */
const QUESTION_SWEEP_DEBOUNCE_MS = 400;

export class HubEngine {
  readonly events = new Emitter<{
    changed: { program: Program };
    removed: { programId: string };
    questionsChanged: { programId: string; questions: HubQuestion[] };
  }>();

  /** Notices waiting for a program manager chain to go idle, per program. */
  private pendingNotices = new PendingQueue<string>();
  private readonly settledRuns = new SettledRuns();
  /**
   * The open-question id set last seen per program, joined — the cheap diff
   * that turns "the board changed" into "these questions are new".
   */
  private questionSets = new Map<string, string>();
  /** Pending debounced question sweeps, per workspace. */
  private sweepTimers = new Map<string, NodeJS.Timeout>();
  /** In-flight sweep per program, so two never race on `questionSets`. */
  private sweepChains = new Map<string, Promise<unknown>>();
  /** Readiness through persisted dispatch, serialized across the portfolio. */
  private projectDispatchQueues = new Map<string, Promise<unknown>>();
  private disposeListener: (() => void) | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly projects: HubProjects,
    /**
     * Agent host for program-manager sessions, rooted at the hub's own
     * directory — a program manager belongs to no single project. Null
     * disables the manager (the hub is then driven purely over MCP/UI).
     */
    private readonly agents: AgentManager | null = null,
    /**
     * The shared agent library. The hub is cross-project, so a manager's
     * `agentId` resolves here — never against any workspace's roster. Null
     * keeps managers on the classic hardcoded default.
     */
    private readonly profiles: GlobalAgentStore | null = null,
  ) {
    this.store = new JsonRecordStore<Program>(
      path.join(dataDir, "programs"),
      (raw) => ProgramSchema.parse(raw),
      (program) => this.events.emit("changed", { program }),
      nowIso,
    );
    if (!agents) return;
    this.disposeListener = agents.events.on("runChanged", ({ run }) => {
      if (!programIdOfRun(run) || !this.settledRuns.claim(run)) return;
      void this.onManagerSettled(run);
    });
  }

  dispose(): void {
    this.disposeListener?.();
    this.disposeListener = null;
    for (const timer of this.sweepTimers.values()) clearTimeout(timer);
    this.sweepTimers.clear();
  }

  /** Persisted programs, with the serialized read-modify-write (see JsonRecordStore). */
  private readonly store: JsonRecordStore<Program>;

  private ensureLoaded(): Promise<void> {
    return this.store.ensureLoaded();
  }

  /** Serialize one read-modify-write against a program record. */
  private mutate<T>(
    programId: string,
    fn: (program: Program) => { program: Program; result: T } | Promise<{ program: Program; result: T }>,
  ): Promise<T> {
    return this.store.mutate(programId, async (record) => {
      const { program, result } = await fn(record);
      return { record: program, result };
    });
  }

  /** One project can host only one orchestrator, even across different programs. */
  private serializeProjectDispatch<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.projectDispatchQueues.get(root) ?? Promise.resolve();
    const step = previous.then(fn);
    const tail = step.catch(() => {});
    this.projectDispatchQueues.set(root, tail);
    void tail.finally(() => {
      if (this.projectDispatchQueues.get(root) === tail) this.projectDispatchQueues.delete(root);
    });
    return step;
  }

  /* ---------------- reads ---------------- */

  list(): Promise<Program[]> {
    return this.store.list();
  }

  get(programId: string): Promise<Program | null> {
    return this.store.get(programId);
  }


  /** Rolled-up spend: every dispatched delivery's workflow, plus the manager chain. */
  async spend(programId: string, managerRuns?: readonly AgentRun[]): Promise<ProgramSpend> {
    const program = await this.get(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    const byDelivery: Record<string, DeliverySpend> = {};
    let stale = false;
    await Promise.all(
      program.deliveries.map(async (delivery) => {
        if (!delivery.ws) return;
        // Every workflow this delivery has run, not just the current one: a
        // retried delivery already spent real money, and dropping it would
        // reset the program's ceiling on every retry.
        const workflowIds = [...delivery.priorWorkflowIds];
        if (delivery.workflowId) workflowIds.push(delivery.workflowId);
        if (!workflowIds.length) return;
        // A rollup must never throw — but "could not read" and "cost nothing"
        // are different answers, and only the second may be treated as zero.
        // A live delivery in a closed project makes the total a lower bound.
        const parts = await Promise.all(
          workflowIds.map((workflowId) =>
            this.projects.workflowSpend(delivery.ws!, workflowId).catch(() => {
              if (!isDeliveryTerminal(delivery.status)) stale = true;
              return null;
            }),
          ),
        );
        if (!isDeliveryTerminal(delivery.status) && parts.some((part) => part === null)) {
          stale = true;
        }
        const spend = sumDeliverySpend(parts);
        if (spend) byDelivery[delivery.id] = spend;
      }),
    );
    const manager = this.agents
      ? managerSpend(programId, managerRuns ?? (await this.agents.list()))
      : emptyDeliverySpend();
    return programSpend(byDelivery, manager, stale);
  }

  async statusText(programId: string): Promise<string> {
    const program = await this.get(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    const [spend, questions] = await Promise.all([
      this.spend(programId),
      this.questions(programId),
    ]);
    // The whole portfolio, so the ready list matches what dispatch will do.
    const others = this.store.all().filter((p) => p.id !== programId);
    return programStatusText(program, spend, questions, others);
  }

  /**
   * Open questions across a program's live deliveries. Only live ones are
   * asked about: a terminal delivery cannot be waiting on anybody, and each
   * lookup reads that project's board.
   */
  async questions(programId: string): Promise<HubQuestion[]> {
    const program = await this.get(programId);
    if (!program) return [];
    const perDelivery = await Promise.all(
      program.deliveries.map(async (delivery): Promise<HubQuestion[]> => {
        if (!delivery.ws || !delivery.workflowId || isDeliveryTerminal(delivery.status)) return [];
        const raw = await this.projects
          .openQuestions(delivery.ws, delivery.workflowId)
          .catch(() => [] as ProjectQuestion[]);
        return raw.map((q) => ({
          ...q,
          deliveryId: delivery.id,
          projectName: delivery.projectName,
          ws: delivery.ws!,
        }));
      }),
    );
    return perDelivery.flat();
  }

  /** Open questions for every live program, keyed by program id (the UI's first load). */
  async allQuestions(): Promise<Record<string, HubQuestion[]>> {
    const programs = (await this.list()).filter((p) => isProgramLive(p.status));
    const out: Record<string, HubQuestion[]> = {};
    await Promise.all(
      programs.map(async (p) => {
        const questions = await this.questions(p.id);
        if (questions.length) out[p.id] = questions;
      }),
    );
    return out;
  }

  /** The portfolio rendering across every program. */
  async portfolioText(): Promise<string> {
    const programs = await this.list();
    // One run list for the whole portfolio, not one per program.
    const runs = this.agents ? await this.agents.list() : [];
    const questions = await this.allQuestions();
    const entries = await Promise.all(
      programs.map(async (program) => ({
        program,
        spend: await this.spend(program.id, runs),
        // The portfolio is an external agent's *primary* view — a project
        // that has stopped to ask something must be visible here too.
        questions: questions[program.id] ?? [],
      })),
    );
    return portfolioStatusText(entries);
  }

  /** Every project the hub can address: open first, then the reopen list. */
  async projectList(): Promise<{ open: HubProjectRef[]; recent: HubRecentProject[] }> {
    const open = this.projects.list();
    const openRoots = new Set(open.map((p) => p.root));
    const recent = (await this.projects.recents()).filter((r) => !openRoots.has(r.root));
    return { open, recent };
  }


  /**
   * Resolve however an agent referred to a project — an open workspace id, or
   * an absolute root path — to a live workspace, opening it if needed. Agents
   * see both forms in `list_projects`, so both must address the same project.
   */
  async resolveProject(ref: string): Promise<HubProjectRef> {
    const open = this.projects.list().find((p) => p.ws === ref || p.root === ref);
    if (open) return open;
    return this.projects.open(ref);
  }

  /** The program a hub-hosted run manages (its `program:` tag), or null. */
  async programIdForRun(runId: string): Promise<string | null> {
    if (!this.agents) return null;
    const run = await this.agents.get(runId);
    return run ? programIdOfRun(run) : null;
  }

  /** The program owning a delivery — lets delivery-scoped tools take just its id. */
  async programIdForDelivery(deliveryId: string): Promise<string | null> {
    await this.ensureLoaded();
    for (const program of this.store.all()) {
      if (program.deliveries.some((d) => d.id === deliveryId)) return program.id;
    }
    return null;
  }

  boardSnapshot(ws: string): Promise<string> {
    return this.projects.boardSnapshot(ws);
  }


  /* ---------------- authoring ---------------- */

  async create(init: { name: string; goal: string; budgetUsd?: number | null }): Promise<Program> {
    const program = createProgram(init);
    await this.store.put(program);
    return { ...program };
  }

  /**
   * Add a delivery. The project root is resolved (and its workspace opened) up
   * front so a typo fails here rather than at dispatch, and the delivery
   * carries a real project name in every listing.
   */
  async addDelivery(programId: string, init: DeliveryInit): Promise<ProgramDelivery> {
    const project = await this.projects.open(init.projectRoot);
    return this.mutate(programId, (current) => {
      const { program, delivery } = addDelivery(current, {
        ...init,
        projectRoot: project.root,
        projectName: init.projectName ?? project.name,
      });
      return { program, result: delivery };
    });
  }

  /**
   * Forget a finished program. Only terminal ones: a live program still owns
   * project workflows, and deleting the record would orphan them (their
   * settlements would land on nothing). The workflows themselves — and every
   * run they billed — stay in their projects; this drops the hub's index of
   * them, which is what keeps the portfolio readable over months.
   */
  async remove(programId: string): Promise<void> {
    await this.ensureLoaded();
    const program = this.store.peek(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    if (isProgramLive(program.status)) {
      throw new Error(
        `Program is ${program.status} — cancel or complete it before removing it.`,
      );
    }
    this.pendingNotices.clear(programId);
    this.questionSets.delete(programId);
    await this.store.remove(programId);
    this.events.emit("removed", { programId });
  }

  /** Drop a delivery that has not been dispatched (and nothing depends on). */
  removeDelivery(programId: string, deliveryId: string): Promise<void> {
    return this.mutate(programId, (current) => {
      const delivery = deliveryById(current, deliveryId);
      if (!delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
      // `priorWorkflowIds` matters here: a retried delivery has a null
      // `workflowId` but real work (and real cost) behind it.
      if (delivery.workflowId || delivery.priorWorkflowIds.length) {
        throw new Error(
          `Delivery ${deliveryId} was already dispatched — cancel its workflow instead of removing it.`,
        );
      }
      const dependents = current.deliveries.filter((d) => d.dependsOn.includes(deliveryId));
      if (dependents.length) {
        throw new Error(
          `Delivery ${deliveryId} is a dependency of ${dependents.map((d) => d.id).join(", ")}.`,
        );
      }
      return {
        program: { ...current, deliveries: current.deliveries.filter((d) => d.id !== deliveryId) },
        result: undefined,
      };
    });
  }

  /**
   * Put a finished delivery back in the queue so it can be dispatched again.
   *
   * Without this a failed delivery is a dead end: its dependents wait on a
   * completion that can never come, its project stays locked for the whole
   * portfolio, and the program never reaches an outcome — the only way out
   * being to cancel the program and rebuild it. The previous attempt's
   * workflow, runs and cost stay in the project; the delivery simply gets a
   * fresh one, and the program reopens if it had already settled.
   *
   * Only a *failed* delivery is retried. A completed one is not a dead end,
   * and re-running it would clear the summary its dependents were dispatched
   * with and re-block them.
   */
  async retryDelivery(programId: string, deliveryId: string): Promise<Program> {
    const program = await this.mutate(programId, (current) => {
      const delivery = deliveryById(current, deliveryId);
      if (!delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
      if (!isDeliveryTerminal(delivery.status)) {
        throw new Error(`Delivery ${deliveryId} is ${delivery.status} — nothing to retry.`);
      }
      if (delivery.status === "completed") {
        throw new Error(
          `Delivery ${deliveryId} completed — add a new delivery rather than re-running a finished one.`,
        );
      }
      let next = patchDelivery(current, deliveryId, {
        status: "pending",
        workflowId: null,
        // Remember what it already ran: spend is attributed by workflow, and
        // a forgotten attempt would hand the retry a budget it had spent.
        priorWorkflowIds: delivery.workflowId
          ? [...delivery.priorWorkflowIds, delivery.workflowId]
          : delivery.priorWorkflowIds,
        summary: null,
        note: `Retried after ${delivery.status}`,
        dispatchedAt: null,
      });
      // A program that had settled has work to do again.
      if (isProgramTerminal(next.status)) {
        next = { ...next, status: "running", summary: null };
      }
      return { program: next, result: next };
    });
    // The retired workflow's questions are no longer answerable — they were
    // filed against a run that is gone. Recompute so the UI's "waiting on you"
    // banner clears instead of offering an answer the board will refuse.
    await this.sweepQuestions(programId).catch(() => {});
    return program;
  }

  /* ---------------- dispatch ---------------- */

  /**
   * Start every ready delivery (or just `deliveryIds`) as a workflow in its own
   * project. The project-root queue covers readiness through the persisted
   * delivery mutation, so another program cannot observe the old portfolio.
   */
  async dispatch(programId: string, deliveryIds?: string[]): Promise<DispatchReport> {
    const initial = await this.get(programId);
    if (!initial) throw new Error(`Unknown program: ${programId}`);
    // Every pending delivery is a candidate, not just the ready ones: blocked
    // deliveries are reported with the reason the caller can act on.
    const wanted = deliveryIds?.length
      ? deliveryIds.map((id) => {
          const delivery = deliveryById(initial, id);
          if (!delivery) throw new Error(`Unknown delivery: ${id}`);
          return delivery;
        })
      : initial.deliveries.filter((delivery) => delivery.status === "pending");
    const report: DispatchReport = { dispatched: [], skipped: [] };

    for (const target of wanted) {
      const item = await this.serializeProjectDispatch(target.projectRoot, () =>
        this.mutate<DispatchItem>(programId, async (program) => {
          const delivery = deliveryById(program, target.id)!;
          // Recompute under the portfolio-wide project lock. The preceding
          // holder has persisted its delivery before this callback can run.
          const others = this.store.all().filter((candidate) => candidate.id !== program.id);
          const readiness = deliveryReadiness(program, delivery, others);
          if (!readiness.ready) {
            return {
              program,
              result: {
                kind: "skipped" as const,
                value: {
                  deliveryId: delivery.id,
                  projectName: delivery.projectName,
                  reason: readiness.reason ?? "Not ready.",
                },
              },
            };
          }
          try {
            const project = await this.projects.open(delivery.projectRoot);
            const workflow = await this.projects.startWorkflow(project.ws, {
              name: `${program.name} — ${delivery.projectName}`,
              goal: deliveryGoalText(program, delivery),
              templateId: delivery.templateId ?? undefined,
              budgetUsd: delivery.budgetUsd,
              runCapUsd: delivery.runCapUsd,
              // A dispatched delivery is unattended by construction.
              interactive: false,
            });
            const next = patchDelivery(program, delivery.id, {
              ws: project.ws,
              projectName: project.name,
              workflowId: workflow.id,
              status: "running",
              note: null,
              dispatchedAt: nowIso(),
            });
            const gaps = (workflow.env?.checks ?? []).filter((c) => !c.ok).map((c) => c.label);
            const premiseGaps = (workflow.premise?.checks ?? [])
              .filter((c) => !c.ok)
              .map((c) => `${c.raw} — ${c.detail ?? "does not hold"}`);
            return {
              program: next,
              result: {
                kind: "dispatched" as const,
                value: {
                  deliveryId: delivery.id,
                  projectName: project.name,
                  ws: project.ws,
                  workflowId: workflow.id,
                  ...(gaps.length ? { envGaps: gaps } : {}),
                  ...(premiseGaps.length ? { premiseGaps } : {}),
                },
              },
            };
          } catch (err) {
            const reason = (err as Error).message;
            return {
              program: patchDelivery(program, delivery.id, { note: `Dispatch failed: ${reason}` }),
              result: {
                kind: "skipped" as const,
                value: { deliveryId: delivery.id, projectName: delivery.projectName, reason },
              },
            };
          }
        }),
      );
      if (item.kind === "dispatched") report.dispatched.push(item.value);
      else report.skipped.push(item.value);
    }
    return report;
  }

  /**
   * The one-shot path the MCP surface leads with: one project, one brief, one
   * program — created and dispatched in a single call.
   */
  async dispatchEpic(init: {
    projectRoot: string;
    name: string;
    goal: string;
    templateId?: string | null;
    budgetUsd?: number | null;
  }): Promise<{ program: Program; report: DispatchReport }> {
    const program = await this.create({
      name: init.name,
      goal: init.goal,
      budgetUsd: init.budgetUsd ?? null,
    });
    await this.addDelivery(program.id, {
      projectRoot: init.projectRoot,
      brief: init.goal,
      templateId: init.templateId ?? null,
      budgetUsd: init.budgetUsd ?? null,
    });
    const report = await this.dispatch(program.id);
    return { program: (await this.get(program.id))!, report };
  }

  /* ---------------- control ---------------- */

  /**
   * Hold (or release) the whole program: every live delivery's workflow is
   * paused with it, so pausing a program actually stops the spend rather than
   * only stopping new dispatches.
   */
  setPaused(
    programId: string,
    paused: boolean,
    reason?: string | null,
    /** What caused the hold — budget pauses auto-clear when the budget is raised. */
    by: "user" | "budget" = "user",
  ): Promise<Program> {
    return this.mutate(programId, async (current) => {
      if (current.status !== "running" && current.status !== "paused") {
        throw new Error(`Program is ${current.status} — cannot ${paused ? "pause" : "resume"} it.`);
      }
      let program: Program = {
        ...current,
        status: paused ? "paused" : "running",
        pausedBy: paused ? by : null,
        pausedReason: paused ? (reason ?? "Paused by the owner") : null,
      };
      for (const delivery of current.deliveries) {
        if (!delivery.ws || !delivery.workflowId) continue;
        if (paused ? delivery.status !== "running" : delivery.status !== "paused") continue;
        try {
          await this.projects.setWorkflowPaused(
            delivery.ws,
            delivery.workflowId,
            paused,
            paused ? `Program ${current.name} paused` : null,
          );
          program = patchDelivery(program, delivery.id, { status: paused ? "paused" : "running" });
        } catch (err) {
          // A project we can no longer reach must not block the program hold.
          program = patchDelivery(program, delivery.id, {
            note: `Could not ${paused ? "pause" : "resume"} its workflow: ${(err as Error).message}`,
          });
        }
      }
      return { program, result: program };
    });
  }

  /** Raise/lower/clear the program budget (clears a budget pause when it now fits). */
  setBudget(programId: string, budgetUsd: number | null): Promise<Program> {
    return this.mutate(programId, async (current) => {
      const program: Program = { ...current, budgetUsd };
      if (program.status === "paused" && current.pausedBy === "budget") {
        const budget = programBudgetState(program, await this.spend(programId));
        if (!budget.exhausted) {
          program.status = "running";
          program.pausedBy = null;
          program.pausedReason = null;
        }
      }
      return { program, result: program };
    });
  }

  /** Set one delivery's budget, forwarding to its workflow when it is live. */
  setDeliveryBudget(programId: string, deliveryId: string, budgetUsd: number | null): Promise<Program> {
    return this.mutate(programId, async (current) => {
      const delivery = deliveryById(current, deliveryId);
      if (!delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
      if (delivery.ws && delivery.workflowId) {
        await this.projects.setWorkflowBudget(delivery.ws, delivery.workflowId, budgetUsd);
      }
      const program = patchDelivery(current, deliveryId, { budgetUsd });
      return { program, result: program };
    });
  }

  /**
   * Answer a question a project raised, from the program that dispatched the
   * work. This is what closes the loop: `messageDelivery` steers an
   * orchestrator, but only an answer clears the question off the board and
   * restarts the run that stopped for it.
   */
  async answerQuestion(
    programId: string,
    questionId: string,
    answer: string,
    /**
     * Where the caller saw the question (the UI holds the full HubQuestion).
     * Trusted first: the derived set below only covers *live* deliveries and
     * current workflow membership, so a question still open on the board
     * reads "unknown" here the moment its delivery settles — the board
     * itself stays the validator (an answered question is refused there).
     */
    context?: { deliveryId?: string | null; taskId?: string | null },
  ): Promise<{ ok: true; resumedRunId: string | null } | { ok: false; reason: string }> {
    const program = await this.get(programId);
    if (!program) return { ok: false, reason: `Unknown program: ${programId}` };

    const send = async (delivery: ProgramDelivery, taskId: string) => {
      const result = await this.projects.answerQuestion(
        delivery.ws!,
        delivery.workflowId!,
        taskId,
        questionId,
        answer,
      );
      // The board write broadcasts, which re-sweeps — but doing it here means
      // the caller's own refetch already sees the question gone.
      if (result.ok) await this.onProjectChanged(delivery.ws!);
      return result;
    };

    if (context?.deliveryId && context.taskId) {
      const delivery = deliveryById(program, context.deliveryId);
      if (delivery?.ws && delivery.workflowId) return send(delivery, context.taskId);
    }

    let question = (await this.questions(programId)).find((q) => q.questionId === questionId);
    if (!question) {
      // Not in the live derivation — scan every dispatched delivery's board,
      // terminal ones included: a delivery that settled can still owe answers
      // for questions asked before it settled.
      for (const delivery of program.deliveries) {
        if (!delivery.ws || !delivery.workflowId) continue;
        const raw = await this.projects
          .openQuestions(delivery.ws, delivery.workflowId)
          .catch(() => [] as ProjectQuestion[]);
        const hit = raw.find((q) => q.questionId === questionId);
        if (hit) {
          question = {
            ...hit,
            deliveryId: delivery.id,
            projectName: delivery.projectName,
            ws: delivery.ws,
          };
          break;
        }
      }
    }
    if (!question) return { ok: false, reason: `Unknown (or already answered) question: ${questionId}` };
    const delivery = deliveryById(program, question.deliveryId);
    if (!delivery?.ws || !delivery.workflowId) {
      return { ok: false, reason: `Delivery ${question.deliveryId} is no longer live.` };
    }
    return send(delivery, question.taskId);
  }

  /**
   * Steer one project's orchestrator without leaving the program. Queues for
   * the next natural wake unless `wake` demands a paid resume; the typed
   * receipt is the answer to "did my $2 message even land?".
   */
  async messageDelivery(
    programId: string,
    deliveryId: string,
    text: string,
    opts: { wake?: boolean } = {},
  ): Promise<{ queued: boolean } & SteerReceipt> {
    const program = await this.get(programId);
    const delivery = program ? deliveryById(program, deliveryId) : null;
    if (!program || !delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
    if (!delivery.ws || !delivery.workflowId) {
      throw new Error(`Delivery ${deliveryId} has not been dispatched yet.`);
    }
    return this.projects.messageWorkflow(delivery.ws, delivery.workflowId, text, opts);
  }

  /**
   * Checkpoint a delivery's orchestrator into a fresh session — the lever
   * against resume cost creep: a long chain re-ingests its whole transcript
   * on every wake, so a program manager watching spend can compact between
   * waves instead of paying for history the board already records.
   */
  async compactDelivery(programId: string, deliveryId: string): Promise<void> {
    const program = await this.get(programId);
    const delivery = program ? deliveryById(program, deliveryId) : null;
    if (!program || !delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
    if (!delivery.ws || !delivery.workflowId) {
      throw new Error(`Delivery ${deliveryId} has not been dispatched yet.`);
    }
    await this.projects.compactWorkflow(delivery.ws, delivery.workflowId);
  }

  /**
   * Settle a delivery from outside its workflow — the missing verb for work
   * that finished (or became moot) by other means: the owner did it by hand,
   * another delivery absorbed it, the premise died. Without it the only
   * levers were retry (a fresh $ workflow), message (a dice-roll), or
   * completing the whole program. The outcome and note are recorded (the
   * note becomes the summary dependents are dispatched with), a live
   * workflow is cancelled *after* the delivery settles (onWorkflowChanged
   * skips terminal deliveries, so the cancellation cannot overwrite the
   * outcome), and the same settlement tail runs as for a workflow-driven
   * finish: dependents auto-dispatch, the program settles if this was the
   * last delivery, and the freed project lock sweeps the portfolio.
   */
  async closeDelivery(
    programId: string,
    deliveryId: string,
    outcome: "completed" | "failed",
    note: string,
  ): Promise<Program> {
    const program = await this.mutate(programId, (current) => {
      const delivery = deliveryById(current, deliveryId);
      if (!delivery) throw new Error(`Unknown delivery: ${deliveryId}`);
      if (isDeliveryTerminal(delivery.status)) {
        throw new Error(
          `Delivery ${deliveryId} is already ${delivery.status} — nothing to close.`,
        );
      }
      const next = patchDelivery(current, deliveryId, {
        status: outcome,
        summary: note,
        note: `Closed externally (${outcome})`,
        endedAt: nowIso(),
      });
      return { program: next, result: next };
    });
    const delivery = deliveryById(program, deliveryId)!;
    if (delivery.ws && delivery.workflowId) {
      await this.projects.cancelWorkflow(delivery.ws, delivery.workflowId).catch(() => {
        // Already gone — nothing to cancel.
      });
      // The retired workflow's open questions are no longer answerable.
      await this.sweepQuestions(programId).catch(() => {});
    }
    const fresh = this.store.peek(programId);
    const portfolio = this.store.all().filter((p) => p.id !== programId);
    if (
      outcome === "completed" &&
      fresh?.status === "running" &&
      readyDeliveries(fresh, portfolio).length
    ) {
      await this.dispatch(programId).catch((err) => {
        console.warn(`[crystal] auto-dispatch failed for ${programId}:`, (err as Error).message);
      });
    }
    await this.settleProgram(programId);
    await this.sweepPortfolioDispatch(programId);
    return this.store.peek(programId) ?? program;
  }

  /** Cancel the program: every live delivery workflow, plus the manager session. */
  async cancel(programId: string): Promise<Program> {
    this.pendingNotices.clear(programId);
    const cancelled = await this.mutate(programId, async (program) => {
      if (isProgramTerminal(program.status)) return { program, result: program };
      // Dispatch holds this same program queue while the workflow is created.
      // Re-scanning here catches any workflow that appeared after cancel was
      // requested but before its mutation reached the head of the queue.
      for (const delivery of program.deliveries) {
        if (!delivery.ws || !delivery.workflowId || isDeliveryTerminal(delivery.status)) continue;
        await this.projects.cancelWorkflow(delivery.ws, delivery.workflowId).catch(() => {
          // Already gone — nothing to cancel.
        });
      }
      if (this.agents && program.managerRunId) {
        const tag = programTag(programId);
        const live = (await this.agents.list()).filter(
          (run) => run.tags.includes(tag) && (run.status === "running" || run.status === "queued"),
        );
        for (const run of live) await this.agents.cancel(run.id).catch(() => {});
      }
      const next: Program = {
        ...program,
        status: "cancelled",
        pausedBy: null,
        pausedReason: null,
        deliveries: program.deliveries.map((d) =>
          isDeliveryTerminal(d.status) ? d : { ...d, status: "cancelled" as const, endedAt: nowIso() },
        ),
      };
      return { program: next, result: next };
    });
    // Every project this program held is now free — dispatch whoever waited.
    await this.sweepPortfolioDispatch(programId);
    return cancelled;
  }

  /** The program manager (or the owner) declares the program finished. */
  complete(programId: string, outcome: "completed" | "failed", summary: string): Promise<Program> {
    return this.mutate(programId, (current) => {
      const program: Program = {
        ...current,
        status: outcome,
        summary,
        pausedBy: null,
        pausedReason: null,
      };
      return { program, result: program };
    });
  }

  /* ---------------- program manager ---------------- */

  /**
   * Type text into the manager's live interactive terminal, if it has one.
   * True = delivered; false = not interactive / terminal gone, use the
   * headless resume/queue path.
   */
  private async interactiveNotify(program: Program, text: string): Promise<boolean> {
    if (!this.agents || !program.managerRunId) return false;
    const run = await this.agents
      .deliverInteractive(program.managerRunId, text)
      .catch(() => null);
    return run != null;
  }

  /**
   * Spawn the interactive program-manager session: a resume-chained run,
   * rooted in the hub's own directory (it coordinates, it does not edit code),
   * carrying the `program:<id>` tag that scopes its MCP toolset and attributes
   * its coordination spend.
   */
  async startManager(
    programId: string,
    model: string | null = null,
    agentId: string | null = null,
  ): Promise<AgentRun> {
    if (!this.agents) throw new Error("Program manager sessions are not available on this server.");
    return this.mutate(programId, async (program) => {
      if (program.managerRunId) {
        throw new Error(`Program ${programId} already has a manager session.`);
      }
      const run = await this.agents!.start(
        await this.managerParams(program, model, agentId, buildProgramManagerPrompt),
      );
      return { program: { ...program, managerRunId: run.id }, result: run };
    });
  }

  /**
   * The manager spawn params, with an optional library profile applied. An
   * explicit `model` wins over the profile's; when neither resolves, the
   * classic heavyweight default stands.
   */
  private async managerParams(
    program: Program,
    model: string | null,
    agentId: string | null,
    prompt: (program: Program, roster: readonly AgentProfile[]) => string,
  ) {
    const roster = this.profiles ? await this.profiles.list() : [];
    let overlay: AgentProfileOverlay | null = null;
    if (agentId && this.profiles) {
      const profile = await this.profiles.get(agentId);
      if (!profile) throw new Error(`Unknown agent profile: ${agentId}`);
      overlay = profileOverlay(profile, presetById(null), { role: "manager" });
    }
    const params = applyProfileOverlay(
      {
        prompt: prompt(program, roster),
        role: "manager" as const,
        purpose: "manage" as const,
        tags: [programTag(program.id)],
        provider: null as AgentProvider | null,
        model,
        agentId: overlay?.agentId ?? null,
      },
      overlay,
    );
    // The hub sits above any one project's roster, so the default preset
    // (not a project's) names its orchestrator model; an explicit `model`
    // on hub.startManager still wins above.
    if (!params.model) {
      const resolved = resolvePresetModel(presetById(null), "manager");
      params.model = resolved.model;
      params.provider ??= resolved.provider;
    }
    // A manager coordinates in place — a profile's worktree default is for
    // workers, and the hub's own directory is not even a repo.
    (params as { isolation?: unknown }).isolation = undefined;
    return params;
  }

  /**
   * Close the manager session: cancel any live program-tagged run (headless
   * chain turn or interactive PTY — `agents.cancel` settles both) and clear
   * `managerRunId` so the start buttons come back. The run history keeps its
   * `program:<id>` tag, so spend attribution survives; pending notices stay
   * queued and flush into whatever session is started next.
   */
  async closeManager(programId: string): Promise<Program> {
    const program = await this.get(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    if (!program.managerRunId) return program;
    if (this.agents) {
      const tag = programTag(programId);
      const live = (await this.agents.list()).filter(
        (r) => r.tags.includes(tag) && (r.status === "running" || r.status === "queued"),
      );
      for (const run of live) await this.agents.cancel(run.id).catch(() => {});
    }
    return this.mutate(programId, (current) => {
      const next: Program = { ...current, managerRunId: null };
      return { program: next, result: next };
    });
  }

  private async requireManagerless(programId: string): Promise<Program> {
    const program = await this.get(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    if (program.managerRunId) {
      throw new Error(`Program ${programId} already has a manager session.`);
    }
    return program;
  }

  /**
   * Plan an *interactive* program-manager session: the native Claude TUI on a
   * PTY, instead of a headless resume-chained run. The server hosts the
   * terminal in whichever workspace the owner asked for (the hub has no PTYs
   * of its own) and binds it back via {@link bindManagerTerminal}; question
   * notices and owner messages are then typed straight into the session,
   * where the manager can put decisions to the owner with AskUserQuestion.
   */
  async prepareInteractiveManager(
    programId: string,
    model: string | null = null,
    agentId: string | null = null,
  ): Promise<InteractiveSpawn> {
    if (!this.agents) throw new Error("Program manager sessions are not available on this server.");
    const program = await this.requireManagerless(programId);
    const spawn = await this.agents.prepareInteractive(
      await this.managerParams(
        program,
        model,
        agentId,
        (p, roster) => buildProgramManagerPrompt(p, roster) + INTERACTIVE_MANAGER_NOTE,
      ),
    );
    await this.mutate(programId, (current) => ({
      program: { ...current, managerRunId: spawn.run.id },
      result: undefined,
    }));
    return spawn;
  }

  /** Attach a prepared interactive manager to the workspace terminal hosting it. */
  async bindManagerTerminal(runId: string, terminalId: string, ws: string): Promise<AgentRun> {
    if (!this.agents) throw new Error("Program manager sessions are not available on this server.");
    return this.agents.bindInteractive(runId, terminalId, ws);
  }

  /**
   * A workspace terminal exited — settle any interactive manager it hosted.
   * Routed through the registry's broadcast seam (like onWorkflowChanged):
   * the hub's runs live outside every workspace, so no runtime settles them.
   */
  async settleInteractiveManager(terminalId: string, exitCode: number | null): Promise<void> {
    await this.agents?.settleInteractive(terminalId, exitCode);
  }

  /**
   * A workspace is about to close, taking its PTYs with it — silently
   * (`TerminalManager.disposeAll` never broadcasts), so the exit hook above
   * will not fire. Settle any interactive manager hosted there now, as
   * failed: the chain stays resumable via its pinned session id, so queued
   * notices continue the manager headlessly instead of wedging the program.
   */
  async onWorkspaceClosing(ws: string): Promise<void> {
    if (!this.agents) return;
    for (const run of await this.agents.list()) {
      if (run.terminalWs !== ws || !run.terminalId || run.endedAt) continue;
      if (run.status !== "running" && run.status !== "queued") continue;
      await this.agents.settleInteractive(run.terminalId, null).catch(() => {});
    }
  }

  /**
   * Every program-manager run, newest first. These live in the hub's own
   * agent host, so they never appear in a workspace's run list.
   */
  async managerRuns(): Promise<AgentRun[]> {
    return this.agents ? this.agents.list() : [];
  }

  async managerRunEvents(runId: string): Promise<RunEvent[]> {
    return this.agents ? this.agents.eventsFor(runId) : [];
  }

  async cancelManagerRun(runId: string): Promise<void> {
    if (!this.agents) throw new Error("Program manager sessions are not available on this server.");
    await this.agents.cancel(runId);
  }

  /** Deliver an owner message into the program manager's session. */
  async message(programId: string, text: string): Promise<{ run: AgentRun | null; queued: boolean }> {
    const program = await this.get(programId);
    if (!program) throw new Error(`Unknown program: ${programId}`);
    if (!this.agents || !program.managerRunId) {
      throw new Error(`Program ${programId} has no manager session — start one first.`);
    }
    // An interactive manager takes the message in its terminal, mid-turn or not.
    const interactive = await this.agents
      .deliverInteractive(program.managerRunId, formatProgramMessage(text))
      .catch(() => null);
    if (interactive) return { run: interactive, queued: false };
    const run = await this.agents.resumeChain(program.managerRunId, formatProgramMessage(text));
    if (!run) {
      this.queueNotice(programId, formatProgramMessage(text));
      return { run: null, queued: true };
    }
    return { run, queued: false };
  }

  private queueNotice(programId: string, text: string): void {
    this.pendingNotices.push(programId, text);
  }

  /**
   * Wake the program manager with `text`, or queue it when a turn is live —
   * two concurrent resumes of one Claude session would fork it. Queued
   * notices flush when the chain next settles.
   */
  private async notifyManager(program: Program, text: string): Promise<void> {
    if (!this.agents || !program.managerRunId) return;
    if (await this.interactiveNotify(program, text)) return;
    const run = await this.agents.resumeChain(program.managerRunId, text).catch(() => null);
    if (!run) this.queueNotice(program.id, text);
  }

  /** Deliver queued notices once no run of the manager chain is live. */
  private async flushNotices(programId: string): Promise<void> {
    const agents = this.agents;
    if (!agents) return;
    const program = this.store.peek(programId);
    if (!program?.managerRunId) return;
    const managerRunId = program.managerRunId;
    await this.pendingNotices.drain(programId, async (pending) => {
      const text =
        pending.length === 1
          ? pending[0]!
          : `${pending.length} updates arrived while you were working.\n\n${pending.join("\n\n---\n\n")}`;
      return (await this.interactiveNotify(program, text))
        ? await agents.get(managerRunId)
        : await agents.resumeChain(managerRunId, text);
    });
  }

  /** A manager turn settled: flush anything queued while it ran. */
  private async onManagerSettled(run: AgentRun): Promise<void> {
    const id = programIdOfRun(run);
    if (!id) return;
    await this.ensureLoaded();
    if (!this.store.peek(id)) return;
    try {
      await this.flushNotices(id);
      const fresh = this.store.peek(id);
      if (fresh) this.events.emit("changed", { program: { ...fresh } });
    } catch (err) {
      console.warn(`[crystal] hub settle hook failed for ${id}:`, (err as Error).message);
    }
  }

  /* ---------------- feedback from projects ---------------- */

  /**
   * A project workflow changed. This is the edge that makes the hub more than
   * a launcher: the delivery follows its workflow's state, completing a
   * delivery auto-dispatches whatever it unblocked, program budget exhaustion
   * pauses everything, and the program manager is woken with the result.
   *
   * Fired for every workflow on the server — most have nothing to do with a
   * program, so the delivery lookup is the fast path out.
   */
  async onWorkflowChanged(ws: string, workflow: Workflow): Promise<void> {
    await this.ensureLoaded();
    const match = this.findDelivery(ws, workflow.id);
    if (!match) return;
    // A workflow's states are a subset of a delivery's, so this is an
    // assignment, not a mapping — and it stops compiling if they ever diverge.
    const status: DeliveryStatus = workflow.status;
    const before = match.delivery;
    // A settled delivery no longer follows its workflow: closeDelivery
    // cancels the retired workflow *after* recording the outcome, and that
    // cancellation echoing back must not overwrite "completed" with
    // "cancelled". (Workflow-driven settles are unaffected — their delivery
    // is still live when the terminal transition arrives.)
    if (isDeliveryTerminal(before.status)) return;
    if (
      before.status === status &&
      (workflow.summary ?? null) === (before.summary ?? null) &&
      (workflow.pausedReason ?? null) === (before.note ?? null)
    ) {
      return; // spend-only update — nothing for the program to record
    }

    // Decide *inside* the lock whether this is the transition that settles the
    // delivery: two callers can observe the same "running → completed" edge
    // (the broadcast and `reconcile`), and both would wake the manager.
    const { program, settled } = await this.mutate(match.program.id, (current) => {
      const live = deliveryById(current, before.id);
      const settledNow =
        !!live && isDeliveryTerminal(status) && !isDeliveryTerminal(live.status);
      const next = patchDelivery(current, before.id, {
        status,
        summary: workflow.summary ?? null,
        note: workflow.pausedReason ?? null,
      });
      return { program: next, result: { program: next, settled: settledNow } };
    });

    // The budget is checked on every change, not only on settlement: a program
    // can outrun its ceiling while its workflows are still going.
    await this.enforceBudget(program.id).catch((err) => {
      // A program that went terminal (or was removed) under us makes
      // `setPaused`/`spend` throw — never abort the settle handling for it.
      console.warn(`[crystal] budget check failed for ${program.id}:`, (err as Error).message);
    });
    if (!settled) return;

    // A settled delivery leaves the questions derivation (it only covers live
    // ones) — re-sweep so its rows leave the UI too instead of lingering as
    // stale "waiting on you" entries that an answer round-trip then refuses.
    this.scheduleQuestionSweep(ws);

    const delivery = deliveryById(program, before.id)!;
    await this.notifyManager(program, deliverySettledNotice(program, delivery)).catch(() => {});
    // A completed delivery may have unblocked dependents — start them without
    // waiting for anyone to ask. Re-read the record: enforceBudget may have
    // paused the program between the settle and here.
    const fresh = this.store.peek(program.id);
    const portfolio = this.store.all().filter((p) => p.id !== program.id);
    if (
      status === "completed" &&
      fresh?.status === "running" &&
      readyDeliveries(fresh, portfolio).length
    ) {
      await this.dispatch(program.id).catch((err) => {
        console.warn(`[crystal] auto-dispatch failed for ${program.id}:`, (err as Error).message);
      });
    }
    await this.settleProgram(program.id);
    // ANY terminal delivery frees its project lock for the rest of the
    // portfolio — not just completed ones, and not just for this program.
    await this.sweepPortfolioDispatch(program.id);
  }

  /**
   * Dispatch deliveries across the whole portfolio that just became ready —
   * typically because another program's delivery settled and freed the
   * project lock. Without this, a program blocked only by a cross-program
   * lock showed "Ready to dispatch" and stalled silently until a human (or
   * agent) asked again. Oldest program first, so the longest wait wins the
   * freed project.
   */
  private async sweepPortfolioDispatch(excludeProgramId: string | null = null): Promise<void> {
    const live = this.store
      .all()
      .filter((p) => p.id !== excludeProgramId && p.status === "running")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const program of live) {
      const others = this.store.all().filter((p) => p.id !== program.id);
      const current = this.store.peek(program.id);
      if (!current || current.status !== "running") continue;
      if (!readyDeliveries(current, others).length) continue;
      await this.dispatch(program.id).catch((err) => {
        console.warn(
          `[crystal] portfolio auto-dispatch failed for ${program.id}:`,
          (err as Error).message,
        );
      });
    }
  }

  /**
   * A project's board changed. Questions are filed on the board, not on the
   * workflow, so this is the only signal that a delivery has stopped to ask
   * something. Programs whose question set grew get an event (the Hub UI
   * shows them) and their manager is woken with the new ones — the same
   * treatment a settled delivery gets, because a question blocks just as hard.
   */
  async onProjectChanged(ws: string): Promise<void> {
    await this.ensureLoaded();
    const affected = this.store.all().filter(
      (p) =>
        isProgramLive(p.status) &&
        p.deliveries.some((d) => d.ws === ws && !isDeliveryTerminal(d.status)),
    );
    // Independent programs sweep in parallel; sweeps of the *same* program
    // are chained, because two overlapping ones race on `questionSets` and
    // the loser publishes a stale set — hiding a question nothing will
    // re-surface, since the asking agent is blocked and writes nothing more.
    await Promise.all(
      affected.map((program) => {
        const chained = (this.sweepChains.get(program.id) ?? Promise.resolve()).then(() =>
          this.sweepQuestions(program.id),
        );
        this.sweepChains.set(program.id, chained.catch(() => {}));
        return chained;
      }),
    );
  }

  /**
   * Board writes arrive in bursts — claim, update, release, cost rollup, all
   * within a second — and each one would otherwise pay for a full question
   * sweep. Coalesce per workspace on a trailing edge; the sweep only has to be
   * eventually right, and the diff makes a repeat sweep free anyway.
   */
  scheduleQuestionSweep(ws: string): void {
    if (this.sweepTimers.has(ws)) return;
    const timer = setTimeout(() => {
      this.sweepTimers.delete(ws);
      void this.onProjectChanged(ws).catch((err) => {
        console.warn(`[crystal] hub question sweep failed for ${ws}:`, (err as Error).message);
      });
    }, QUESTION_SWEEP_DEBOUNCE_MS);
    // A pending sweep must never hold the process open at shutdown.
    timer.unref();
    this.sweepTimers.set(ws, timer);
  }

  /**
   * Re-read every live delivery's workflow and fold it through the same path
   * a live event would take. Without this the hub is pure event edges: a
   * workflow that settles while the server is down would leave its delivery
   * `running` forever, its program would never reach an outcome, and no
   * manager would ever be woken. Called once at startup (after workspaces are
   * restored) and safe to call again — unchanged deliveries are no-ops.
   */
  async reconcile(): Promise<void> {
    await this.ensureLoaded();
    const live = this.store.all().flatMap((program) =>
      program.deliveries
        .filter((d) => d.ws && d.workflowId && !isDeliveryTerminal(d.status))
        .map((d) => ({
          programId: program.id,
          deliveryId: d.id,
          ws: d.ws!,
          workflowId: d.workflowId!,
          projectRoot: d.projectRoot,
        })),
    );
    for (const entry of live) {
      let ws = entry.ws;
      let workflow = await this.projects.workflow(ws, entry.workflowId).catch(() => null);
      if (!workflow) {
        // The project is not open — this workspace id belongs to a previous
        // session. Skipping would leave the delivery `running` forever, and a
        // stuck delivery holds its project lock against the whole portfolio,
        // so open it by root and ask again. Bounded work: only deliveries the
        // hub still believes are live get here.
        const reopened = await this.projects
          .open(entry.projectRoot)
          .then((p) => p.ws)
          .catch(() => null);
        if (!reopened) continue;
        workflow = await this.projects.workflow(reopened, entry.workflowId).catch(() => null);
        if (!workflow) {
          // The project is there but the workflow is not (its records were
          // wiped, or the project was rebuilt). Leaving the delivery `running`
          // would hold this project's lock against the whole portfolio with no
          // way out — `retryDelivery` refuses a live delivery and
          // `removeDelivery` refuses a dispatched one. Call it failed so a
          // retry can rescue it.
          await this.mutate(entry.programId, (current) => ({
            program: patchDelivery(current, entry.deliveryId, {
              status: "failed",
              note: "Its project workflow no longer exists — retry to run it again.",
            }),
            result: undefined,
          })).catch(() => {});
          continue;
        }
        ws = reopened;
        // Pin the new id so the settle path below — and every later call —
        // addresses the project that is actually open.
        if (ws !== entry.ws) {
          await this.mutate(entry.programId, (current) => {
            const next = patchDelivery(current, entry.deliveryId, { ws });
            return { program: next, result: undefined };
          }).catch(() => {});
        }
      }
      await this.onWorkflowChanged(ws, workflow);
    }
  }

  /** Re-derive one program's open questions, emitting and waking only on a change. */
  private async sweepQuestions(programId: string): Promise<void> {
    try {
      const program = this.store.peek(programId);
      if (!program) return;
      const questions = await this.questions(program.id);
      const ids = questions.map((q) => q.questionId).sort().join("|");
      // Unseen and empty are the same thing — a program that has never had a
      // question must not emit one saying so on the first board write.
      const before = this.questionSets.get(program.id) ?? "";
      if (ids === before) return;
      this.questionSets.set(program.id, ids);
      this.events.emit("questionsChanged", { programId: program.id, questions });
      // Only *new* questions are worth waking a manager for — a set that
      // shrank means one was answered. A question still open after a server
      // restart counts as new: it is still blocking, and nobody has told this
      // manager about it.
      const seen = new Set(before.split("|").filter(Boolean));
      const fresh = questions.filter((q) => !seen.has(q.questionId));
      if (fresh.length) await this.notifyManager(program, questionsNotice(fresh));
    } catch (err) {
      console.warn(`[crystal] hub question sweep failed for ${programId}:`, (err as Error).message);
    }
  }

  /** The program + delivery carrying one project workflow, if any. */
  private findDelivery(
    ws: string,
    workflowId: string,
  ): { program: Program; delivery: ProgramDelivery } | null {
    for (const program of this.store.all()) {
      const delivery = program.deliveries.find((d) => d.ws === ws && d.workflowId === workflowId);
      if (delivery) return { program, delivery };
    }
    return null;
  }

  /** Pause the program (and every live delivery) once its budget is spent. */
  private async enforceBudget(programId: string): Promise<void> {
    const program = this.store.peek(programId);
    if (!program || program.status !== "running" || program.budgetUsd == null) return;
    const budget = programBudgetState(program, await this.spend(programId));
    // `exhausted` is already false when the rollup is a lower bound; this is
    // the explicit statement of why nothing happens in that case.
    if (!budget.exhausted) return;
    await this.setPaused(
      programId,
      true,
      `Budget exhausted ($${budget.spentUsd.toFixed(2)} of $${budget.budgetUsd!.toFixed(2)})`,
      "budget",
    );
  }

  /**
   * Move the program to its outcome once every delivery is terminal. A manager
   * session may still call `complete_program` afterwards to record a summary
   * (and correct the outcome) — but a program whose work is all finished must
   * never sit in `running` waiting for an agent that may never come back.
   */
  private async settleProgram(programId: string): Promise<void> {
    const program = this.store.peek(programId);
    if (!program || program.status !== "running") return;
    const outcome = programOutcome(program);
    if (!outcome) return;
    await this.mutate(programId, (current) => {
      // Re-check under the lock: the manager may have called
      // `complete_program` with its own verdict while we were queued, and a
      // derived outcome must not overwrite a declared one.
      if (current.status !== "running") return { program: current, result: undefined };
      return {
        program: { ...current, status: outcome, pausedBy: null, pausedReason: null },
        result: undefined,
      };
    });
    const fresh = this.store.peek(programId);
    if (fresh?.managerRunId) {
      await this.notifyManager(
        fresh,
        `Every delivery of program "${fresh.name}" has settled (${outcome}). Review program_status, then call complete_program with a summary of what shipped per project, what it cost, and anything left open.`,
      ).catch(() => {});
    }
  }
}

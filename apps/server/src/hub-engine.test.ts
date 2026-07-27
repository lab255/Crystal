import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Emitter,
  chainRootId,
  createAgentRun,
  createWorkflow,
  programBudgetState,
  programTag,
  type AgentRun,
  type RunEvent,
  type Workflow,
  type WorkflowTemplate,
} from "@crystal/core";
import type { AgentManager, AgentStartParams } from "./agent-manager.js";
import {
  HubEngine,
  type HubProjectRef,
  type HubProjects,
  type ProjectQuestion,
} from "./hub-engine.js";

/**
 * In-memory workspace layer: every project op the hub can perform, recorded.
 * Workflows never actually run — `settle` is how a test says "that project's
 * orchestrator finished".
 */
class FakeProjects implements HubProjects {
  opened: string[] = [];
  started: { ws: string; init: { name: string; goal: string; budgetUsd?: number | null } }[] = [];
  messages: { workflowId: string; text: string }[] = [];
  paused: { workflowId: string; paused: boolean }[] = [];
  cancelled: string[] = [];
  workflows = new Map<string, Workflow>();
  spend = new Map<string, number>();
  /** Roots that cannot be opened, mapped to the failure message. */
  broken = new Map<string, string>();

  private readonly known: HubProjectRef[];

  // Copy: tests mutate their own project list (`reopenAs`), and a shared
  // fixture would leak that into every test that ran after.
  constructor(known: HubProjectRef[]) {
    this.known = known.map((p) => ({ ...p }));
  }

  async open(root: string): Promise<HubProjectRef> {
    const broken = this.broken.get(root);
    if (broken) throw new Error(broken);
    this.opened.push(root);
    const hit = this.known.find((p) => p.root === root);
    if (hit) return hit;
    const ref = { ws: `ws-${this.known.length + 1}`, root, name: path.basename(root) };
    this.known.push(ref);
    return ref;
  }

  list(): HubProjectRef[] {
    return [...this.known];
  }

  async recents() {
    return [{ root: "/repos/archived", name: "archived", lastOpenedAt: "2026-01-01T00:00:00.000Z" }];
  }

  async startWorkflow(ws: string, init: { name: string; goal: string; budgetUsd?: number | null }) {
    this.started.push({ ws, init });
    const workflow = createWorkflow({ name: init.name, goal: init.goal, budgetUsd: init.budgetUsd });
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  /** Workspace ids a restart has invalidated — reading through one throws. */
  closed = new Set<string>();

  async workflow(ws: string, workflowId: string) {
    if (this.closed.has(ws)) throw new Error(`Unknown workspace: ${ws}`);
    return this.workflows.get(workflowId) ?? null;
  }

  /** A project that comes back under a new workspace id, as a restart does. */
  reopenAs(root: string, ws: string): void {
    const hit = this.known.find((p) => p.root === root)!;
    this.closed.add(hit.ws);
    hit.ws = ws;
  }

  /** Workflows whose workspace is closed — reading them throws, as it would. */
  unreachable = new Set<string>();

  async workflowSpend(_ws: string, workflowId: string) {
    if (this.unreachable.has(workflowId)) throw new Error("Unknown workspace: ws-auth");
    if (!this.workflows.has(workflowId)) return null;
    return { costUsd: this.spend.get(workflowId) ?? 0, totalTokens: 1000, runCount: 1, liveRunCount: 0 };
  }

  async messageWorkflow(_ws: string, workflowId: string, text: string) {
    this.messages.push({ workflowId, text });
    return { queued: false };
  }

  async setWorkflowPaused(_ws: string, workflowId: string, paused: boolean) {
    this.paused.push({ workflowId, paused });
    const workflow = this.workflows.get(workflowId);
    if (workflow) workflow.status = paused ? "paused" : "running";
  }

  async setWorkflowBudget(_ws: string, workflowId: string, budgetUsd: number | null) {
    const workflow = this.workflows.get(workflowId);
    if (workflow) workflow.budgetUsd = budgetUsd;
  }

  async cancelWorkflow(_ws: string, workflowId: string) {
    this.cancelled.push(workflowId);
    const workflow = this.workflows.get(workflowId);
    if (workflow) workflow.status = "cancelled";
  }

  async boardSnapshot(ws: string) {
    return `board of ${ws}`;
  }

  /** Open questions per workflow id — a test files them with `ask`. */
  questions = new Map<string, ProjectQuestion[]>();

  async openQuestions(_ws: string, workflowId: string): Promise<ProjectQuestion[]> {
    return this.questions.get(workflowId) ?? [];
  }

  /** Stand in for a project orchestrator filing a question on its board. */
  ask(workflowId: string, questionId: string, text: string): void {
    const list = this.questions.get(workflowId) ?? [];
    list.push({
      questionId,
      text,
      taskId: `task_${questionId}`,
      taskTitle: "Some task",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    this.questions.set(workflowId, list);
  }

  /** …and the human answering it (the question leaves the open set). */
  answer(workflowId: string, questionId: string): void {
    this.questions.set(
      workflowId,
      (this.questions.get(workflowId) ?? []).filter((q) => q.questionId !== questionId),
    );
  }

  answered: { questionId: string; answer: string }[] = [];

  async answerQuestion(
    _ws: string,
    workflowId: string,
    _taskId: string,
    questionId: string,
    answer: string,
  ) {
    if (!(this.questions.get(workflowId) ?? []).some((q) => q.questionId === questionId)) {
      return { ok: false as const, reason: `Unknown question: ${questionId}` };
    }
    this.answered.push({ questionId, answer });
    this.answer(workflowId, questionId);
    return { ok: true as const, resumedRunId: "run_resumed" };
  }

  async workflowTemplates(): Promise<WorkflowTemplate[]> {
    return [];
  }

  /** Move a workflow to a terminal state, as its project's engine would. */
  settle(workflowId: string, status: Workflow["status"], summary?: string): Workflow {
    const workflow = this.workflows.get(workflowId)!;
    workflow.status = status;
    if (summary) workflow.summary = summary;
    return { ...workflow };
  }

  wsOf(workflowId: string): string {
    return this.started.find((s) => this.workflows.get(workflowId)?.name === s.init.name)!.ws;
  }
}

/** Just enough AgentManager for the program-manager session (see WorkflowEngine's fake). */
class FakeAgents {
  events = new Emitter<{ event: RunEvent; runChanged: { run: AgentRun } }>();
  runs: AgentRun[] = [];
  started: AgentStartParams[] = [];
  resumes: string[] = [];

  async list(): Promise<AgentRun[]> {
    return [...this.runs];
  }

  async get(runId: string): Promise<AgentRun | null> {
    return this.runs.find((r) => r.id === runId) ?? null;
  }

  async eventsFor(): Promise<RunEvent[]> {
    return [];
  }

  async start(params: AgentStartParams): Promise<AgentRun> {
    this.started.push(params);
    const run = createAgentRun(params);
    run.status = "running";
    run.sessionId = `sess_${this.runs.length}`;
    this.runs.push(run);
    return run;
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) run.status = "cancelled";
  }

  /** No interactive terminals in these tests — the engine falls back to resumeChain. */
  async deliverInteractive(_runId: string, _text: string): Promise<AgentRun | null> {
    return null;
  }

  async resumeChain(fromRunId: string, prompt: string): Promise<AgentRun | null> {
    const byId = new Map(this.runs.map((r) => [r.id, r]));
    const root = chainRootId(fromRunId, byId);
    const chain = this.runs.filter((r) => chainRootId(r.id, byId) === root);
    if (chain.some((r) => r.status === "running" || r.status === "queued")) return null;
    const latest = chain[chain.length - 1];
    if (!latest || latest.status === "cancelled") return null;
    this.resumes.push(prompt);
    return this.start({
      prompt,
      resumedFromRunId: latest.id,
      role: "manager",
      tags: chain[0]!.tags,
    });
  }

  /** Settle the newest run and fire the terminal event the engine listens for. */
  settleLatest(status: AgentRun["status"] = "completed"): void {
    const run = this.runs[this.runs.length - 1]!;
    run.status = status;
    this.events.emit("runChanged", { run: { ...run } });
  }
}

const PROJECTS: HubProjectRef[] = [
  { ws: "ws-auth", root: "/repos/auth-service", name: "auth-service" },
  { ws: "ws-web", root: "/repos/web-console", name: "web-console" },
];

function engine(projects = new FakeProjects([...PROJECTS]), agents = new FakeAgents()) {
  return { projects, agents };
}

describe("HubEngine", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-hub-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A fresh engine on its own data directory. */
  async function fresh(name: string) {
    const { projects, agents } = engine();
    const dataDir = path.join(dir, name);
    const hub = new HubEngine(dataDir, projects, agents as unknown as AgentManager);
    return { hub, projects, agents, dataDir };
  }

  it("dispatches a delivery as a workflow in its own project, carrying the program's context", async () => {
    const { hub, projects } = await fresh("dispatch");
    const program = await hub.create({ name: "SSO", goal: "Single sign-on everywhere." });
    await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "Issue OIDC tokens.",
    });

    const report = await hub.dispatch(program.id);
    expect(report.dispatched).toHaveLength(1);
    expect(report.dispatched[0]!.ws).toBe("ws-auth");
    expect(projects.started[0]!.ws).toBe("ws-auth");
    expect(projects.started[0]!.init.name).toBe("SSO — auth-service");
    // The workflow goal carries the program goal *and* the project's brief.
    expect(projects.started[0]!.init.goal).toContain("Single sign-on everywhere.");
    expect(projects.started[0]!.init.goal).toContain("Issue OIDC tokens.");

    const after = await hub.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("running");
    expect(after!.deliveries[0]!.ws).toBe("ws-auth");
    expect(after!.deliveries[0]!.workflowId).toBe(report.dispatched[0]!.workflowId);
  });

  it("holds a dependent delivery, then auto-dispatches it when its dependency completes", async () => {
    const { hub, projects } = await fresh("chain");
    const program = await hub.create({ name: "SSO", goal: "g" });
    const auth = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "Issue tokens.",
    });
    await hub.addDelivery(program.id, {
      projectRoot: "/repos/web-console",
      brief: "Log in with it.",
      dependsOn: [auth.id],
    });

    const first = await hub.dispatch(program.id);
    expect(first.dispatched).toHaveLength(1);
    expect(first.skipped[0]!.reason).toMatch(/Blocked by/);

    // The auth project's orchestrator finishes.
    const workflowId = first.dispatched[0]!.workflowId;
    await hub.onWorkflowChanged("ws-auth", projects.settle(workflowId, "completed", "Tokens live."));

    const after = await hub.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("completed");
    expect(after!.deliveries[0]!.summary).toBe("Tokens live.");
    // …and the web delivery started itself, with the upstream summary in its goal.
    expect(after!.deliveries[1]!.status).toBe("running");
    expect(projects.started[1]!.ws).toBe("ws-web");
    expect(projects.started[1]!.init.goal).toContain("Tokens live.");
  });

  it("refuses a project already busy for another program — the lock is per repo", async () => {
    const { hub, projects } = await fresh("cross-program-lock");
    const first = await hub.create({ name: "First", goal: "g" });
    await hub.addDelivery(first.id, { projectRoot: "/repos/auth-service", brief: "a" });
    await hub.dispatch(first.id);

    const second = await hub.create({ name: "Second", goal: "g" });
    await hub.addDelivery(second.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(second.id);

    expect(report.dispatched).toEqual([]);
    expect(report.skipped[0]!.reason).toMatch(/already running .* of program "First"/);

    // Once the first program's delivery lands, the freed project is handed to
    // the waiting program *automatically* — a delivery blocked only by a
    // cross-program lock used to stall silently until someone asked again.
    const wf = (await hub.get(first.id))!.deliveries[0]!.workflowId!;
    await hub.onWorkflowChanged("ws-auth", projects.settle(wf, "completed"));
    expect((await hub.get(second.id))!.deliveries[0]!.status).toBe("running");
  });

  it("frees the project for other programs on failure and on cancel, not just success", async () => {
    const { hub, projects } = await fresh("portfolio-sweep");
    const first = await hub.create({ name: "First", goal: "g" });
    await hub.addDelivery(first.id, { projectRoot: "/repos/auth-service", brief: "a" });
    await hub.dispatch(first.id);
    const second = await hub.create({ name: "Second", goal: "g" });
    await hub.addDelivery(second.id, { projectRoot: "/repos/auth-service", brief: "b" });
    await hub.dispatch(second.id); // refused — lock held by First

    // A FAILED delivery is just as terminal: the lock frees, Second starts.
    const wf = (await hub.get(first.id))!.deliveries[0]!.workflowId!;
    await hub.onWorkflowChanged("ws-auth", projects.settle(wf, "failed"));
    expect((await hub.get(second.id))!.deliveries[0]!.status).toBe("running");

    // And a cancelled program hands its projects over on the way out.
    const third = await hub.create({ name: "Third", goal: "g" });
    await hub.addDelivery(third.id, { projectRoot: "/repos/auth-service", brief: "c" });
    await hub.dispatch(third.id); // refused — Second holds the lock now
    expect((await hub.get(third.id))!.deliveries[0]!.status).toBe("pending");
    await hub.cancel(second.id);
    expect((await hub.get(third.id))!.deliveries[0]!.status).toBe("running");
  });

  it("settles the program once every delivery is terminal", async () => {
    const { hub, projects } = await fresh("settle");
    const program = await hub.create({ name: "One", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    await hub.onWorkflowChanged("ws-auth", projects.settle(report.dispatched[0]!.workflowId, "failed"));

    const after = await hub.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("failed");
    expect(after!.status).toBe("failed");
  });

  it("pausing a program pauses its live project workflows too", async () => {
    const { hub, projects } = await fresh("pause");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);

    await hub.setPaused(program.id, true, "on hold");
    expect(projects.paused).toEqual([{ workflowId: report.dispatched[0]!.workflowId, paused: true }]);
    const paused = await hub.get(program.id);
    expect(paused!.status).toBe("paused");
    expect(paused!.deliveries[0]!.status).toBe("paused");
    // A paused program dispatches nothing.
    expect((await hub.dispatch(program.id)).dispatched).toEqual([]);

    await hub.setPaused(program.id, false);
    expect((await hub.get(program.id))!.deliveries[0]!.status).toBe("running");
  });

  it("pauses the program when its budget runs out, and resumes when it is raised", async () => {
    const { hub, projects } = await fresh("budget");
    const program = await hub.create({ name: "P", goal: "g", budgetUsd: 1 });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    const workflowId = report.dispatched[0]!.workflowId;

    projects.spend.set(workflowId, 5);
    // A pause of the workflow (not a settle) still reports spend upward.
    await hub.onWorkflowChanged("ws-auth", projects.settle(workflowId, "paused"));

    const paused = await hub.get(program.id);
    expect(paused!.status).toBe("paused");
    expect(paused!.pausedBy).toBe("budget");
    expect(paused!.pausedReason).toMatch(/Budget exhausted/);

    const raised = await hub.setBudget(program.id, 20);
    expect(raised.status).toBe("running");
    expect(raised.pausedBy).toBeNull();
  });

  it("records a dispatch failure on the delivery instead of losing it", async () => {
    const { hub, projects } = await fresh("failure");
    projects.broken.set("/repos/gone", "Not a directory: /repos/gone");
    const program = await hub.create({ name: "P", goal: "g" });
    // addDelivery resolves the project up front, so a bad root fails there…
    await expect(
      hub.addDelivery(program.id, { projectRoot: "/repos/gone", brief: "b" }),
    ).rejects.toThrow(/Not a directory/);

    // …and a project that breaks *after* being added surfaces on dispatch.
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    projects.broken.set("/repos/auth-service", "disk on fire");
    const report = await hub.dispatch(program.id);
    expect(report.dispatched).toEqual([]);
    expect(report.skipped[0]!.reason).toBe("disk on fire");
    const after = await hub.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("pending");
    expect(after!.deliveries[0]!.note).toMatch(/disk on fire/);
  });

  it("cancels every live workflow and marks the program cancelled", async () => {
    const { hub, projects } = await fresh("cancel");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);

    const cancelled = await hub.cancel(program.id);
    expect(projects.cancelled).toEqual([report.dispatched[0]!.workflowId]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.deliveries[0]!.status).toBe("cancelled");
  });

  it("steers one project's orchestrator without leaving the program", async () => {
    const { hub, projects } = await fresh("message");
    const program = await hub.create({ name: "P", goal: "g" });
    const delivery = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    await expect(hub.messageDelivery(program.id, delivery.id, "hi")).rejects.toThrow(
      /has not been dispatched/,
    );

    await hub.dispatch(program.id);
    await hub.messageDelivery(program.id, delivery.id, "the schema changed");
    expect(projects.messages[0]!.text).toBe("the schema changed");
  });

  it("wakes the program manager when a delivery settles, queueing while it is mid-turn", async () => {
    const { hub, projects, agents } = await fresh("manager");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });

    const run = await hub.startManager(program.id);
    expect(run.tags).toContain(programTag(program.id));
    expect(agents.started[0]!.prompt).toContain("PROGRAM MANAGER");
    // One manager per program.
    await expect(hub.startManager(program.id)).rejects.toThrow(/already has a manager/);

    const report = await hub.dispatch(program.id);
    const workflowId = report.dispatched[0]!.workflowId;

    // The manager's first turn is still live — the notice must queue rather
    // than fork the session with a concurrent resume.
    await hub.onWorkflowChanged("ws-auth", projects.settle(workflowId, "completed", "done"));
    expect(agents.resumes).toEqual([]);

    // Its turn ends: the queued notice is delivered.
    agents.settleLatest();
    await new Promise((r) => setTimeout(r, 0));
    expect(agents.resumes.length).toBeGreaterThan(0);
    expect(agents.resumes[0]).toContain("settled: completed");
  });

  it("catches up on a workflow that settled while the server was down", async () => {
    const { hub, projects, dataDir } = await fresh("reconcile");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);

    // The workflow finishes with nobody listening (the engine is replaced by a
    // fresh one over the same data dir, as a restart would do).
    projects.settle(report.dispatched[0]!.workflowId, "completed", "shipped anyway");
    const restarted = new HubEngine(dataDir, projects, null);
    expect((await restarted.get(program.id))!.deliveries[0]!.status).toBe("running");

    await restarted.reconcile();
    const after = await restarted.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("completed");
    expect(after!.deliveries[0]!.summary).toBe("shipped anyway");
    // …and the program follows its deliveries to an outcome.
    expect(after!.status).toBe("completed");
  });

  it("reopens a project whose workspace id did not survive the restart", async () => {
    const { hub, projects, dataDir } = await fresh("reconcile-closed");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    projects.settle(report.dispatched[0]!.workflowId, "completed", "landed");

    // The restart gives that project a new workspace id, so the delivery's
    // stored one reads as closed. Skipping it would leave the delivery
    // `running` forever — and holding the project lock for the whole portfolio.
    projects.reopenAs("/repos/auth-service", "ws-auth-2");
    const restarted = new HubEngine(dataDir, projects, null);
    await restarted.reconcile();

    const after = await restarted.get(program.id);
    expect(after!.deliveries[0]!.status).toBe("completed");
    expect(after!.deliveries[0]!.summary).toBe("landed");
    // …and the delivery now addresses the workspace that is actually open.
    expect(after!.deliveries[0]!.ws).toBe("ws-auth-2");
    expect(projects.opened).toContain("/repos/auth-service");
  });

  it("ignores workflow events that belong to no delivery", async () => {
    const { hub, projects } = await fresh("stray");
    const stray = await projects.startWorkflow("ws-auth", { name: "unrelated", goal: "g" });
    await expect(hub.onWorkflowChanged("ws-auth", stray)).resolves.toBeUndefined();
    expect(await hub.list()).toEqual([]);
  });

  it("reloads programs from disk on a fresh engine over the same directory", async () => {
    const { hub, dataDir, projects } = await fresh("persist");
    const program = await hub.create({ name: "Durable", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });

    const reopened = new HubEngine(dataDir, projects, null);
    const loaded = await reopened.get(program.id);
    expect(loaded!.name).toBe("Durable");
    expect(loaded!.deliveries).toHaveLength(1);
    // Without an agent host there is no manager session to start.
    await expect(reopened.startManager(program.id)).rejects.toThrow(/not available/);
  });

  it("dispatchEpic is create + one delivery + dispatch in a single call", async () => {
    const { hub, projects } = await fresh("epic");
    const { program, report } = await hub.dispatchEpic({
      projectRoot: "/repos/web-console",
      name: "Dark mode",
      goal: "Ship a dark theme.",
      budgetUsd: 12,
    });
    expect(program.deliveries).toHaveLength(1);
    expect(report.dispatched).toHaveLength(1);
    expect(projects.started[0]!.init.budgetUsd).toBe(12);
    expect((await hub.get(program.id))!.deliveries[0]!.status).toBe("running");
  });

  it("refuses to remove a dispatched delivery or one that is depended on", async () => {
    const { hub } = await fresh("remove");
    const program = await hub.create({ name: "P", goal: "g" });
    const first = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    const second = await hub.addDelivery(program.id, {
      projectRoot: "/repos/web-console",
      brief: "b",
      dependsOn: [first.id],
    });
    await expect(hub.removeDelivery(program.id, first.id)).rejects.toThrow(/dependency of/);

    await hub.removeDelivery(program.id, second.id);
    expect((await hub.get(program.id))!.deliveries).toHaveLength(1);

    await hub.dispatch(program.id);
    await expect(hub.removeDelivery(program.id, first.id)).rejects.toThrow(/already dispatched/);
  });

  it("retries a failed delivery: back to pending, program reopened, dispatchable again", async () => {
    const { hub, projects } = await fresh("retry");
    const program = await hub.create({ name: "P", goal: "g" });
    const first = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    // A dependent, so the dead-end this fixes is visible: it can never start
    // while its blocker sits in `failed`.
    await hub.addDelivery(program.id, {
      projectRoot: "/repos/web-console",
      brief: "b",
      dependsOn: [first.id],
    });
    const report = await hub.dispatch(program.id);
    await hub.onWorkflowChanged("ws-auth", projects.settle(report.dispatched[0]!.workflowId, "failed"));

    // The dead end: the dependent is ready for nothing, and no further dispatch
    // can move the program off `running`.
    const second = (await hub.get(program.id))!.deliveries[1]!;
    expect((await hub.dispatch(program.id)).dispatched).toEqual([]);
    // …and a delivery that has not finished has nothing to retry.
    await expect(hub.retryDelivery(program.id, second.id)).rejects.toThrow(/nothing to retry/);

    const retried = await hub.retryDelivery(program.id, first.id);
    expect(retried.deliveries[0]).toMatchObject({
      status: "pending",
      workflowId: null,
      note: "Retried after failed",
    });
    // The project lock is free again, so it gets a fresh workflow.
    const again = await hub.dispatch(program.id);
    expect(again.dispatched.map((d) => d.deliveryId)).toEqual([first.id]);
    expect(again.dispatched[0]!.workflowId).not.toBe(report.dispatched[0]!.workflowId);
  });

  it("reopens a program that had already settled when its delivery is retried", async () => {
    const { hub, projects } = await fresh("retry-terminal");
    const program = await hub.create({ name: "P", goal: "g" });
    const only = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    const report = await hub.dispatch(program.id);
    await hub.onWorkflowChanged("ws-auth", projects.settle(report.dispatched[0]!.workflowId, "failed"));
    expect((await hub.get(program.id))!.status).toBe("failed");

    const retried = await hub.retryDelivery(program.id, only.id);
    expect(retried.status).toBe("running");
    expect(retried.summary).toBeNull();
    expect((await hub.dispatch(program.id)).dispatched).toHaveLength(1);
  });

  it("keeps the failed attempt's spend on the books across a retry", async () => {
    const { hub, projects } = await fresh("retry-spend");
    const program = await hub.create({ name: "P", goal: "g", budgetUsd: 60 });
    const only = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    const first = (await hub.dispatch(program.id)).dispatched[0]!.workflowId;
    projects.spend.set(first, 55);
    await hub.onWorkflowChanged("ws-auth", projects.settle(first, "failed"));
    expect((await hub.spend(program.id)).costUsd).toBe(55);

    await hub.retryDelivery(program.id, only.id);
    // The money is still spent: forgetting it would hand the retry a fresh $60.
    const afterRetry = await hub.spend(program.id);
    expect(afterRetry.costUsd).toBe(55);
    expect(afterRetry.byDelivery[only.id]!.costUsd).toBe(55);

    const second = (await hub.dispatch(program.id)).dispatched[0]!.workflowId;
    projects.spend.set(second, 10);
    const total = await hub.spend(program.id);
    expect(total.costUsd).toBe(65);
    expect(programBudgetState({ ...program, budgetUsd: 60 }, total).exhausted).toBe(true);
  });

  it("refuses to retry a completed delivery, and to remove a retried one", async () => {
    const { hub, projects } = await fresh("retry-guards");
    const program = await hub.create({ name: "P", goal: "g" });
    const only = await hub.addDelivery(program.id, {
      projectRoot: "/repos/auth-service",
      brief: "b",
    });
    const wf = (await hub.dispatch(program.id)).dispatched[0]!.workflowId;
    await hub.onWorkflowChanged("ws-auth", projects.settle(wf, "completed", "shipped"));
    // Re-running it would clear the summary its dependents were dispatched with.
    await expect(hub.retryDelivery(program.id, only.id)).rejects.toThrow(/completed/);

    // …and after a legitimate retry the delivery still counts as dispatched,
    // so removing it (and its spend) is still refused.
    const other = await hub.create({ name: "Q", goal: "g" });
    const q = await hub.addDelivery(other.id, { projectRoot: "/repos/web-console", brief: "b" });
    const qwf = (await hub.dispatch(other.id)).dispatched[0]!.workflowId;
    await hub.onWorkflowChanged("ws-web", projects.settle(qwf, "failed"));
    await hub.retryDelivery(other.id, q.id);
    await expect(hub.removeDelivery(other.id, q.id)).rejects.toThrow(/already dispatched/);
  });

  it("surfaces project questions, wakes the manager on new ones, and drops answered ones", async () => {
    const { hub, projects, agents } = await fresh("questions");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    await hub.startManager(program.id);
    const report = await hub.dispatch(program.id);
    const workflowId = report.dispatched[0]!.workflowId;
    const deliveryId = report.dispatched[0]!.deliveryId;
    agents.settleLatest(); // the manager's turn ends so wake-ups deliver at once
    await new Promise((r) => setTimeout(r, 0));

    const events: { programId: string; count: number }[] = [];
    hub.events.on("questionsChanged", ({ programId, questions }) =>
      events.push({ programId, count: questions.length }),
    );

    // Nothing asked yet: a board write must not invent an event.
    await hub.onProjectChanged("ws-auth");
    expect(events).toEqual([]);

    projects.ask(workflowId, "q1", "Which token format do we standardise on?");
    await hub.onProjectChanged("ws-auth");

    const questions = await hub.questions(program.id);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      deliveryId,
      projectName: "auth-service",
      ws: "ws-auth",
      taskId: "task_q1",
    });
    expect(events).toEqual([{ programId: program.id, count: 1 }]);
    // The manager is woken with it — a question blocks as hard as a settle.
    expect(agents.resumes.at(-1)).toContain("Which token format");

    // An unchanged board is a no-op, not another wake-up.
    const wakes = agents.resumes.length;
    await hub.onProjectChanged("ws-auth");
    expect(agents.resumes).toHaveLength(wakes);
    expect(events).toHaveLength(1);

    // Answering removes it, and that is not something to wake anyone for.
    projects.answer(workflowId, "q1");
    await hub.onProjectChanged("ws-auth");
    expect(await hub.questions(program.id)).toEqual([]);
    expect(events).toHaveLength(2);
    expect(agents.resumes).toHaveLength(wakes);

    // A terminal delivery is never asked about — it cannot be waiting.
    projects.ask(workflowId, "q2", "stale");
    await hub.onWorkflowChanged("ws-auth", projects.settle(workflowId, "completed"));
    expect(await hub.questions(program.id)).toEqual([]);
    expect(await hub.allQuestions()).toEqual({});
  });

  it("answers a question: recorded, handed back to the asker, and off the list", async () => {
    const { hub, projects } = await fresh("answer");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    projects.ask(report.dispatched[0]!.workflowId, "q1", "Version the payload?");
    await hub.onProjectChanged("ws-auth");

    const answered: number[] = [];
    hub.events.on("questionsChanged", ({ questions }) => answered.push(questions.length));

    const result = await hub.answerQuestion(program.id, "q1", "Add fields in place.");
    expect(result).toEqual({ ok: true, resumedRunId: "run_resumed" });
    expect(projects.answered).toEqual([{ questionId: "q1", answer: "Add fields in place." }]);
    // The caller's own refetch already sees it gone — no waiting for the
    // board's broadcast to come back around.
    expect(await hub.questions(program.id)).toEqual([]);
    expect(answered).toEqual([0]);

    const again = await hub.answerQuestion(program.id, "q1", "again");
    expect(again).toEqual({ ok: false, reason: expect.stringContaining("already answered") });
  });

  it("renders open questions into the agent-facing status", async () => {
    const { hub, projects } = await fresh("question-text");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    projects.ask(report.dispatched[0]!.workflowId, "q1", "Shared token format?");

    const text = await hub.statusText(program.id);
    expect(text).toContain("NEEDS AN ANSWER");
    expect(text).toContain("Shared token format?");
    expect(text).toContain("message_delivery");
  });

  it("forgets a finished program, but never a live one", async () => {
    const { hub, dataDir } = await fresh("remove-program");
    const program = await hub.create({ name: "P", goal: "g" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    await hub.dispatch(program.id);

    const removed: string[] = [];
    hub.events.on("removed", ({ programId }) => removed.push(programId));

    await expect(hub.remove(program.id)).rejects.toThrow(/cancel or complete it/);
    await hub.cancel(program.id);
    await hub.remove(program.id);

    expect(removed).toEqual([program.id]);
    expect(await hub.get(program.id)).toBeNull();
    expect(await hub.list()).toEqual([]);
    // …and it stays gone across a restart on the same directory.
    const reopened = new HubEngine(dataDir, new FakeProjects([...PROJECTS]), null);
    expect(await reopened.list()).toEqual([]);
    await expect(hub.remove(program.id)).rejects.toThrow(/Unknown program/);
  });

  it("rolls spend up across projects and renders it for an agent", async () => {
    const { hub, projects } = await fresh("spend");
    const program = await hub.create({ name: "P", goal: "g", budgetUsd: 10 });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "auth work" });
    await hub.addDelivery(program.id, { projectRoot: "/repos/web-console", brief: "web work" });
    const report = await hub.dispatch(program.id);
    for (const d of report.dispatched) projects.spend.set(d.workflowId, 1.5);

    const spend = await hub.spend(program.id);
    expect(spend.costUsd).toBeCloseTo(3);
    expect(Object.keys(spend.byDelivery)).toHaveLength(2);

    const text = await hub.statusText(program.id);
    expect(text).toContain("budget $10.00, remaining $7.00");
    expect(await hub.portfolioText()).toContain("1 program(s)");
  });

  it("resolves a project by workspace id or by root, and lists open + recent", async () => {
    const { hub } = await fresh("projects");
    expect((await hub.resolveProject("ws-web")).root).toBe("/repos/web-console");
    expect((await hub.resolveProject("/repos/web-console")).ws).toBe("ws-web");
    const { open, recent } = await hub.projectList();
    expect(open.map((p) => p.name)).toEqual(["auth-service", "web-console"]);
    expect(recent.map((r) => r.name)).toEqual(["archived"]);
  });
});

describe("HubEngine spend integrity", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-hub-spend-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("marks the rollup incomplete when a live delivery's project is unreachable", async () => {
    const projects = new FakeProjects([...PROJECTS]);
    const hub = new HubEngine(path.join(dir, "stale"), projects, null);
    const program = await hub.create({ name: "P", goal: "g", budgetUsd: 1 });
    await hub.addDelivery(program.id, { projectRoot: "/repos/auth-service", brief: "b" });
    const report = await hub.dispatch(program.id);
    projects.spend.set(report.dispatched[0]!.workflowId, 0.5);

    expect((await hub.spend(program.id)).stale).toBe(false);

    // The workspace closes: the delivery is still running and still spending,
    // but its cost can no longer be read.
    projects.unreachable.add(report.dispatched[0]!.workflowId);
    const spend = await hub.spend(program.id);
    expect(spend.stale).toBe(true);
    expect(spend.costUsd).toBe(0);

    // The budget must not read as "fine" off a number we cannot stand behind,
    // and the status text has to say so rather than quietly under-reporting.
    expect(programBudgetState((await hub.get(program.id))!, spend).exhausted).toBe(false);
    expect(await hub.statusText(program.id)).toContain("INCOMPLETE");
  });
});

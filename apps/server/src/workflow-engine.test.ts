import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Emitter,
  chainRootId,
  createAgentRun,
  createDefaultRoster,
  makeTemplate,
  workflowTag,
  type AgentRun,
  type RunEvent,
  type WorkerSpec,
} from "@crystal/core";
import type { AgentManager, AgentStartParams } from "./agent-manager.js";
import { runGit } from "./git.js";
import type { WorkspaceStore } from "./workspace-store.js";
import { GlobalTemplateStore } from "./template-library.js";
import { WorkflowEngine } from "./workflow-engine.js";

/** In-memory stand-in for AgentManager — just enough surface for the engine. */
class FakeAgents {
  events = new Emitter<{ event: RunEvent; runChanged: { run: AgentRun } }>();
  dispatchGuard: ((manager: AgentRun, spec: WorkerSpec) => Promise<string | null>) | null = null;
  runs: AgentRun[] = [];
  started: AgentStartParams[] = [];
  /** mergeTrack runs real git here — tests that use it point this at a repo. */
  workspaceRoot = "";

  async list(): Promise<AgentRun[]> {
    return [...this.runs];
  }

  /** Mirrors the AgentManager tag index the engine's spend path reads. */
  async runsWithTag(tag: string): Promise<AgentRun[]> {
    return this.runs.filter((r) => r.tags.includes(tag));
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
    if (!run) throw new Error(`No active run ${runId}`);
    run.status = "cancelled";
  }

  async chainRuns(runId: string): Promise<AgentRun[]> {
    const byId = new Map(this.runs.map((r) => [r.id, r]));
    const root = chainRootId(runId, byId);
    return this.runs
      .filter((r) => chainRootId(r.id, byId) === root)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** No interactive terminals in these tests — the engine falls back to resumeChain. */
  async deliverInteractive(_runId: string, _text: string): Promise<AgentRun | null> {
    return null;
  }

  /** Mirrors AgentManager.resumeChain: idle + session → new turn, else null. */
  async resumeChain(fromRunId: string, prompt: string): Promise<AgentRun | null> {
    const chain = await this.chainRuns(fromRunId);
    if (chain.some((r) => r.status === "running" || r.status === "queued")) return null;
    const latest = chain[chain.length - 1];
    const session = [...chain].reverse().find((r) => r.sessionId)?.sessionId;
    if (!latest || !session || latest.status === "cancelled") return null;
    const root = chain[0]!;
    return this.start({
      prompt,
      cwd: root.cwd,
      resumeSessionId: session,
      resumedFromRunId: latest.id,
      role: root.role === "manager" ? "manager" : null,
      tags: root.tags,
    });
  }

  /** Settle a run and fire the terminal runChanged the engine listens for. */
  settle(run: AgentRun, status: AgentRun["status"] = "completed"): void {
    run.status = status;
    this.events.emit("runChanged", { run: { ...run } });
  }
}

const fakeStore = {
  loadAgents: async () => createDefaultRoster(),
} as unknown as WorkspaceStore;

async function until(cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WorkflowEngine", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-wf-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeEngine() {
    const agents = new FakeAgents();
    const dataDir = path.join(dir, `e${Math.random().toString(36).slice(2)}`);
    // The global library gets a directory under the test's temp root: the
    // real one is ~/.crystal/workflow-templates, and a test that writes there
    // would leave templates in the developer's own Crystal.
    const globalDir = path.join(dataDir, "global-templates");
    const engine = new WorkflowEngine(
      dataDir,
      agents as unknown as AgentManager,
      fakeStore,
      new GlobalTemplateStore(globalDir),
    );
    return { agents, engine, dataDir, globalDir };
  }

  it("start spawns a tagged manager session and persists the workflow", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({
      name: "Feature X",
      goal: "Build feature X",
      budgetUsd: 10,
    });
    expect(run.role).toBe("manager");
    expect(run.purpose).toBe("manage");
    expect(run.tags).toContain(workflowTag(workflow.id));
    expect(run.prompt).toContain("Build feature X");
    expect(workflow.managerRunId).toBe(run.id);
    expect((await engine.list()).map((w) => w.id)).toContain(workflow.id);
    expect(agents.started).toHaveLength(1);
    // The manager defaults to the default preset's manager model when no
    // profile overrides (Delegated: fable orchestration).
    expect(agents.started[0]!.model).toBe("fable");
  });

  async function makeRepo(): Promise<string> {
    const repo = path.join(dir, `repo${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(repo, { recursive: true });
    await runGit(repo, ["init", "-b", "main"]);
    // The engine's merge commits with the repo's identity — configure one.
    await runGit(repo, ["config", "user.email", "test@crystal.local"]);
    await runGit(repo, ["config", "user.name", "Crystal Test"]);
    // Keep file bytes as written — a Windows autocrlf checkout would turn
    // the \n fixtures into \r\n and fail exact-content assertions.
    await runGit(repo, ["config", "core.autocrlf", "false"]);
    await fs.writeFile(path.join(repo, "app.txt"), "base\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-m", "base"]);
    return repo;
  }

  it("mergeTrack lands a track branch with --no-ff and marks the track merged", async () => {
    const { agents, engine } = makeEngine();
    const repo = (agents.workspaceRoot = await makeRepo());
    await runGit(repo, ["checkout", "-b", "wf/x/api"]);
    await fs.writeFile(path.join(repo, "api.txt"), "api\n");
    await runGit(repo, ["add", "."]);
    await runGit(repo, ["commit", "-m", "api work"]);
    await runGit(repo, ["checkout", "main"]);

    const { workflow } = await engine.start({ name: "X", goal: "g" });
    const track = await engine.addTrack(workflow.id, { name: "API", branch: "wf/x/api" });

    // A live worker on the branch means uncommitted work in flight — refuse.
    const worker = await agents.start({
      prompt: "w",
      tags: [workflowTag(workflow.id)],
      branch: "wf/x/api",
    });
    const blocked = await engine.mergeTrack(workflow.id, track.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("live worker");
    agents.settle(worker);

    const merged = await engine.mergeTrack(workflow.id, track.id);
    expect(merged.ok).toBe(true);
    // A real --no-ff merge commit, with the branch's file on the main line.
    expect((await runGit(repo, ["log", "--oneline", "--merges"])).trim()).not.toBe("");
    await expect(fs.readFile(path.join(repo, "api.txt"), "utf8")).resolves.toBe("api\n");
    const wf = (await engine.get(workflow.id))!;
    expect(wf.tracks.find((t) => t.id === track.id)?.status).toBe("merged");
    // Merging twice is refused, not re-run.
    expect((await engine.mergeTrack(workflow.id, track.id)).ok).toBe(false);
  });

  it("mergeTrack aborts on conflict and returns the conflicted files", async () => {
    const { agents, engine } = makeEngine();
    const repo = (agents.workspaceRoot = await makeRepo());
    await runGit(repo, ["checkout", "-b", "wf/x/ui"]);
    await fs.writeFile(path.join(repo, "app.txt"), "branch change\n");
    await runGit(repo, ["commit", "-am", "branch side"]);
    await runGit(repo, ["checkout", "main"]);
    await fs.writeFile(path.join(repo, "app.txt"), "main change\n");
    await runGit(repo, ["commit", "-am", "main side"]);

    const { workflow } = await engine.start({ name: "X", goal: "g" });
    const track = await engine.addTrack(workflow.id, { name: "UI", branch: "wf/x/ui" });
    const result = await engine.mergeTrack(workflow.id, track.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The conflicted files are the handoff to a resolution worker.
      expect(result.conflicts).toEqual(["app.txt"]);
      expect(result.reason).toContain("conflict");
    }
    // Nothing half-merged: clean tree, track untouched.
    expect((await runGit(repo, ["status", "--porcelain"])).trim()).toBe("");
    const wf = (await engine.get(workflow.id))!;
    expect(wf.tracks.find((t) => t.id === track.id)?.status).toBe("active");

    // A track whose branch never materialized is a clear refusal, not a git error.
    const ghost = await engine.addTrack(workflow.id, { name: "Ghost" });
    const missing = await engine.mergeTrack(workflow.id, ghost.id);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("does not exist");
  });

  it("interactive start goes through the injected launcher with the terminal protocol", async () => {
    const { agents, engine } = makeEngine();
    const launched: { prompt: string; title?: string | null; tags: string[] }[] = [];
    engine.interactiveLauncher = async (params) => {
      launched.push(params);
      const run = createAgentRun({ prompt: params.prompt, role: "manager", tags: params.tags });
      run.status = "running";
      run.terminalId = "term_wf";
      return { run, terminal: { id: "term_wf" } };
    };
    const { workflow, run } = await engine.start({ name: "Feature X", goal: "g", interactive: true });
    expect(run.terminalId).toBe("term_wf");
    expect((await engine.get(workflow.id))?.managerRunId).toBe(run.id);
    // Headless spawn was NOT used; the prompt carries the interactive pairing.
    expect(agents.started).toHaveLength(0);
    expect(launched[0]!.prompt).toContain("AskUserQuestion");
    expect(launched[0]!.prompt).toContain("resolve_question");
    expect(launched[0]!.title).toContain("Feature X");
    expect(launched[0]!.tags).toContain(workflowTag(workflow.id));
  });

  it("defaults to interactive when a launcher is wired; interactive:false opts out", async () => {
    const { agents, engine } = makeEngine();
    let launches = 0;
    engine.interactiveLauncher = async (params) => {
      launches += 1;
      const run = createAgentRun({ prompt: params.prompt, role: "manager", tags: params.tags });
      run.status = "running";
      run.terminalId = "term_wf";
      return { run, terminal: { id: "term_wf" } };
    };
    // No `interactive` field at all → the launcher hosts the manager.
    await engine.start({ name: "Default", goal: "g" });
    expect(launches).toBe(1);
    expect(agents.started).toHaveLength(0);
    // The explicit opt-out stays headless (unattended workflows, hub dispatches).
    await engine.start({ name: "Unattended", goal: "g", interactive: false });
    expect(launches).toBe(1);
    expect(agents.started).toHaveLength(1);
  });

  it("messages queue while the manager is live and deliver on settlement", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g" });

    const queued = await engine.message(workflow.id, "change of plans");
    expect(queued.queued).toBe(true);
    expect(queued.run).toBeNull();
    expect(agents.started).toHaveLength(1); // nothing resumed yet

    agents.settle(run);
    await until(() => agents.started.length === 2);
    const resumed = agents.started[1]!;
    expect(resumed.resumeSessionId).toBe(run.sessionId);
    expect(resumed.resumedFromRunId).toBe(run.id);
    expect(resumed.prompt).toContain("USER MESSAGE");
    expect(resumed.prompt).toContain("change of plans");
    expect(resumed.tags).toContain(workflowTag(workflow.id));

    // Idle chain: the next message resumes immediately.
    agents.settle(agents.runs[1]!);
    await new Promise((r) => setTimeout(r, 20));
    const direct = await engine.message(workflow.id, "and one more thing");
    expect(direct.queued).toBe(false);
    expect(direct.run?.prompt).toContain("and one more thing");
  });

  it("guards dispatches while paused and when the budget is exhausted", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g", budgetUsd: 1 });

    // Non-workflow managers are never vetoed.
    const plain = createAgentRun({ prompt: "m", role: "manager" });
    expect(await agents.dispatchGuard!(plain, { prompt: "w" })).toBeNull();

    // Paused → veto.
    await engine.setPaused(workflow.id, true, "hold on");
    const pausedVeto = await agents.dispatchGuard!(run, { prompt: "w" });
    expect(pausedVeto).toMatch(/paused/i);
    await engine.setPaused(workflow.id, false);
    expect(await agents.dispatchGuard!(run, { prompt: "w" })).toBeNull();

    // Spend past the budget → veto with the numbers.
    const spender = createAgentRun({ prompt: "x", tags: [workflowTag(workflow.id)] });
    spender.status = "completed";
    spender.costUsd = 2;
    agents.runs.push(spender);
    const budgetVeto = await agents.dispatchGuard!(run, { prompt: "w" });
    expect(budgetVeto).toMatch(/Budget exhausted/);
  });

  it("budget exhaustion pauses the workflow on settlement; raising it resumes", async () => {
    const { agents, engine } = makeEngine();
    const { workflow } = await engine.start({ name: "W", goal: "g", budgetUsd: 1 });

    const spender = createAgentRun({ prompt: "x", tags: [workflowTag(workflow.id)] });
    spender.costUsd = 3;
    agents.runs.push(spender);
    agents.settle(spender);

    await until(async () => (await engine.get(workflow.id))?.status === "paused");
    const paused = await engine.get(workflow.id);
    expect(paused?.pausedReason).toMatch(/Budget exhausted/);

    const raised = await engine.setBudget(workflow.id, 100);
    expect(raised.status).toBe("running");
    expect(raised.pausedReason).toBeNull();
  });

  it("drives stages, tracks, epic binding and completion through the manager tools", async () => {
    const { engine } = makeEngine();
    const { workflow } = await engine.start({ name: "Big Ship", goal: "g" });

    // Dependency rails hold through the engine too.
    const blocked = await engine.advanceStage(workflow.id, "merge", "active");
    expect(blocked.ok).toBe(false);
    expect((await engine.advanceStage(workflow.id, "refine", "done", "reqs settled")).ok).toBe(true);
    expect((await engine.advanceStage(workflow.id, "plan", "done")).ok).toBe(true);

    const track = await engine.addTrack(workflow.id, { name: "API layer" });
    expect(track.branch).toBe("wf/big-ship/api-layer");
    expect((await engine.setTrackStatus(workflow.id, track.id, "merged")).ok).toBe(true);
    expect((await engine.setTrackStatus(workflow.id, "nope", "merged")).ok).toBe(false);

    await engine.bindEpic(workflow.id, "epic_1");
    const done = await engine.complete(workflow.id, "completed", "Shipped it.");
    expect(done.status).toBe("completed");
    expect(done.summary).toBe("Shipped it.");
    expect(done.epicId).toBe("epic_1");

    const status = await engine.statusText(workflow.id);
    expect(status).toContain("refine [done]");
    expect(status).toContain("wf/big-ship/api-layer");
  });

  it("saves, lists, starts from and deletes custom templates; built-ins are read-only", async () => {
    const { engine } = makeEngine();

    // Built-ins are always listed first.
    const before = await engine.listTemplates();
    expect(before.map((t) => t.id)).toContain("standard");

    const saved = await engine.saveTemplate(
      makeTemplate({
        id: "",
        name: "Docs pass",
        stages: [
          { id: "a", name: "Survey", purpose: "survey", dependsOn: [], perTrack: false, description: "" },
          { id: "b", name: "Write", purpose: "implement", dependsOn: ["a"], perTrack: false, description: "" },
        ],
      }),
    );
    expect(saved.id).toMatch(/^wft_/);
    expect((await engine.listTemplates()).map((t) => t.id)).toContain(saved.id);

    // Starting from the custom id snapshots it into the workflow.
    const { workflow, run } = await engine.start({ name: "Docs", goal: "g", templateId: saved.id });
    expect(workflow.template?.id).toBe(saved.id);
    expect(workflow.stages.map((s) => s.id)).toEqual(["a", "b"]);
    expect(run.prompt).toContain("Survey");

    // Invalid graphs and built-in ids are refused.
    await expect(
      engine.saveTemplate({ ...saved, stages: [{ ...saved.stages[0]!, dependsOn: ["ghost"] }] }),
    ).rejects.toThrow(/unknown stage/);
    await expect(engine.saveTemplate({ ...saved, id: "standard" })).rejects.toThrow(/read-only/);
    await expect(engine.deleteTemplate("standard")).rejects.toThrow(/built-in/);
    await expect(engine.start({ name: "X", goal: "g", templateId: "nope" })).rejects.toThrow(
      /Unknown workflow template/,
    );

    // Deleting the template leaves the running workflow on its snapshot.
    await engine.deleteTemplate(saved.id);
    expect((await engine.listTemplates()).map((t) => t.id)).not.toContain(saved.id);
    const still = await engine.get(workflow.id);
    expect(still?.template?.stages.map((s) => s.id)).toEqual(["a", "b"]);
    expect((await engine.advanceStage(workflow.id, "a", "done")).ok).toBe(true);
  });

  it("custom templates persist across engine restarts on the same data dir", async () => {
    const { engine, dataDir, globalDir } = makeEngine();
    const saved = await engine.saveTemplate(
      makeTemplate({
        id: "",
        name: "Persisted",
        stages: [
          { id: "only", name: "Only", purpose: "implement", dependsOn: [], perTrack: false, description: "" },
        ],
      }),
    );
    const fresh = new WorkflowEngine(
      dataDir,
      new FakeAgents() as unknown as AgentManager,
      fakeStore,
      new GlobalTemplateStore(globalDir),
    );
    expect((await fresh.listTemplates()).map((t) => t.id)).toContain(saved.id);
  });

  it("a global template is visible from every workspace sharing the store", async () => {
    const shared = new GlobalTemplateStore(path.join(dir, `shared${Math.random().toString(36).slice(2)}`));
    const makeOn = (suffix: string) =>
      new WorkflowEngine(
        path.join(dir, `ws-${suffix}`),
        new FakeAgents() as unknown as AgentManager,
        fakeStore,
        shared,
      );
    const a = makeOn("a");
    const b = makeOn("b");

    let notified = 0;
    b.events.on("templatesChanged", () => {
      notified += 1;
    });
    const saved = await a.saveTemplate(
      makeTemplate({
        id: "",
        name: "Shared shape",
        stages: [
          { id: "only", name: "Only", purpose: "implement", dependsOn: [], perTrack: false, description: "" },
        ],
      }),
      "global",
    );
    expect(saved.scope).toBe("global");
    // The other workspace sees it without a reload, and was told.
    expect((await b.listTemplates()).map((t) => t.id)).toContain(saved.id);
    expect(notified).toBeGreaterThan(0);

    // A project-scoped one stays put.
    const local = await a.saveTemplate(
      makeTemplate({
        id: "",
        name: "Local shape",
        stages: [
          { id: "only", name: "Only", purpose: "implement", dependsOn: [], perTrack: false, description: "" },
        ],
      }),
      "project",
    );
    expect((await b.listTemplates()).map((t) => t.id)).not.toContain(local.id);
  });

  it("an inline template starts one workflow without touching the library", async () => {
    const { engine } = makeEngine();
    const oneOff = makeTemplate({
      id: "wft_oneoff",
      name: "Just this once",
      stages: [
        { id: "solo", name: "Solo", purpose: "implement", dependsOn: [], perTrack: false, description: "" },
      ],
    });
    const { workflow } = await engine.start({ name: "W", goal: "g", template: oneOff });
    expect(workflow.stages.map((s) => s.id)).toEqual(["solo"]);
    expect((await engine.listTemplates()).map((t) => t.id)).not.toContain("wft_oneoff");
  });

  it("wake: false parks a steer for the next natural wake, with an honest receipt", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g" });
    agents.settle(run);
    await new Promise((r) => setTimeout(r, 30)); // let the settle hook drain — chain is idle now

    const receipt = await engine.message(workflow.id, "later is fine", { wake: false });
    // Nothing live: the receipt must say a natural wake is NOT coming.
    expect(receipt).toMatchObject({ queued: true, mode: "queued", wakeExpected: false });
    expect(agents.started).toHaveLength(1); // no resume was paid for

    // A worker settling is the natural wake that flushes the parked steer.
    const worker = await agents.start({ prompt: "w", tags: [workflowTag(workflow.id)] });
    agents.settle(worker);
    await until(() => agents.started.length === 3);
    expect(agents.started[2]!.prompt).toContain("USER MESSAGE");
    expect(agents.started[2]!.prompt).toContain("later is fine");

    // The default path still wakes, and says so.
    agents.settle(agents.runs.at(-1)!);
    await new Promise((r) => setTimeout(r, 30));
    const woke = await engine.message(workflow.id, "act on this now");
    expect(woke.mode).toBe("resumed");
    expect(woke.run?.prompt).toContain("act on this now");
  });

  it("compact refuses while runs are live, then respawns the manager from durable state", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "Long Haul", goal: "g" });
    await expect(engine.compact(workflow.id)).rejects.toThrow(/live run/);

    agents.settle(run);
    await new Promise((r) => setTimeout(r, 30));
    await engine.advanceStage(workflow.id, "refine", "done", "reqs settled");

    const { workflow: after, run: fresh } = await engine.compact(workflow.id);
    expect(after.managerRunId).toBe(fresh.id);
    expect(fresh.role).toBe("manager");
    expect(fresh.tags).toContain(workflowTag(workflow.id));
    // Not a resume: a fresh session seeded with the standing prompt + status.
    expect(fresh.resumedFromRunId ?? null).toBeNull();
    expect(fresh.prompt).toContain("COMPACTED SESSION");
    expect(fresh.prompt).toContain("refine [done]");
  });

  it("warns the manager once at 80% of budget, re-armed when the budget changes", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g", budgetUsd: 10 });
    const spender = createAgentRun({ prompt: "x", tags: [workflowTag(workflow.id)] });
    spender.status = "completed";
    spender.costUsd = 8.5;
    agents.runs.push(spender);

    agents.settle(run);
    await until(() => agents.started.length === 2);
    // The warning is an engine notice, not dressed up as the owner's words.
    expect(agents.started[1]!.prompt).toContain("BUDGET WARNING");
    expect(agents.started[1]!.prompt).not.toContain("USER MESSAGE");
    const warned = await engine.get(workflow.id);
    expect(warned?.budgetWarnedAt).toBeTruthy();
    expect(warned?.status).toBe("running"); // warned, not paused — money remains

    // Once: the next settlement past the threshold stays quiet.
    agents.settle(agents.runs.at(-1)!);
    await new Promise((r) => setTimeout(r, 50));
    expect(
      agents.started.filter((s) => s.prompt.includes("BUDGET WARNING")),
    ).toHaveLength(1);

    // Raising the budget re-arms the tripwire for the new edge.
    const raised = await engine.setBudget(workflow.id, 100);
    expect(raised.budgetWarnedAt).toBeNull();
  });

  it("two manager turns that settle nothing pause the workflow as a stall", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g" });

    // Turn 1 ends untyped: no dispatch, no stage/board movement, no question.
    agents.settle(run);
    await until(async () => (await engine.get(workflow.id))?.noProgressTurns === 1);
    expect((await engine.get(workflow.id))?.status).toBe("running");

    // Turn 2 ends untyped too — that's the stall.
    const turn2 = await agents.resumeChain(run.id, "worker settled");
    agents.settle(turn2!);
    await until(async () => (await engine.get(workflow.id))?.status === "paused");
    const stalled = (await engine.get(workflow.id))!;
    expect(stalled.pausedBy).toBe("stall");
    expect(stalled.pausedReason).toMatch(/without settling/);
    // A stalled workflow takes no dispatches until someone intervenes.
    const veto = await agents.dispatchGuard!(turn2!, { prompt: "w" });
    expect(veto).toMatch(/paused/i);

    // Resuming forgives the streak — one quiet turn won't instantly re-pause.
    const resumed = await engine.setPaused(workflow.id, false);
    expect(resumed.noProgressTurns).toBe(0);
  });

  it("typed outcomes reset the stall streak: stage moves and dispatches count", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g" });
    agents.settle(run);
    await until(async () => (await engine.get(workflow.id))?.noProgressTurns === 1);

    // This turn advanced a stage — progress, streak back to zero.
    await engine.advanceStage(workflow.id, "refine", "done", "reqs settled");
    const turn2 = await agents.resumeChain(run.id, "go");
    agents.settle(turn2!);
    await until(async () => (await engine.get(workflow.id))?.noProgressTurns === 0);
    expect((await engine.get(workflow.id))?.status).toBe("running");

    // This turn dispatched a worker — also progress, even with stages untouched.
    await agents.start({ prompt: "w", tags: [workflowTag(workflow.id)] });
    const turn3 = await agents.resumeChain(run.id, "go again");
    agents.settle(turn3!);
    // The streak must stay clear once the hook lands (fingerprint saw the worker).
    await new Promise((r) => setTimeout(r, 50));
    const after = (await engine.get(workflow.id))!;
    expect(after.noProgressTurns).toBe(0);
    expect(after.status).toBe("running");
  });

  it("cancel kills live tagged runs and marks the workflow cancelled", async () => {
    const { agents, engine } = makeEngine();
    const { workflow, run } = await engine.start({ name: "W", goal: "g" });
    expect(run.status).toBe("running");
    const cancelled = await engine.cancel(workflow.id);
    expect(cancelled.status).toBe("cancelled");
    expect(agents.runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
    // Terminal workflows refuse pause/resume.
    await expect(engine.setPaused(workflow.id, true)).rejects.toThrow(/cancelled/);
  });
});

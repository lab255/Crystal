import { describe, expect, it } from "vitest";
import type { AgentRun } from "@crystal/core";
import {
  PermissionBroker,
  callSummary,
  type BoardQuestionRef,
  type PermissionBrokerHost,
} from "./permission-broker.js";

function fakeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run_1",
    prompt: "p",
    cwd: ".",
    status: "running",
    isolation: "none",
    taskId: "task_1",
    projectId: null,
    repoId: null,
    sessionId: null,
    agentId: null,
    parentRunId: null,
    resumedFromRunId: null,
    handoffFromRunId: null,
    role: null,
    purpose: null,
    tags: [],
    model: null,
    branch: null,
    worktreePath: null,
    terminalId: null,
    terminalWs: null,
    filesTouched: [],
    usage: null,
    costUsd: null,
    costCapUsd: null,
    turns: null,
    durationMs: null,
    resultText: null,
    failure: null,
    createdAt: "t0",
    startedAt: null,
    endedAt: null,
  } as unknown as AgentRun;
}

interface HostState {
  grants: string[];
  answer: string | null;
  noted: { runId: string; tool: string; state: string; detail?: string }[];
  filed: { text: string; options: string[]; recommended: string }[];
  closed: string[];
  denied: string[];
  run: AgentRun | null;
  fileResult?: BoardQuestionRef | null;
}

function makeHost(state: HostState): PermissionBrokerHost {
  return {
    run: async () => state.run,
    grantPatterns: async () => state.grants,
    profilePatterns: async () => [],
    note: (runId, event) => state.noted.push({ runId, ...event }),
    fileQuestion: async (_run, text, options, recommended) => {
      state.filed.push({ text, options, recommended });
      return state.fileResult !== undefined
        ? state.fileResult
        : { projectPath: "proj.json", taskId: "task_1", questionId: "q_1" };
    },
    readAnswer: async () => state.answer,
    closeQuestion: async (_ref, _runId, note) => {
      state.closed.push(note);
    },
    onDenied: (_run, tool) => state.denied.push(tool),
  };
}

function baseState(): HostState {
  return {
    grants: [],
    answer: null,
    noted: [],
    filed: [],
    closed: [],
    denied: [],
    run: fakeRun(),
  };
}

const BASELINE = ["Bash(git status*)", "mcp__crystal"];

describe("PermissionBroker", () => {
  it("auto-allows a call covered by the baseline patterns, echoing the input", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 50);
    const input = { command: "git status --short" };
    const decision = await broker.request("run_1", "Bash", input);
    expect(decision).toEqual({ behavior: "allow", updatedInput: input });
    expect(state.filed).toHaveLength(0);
    expect(broker.pendingCount).toBe(0);
  });

  it("auto-allows via the grants ledger", async () => {
    const state = baseState();
    state.grants = ["WebFetch"];
    const broker = new PermissionBroker(makeHost(state), BASELINE, 50);
    const decision = await broker.request("run_1", "WebFetch", { url: "https://x" });
    expect(decision.behavior).toBe("allow");
  });

  it("parks an uncovered call, files the board question, and allows on a grants change", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(broker.pendingCount).toBe(1);
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]!.options).toEqual(["Allow", "Deny"]);
    expect(state.noted.at(0)).toMatchObject({ state: "pending", tool: "WebFetch" });

    state.grants = ["WebFetch"];
    await broker.recheckGrants();
    const decision = await pending;
    expect(decision).toEqual({ behavior: "allow", updatedInput: { url: "https://x" } });
    expect(broker.pendingCount).toBe(0);
    expect(state.noted.at(-1)).toMatchObject({ state: "allowed" });
    expect(state.denied).toHaveLength(0);
    // The board copy is closed with the outcome.
    expect(state.closed.some((n) => n.includes("allowed"))).toBe(true);
  });

  it("allows on an owner board answer starting with Allow", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    state.answer = "Allow";
    await broker.onBoardChanged();
    const decision = await pending;
    expect(decision.behavior).toBe("allow");
    expect(state.denied).toHaveLength(0);
  });

  it("denies on any other owner answer, carrying the owner's words", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    state.answer = "Deny — use the local fixture instead";
    await broker.onBoardChanged();
    const decision = await pending;
    expect(decision.behavior).toBe("deny");
    expect((decision as { message: string }).message).toContain("use the local fixture");
    // The denial reaches the grants ledger tally.
    expect(state.denied).toEqual(["WebFetch"]);
    expect(state.noted.at(-1)).toMatchObject({ state: "denied" });
  });

  it("denies on timeout with instructions to proceed differently", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 20);
    const decision = await broker.request("run_1", "WebFetch", { url: "https://x" });
    expect(decision.behavior).toBe("deny");
    expect((decision as { message: string }).message).toMatch(/ask_question/);
    expect(state.denied).toEqual(["WebFetch"]);
    expect(broker.pendingCount).toBe(0);
  });

  it("settles exactly once when several wake-ups race", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    state.grants = ["WebFetch"];
    state.answer = "Deny";
    await Promise.all([broker.recheckGrants(), broker.onBoardChanged(), broker.recheckGrants()]);
    const decision = await pending;
    // Whichever settled first won; there is exactly one terminal note.
    const terminal = state.noted.filter((n) => n.state !== "pending");
    expect(terminal).toHaveLength(1);
    expect(["allow", "deny"]).toContain(decision.behavior);
    expect(broker.pendingCount).toBe(0);
  });

  it("denies when the run settles before a decision", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    broker.cancelForRun("run_1");
    const decision = await pending;
    expect(decision.behavior).toBe("deny");
    expect((decision as { message: string }).message).toContain("run ended");
  });

  it("still parks (stream event only) when the run has no board task", async () => {
    const state = baseState();
    state.run = fakeRun({ taskId: null });
    state.fileResult = null;
    const broker = new PermissionBroker(makeHost(state), BASELINE, 20);
    const decision = await broker.request("run_1", "WebFetch", { url: "https://x" });
    expect(decision.behavior).toBe("deny"); // timed out — no grants change came
    expect(state.noted.at(0)).toMatchObject({ state: "pending" });
  });

  it("denies unknown runs and never throws", async () => {
    const state = baseState();
    state.run = null;
    const broker = new PermissionBroker(makeHost(state), BASELINE, 20);
    const decision = await broker.request("run_x", "WebFetch", {});
    expect(decision.behavior).toBe("deny");
  });

  it("dispose denies everything parked", async () => {
    const state = baseState();
    const broker = new PermissionBroker(makeHost(state), BASELINE, 10_000);
    const pending = broker.request("run_1", "WebFetch", { url: "https://x" });
    await new Promise((r) => setTimeout(r, 10));
    broker.dispose();
    const decision = await pending;
    expect(decision.behavior).toBe("deny");
    expect(broker.pendingCount).toBe(0);
  });
});

describe("callSummary", () => {
  it("names the tool with its primary argument, capped", () => {
    expect(callSummary("Bash", { command: "git push" })).toBe("Bash (git push)");
    expect(callSummary("WebFetch", { url: "https://x" })).toBe("WebFetch (https://x)");
    expect(callSummary("Weird", { nested: {} })).toBe("Weird");
    expect(callSummary("Bash", { command: "x".repeat(200) })).toHaveLength("Bash ()".length + 121);
  });
});

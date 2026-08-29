import { describe, expect, it } from "vitest";
import {
  createAgentRun,
  groupRunsByManager,
  MANAGER_PREAMBLE,
  type AgentEvent,
  type AgentRun,
  type RunEvent,
  type TaskQuestion,
} from "@crystal/core";
import {
  buildTranscriptItems,
  humanRunFailure,
  workTitle,
  type WorkEntry,
} from "./transcript-items.js";

function run(overrides: Partial<AgentRun> & { prompt: string }): AgentRun {
  const base = createAgentRun({ prompt: overrides.prompt });
  return { ...base, ...overrides, id: overrides.id ?? base.id };
}

function events(runId: string, list: AgentEvent[]): RunEvent[] {
  return list.map((event, i) => ({ runId, seq: i + 1, ts: `2026-01-01T00:00:0${i}Z`, event }));
}

const READ = (id: string, file: string): AgentEvent[] => [
  { type: "tool_use", toolUseId: id, name: "Read", input: { file_path: file } },
  { type: "tool_result", toolUseId: id, content: "…", isError: false },
];

describe("buildTranscriptItems", () => {
  it("classifies kickoff prompts, engine notices, and owner text", () => {
    const prompts = [
      MANAGER_PREAMBLE + "\nbrief",
      'You are the PROGRAM MANAGER of "Launch"',
      "Worker run_1 settled: completed",
      'Answer to your question "Ship?": yes',
      "USER MESSAGE:\nship it",
      "BUDGET WARNING: $8 of $10 spent",
      "Delivery d1 (Alpha) settled: completed",
      "A project is waiting on an answer:",
      "2 projects are waiting on answers:",
      'Every delivery of program "Launch" has settled (completed).',
      "2 updates arrived while you were working.",
      "ordinary owner text",
    ];
    const items = buildTranscriptItems({
      turns: prompts.map((prompt, index) => run({ id: `r${index}`, prompt })),
      eventsByRun: Object.fromEntries(prompts.map((_, index) => [`r${index}`, []])),
    });
    expect(items.map((item) => item.kind)).toEqual([
      "kickoff", "kickoff", "notice", "notice", "user", "notice",
      "notice", "notice", "notice", "notice", "notice", "user",
    ]);
    expect(items[4]).toMatchObject({ kind: "user", text: "ship it" });
  });

  it("renders both owner-message envelopes as stripped user bubbles", () => {
    const prompts = [
      "USER MESSAGE:\nworkflow words\n\nThis is steering from the workflow's owner. Acknowledge it, adjust the plan/dispatches accordingly, and keep driving the workflow.",
      "OWNER MESSAGE:\nprogram words\n\nThis is steering from the program's owner. Acknowledge it, adjust the deliveries/dispatches accordingly, and keep driving the program.",
    ];
    const items = buildTranscriptItems({
      turns: prompts.map((prompt, index) => run({ id: `owner${index}`, prompt })),
      eventsByRun: { owner0: [], owner1: [] },
    });
    expect(items).toMatchObject([
      { kind: "user", text: "workflow words" },
      { kind: "user", text: "program words" },
    ]);
  });

  it("expires pending permissions on terminal runs", () => {
    const turn = run({ id: "r1", prompt: "x", status: "failed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [{
          type: "permission",
          tool: "Bash",
          state: "pending",
          detail: "pnpm test",
        }]),
      },
    });
    expect(items.find((item) => item.kind === "permission")).toMatchObject({
      kind: "permission",
      state: "expired",
    });
  });
  it("renders each turn as user row + folded events, oldest first", () => {
    const turn = run({ id: "r1", prompt: "Fix it", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "text", text: "On it." },
          ...READ("t1", "a.ts"),
          ...READ("t2", "b.ts"),
          {
            type: "result",
            ok: true,
            resultText: "Done",
            costUsd: 0.42,
            turns: 3,
            durationMs: 9000,
            sessionId: null,
          },
        ]),
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "work", "turn-end"]);
    const work = items[2] as Extract<(typeof items)[number], { kind: "work" }>;
    expect(work.entries).toHaveLength(2);
    expect(work.title).toBe("Explored 2 files");
    expect(work.hasError).toBe(false);
    const end = items[3] as Extract<(typeof items)[number], { kind: "turn-end" }>;
    expect(end.costUsd).toBe(0.42);
  });

  it("keeps consecutive reads in one collapsed group but splits on prose", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          ...READ("t1", "a.ts"),
          { type: "text", text: "Found it." },
          ...READ("t2", "b.ts"),
        ]),
      },
    });
    expect(items.map((i) => i.kind)).toEqual(["user", "work", "assistant", "work"]);
  });

  it("marks a work group loud when a tool result errors", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "tool_use", toolUseId: "t1", name: "Bash", input: { command: "false" } },
          { type: "tool_result", toolUseId: "t1", content: "exit 1", isError: true },
        ]),
      },
    });
    const work = items.find((i) => i.kind === "work");
    expect(work && work.kind === "work" ? work.hasError : null).toBe(true);
  });

  it("attaches thinking to the following assistant prose", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "Answer." },
        ]),
      },
    });
    const assistant = items.find((i) => i.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" ? assistant.thinking : null).toBe("hmm");
  });

  it("joins question events to their board record by run and text", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const record: TaskQuestion = {
      id: "q1",
      runId: "r1",
      askedBy: "agent",
      text: "Ship it?",
      options: ["yes", "no"],
      recommended: "yes",
      answer: null,
      createdAt: "2026-01-01T00:00:00Z",
      answeredAt: null,
    };
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [{ type: "question", text: "Ship it?", options: ["yes", "no"] }]),
      },
      questions: [record],
    });
    const q = items.find((i) => i.kind === "question");
    expect(q && q.kind === "question" ? q.record?.id : null).toBe("q1");
  });

  it("nests the dispatched worker under its delegation row", () => {
    const manager = run({ id: "m1", prompt: "Manage", role: "manager", status: "completed", createdAt: "2026-01-01T00:00:00Z" });
    const worker = run({ id: "w1", prompt: "Do the thing", parentRunId: "m1", status: "completed", createdAt: "2026-01-02T00:00:00Z" });
    const [node] = groupRunsByManager([worker, manager]);
    const items = buildTranscriptItems({
      turns: node!.turns,
      eventsByRun: {
        m1: events("m1", [
          {
            type: "dispatch",
            spec: { prompt: "Do the thing" },
          },
        ]),
      },
      workers: node!.workers,
    });
    const d = items.find((i) => i.kind === "delegation");
    expect(d && d.kind === "delegation" ? d.worker?.run.id : null).toBe("w1");
  });

  it("clears pending on a work group closed before its tool_result arrived", () => {
    // A permission prompt closes the work group mid-flight; the later
    // tool_result must still clear the closed item's spinner.
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "tool_use", toolUseId: "t1", name: "Bash", input: { command: "ls" } },
          { type: "permission", tool: "Bash", state: "pending" },
          { type: "permission", tool: "Bash", state: "allowed" },
          { type: "tool_result", toolUseId: "t1", content: "ok", isError: false },
        ]),
      },
    });
    const work = items.find((i) => i.kind === "work");
    expect(work && work.kind === "work" ? work.pending : null).toBe(false);
  });

  it("settles a pending permission row in place when its allowed/denied event lands", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "permission", tool: "Bash", state: "pending", detail: "rm -rf tmp" },
          { type: "permission", tool: "Bash", state: "allowed" },
        ]),
      },
    });
    const perms = items.filter((i) => i.kind === "permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.kind === "permission" ? perms[0]!.state : null).toBe("allowed");
    expect(perms[0]!.kind === "permission" ? perms[0]!.detail : null).toBe("rm -rf tmp");
  });

  it("keeps pending permission rows for different tools distinct", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "permission", tool: "Bash", state: "pending" },
          { type: "permission", tool: "WebFetch", state: "pending" },
          { type: "permission", tool: "WebFetch", state: "denied" },
        ]),
      },
    });
    const perms = items.filter((i) => i.kind === "permission");
    expect(perms.map((p) => (p.kind === "permission" ? [p.tool, p.state] : null))).toEqual([
      ["Bash", "expired"],
      ["WebFetch", "denied"],
    ]);
  });

  it("keeps a permission row that settled without a prior pending event", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [{ type: "permission", tool: "Bash", state: "allowed" }]),
      },
    });
    const perms = items.filter((i) => i.kind === "permission");
    expect(perms).toHaveLength(1);
    expect(perms[0]!.kind === "permission" ? perms[0]!.state : null).toBe("allowed");
  });

  it("honors collapsedTurnIds even when the turn's events are loaded", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: { r1: events("r1", [{ type: "text", text: "hi" }]) },
      collapsedTurnIds: new Set(["r1"]),
    });
    expect(items.map((i) => i.kind)).toEqual(["user", "collapsed-turn"]);
  });

  it("renders a settled turn without loaded events as a collapsed row", () => {
    const turn = run({ id: "r1", prompt: "x", status: "completed" });
    const items = buildTranscriptItems({ turns: [turn], eventsByRun: {} });
    expect(items.map((i) => i.kind)).toEqual(["user", "collapsed-turn"]);
  });

  it("skips lifecycle noise but keeps terminal failures", () => {
    const turn = run({ id: "r1", prompt: "x", status: "failed" });
    const items = buildTranscriptItems({
      turns: [turn],
      eventsByRun: {
        r1: events("r1", [
          { type: "status", status: "running" },
          { type: "status", status: "failed", message: "spawn ENOENT" },
        ]),
      },
    });
    const system = items.find((i) => i.kind === "system");
    expect(system && system.kind === "system" ? system.text : null).toBe("failed — spawn ENOENT");
  });
});

describe("workTitle", () => {
  const entry = (name: string, title: string): WorkEntry => ({
    toolUseId: title,
    name,
    title,
    input: "",
    result: "",
    isError: false,
  });

  it("summarizes reads, searches, commands and edits", () => {
    expect(
      workTitle([
        entry("Read", "Read a.ts"),
        entry("Read", "Read b.ts"),
        entry("Grep", "Searched foo"),
        entry("Bash", "$ pnpm test"),
        entry("Edit", "Edited packages/core/src/agent.ts"),
      ]),
    ).toBe("Explored 2 files, 1 search, 1 command, edited agent.ts");
  });
});

describe("humanRunFailure", () => {
  it("turns provider failure codes into a recovery label", () => {
    expect(humanRunFailure("rate_limit_error: usage limit reached"))
      .toContain("Usage limit reached");
    expect(humanRunFailure("spawn ENOENT")).toBe("spawn ENOENT");
  });
});

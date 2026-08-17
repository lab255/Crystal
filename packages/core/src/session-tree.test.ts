import { describe, expect, it } from "vitest";
import { createAgentRun, groupRunsByManager, type AgentRun } from "./agent.js";
import type { NeedsYou } from "./attention.js";
import {
  attentionRunIds,
  runWorkflowId,
  sessionDescendantCount,
  sessionDisplayStatus,
  sessionLatestActivity,
  sessionSubtreeCost,
  sessionWorkflowId,
} from "./session-tree.js";

const run = (id: string, over: Partial<AgentRun> = {}): AgentRun =>
  ({ ...createAgentRun({ prompt: id }), id, createdAt: `2026-01-01T00:00:0${id.at(-1)}Z`, ...over });

/** Deep fixture: manager → worker-manager → grandchild, plus a settled sibling. */
function forest(over: Record<string, Partial<AgentRun>> = {}) {
  const runs = [
    run("g4", { parentRunId: "w2", role: "worker", ...over["g4"] }),
    run("w3", { parentRunId: "m1", role: "worker", status: "completed", ...over["w3"] }),
    run("w2", { parentRunId: "m1", role: "manager", status: "completed", ...over["w2"] }),
    run("m1", { role: "manager", status: "completed", ...over["m1"] }),
  ];
  return groupRunsByManager(runs);
}

describe("sessionDisplayStatus", () => {
  it("sees work anywhere in the subtree, not just one level down", () => {
    const [root] = forest({ g4: { status: "running" } });
    expect(sessionDisplayStatus(root!, new Set())).toBe("working");
  });

  it("lets attention outrank a streaming sibling — blocked is actionable", () => {
    const [root] = forest({ g4: { status: "running" }, w3: { status: "failed" } });
    expect(sessionDisplayStatus(root!, new Set(["w3"]))).toBe("needs-you");
  });

  it("degrades to failed/idle without an attention feed, never to needs-you", () => {
    const [failed] = forest({ g4: { status: "failed" } });
    expect(sessionDisplayStatus(failed!, new Set())).toBe("failed");
    const [settled] = forest({ g4: { status: "completed" } });
    expect(sessionDisplayStatus(settled!, new Set())).toBe("idle");
  });

  it("matches attention on any turn of a resume chain, not only the face", () => {
    const first = run("t1", { status: "failed" });
    const second = run("t2", { resumedFromRunId: "t1", status: "completed" });
    const [node] = groupRunsByManager([second, first]);
    expect(sessionDisplayStatus(node!, new Set(["t1"]))).toBe("needs-you");
  });
});

describe("subtree rollups", () => {
  it("sums cost and counts descendants across every level", () => {
    const [root] = forest({
      m1: { costUsd: 1 },
      w2: { costUsd: 2 },
      w3: { costUsd: 4 },
      g4: { costUsd: 8 },
    });
    expect(sessionSubtreeCost(root!)).toBe(15);
    expect(sessionDescendantCount(root!)).toBe(3);
  });

  it("takes the newest stamp in the subtree as latest activity", () => {
    const [root] = forest({ g4: { endedAt: "2026-01-02T00:00:00Z" } });
    expect(sessionLatestActivity(root!)).toBe("2026-01-02T00:00:00Z");
  });
});

describe("workflow attribution", () => {
  it("reads the workflow dimension off run tags", () => {
    expect(runWorkflowId({ tags: ["epic:e1", "workflow:wf9"] })).toBe("wf9");
    expect(runWorkflowId({ tags: ["epic:e1"] })).toBeNull();
  });

  it("takes the first tagged turn of the chain", () => {
    const first = run("t1", { tags: ["workflow:wf9"] });
    const second = run("t2", { resumedFromRunId: "t1", tags: [] });
    const [node] = groupRunsByManager([second, first]);
    expect(sessionWorkflowId(node!)).toBe("wf9");
  });
});

describe("attentionRunIds", () => {
  it("joins questions, permissions and failures on their run ids", () => {
    const needsYou = {
      questions: [
        { question: { runId: "q-run" } },
        { question: { runId: null } }, // manual ask — no session to mark
      ],
      permissions: [{ runId: "p-run" }],
      failures: [{ id: "f-run" }],
      count: 3,
    } as unknown as NeedsYou;
    expect(attentionRunIds(needsYou)).toEqual(new Set(["q-run", "p-run", "f-run"]));
  });
});

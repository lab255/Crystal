import { describe, expect, it } from "vitest";
import { createAgentRun, type AgentRun } from "@crystal/core";
import { buildThreadGroups, threadForRunId, threadIndicator } from "./thread-model.js";
import { groupRunsByManager } from "@crystal/core";

function run(overrides: Partial<AgentRun> & { prompt: string }): AgentRun {
  const base = createAgentRun({ prompt: overrides.prompt });
  return { ...base, ...overrides, id: overrides.id ?? base.id };
}

describe("buildThreadGroups", () => {
  it("collapses resume chains to one thread keyed by the chain root", () => {
    const first = run({ id: "r1", prompt: "Fix the login bug", status: "completed", createdAt: "2026-01-01T00:00:00Z" });
    const resumed = run({
      id: "r2",
      prompt: "Worker settled — review it",
      resumedFromRunId: "r1",
      status: "completed",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const groups = buildThreadGroups({
      runs: [resumed, first],
      attention: new Set(),
      lastSeen: { r1: "2026-02-01T00:00:00Z" },
      pins: new Set(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.threads).toHaveLength(1);
    const thread = groups[0]!.threads[0]!;
    // Thread identity is the chain ROOT, stable across resumes.
    expect(thread.id).toBe("r1");
    expect(thread.node.turns.map((t) => t.id)).toEqual(["r1", "r2"]);
  });

  it("groups by board project and buckets unattributed runs as ad hoc", () => {
    const boardRun = run({ id: "r1", prompt: "On the board", projectId: "proj1", status: "completed", createdAt: "2026-01-01T00:00:00Z" });
    const looseRun = run({ id: "r2", prompt: "Ad hoc exploration", status: "completed", createdAt: "2026-01-02T00:00:00Z" });
    const groups = buildThreadGroups({
      runs: [looseRun, boardRun],
      attention: new Set(),
      lastSeen: { r1: "2026-02-01T00:00:00Z", r2: "2026-02-01T00:00:00Z" },
      pins: new Set(),
      projectNameOf: (id) => (id === "proj1" ? "Payments" : null),
    });
    expect(groups.map((g) => g.name)).toEqual(["Ad hoc", "Payments"]);
  });

  it("groups unprojected workflow chains by workflow name instead of ad hoc", () => {
    const workflowRun = run({
      id: "r1",
      prompt: "Coordinate release",
      tags: ["workflow:wf1"],
      status: "completed",
    });
    const groups = buildThreadGroups({
      runs: [workflowRun],
      attention: new Set(),
      lastSeen: {},
      pins: new Set(),
      namingContext: { workflowNameOf: (id) => id === "wf1" ? "Release train" : null },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "workflow:wf1", projectId: null, name: "Release train" });
  });

  it("gives workflow and ad-hoc sections distinct stable render keys", () => {
    const workflowRun = run({ id: "r1", prompt: "Release", tags: ["workflow:wf1"], status: "completed" });
    const looseRun = run({ id: "r2", prompt: "Explore", status: "completed" });
    const groups = buildThreadGroups({
      runs: [workflowRun, looseRun], attention: new Set(), lastSeen: {}, pins: new Set(),
    });
    expect(groups.map((group) => group.key)).toEqual(["workflow:wf1", "ad-hoc"]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length);
  });

  it("orders by pin, then indicator precedence, then recency", () => {
    const needsInput = run({ id: "rq", prompt: "Blocked on a question", status: "completed", createdAt: "2026-01-01T00:00:00Z" });
    const working = run({ id: "rw", prompt: "Streaming", status: "running", createdAt: "2026-01-02T00:00:00Z" });
    const idle = run({ id: "ri", prompt: "Old and read", status: "completed", createdAt: "2026-01-03T00:00:00Z" });
    const pinnedIdle = run({ id: "rp", prompt: "Pinned", status: "completed", createdAt: "2026-01-04T00:00:00Z" });
    const groups = buildThreadGroups({
      runs: [idle, working, needsInput, pinnedIdle],
      attention: new Set(["rq"]),
      lastSeen: {
        ri: "2026-02-01T00:00:00Z",
        rp: "2026-02-01T00:00:00Z",
        rw: "2026-02-01T00:00:00Z",
      },
      pins: new Set(["rp"]),
    });
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(["rp", "rq", "rw", "ri"]);
    expect(groups[0]!.threads.map((t) => t.indicator)).toEqual([
      "idle",
      "needs-input",
      "running",
      "idle",
    ]);
  });

  it("filters by title", () => {
    const a = run({ id: "r1", prompt: "Fix the login bug", status: "completed" });
    const b = run({ id: "r2", prompt: "Write release notes", status: "completed" });
    const groups = buildThreadGroups({
      runs: [a, b],
      attention: new Set(),
      lastSeen: {},
      pins: new Set(),
      find: "login",
    });
    expect(groups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["r1"]);
  });

  it("copies cross-workspace scope onto groups and summaries", () => {
    const groups = buildThreadGroups({
      runs: [run({ id: "r1", prompt: "Scoped", status: "completed" })],
      attention: new Set(), lastSeen: {}, pins: new Set(),
      scope: { sid: "s1", ws: "w1" },
    });
    expect(groups[0]).toMatchObject({ sid: "s1", ws: "w1" });
    expect(groups[0]!.threads[0]).toMatchObject({ sid: "s1", ws: "w1" });
  });
});

describe("threadIndicator", () => {
  it("marks unread only for settled threads with unseen activity", () => {
    const settled = run({
      id: "r1",
      prompt: "x",
      status: "completed",
      createdAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-05T00:00:00Z",
    });
    const [node] = groupRunsByManager([settled]);
    expect(threadIndicator(node!, new Set(), undefined)).toBe("unread");
    expect(threadIndicator(node!, new Set(), "2026-01-06T00:00:00Z")).toBe("idle");
    expect(threadIndicator(node!, new Set(), "2026-01-02T00:00:00Z")).toBe("unread");
    // Attention outranks everything.
    expect(threadIndicator(node!, new Set(["r1"]), "2026-01-06T00:00:00Z")).toBe("needs-input");
  });
});

describe("threadForRunId", () => {
  it("resolves any run id in a chain — including a worker's — to its thread", () => {
    const manager = run({ id: "m1", prompt: "Manage", role: "manager", status: "running", createdAt: "2026-01-01T00:00:00Z" });
    const worker = run({ id: "w1", prompt: "Do the work", parentRunId: "m1", status: "running", createdAt: "2026-01-02T00:00:00Z" });
    const groups = buildThreadGroups({
      runs: [worker, manager],
      attention: new Set(),
      lastSeen: {},
      pins: new Set(),
    });
    expect(threadForRunId(groups, "w1")?.id).toBe("m1");
    expect(threadForRunId(groups, "m1")?.id).toBe("m1");
    expect(threadForRunId(groups, "nope")).toBeNull();
  });
});

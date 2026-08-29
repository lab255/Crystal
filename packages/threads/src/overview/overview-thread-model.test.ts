import { describe, expect, it } from "vitest";
import {
  createAgentRun,
  createProgram,
  createWorkflow,
  type AgentRun,
  type Program,
  type Workflow,
} from "@crystal/core";
import {
  buildOverviewSections,
  countExternalProgramQuestions,
  filterOverviewSections,
  formatOverviewThreadId,
  parseOverviewThreadId,
  resolveOverviewThread,
  type OverviewModelInput,
} from "./overview-thread-model.js";

function run(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return { ...createAgentRun({ prompt: overrides.prompt ?? id }), ...overrides, id };
}
function program(id: string, name = id): Program {
  return { ...createProgram({ name, goal: "goal" }), id };
}
function workflow(id: string, managerRunId: string | null): Workflow {
  return { ...createWorkflow({ name: id, goal: "goal" }), id, managerRunId };
}
function input(runs: AgentRun[] = [], workflows: Workflow[] = []): OverviewModelInput {
  return {
    connections: [{
      sid: "s1",
      label: "Local",
      state: "open",
      workspaces: [{ id: "w1", name: "Alpha" }],
    }],
    runsByWs: { "s1/w1": runs },
    workflowsByWs: { "s1/w1": workflows },
    attentionByWs: {},
    programs: [] as Program[],
    hubRuns: [] as AgentRun[],
    hubSid: "s1",
    programQuestions: {},
    spend: {},
    lastSeen: {},
    pins: new Set<string>(),
    filter: "managers" as const,
  };
}

describe("overview thread ids", () => {
  it("round trips program and slash-containing workspace refs", () => {
    const refs = [
      { kind: "program", programId: "p1" },
      { kind: "workspace", sid: "sabc", ws: "folder/uuid", threadId: "r1" },
    ] as const;
    for (const ref of refs) {
      expect(parseOverviewThreadId(formatOverviewThreadId(ref))).toEqual(ref);
    }
    expect(parseOverviewThreadId("ws:broken")).toBeNull();
  });

  it("rejects empty workspace ids and preserves opaque program and workspace ids", () => {
    expect(parseOverviewThreadId("ws:s1//r1")).toBeNull();
    expect(parseOverviewThreadId("program:portfolio/launch")).toEqual({
      kind: "program",
      programId: "portfolio/launch",
    });
    expect(parseOverviewThreadId("ws:s1/team:api/r1")).toEqual({
      kind: "workspace",
      sid: "s1",
      ws: "team:api",
      threadId: "r1",
    });
  });
});

describe("buildOverviewSections", () => {
  it("keeps each manager-filter rule and excludes an unrelated root", () => {
    const runs = [
      run("workflow-manager"),
      run("role-manager", { role: "manager" }),
      run("tag-manager", { tags: ["workflow:w2"] }),
      run("ordinary"),
    ];
    const sections = filterOverviewSections(
      buildOverviewSections(input(runs, [workflow("w1", "workflow-manager")])),
      { filter: "managers" },
    );
    const ids = sections[1]!.threads.map((thread) =>
      thread.ref.kind === "workspace" && thread.ref.threadId,
    );
    expect(ids).toEqual(
      expect.arrayContaining(["workflow-manager", "role-manager", "tag-manager"]),
    );
    expect(ids).not.toContain("ordinary");
  });

  it("shows programs with and without runs and gives open questions precedence", () => {
    const a = program("p1", "Fresh");
    const b = { ...program("p2", "Active"), managerRunId: "hub1" };
    const data = input();
    data.programs = [a, b];
    data.hubRuns = [run("hub1", { tags: ["program:p2"], status: "running" })];
    data.programQuestions = { p1: [{ questionId: "q1" }] as never };
    const coordinator = buildOverviewSections(data)[0]!;
    expect(coordinator.threads.map((thread) => [thread.title, thread.indicator])).toEqual([
      ["Fresh", "needs-input"],
      ["Active", "running"],
    ]);
  });

  it("marks program questions as needs-input and newer settled faces as unread", () => {
    const questioned = { ...program("p1", "Questioned"), managerRunId: "hub1" };
    const unread = { ...program("p2", "Unread"), managerRunId: "hub2" };
    const data = input();
    data.programs = [questioned, unread];
    data.hubRuns = [
      run("hub1", {
        tags: ["program:p1"],
        status: "completed",
        endedAt: "2026-08-09T00:00:02.000Z",
      }),
      run("hub2", {
        tags: ["program:p2"],
        status: "completed",
        endedAt: "2026-08-09T00:00:03.000Z",
      }),
    ];
    data.programQuestions = { p1: [{ questionId: "q1" }] as never };
    data.lastSeen["s1/hub/program:p2"] = "2026-08-09T00:00:01.000Z";

    const rows = buildOverviewSections(data)[0]!.threads;
    expect(rows.find((thread) => thread.title === "Questioned")?.indicator).toBe("needs-input");
    expect(rows.find((thread) => thread.title === "Unread")?.indicator).toBe("unread");
  });

  it("sorts pinned before attention and filters by workspace or program name", () => {
    const data = input([
      run("a", { role: "manager", status: "running" }),
      run("b", { role: "manager", status: "completed" }),
    ]);
    data.attentionByWs = { "s1/w1": new Set(["a"]) };
    data.pins.add("s1/w1/b");
    const sections = buildOverviewSections(data);
    expect(sections[1]!.threads.map((thread) => thread.summary?.id)).toEqual(["b", "a"]);
    expect(
      filterOverviewSections(sections, { filter: "managers", find: "alpha" }),
    ).toHaveLength(1);
    expect(
      filterOverviewSections(sections, { filter: "managers", find: "missing" }),
    ).toHaveLength(0);
  });

  it("finds title, workspace name, or program name and carries workspace labels", () => {
    const data = input([run("manager", { role: "manager", prompt: "Deploy API" })]);
    data.programs = [program("p1", "Portfolio launch")];

    const all = buildOverviewSections(data);
    expect(all[1]!.threads[0]).toMatchObject({
      workspaceName: "Alpha",
      serverLabel: null,
    });
    expect(
      filterOverviewSections(all, { filter: "managers", find: "deploy" })[0]!.threads,
    ).toHaveLength(1);
    expect(
      filterOverviewSections(all, { filter: "managers", find: "alpha" })[0]!.threads,
    ).toHaveLength(1);
    expect(
      filterOverviewSections(all, { filter: "managers", find: "portfolio" })[0]!.threads,
    ).toHaveLength(1);
  });

  it("resolves filtered-out roots and resumed or worker run ids to the canonical thread", () => {
    const runs = [
      run("root"),
      run("resume", { parentRunId: "root" }),
      run("worker", { parentRunId: "resume", role: "worker" }),
    ];
    const all = buildOverviewSections(input(runs));
    const visible = filterOverviewSections(all, { filter: "managers", find: "no match" });
    expect(visible).toHaveLength(0);
    for (const runId of ["root", "resume", "worker"]) {
      expect(resolveOverviewThread(all, `ws:s1/w1/${runId}`)?.ref).toEqual({
        kind: "workspace",
        sid: "s1",
        ws: "w1",
        threadId: "root",
      });
    }
  });

  it("assigns a workflow only to the chain that owns its manager run", () => {
    const taggedOld = run("old", { tags: ["workflow:w1"] });
    const taggedLive = run("live", { tags: ["workflow:w1"] });
    const rows = buildOverviewSections(input(
      [taggedOld, taggedLive],
      [workflow("w1", "live")],
    ))[1]!.threads;
    expect(rows.find((thread) => thread.summary?.id === "live")?.workflow?.id).toBe("w1");
    expect(rows.find((thread) => thread.summary?.id === "old")?.workflow).toBeNull();
  });

  it("keeps a run-less program idle with no activity stamp and a hub-scoped read key", () => {
    const data = input();
    data.programs = [program("p1")];
    expect(buildOverviewSections(data)[0]!.threads[0]).toMatchObject({
      indicator: "idle",
      lastActivity: null,
      readKey: "s1/hub/program:p1",
    });
  });

  it("uses hub spend for coordinator row cost when available", () => {
    const data = input();
    data.programs = [program("p1")];
    data.spend = { p1: { costUsd: 12.5 } as never };
    expect(buildOverviewSections(data)[0]!.threads[0]!.costUsd).toBe(12.5);
  });

  it("drops empty workspace sections while retaining an empty coordinator section", () => {
    const sections = filterOverviewSections(buildOverviewSections(input()), {
      filter: "managers",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: "coordinator", threads: [] });
  });

  it("counts only hub questions outside open workspaces on the hub connection", () => {
    const data = input();
    const questions = {
      p1: [{ ws: "w1" }, { ws: "closed" }],
      p2: [{ ws: "closed-too" }],
    } as never;
    expect(countExternalProgramQuestions(questions, data.connections, data.hubSid)).toBe(2);
  });
});

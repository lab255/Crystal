import { describe, expect, it } from "vitest";
import { createAgentRun, createProgram, createWorkflow, type AgentRun, type Program, type Workflow } from "@crystal/core";
import { buildOverviewSections, formatOverviewThreadId, parseOverviewThreadId } from "./overview-thread-model.js";

function run(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return { ...createAgentRun({ prompt: overrides.prompt ?? id }), ...overrides, id };
}
function program(id: string, name = id): Program { return { ...createProgram({ name, goal: "goal" }), id }; }
function workflow(id: string, managerRunId: string | null): Workflow { return { ...createWorkflow({ name: id, goal: "goal" }), id, managerRunId }; }
function input(runs: AgentRun[] = [], workflows: Workflow[] = []) {
  return {
    connections: [{ sid: "s1", label: "Local", state: "open", workspaces: [{ id: "w1", name: "Alpha" }] }],
    runsByWs: { "s1/w1": runs }, workflowsByWs: { "s1/w1": workflows }, attentionByWs: {},
    programs: [] as Program[], hubRuns: [] as AgentRun[], hubSid: "s1", programQuestions: {},
    lastSeen: {}, pins: new Set<string>(), filter: "managers" as const,
  };
}

describe("overview thread ids", () => {
  it("round trips program and slash-containing workspace refs", () => {
    const refs = [{ kind: "program", programId: "p1" }, { kind: "workspace", sid: "sabc", ws: "folder/uuid", threadId: "r1" }] as const;
    for (const ref of refs) expect(parseOverviewThreadId(formatOverviewThreadId(ref))).toEqual(ref);
    expect(parseOverviewThreadId("ws:broken")).toBeNull();
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
    const sections = buildOverviewSections(input(runs, [workflow("w1", "workflow-manager")]));
    expect(sections[1]!.threads.map((thread) => thread.ref.kind === "workspace" && thread.ref.threadId)).toEqual(expect.arrayContaining(["workflow-manager", "role-manager", "tag-manager"]));
    expect(sections[1]!.threads.some((thread) => thread.ref.kind === "workspace" && thread.ref.threadId === "ordinary")).toBe(false);
  });

  it("shows programs with and without runs and gives open questions precedence", () => {
    const a = program("p1", "Fresh"); const b = { ...program("p2", "Active"), managerRunId: "hub1" };
    const data = input(); data.programs = [a, b]; data.hubRuns = [run("hub1", { tags: ["program:p2"], status: "running" })];
    data.programQuestions = { p1: [{ questionId: "q1" }] as never };
    const coordinator = buildOverviewSections(data)[0]!;
    expect(coordinator.threads.map((thread) => [thread.title, thread.indicator])).toEqual([["Fresh", "needs-input"], ["Active", "running"]]);
  });

  it("sorts pinned before attention and filters by workspace or program name", () => {
    const data = input([run("a", { role: "manager", status: "running" }), run("b", { role: "manager", status: "completed" })]);
    data.attentionByWs = { "s1/w1": new Set(["a"]) };
    data.pins.add("s1/w1/b");
    expect(buildOverviewSections(data)[1]!.threads.map((thread) => thread.ref.kind === "workspace" && thread.ref.threadId)).toEqual(["b", "a"]);
    expect(buildOverviewSections({ ...data, find: "alpha" })).toHaveLength(1);
    expect(buildOverviewSections({ ...data, find: "missing" })).toHaveLength(0);
  });
});

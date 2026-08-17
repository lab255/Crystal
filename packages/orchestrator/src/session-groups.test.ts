import {
  AgentRunSchema,
  ProjectSchema,
  TaskItemSchema,
  sessionIsWorking,
  type AgentRun,
  type Project,
} from "@crystal/core";
import { describe, expect, it } from "vitest";
import {
  filterSessionTree,
  groupSessionsByProject,
  sessionNodeMatchesFilter,
} from "./session-groups.js";

const timestamp = "2026-08-12T00:00:00.000Z";

function run(id: string, init: Partial<AgentRun> = {}): AgentRun {
  return AgentRunSchema.parse({ id, prompt: id, createdAt: timestamp, ...init });
}

function project(
  id: string,
  name: string,
  init: Partial<Pick<Project, "epics" | "tasks">> = {},
): Project {
  return ProjectSchema.parse({ id, name, ...init });
}

describe("groupSessionsByProject", () => {
  it("buckets root sessions by project in workspace order", () => {
    const alpha = project("alpha", "Alpha");
    const beta = project("beta", "Beta");
    const groups = groupSessionsByProject(
      [run("beta-run", { projectId: "beta" }), run("alpha-run", { projectId: "alpha" })],
      [
        { path: "alpha.crystal", project: alpha },
        { path: "beta.crystal", project: beta },
      ],
    );

    expect(groups.map((group) => group.projectId)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.epics[0]?.sessions.map((session) => session.run.id)).toEqual(["alpha-run"]);
    expect(groups[1]?.epics[0]?.sessions.map((session) => session.run.id)).toEqual(["beta-run"]);
  });

  it("includes an empty project with no epic buckets", () => {
    const alpha = project("alpha", "Alpha");
    const groups = groupSessionsByProject([], [{ path: "alpha.crystal", project: alpha }]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ projectId: "alpha", name: "Alpha", epics: [] });
  });

  it("includes configured epics with zero sessions", () => {
    const board = project("alpha", "Alpha", {
      epics: [
        { id: "active", name: "Active", description: "" },
        { id: "empty", name: "Empty", description: "" },
      ],
    });
    const [group] = groupSessionsByProject(
      [run("active-run", { projectId: "alpha", tags: ["epic:active"] })],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(group?.epics.map((epic) => epic.epicId)).toEqual(["active", "empty"]);
    expect(group?.epics[1]?.sessions).toEqual([]);
  });

  it("omits empty No epic and Unassigned residue buckets", () => {
    const board = project("alpha", "Alpha", {
      epics: [{ id: "assigned", name: "Assigned", description: "" }],
    });
    const groups = groupSessionsByProject(
      [run("assigned-run", { projectId: "alpha", tags: ["epic:assigned"] })],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(groups.map((group) => group.name)).toEqual(["Alpha"]);
    expect(groups[0]?.epics.map((epic) => epic.name)).toEqual(["Assigned"]);
  });

  it("resolves an epic through the run's task before its epic tag", () => {
    const board = project("alpha", "Alpha", {
      epics: [
        { id: "task-epic", name: "Task epic", description: "" },
        { id: "tag-epic", name: "Tag epic", description: "" },
      ],
      tasks: [
        TaskItemSchema.parse({
          id: "task-1",
          title: "Task",
          epicId: "task-epic",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ],
    });
    const [group] = groupSessionsByProject(
      [run("task-run", { projectId: "alpha", taskId: "task-1", tags: ["epic:tag-epic"] })],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(group?.epics.map((epic) => epic.epicId)).toEqual(["task-epic", "tag-epic"]);
    expect(group?.epics[0]?.sessions.map((session) => session.run.id)).toEqual(["task-run"]);
    expect(group?.epics[1]?.sessions).toEqual([]);
  });

  it("falls back to an epic dimensional tag", () => {
    const board = project("alpha", "Alpha", {
      epics: [{ id: "tag-epic", name: "Tagged", description: "" }],
    });
    const [group] = groupSessionsByProject(
      [run("tagged-run", { projectId: "alpha", tags: ["area:server", "epic:tag-epic"] })],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(group?.epics[0]?.epicId).toBe("tag-epic");
  });

  it("puts unknown or absent projects in a trailing Unassigned bucket", () => {
    const board = project("alpha", "Alpha");
    const groups = groupSessionsByProject(
      [
        run("known", { projectId: "alpha" }),
        run("missing-project", { projectId: "removed" }),
        run("no-project"),
      ],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(groups.map((group) => group.name)).toEqual(["Alpha", "Unassigned"]);
    expect(groups[1]?.epics[0]?.sessions.map((session) => session.run.id)).toEqual([
      "missing-project",
      "no-project",
    ]);
  });

  it("puts sessions without a resolvable epic in a trailing No epic bucket", () => {
    const board = project("alpha", "Alpha", {
      epics: [{ id: "real", name: "Real epic", description: "" }],
    });
    const [group] = groupSessionsByProject(
      [
        run("no-epic", { projectId: "alpha" }),
        run("has-epic", { projectId: "alpha", tags: ["epic:real"] }),
      ],
      [{ path: "alpha.crystal", project: board }],
    );

    expect(group?.epics.map((epic) => epic.name)).toEqual(["Real epic", "No epic"]);
  });

  it("keeps nested workers out of the rail and rolls their live status into the root", () => {
    const board = project("alpha", "Alpha");
    const groups = groupSessionsByProject(
      [
        run("manager", { projectId: "alpha", role: "manager", status: "completed" }),
        run("worker", {
          projectId: "alpha",
          parentRunId: "manager",
          role: "worker",
          status: "running",
        }),
      ],
      [{ path: "alpha.crystal", project: board }],
    );
    const sessions = groups[0]?.epics[0]?.sessions ?? [];

    expect(sessions.map((session) => session.run.id)).toEqual(["manager"]);
    expect(sessions[0]?.workers.map((worker) => worker.run.id)).toEqual(["worker"]);
    expect(sessionIsWorking(sessions[0]!)).toBe(true);
  });

  it("sorts sessions by newest subtree activity", () => {
    const board = project("alpha", "Alpha");
    const [group] = groupSessionsByProject(
      [
        run("older", { projectId: "alpha", createdAt: "2026-01-01T00:00:00Z" }),
        run("manager", { projectId: "alpha", createdAt: "2026-01-02T00:00:00Z" }),
        run("fresh-worker", {
          projectId: "alpha",
          parentRunId: "manager",
          createdAt: "2026-01-04T00:00:00Z",
        }),
        run("middle", { projectId: "alpha", createdAt: "2026-01-03T00:00:00Z" }),
      ],
      [{ path: "alpha.crystal", project: board }],
    );
    expect(group?.epics[0]?.sessions.map((node) => node.run.id)).toEqual([
      "manager",
      "middle",
      "older",
    ]);
  });
});

describe("session filtering", () => {
  const nameOf = (candidate: AgentRun) => candidate.agentId === "reviewer" ? "Code Reviewer" : null;

  it("matches headline and rich run metadata case-insensitively", () => {
    const [node] = groupSessionsByProject([
      run("root", { prompt: "Repair Search", agentId: "reviewer", model: "sonnet", branch: "fix/rail", purpose: "code-review" }),
    ], []).at(-1)?.epics[0]?.sessions ?? [];
    expect(sessionNodeMatchesFilter(node!, "SEARCH", nameOf)).toBe(true);
    expect(sessionNodeMatchesFilter(node!, "code reviewer", nameOf)).toBe(true);
    expect(sessionNodeMatchesFilter(node!, "fix/rail", nameOf)).toBe(true);
    expect(sessionNodeMatchesFilter(node!, "missing", nameOf)).toBe(false);
  });

  it("matches the displayed workflow worker title instead of raw boilerplate", () => {
    const [node] = groupSessionsByProject([
      run("worker", {
        prompt: "You are the PLAN-stage worker for workflow boilerplate",
        purpose: "plan",
        tags: ["workflow:wf-1"],
      }),
    ], []).at(-1)?.epics[0]?.sessions ?? [];
    const naming = { workflowNameOf: (id: string) => id === "wf-1" ? "Checkout launch" : null };

    expect(sessionNodeMatchesFilter(node!, "plan — checkout launch", nameOf, naming)).toBe(true);
    expect(sessionNodeMatchesFilter(node!, "workflow boilerplate", nameOf, naming)).toBe(false);
  });

  it("keeps ancestors while pruning nonmatching sibling workers", () => {
    const groups = groupSessionsByProject([
      run("manager"),
      run("match", { parentRunId: "manager", prompt: "Needle worker" }),
      run("other", { parentRunId: "manager", prompt: "Other worker" }),
    ], []);
    const root = groups[0]!.epics[0]!.sessions[0]!;
    const filtered = filterSessionTree(root, "needle", nameOf);
    expect(filtered?.run.id).toBe("manager");
    expect(filtered?.workers.map((node) => node.run.id)).toEqual(["match"]);
  });

  it("keeps a directly matching root's whole subtree", () => {
    const groups = groupSessionsByProject([
      run("manager", { prompt: "Needle root" }),
      run("worker", { parentRunId: "manager" }),
    ], []);
    const root = groups[0]!.epics[0]!.sessions[0]!;
    expect(filterSessionTree(root, "needle", nameOf)?.workers).toHaveLength(1);
  });
});

import {
  AgentRunSchema,
  ProjectSchema,
  TaskItemSchema,
  type AgentRun,
  type Project,
} from "@crystal/core";
import { describe, expect, it } from "vitest";
import { groupSessionsByProject, sessionStatus } from "./session-groups.js";

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

    expect(group?.epics.map((epic) => epic.epicId)).toEqual(["task-epic"]);
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
    expect(sessionStatus(sessions[0]!)).toBe("working");
  });
});

import {
  groupRunsByManager,
  tagsInDimension,
  type AgentRun,
  type Epic,
  type Project,
  type RunNode,
  type WorkspaceInfo,
} from "@crystal/core";

export type SessionStatus = "working" | "idle";

/** One epic section in a project's sessions rail; null is the trailing residue. */
export interface SessionEpicGroup {
  epicId: string | null;
  name: string;
  epic: Epic | null;
  sessions: RunNode[];
}

/** One project section in the sessions rail; null is the trailing Unassigned bucket. */
export interface SessionProjectGroup {
  projectId: string | null;
  name: string;
  projectPath: string | null;
  project: Project | null;
  epics: SessionEpicGroup[];
}

type WorkspaceProject = WorkspaceInfo["projects"][number];

/**
 * A session is working while any turn represented by its face or any nested
 * worker session is queued/running. Workers are recursive because managers
 * may delegate to managers of their own.
 */
export function sessionStatus(session: RunNode): SessionStatus {
  if (session.run.status === "running" || session.run.status === "queued") return "working";
  return session.workers.some((worker) => sessionStatus(worker) === "working")
    ? "working"
    : "idle";
}

function epicForSession(session: RunNode, project: Project): Epic | null {
  const task = session.run.taskId
    ? project.tasks.find((candidate) => candidate.id === session.run.taskId)
    : null;
  const taskEpic = task?.epicId
    ? project.epics.find((candidate) => candidate.id === task.epicId)
    : null;
  if (taskEpic) return taskEpic;

  const taggedEpicIds = tagsInDimension(session.run.tags, "epic");
  return project.epics.find((epic) => taggedEpicIds.includes(epic.id)) ?? null;
}

function groupProjectSessions(
  source: WorkspaceProject | null,
  sessions: RunNode[],
): SessionProjectGroup {
  const project = source?.project ?? null;
  const byEpic = new Map<string, RunNode[]>();
  const noEpic: RunNode[] = [];

  for (const session of sessions) {
    const epic = project ? epicForSession(session, project) : null;
    if (!epic) {
      noEpic.push(session);
      continue;
    }
    const bucket = byEpic.get(epic.id);
    if (bucket) bucket.push(session);
    else byEpic.set(epic.id, [session]);
  }

  const epics: SessionEpicGroup[] = project
    ? project.epics.map((epic) => ({
        epicId: epic.id,
        name: epic.name,
        epic,
        sessions: byEpic.get(epic.id) ?? [],
      }))
    : [];
  if (noEpic.length) {
    epics.push({ epicId: null, name: "No epic", epic: null, sessions: noEpic });
  }

  return {
    projectId: project?.id ?? null,
    name: project?.name ?? "Unassigned",
    projectPath: source?.path ?? null,
    project,
    epics,
  };
}

/**
 * Collapse a workspace's flat run history into root sessions, then group the
 * rail by project and epic. Every configured project and epic is represented
 * in source order, even when empty; Unassigned/No epic residues trail and are
 * included only when they contain sessions.
 */
export function groupSessionsByProject(
  runs: readonly AgentRun[],
  projects: readonly WorkspaceProject[],
): SessionProjectGroup[] {
  const roots = groupRunsByManager([...runs]);
  const sourceById = new Map(projects.map((source) => [source.project.id, source]));
  const sessionsByProject = new Map<string, RunNode[]>();
  const unassigned: RunNode[] = [];

  for (const session of roots) {
    const source = session.run.projectId ? sourceById.get(session.run.projectId) : undefined;
    if (!source) {
      unassigned.push(session);
      continue;
    }
    const bucket = sessionsByProject.get(source.project.id);
    if (bucket) bucket.push(session);
    else sessionsByProject.set(source.project.id, [session]);
  }

  const grouped = projects.map((source) =>
    groupProjectSessions(source, sessionsByProject.get(source.project.id) ?? []),
  );
  if (unassigned.length) grouped.push(groupProjectSessions(null, unassigned));
  return grouped;
}

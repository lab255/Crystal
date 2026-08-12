import { useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { RunNode } from "@crystal/core";
import { Button, StatusDot, cn } from "@crystal/ui";
import { runHeadline } from "./RunList.js";
import {
  sessionStatus,
  type SessionEpicGroup,
  type SessionProjectGroup,
} from "./session-groups.js";

export interface NewSessionScope {
  projectId: string | null;
  epicId: string | null;
}

export interface SessionGroupListProps {
  /** Project/epic groups derived by groupSessionsByProject outside this component. */
  sessions: readonly SessionProjectGroup[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onNewSession: (scope: NewSessionScope) => void;
}

function toggleKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function projectKey(project: SessionProjectGroup): string {
  return project.projectId ?? "__unassigned__";
}

function epicKey(project: SessionProjectGroup, epic: SessionEpicGroup): string {
  return `${projectKey(project)}/${epic.epicId ?? "__no_epic__"}`;
}

function sessionCount(project: SessionProjectGroup): number {
  return project.epics.reduce((count, epic) => count + epic.sessions.length, 0);
}

/** Collapsible project/epic rail for root agent sessions. */
export function SessionGroupList({
  sessions,
  selectedRunId,
  onSelect,
  onNewSession,
}: SessionGroupListProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedEpics, setCollapsedEpics] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  return (
    <aside
      aria-label="Sessions"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-edge bg-surface-1"
    >
      {sessions.map((project) => {
        const key = projectKey(project);
        const collapsed = collapsedProjects.has(key);
        return (
          <section key={key} className="border-b border-edge/70 last:border-b-0">
            <div className="flex items-center gap-1 px-1.5 py-1.5">
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => setCollapsedProjects((current) => toggleKey(current, key))}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                  {project.name}
                </span>
                <span className="text-[10px] tabular-nums text-ink-faint">
                  {sessionCount(project)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`New session in ${project.name}`}
                title={`New session in ${project.name}`}
                onClick={() =>
                  onNewSession({ projectId: project.projectId, epicId: null })
                }
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            {collapsed ? null : (
              <div className="pb-1.5">
                {project.epics.map((epic) => (
                  <EpicSection
                    key={epicKey(project, epic)}
                    project={project}
                    epic={epic}
                    collapsed={collapsedEpics.has(epicKey(project, epic))}
                    onToggle={() => {
                      const key = epicKey(project, epic);
                      setCollapsedEpics((current) => toggleKey(current, key));
                    }}
                    selectedRunId={selectedRunId}
                    onSelect={onSelect}
                    onNewSession={onNewSession}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}

function EpicSection({
  project,
  epic,
  collapsed,
  onToggle,
  selectedRunId,
  onSelect,
  onNewSession,
}: {
  project: SessionProjectGroup;
  epic: SessionEpicGroup;
  collapsed: boolean;
  onToggle: () => void;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onNewSession: (scope: NewSessionScope) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-1 pl-4 pr-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-surface-2"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-muted">
            {epic.name}
          </span>
          <span className="text-[10px] tabular-nums text-ink-faint">
            {epic.sessions.length}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`New session in ${epic.name}`}
          title={`New session in ${epic.name}`}
          onClick={() =>
            onNewSession({ projectId: project.projectId, epicId: epic.epicId })
          }
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {collapsed ? null : (
        <div className="space-y-1 px-1.5 pb-1 pl-6">
          {epic.sessions.map((session) => (
            <SessionCard
              key={session.run.id}
              session={session}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionCard({
  session,
  selectedRunId,
  onSelect,
}: {
  session: RunNode;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const status = sessionStatus(session);
  const selected =
    selectedRunId != null && session.turns.some((turn) => turn.id === selectedRunId);
  const headline = runHeadline(session.run.prompt) || "Session";

  return (
    <button
      type="button"
      onClick={() => onSelect(session.run.id)}
      className={cn(
        "w-full rounded-lg px-2 py-1.5 text-left transition-colors",
        selected ? "bg-crystal-500/15" : "hover:bg-surface-2",
      )}
    >
      <span className="block truncate text-xs text-ink">{headline}</span>
      <span className="mt-0.5 flex items-center gap-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-ink-faint">
          {session.run.id}
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1",
            status === "working" ? "text-ink" : "text-ink-faint",
          )}
        >
          <StatusDot status={status === "working" ? "running" : "idle"} />
          {status === "working" ? "Working" : "Idle"}
        </span>
      </span>
    </button>
  );
}

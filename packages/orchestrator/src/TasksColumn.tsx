import { useEffect, useMemo, useState } from "react";
import { CircleHelp, Lock, Plus, TriangleAlert } from "lucide-react";
import {
  TASK_LIST_GROUP_LABELS,
  createTask,
  groupTasksForList,
  groupRunsByManager,
  headline,
  isQuestionActionable,
  livenessIndex,
  matchAgent,
  openQuestions,
  tasksInColumn,
  type Project,
  type TaskAttention,
  type TaskItem,
  type TaskListGroupId,
  formatWaitedFor,
} from "@crystal/core";
import { useAgents, useWorkspace } from "@crystal/client";
import { Button, cn } from "@crystal/ui";

/**
 * The grouped task list — the left column of the list+session working view
 * (operator's TasksColumn, on Crystal's board model). "Needs your input" is
 * pinned first (longest-waiting first) and a task in it leaves its status
 * group entirely; the dot shows attention over running over idle. Selection
 * is caller-owned (nav store); the session pane beside this follows it.
 */
export function TasksColumn({
  project,
  selectedTaskId,
  onSelectTask,
  onProjectChange,
}: {
  project: Project;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onProjectChange: (project: Project) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const roster = useWorkspace((s) => s.roster);
  const [doneOpen, setDoneOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  // "waiting 3m" labels age in place — a slow tick, not per-event renders.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const groups = useMemo(() => groupTasksForList(project, runs), [project, runs]);
  const runsById = useMemo(() => livenessIndex(runs), [runs]);
  const liveTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of runs) {
      if (r.taskId && (r.status === "running" || r.status === "queued")) ids.add(r.taskId);
    }
    return ids;
  }, [runs]);
  const sessionCounts = useMemo(() => {
    const byTask = new Map<string, typeof runs>();
    for (const run of runs) {
      if (!run.taskId) continue;
      const taskRuns = byTask.get(run.taskId);
      if (taskRuns) taskRuns.push(run);
      else byTask.set(run.taskId, [run]);
    }
    const counts = new Map<string, number>();
    for (const [taskId, taskRuns] of byTask) {
      counts.set(taskId, groupRunsByManager(taskRuns).length);
    }
    return counts;
  }, [runs]);

  function addTask(title: string): void {
    const task = createTask(title);
    task.order = Math.max(0, ...tasksInColumn(project, "backlog").map((t) => t.order)) + 1;
    // Same birth convention as the kanban: tag-matched agent + default human.
    if (roster) {
      task.owners = {
        agentId: matchAgent(task.labels, roster)?.id ?? null,
        human: roster.defaultHuman || null,
      };
    }
    onProjectChange({ ...project, tasks: [...project.tasks, task] });
    onSelectTask(task.id);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2.5 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Tasks
        </span>
        <span className="text-[10px] text-ink-faint">{project.tasks.length}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="New task"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {adding ? (
        <div className="shrink-0 border-b border-edge p-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                addTask(draft.trim());
                setDraft("");
                setAdding(false);
              } else if (e.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            placeholder="Task title — Enter creates, Esc cancels"
            aria-label="New task title"
            className="h-8 w-full rounded-lg border border-edge bg-surface-2 px-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-crystal-500/60 focus:outline-none"
          />
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.map((group) => {
          if (group.tasks.length === 0) return null;
          const collapsed = group.id === "done" && !doneOpen;
          return (
            <section key={group.id}>
              <GroupHeader
                id={group.id}
                count={group.tasks.length}
                collapsible={group.id === "done"}
                collapsed={collapsed}
                onToggle={() => setDoneOpen((v) => !v)}
              />
              {collapsed
                ? null
                : group.tasks.map((task, i) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      group={group.id}
                      attention={group.attention?.[i] ?? null}
                      live={liveTaskIds.has(task.id)}
                      runsById={runsById}
                      sessionCount={sessionCounts.get(task.id) ?? 0}
                      project={project}
                      selected={task.id === selectedTaskId}
                      onSelect={() => onSelectTask(task.id)}
                    />
                  ))}
            </section>
          );
        })}
        {project.tasks.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-ink-faint">
            No tasks yet — add one above, or promote a todo from the overview.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function GroupHeader({
  id,
  count,
  collapsible,
  collapsed,
  onToggle,
}: {
  id: TaskListGroupId;
  count: number;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const attention = id === "attention";
  const label = (
    <>
      <span
        className={cn(
          "text-[10px] font-semibold uppercase tracking-wider",
          attention ? "text-warn" : "text-ink-faint",
        )}
      >
        {TASK_LIST_GROUP_LABELS[id]}
      </span>
      <span className={cn("text-[10px]", attention ? "text-warn/80" : "text-ink-faint")}>
        {count}
      </span>
      {collapsible ? (
        <span className="ml-auto text-[10px] text-ink-faint">{collapsed ? "show" : "hide"}</span>
      ) : null}
    </>
  );
  const classes = cn(
    "flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left",
    attention && "border-l-2 border-warn/60",
  );
  return collapsible ? (
    <button type="button" onClick={onToggle} className={classes} aria-expanded={!collapsed}>
      {label}
    </button>
  ) : (
    <div className={classes}>{label}</div>
  );
}

function TaskRow({
  task,
  group,
  attention,
  live,
  runsById,
  sessionCount,
  project,
  selected,
  onSelect,
}: {
  task: TaskItem;
  group: TaskListGroupId;
  attention: TaskAttention | null;
  live: boolean;
  runsById: ReturnType<typeof livenessIndex>;
  sessionCount: number;
  project: Project;
  selected: boolean;
  onSelect: () => void;
}) {
  const questionCount = openQuestions(task).filter((question) =>
    isQuestionActionable(question, runsById),
  ).length;
  const blockers =
    group === "blocked"
      ? task.blockedBy
          .map((id) => project.tasks.find((candidate) => candidate.id === id))
          .filter(
            (candidate): candidate is TaskItem =>
              candidate != null && candidate.status !== "done",
          )
      : [];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
        selected ? "bg-surface-3" : "hover:bg-surface-2",
        attention && "border-l-2 border-warn/60",
      )}
    >
      {/* Attention beats running beats idle — coral "waiting on you" wins
          even while the asking turn is technically live. */}
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          attention
            ? "bg-warn animate-pulse"
            : live
              ? "bg-info animate-pulse"
              : task.status === "done"
                ? "bg-ok"
                : "bg-ink-faint",
        )}
        aria-label={attention ? "needs your input" : live ? "agent working" : task.status}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12px]",
          task.status === "done" ? "text-ink-muted" : "text-ink",
        )}
      >
        {task.title}
      </span>
      {attention ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] text-warn"
          title={
            attention.kinds.includes("failure")
              ? "A run failed recoverably — recover it from the session"
              : "An agent question is waiting on you"
          }
        >
          {attention.kinds.includes("failure") ? (
            <TriangleAlert className="h-3 w-3" />
          ) : (
            <CircleHelp className="h-3 w-3" />
          )}
          waiting {formatWaitedFor(attention.waitingSince)}
        </span>
      ) : questionCount > 0 ? (
        <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-ink-faint">
          <CircleHelp className="h-3 w-3" /> {questionCount}
        </span>
      ) : null}
      {group === "blocked" ? (
        <Lock className="h-3 w-3 shrink-0 text-ink-faint" aria-label="blocked" />
      ) : null}
      {blockers.length > 0 ? (
        <span className="shrink-0 text-[10px] text-ink-faint">
          blocked by {headline(blockers[0]!.title, 24)}
          {blockers.length > 1 ? ` +${blockers.length - 1}` : ""}
        </span>
      ) : null}
      {sessionCount > 1 ? (
        <span className="shrink-0 text-[10px] text-ink-faint">{sessionCount} sessions</span>
      ) : null}
      {live && !attention ? (
        <span className="shrink-0 text-[10px] text-info">working</span>
      ) : null}
    </button>
  );
}

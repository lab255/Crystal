import { useMemo, useState, type DragEvent } from "react";
import { Bot, CircleHelp, Plus, UserRound } from "lucide-react";
import {
  PRIORITY_RANK,
  TASK_SIZE_POINTS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  createEpic,
  createTask,
  matchAgent,
  nowIso,
  openQuestions,
  tagDimension,
  tagDimensions,
  tagsInDimension,
  tasksInColumn,
  usageTotalTokens,
  type AgentRoster,
  type Project,
  type TaskItem,
  type TaskStatus,
} from "@crystal/core";
import { useAgents, useNav, useNavUpdate, useWorkspace } from "@crystal/client";
import { Badge, StatusDot, cn } from "@crystal/ui";
import { formatCost, formatTokens } from "./prompt.js";

const TASK_MIME = "application/crystal-task-id";

const PRIORITY_TONES = {
  low: "slate",
  medium: "blue",
  high: "amber",
  urgent: "rose",
} as const;

const COLUMN_ACCENTS: Record<TaskStatus, string> = {
  backlog: "var(--color-accent-slate)",
  in_progress: "var(--color-accent-blue)",
  review: "var(--color-accent-amber)",
  done: "var(--color-accent-emerald)",
};

/** "status" | "epic" | "tag:<dimension>" — mirrors the deep-link `group` param. */
type BoardGroup = string;
/** "manual" | "priority" | "size" | "tokens" | "cost" — deep-link `sort` param. */
type BoardSort = string;

const SORT_OPTIONS: { value: BoardSort; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "priority", label: "Priority" },
  { value: "size", label: "Size" },
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
];

interface ColumnDef {
  key: string;
  label: string;
  accent: string;
}

export function Board({
  project,
  selectedTaskId,
  onProjectChange,
  onSelectTask,
}: {
  project: Project;
  selectedTaskId: string | null;
  onProjectChange: (project: Project) => void;
  onSelectTask: (taskId: string | null) => void;
}) {
  const runs = useAgents((s) => s.runs);
  const roster = useWorkspace((s) => s.roster);
  const nav = useNavUpdate();
  const group: BoardGroup = useNav((l) => l.orchestrate?.group) ?? "status";
  const sort: BoardSort = useNav((l) => l.orchestrate?.sort) ?? "manual";
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [epicDraft, setEpicDraft] = useState<string | null>(null);

  // Every run touching a task bills it — implement, review, merge, CI alike.
  const usageByTask = useMemo(() => {
    const map = new Map<string, { tokens: number; costUsd: number }>();
    for (const run of runs) {
      if (!run.taskId) continue;
      const cur = map.get(run.taskId) ?? { tokens: 0, costUsd: 0 };
      cur.tokens += usageTotalTokens(run.usage);
      cur.costUsd += run.costUsd ?? 0;
      map.set(run.taskId, cur);
    }
    return map;
  }, [runs]);

  const dimensions = useMemo(
    () => tagDimensions(project.tasks.flatMap((t) => t.labels)),
    [project.tasks],
  );

  const columns: ColumnDef[] =
    group === "epic"
      ? [
          ...project.epics.map((e) => ({
            key: e.id,
            label: e.name,
            accent: "var(--color-accent-violet)",
          })),
          { key: "", label: "No epic", accent: "var(--color-accent-slate)" },
        ]
      : group.startsWith("tag:")
        ? [
            ...[...new Set(
              project.tasks.flatMap((t) => tagsInDimension(t.labels, group.slice(4))),
            )]
              .sort()
              .map((v) => ({
                key: v,
                label: v,
                accent: "var(--color-accent-cyan)",
              })),
            { key: "", label: "untagged", accent: "var(--color-accent-slate)" },
          ]
        : TASK_STATUSES.map((s) => ({
            key: s,
            label: TASK_STATUS_LABELS[s],
            accent: COLUMN_ACCENTS[s],
          }));

  function tasksInGroup(key: string): TaskItem[] {
    let tasks: TaskItem[];
    if (group === "epic") {
      tasks = project.tasks.filter((t) => (t.epicId ?? "") === key);
    } else if (group.startsWith("tag:")) {
      const dim = group.slice(4);
      tasks = project.tasks.filter((t) => {
        const values = tagsInDimension(t.labels, dim);
        return key === "" ? values.length === 0 : values.includes(key);
      });
    } else {
      tasks = tasksInColumn(project, key as TaskStatus);
    }
    return sortTasks(tasks, sort, usageByTask);
  }

  /** Dropping a card re-homes it along the active grouping axis. */
  function dropTask(taskId: string, columnKey: string): void {
    const patchTask = (patch: Partial<TaskItem>) =>
      onProjectChange({
        ...project,
        tasks: project.tasks.map((t) =>
          t.id === taskId ? { ...t, ...patch, updatedAt: nowIso() } : t,
        ),
      });
    if (group === "epic") {
      patchTask({ epicId: columnKey || null });
    } else if (group.startsWith("tag:")) {
      const dim = group.slice(4);
      const task = project.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const kept = task.labels.filter((l) => tagDimension(l) !== dim);
      patchTask({ labels: columnKey ? [...kept, `${dim}:${columnKey}`] : kept });
    } else {
      const status = columnKey as TaskStatus;
      const maxOrder = Math.max(0, ...tasksInColumn(project, status).map((t) => t.order));
      patchTask({ status, order: maxOrder + 1 });
    }
  }

  function addTask(status: TaskStatus, title: string): void {
    const task = createTask(title, status);
    task.order = Math.max(0, ...tasksInColumn(project, status).map((t) => t.order)) + 1;
    // Every task is owned by an agent and a human from birth: tag-matched
    // specialist (or the default generic agent) + the roster's default human.
    if (roster) {
      task.owners = {
        agentId: matchAgent(task.labels, roster)?.id ?? null,
        human: roster.defaultHuman || null,
      };
    }
    onProjectChange({ ...project, tasks: [...project.tasks, task] });
    onSelectTask(task.id);
  }

  function addEpic(name: string): void {
    onProjectChange({ ...project, epics: [...project.epics, createEpic(name)] });
  }

  const running = new Set(
    runs.filter((r) => r.status === "running" && r.taskId).map((r) => r.taskId as string),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          Group
          <select
            className="h-6 rounded-md border border-edge bg-surface-1 px-1.5 text-[11px] text-ink focus:border-crystal-500/60 focus:outline-none"
            value={group}
            onChange={(e) => nav({ orchestrate: { group: e.target.value } })}
            aria-label="Group tasks by"
          >
            <option value="status">Status</option>
            <option value="epic">Epic</option>
            {dimensions.map((d) => (
              <option key={d} value={`tag:${d}`}>
                Tag: {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          Sort
          <select
            className="h-6 rounded-md border border-edge bg-surface-1 px-1.5 text-[11px] text-ink focus:border-crystal-500/60 focus:outline-none"
            value={sort}
            onChange={(e) => nav({ orchestrate: { sort: e.target.value } })}
            aria-label="Sort tasks by"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {group === "epic" ? (
          epicDraft === null ? (
            <button
              type="button"
              onClick={() => setEpicDraft("")}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
            >
              <Plus className="h-3 w-3" /> Epic
            </button>
          ) : (
            <input
              autoFocus
              value={epicDraft}
              onChange={(e) => setEpicDraft(e.target.value)}
              onBlur={() => {
                if (epicDraft.trim()) addEpic(epicDraft.trim());
                setEpicDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") setEpicDraft(null);
              }}
              placeholder="Epic name…"
              className="h-6 w-40 rounded-md border border-crystal-500/40 bg-surface-1 px-1.5 text-[11px] text-ink outline-none placeholder:text-ink-faint"
            />
          )
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) => {
          const tasks = tasksInGroup(column.key);
          return (
            <div
              key={`${group}:${column.key}`}
              className={cn(
                "flex h-full w-64 shrink-0 flex-col rounded-xl border bg-surface-1/60 transition-colors",
                dragOver === column.key
                  ? "border-crystal-500/50 bg-crystal-500/5"
                  : "border-edge",
              )}
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                setDragOver(column.key);
              }}
              onDragLeave={() => setDragOver((s) => (s === column.key ? null : s))}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData(TASK_MIME);
                if (id) dropTask(id, column.key);
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="h-2 w-2 rounded-full" style={{ background: column.accent }} />
                <span className="truncate text-xs font-semibold text-ink">{column.label}</span>
                <span className="text-[11px] text-ink-faint">{tasks.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    roster={roster}
                    usage={usageByTask.get(task.id) ?? null}
                    selected={task.id === selectedTaskId}
                    agentRunning={running.has(task.id)}
                    onClick={() => onSelectTask(task.id)}
                  />
                ))}
                {group === "status" ? (
                  <AddTask onAdd={(title) => addTask(column.key as TaskStatus, title)} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function sortTasks(
  tasks: TaskItem[],
  sort: BoardSort,
  usage: Map<string, { tokens: number; costUsd: number }>,
): TaskItem[] {
  if (sort === "manual") return tasks;
  const metric = (t: TaskItem): number => {
    switch (sort) {
      case "priority":
        return PRIORITY_RANK[t.priority];
      case "size":
        return t.size ? TASK_SIZE_POINTS[t.size] : 0;
      case "tokens":
        return usage.get(t.id)?.tokens ?? 0;
      case "cost":
        return usage.get(t.id)?.costUsd ?? 0;
      default:
        return 0;
    }
  };
  return [...tasks].sort(
    (a, b) => metric(b) - metric(a) || a.order - b.order || b.updatedAt.localeCompare(a.updatedAt),
  );
}

function TaskCard({
  task,
  roster,
  usage,
  selected,
  agentRunning,
  onClick,
}: {
  task: TaskItem;
  roster: AgentRoster | null;
  usage: { tokens: number; costUsd: number } | null;
  selected: boolean;
  agentRunning: boolean;
  onClick: () => void;
}) {
  const agent = roster?.agents.find((a) => a.id === task.owners.agentId) ?? null;
  const questions = openQuestions(task).length;
  const unowned = !task.owners.agentId || !task.owners.human;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_MIME, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-lg border bg-surface-2 p-2.5 shadow-sm transition-colors",
        selected
          ? "border-crystal-400/70 ring-1 ring-crystal-400/30"
          : "border-edge hover:border-edge-strong",
      )}
    >
      <div className="text-[13px] font-medium leading-snug text-ink">{task.title}</div>
      {task.description ? (
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-muted">
          {task.description}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-1.5">
        <Badge tone={PRIORITY_TONES[task.priority]}>{task.priority}</Badge>
        {task.size ? <Badge>{task.size}</Badge> : null}
        {task.labels.slice(0, 2).map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          {questions > 0 ? (
            <span className="flex items-center gap-0.5 text-[10px] text-warn">
              <CircleHelp className="h-3 w-3" /> {questions}
            </span>
          ) : null}
          {agentRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-info">
              <StatusDot status="running" /> agent
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-faint">
        <span
          className={cn("flex min-w-0 items-center gap-1", unowned && "text-warn")}
          title={unowned ? "Every task needs an agent and a human owner" : undefined}
        >
          <Bot className="h-3 w-3 shrink-0" />
          <span className="truncate">{agent?.name ?? "unassigned"}</span>
          <UserRound className="ml-1 h-3 w-3 shrink-0" />
          <span className="truncate">{task.owners.human || "unassigned"}</span>
        </span>
        {usage && (usage.tokens > 0 || usage.costUsd > 0) ? (
          <span className="ml-auto shrink-0">
            {formatTokens(usage.tokens)} · {formatCost(usage.costUsd)}
          </span>
        ) : task.runIds.length > 0 ? (
          <span className="ml-auto shrink-0">
            {task.runIds.length} run{task.runIds.length > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
      >
        <Plus className="h-3.5 w-3.5" /> Add task
      </button>
    );
  }

  const submit = () => {
    if (title.trim()) onAdd(title.trim());
    setTitle("");
    setEditing(false);
  };

  return (
    <textarea
      autoFocus
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          setTitle("");
          setEditing(false);
        }
      }}
      placeholder="Task title…"
      rows={2}
      className="w-full resize-none rounded-lg border border-crystal-500/40 bg-surface-2 p-2 text-[13px] text-ink outline-none placeholder:text-ink-faint"
    />
  );
}

import { useState, type DragEvent } from "react";
import { Plus } from "lucide-react";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  createTask,
  tasksInColumn,
  nowIso,
  type Project,
  type TaskItem,
  type TaskStatus,
} from "@crystal/core";
import { useAgents } from "@crystal/client";
import { Badge, StatusDot, cn } from "@crystal/ui";

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
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  function moveTask(taskId: string, status: TaskStatus): void {
    const maxOrder = Math.max(0, ...tasksInColumn(project, status).map((t) => t.order));
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) =>
        t.id === taskId ? { ...t, status, order: maxOrder + 1, updatedAt: nowIso() } : t,
      ),
    });
  }

  function addTask(status: TaskStatus, title: string): void {
    const task = createTask(title, status);
    task.order = Math.max(0, ...tasksInColumn(project, status).map((t) => t.order)) + 1;
    onProjectChange({ ...project, tasks: [...project.tasks, task] });
    onSelectTask(task.id);
  }

  function runningTaskIds(): Set<string> {
    return new Set(
      runs.filter((r) => r.status === "running" && r.taskId).map((r) => r.taskId as string),
    );
  }
  const running = runningTaskIds();

  return (
    <div className="flex h-full min-h-0 gap-3 overflow-x-auto p-3">
      {TASK_STATUSES.map((status) => {
        const tasks = tasksInColumn(project, status);
        return (
          <div
            key={status}
            className={cn(
              "flex h-full w-64 shrink-0 flex-col rounded-xl border bg-surface-1/60 transition-colors",
              dragOver === status ? "border-crystal-500/50 bg-crystal-500/5" : "border-edge",
            )}
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              setDragOver(status);
            }}
            onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              setDragOver(null);
              const id = e.dataTransfer.getData(TASK_MIME);
              if (id) moveTask(id, status);
            }}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: COLUMN_ACCENTS[status] }}
              />
              <span className="text-xs font-semibold text-ink">{TASK_STATUS_LABELS[status]}</span>
              <span className="text-[11px] text-ink-faint">{tasks.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  agentRunning={running.has(task.id)}
                  onClick={() => onSelectTask(task.id)}
                />
              ))}
              <AddTask onAdd={(title) => addTask(status, title)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  selected,
  agentRunning,
  onClick,
}: {
  task: TaskItem;
  selected: boolean;
  agentRunning: boolean;
  onClick: () => void;
}) {
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
        {task.labels.slice(0, 2).map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          {agentRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-info">
              <StatusDot status="running" /> agent
            </span>
          ) : task.runIds.length > 0 ? (
            <span className="text-[10px] text-ink-faint">
              {task.runIds.length} run{task.runIds.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </span>
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

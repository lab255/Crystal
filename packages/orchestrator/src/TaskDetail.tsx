import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Play, Trash2, X } from "lucide-react";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  nowIso,
  type Project,
  type TaskItem,
  type TaskPriority,
  type TaskStatus,
} from "@crystal/core";
import { useAgents, useWorkspace } from "@crystal/client";
import { Badge, Button, Input, StatusDot, Textarea, cn } from "@crystal/ui";
import { buildTaskPrompt, formatCost } from "./prompt.js";

const selectClasses =
  "w-full h-8 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink " +
  "focus:border-crystal-500/60 focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </div>
      {children}
    </div>
  );
}

export function TaskDetail({
  project,
  projectPath,
  task,
  onProjectChange,
  onClose,
  onOpenRun,
}: {
  project: Project;
  projectPath: string;
  task: TaskItem;
  onProjectChange: (project: Project) => void;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const info = useWorkspace((s) => s.info);
  const runs = useAgents((s) => s.runs);
  const startRun = useAgents((s) => s.start);

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [cwd, setCwd] = useState(".");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description);
    setPromptDirty(false);
  }, [task.id]);

  const defaultPrompt = useMemo(() => buildTaskPrompt(task, info), [task, info]);
  const effectivePrompt = promptDirty ? prompt : defaultPrompt;

  const taskRuns = runs.filter((r) => r.taskId === task.id);

  function patchTask(patch: Partial<TaskItem>): void {
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) =>
        t.id === task.id ? { ...t, ...patch, updatedAt: nowIso() } : t,
      ),
    });
  }

  function deleteTask(): void {
    onProjectChange({ ...project, tasks: project.tasks.filter((t) => t.id !== task.id) });
    onClose();
  }

  async function runAgent(): Promise<void> {
    setStarting(true);
    try {
      const repoId = info?.manifest.repos.find((r) => r.path === cwd)?.id ?? null;
      const run = await startRun({
        prompt: effectivePrompt,
        cwd,
        taskId: task.id,
        projectId: project.id,
        repoId,
      });
      patchTask({
        runIds: [...task.runIds, run.id],
        status: task.status === "backlog" ? "in_progress" : task.status,
      });
      onOpenRun(run.id);
    } finally {
      setStarting(false);
    }
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-edge bg-surface-1">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Task
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={deleteTask} aria-label="Delete task">
            <Trash2 className="h-3.5 w-3.5 text-danger" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task detail">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3">
        <Textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && patchTask({ title: title.trim() })}
          rows={2}
          className="text-sm font-semibold"
          aria-label="Task title"
        />

        <div className="grid grid-cols-2 gap-2">
          <Field label="Status">
            <select
              className={selectClasses}
              value={task.status}
              onChange={(e) => patchTask({ status: e.target.value as TaskStatus })}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              className={selectClasses}
              value={task.priority}
              onChange={(e) => patchTask({ priority: e.target.value as TaskPriority })}
            >
              {(["low", "medium", "high", "urgent"] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => patchTask({ description })}
            rows={4}
            placeholder="Details, acceptance criteria…"
          />
        </Field>

        {info && info.manifest.repos.length > 0 ? (
          <Field label="Linked repos">
            <div className="flex flex-wrap gap-1.5">
              {info.manifest.repos.map((repo) => {
                const linked = task.links.repoIds.includes(repo.id);
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() =>
                      patchTask({
                        links: {
                          ...task.links,
                          repoIds: linked
                            ? task.links.repoIds.filter((id) => id !== repo.id)
                            : [...task.links.repoIds, repo.id],
                        },
                      })
                    }
                  >
                    <Badge tone={linked ? "violet" : "neutral"} className="cursor-pointer">
                      {repo.name}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        {info ? <NodeLinks task={task} patchTask={patchTask} /> : null}

        <div className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-crystal-300">
              Run agent
            </span>
            {promptDirty ? (
              <button
                type="button"
                className="text-[10px] text-ink-faint underline hover:text-ink-muted"
                onClick={() => setPromptDirty(false)}
              >
                reset prompt
              </button>
            ) : null}
          </div>
          <Textarea
            value={effectivePrompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setPromptDirty(true);
            }}
            rows={5}
            className="font-mono text-[11px]"
            aria-label="Agent prompt"
          />
          <div className="mt-2 flex items-center gap-2">
            <select
              className={cn(selectClasses, "h-7 flex-1 text-xs")}
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              aria-label="Working directory"
            >
              <option value=".">workspace root</option>
              {info?.manifest.repos
                .filter((r) => r.path !== ".")
                .map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.name}
                  </option>
                ))}
            </select>
            <Button
              variant="primary"
              size="sm"
              disabled={starting || !effectivePrompt.trim()}
              onClick={() => void runAgent()}
            >
              <Play className="h-3 w-3" /> Run
            </Button>
          </div>
        </div>

        {taskRuns.length > 0 ? (
          <Field label={`Runs (${taskRuns.length})`}>
            <div className="space-y-1">
              {taskRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => onOpenRun(run.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-left transition-colors hover:border-edge-strong"
                >
                  <StatusDot status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                    {new Date(run.createdAt).toLocaleTimeString()} · {run.status}
                  </span>
                  <span className="text-[10px] text-ink-faint">{formatCost(run.costUsd)}</span>
                  <ExternalLink className="h-3 w-3 text-ink-faint" />
                </button>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </aside>
  );
}

const EMPTY_ARCHITECTURES: never[] = [];

function NodeLinks({
  task,
  patchTask,
}: {
  task: TaskItem;
  patchTask: (patch: Partial<TaskItem>) => void;
}) {
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const allNodes = architectures.flatMap((a) => a.graph.nodes.map((n) => ({ ...n, graph: a.graph.name })));
  if (allNodes.length === 0) return null;

  return (
    <Field label="Architecture links">
      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {allNodes.map((node) => {
          const linked = task.links.nodeIds.includes(node.id);
          return (
            <button
              key={node.id}
              type="button"
              title={`${node.graph} / ${node.label}`}
              onClick={() =>
                patchTask({
                  links: {
                    ...task.links,
                    nodeIds: linked
                      ? task.links.nodeIds.filter((id) => id !== node.id)
                      : [...task.links.nodeIds, node.id],
                  },
                })
              }
            >
              <Badge tone={linked ? "cyan" : "neutral"} className="cursor-pointer">
                {node.label}
              </Badge>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

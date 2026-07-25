import { useMemo, useState, type DragEvent, type KeyboardEvent } from "react";
import { Bot, CircleHelp, Lock, Network, Plus, UserRound } from "lucide-react";
import {
  PRIORITY_RANK,
  TASK_SIZE_POINTS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  createEpic,
  createTask,
  leaseValid,
  matchAgent,
  nowIso,
  openQuestions,
  readyTasks,
  tagDimension,
  tagDimensions,
  tagsInDimension,
  taskLiveUsage,
  tasksInColumn,
  templateOf,
  type AgentRoster,
  type Project,
  type TaskItem,
  type TaskStatus,
} from "@crystal/core";
import { useAgents, useNav, useNavUpdate, useWorkflows, useWorkspace } from "@crystal/client";
import { Badge, StatusDot, Tooltip, cn } from "@crystal/ui";
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
  const workflows = useWorkflows((s) => s.workflows);

  /**
   * The stage each status column is currently being driven by, from any live
   * workflow planning onto this board. This is the board's half of the
   * stage↔column mapping the template declares: without it, tasks move
   * between columns with no visible reason, because the thing moving them
   * lives in another tab.
   */
  const stagesByColumn = useMemo(() => {
    const map = new Map<TaskStatus, string[]>();
    for (const workflow of workflows) {
      if (workflow.status !== "running") continue;
      // A null projectId means the workspace's default board — which is this
      // one only when it is the board being shown, so match on identity and
      // let the default case fall through to "no claim".
      if (workflow.projectId != null && workflow.projectId !== project.id) continue;
      const template = templateOf(workflow);
      for (const state of workflow.stages) {
        if (state.status !== "active") continue;
        const def = template.stages.find((s) => s.id === state.id);
        if (!def?.boardStatus) continue;
        const names = map.get(def.boardStatus) ?? [];
        if (!names.includes(def.name)) names.push(def.name);
        map.set(def.boardStatus, names);
      }
    }
    return map;
  }, [workflows, project.id]);
  const nav = useNavUpdate();
  const group: BoardGroup = useNav((l) => l.orchestrate?.group) ?? "status";
  const sort: BoardSort = useNav((l) => l.orchestrate?.sort) ?? "manual";
  const filter = useNav((l) => l.orchestrate?.filter) ?? "";
  const owner = useNav((l) => l.orchestrate?.owner) ?? "";
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragOverCard, setDragOverCard] = useState<string | null>(null);
  const [epicDraft, setEpicDraft] = useState<string | null>(null);

  // Every run touching a task bills it — implement, review, merge, CI alike.
  // The durable rollup carries the settled history (runs age out of app
  // data); still-active runs add their live usage on top.
  const usageByTask = useMemo(() => {
    const map = new Map<string, { tokens: number; costUsd: number }>();
    for (const task of project.tasks) {
      const usage = taskLiveUsage(task, runs);
      if (usage) map.set(task.id, usage);
    }
    return map;
  }, [runs, project.tasks]);

  // Tasks whose blockers are not all done — surfaced so nobody starts them.
  const blockedTasks = useMemo(() => {
    const byId = new Map(project.tasks.map((t) => [t.id, t]));
    return new Set(
      project.tasks
        .filter(
          (t) =>
            t.status !== "done" &&
            t.blockedBy.some((id) => (byId.get(id)?.status ?? "done") !== "done"),
        )
        .map((t) => t.id),
    );
  }, [project.tasks]);

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

  /** Tasks hidden by the toolbar filters are dimmed out of every column. */
  function matchesFilters(task: TaskItem): boolean {
    if (owner) {
      if (owner.startsWith("agent:") && task.owners.agentId !== owner.slice(6)) return false;
      if (owner.startsWith("human:") && (task.owners.human ?? "") !== owner.slice(6)) return false;
    }
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      task.title.toLowerCase().includes(q) ||
      task.description.toLowerCase().includes(q) ||
      task.labels.some((l) => l.toLowerCase().includes(q))
    );
  }

  /** Every member of a column (unfiltered), in stable manual order. */
  function groupMembers(key: string): TaskItem[] {
    if (group === "epic") {
      return project.tasks
        .filter((t) => (t.epicId ?? "") === key)
        .sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
    }
    if (group.startsWith("tag:")) {
      const dim = group.slice(4);
      return project.tasks
        .filter((t) => {
          const values = tagsInDimension(t.labels, dim);
          return key === "" ? values.length === 0 : values.includes(key);
        })
        .sort((a, b) => a.order - b.order || b.updatedAt.localeCompare(a.updatedAt));
    }
    return tasksInColumn(project, key as TaskStatus);
  }

  function tasksInGroup(key: string): TaskItem[] {
    return sortTasks(groupMembers(key).filter((t) => matchesFilters(t)), sort, usageByTask);
  }

  /** The column a task currently sits in along the active grouping axis. */
  function columnKeyOf(task: TaskItem): string {
    if (group === "epic") return task.epicId ?? "";
    if (group.startsWith("tag:")) return tagsInDimension(task.labels, group.slice(4))[0] ?? "";
    return task.status;
  }

  /**
   * Dropping a card re-homes it along the active grouping axis; with a
   * `beforeId` (dropped onto a card, manual sort) it also lands at that spot —
   * the target column is renumbered so hidden/filtered tasks keep their
   * relative order.
   */
  function dropTask(taskId: string, columnKey: string, beforeId?: string): void {
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task) return;
    let axisPatch: Partial<TaskItem> = {};
    if (group === "epic") {
      axisPatch = { epicId: columnKey || null };
    } else if (group.startsWith("tag:")) {
      const dim = group.slice(4);
      const kept = task.labels.filter((l) => tagDimension(l) !== dim);
      axisPatch = { labels: columnKey ? [...kept, `${dim}:${columnKey}`] : kept };
    } else {
      axisPatch = { status: columnKey as TaskStatus };
    }
    const members = groupMembers(columnKey).filter((t) => t.id !== taskId);
    const beforeIdx = beforeId && sort === "manual" ? members.findIndex((t) => t.id === beforeId) : -1;
    members.splice(beforeIdx >= 0 ? beforeIdx : members.length, 0, task);
    const orderById = new Map(members.map((t, i) => [t.id, i + 1]));
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) => {
        if (t.id === taskId) {
          return { ...t, ...axisPatch, order: orderById.get(t.id) ?? t.order, updatedAt: nowIso() };
        }
        const order = orderById.get(t.id);
        // Sibling renumbering is cosmetic — leave updatedAt alone so it never
        // outranks an agent's real write in a stale-save merge.
        return order != null && order !== t.order ? { ...t, order } : t;
      }),
    });
  }

  /** Keyboard: move a card one column left/right along the active grouping. */
  function moveTask(task: TaskItem, delta: -1 | 1): void {
    const idx = columns.findIndex((c) => c.key === columnKeyOf(task));
    const target = columns[idx + delta];
    if (target) dropTask(task.id, target.key);
  }

  /** Keyboard: nudge a card up/down within its column (manual sort only). */
  function nudgeTask(task: TaskItem, delta: -1 | 1): void {
    if (sort !== "manual") return;
    const key = columnKeyOf(task);
    const members = groupMembers(key);
    const idx = members.findIndex((t) => t.id === task.id);
    const targetIdx = delta === -1 ? idx - 1 : idx + 2;
    if (idx < 0 || (delta === -1 && idx === 0) || (delta === 1 && idx >= members.length - 1)) return;
    dropTask(task.id, key, members[targetIdx]?.id);
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

  // Agent-driven boards stall silently when the manager dies: READY work with
  // nobody to pick it up. Surface it instead of waiting for someone to notice.
  const ready = useMemo(() => readyTasks(project), [project]);
  const managerLive = runs.some(
    (r) => r.role === "manager" && (r.status === "running" || r.status === "queued"),
  );
  const agentDriven = project.tasks.some((t) => t.runIds.length > 0);
  const stalled = agentDriven && !managerLive && ready.length > 0;

  const humans = [
    ...new Set(
      [roster?.defaultHuman, ...project.tasks.map((t) => t.owners.human)].filter(
        (h): h is string => !!h,
      ),
    ),
  ].sort();
  const filtering = !!filter.trim() || !!owner;

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
        <input
          value={filter}
          onChange={(e) => nav({ orchestrate: { filter: e.target.value || null } })}
          placeholder="Filter…"
          aria-label="Filter tasks"
          className="h-6 w-32 rounded-md border border-edge bg-surface-1 px-1.5 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-crystal-500/60"
        />
        <select
          className="h-6 rounded-md border border-edge bg-surface-1 px-1.5 text-[11px] text-ink focus:border-crystal-500/60 focus:outline-none"
          value={owner}
          onChange={(e) => nav({ orchestrate: { owner: e.target.value || null } })}
          aria-label="Filter by owner"
        >
          <option value="">All owners</option>
          {(roster?.agents ?? []).map((a) => (
            <option key={a.id} value={`agent:${a.id}`}>
              🤖 {a.name}
            </option>
          ))}
          {humans.map((h) => (
            <option key={h} value={`human:${h}`}>
              {h}
            </option>
          ))}
        </select>
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
        {stalled ? (
          <span
            className="ml-auto flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn/5 px-2 py-0.5 text-[11px] text-warn"
            title="Unblocked backlog tasks are waiting and no manager run is live — dispatch a manager from the Agents tab or start a task run."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            {ready.length} ready · no active manager
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) => {
          const tasks = tasksInGroup(column.key);
          const total = filtering ? groupMembers(column.key).length : tasks.length;
          const wipLimit = group === "status" ? project.wipLimits[column.key] : undefined;
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
                setDragOverCard(null);
                const id = e.dataTransfer.getData(TASK_MIME);
                if (id) dropTask(id, column.key);
              }}
            >
              <div className="flex items-center gap-2 px-3 py-2.5">
                <span className="h-2 w-2 rounded-full" style={{ background: column.accent }} />
                <span className="truncate text-xs font-semibold text-ink">{column.label}</span>
                {group === "status" && stagesByColumn.has(column.key as TaskStatus) ? (
                  <Tooltip
                    content={`Driven by the ${stagesByColumn
                      .get(column.key as TaskStatus)!
                      .join(", ")} stage of a running workflow`}
                  >
                    <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-crystal-500/40 bg-crystal-500/10 px-1.5 py-px text-[9px] text-crystal-200">
                      <Network className="h-2.5 w-2.5" />
                      {stagesByColumn.get(column.key as TaskStatus)!.join(", ")}
                    </span>
                  </Tooltip>
                ) : null}
                <ColumnCount
                  shown={tasks.length}
                  total={total}
                  filtering={filtering}
                  limit={wipLimit}
                  onSetLimit={
                    group === "status"
                      ? (limit) => {
                          const wipLimits = { ...project.wipLimits };
                          if (limit == null) delete wipLimits[column.key];
                          else wipLimits[column.key] = limit;
                          onProjectChange({ ...project, wipLimits });
                        }
                      : undefined
                  }
                />
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
                    blocked={blockedTasks.has(task.id)}
                    dropBefore={dragOverCard === task.id}
                    onClick={() => onSelectTask(task.id)}
                    onDragOverCard={(over) => setDragOverCard(over ? task.id : null)}
                    onDropBefore={(draggedId) => {
                      setDragOver(null);
                      setDragOverCard(null);
                      dropTask(draggedId, column.key, task.id);
                    }}
                    onKeyCommand={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectTask(task.id);
                      } else if (e.key === "[" || (e.key === "ArrowLeft" && e.altKey)) {
                        e.preventDefault();
                        moveTask(task, -1);
                      } else if (e.key === "]" || (e.key === "ArrowRight" && e.altKey)) {
                        e.preventDefault();
                        moveTask(task, 1);
                      } else if (e.key === "ArrowUp" && e.altKey) {
                        e.preventDefault();
                        nudgeTask(task, -1);
                      } else if (e.key === "ArrowDown" && e.altKey) {
                        e.preventDefault();
                        nudgeTask(task, 1);
                      }
                    }}
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

/**
 * Column count, doubling as the WIP-limit control on status columns: shows
 * `total/limit` (amber when over), click to set or clear the limit.
 */
function ColumnCount({
  shown,
  total,
  filtering,
  limit,
  onSetLimit,
}: {
  shown: number;
  total: number;
  filtering: boolean;
  limit: number | undefined;
  onSetLimit?: (limit: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const over = limit != null && total > limit;
  const label = filtering ? `${shown}/${total}` : limit != null ? `${total}/${limit}` : `${total}`;

  if (editing && onSetLimit) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
        onBlur={() => {
          onSetLimit(draft ? Math.max(1, Number(draft)) : null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setEditing(false);
        }}
        placeholder="WIP"
        aria-label="WIP limit (empty clears)"
        className="h-5 w-10 rounded border border-crystal-500/40 bg-surface-1 px-1 text-[10px] text-ink outline-none placeholder:text-ink-faint"
      />
    );
  }
  if (!onSetLimit) return <span className="text-[11px] text-ink-faint">{label}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(limit != null ? String(limit) : "");
        setEditing(true);
      }}
      title={
        over
          ? `Over the WIP limit (${total} > ${limit}) — finish before starting more. Click to change.`
          : "Click to set a WIP limit"
      }
      className={cn(
        "rounded px-1 text-[11px] transition-colors hover:bg-surface-2",
        over ? "font-semibold text-warn" : "text-ink-faint",
      )}
    >
      {label}
      {over ? " !" : ""}
    </button>
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
  blocked,
  dropBefore,
  onClick,
  onDragOverCard,
  onDropBefore,
  onKeyCommand,
}: {
  task: TaskItem;
  roster: AgentRoster | null;
  usage: { tokens: number; costUsd: number } | null;
  selected: boolean;
  agentRunning: boolean;
  blocked: boolean;
  dropBefore: boolean;
  onClick: () => void;
  onDragOverCard: (over: boolean) => void;
  onDropBefore: (draggedId: string) => void;
  onKeyCommand: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const agent = roster?.agents.find((a) => a.id === task.owners.agentId) ?? null;
  const questions = openQuestions(task).length;
  const unowned = !task.owners.agentId || !task.owners.human;
  const leased = leaseValid(task.lease);

  return (
    <div
      draggable
      role="button"
      tabIndex={0}
      aria-label={`Task: ${task.title}. Enter opens; [ and ] move between columns; Alt+↑/↓ reorder.`}
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_MIME, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOverCard(true);
      }}
      onDragLeave={() => onDragOverCard(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const id = e.dataTransfer.getData(TASK_MIME);
        if (id && id !== task.id) onDropBefore(id);
        else onDragOverCard(false);
      }}
      onClick={onClick}
      onKeyDown={onKeyCommand}
      className={cn(
        "cursor-pointer rounded-lg border bg-surface-2 p-2.5 shadow-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-crystal-400/60",
        selected
          ? "border-crystal-400/70 ring-1 ring-crystal-400/30"
          : "border-edge hover:border-edge-strong",
      )}
      style={dropBefore ? { boxShadow: "0 -2px 0 0 var(--color-crystal-400)" } : undefined}
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
        {blocked ? <Badge tone="amber">blocked</Badge> : null}
        {task.labels.slice(0, 2).map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          {leased ? (
            <span
              className="flex items-center gap-0.5 text-[10px] text-info"
              title={`Leased to ${task.lease!.holder} until ${new Date(task.lease!.expiresAt).toLocaleTimeString()} — one writer per task`}
            >
              <Lock className="h-3 w-3" />
              <span className="max-w-[80px] truncate">{task.lease!.holder}</span>
            </span>
          ) : null}
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

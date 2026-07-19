import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  CircleDollarSign,
  GitBranch,
  MessageSquare,
  Network,
  Pause,
  Play,
  Plus,
  Send,
} from "lucide-react";
import {
  budgetState,
  workflowSpend,
  workflowTag,
  workflowTemplate,
  type AgentRun,
  type AgentRunStatus,
  type Workflow,
  type WorkflowSpend,
  type WorkflowStageStatus,
} from "@crystal/core";
import { useAgents, useWorkflows, useWorkspace } from "@crystal/client";
import { Badge, Button, EmptyState, Input, Spinner, Textarea, Tooltip, cn } from "@crystal/ui";
import { formatCost, formatTokens } from "./prompt.js";
import { RunView } from "./RunView.js";

const EMPTY_PROJECTS: never[] = [];

/**
 * The workflow surface: multi-agent workflows driven by an interactive manager
 * session. Left: the workspace's workflows with live spend vs budget. Right:
 * the selected workflow — stage pipeline, parallel tracks with branches, and
 * the manager conversation (every resume-chained turn) with a composer that
 * messages the manager remotely.
 */
export function WorkflowsTab({
  selectedWorkflowId,
  onSelectWorkflow,
  onOpenRun,
  onOpenTask,
}: {
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  /** Open a run in the Runs tab (worker drill-down). */
  onOpenRun?: (id: string) => void;
  /** Open a task on the Board tab (answering questions). */
  onOpenTask?: (id: string) => void;
}) {
  const workflows = useWorkflows((s) => s.workflows);
  const runs = useAgents((s) => s.runs);
  const selected = workflows.find((w) => w.id === selectedWorkflowId) ?? null;
  // One pass over the run list per change, not one per visible workflow —
  // `runs` gets a new reference on every usage tick of any live agent.
  const spendById = useMemo(
    () => new Map(workflows.map((w) => [w.id, workflowSpend(w.id, runs)])),
    [workflows, runs],
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <Network className="h-3.5 w-3.5 text-crystal-300" />
          <span className="text-xs font-semibold text-ink">Workflows</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="New workflow"
            onClick={() => onSelectWorkflow(null)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {workflows.length === 0 ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-ink-faint">
              No workflows yet. Start one on the right — a manager agent refines the goal with
              you, plans it onto the board, and drives parallel develop → review → merge →
              release tracks.
            </p>
          ) : (
            workflows.map((w) => (
              <WorkflowListItem
                key={w.id}
                workflow={w}
                spend={spendById.get(w.id)!}
                selected={w.id === selectedWorkflowId}
                onSelect={() => onSelectWorkflow(w.id)}
              />
            ))
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {selected ? (
          <WorkflowDetail
            workflow={selected}
            runs={runs}
            spend={spendById.get(selected.id)!}
            onOpenRun={onOpenRun}
            onOpenTask={onOpenTask}
          />
        ) : (
          <NewWorkflowPanel onStarted={onSelectWorkflow} />
        )}
      </main>
    </div>
  );
}

const STATUS_TONES: Record<Workflow["status"], "violet" | "amber" | "emerald" | "rose" | "slate"> = {
  running: "violet",
  paused: "amber",
  completed: "emerald",
  failed: "rose",
  cancelled: "slate",
};

function WorkflowListItem({
  workflow,
  spend,
  selected,
  onSelect,
}: {
  workflow: Workflow;
  spend: WorkflowSpend;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "mb-1 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-crystal-500/40 bg-crystal-500/10"
          : "border-transparent hover:border-edge hover:bg-surface-2",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
          {workflow.name}
        </span>
        <Badge tone={STATUS_TONES[workflow.status]}>{workflow.status}</Badge>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint">
        <span>
          {formatCost(spend.costUsd)}
          {workflow.budgetUsd != null ? ` / $${workflow.budgetUsd.toFixed(2)}` : ""}
        </span>
        <span>{formatTokens(spend.totalTokens)} tok</span>
        <span>{spend.runCount} runs</span>
        {spend.liveRunCount > 0 ? <Spinner className="h-2.5 w-2.5" /> : null}
      </div>
    </button>
  );
}

const STAGE_STATUS_CLASSES: Record<WorkflowStageStatus, string> = {
  pending: "border-edge text-ink-faint",
  active: "border-crystal-500/50 bg-crystal-500/10 text-crystal-200",
  done: "border-ok/40 bg-ok/10 text-ok",
  skipped: "border-edge text-ink-faint line-through",
};

const WORKER_CHIP_CLASSES: Record<AgentRunStatus, string> = {
  queued: "border-crystal-500/40 bg-crystal-500/10 text-crystal-200",
  running: "border-crystal-500/40 bg-crystal-500/10 text-crystal-200",
  completed: "border-ok/30 text-ok",
  failed: "border-danger/30 text-danger",
  cancelled: "border-edge text-ink-faint line-through",
};

function WorkflowDetail({
  workflow,
  runs,
  spend,
  onOpenRun,
  onOpenTask,
}: {
  workflow: Workflow;
  runs: AgentRun[];
  spend: WorkflowSpend;
  onOpenRun?: (id: string) => void;
  onOpenTask?: (id: string) => void;
}) {
  const setPaused = useWorkflows((s) => s.setPaused);
  const setBudget = useWorkflows((s) => s.setBudget);
  const cancel = useWorkflows((s) => s.cancel);

  const template = workflowTemplate(workflow.templateId);
  const budget = budgetState(workflow, spend);
  const terminal =
    workflow.status === "completed" ||
    workflow.status === "failed" ||
    workflow.status === "cancelled";

  // The manager conversation: every manager-role run carrying this
  // workflow's tag, in chain order (createdAt is chain order — each turn is
  // spawned after the previous settles).
  const tag = workflowTag(workflow.id);
  const managerTurns = useMemo(
    () =>
      runs
        .filter((r) => r.tags.includes(tag) && r.role === "manager")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs, tag],
  );
  const workers = useMemo(
    () =>
      runs
        .filter((r) => r.tags.includes(tag) && r.role === "worker")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [runs, tag],
  );

  // Open questions on the workflow's board tasks — the manager (or a worker)
  // is waiting on the human owner; answering happens on the Board tab.
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const openQuestions = useMemo(() => {
    const project =
      projects.find((p) => p.project.id === workflow.projectId) ?? projects[0] ?? null;
    if (!project) return [];
    const trackTaskIds = new Set(workflow.tracks.flatMap((t) => t.taskIds));
    return project.project.tasks
      .filter(
        (t) =>
          (workflow.epicId != null && t.epicId === workflow.epicId) || trackTaskIds.has(t.id),
      )
      .flatMap((t) =>
        t.questions
          .filter((q) => q.answer == null)
          .map((q) => ({ taskId: t.id, taskTitle: t.title, text: q.text })),
      );
  }, [projects, workflow.projectId, workflow.epicId, workflow.tracks]);
  const [turnId, setTurnId] = useState<string | null>(null);
  const latestTurn = managerTurns[managerTurns.length - 1] ?? null;
  const viewedTurn = managerTurns.find((r) => r.id === turnId) ?? latestTurn;
  // Follow the live conversation unless an older turn was explicitly picked.
  useEffect(() => setTurnId(null), [workflow.id]);

  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-edge px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 shrink-0 text-crystal-300" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {workflow.name}
          </h2>
          <Badge tone={STATUS_TONES[workflow.status]}>{workflow.status}</Badge>
          {!terminal ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void setPaused(workflow.id, workflow.status !== "paused")}
              >
                {workflow.status === "paused" ? (
                  <>
                    <Play className="h-3 w-3" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3 w-3" /> Pause
                  </>
                )}
              </Button>
              <Button variant="danger" size="xs" onClick={() => void cancel(workflow.id)}>
                <Ban className="h-3 w-3" /> Cancel
              </Button>
            </>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">
          {workflow.goal}
        </p>
        {workflow.pausedReason ? (
          <p className="mt-1 text-[11px] text-warn">{workflow.pausedReason}</p>
        ) : null}
        {workflow.summary ? (
          <p className="mt-1 text-[11px] text-ink-muted">
            <span className="font-semibold text-ink">Outcome:</span> {workflow.summary}
          </p>
        ) : null}

        {/* Stage pipeline */}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {template.stages.map((def, i) => {
            const state = workflow.stages.find((s) => s.id === def.id);
            return (
              <span key={def.id} className="flex items-center gap-1">
                {i > 0 ? <span className="text-[10px] text-ink-faint">→</span> : null}
                <Tooltip content={`${def.description}${state?.note ? ` — ${state.note}` : ""}`}>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                      STAGE_STATUS_CLASSES[state?.status ?? "pending"],
                    )}
                  >
                    {def.name}
                    {def.perTrack ? "∥" : ""}
                  </span>
                </Tooltip>
              </span>
            );
          })}
        </div>

        {/* Tracks + budget */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          <span className="flex items-center gap-1">
            <CircleDollarSign className="h-3.5 w-3.5 text-crystal-300" />
            {formatCost(spend.costUsd)}
            {budget.budgetUsd != null ? (
              <span className={cn(budget.exhausted && "text-danger")}>
                {" "}
                / ${budget.budgetUsd.toFixed(2)}
              </span>
            ) : (
              <span className="text-ink-faint"> (no budget)</span>
            )}
            · {formatTokens(spend.totalTokens)} tok · {spend.runCount} runs
          </span>
          {editingBudget ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(budgetInput);
                void setBudget(workflow.id, budgetInput.trim() === "" || !Number.isFinite(n) ? null : n);
                setEditingBudget(false);
              }}
            >
              <Input
                autoFocus
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder="USD (empty = none)"
                className="h-6 w-32 text-[11px]"
                aria-label="Budget in USD"
              />
              <Button type="submit" variant="ghost" size="xs">
                Set
              </Button>
            </form>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setBudgetInput(workflow.budgetUsd?.toString() ?? "");
                setEditingBudget(true);
              }}
            >
              Edit budget
            </Button>
          )}
          {workflow.tracks.map((t) => (
            <Tooltip key={t.id} content={`${t.name} — ${t.taskIds.length} tasks`}>
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full border border-edge px-2 py-0.5 font-mono text-[10px]",
                  t.status === "merged" && "text-ok",
                  t.status === "abandoned" && "line-through text-ink-faint",
                )}
              >
                <GitBranch className="h-3 w-3" />
                {t.branch}
              </span>
            </Tooltip>
          ))}
        </div>

        {openQuestions.length > 0 ? (
          <div className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5">
            {openQuestions.map((q, i) => (
              <button
                key={`${q.taskId}-${i}`}
                type="button"
                onClick={() => onOpenTask?.(q.taskId)}
                className="block w-full truncate text-left text-[11px] text-ink hover:underline"
                title="Answer on the board"
              >
                <span className="font-semibold text-warn">Q</span> {q.text}
                <span className="text-ink-faint"> — {q.taskTitle}</span>
              </button>
            ))}
          </div>
        ) : null}

        {workers.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {workers.map((w) => (
              <Tooltip key={w.id} content={w.prompt.split("\n")[0] ?? w.id}>
                <button
                  type="button"
                  onClick={() => onOpenRun?.(w.id)}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                    WORKER_CHIP_CLASSES[w.status],
                  )}
                >
                  {w.status === "running" ? <Spinner className="h-2.5 w-2.5" /> : null}
                  {w.purpose ?? "worker"}
                  {w.branch ? <span className="font-mono text-ink-faint">{w.branch.split("/").pop()}</span> : null}
                  {w.costUsd != null ? <span className="text-ink-faint">{formatCost(w.costUsd)}</span> : null}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </header>

      {/* Manager conversation */}
      <div className="flex min-h-0 flex-1 flex-col">
        {managerTurns.length > 1 ? (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-edge px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-ink-faint">Turns</span>
            {managerTurns.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setTurnId(r.id === latestTurn?.id ? null : r.id)}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                  viewedTurn?.id === r.id
                    ? "bg-surface-3 text-ink"
                    : "text-ink-muted hover:text-ink",
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {viewedTurn ? (
            <RunView run={viewedTurn} />
          ) : (
            <EmptyState icon={MessageSquare} title="Manager session">
              The manager's turns stream here as it refines, plans and dispatches.
            </EmptyState>
          )}
        </div>
        {!terminal ? <ManagerComposer workflowId={workflow.id} /> : null}
      </div>
    </div>
  );
}

/** Remote control: send the manager a message (delivered/queued server-side). */
function ManagerComposer({ workflowId }: { workflowId: string }) {
  const message = useWorkflows((s) => s.message);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const { queued } = await message(workflowId, t);
      setText("");
      setNotice(queued ? "Queued — delivered when the manager finishes its current turn." : null);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-edge bg-surface-1 p-2">
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
          }}
          rows={2}
          placeholder="Message the manager — steer scope, answer questions, change priorities… (Ctrl+Enter)"
          aria-label="Message the workflow manager"
          className="min-h-0 flex-1"
        />
        <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
          <Send className="h-3 w-3" /> Send
        </Button>
      </div>
      {notice ? <p className="mt-1 text-[10px] text-ink-faint">{notice}</p> : null}
    </div>
  );
}

function NewWorkflowPanel({ onStarted }: { onStarted: (id: string) => void }) {
  const start = useWorkflows((s) => s.start);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudgetInput] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const n = Number(budget);
      const workflow = await start({
        name: name.trim(),
        goal: goal.trim(),
        projectId: projectId || null,
        budgetUsd: budget.trim() !== "" && Number.isFinite(n) ? n : null,
      });
      onStarted(workflow.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-5">
      <div className="rounded-xl border border-crystal-500/25 bg-crystal-500/5 p-3">
        <div className="mb-2 flex items-center gap-2">
          <Network className="h-4 w-4 text-crystal-300" />
          <span className="text-[13px] font-semibold text-ink">Start a workflow</span>
        </div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name, e.g. Payments v2"
          aria-label="Workflow name"
        />
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={5}
          placeholder="Describe the goal. The manager refines it with you before planning — rough is fine."
          aria-label="Workflow goal"
          className="mt-2"
        />
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={budget}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder="Budget USD (optional)"
            aria-label="Budget in USD"
            className="w-40"
          />
          <select
            className="h-8 flex-1 rounded-lg border border-edge bg-surface-1 px-2 text-[13px] text-ink focus:border-crystal-500/60 focus:outline-none"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project board"
          >
            <option value="">Default board</option>
            {projects.map((p) => (
              <option key={p.project.id} value={p.project.id}>
                {p.project.name}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !name.trim() || !goal.trim()}
            onClick={() => void create()}
          >
            <Play className="h-3 w-3" /> Start
          </Button>
        </div>
        {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
      </div>

      <EmptyState icon={Network} title="Manager → plan + design → develop ∥ review → merge → release">
        An interactive manager session coordinates the whole flow: it refines requirements with
        you (message it any time), plans tasks onto the board, dispatches parallel develop
        tracks on their own branches, reviews each as it lands, then merges and releases —
        with every token accounted against the budget.
      </EmptyState>
    </div>
  );
}

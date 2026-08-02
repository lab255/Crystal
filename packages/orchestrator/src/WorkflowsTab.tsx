import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  Ban,
  ChevronRight,
  CircleDollarSign,
  GitBranch,
  LayoutTemplate,
  MessageSquare,
  Network,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
  TerminalSquare,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  AUTO_MODEL,
  MODEL_HINTS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  boardColumnStages,
  budgetState,
  envGaps,
  premiseGaps,
  presetById,
  templateOf,
  validateWorkflowTemplate,
  workflowSpend,
  workflowTag,
  type AgentRun,
  type AgentRunStatus,
  type Workflow,
  type WorkflowSpend,
  type WorkflowStageStatus,
  type WorkflowTemplate,
} from "@crystal/core";
import {
  RunSurface,
  formatRunCost,
  formatRunTokens,
  useAgents,
  useCrystal,
  useRunSurface,
  useTerminals,
  useWorkflows,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  Textarea,
  Tooltip,
  cn,
} from "@crystal/ui";
import { TemplateBuilder } from "./TemplateBuilder.js";
import { TemplateEditor } from "./TemplateEditor.js";
import { WorkflowGraph } from "./WorkflowGraph.js";

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
  builderOpen = false,
  onToggleBuilder,
  selectedTemplateId = null,
  onSelectTemplate,
}: {
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  /** Open a run in the Runs tab (worker drill-down). */
  onOpenRun?: (id: string) => void;
  /** Open a task on the Board tab (answering questions). */
  onOpenTask?: (id: string) => void;
  /** Visual template builder open (deep-linkable — lives in the nav store). */
  builderOpen?: boolean;
  onToggleBuilder?: (open: boolean) => void;
  /** Template selected in the builder. */
  selectedTemplateId?: string | null;
  onSelectTemplate?: (id: string | null) => void;
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
          <Tooltip content="Template builder">
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn("ml-auto", builderOpen && "bg-surface-3 text-ink")}
              aria-label="Template builder"
              onClick={() => onToggleBuilder?.(!builderOpen)}
            >
              <LayoutTemplate className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New workflow"
            onClick={() => {
              onToggleBuilder?.(false);
              onSelectWorkflow(null);
            }}
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
        {builderOpen ? (
          <TemplateBuilder
            selectedTemplateId={selectedTemplateId}
            onSelectTemplate={(id) => onSelectTemplate?.(id)}
            onClose={() => onToggleBuilder?.(false)}
          />
        ) : selected ? (
          <WorkflowDetail
            workflow={selected}
            runs={runs}
            spend={spendById.get(selected.id)!}
            onOpenRun={onOpenRun}
            onOpenTask={onOpenTask}
          />
        ) : (
          <NewWorkflowPanel
            onStarted={onSelectWorkflow}
            onEditTemplates={() => onToggleBuilder?.(true)}
          />
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
          {formatRunCost(spend.costUsd)}
          {workflow.budgetUsd != null ? ` / $${workflow.budgetUsd.toFixed(2)}` : ""}
        </span>
        <span>{formatRunTokens(spend.totalTokens)} tok</span>
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
  const setRunCap = useWorkflows((s) => s.setRunCap);
  const cancel = useWorkflows((s) => s.cancel);
  const compact = useWorkflows((s) => s.compact);
  const [notice, setNotice] = useState<string | null>(null);

  const template = templateOf(workflow);
  const [graphOpen, setGraphOpen] = useState(false);
  const stageStatuses = useMemo(
    () => new Map(workflow.stages.map((s) => [s.id, s.status])),
    [workflow.stages],
  );
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
  const message = useWorkflows((s) => s.message);
  const [turnId, setTurnId] = useState<string | null>(null);
  const latestTurn = managerTurns[managerTurns.length - 1] ?? null;
  const viewedTurn = managerTurns.find((r) => r.id === turnId) ?? latestTurn;
  // The shared run surface renders the viewed turn: transcript or PTY
  // handoff, the resume-chain turn strip, composer and worktree changes.
  const surface = useRunSurface(viewedTurn?.id ?? null);
  const [openTrackId, setOpenTrackId] = useState<string | null>(null);
  const openTrack = workflow.tracks.find((t) => t.id === openTrackId) ?? null;
  // Follow the live conversation unless an older turn was explicitly picked.
  useEffect(() => {
    setTurnId(null);
    setOpenTrackId(null);
    setNotice(null);
  }, [workflow.id]);

  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [editingRunCap, setEditingRunCap] = useState(false);
  const [runCapInput, setRunCapInput] = useState("");

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
              <Tooltip content="Retire the manager's transcript and reseed a fresh session from the workflow record + board — cuts what every wake re-ingests. Only between waves (refused while runs are live).">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void compact(workflow.id)
                      .then(() => setNotice("Compacted into a fresh manager session."))
                      .catch((err: Error) => setNotice(err.message))
                  }
                >
                  <Archive className="h-3 w-3" /> Compact
                </Button>
              </Tooltip>
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
        {workflow.env && !workflow.env.ok ? (
          <p className="mt-1 text-[11px] text-warn">
            Environment gaps:{" "}
            {envGaps(workflow.env)
              .map((c) => `${c.label} (${c.reason})`)
              .join(", ")}{" "}
            — the pre-flight could not resolve these; workers relying on them will fail.
          </p>
        ) : null}
        {workflow.premise && !workflow.premise.ok ? (
          <p className="mt-1 text-[11px] text-danger">
            Failed premises:{" "}
            {premiseGaps(workflow.premise)
              .map((c) => `${c.raw} (${c.detail ?? "does not hold"})`)
              .join("; ")}{" "}
            — the brief asserts things this repo says are false; the manager was told to stop
            and ask rather than build on them.
          </p>
        ) : null}
        {notice ? <p className="mt-1 text-[11px] text-ink-faint">{notice}</p> : null}
        {workflow.summary ? (
          <p className="mt-1 text-[11px] text-ink-muted">
            <span className="font-semibold text-ink">Outcome:</span> {workflow.summary}
          </p>
        ) : null}

        {/* Stage pipeline — chips inline, expandable into the dependency graph */}
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
          <Tooltip content={graphOpen ? "Hide the stage graph" : "Show the stage graph"}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle stage graph"
              className={cn(graphOpen && "bg-surface-3 text-ink")}
              onClick={() => setGraphOpen((v) => !v)}
            >
              <WorkflowIcon className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        </div>
        {graphOpen ? (
          <div className="mt-2 h-52 overflow-hidden rounded-lg border border-edge bg-surface-0">
            <WorkflowGraph
              key={workflow.id}
              stages={template.stages}
              statuses={stageStatuses}
            />
          </div>
        ) : null}

        {/* Tracks + budget */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          <span className="flex items-center gap-1">
            <CircleDollarSign className="h-3.5 w-3.5 text-crystal-300" />
            {formatRunCost(spend.costUsd)}
            {budget.budgetUsd != null ? (
              <span className={cn(budget.exhausted && "text-danger")}>
                {" "}
                / ${budget.budgetUsd.toFixed(2)}
              </span>
            ) : (
              <span className="text-ink-faint"> (no budget)</span>
            )}
            · {formatRunTokens(spend.totalTokens)} tok · {spend.runCount} runs
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
          {workflow.runCapUsd != null ? (
            <Tooltip content="Per-run cost cap: any single run (manager turns included) crossing it is killed mid-flight. Applies to runs spawned from now on.">
              <span className="text-ink-faint">run cap ${workflow.runCapUsd.toFixed(2)}</span>
            </Tooltip>
          ) : null}
          {editingRunCap ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(runCapInput);
                void setRunCap(
                  workflow.id,
                  runCapInput.trim() === "" || !Number.isFinite(n) ? null : n,
                );
                setEditingRunCap(false);
              }}
            >
              <Input
                autoFocus
                value={runCapInput}
                onChange={(e) => setRunCapInput(e.target.value)}
                placeholder="USD/run (empty = none)"
                className="h-6 w-32 text-[11px]"
                aria-label="Per-run cost cap in USD"
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
                setRunCapInput(workflow.runCapUsd?.toString() ?? "");
                setEditingRunCap(true);
              }}
            >
              Edit run cap
            </Button>
          )}
          {workflow.tracks.map((t) => (
            <Tooltip
              key={t.id}
              content={`${t.name} — ${t.taskIds.length} tasks. Click for the files this branch changes.`}
            >
              <button
                type="button"
                onClick={() => setOpenTrackId((id) => (id === t.id ? null : t.id))}
                className={cn(
                  "flex items-center gap-1 rounded-full border border-edge px-2 py-0.5 font-mono text-[10px]",
                  t.status === "merged" && "text-ok",
                  t.status === "abandoned" && "line-through text-ink-faint",
                  openTrackId === t.id && "bg-surface-3 text-ink",
                )}
              >
                <GitBranch className="h-3 w-3" />
                {t.branch}
              </button>
            </Tooltip>
          ))}
        </div>

        {/* Marginal value per manager turn: cost beside what changed. A turn
            that spent money and settled nothing is the retro's failure mode —
            it reads loud here, not as archaeology across board revisions. */}
        {workflow.turnLog.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
            <span className="mr-1 uppercase tracking-wider text-ink-faint">Turns</span>
            {workflow.turnLog.slice(-12).map((t) => (
              <Tooltip
                key={t.runId}
                content={
                  t.progressed
                    ? `${new Date(t.at).toLocaleString()} — this manager turn settled something (dispatch, stage/board movement, question, or completion).`
                    : `${new Date(t.at).toLocaleString()} — this manager turn changed NOTHING: no dispatch, no stage/board movement, no question. Money left; the board did not move.`
                }
              >
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 font-mono",
                    t.progressed
                      ? "border-edge text-ink-muted"
                      : "border-danger/50 bg-danger/15 font-semibold text-danger",
                  )}
                >
                  {formatRunCost(t.costUsd)}
                  {t.progressed ? "" : " ∅"}
                </span>
              </Tooltip>
            ))}
          </div>
        ) : null}

        {openTrack?.branch ? (
          <TrackFilesPanel key={openTrack.id} branch={openTrack.branch} />
        ) : null}

        {openQuestions.length > 0 ? (
          <div className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5">
            {openQuestions.map((q, i) => (
              <button
                key={`${q.taskId}-${i}`}
                type="button"
                onClick={() => onOpenTask?.(q.taskId)}
                className="block w-full text-left text-[11px] leading-snug text-ink hover:underline line-clamp-2"
                title={`${q.text}\n\n(answer on the board)`}
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
                  {w.costUsd != null ? <span className="text-ink-faint">{formatRunCost(w.costUsd)}</span> : null}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </header>

      {/* Manager conversation — the shared run surface (its turn strip walks
          the resume chain; its composer routes to workflow.message). */}
      <div className="min-h-0 flex-1">
        {surface.run ? (
          <RunSurface
            run={surface.run}
            events={surface.events}
            chain={surface.chain}
            diff={surface.diff}
            onRefreshDiff={surface.onRefreshDiff}
            onApplyBranch={surface.onApplyBranch}
            onDiscard={surface.onDiscard}
            merge={surface.merge}
            onCancel={surface.onCancel}
            onSelectTurn={(id) => setTurnId(id === latestTurn?.id ? null : id)}
            onSend={terminal ? undefined : (text) => message(workflow.id, text)}
          />
        ) : (
          <EmptyState icon={MessageSquare} title="Manager session">
            The manager's turns stream here as it refines, plans and dispatches.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/**
 * The committed changes a track branch would merge (`git diff HEAD...branch`),
 * fetched when its chip is opened — the merge preview that pairs with the
 * manager's merge_track tool.
 */
function TrackFilesPanel({ branch }: { branch: string }) {
  const { client } = useCrystal();
  const [result, setResult] = useState<{ files: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setResult(null);
    setError(null);
    client
      .request("git.changedFiles", { scope: "base", ofRef: branch })
      .then((r) => {
        if (alive) setResult(r);
      })
      .catch((err) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [client, branch]);

  return (
    <div className="mt-2 rounded-lg border border-edge bg-surface-0 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-ink-faint">
        <GitBranch className="h-3 w-3" />
        <span className="font-mono normal-case">{branch}</span>
        {result ? (
          <span>
            {result.files.length} file{result.files.length === 1 ? "" : "s"} vs the main line
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1 text-[11px] text-danger">{error}</p>
      ) : result == null ? (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <Spinner className="h-3 w-3" /> Diffing…
        </div>
      ) : result.files.length === 0 ? (
        <p className="mt-1 text-[11px] text-ink-faint">
          No committed changes beyond the main line — the track's work is still uncommitted in
          its worktree, or already merged.
        </p>
      ) : (
        <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed text-ink-muted">
          {result.files.map((f) => (
            <li key={f} className="truncate">
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewWorkflowPanel({
  onStarted,
  onEditTemplates,
}: {
  onStarted: (id: string) => void;
  onEditTemplates?: () => void;
}) {
  const start = useWorkflows((s) => s.start);
  const templates = useWorkflows((s) => s.templates);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const roster = useWorkspace((s) => s.roster);
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudgetInput] = useState("");
  const [runCap, setRunCapInput] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [templateId, setTemplateId] = useState<string>("");
  /** "" = the roster preset's manager model; anything else overrides this run. */
  const [managerModel, setManagerModel] = useState<string>("");
  const preset = presetById(roster?.preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A one-off graph for this run. Held here and passed to `start`, which
   * snapshots it into the workflow — nothing is written to the library, so
   * tweaking one run can never drift the template other runs use.
   */
  const [tweak, setTweak] = useState<WorkflowTemplate | null>(null);

  const template = templates.find((t) => t.id === templateId) ?? templates[0] ?? null;
  const effective = tweak ?? template;
  const tweakProblems = useMemo(
    () => (tweak ? validateWorkflowTemplate(tweak) : []),
    [tweak],
  );

  // Switching template abandons a tweak of the *previous* one — keeping it
  // would silently start a workflow on a graph the picker no longer shows.
  const selectTemplate = (id: string) => {
    setTemplateId(id);
    setTweak(null);
  };

  async function create(interactive = false) {
    if (!name.trim() || !goal.trim() || busy || tweakProblems.length) return;
    setBusy(true);
    setError(null);
    try {
      const n = Number(budget);
      const cap = Number(runCap);
      const { workflow, run } = await start({
        name: name.trim(),
        goal: goal.trim(),
        templateId: template?.id,
        template: tweak,
        projectId: projectId || null,
        managerModel: managerModel || null,
        budgetUsd: budget.trim() !== "" && Number.isFinite(n) ? n : null,
        runCapUsd: runCap.trim() !== "" && Number.isFinite(cap) ? cap : null,
        interactive,
      });
      onStarted(workflow.id);
      // The interactive manager lives in the terminal panel — surface it.
      if (interactive && activeWs && run.terminalId) {
        await focusTerminal(activeWs, run.terminalId);
      }
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
          <Select
            className="flex-1"
            value={template?.id ?? ""}
            onChange={(e) => selectTemplate(e.target.value)}
            aria-label="Workflow template"
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.stages.length} stages)
              </option>
            ))}
          </Select>
          <Tooltip content="Change the stages for this run only — the template is untouched">
            <Button
              variant="ghost"
              size="sm"
              disabled={!template}
              className={cn(tweak && "bg-surface-3 text-ink")}
              onClick={() =>
                setTweak((current) =>
                  current
                    ? null
                    : template
                      ? {
                          ...template,
                          stages: template.stages.map((s) => ({
                            ...s,
                            dependsOn: [...s.dependsOn],
                          })),
                        }
                      : null,
                )
              }
            >
              <SlidersHorizontal className="h-3 w-3" /> Customise for this run
            </Button>
          </Tooltip>
          <Button variant="ghost" size="sm" onClick={() => onEditTemplates?.()}>
            <LayoutTemplate className="h-3 w-3" /> Edit templates
          </Button>
        </div>

        {tweak ? (
          <div className="mt-2 overflow-hidden rounded-lg border border-crystal-500/30">
            <div className="flex items-center gap-2 border-b border-edge bg-surface-2 px-2 py-1">
              <span className="text-[11px] text-ink-muted">
                This run only — <span className="text-ink">{template?.name}</span> stays as it is.
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => setTweak(null)}
              >
                Reset
              </Button>
            </div>
            <TemplateEditor
              template={tweak}
              onChange={setTweak}
              className="h-80"
            />
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={budget}
            onChange={(e) => setBudgetInput(e.target.value)}
            placeholder="Budget USD (optional)"
            aria-label="Budget in USD"
            className="w-40"
          />
          <Tooltip content="Per-run cost cap: any single run (manager turns included) crossing it is killed mid-flight — the lever against one runaway resume.">
            <Input
              value={runCap}
              onChange={(e) => setRunCapInput(e.target.value)}
              placeholder="$/run cap"
              aria-label="Per-run cost cap in USD"
              className="w-24"
            />
          </Tooltip>
          <Select
            className="flex-1"
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
          </Select>
          <Tooltip content={`The orchestrator model for this run only. The project preset (${preset.name}) is set on the Agents tab.`}>
            <Select
              className="w-44"
              value={managerModel}
              onChange={(e) => setManagerModel(e.target.value)}
              aria-label="Manager model"
            >
              <option value="">Manager: {preset.manager} (preset)</option>
              {/* "" already means "follow the preset", so the auto sentinel is redundant here. */}
              {MODEL_HINTS.filter((m) => m !== AUTO_MODEL && m !== preset.manager).map((m) => (
                <option key={m} value={m}>
                  Manager: {m}
                </option>
              ))}
            </Select>
          </Tooltip>
          {/* Interactive is the default: the manager runs as a native Claude
              session in the terminal panel. Headless stays available for
              unattended workflows. */}
          <Tooltip content="Host the manager as a native interactive Claude session in the terminal panel — it asks you decisions directly (AskUserQuestion, still logged on the board), and you steer it by typing.">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !name.trim() || !goal.trim() || tweakProblems.length > 0}
              onClick={() => void create(true)}
            >
              <TerminalSquare className="h-3 w-3" /> Start
            </Button>
          </Tooltip>
          <Tooltip content="Run the manager headless in the background — steer it from the workflow's composer instead of a terminal.">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !name.trim() || !goal.trim() || tweakProblems.length > 0}
              onClick={() => void create()}
            >
              <Play className="h-3 w-3" /> Start headless
            </Button>
          </Tooltip>
        </div>
        {error ? <p className="mt-2 text-[11px] text-danger">{error}</p> : null}
        {tweakProblems.length ? (
          <p className="mt-2 text-[11px] text-danger">{tweakProblems.join(" ")}</p>
        ) : null}
      </div>

      {effective ? <TemplateSummary template={effective} /> : null}
    </div>
  );
}

/**
 * What the picked template will actually do: the stage chain, and which board
 * column each stage parks its tasks in. Replaces a fixed description of the
 * standard flow — with three built-ins and custom templates, a hardcoded
 * summary is wrong more often than it is right.
 */
function TemplateSummary({ template }: { template: WorkflowTemplate }) {
  const columns = useMemo(() => boardColumnStages(template), [template]);
  return (
    <div className="rounded-xl border border-edge bg-surface-1 p-3">
      <div className="mb-1 flex items-center gap-2">
        <Network className="h-3.5 w-3.5 text-crystal-300" />
        <span className="text-[13px] font-semibold text-ink">{template.name}</span>
      </div>
      {template.description ? (
        <p className="mb-2 text-[11px] leading-snug text-ink-muted">{template.description}</p>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-1">
        {template.stages.map((stage, i) => (
          <span key={stage.id} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="h-3 w-3 text-ink-faint" /> : null}
            <Tooltip content={stage.handoff || stage.description || stage.id}>
              <span className="rounded-full border border-edge px-2 py-0.5 text-[10px] text-ink">
                {stage.name}
                {stage.perTrack ? " ∥" : ""}
              </span>
            </Tooltip>
          </span>
        ))}
      </div>

      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        On the board
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {TASK_STATUSES.map((status) => (
          <div key={status} className="rounded-lg border border-edge bg-surface-2 p-1.5">
            <div className="text-[10px] font-medium text-ink">{TASK_STATUS_LABELS[status]}</div>
            <div className="mt-0.5 text-[10px] leading-snug text-ink-muted">
              {columns[status].length
                ? columns[status].map((s) => s.name).join(", ")
                : "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, PanelRight } from "lucide-react";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  deriveTaskAttention,
  groupRunsByManager,
  livenessIndex,
  nowIso,
  openQuestions,
  promptHeadline,
  questionDeliverability,
  type Project,
  type TaskItem,
  type TaskQuestion,
  type TaskStatus,
} from "@crystal/core";
import {
  RunSurface,
  formatRunCost,
  questionDeliveryNotice,
  useAgents,
  useCrystal,
  useRunSurface,
} from "@crystal/client";
import { Button, Select, StatusDot, Tooltip, cn } from "@crystal/ui";
import { messageRun } from "./message-run.js";
import { QuestionRow } from "./QuestionRow.js";
import { RunAgentCard } from "./RunAgentCard.js";

/**
 * The task's live session, anchored beside the task list (operator's
 * SessionView on Crystal's run model): open questions answerable in place,
 * then the run surface — transcript (or the interactive-terminal banner),
 * turn strip, composer, and the worktree diff/merge region. A task with no
 * runs shows the hero instead: description plus the dispatch card, so
 * "read the task → start the agent" happens without leaving the pane.
 * Selection semantics: `selectedRunId` (nav-owned) wins while it belongs to
 * this task; otherwise the newest run is followed automatically — including
 * new dispatches and resumed turns.
 */
export function TaskSession({
  project,
  projectPath,
  task,
  onProjectChange,
  selectedRunId,
  onSelectRun,
  detailsOpen,
  onToggleDetails,
}: {
  project: Project;
  projectPath: string;
  task: TaskItem;
  onProjectChange: (project: Project) => void;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const { client } = useCrystal();
  const runs = useAgents((s) => s.runs);
  const runsById = useMemo(() => livenessIndex(runs), [runs]);
  const [questionNotice, setQuestionNotice] = useState<string | null>(null);
  useEffect(() => setQuestionNotice(null), [task.id]);

  const taskRuns = useMemo(
    () =>
      runs
        .filter((r) => r.taskId === task.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    [runs, task.id],
  );
  const attention = useMemo(() => deriveTaskAttention(task, runs), [task, runs]);

  // Chains, newest last. The session shown is the selected run's (when it is
  // this task's), else the newest chain's face.
  const chains = useMemo(() => groupRunsByManager([...taskRuns].reverse()), [taskRuns]);
  const effectiveRunId = useMemo(() => {
    if (selectedRunId && taskRuns.some((r) => r.id === selectedRunId)) return selectedRunId;
    return taskRuns.length > 0 ? taskRuns[taskRuns.length - 1]!.id : null;
  }, [selectedRunId, taskRuns]);

  const surface = useRunSurface(effectiveRunId);
  const run = surface.run;

  const onSend = useCallback(
    async (text: string) => {
      if (!run) return;
      const result = await messageRun(client, run, text);
      // Follow a delivered message's resumed turn — same contract as RunsPane.
      if (result.runId && result.runId !== run.id) onSelectRun(result.runId);
      return result;
    },
    [client, run, onSelectRun],
  );

  // Follow the conversation when a queued delivery lands later: a new turn
  // grown from the shown tip advances with it (see RunsPane for the rule).
  const lastShown = useRef<string | null>(null);
  const hadSuccessor = useRef(false);
  useEffect(() => {
    if (taskRuns.length === 0) return;
    const successor = effectiveRunId
      ? taskRuns.find((r) => r.resumedFromRunId === effectiveRunId)
      : undefined;
    if (effectiveRunId !== lastShown.current) {
      lastShown.current = effectiveRunId;
      hadSuccessor.current = successor != null;
      return;
    }
    if (!effectiveRunId || hadSuccessor.current || !successor) return;
    onSelectRun(successor.id);
  }, [taskRuns, effectiveRunId, onSelectRun]);

  function patchTask(patch: Partial<TaskItem>): void {
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) =>
        t.id === task.id ? { ...t, ...patch, updatedAt: nowIso() } : t,
      ),
    });
  }

  /** Same answer contract as TaskDetail: record + local patch + follow the resumed run. */
  async function answerQuestion(question: TaskQuestion, answer: string): Promise<void> {
    const result = await client.request("task.answer", {
      path: projectPath,
      taskId: task.id,
      questionId: question.id,
      answer,
    });
    if (!result.ok) throw new Error(result.reason);
    const at = nowIso();
    patchTask({
      questions: task.questions.map((q) =>
        q.id === question.id
          ? {
              ...q,
              answer,
              answeredAt: at,
              closed: { at, reason: "answered" as const, note: null, by: "user" as const },
            }
          : q,
      ),
    });
    // Typed delivery outcome: only a resumed turn moves the surface.
    if (result.delivery === "resumed" && result.runId) onSelectRun(result.runId);
    setQuestionNotice(questionDeliveryNotice(result.delivery));
  }

  async function dismissQuestion(question: TaskQuestion): Promise<void> {
    const result = await client.request("task.dismissQuestion", {
      path: projectPath,
      taskId: task.id,
      questionId: question.id,
    });
    if (!result.ok) throw new Error(result.reason);
    const at = nowIso();
    patchTask({
      questions: task.questions.map((q) =>
        q.id === question.id
          ? {
              ...q,
              closed: { at, reason: "dismissed" as const, note: null, by: "user" as const },
            }
          : q,
      ),
    });
  }

  const waiting = openQuestions(task);
  const blockers = task.blockedBy
    .map((id) => project.tasks.find((t) => t.id === id))
    .filter((t): t is TaskItem => t != null && t.status !== "done");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            attention
              ? "bg-warn animate-pulse"
              : run && (run.status === "running" || run.status === "queued")
                ? "bg-info animate-pulse"
                : task.status === "done"
                  ? "bg-ok"
                  : "bg-ink-faint",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={task.title}>
          {task.title}
        </span>
        <Select
          size="sm"
          value={task.status}
          onChange={(e) => patchTask({ status: e.target.value as TaskStatus })}
          aria-label="Task status"
          className="w-28 shrink-0"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Tooltip content={detailsOpen ? "Hide task details" : "Task details — owners, tags, dependencies, cost"}>
          <Button
            variant={detailsOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Toggle task details"
            onClick={onToggleDetails}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </header>

      {waiting.length > 0 ? (
        <div className="shrink-0 space-y-1.5 border-b border-warn/25 bg-warn/5 px-3 py-2">
          {waiting.map((q) => (
            <QuestionRow
              key={q.id}
              question={q}
              deliverability={questionDeliverability(q, runsById)}
              onAnswer={answerQuestion}
              onDismiss={dismissQuestion}
            />
          ))}
        </div>
      ) : null}
      {questionNotice ? (
        <div className="shrink-0 border-b border-edge bg-surface-2 px-3 py-1.5 text-[11px] text-ink-muted">
          {questionNotice}
        </div>
      ) : null}

      {chains.length > 1 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge bg-surface-1 px-3 py-1">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">Sessions</span>
          {chains.map((node) => {
            const active = node.turns.some((t) => t.id === effectiveRunId);
            return (
              <button
                key={node.run.id}
                type="button"
                onClick={() => onSelectRun(node.run.id)}
                title={node.run.prompt.split("\n")[0]}
                className={cn(
                  "flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  active
                    ? "border-crystal-500/40 bg-crystal-500/15 text-crystal-200"
                    : "border-edge text-ink-muted hover:border-edge-strong hover:text-ink",
                )}
              >
                <StatusDot status={node.run.status} className="h-1.5 w-1.5" />
                <span className="truncate">{promptHeadline(node.run.prompt, 40)}</span>
                <span className="text-ink-faint">{formatRunCost(node.run.costUsd)}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {run ? (
          <RunSurface
            run={run}
            events={surface.events}
            chain={surface.chain}
            diff={surface.diff}
            onRefreshDiff={surface.onRefreshDiff}
            onApplyBranch={surface.onApplyBranch}
            onDiscard={surface.onDiscard}
            merge={surface.merge}
            onSend={onSend}
            onCancel={surface.onCancel}
            onSelectTurn={onSelectRun}
          />
        ) : (
          <TaskHero
            project={project}
            task={task}
            blockers={blockers}
            onProjectChange={onProjectChange}
            onOpenRun={(id) => onSelectRun(id)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Pre-session hero: what the task is, why it can't start (if blocked), and
 * the dispatch card — the session pane never dead-ends on "no runs yet".
 */
function TaskHero({
  project,
  task,
  blockers,
  onProjectChange,
  onOpenRun,
}: {
  project: Project;
  task: TaskItem;
  blockers: TaskItem[];
  onProjectChange: (project: Project) => void;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-xl space-y-4 px-4 py-6">
        <div>
          <h2 className="text-sm font-semibold text-ink">{task.title}</h2>
          {task.description ? (
            <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
              {task.description}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-ink-faint">
              No description yet — the prompt below is what the agent receives.
            </p>
          )}
        </div>
        {blockers.length > 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/5 px-2.5 py-2 text-[11px] text-ink">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <span>
              Blocked by {blockers.map((b) => `“${b.title}”`).join(", ")} — finish{" "}
              {blockers.length === 1 ? "it" : "them"} first, or drop the dependency in details.
            </span>
          </div>
        ) : null}
        <RunAgentCard
          project={project}
          task={task}
          onProjectChange={onProjectChange}
          onOpenRun={onOpenRun}
        />
      </div>
    </div>
  );
}

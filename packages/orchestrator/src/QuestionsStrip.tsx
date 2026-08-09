import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import {
  livenessIndex,
  nowIso,
  openQuestions,
  partitionQuestionRows,
  questionDeliverability,
  type Project,
  type QuestionDeliverability,
  type TaskItem,
  type TaskQuestion,
} from "@crystal/core";
import {
  QuestionCard,
  questionDeliveryNotice,
  useAgents,
  useCrystal,
} from "@crystal/client";
import { Button } from "@crystal/ui";

interface StripRow {
  task: TaskItem;
  question: TaskQuestion;
  deliverability: QuestionDeliverability;
}

/**
 * The board's questions inbox: actionable questions stay prominent and
 * answerable; definitively stale agent asks move into one collapsed trailing
 * section where they can be dismissed without pretending an answer is read.
 */
export function QuestionsStrip({
  project,
  projectPath,
  onProjectChange,
  onOpenTask,
  onOpenRun,
}: {
  project: Project;
  projectPath: string;
  onProjectChange: (project: Project) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { client } = useCrystal();
  const runs = useAgents((s) => s.runs);
  const runsById = useMemo(() => livenessIndex(runs), [runs]);
  const rows = useMemo(
    () =>
      project.tasks.flatMap((task) =>
        openQuestions(task).map((question) => ({
          task,
          question,
          deliverability: questionDeliverability(question, runsById),
        })),
      ),
    [project.tasks, runsById],
  );
  const { actionable, stale } = useMemo(() => partitionQuestionRows(rows), [rows]);
  const [collapsed, setCollapsed] = useState(false);
  const [staleCollapsed, setStaleCollapsed] = useState(true);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [dismissProgress, setDismissProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  useEffect(() => {
    setDeliveryNotice(null);
    setDismissError(null);
  }, [projectPath]);

  if (rows.length === 0 && deliveryNotice == null) return null;

  function closeDismissed(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    const at = nowIso();
    onProjectChange({
      ...project,
      tasks: project.tasks.map((task) => {
        if (!task.questions.some((question) => ids.has(question.id))) return task;
        return {
          ...task,
          questions: task.questions.map((question) =>
            ids.has(question.id)
              ? {
                  ...question,
                  closed: {
                    at,
                    reason: "dismissed" as const,
                    note: null,
                    by: "user" as const,
                  },
                }
              : question,
          ),
          updatedAt: at,
        };
      }),
    });
  }

  async function dismissOne(row: StripRow): Promise<void> {
    setDismissError(null);
    const result = await client.request("task.dismissQuestion", {
      path: projectPath,
      taskId: row.task.id,
      questionId: row.question.id,
    });
    if (!result.ok) throw new Error(result.reason);
    closeDismissed(new Set([row.question.id]));
  }

  async function dismissAllStale(): Promise<void> {
    if (dismissProgress) return;
    setDismissError(null);
    setDismissProgress({ done: 0, total: stale.length });
    const dismissed = new Set<string>();
    const failures: string[] = [];
    for (let i = 0; i < stale.length; i += 1) {
      const row = stale[i]!;
      try {
        const result = await client.request("task.dismissQuestion", {
          path: projectPath,
          taskId: row.task.id,
          questionId: row.question.id,
        });
        if (!result.ok) throw new Error(result.reason);
        dismissed.add(row.question.id);
      } catch (error) {
        failures.push((error as Error).message);
      }
      setDismissProgress({ done: i + 1, total: stale.length });
    }
    closeDismissed(dismissed);
    if (failures.length > 0) {
      setDismissError(
        `Failed to dismiss ${failures.length} stale question${failures.length === 1 ? "" : "s"}: ${failures[0]}`,
      );
    }
    setDismissProgress(null);
  }

  return (
    <div className="border-b border-edge bg-surface-1">
      {actionable.length > 0 ? (
        <section className="bg-warn/5">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-warn"
          >
            {collapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            <CircleHelp className="h-3.5 w-3.5" />
            {actionable.length} question{actionable.length === 1 ? "" : "s"} waiting on you
            <span className="font-normal text-ink-faint">
              — the asking runs are stopped until answered
            </span>
          </button>
          {collapsed ? null : (
            <div className="max-h-64 space-y-2 overflow-y-auto px-3 pb-2.5">
              {actionable.map((row) => (
                <StripQuestion
                  key={row.question.id}
                  row={row}
                  project={project}
                  projectPath={projectPath}
                  onProjectChange={onProjectChange}
                  onOpenTask={onOpenTask}
                  onOpenRun={onOpenRun}
                  onDeliveryNotice={setDeliveryNotice}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {deliveryNotice ? (
        <p className="border-t border-edge bg-surface-2 px-3 py-1.5 text-[11px] text-ink-muted">
          {deliveryNotice}
        </p>
      ) : null}

      {stale.length > 0 ? (
        <section className={actionable.length > 0 || deliveryNotice ? "border-t border-edge" : ""}>
          <div className="flex items-center gap-2 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setStaleCollapsed((value) => !value)}
              aria-expanded={!staleCollapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-medium text-ink-faint"
            >
              {staleCollapsed ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              Stale ({stale.length})
            </button>
            <Button
              variant="ghost"
              size="sm"
              disabled={dismissProgress != null}
              onClick={() => void dismissAllStale()}
            >
              {dismissProgress
                ? `Dismissing ${dismissProgress.done}/${dismissProgress.total}…`
                : "Dismiss all stale"}
            </Button>
          </div>
          {staleCollapsed ? null : (
            <div className="max-h-64 space-y-2 overflow-y-auto px-3 pb-2.5">
              {stale.map((row) => (
                <StaleStripQuestion
                  key={row.question.id}
                  row={row}
                  project={project}
                  onOpenTask={onOpenTask}
                  onDismiss={dismissOne}
                  disabled={dismissProgress != null}
                />
              ))}
            </div>
          )}
          {dismissError ? (
            <p className="px-3 pb-2 text-[10px] text-danger">{dismissError}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function QuestionContext({
  project,
  task,
  question,
  onOpenTask,
  muted = false,
}: {
  project: Project;
  task: TaskItem;
  question: TaskQuestion;
  onOpenTask: (taskId: string) => void;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={`truncate font-semibold ${muted ? "text-ink-faint" : "text-ink"}`}>
        {project.name}
      </span>
      <span className="text-ink-faint">/</span>
      <button
        type="button"
        onClick={() => onOpenTask(task.id)}
        title="Open the task"
        className={
          muted
            ? "truncate text-ink-faint hover:text-ink-muted hover:underline"
            : "truncate text-ink-muted hover:text-ink hover:underline"
        }
      >
        {task.title}
      </button>
      {question.runId ? (
        <>
          <span className="text-ink-faint">/</span>
          <span className="shrink-0 font-mono text-ink-faint">{question.runId.slice(0, 12)}</span>
        </>
      ) : null}
    </div>
  );
}

function StripQuestion({
  row,
  project,
  projectPath,
  onProjectChange,
  onOpenTask,
  onOpenRun,
  onDeliveryNotice,
}: {
  row: StripRow;
  project: Project;
  projectPath: string;
  onProjectChange: (project: Project) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
  onDeliveryNotice: (notice: string) => void;
}) {
  const { client } = useCrystal();
  const { task, question } = row;

  async function send(answer: string) {
    const result = await client.request("task.answer", {
      path: projectPath,
      taskId: task.id,
      questionId: question.id,
      answer,
    });
    if (!result.ok) throw new Error(result.reason);
    const at = nowIso();
    onProjectChange({
      ...project,
      tasks: project.tasks.map((candidate) =>
        candidate.id === task.id
          ? {
              ...candidate,
              questions: candidate.questions.map((candidateQuestion) =>
                candidateQuestion.id === question.id
                  ? {
                      ...candidateQuestion,
                      answer,
                      answeredAt: at,
                      closed: {
                        at,
                        reason: "answered" as const,
                        note: null,
                        by: "user" as const,
                      },
                    }
                  : candidateQuestion,
              ),
              updatedAt: at,
            }
          : candidate,
      ),
    });
    if (result.delivery === "resumed" && result.runId) onOpenRun(result.runId);
    onDeliveryNotice(questionDeliveryNotice(result.delivery));
  }

  return (
    <QuestionCard
      context={
        <QuestionContext
          project={project}
          task={task}
          question={question}
          onOpenTask={onOpenTask}
        />
      }
      question={question.text}
      options={question.options.map((option) => ({ value: option, label: option }))}
      recommended={question.recommended}
      onAnswer={send}
      answerLabel={`Answer the question on ${task.title}`}
      className="bg-surface-1/80"
      title={row.deliverability === "unknown" ? "liveness unavailable" : undefined}
    />
  );
}

function StaleStripQuestion({
  row,
  project,
  onOpenTask,
  onDismiss,
  disabled,
}: {
  row: StripRow;
  project: Project;
  onOpenTask: (taskId: string) => void;
  onDismiss: (row: StripRow) => Promise<void>;
  disabled: boolean;
}) {
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className="rounded-xl border border-edge bg-surface-2 p-3 text-ink-faint">
      <header className="flex items-start gap-2 border-b border-edge/70 pb-2">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1 text-[10px] font-medium">
          <QuestionContext
            project={project}
            task={row.task}
            question={row.question}
            onOpenTask={onOpenTask}
            muted
          />
        </div>
        <span className="shrink-0 rounded-full border border-edge px-1.5 py-0.5 text-[9px] font-medium">
          asker gone
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || dismissing}
          onClick={() => {
            setDismissing(true);
            setError(null);
            void onDismiss(row)
              .catch((caught: Error) => setError(caught.message))
              .finally(() => setDismissing(false));
          }}
        >
          {dismissing ? "Dismissing…" : "Dismiss"}
        </Button>
      </header>
      <p className="whitespace-pre-wrap py-3 text-sm leading-relaxed text-ink-faint">
        {row.question.text}
      </p>
      {error ? <p className="text-[10px] text-danger">{error}</p> : null}
    </article>
  );
}

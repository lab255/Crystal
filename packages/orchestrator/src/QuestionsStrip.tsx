import { useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import {
  nowIso,
  openQuestions,
  type Project,
  type TaskItem,
  type TaskQuestion,
} from "@crystal/core";
import { QuestionCard, useCrystal } from "@crystal/client";

/**
 * The board's questions inbox: every unanswered agent question on this
 * project, pinned above the columns and answerable in place. Before this,
 * a question lived behind a card badge and a task-detail scroll — a stopped
 * run could wait hours for an answer nobody knew was owed.
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
  const [collapsed, setCollapsed] = useState(false);

  const waiting = project.tasks.flatMap((task) =>
    openQuestions(task).map((question) => ({ task, question })),
  );
  if (waiting.length === 0) return null;

  return (
    <div className="border-b border-warn/25 bg-warn/5">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-medium text-warn"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        <CircleHelp className="h-3.5 w-3.5" />
        {waiting.length} question{waiting.length === 1 ? "" : "s"} waiting on you
        <span className="font-normal text-ink-faint">
          — the asking runs are stopped until answered
        </span>
      </button>
      {collapsed ? null : (
        <div className="max-h-64 space-y-2 overflow-y-auto px-3 pb-2.5">
          {waiting.map(({ task, question }) => (
            <StripQuestion
              key={question.id}
              task={task}
              question={question}
              project={project}
              projectPath={projectPath}
              onProjectChange={onProjectChange}
              onOpenTask={onOpenTask}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StripQuestion({
  task,
  question,
  project,
  projectPath,
  onProjectChange,
  onOpenTask,
  onOpenRun,
}: {
  task: TaskItem;
  question: TaskQuestion;
  project: Project;
  projectPath: string;
  onProjectChange: (project: Project) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { client } = useCrystal();

  /**
   * Same contract as TaskDetail's answer path: record server-side, then patch
   * the answer into the local project too — board props don't refetch on
   * `workspace.changed`, and a later whole-project save from a stale snapshot
   * would silently reopen the question (newest-updatedAt merge).
   */
  async function send(answer: string): Promise<void> {
    const result = await client.request("task.answer", {
      path: projectPath,
      taskId: task.id,
      questionId: question.id,
      answer,
    });
    if (!result.ok) throw new Error(result.reason);
    onProjectChange({
      ...project,
      tasks: project.tasks.map((t) =>
        t.id === task.id
          ? {
              ...t,
              questions: t.questions.map((q) =>
                q.id === question.id ? { ...q, answer, answeredAt: nowIso() } : q,
              ),
              updatedAt: nowIso(),
            }
          : t,
      ),
    });
    if (result.resumedRunId) onOpenRun(result.resumedRunId);
  }

  return (
    <QuestionCard
      context={
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-ink">{project.name}</span>
          <span className="text-ink-faint">/</span>
          <button
            type="button"
            onClick={() => onOpenTask(task.id)}
            title="Open the task"
            className="truncate text-ink-muted hover:text-ink hover:underline"
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
      }
      question={question.text}
      options={question.options.map((option) => ({ value: option, label: option }))}
      recommended={question.recommended}
      onAnswer={send}
      answerLabel={`Answer the question on ${task.title}`}
      className="bg-surface-1/80"
    />
  );
}

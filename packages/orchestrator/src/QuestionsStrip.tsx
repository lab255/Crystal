import { useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp, Send } from "lucide-react";
import {
  nowIso,
  openQuestions,
  type Project,
  type TaskItem,
  type TaskQuestion,
} from "@crystal/core";
import { enterKeyAction, useCrystal, useSettings } from "@crystal/client";
import { Button, Textarea, cn } from "@crystal/ui";

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
              soloOpen={waiting.length === 1}
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
  soloOpen,
}: {
  task: TaskItem;
  question: TaskQuestion;
  project: Project;
  projectPath: string;
  onProjectChange: (project: Project) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
  soloOpen: boolean;
}) {
  const { client } = useCrystal();
  const [answering, setAnswering] = useState(soloOpen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const enterToSend = useSettings((s) => s.enterToSend);
  const [error, setError] = useState<string | null>(null);

  /**
   * Same contract as TaskDetail's answer path: record server-side, then patch
   * the answer into the local project too — board props don't refetch on
   * `workspace.changed`, and a later whole-project save from a stale snapshot
   * would silently reopen the question (newest-updatedAt merge).
   */
  async function send() {
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    try {
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
      setText("");
      if (result.resumedRunId) onOpenRun(result.resumedRunId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-edge bg-surface-1/80 p-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 whitespace-pre-wrap text-[11px] leading-snug text-ink">
          {question.text}
        </span>
        <button
          type="button"
          onClick={() => onOpenTask(task.id)}
          title="Open the task"
          className="max-w-40 shrink-0 truncate text-[10px] text-ink-faint hover:text-ink hover:underline"
        >
          {task.title}
        </button>
      </div>
      {answering ? (
        <div className="mt-1.5 flex items-end gap-2">
          <Textarea
            autoFocus={!soloOpen}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (enterKeyAction(e, enterToSend) === "send") {
                e.preventDefault();
                void send();
              }
              if (e.key === "Escape") setAnswering(false);
            }}
            rows={2}
            placeholder="Your answer — it resumes the run that stopped for it"
            aria-label={`Answer the question on ${task.title}`}
            className="min-h-0 flex-1"
          />
          <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
            <Send className="h-3 w-3" /> Answer
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAnswering(true)}
          className={cn("mt-1 text-[10px] text-warn hover:underline")}
        >
          Answer…
        </button>
      )}
      {error ? <p className="mt-1 text-[10px] text-danger">{error}</p> : null}
    </div>
  );
}

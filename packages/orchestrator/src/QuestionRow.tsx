import { useState } from "react";
import { CircleHelp, Send } from "lucide-react";
import {
  isQuestionActionableWithDeliverability,
  questionClosure,
  type QuestionDeliverability,
  type TaskQuestion,
} from "@crystal/core";
import { enterKeyAction, useSettings } from "@crystal/client";
import { Button, Textarea, cn } from "@crystal/ui";

/**
 * One task question, answerable in place: option buttons (the agent's
 * recommendation highlighted) or free text. Shared by the task-detail aside
 * and the task session pane — the answer contract (`task.answer` + local
 * patch) stays with the caller.
 */
export function QuestionRow({
  question,
  onAnswer,
  deliverability,
  onDismiss,
}: {
  question: TaskQuestion;
  onAnswer: (question: TaskQuestion, answer: string) => Promise<void>;
  deliverability?: QuestionDeliverability;
  onDismiss?: (question: TaskQuestion) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enterToSend = useSettings((s) => s.enterToSend);
  // Closure-aware: dismissed/expired questions render closed too, with the
  // closure note instead of an answer line.
  const closure = questionClosure(question);
  const answered = closure != null;
  const stale =
    !answered &&
    deliverability != null &&
    !isQuestionActionableWithDeliverability(question, deliverability);
  const livenessUnavailable =
    !answered && (deliverability == null || deliverability === "unknown");

  return (
    <div
      title={livenessUnavailable ? "liveness unavailable" : undefined}
      className={cn(
        "rounded-lg border px-2.5 py-2",
        answered
          ? "border-edge bg-surface-2 opacity-70"
          : stale
            ? "border-edge bg-surface-2"
            : "border-warn/30 bg-warn/5",
      )}
    >
      <div
        className={cn(
          "flex items-start gap-1.5 text-[11px] leading-snug",
          stale ? "text-ink-faint" : "text-ink",
        )}
      >
        <CircleHelp
          className={cn(
            "mt-0.5 h-3 w-3 shrink-0",
            answered || stale ? "text-ink-faint" : "text-warn",
          )}
        />
        <span className="min-w-0 flex-1 whitespace-pre-wrap">{question.text}</span>
        {stale ? (
          <span className="shrink-0 rounded-full border border-edge px-1.5 py-0.5 text-[9px] font-medium text-ink-faint">
            asker gone
          </span>
        ) : null}
        {stale && onDismiss ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={sending}
            onClick={() => {
              setSending(true);
              setError(null);
              void onDismiss(question)
                .catch((err: Error) => setError(err.message))
                .finally(() => setSending(false));
            }}
          >
            Dismiss
          </Button>
        ) : null}
      </div>
      {answered ? (
        <div className="mt-1 pl-4.5 text-[11px] text-ink-muted">
          {closure!.reason === "answered"
            ? `↳ ${question.answer}`
            : `↳ ${closure!.reason}${closure!.note ? ` — ${closure!.note}` : ""}`}
        </div>
      ) : stale ? null : (
        <>
          {question.options.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-4.5">
              {question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={sending}
                  title={
                    option === question.recommended
                      ? "Answer with this option (the agent's recommendation)"
                      : "Answer with this option"
                  }
                  onClick={() => {
                    setSending(true);
                    setError(null);
                    void onAnswer(question, option)
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setSending(false));
                  }}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                    option === question.recommended
                      ? "border-warn/50 bg-warn/10 font-medium text-ink hover:bg-warn/20"
                      : "border-edge bg-surface-1 text-ink-muted hover:border-warn/40 hover:text-ink",
                  )}
                >
                  {option}
                  {option === question.recommended ? (
                    <span className="ml-1 text-[9px] uppercase tracking-wide text-warn">rec</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 flex items-end gap-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (enterKeyAction(e, enterToSend) === "send" && draft.trim()) {
                  e.preventDefault();
                  setSending(true);
                  setError(null);
                  void onAnswer(question, draft.trim())
                    .catch((err: Error) => setError(err.message))
                    .finally(() => setSending(false));
                }
              }}
              rows={2}
              placeholder={question.options.length ? "Or answer in your own words…" : "Your answer…"}
              className="text-[11px]"
              aria-label="Answer"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={sending || !draft.trim()}
              onClick={() => {
                setSending(true);
                setError(null);
                void onAnswer(question, draft.trim())
                  .catch((err: Error) => setError(err.message))
                  .finally(() => setSending(false));
              }}
              aria-label="Submit answer"
            >
              <Send className="h-3 w-3" />
            </Button>
          </div>
        </>
      )}
      {error ? <p className="mt-1 pl-4.5 text-[10px] text-danger">{error}</p> : null}
    </div>
  );
}

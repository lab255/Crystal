import { useState } from "react";
import { CircleHelp, Send } from "lucide-react";
import type { TaskQuestion } from "@crystal/core";
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
}: {
  question: TaskQuestion;
  onAnswer: (question: TaskQuestion, answer: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = question.answer != null;

  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2",
        answered ? "border-edge bg-surface-2 opacity-70" : "border-warn/30 bg-warn/5",
      )}
    >
      <div className="flex items-start gap-1.5 text-[11px] leading-snug text-ink">
        <CircleHelp className={cn("mt-0.5 h-3 w-3 shrink-0", answered ? "text-ink-faint" : "text-warn")} />
        <span className="whitespace-pre-wrap">{question.text}</span>
      </div>
      {answered ? (
        <div className="mt-1 pl-4.5 text-[11px] text-ink-muted">↳ {question.answer}</div>
      ) : (
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
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && draft.trim()) {
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
              aria-label="Send answer and resume the agent"
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

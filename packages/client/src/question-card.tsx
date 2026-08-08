import { useState, type ReactNode } from "react";
import { CircleHelp, Send } from "lucide-react";
import { Button, Textarea, cn } from "@crystal/ui";
import { useComposerKeydown } from "./settings.js";

export interface QuestionCardOption {
  /** The exact answer sent back to the asking run. */
  value: string;
  /** Prominent human-facing choice label. */
  label: string;
  /** Optional supporting detail below the label. */
  description?: string | null;
  recommended?: boolean;
}

export interface QuestionCardProps {
  context: ReactNode;
  question: string;
  options?: readonly QuestionCardOption[];
  recommended?: string | null;
  onAnswer: (answer: string) => Promise<void>;
  action?: ReactNode;
  answerLabel?: string;
  className?: string;
}

/**
 * Shared answering surface for the project and portfolio inboxes. Choice
 * clicks optimistically hide the card; a rejected answer restores it with
 * the error, while a successful caller removes it from its source store.
 */
export function QuestionCard({
  context,
  question,
  options = [],
  recommended = null,
  onAnswer,
  action,
  answerLabel = "Answer question",
  className,
}: QuestionCardProps) {
  const [draft, setDraft] = useState("");
  const [otherOpen, setOtherOpen] = useState(options.length === 0);
  const [submitting, setSubmitting] = useState(false);
  const [optimisticHidden, setOptimisticHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(rawAnswer: string): Promise<void> {
    const answer = rawAnswer.trim();
    if (!answer || submitting) return;
    setSubmitting(true);
    setOptimisticHidden(true);
    setError(null);
    try {
      await onAnswer(answer);
      setDraft("");
    } catch (err) {
      setOptimisticHidden(false);
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const onComposerKeydown = useComposerKeydown(() => void submit(draft));

  if (optimisticHidden) return null;

  return (
    <article
      className={cn(
        "rounded-xl border border-edge bg-surface-1 p-3",
        className,
      )}
    >
      <header className="flex items-start gap-2 border-b border-edge/70 pb-2">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1 text-[10px] font-medium text-ink-muted">{context}</div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>

      <p className="whitespace-pre-wrap py-3 text-sm leading-relaxed text-ink">{question}</p>

      {options.length > 0 ? (
        <div className="grid gap-2">
          {options.map((option) => {
            const isRecommended = option.recommended || option.value === recommended;
            return (
              <button
                key={option.value}
                type="button"
                disabled={submitting}
                onClick={() => void submit(option.value)}
                className={cn(
                  "w-full rounded-lg border px-4 py-3 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crystal-400/60",
                  isRecommended
                    ? "border-crystal-500/50 bg-crystal-500/10 hover:bg-crystal-500/15"
                    : "border-edge bg-surface-2 hover:border-crystal-500/40 hover:bg-surface-3",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {option.label}
                  {isRecommended ? (
                    <span className="rounded-full bg-crystal-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-crystal-300">
                      Recommended
                    </span>
                  ) : null}
                </span>
                {option.description ? (
                  <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                    {option.description}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {options.length > 0 && !otherOpen ? (
        <button
          type="button"
          onClick={() => setOtherOpen(true)}
          className="mt-2 rounded-md px-1 py-1 text-xs font-medium text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crystal-400/60"
        >
          Other…
        </button>
      ) : null}

      {otherOpen ? (
        <div className={cn("flex items-end gap-2", options.length > 0 && "mt-2")}>
          <Textarea
            autoFocus={options.length > 0}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              onComposerKeydown(event);
              if (event.key === "Escape" && options.length > 0) setOtherOpen(false);
            }}
            rows={3}
            placeholder={options.length > 0 ? "Your other answer…" : "Your answer…"}
            aria-label={answerLabel}
            className="min-h-0 flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={submitting || !draft.trim()}
            onClick={() => void submit(draft)}
            aria-label="Submit answer and resume the asking run"
          >
            <Send className="h-3.5 w-3.5" /> Answer
          </Button>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </article>
  );
}

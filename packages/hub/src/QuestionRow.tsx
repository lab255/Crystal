import { useState } from "react";
import { ExternalLink, Send } from "lucide-react";
import type { HubQuestion } from "@crystal/core";
import { enterKeyAction, useHub, useSettings } from "@crystal/client";
import { Button, Textarea, Tooltip, cn } from "@crystal/ui";
import { useCrossWorkspaceNav } from "./common.js";

/**
 * One question a project stopped for. Answer it here — the answer is recorded
 * on that project's board and handed straight back to the run that asked, so
 * the delivery carries on — or open the task if it needs more context than a
 * line of text.
 */
export function QuestionRow({
  programId,
  question,
  defaultOpen = false,
}: {
  programId: string;
  question: HubQuestion;
  /** Start with the answer box open — the Questions view does, headers don't. */
  defaultOpen?: boolean;
}) {
  const answerQuestion = useHub((s) => s.answerQuestion);
  const enterToSend = useSettings((s) => s.enterToSend);
  const goToProject = useCrossWorkspaceNav();
  const [answering, setAnswering] = useState(defaultOpen);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    const result = await answerQuestion(programId, question.questionId, answer).catch(
      (err: Error) => ({ ok: false as const, reason: err.message }),
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    // On success the question leaves the store and this row unmounts.
    setText("");
    setAnswering(false);
  }

  return (
    <div className="mt-1">
      <div className="flex items-start gap-1.5">
        {/* Collapsed rows clamp, never single-line truncate — and answering
            shows the whole question: you can't answer what you can't read. */}
        <button
          type="button"
          onClick={() => setAnswering((v) => !v)}
          title={answering ? undefined : question.text}
          className={cn(
            "min-w-0 flex-1 text-left text-[11px] leading-snug text-ink hover:underline",
            !answering && "line-clamp-2",
          )}
        >
          <span className="font-medium text-warn">{question.projectName}</span>{" "}
          <span className={cn(answering && "whitespace-pre-wrap")}>{question.text}</span>
          <span className="text-ink-faint"> — {question.taskTitle}</span>
        </button>
        <Tooltip content="Open the task on that project's board">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open the task"
            onClick={() =>
              goToProject(question.ws, {
                mode: "orchestrate",
                orchestrate: { tab: "board", task: question.taskId },
              })
            }
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>
      {answering ? (
        <div className="mt-1 flex items-end gap-2">
          <Textarea
            autoFocus={!defaultOpen}
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
            placeholder="Your answer — it goes back to the run that stopped for it"
            aria-label={`Answer ${question.projectName}'s question`}
            className="min-h-0 flex-1"
          />
          <Button variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
            <Send className="h-3 w-3" /> Answer
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[10px] text-danger">{error}</p> : null}
    </div>
  );
}

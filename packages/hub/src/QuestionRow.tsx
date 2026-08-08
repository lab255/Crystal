import { ExternalLink } from "lucide-react";
import type { HubQuestion } from "@crystal/core";
import { QuestionCard, useHub } from "@crystal/client";
import { Button, Tooltip } from "@crystal/ui";
import { useCrossWorkspaceNav } from "./common.js";

type StructuredHubQuestion = HubQuestion & {
  options?: string[];
  recommended?: string | null;
};

/**
 * One question a project stopped for. Answer it here — the answer is recorded
 * on that project's board and handed straight back to the run that asked, so
 * the delivery carries on — or open the task if it needs more context than a
 * line of text.
 */
export function QuestionRow({
  programId,
  programName,
  question,
}: {
  programId: string;
  programName: string;
  question: StructuredHubQuestion;
}) {
  const answerQuestion = useHub((s) => s.answerQuestion);
  const goToProject = useCrossWorkspaceNav();

  async function send(answer: string) {
    const result = await answerQuestion(programId, question.questionId, answer).catch(
      (err: Error) => ({ ok: false as const, reason: err.message }),
    );
    if (!result.ok) throw new Error(result.reason);
    if (!result.resumedRunId) {
      return {
        notice:
          "Recorded on the board — the asking session will pick it up if it resumes.",
      };
    }
  }

  return (
    <QuestionCard
      context={
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-ink">{programName}</span>
          <span className="text-ink-faint">/</span>
          <span className="truncate">{question.projectName}</span>
          <span className="text-ink-faint">/</span>
          <span className="truncate">{question.taskTitle}</span>
        </div>
      }
      question={question.text}
      options={(question.options ?? []).map((option) => ({ value: option, label: option }))}
      recommended={question.recommended}
      onAnswer={send}
      answerLabel={`Answer ${question.projectName}'s question`}
      action={
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
      }
    />
  );
}

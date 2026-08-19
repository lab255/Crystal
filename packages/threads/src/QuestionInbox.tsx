import { useMemo } from "react";
import { ExternalLink, Inbox } from "lucide-react";
import {
  QuestionCard,
  questionDeliveryNotice,
  useAttentionJump,
  useCrystal,
  useFleetNeedsYou,
  useHub,
  type FleetQuestion,
} from "@crystal/client";
import { formatWsRef, type HubQuestion, type Program } from "@crystal/core";
import { Button, EmptyState, Tooltip } from "@crystal/ui";

const EMPTY_PROGRAMS: Program[] = [];

/**
 * Every question waiting on the human, across the whole portfolio: board
 * questions from every open workspace plus program questions from the hub.
 * Each answers in place — the answer is recorded on the asking board and
 * handed straight back to the run that stopped for it.
 */
export function QuestionInbox({ find = "" }: { find?: string }) {
  const fleet = useFleetNeedsYou();
  const programs = useHub((s) => (s.loaded ? s.programs : EMPTY_PROGRAMS));
  const hubQuestions = useHub((s) => s.questions);

  const needle = find.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);

  const workspaceRows = useMemo(
    () =>
      fleet.rows
        .map((row) => ({
          row,
          questions: row.actionableQuestions.filter(
            (q) => matches(q.question.text) || matches(q.taskTitle) || matches(row.name),
          ),
        }))
        .filter((entry) => entry.questions.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fleet.rows, needle],
  );

  const programRows = useMemo(
    () =>
      programs
        .filter((p) => p.status === "running" || p.status === "paused")
        .map((program) => ({
          program,
          questions: (hubQuestions[program.id] ?? []).filter(
            (q) => matches(q.text) || matches(q.taskTitle) || matches(program.name),
          ),
        }))
        .filter((entry) => entry.questions.length > 0)
        .sort((a, b) => b.program.createdAt.localeCompare(a.program.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [programs, hubQuestions, needle],
  );

  const empty = workspaceRows.length === 0 && programRows.length === 0;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3 overflow-y-auto p-4">
      {empty ? (
        <EmptyState icon={Inbox} title="Nothing is waiting on you">
          Questions agents ask land here — and on their thread — until you answer them.
        </EmptyState>
      ) : null}
      {workspaceRows.map(({ row, questions }) => (
        <section key={row.key} className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {row.name}
            {row.serverLabel ? ` · ${row.serverLabel}` : ""}
          </h3>
          {questions.map((q) => (
            <WorkspaceQuestionCard key={q.question.id} sid={row.sid} ws={row.ws} row={q} />
          ))}
        </section>
      ))}
      {programRows.map(({ program, questions }) => (
        <section key={program.id} className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            {program.name}
          </h3>
          {questions.map((q) => (
            <ProgramQuestionCard key={q.questionId} programId={program.id} question={q} />
          ))}
        </section>
      ))}
    </div>
  );
}

function WorkspaceQuestionCard({
  sid,
  ws,
  row,
}: {
  sid: string;
  ws: string;
  row: FleetQuestion;
}) {
  const { client, activeSid } = useCrystal();
  const jump = useAttentionJump();

  async function answer(text: string) {
    // The bridge client talks to the ACTIVE server; a question on another
    // server answers inline on its own thread (the jump switches over).
    if (sid !== activeSid) {
      throw new Error("This question lives on another server — open its thread to answer.");
    }
    const result = await client.request("task.answer", {
      ws,
      path: row.projectPath,
      taskId: row.taskId,
      questionId: row.question.id,
      answer: text,
    });
    if (!result.ok) throw new Error(result.reason);
    // Typed delivery outcome — never collapsed to a boolean.
    return { notice: questionDeliveryNotice(result.delivery) };
  }

  return (
    <QuestionCard
      context={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-ink">{row.projectName}</span>
          <span className="text-ink-faint">/</span>
          <span className="truncate">{row.taskTitle}</span>
        </span>
      }
      question={row.question.text}
      options={row.question.options.map((o) => ({ value: o, label: o }))}
      recommended={row.question.recommended}
      onAnswer={answer}
      action={
        <Tooltip content="Open the thread that asked">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open the thread that asked"
            onClick={() => jump({ kind: "question", sid, ws, question: row })}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        </Tooltip>
      }
    />
  );
}

type StructuredHubQuestion = HubQuestion & {
  options?: string[];
  recommended?: string | null;
};

function ProgramQuestionCard({
  programId,
  question,
}: {
  programId: string;
  question: StructuredHubQuestion;
}) {
  const answerQuestion = useHub((s) => s.answerQuestion);
  const { selectWorkspace, navStore, activeSid } = useCrystal();

  async function answer(text: string) {
    const result = await answerQuestion(programId, question.questionId, text).catch(
      (err: Error) => ({ ok: false as const, reason: err.message }),
    );
    if (!result.ok) throw new Error(result.reason);
    return { notice: questionDeliveryNotice(result.delivery) };
  }

  return (
    <QuestionCard
      context={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-ink">{question.projectName}</span>
          <span className="text-ink-faint">/</span>
          <span className="truncate">{question.taskTitle}</span>
        </span>
      }
      question={question.text}
      options={(question.options ?? []).map((o) => ({ value: o, label: o }))}
      recommended={question.recommended}
      onAnswer={answer}
      action={
        <Tooltip content="Open that project's threads">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open that project's threads"
            onClick={() => {
              // Hub questions carry the workspace on the ACTIVE server — the
              // ws param must ride the server prefix or a bare id resolves
              // against the default server on reload/share.
              selectWorkspace(activeSid, question.ws);
              navStore.getState().update({
                ws: formatWsRef(activeSid, question.ws),
                mode: "threads",
                threads: { compose: null },
              });
            }}
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        </Tooltip>
      }
    />
  );
}

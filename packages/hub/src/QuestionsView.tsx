import { CircleHelp, Target } from "lucide-react";
import { isProgramLive, type HubQuestion, type Program } from "@crystal/core";
import { EMPTY_PROGRAMS, useHub, useNavUpdate } from "@crystal/client";
import { EmptyState } from "@crystal/ui";
import { SectionLabel } from "./common.js";
import { QuestionRow } from "./QuestionRow.js";

/**
 * Every unanswered question across the whole portfolio, one answerable list.
 * This is the "waiting on you" chip made into a place: no guessing which
 * program asked, no drilling into a detail header — the newest questions
 * first, each with its answer box already open.
 */
export function QuestionsView({ find }: { find: string }) {
  const programs = useHub((s) => s.programs) ?? EMPTY_PROGRAMS;
  const questionsByProgram = useHub((s) => s.questions);
  const nav = useNavUpdate();

  const needle = find.trim().toLowerCase();
  const matches = (p: Program, q: HubQuestion) =>
    !needle ||
    p.name.toLowerCase().includes(needle) ||
    q.projectName.toLowerCase().includes(needle) ||
    q.taskTitle.toLowerCase().includes(needle) ||
    q.text.toLowerCase().includes(needle);

  const sections = programs
    .map((program) => ({
      program,
      questions: (questionsByProgram[program.id] ?? [])
        .filter((q) => matches(program, q))
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    }))
    .filter((s) => s.questions.length > 0);
  if (sections.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState icon={CircleHelp} title={needle ? "No matching questions" : "Nothing waiting on you"}>
          {needle
            ? "No open question matches the current filter."
            : "When an agent in any program stops for an answer, the question lands here the moment it's asked."}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4">
        {sections.map(({ program, questions }) => (
          <section key={program.id} className="rounded-xl border border-edge bg-surface-1/60 p-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => nav({ projects: { view: "chat", program: program.id } })}
                title="Open the coordinator chat for this program"
                className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-ink hover:underline"
              >
                <Target className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
                <span className="truncate">{program.name}</span>
              </button>
              <span className="text-[10px] text-ink-faint">
                {questions.length} open
                {isProgramLive(program.status) ? "" : ` · ${program.status}`}
              </span>
            </div>
            <div className="mt-1.5 space-y-2">
              {questions.map((q) => (
                <QuestionRow
                  key={q.questionId}
                  programId={program.id}
                  programName={program.name}
                  question={q}
                />
              ))}
            </div>
          </section>
        ))}
        <SectionLabel className="block px-1">
          Answers go back to the run that asked — the delivery resumes on its own.
        </SectionLabel>
      </div>
    </div>
  );
}

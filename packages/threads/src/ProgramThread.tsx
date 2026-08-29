import { useEffect, useMemo, useState } from "react";
import { Play, PowerOff, RotateCcw } from "lucide-react";
import {
  MessageComposer,
  QuestionCard,
  questionDeliveryNotice,
  useHub,
  type ComposerSendResult,
} from "@crystal/client";
import {
  type AgentRun,
  type HubQuestion,
  type Program,
  type ProgramSpend,
} from "@crystal/core";
import { Button, EmptyState, Input, Textarea, Tooltip } from "@crystal/ui";
import { SpendLine, StatusBadge, parseBudget } from "./spend-line.js";
import { ThreadTranscript } from "./ThreadTranscript.js";
import { buildTranscriptItems } from "./transcript-items.js";
import { programChain } from "./overview/overview-thread-model.js";

const EMPTY_HUB_RUNS: AgentRun[] = [];

export function CreateProgram({
  onCreated,
  onCancel,
}: {
  onCreated: (program: Program) => void;
  onCancel: () => void;
}) {
  const createProgram = useHub((s) => s.createProgram);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      className="mx-auto w-full max-w-xl p-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <h2 className="text-sm font-semibold text-ink">New program</h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        One epic across projects. The program manager splits it into per-project deliveries and
        dispatches each as a workflow inside that project.
      </p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Program name"
        aria-label="Program name"
        className="mt-3"
      />
      <Textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={4}
        placeholder="The goal, in your words…"
        aria-label="Program goal"
        className="mt-2"
      />
      <div className="mt-2 flex items-center gap-2">
        <Input
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          placeholder="Budget USD (optional)"
          aria-label="Budget in USD"
          className="w-44"
        />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !name.trim() || !goal.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const program = await createProgram({
                name: name.trim(),
                goal: goal.trim(),
                budgetUsd: parseBudget(budget),
              });
              onCreated(program);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Create
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

/** The reusable program conversation keeps hub actions honest on every surface. */
export function ProgramSession({
  program,
  onError,
}: {
  program: Program;
  onError?: (message: string) => void;
}) {
  const spend = useHub((s) => s.spend[program.id] as ProgramSpend | undefined);
  const questions = useHub((s) => s.questions[program.id]);
  const runs = useHub((s) => (s.loaded ? s.runs : EMPTY_HUB_RUNS));
  const eventsByRun = useHub((s) => s.eventsByRun);
  const loadRunEvents = useHub((s) => s.loadRunEvents);
  const startManager = useHub((s) => s.startManager);
  const closeManager = useHub((s) => s.closeManager);
  const message = useHub((s) => s.message);
  const retryDelivery = useHub((s) => s.retryDelivery);
  const answerQuestion = useHub((s) => s.answerQuestion);
  const [busy, setBusy] = useState(false);

  // Whether a manager SESSION exists is the program record's call
  // (managerRunId), never "any program-tagged runs exist": closeManager nulls
  // the id but deliberately keeps history in `runs`, and a composer aimed at
  // a detached chain only throws "no manager session — start one first".
  const hasManager = program.managerRunId != null;

  // The manager conversation: this program's hub runs collapsed to a resume
  // chain — anchored on managerRunId when live, else the retired chain's
  // history (rendered read-only below).
  const chain = useMemo(() => programChain(program, runs), [runs, program]);
  const face = chain[chain.length - 1] ?? null;
  const working =
    hasManager && face != null && (face.status === "running" || face.status === "queued");
  const managerNotLive = program.status === "running" && !working;

  useEffect(() => {
    for (const turn of chain.slice(-2)) void loadRunEvents(turn.id);
  }, [chain, loadRunEvents]);

  const items = useMemo(
    () => buildTranscriptItems({ turns: chain, eventsByRun }),
    [chain, eventsByRun],
  );

  async function send(text: string): Promise<ComposerSendResult> {
    const result = await message(program.id, text);
    return { queued: result.queued };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge px-4 py-2 text-[11px] text-ink-muted">
        <StatusBadge status={program.status} />
        {spend ? (
          <SpendLine
            costUsd={spend.costUsd}
            budgetUsd={program.budgetUsd}
            stale={spend.stale}
            showUnbudgeted
          />
        ) : null}
        <div className="flex-1" />
        {hasManager ? (
          <Tooltip content="Close the manager session (history stays)">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await closeManager(program.id);
                } catch (error) {
                  onError?.(error instanceof Error ? error.message : String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <PowerOff className="h-3 w-3" /> Close manager
            </Button>
          </Tooltip>
        ) : null}
      </div>

      {program.deliveries.length ? (
        <div className="flex gap-2 overflow-x-auto border-b border-edge px-4 py-2">
          {program.deliveries.map((delivery) => {
            const dSpend = spend?.byDelivery[delivery.id];
            const terminal =
              delivery.status === "failed" || delivery.status === "cancelled";
            return (
              <div
                key={delivery.id}
                className="flex shrink-0 items-center gap-2 rounded-lg border border-edge bg-surface-1 px-2.5 py-1.5 text-[11px] text-ink"
              >
                <span className="font-medium">{delivery.projectName}</span>
                <StatusBadge status={delivery.status} />
                {dSpend ? (
                  <span className="text-ink-faint">
                    <SpendLine costUsd={dSpend.costUsd} budgetUsd={delivery.budgetUsd} />
                  </span>
                ) : null}
                {terminal ? (
                  <Tooltip content="Queue this delivery again">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Retry ${delivery.projectName}`}
                      onClick={() => {
                        void retryDelivery(program.id, delivery.id).catch((error) =>
                          onError?.(error instanceof Error ? error.message : String(error)),
                        );
                      }}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {face ? (
        <ThreadTranscript
          items={items}
          // Chain-root id — stable across manager wakes; face.id changes on
          // every resume and would reset the user's scroll position.
          threadId={chain[0]!.id}
          working={working}
          onExpandTurn={(runId) => loadRunEvents(runId)}
          renderQuestion={undefined}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon={Play} title="No manager session yet">
            <span className="block max-w-sm text-xs leading-relaxed">
              Start the program manager — it plans deliveries on this chat and drives each
              project's orchestrator.
            </span>
            <StartManagerButton
              busy={busy}
              setBusy={setBusy}
              start={() => startManager(program.id)}
              onError={onError}
              className="mt-3"
            />
          </EmptyState>
        </div>
      )}

      {(questions ?? []).length ? (
        <div className="max-h-64 space-y-2 overflow-y-auto border-t border-edge px-4 py-2">
          {(questions ?? []).map((q: HubQuestion & { options?: string[]; recommended?: string | null }) => (
            <QuestionCard
              key={q.questionId}
              context={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-semibold text-ink">{q.projectName}</span>
                  <span className="text-ink-faint">/</span>
                  <span className="truncate">{q.taskTitle}</span>
                </span>
              }
              question={q.text}
              options={(q.options ?? []).map((o) => ({ value: o, label: o }))}
              recommended={q.recommended}
              onAnswer={async (answer) => {
                const result = await answerQuestion(program.id, q.questionId, answer);
                if (!result.ok) throw new Error(result.reason);
                return { notice: questionDeliveryNotice(result.delivery) };
              }}
            />
          ))}
        </div>
      ) : null}

      {managerNotLive && face ? (
        <div className="flex items-center gap-3 border-t border-warn/30 bg-warn/10 px-4 py-2">
          <span className="flex-1 text-[11px] text-warn">
            Manager session is not live — messages will only be recorded
          </span>
          <StartManagerButton
            busy={busy}
            setBusy={setBusy}
            start={async () => {
              if (hasManager) await closeManager(program.id);
              return startManager(program.id);
            }}
            onError={onError}
          />
        </div>
      ) : hasManager ? (
        <MessageComposer
          onSend={send}
          placeholder="Message the program manager…"
          ariaLabel="Message the program manager"
          className="border-t border-edge"
        />
      ) : face ? (
        // Closed session: the transcript above is read-only history — the
        // way back is starting a fresh manager, never messaging a detached
        // chain (hub.message refuses it anyway).
        <div className="flex items-center gap-3 border-t border-edge px-4 py-2.5">
          <span className="text-[11px] text-ink-muted">
            The manager session is closed — its transcript stays above.
          </span>
          <StartManagerButton
            busy={busy}
            setBusy={setBusy}
            start={() => startManager(program.id)}
            onError={onError}
          />
        </div>
      ) : null}
    </div>
  );
}

export function StartManagerButton({
  busy,
  setBusy,
  start,
  className,
  onError,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  start: () => Promise<unknown>;
  className?: string;
  onError?: (message: string) => void;
}) {
  return (
    <Button
      variant="primary"
      size="sm"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await start();
        } catch (error) {
          onError?.(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Play className="h-3 w-3" /> Start manager
    </Button>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Bot,
  CircleDollarSign,
  CircleHelp,
  ExternalLink,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Rocket,
  RotateCcw,
  Send,
  Target,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  deliveryReadiness,
  emptyDeliverySpend,
  headline,
  isDeliveryTerminal,
  isProgramTerminal,
  programBudgetState,
  programSpend,
  type AgentRun,
  type HubQuestion,
  type Program,
  type ProgramDelivery,
  type ProgramSpend,
} from "@crystal/core";
import {
  EMPTY_HUB_EVENTS,
  EMPTY_HUB_QUESTIONS,
  MessageComposer,
  RunSurface,
  chainOf,
  formatRunCost,
  formatRunTokens,
  useHub,
  useNav,
  useNavUpdate,
  useTerminals,
  useWorkspaces,
} from "@crystal/client";
import {
  Button,
  EmptyState,
  Input,
  Spinner,
  StatusDot,
  Textarea,
  Tooltip,
  cn,
  useContextMenu,
} from "@crystal/ui";
import {
  SectionLabel,
  SpendLine,
  StatusBadge,
  parseBudget,
  useCrossWorkspaceNav,
  useHubMenuContext,
} from "./common.js";
import { AddDeliveryForm } from "./AddDeliveryForm.js";
import { deliveryHint, deliveryMenuEntries, programMenuEntries } from "./menus.js";

/** Stable empty chain — a fresh [] per render would defeat the memo below. */
const EMPTY_TURNS: AgentRun[] = [];

/**
 * One program: what each project was asked for, where its orchestrator has
 * got to, what it has cost — and the program-manager session, when one is
 * driving it.
 */
export function ProgramDetail({ program }: { program: Program }) {
  const spend = useHub((s) => s.spend[program.id]) ?? programSpend({});
  // The one-orchestrator-per-project rule spans programs, so readiness has to
  // be judged against the whole portfolio — otherwise the button offers to
  // dispatch deliveries the server will refuse.
  const allPrograms = useHub((s) => s.programs);
  const others = useMemo(
    () => allPrograms.filter((p) => p.id !== program.id),
    [allPrograms, program.id],
  );
  const questions = useHub((s) => s.questions[program.id]) ?? EMPTY_HUB_QUESTIONS;
  const dispatch = useHub((s) => s.dispatch);
  const setPaused = useHub((s) => s.setPaused);
  const setBudget = useHub((s) => s.setBudget);
  const cancel = useHub((s) => s.cancel);
  const startManager = useHub((s) => s.startManager);
  const removeDelivery = useHub((s) => s.removeDelivery);
  const retryDelivery = useHub((s) => s.retryDelivery);
  const remove = useHub((s) => s.remove);
  const nav = useNavUpdate();
  const menu = useContextMenu();
  const menuCtx = useHubMenuContext();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");

  const selectedDelivery = useNav((l) => l.hub?.delivery) ?? null;
  const selectDelivery = useCallback(
    (id: string | null) => nav({ hub: { delivery: id } }),
    [nav],
  );

  const terminal = isProgramTerminal(program.status);
  const readyCount = program.deliveries.filter(
    (d) => deliveryReadiness(program, d, others).ready,
  ).length;
  const budget = programBudgetState(program, spend);

  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice(`${label} failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runDispatch = (deliveryIds?: string[]) =>
    guard("Dispatch", async () => {
      const report = await dispatch(program.id, deliveryIds);
      const skipped = report.skipped.length
        ? ` ${report.skipped.length} skipped: ${report.skipped.map((s) => `${s.projectName} — ${s.reason}`).join("; ")}`
        : "";
      setNotice(
        report.dispatched.length
          ? `Dispatched ${report.dispatched.length} to ${report.dispatched.map((d) => d.projectName).join(", ")}.${skipped}`
          : `Nothing dispatched.${skipped}`,
      );
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="border-b border-edge px-4 py-2.5"
        onContextMenu={(e) =>
          menu.open(
            e,
            programMenuEntries(program, menuCtx, {
              dispatch: () => void runDispatch(),
              setPaused: (paused) => void guard("Pause", () => setPaused(program.id, paused)),
              cancel: () => void guard("Cancel", () => cancel(program.id)),
              startManager: () => void guard("Start manager", () => startManager(program.id)),
              remove: () => void guard("Remove", () => remove(program.id)),
            }),
          )
        }
      >
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 shrink-0 text-crystal-300" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{program.name}</h2>
          <StatusBadge status={program.status} />
          {!terminal ? (
            <>
              <Tooltip
                content={
                  readyCount
                    ? `Start ${readyCount} unblocked ${readyCount === 1 ? "delivery" : "deliveries"}`
                    : "Nothing is unblocked right now"
                }
              >
                <Button
                  variant="primary"
                  size="xs"
                  disabled={busy || readyCount === 0}
                  onClick={() => void runDispatch()}
                >
                  <Rocket className="h-3 w-3" /> Dispatch{readyCount ? ` ${readyCount}` : ""}
                </Button>
              </Tooltip>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void guard("Pause", () => setPaused(program.id, program.status !== "paused"))
                }
              >
                {program.status === "paused" ? (
                  <>
                    <Play className="h-3 w-3" /> Resume
                  </>
                ) : (
                  <>
                    <Pause className="h-3 w-3" /> Pause
                  </>
                )}
              </Button>
              <Button
                variant="danger"
                size="xs"
                disabled={busy}
                onClick={() => void guard("Cancel", () => cancel(program.id))}
              >
                <Ban className="h-3 w-3" /> Cancel
              </Button>
            </>
          ) : (
            <Tooltip content="Forget this program. The project work it dispatched stays where it ran.">
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => void guard("Remove", () => remove(program.id))}
              >
                <Trash2 className="h-3 w-3" /> Remove
              </Button>
            </Tooltip>
          )}
        </div>

        <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-ink-muted">
          {program.goal}
        </p>
        {program.summary ? (
          <p className="mt-1.5 rounded-lg border border-ok/25 bg-ok/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-ink">
            {program.summary}
          </p>
        ) : null}
        {program.pausedReason ? (
          <p className="mt-1.5 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[11px] text-ink">
            {program.pausedReason}
          </p>
        ) : null}

        {questions.length ? (
          <div className="mt-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <CircleHelp className="h-3.5 w-3.5 text-warn" />
              <span className="text-[11px] font-semibold text-ink">
                {questions.length === 1
                  ? "A project is waiting on you"
                  : `${questions.length} projects are waiting on you`}
              </span>
            </div>
            {questions.map((q) => (
              <QuestionRow key={q.questionId} programId={program.id} question={q} />
            ))}
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          <span className="flex items-center gap-1">
            <CircleDollarSign className="h-3.5 w-3.5 text-crystal-300" />
            <SpendLine costUsd={spend.costUsd} budgetUsd={budget.budgetUsd} showUnbudgeted />
            {spend.runCount ? (
              <span className="text-ink-faint">
                {spend.totalTokens ? ` · ${formatRunTokens(spend.totalTokens)} tok` : ""} ·{" "}
                {spend.runCount} runs
              </span>
            ) : null}
            {spend.liveRunCount > 0 ? <Spinner className="h-2.5 w-2.5" /> : null}
          </span>
          {editingBudget ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void guard("Set budget", () => setBudget(program.id, parseBudget(budgetInput)));
                setEditingBudget(false);
              }}
            >
              <Input
                autoFocus
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                placeholder="USD (empty = none)"
                className="h-6 w-36 text-[11px]"
                aria-label="Program budget in USD"
              />
              <Button type="submit" variant="ghost" size="xs">
                Set
              </Button>
            </form>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setBudgetInput(program.budgetUsd?.toString() ?? "");
                setEditingBudget(true);
              }}
            >
              Edit budget
            </Button>
          )}
          {spend.manager.runCount ? (
            <Tooltip content="What the program-manager session itself has cost">
              <span className="text-ink-faint">
                coordination {formatRunCost(spend.manager.costUsd)}
              </span>
            </Tooltip>
          ) : null}
        </div>
        {notice ? <p className="mt-1.5 text-[11px] text-ink-faint">{notice}</p> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2">
            <SectionLabel>Deliveries</SectionLabel>
            <span className="text-[10px] text-ink-faint">{program.deliveries.length}</span>
            {!terminal ? (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => setAdding((v) => !v)}
              >
                <Plus className="h-3 w-3" /> Add a project
              </Button>
            ) : null}
          </div>

          {adding ? (
            <AddDeliveryForm
              program={program}
              onDone={() => setAdding(false)}
              className="mb-2"
            />
          ) : null}

          {program.deliveries.length === 0 && !adding ? (
            <p className="rounded-lg border border-edge px-3 py-4 text-[11px] leading-relaxed text-ink-faint">
              No deliveries yet. Add one per project that owns part of this goal — each becomes a
              workflow driven by that project's own orchestrator.
            </p>
          ) : null}

          <div className="space-y-1">
            {program.deliveries.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                program={program}
                delivery={delivery}
                spend={spend}
                waiting={questions.filter((q) => q.deliveryId === delivery.id).length}
                others={others}
                selected={delivery.id === selectedDelivery}
                busy={busy}
                onSelect={() =>
                  selectDelivery(delivery.id === selectedDelivery ? null : delivery.id)
                }
                onDispatch={() => void runDispatch([delivery.id])}
                onRetry={() => void guard("Retry", () => retryDelivery(program.id, delivery.id))}
                onContextMenu={(e) =>
                  menu.open(
                    e,
                    deliveryMenuEntries(program, delivery, menuCtx, {
                      others,
                      dispatch: (id) => void runDispatch([id]),
                      message: (id) => selectDelivery(id),
                      remove: (id) =>
                        void guard("Remove", () => removeDelivery(program.id, id)),
                      retry: (id) => void guard("Retry", () => retryDelivery(program.id, id)),
                    }),
                  )
                }
              />
            ))}
          </div>
        </div>

        <ManagerSession program={program} />
      </div>
      {menu.element}
    </div>
  );
}

/**
 * One question a project stopped for. Answer it here — the answer is recorded
 * on that project's board and handed straight back to the run that asked, so
 * the delivery carries on — or open the task if it needs more context than a
 * line of text.
 */
function QuestionRow({ programId, question }: { programId: string; question: HubQuestion }) {
  const answerQuestion = useHub((s) => s.answerQuestion);
  const goToProject = useCrossWorkspaceNav();
  const [answering, setAnswering] = useState(false);
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
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
              if (e.key === "Escape") setAnswering(false);
            }}
            rows={2}
            placeholder="Your answer — it goes back to the run that stopped for it (Ctrl+Enter)"
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

/** A delivery's status as a run-style dot; pending and paused both read "idle". */
const DELIVERY_DOTS: Record<ProgramDelivery["status"], "running" | "completed" | "failed" | "cancelled" | "idle"> = {
  pending: "idle",
  paused: "idle",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

function DeliveryRow({
  program,
  delivery,
  spend,
  waiting,
  others,
  selected,
  busy,
  onSelect,
  onDispatch,
  onRetry,
  onContextMenu,
}: {
  program: Program;
  delivery: ProgramDelivery;
  spend: ProgramSpend;
  /** How many of this delivery's questions are unanswered. */
  waiting: number;
  /** The rest of the portfolio, for the cross-program project lock. */
  others: readonly Program[];
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onDispatch: () => void;
  onRetry: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const own = spend.byDelivery[delivery.id] ?? emptyDeliverySpend();
  const readiness = deliveryReadiness(program, delivery, others);
  const hint = deliveryHint(program, delivery);
  const failed = delivery.status === "failed" || delivery.status === "cancelled";
  // Retrying a delivery of a cancelled program reopens the program — say so,
  // rather than letting the header silently flip back to Dispatch/Pause.
  const retryHint = isProgramTerminal(program.status)
    ? "Queue this delivery again and reopen the program"
    : "Queue this delivery again and start a fresh workflow";

  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        selected ? "border-crystal-500/40 bg-crystal-500/10" : "border-edge bg-surface-1",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        <StatusDot status={DELIVERY_DOTS[delivery.status]} className="mt-1" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-ink">{delivery.projectName}</span>
            <StatusBadge status={delivery.status} />
            {waiting ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-warn/40 bg-warn/10 px-1.5 text-[9px] font-medium text-warn">
                <CircleHelp className="h-2.5 w-2.5" />
                {waiting}
              </span>
            ) : null}
            {hint ? <span className="truncate text-[10px] text-warn">{hint}</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
            {headline(delivery.brief)}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
            {own.runCount ? (
              <>
                <SpendLine costUsd={own.costUsd} budgetUsd={delivery.budgetUsd} />
                <span>
                  {own.runCount} run{own.runCount === 1 ? "" : "s"}
                </span>
              </>
            ) : delivery.budgetUsd != null ? (
              <span>budget ${delivery.budgetUsd.toFixed(2)}</span>
            ) : null}
            {own.liveRunCount > 0 ? <Spinner className="h-2.5 w-2.5" /> : null}
          </span>
        </span>
        {/*
          The row is itself a button, and a `disabled` Button gets
          `pointer-events: none` — so while an action is in flight its clicks
          would land on the row and collapse it. Catching them on the wrapper
          keeps a double-click inert instead of surprising.
        */}
        <span onClick={(e) => e.stopPropagation()}>
          {readiness.ready ? (
            <Tooltip content="Start this delivery in its project">
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Dispatch ${delivery.projectName}`}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onDispatch();
                }}
              >
                <Rocket className="h-3 w-3" />
              </Button>
            </Tooltip>
          ) : failed ? (
            // The recovery is on the row, not buried in the menu: a failure
            // here stops every delivery that depends on this one.
            <Tooltip content={retryHint}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`Retry ${delivery.projectName}`}
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry();
                }}
              >
                <RotateCcw className="h-3 w-3" />
              </Button>
            </Tooltip>
          ) : null}
        </span>
      </button>
      {selected ? <DeliveryDetail program={program} delivery={delivery} /> : null}
    </div>
  );
}

/** The expanded delivery: full brief, and a line into its orchestrator. */
function DeliveryDetail({ program, delivery }: { program: Program; delivery: ProgramDelivery }) {
  const messageDelivery = useHub((s) => s.messageDelivery);
  const setDeliveryBudget = useHub((s) => s.setDeliveryBudget);
  const goToProject = useCrossWorkspaceNav();

  const live = !isDeliveryTerminal(delivery.status) && !!delivery.workflowId;

  return (
    <div className="border-t border-edge/70 px-2.5 py-2">
      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink-muted">
        {delivery.brief}
      </p>
      {delivery.summary ? (
        <p className="mt-1.5 rounded-lg border border-ok/25 bg-ok/8 px-2 py-1 text-[11px] text-ink">
          {delivery.summary}
        </p>
      ) : null}
      {delivery.note ? (
        <p className="mt-1.5 text-[10px] text-warn">{delivery.note}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-ink-faint">
        <span className="font-mono">{delivery.projectRoot}</span>
        {delivery.ws && delivery.workflowId ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              goToProject(delivery.ws!, {
                mode: "orchestrate",
                orchestrate: { tab: "workflows", workflow: delivery.workflowId },
              })
            }
          >
            Open its workflow →
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            const raw = window.prompt(
              `Budget for ${delivery.projectName} in USD (empty clears it)`,
              delivery.budgetUsd?.toString() ?? "",
            );
            if (raw === null) return;
            void setDeliveryBudget(program.id, delivery.id, parseBudget(raw));
          }}
        >
          Set delivery budget
        </Button>
      </div>
      {live ? (
        <MessageComposer
          onSend={(t) => messageDelivery(program.id, delivery.id, t)}
          placeholder={`Message ${delivery.projectName}'s orchestrator — a decision from another project, a changed contract… (Ctrl+Enter)`}
          ariaLabel="Message this delivery's orchestrator"
          className="mt-1 bg-transparent p-0"
        />
      ) : null}
    </div>
  );
}

/**
 * The program-manager session: an interactive agent that owns this program —
 * splitting the goal, dispatching deliveries, sequencing them. Optional: a
 * program can equally be driven by hand here, or by an external agent over MCP.
 */
function ManagerSession({ program }: { program: Program }) {
  const runs = useHub((s) => s.runs);
  const eventsByRun = useHub((s) => s.eventsByRun);
  const loadRunEvents = useHub((s) => s.loadRunEvents);
  const startManager = useHub((s) => s.startManager);
  const message = useHub((s) => s.message);
  const cancelRun = useHub((s) => s.cancelRun);
  const activeWs = useWorkspaces((s) => s.activeId);
  const openWsIds = useWorkspaces((s) => s.workspaces);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  const nav = useNavUpdate();
  const selectedRun = useNav((l) => l.hub?.run) ?? null;

  // Where an interactive manager's PTY would live: prefer a workspace this
  // program is already delivering into, else whatever is active.
  const hostWs =
    program.deliveries
      .map((d) => d.ws)
      .find((ws) => ws && openWsIds.some((w) => w.id === ws)) ?? activeWs;

  async function startInteractive(): Promise<void> {
    if (!hostWs) return;
    const run = await startManager(program.id, { ws: hostWs });
    if (run.terminalId) await focusTerminal(hostWs, run.terminalId);
  }

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The manager's chain: every turn of the session, oldest first — the shared
  // resume-lineage walk anchored on the run the program record points at.
  const chain = useMemo(() => {
    const anchor = runs.find((r) => r.id === program.managerRunId);
    return anchor ? chainOf(runs, anchor) : EMPTY_TURNS;
  }, [runs, program.managerRunId]);
  const latest = chain[chain.length - 1] ?? null;
  const viewed = chain.find((r) => r.id === selectedRun) ?? latest;
  const events = viewed ? (eventsByRun[viewed.id] ?? EMPTY_HUB_EVENTS) : EMPTY_HUB_EVENTS;

  // Keyed on the id: `viewed` is a fresh object on every run event, and
  // depending on it re-fires this request on every usage tick.
  const viewedId = viewed?.id ?? null;
  useEffect(() => {
    if (viewedId) void loadRunEvents(viewedId);
  }, [viewedId, loadRunEvents]);

  const terminal = isProgramTerminal(program.status);

  if (!program.managerRunId) {
    return (
      <div className="border-t border-edge px-4 py-4">
        <EmptyState
          icon={Bot}
          title="No program manager"
          action={
            terminal ? undefined : (
              <div className="flex items-center gap-2">
                <Tooltip content="A native interactive Claude session in the terminal panel — it asks you decisions directly (AskUserQuestion); notices and answers are typed into it live.">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || !hostWs}
                    onClick={() => {
                      setBusy(true);
                      void startInteractive()
                        .catch((err: Error) => setNotice(err.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <TerminalSquare className="h-3 w-3" /> Start in terminal
                  </Button>
                </Tooltip>
                <Tooltip content="A headless session driven from this pane — it wakes on settlements and questions, and you steer it with messages here.">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void startManager(program.id)
                        .catch((err: Error) => setNotice(err.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Bot className="h-3 w-3" /> Start headless
                  </Button>
                </Tooltip>
              </div>
            )
          }
        >
          A program manager is an interactive session that owns this program: it splits the goal
          across projects, dispatches each delivery to that project's orchestrator, and sequences
          them as dependencies land. You can equally drive the program by hand from here — or point
          an external agent at the hub's MCP endpoint.
        </EmptyState>
        {notice ? <p className="mt-2 text-[11px] text-danger">{notice}</p> : null}
      </div>
    );
  }

  return (
    <div className="border-t border-edge">
      <div className="flex items-center gap-2 px-4 py-2">
        <MessageSquare className="h-3.5 w-3.5 text-crystal-300" />
        <SectionLabel>Program manager</SectionLabel>
      </div>
      {viewed ? (
        <RunSurface
          run={viewed}
          events={events}
          chain={chain}
          diff={null}
          onCancel={() => cancelRun(viewed.id)}
          onSend={terminal ? undefined : (t) => message(program.id, t)}
          onSelectTurn={(id) => nav({ hub: { run: id === latest?.id ? null : id } })}
          // An interactive turn collapses to its PTY banner; a headless one
          // keeps the transcript to a bounded pane inside the scrolling view.
          className={cn("border-t border-edge", !viewed.terminalId && "h-[28rem]")}
        />
      ) : null}
    </div>
  );
}

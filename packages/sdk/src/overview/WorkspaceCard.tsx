import { useMemo } from "react";
import {
  ArrowRight,
  Bot,
  History,
  KanbanSquare,
  MessageSquare,
  TerminalSquare,
} from "lucide-react";
import {
  buildWorkspaceRecap,
  countActionableQuestionRows,
  deriveRunAttention,
  formatRecapAge,
  formatUsd,
  formatWsRef,
  sumCostRollups,
  unrecoveredFailures,
  workspaceLight,
  TRAFFIC_LIGHT_LABELS,
  type WorkspaceDescriptor,
} from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_PROJECT_ENTRIES,
  EMPTY_QUESTIONS,
  EMPTY_TODOS,
  formatRunCost,
  useCrystal,
  useFleet,
  useHub,
  useNavUpdate,
  useWorkspaces,
  wsKey,
} from "@crystal/client";
import { formatOverviewThreadId } from "@crystal/threads";
import { Tooltip, TrafficLightDot, cn } from "@crystal/ui";
import { TodoSection } from "./TodoSection.js";

/**
 * One project (workspace) on the overview: its traffic light, agent-run
 * summary, and todo list. Fleet-aware: the card belongs to one bridge
 * connection (`sid`), reads its slice of the fleet store via the compound
 * `"<sid>/<wsId>"` key, and entering it switches both the active server and
 * workspace. The rollup light combines open todos with run attention (one
 * policy — attention.ts in core): a run finishing while you work elsewhere
 * turns the card yellow (review) or red (failure) until you focus the
 * workspace again; open questions and unrecovered recoverable failures stay
 * lit until answered/recovered, never acknowledgeable-away.
 */
export function WorkspaceCard({
  sid,
  ws,
  serverLabel,
  offline,
}: {
  sid: string;
  ws: WorkspaceDescriptor;
  /** Shown when more than one server is connected. */
  serverLabel: string | null;
  /** The card's connection is down — render read-only/dimmed. */
  offline: boolean;
}) {
  const { activeSid, selectWorkspace } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const updateNav = useNavUpdate();
  const key = wsKey(sid, ws.id);
  const runs = useFleet((s) => s.runsByWs[key] ?? EMPTY_RUNS);
  const projects = useFleet((s) => s.projectsByWs[key] ?? EMPTY_PROJECT_ENTRIES);
  const todos = useFleet((s) => s.todosByWs[key] ?? EMPTY_TODOS);
  const seenAt = useFleet((s) => s.seenAtByWs[key] ?? null);
  const questions = useFleet((s) =>
    countActionableQuestionRows(s.questionsByWs[key] ?? EMPTY_QUESTIONS),
  );

  const active = sid === activeSid && ws.id === activeWsId;
  const light = workspaceLight(todos, runs, seenAt, questions);
  // Where you left off — derived from the run list, no model call.
  const recap = useMemo(() => buildWorkspaceRecap(runs), [runs]);
  const totalCostUsd = useMemo(
    () =>
      sumCostRollups(
        projects.flatMap(({ project }) => project.tasks.map((task) => task.cost)),
      )?.costUsd ?? null,
    [projects],
  );
  // Chips come from the same attention policy as the light (attention.ts in
  // core), so a card can never say something its own dot doesn't.
  const attn = useMemo(() => deriveRunAttention(runs, seenAt), [runs, seenAt]);
  const running = attn.running;
  const toReview = attn.review;
  // The two red lanes clear differently, so they never share a chip: `failed`
  // (settled-unseen) goes away once the workspace is focused, while a run in
  // `needRecovery` stays until something resumes or hands off from it.
  const failed = attn.reviewFailed;
  const needRecovery = useMemo(() => unrecoveredFailures(runs), [runs]);
  const openTodos = todos.filter((t) => !t.done).length;

  const enter = () => selectWorkspace(sid, ws.id);
  const goToRuns = () => {
    enter();
    updateNav({ ws: formatWsRef(sid, ws.id), mode: "threads", threads: { thread: null, compose: null } });
  };
  const goToSessions = () => {
    enter();
    updateNav({ ws: formatWsRef(sid, ws.id), mode: "threads", threads: { thread: null, compose: null } });
  };
  const goToBoard = () => {
    enter();
    updateNav({ ws: formatWsRef(sid, ws.id), mode: "threads", threads: { thread: null, compose: null } });
  };
  // Same jump as the orchestrator pill: resolve the newest failure in its
  // hierarchical session, where recovery actions stay in conversation context.
  const goToFailure = () => {
    enter();
    updateNav({
      ws: formatWsRef(sid, ws.id),
      mode: "threads",
      threads: { thread: needRecovery[0]?.id ?? null, compose: null },
    });
  };

  const openTerminal = (kind: "shell" | "agent") => {
    window.dispatchEvent(
      new CustomEvent("crystal:open-terminal", { detail: { ws: ws.id, sid, kind } }),
    );
  };

  // The program whose delivery runs in this project, if any — "talk to the
  // coordinator" opens the chat on it (primitive selector: id or null).
  const programId = useHub(
    (s) => s.programs.find((p) => p.deliveries.some((d) => d.ws === ws.id))?.id ?? null,
  );
  const goToChat = () => {
    updateNav({
      mode: "projects",
      projects: {
        view: "threads",
        thread: programId ? formatOverviewThreadId({ kind: "program", programId }) : null,
      },
    });
  };

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-xl border bg-surface-1 p-3.5",
        active ? "border-crystal-500/50" : "border-edge",
        offline && "opacity-60",
      )}
    >
      <header className="flex items-center gap-2.5">
        <TrafficLightDot light={light} className="h-2.5 w-2.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <button
              type="button"
              disabled={offline}
              onClick={enter}
              title={`Open ${ws.name}`}
              className="min-w-0 truncate text-left text-sm font-semibold text-ink hover:text-crystal-300 disabled:cursor-default disabled:hover:text-ink"
            >
              {ws.name}
            </button>
            {serverLabel ? (
              <span className="truncate text-[10px] text-ink-faint">{serverLabel}</span>
            ) : null}
            {active ? <span className="text-[10px] text-crystal-300">active</span> : null}
            {offline ? <span className="text-[10px] text-danger">offline</span> : null}
          </div>
          <div className="truncate text-[10px] text-ink-faint" title={ws.root}>
            {ws.root}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content="Open a terminal here">
            <button
              type="button"
              disabled={offline}
              onClick={() => openTerminal("shell")}
              aria-label={`Open terminal in ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
            >
              <TerminalSquare className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Open an agent console here">
            <button
              type="button"
              disabled={offline}
              onClick={() => openTerminal("agent")}
              aria-label={`Open agent console in ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
            >
              <Bot className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip
            content={
              programId
                ? "Talk to the coordinating agent about this project"
                : "Talk to the coordinating agent"
            }
          >
            <button
              type="button"
              onClick={goToChat}
              aria-label={`Talk to the coordinator about ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Open the task board">
            <button
              type="button"
              disabled={offline}
              onClick={goToBoard}
              aria-label={`Open board for ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
            >
              <KanbanSquare className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {!active ? (
            <Tooltip content="Switch to this workspace">
              <button
                type="button"
                disabled={offline}
                onClick={enter}
                aria-label={`Switch to ${ws.name}`}
                className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="text-ink-faint">{TRAFFIC_LIGHT_LABELS[light]}</span>
        {questions > 0 ? (
          <button
            type="button"
            disabled={offline}
            onClick={goToBoard}
            title="Agents filed decisions only a human can make — answer them on the board"
            className="rounded-full bg-warn/15 px-2 py-0.5 font-medium text-warn hover:bg-warn/25"
          >
            {questions} waiting on you
          </button>
        ) : null}
        {needRecovery.length > 0 ? (
          <button
            type="button"
            disabled={offline}
            onClick={goToFailure}
            title="Failed runs no later run has recovered — resume or hand off to clear; focusing the workspace won't"
            className="rounded-full border border-danger/40 bg-danger/15 px-2 py-0.5 font-medium text-danger hover:bg-danger/25"
          >
            {needRecovery.length} need{needRecovery.length === 1 ? "s" : ""} recovery
          </button>
        ) : null}
        {running > 0 ? (
          <button
            type="button"
            disabled={offline}
            onClick={goToSessions}
            className="rounded-full bg-info/15 px-2 py-0.5 text-info hover:bg-info/25"
          >
            {running} running
          </button>
        ) : null}
        {toReview > 0 ? (
          <button
            type="button"
            disabled={offline}
            onClick={goToRuns}
            className="rounded-full bg-warn/15 px-2 py-0.5 text-warn hover:bg-warn/25"
          >
            {toReview} to review
          </button>
        ) : null}
        {failed > 0 ? (
          <button
            type="button"
            disabled={offline}
            onClick={goToRuns}
            title="Failed since you last looked — clears once you focus this workspace"
            className="rounded-full bg-danger/15 px-2 py-0.5 text-danger hover:bg-danger/25"
          >
            {failed} failed
          </button>
        ) : null}
        {openTodos > 0 ? (
          <span className="rounded-full bg-surface-3 px-2 py-0.5 text-ink-faint">
            {openTodos} open todo{openTodos > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>

      {recap.lastActivityAt ? (
        <button
          type="button"
          onClick={goToRuns}
          title="Open the runs list"
          className="flex min-w-0 items-center gap-1.5 text-left text-[10px] text-ink-faint hover:text-ink-muted"
        >
          <History className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{formatRecapAge(recap.lastActivityAt)}</span>
          <span className="min-w-0 flex-1 truncate">· {recap.headline}</span>
          {recap.last24h.runCount > 0 ? (
            <span className="shrink-0 tabular-nums">
              24h: {recap.last24h.runCount} runs · {formatUsd(recap.last24h.costUsd)}
              {recap.last24h.failed > 0 ? ` · ${recap.last24h.failed} failed` : ""}
            </span>
          ) : null}
          {totalCostUsd != null && totalCostUsd > 0 ? (
            <span className="shrink-0 tabular-nums text-ink-faint">
              total {formatRunCost(totalCostUsd)}
            </span>
          ) : null}
        </button>
      ) : null}

      <TodoSection sid={sid} ws={ws.id} todos={todos} />
    </section>
  );
}

import { ArrowRight, Bot, KanbanSquare, TerminalSquare } from "lucide-react";
import {
  workspaceLight,
  TRAFFIC_LIGHT_LABELS,
  type WorkspaceDescriptor,
} from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  useFleet,
  useNavUpdate,
  useWorkspaces,
} from "@crystal/client";
import { Tooltip, TrafficLightDot, cn } from "@crystal/ui";
import { TodoSection } from "./TodoSection.js";

/**
 * One project (workspace) on the overview: its traffic light, agent-run
 * summary, and todo list. The rollup light combines open todos with run
 * attention — a run finishing while you work elsewhere turns the card yellow
 * (review) or red (failure) until you focus the workspace again.
 */
export function WorkspaceCard({ ws, active }: { ws: WorkspaceDescriptor; active: boolean }) {
  const setActive = useWorkspaces((s) => s.setActive);
  const updateNav = useNavUpdate();
  const runs = useFleet((s) => s.runsByWs[ws.id] ?? EMPTY_RUNS);
  const todos = useFleet((s) => s.todosByWs[ws.id] ?? EMPTY_TODOS);
  const seenAt = useFleet((s) => s.seenAtByWs[ws.id] ?? null);
  const questions = useFleet((s) => s.questionsByWs[ws.id] ?? 0);

  const light = workspaceLight(todos, runs, seenAt, questions);
  const running = runs.filter((r) => r.status === "running" || r.status === "queued").length;
  const unseen = seenAt === null ? runs.filter((r) => r.endedAt) : runs.filter((r) => r.endedAt && r.endedAt > seenAt);
  const toReview = unseen.filter((r) => r.status === "completed").length;
  const failed = unseen.filter((r) => r.status === "failed").length;
  const openTodos = todos.filter((t) => !t.done).length;

  const goToRuns = () => {
    setActive(ws.id);
    updateNav({ ws: ws.id, mode: "orchestrate", orchestrate: { tab: "runs" } });
  };

  const openTerminal = (kind: "shell" | "agent") => {
    window.dispatchEvent(
      new CustomEvent("crystal:open-terminal", { detail: { ws: ws.id, kind } }),
    );
  };

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-xl border bg-surface-1 p-3.5",
        active ? "border-crystal-500/50" : "border-edge",
      )}
    >
      <header className="flex items-center gap-2.5">
        <TrafficLightDot light={light} className="h-2.5 w-2.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-sm font-semibold text-ink">{ws.name}</h3>
            {active ? <span className="text-[10px] text-crystal-300">active</span> : null}
          </div>
          <div className="truncate text-[10px] text-ink-faint" title={ws.root}>
            {ws.root}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip content="Open a terminal here">
            <button
              type="button"
              onClick={() => openTerminal("shell")}
              aria-label={`Open terminal in ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <TerminalSquare className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Open an agent console here">
            <button
              type="button"
              onClick={() => openTerminal("agent")}
              aria-label={`Open agent console in ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <Bot className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Open the task board">
            <button
              type="button"
              onClick={() => {
                setActive(ws.id);
                updateNav({ ws: ws.id, mode: "orchestrate", orchestrate: { tab: "board" } });
              }}
              aria-label={`Open board for ${ws.name}`}
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <KanbanSquare className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {!active ? (
            <Tooltip content="Switch to this workspace">
              <button
                type="button"
                onClick={() => setActive(ws.id)}
                aria-label={`Switch to ${ws.name}`}
                className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
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
            onClick={() => {
              setActive(ws.id);
              updateNav({ ws: ws.id, mode: "orchestrate", orchestrate: { tab: "board" } });
            }}
            title="Agents filed decisions only a human can make — answer them on the board"
            className="rounded-full bg-warn/15 px-2 py-0.5 font-medium text-warn hover:bg-warn/25"
          >
            {questions} waiting on you
          </button>
        ) : null}
        {running > 0 ? (
          <button
            type="button"
            onClick={goToRuns}
            className="rounded-full bg-info/15 px-2 py-0.5 text-info hover:bg-info/25"
          >
            {running} running
          </button>
        ) : null}
        {toReview > 0 ? (
          <button
            type="button"
            onClick={goToRuns}
            className="rounded-full bg-warn/15 px-2 py-0.5 text-warn hover:bg-warn/25"
          >
            {toReview} to review
          </button>
        ) : null}
        {failed > 0 ? (
          <button
            type="button"
            onClick={goToRuns}
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

      <TodoSection ws={ws.id} todos={todos} />
    </section>
  );
}

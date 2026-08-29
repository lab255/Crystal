import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import {
  sessionIsWorking,
  workflowSpend,
  type AgentRun,
  type RunEvent,
  type RunNode,
  type WorkflowTurn,
} from "@crystal/core";
import {
  InteractiveRunBanner,
  QuestionCard,
  formatElapsed,
  formatRunCost,
  questionDeliveryNotice,
  useCrystal,
  useWorkspaces,
  type FleetQuestion,
} from "@crystal/client";
import {
  Badge,
  Button,
  EmptyState,
  StatusDot,
  Tooltip,
  cn,
  type MenuEntry,
} from "@crystal/ui";
import { CreateProgram, ProgramSession } from "../ProgramThread.js";
import { PAUSED_BY_LABEL, STATUS_LABEL, SpendLine } from "../spend-line.js";
import { ThreadComposer } from "../ThreadComposer.js";
import { ThreadTranscript } from "../ThreadTranscript.js";
import {
  buildTranscriptItems,
  joinTranscriptRecords,
  type TranscriptItem,
} from "../transcript-items.js";
import { INDICATOR_LABEL } from "../ThreadRow.js";
import type { OverviewThread, OverviewThreadRef } from "./overview-thread-model.js";

interface PaneProps {
  thread: OverviewThread | null;
  creating: boolean;
  notice: string | null;
  noticeTone: "danger" | "neutral";
  dismissNotice: () => void;
  onError: (message: string) => void;
  onCreated: (id: string) => void;
  questions: FleetQuestion[];
  eventsByRun: Record<string, RunEvent[]>;
  runs: AgentRun[];
  loadEvents: (id: string) => Promise<void>;
  entries: MenuEntry[];
  openMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void;
  openProject: () => void;
  resumeWorkflow: () => void;
  focusTurnId?: string;
  onCopyTurnLink?: (runId: string) => void | Promise<void>;
  onFocusedTurn?: (runId: string) => void;
  missingRef?: OverviewThreadRef | null;
  missingProjectClosed?: boolean;
  clearSelection: () => void;
}

function NodeTranscript({
  node,
  eventsByRun,
  loadEvents,
  questions,
  focusTurnId,
  onCopyTurnLink,
  onFocusedTurn,
}: {
  node: RunNode;
  eventsByRun: Record<string, RunEvent[]>;
  loadEvents: (id: string) => Promise<void>;
  questions: FleetQuestion[];
  focusTurnId?: string;
  onCopyTurnLink?: (runId: string) => void | Promise<void>;
  onFocusedTurn?: (runId: string) => void;
}) {
  const loadEventsRef = useRef(loadEvents);
  const foldCacheRef = useRef(new Map<
    string,
    { events: readonly RunEvent[] | undefined; items: TranscriptItem[] }
  >());
  const [loadedFocusTurnId, setLoadedFocusTurnId] = useState<string | undefined>();
  const ownsFocusTurn = focusTurnId != null
    && node.turns.some((turn) => turn.id === focusTurnId);
  useEffect(() => {
    loadEventsRef.current = loadEvents;
  }, [loadEvents]);
  const loadNodeEvents = useCallback((id: string) => loadEventsRef.current(id), []);
  useEffect(() => {
    for (const turn of node.turns.slice(-2)) void loadEventsRef.current(turn.id);
  }, [node.turns]);
  useEffect(() => {
    if (!focusTurnId || !ownsFocusTurn) {
      setLoadedFocusTurnId(undefined);
      return;
    }
    let current = true;
    setLoadedFocusTurnId(undefined);
    void loadEventsRef.current(focusTurnId).then(
      () => {
        if (current) setLoadedFocusTurnId(focusTurnId);
      },
      () => {
        if (current) setLoadedFocusTurnId(focusTurnId);
      },
    );
    return () => {
      current = false;
    };
  }, [focusTurnId, ownsFocusTurn]);
  const transcriptQuestions = useMemo(
    () => questions.map((row) => row.question),
    [questions],
  );
  const items = useMemo(() => {
    const liveIds = new Set(node.turns.map((turn) => turn.id));
    for (const id of foldCacheRef.current.keys()) {
      if (!liveIds.has(id)) foldCacheRef.current.delete(id);
    }
    const base = node.turns.flatMap((turn) => {
      const turnEvents = eventsByRun[turn.id];
      const cached = foldCacheRef.current.get(turn.id);
      if (cached && cached.events === turnEvents) return cached.items;
      const folded = buildTranscriptItems({
        turns: [turn],
        eventsByRun: turnEvents ? { [turn.id]: turnEvents } : {},
      });
      foldCacheRef.current.set(turn.id, { events: turnEvents, items: folded });
      return folded;
    });
    return joinTranscriptRecords(base, transcriptQuestions, node.workers);
  }, [node.turns, node.workers, eventsByRun, transcriptQuestions]);
  const renderWorker = useCallback(
    (item: Extract<TranscriptItem, { kind: "delegation" }>) => item.worker ? (
      <NodeTranscript
        node={item.worker}
        eventsByRun={eventsByRun}
        loadEvents={loadNodeEvents}
        questions={questions}
        focusTurnId={focusTurnId}
        onCopyTurnLink={onCopyTurnLink}
        onFocusedTurn={onFocusedTurn}
      />
    ) : null,
    [eventsByRun, focusTurnId, loadNodeEvents, onCopyTurnLink, onFocusedTurn, questions],
  );
  return (
    <ThreadTranscript
      items={items}
      threadId={node.turns[0]!.id}
      working={sessionIsWorking(node)}
      renderWorker={renderWorker}
      onExpandTurn={loadNodeEvents}
      focusTurnId={ownsFocusTurn ? loadedFocusTurnId : focusTurnId}
      onCopyTurnLink={onCopyTurnLink}
      onFocusedTurn={onFocusedTurn}
    />
  );
}

/** The pane preserves project context and action truth while crossing workspaces. */
export function OverviewThreadPane({
  thread,
  creating,
  notice,
  noticeTone,
  dismissNotice,
  onError,
  onCreated,
  questions,
  eventsByRun,
  runs,
  loadEvents,
  entries,
  openMenu,
  openProject,
  resumeWorkflow,
  focusTurnId,
  onCopyTurnLink,
  onFocusedTurn,
  missingRef,
  missingProjectClosed,
  clearSelection,
}: PaneProps) {
  const { fleet, activeSid } = useCrystal();
  const activeWs = useWorkspaces((state) => state.activeId);
  const face = thread?.summary?.node.run;
  const working = face ? sessionIsWorking(thread!.summary!.node) : false;
  const activeQuestionRows = useMemo(() => {
    if (!thread?.summary) return [];
    const chainIds = new Set(thread.summary.node.turns.map((turn) => turn.id));
    return questions.filter((row) => row.question.runId && chainIds.has(row.question.runId));
  }, [questions, thread?.summary]);

  if (creating) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        {notice ? <Notice text={notice} tone={noticeTone} dismiss={dismissNotice} /> : null}
        <CreateProgram
          onCreated={(program) => onCreated(program.id)}
          onCancel={clearSelection}
        />
      </main>
    );
  }
  if (!thread) {
    if (missingRef) {
      return (
        <main className="flex flex-1 items-center justify-center">
          <EmptyState title="This thread is no longer available">
            {missingProjectClosed ? "The project is closed." : null}
            <Button className="mt-3" size="sm" onClick={clearSelection}>
              Clear selection
            </Button>
          </EmptyState>
        </main>
      );
    }
    return (
      <main className="flex flex-1 items-center justify-center">
        <EmptyState title="Pick a thread">
          Select a conversation on the left, or start a new program.
        </EmptyState>
      </main>
    );
  }
  if (thread.program) {
    return (
      <main className="flex min-w-0 flex-1 flex-col">
        {notice ? <Notice text={notice} tone={noticeTone} dismiss={dismissNotice} /> : null}
        <header className="flex items-center gap-2.5 border-b border-edge px-4 py-2.5">
          <span className="rounded bg-surface-2 px-2 py-1 text-[10px] text-ink-muted">
            Coordinator
            {thread.serverLabel ? ` · ${thread.serverLabel}` : ""}
          </span>
          <Tooltip content={INDICATOR_LABEL[thread.indicator]}>
            <span><StatusDot status={thread.indicator === "needs-input"
              ? "needs-you"
              : thread.indicator === "unread" ? "queued" : thread.indicator} /></span>
          </Tooltip>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {thread.program.name}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Thread actions"
            onClick={(event) => openMenu(event, entries)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </header>
        <ProgramSession program={thread.program} onError={onError} />
      </main>
    );
  }

  const summary = thread.summary!;
  const run = summary.node.run;
  const client = thread.ref.kind === "workspace" ? fleet.clientOf(thread.ref.sid) : null;
  const spend = thread.workflow ? workflowSpend(thread.workflow.id, runs) : null;
  const interactive = run.terminalId != null;
  const activeProject = thread.ref.kind === "workspace"
    && activeSid === thread.ref.sid
    && activeWs === thread.ref.ws;
  const recentTurnLog = thread.workflow?.turnLog.slice(-5) ?? [];
  const recentTurnOffset = (thread.workflow?.turnLog.length ?? 0) - recentTurnLog.length;
  const workflowLabel = thread.workflow
    ? `${thread.workflow.name === thread.title ? "" : `${thread.workflow.name} · `}`
      + STATUS_LABEL[thread.workflow.status]
      + (thread.workflow.status === "paused"
        ? ` · ${PAUSED_BY_LABEL[thread.workflow.pausedBy ?? "user"]}`
        : "")
    : null;

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {notice ? <Notice text={notice} tone={noticeTone} dismiss={dismissNotice} /> : null}
      <header className="flex items-center gap-2.5 border-b border-edge px-4 py-2.5">
        <Tooltip content="Open in project">
          <button
            type="button"
            onClick={openProject}
            className={cn(
              "max-w-48 truncate rounded bg-surface-2 px-2 py-1",
              "text-[10px] text-ink-muted",
            )}
          >
            {thread.serverLabel ? `${thread.serverLabel} › ` : ""}{thread.workspaceName}
          </button>
        </Tooltip>
        <StatusDot status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{thread.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-faint">
            {run.purpose ? (
              <Tooltip content={run.model ? `Model ${run.model}` : run.purpose}>
                <span><Badge tone="violet">{run.purpose}</Badge></span>
              </Tooltip>
            ) : null}
            <span>Thread {formatRunCost(thread.costUsd ?? 0)}</span>
            {working && run.startedAt ? <Elapsed startedAt={run.startedAt} /> : null}
            {workflowLabel ? <Badge>{workflowLabel}</Badge> : null}
            {thread.workflow && spend ? (
              <span>Workflow <SpendLine
                costUsd={spend.costUsd}
                budgetUsd={thread.workflow.budgetUsd}
              /></span>
            ) : null}
            <RecentTurnStrip turns={recentTurnLog} offset={recentTurnOffset} />
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Thread actions"
          onClick={(event) => openMenu(event, entries)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </header>
      {interactive && activeProject ? <InteractiveRunBanner run={run} /> : null}
      {interactive && !activeProject ? (
        <div
          className={cn(
            "flex items-center gap-3 border-b border-edge px-4 py-2",
            "text-xs text-ink-muted",
          )}
        >
          <span>Interactive session — open in project to attach the terminal</span>
          <Button size="sm" variant="ghost" onClick={openProject}>Open in project</Button>
        </div>
      ) : null}
      <NodeTranscript
        node={summary.node}
        eventsByRun={eventsByRun}
        loadEvents={loadEvents}
        questions={activeQuestionRows}
        focusTurnId={focusTurnId}
        onCopyTurnLink={onCopyTurnLink}
        onFocusedTurn={onFocusedTurn}
      />
      {activeQuestionRows.length ? (
        <div className="space-y-2 border-t border-edge px-4 py-2">
          {activeQuestionRows.map((row) => (
            <QuestionCard
              key={row.question.id}
              context={<span>{row.projectName} / {row.taskTitle}</span>}
              question={row.question.text}
              options={row.question.options.map((value) => ({ value, label: value }))}
              recommended={row.question.recommended}
              onAnswer={async (answer) => {
                if (!client || thread.ref.kind !== "workspace") {
                  throw new Error("This bridge is disconnected.");
                }
                const result = await client.request("task.answer", {
                  ws: thread.ref.ws,
                  path: row.projectPath,
                  taskId: row.taskId,
                  questionId: row.question.id,
                  answer,
                });
                if (!result.ok) throw new Error(result.reason);
                return { notice: questionDeliveryNotice(result.delivery) };
              }}
            />
          ))}
        </div>
      ) : null}
      {thread.workflow && ["completed", "failed", "cancelled"].includes(thread.workflow.status) ? (
        <div className="border-t border-edge px-4 py-3 text-xs text-ink-muted">
          This workflow is closed. The transcript is read-only.
        </div>
      ) : (
        <>
          {thread.workflow?.status === "paused" ? (
            <div
              className={cn(
                "flex items-center gap-2 border-t border-edge px-4 py-2",
                "text-xs text-ink-muted",
              )}
            >
              <span>Paused by {PAUSED_BY_LABEL[thread.workflow.pausedBy ?? "user"]}</span>
              <Button variant="ghost" size="sm" onClick={resumeWorkflow}>Resume</Button>
            </div>
          ) : null}
          {thread.ref.kind === "workspace" ? (
            <ThreadComposer
              run={run}
              sid={thread.ref.sid}
              ws={thread.ref.ws}
              className="border-t border-edge"
            />
          ) : null}
        </>
      )}
    </main>
  );
}

function RecentTurnStrip({ turns, offset }: { turns: readonly WorkflowTurn[]; offset: number }) {
  if (!turns.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
      <span className="text-ink-faint">Last 5 turns</span>
      {turns.map((turn, index) => {
        const cost = formatRunCost(turn.costUsd);
        return (
          <Tooltip
            key={`${turn.runId}:${turn.at}`}
            content={
              `Turn ${offset + index + 1} · ${cost} · `
              + (turn.progressed ? "progressed" : "no progress")
            }
          >
            <span
              aria-label={turn.progressed ? `${cost}, progressed` : `${cost}, stalled`}
              className={cn(
                "rounded px-1 py-0.5",
                turn.progressed ? "bg-surface-2" : "bg-danger/15 font-semibold text-danger",
              )}
            >
              {cost}
            </span>
          </Tooltip>
        );
      })}
      <span>{turns.filter((turn) => !turn.progressed).length} stalled</span>
    </span>
  );
}

function Notice({
  text,
  tone,
  dismiss,
}: {
  text: string;
  tone: "danger" | "neutral";
  dismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-2 border-b bg-surface-2 px-4 py-2 text-xs",
        tone === "danger" ? "border-danger/40 text-danger" : "border-edge text-ink",
      )}
    >
      <span className="flex-1">{text}</span>
      <button type="button" aria-label="Dismiss error" onClick={dismiss}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span>{formatElapsed(startedAt, nowMs)}</span>;
}

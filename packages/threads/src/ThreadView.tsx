import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, FileDiff, GitMerge, RefreshCw, Trash2 } from "lucide-react";
import {
  rollupRunsUsage,
  sessionIsWorking,
  sessionWorkflowId,
  usageTotalTokens,
  workflowSpend,
  type AgentRun,
  type RunNode,
  type TaskQuestion,
} from "@crystal/core";
import {
  InteractiveRunBanner,
  InteractiveRunTerminal,
  QuestionCard,
  questionDeliveryNotice,
  formatElapsed,
  formatRunCost,
  formatRunTokens,
  useAgents,
  useCrystal,
  useGrants,
  useRunSurface,
  useWorkflows,
  useWorkspace,
} from "@crystal/client";
import { Badge, Button, StatusDot, Tooltip, cn } from "@crystal/ui";
import { ThreadComposer } from "./ThreadComposer.js";
import { SpendLine } from "./spend-line.js";
import { StatusBadge } from "./spend-line.js";
import { RunContextDetails } from "./RunContextDetails.js";
import { ThreadTranscript } from "./ThreadTranscript.js";
import { buildTranscriptItems, type TranscriptItem } from "./transcript-items.js";
import type { ThreadSummary } from "./thread-model.js";

/** How many of the chain's newest turns hydrate eagerly on open. */
const EAGER_TURNS = 2;

interface QuestionContext {
  path: string;
  taskId: string;
}

const EMPTY_PROJECTS: { path: string; project: { tasks: { id: string; questions: TaskQuestion[] }[] } }[] = [];

/** Board questions raised by any of these run ids, with answer routing. */
function useChainQuestions(runIds: ReadonlySet<string>): {
  questions: TaskQuestion[];
  contextOf: Map<string, QuestionContext>;
} {
  const projects = useWorkspace((s) => s.info?.projects ?? (EMPTY_PROJECTS as never));
  return useMemo(() => {
    const questions: TaskQuestion[] = [];
    const contextOf = new Map<string, QuestionContext>();
    for (const { path, project } of projects) {
      for (const task of project.tasks) {
        for (const question of task.questions ?? []) {
          if (!question.runId || !runIds.has(question.runId)) continue;
          questions.push(question);
          contextOf.set(question.id, { path, taskId: task.id });
        }
      }
    }
    questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { questions, contextOf };
  }, [projects, runIds]);
}

function subtreeRunIds(node: RunNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: RunNode) => {
    for (const turn of n.turns) ids.add(turn.id);
    n.workers.forEach(walk);
  };
  walk(node);
  return ids;
}

function flattenRuns(node: RunNode): AgentRun[] {
  const runs: AgentRun[] = [];
  const walk = (n: RunNode) => {
    runs.push(...n.turns);
    n.workers.forEach(walk);
  };
  walk(node);
  return runs;
}

/**
 * One thread, chat-shaped: header (title, status, cost), the folded
 * transcript over the WHOLE resume chain (workers nested inline), the
 * composer, and a compact worktree-changes footer for isolated runs.
 */
export function ThreadView({
  thread,
  onSeen,
  focusTurnId,
  onCopyTurnLink,
  onFocusedTurn,
  className,
}: {
  thread: ThreadSummary;
  /** Called when the thread's newest activity has been on screen. The stamp
   * is the thread's own latest-activity time (server clock domain) — never
   * the client clock, which can sit behind the bridge's stamps. */
  onSeen?: (threadId: string, stamp: string) => void;
  focusTurnId?: string;
  onCopyTurnLink?: (runId: string) => void | Promise<void>;
  onFocusedTurn?: (runId: string) => void;
  className?: string;
}) {
  const { client } = useCrystal();
  const node = thread.node;
  const face = node.run;
  const working = sessionIsWorking(node);
  const eventsByRun = useAgents((s) => s.eventsByRun);
  const loadEvents = useAgents((s) => s.loadEvents);
  const cancel = useAgents((s) => s.cancel);

  // Eager-hydrate the newest turns; older ones expand on demand.
  useEffect(() => {
    for (const turn of node.turns.slice(-EAGER_TURNS)) void loadEvents(turn.id);
  }, [node.turns, loadEvents]);

  // Mark seen while the thread is open and activity lands.
  useEffect(() => {
    onSeen?.(thread.id, thread.lastActivity);
  }, [thread.id, thread.lastActivity, onSeen]);

  const runIds = useMemo(() => subtreeRunIds(node), [node]);
  const { questions, contextOf } = useChainQuestions(runIds);

  const items = useMemo<TranscriptItem[]>(
    () =>
      buildTranscriptItems({
        turns: node.turns,
        eventsByRun,
        questions,
        workers: node.workers,
      }),
    [node, eventsByRun, questions],
  );

  const answerQuestion = useCallback(
    async (record: TaskQuestion, answer: string) => {
      const ctx = contextOf.get(record.id);
      if (!ctx) throw new Error("This question's board record is gone.");
      const result = await client.request("task.answer", {
        path: ctx.path,
        taskId: ctx.taskId,
        questionId: record.id,
        answer,
      });
      if (!result.ok) throw new Error(result.reason);
      // Typed delivery outcome — never collapsed to a boolean.
      return { notice: questionDeliveryNotice(result.delivery) };
    },
    [client, contextOf],
  );

  const renderQuestion = useCallback(
    (item: Extract<TranscriptItem, { kind: "question" }>) => {
      if (!item.record || !contextOf.has(item.record.id)) return null;
      const record = item.record;
      return (
        <QuestionCard
          context={<span>This thread is waiting on you</span>}
          question={item.text}
          options={(record.options.length ? record.options : item.options).map((o) => ({
            value: o,
            label: o,
          }))}
          recommended={record.recommended ?? item.recommended}
          onAnswer={(answer) => answerQuestion(record, answer)}
        />
      );
    },
    [contextOf, answerQuestion],
  );

  const renderWorker = useCallback(
    (item: Extract<TranscriptItem, { kind: "delegation" }>) =>
      item.worker ? (
        <WorkerThread worker={item.worker} questions={questions} renderQuestion={renderQuestion} />
      ) : null,
    [questions, renderQuestion],
  );

  // Header rollup: the whole subtree's bill, and a live clock while working.
  const rollup = useMemo(() => rollupRunsUsage(flattenRuns(node)), [node]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);

  // Read-only workflow spend line for workflow-attributed threads.
  const workflowId = useMemo(() => sessionWorkflowId(node), [node]);
  const workflows = useWorkflows((s) => s.workflows);
  const templates = useWorkflows((s) => s.templates);
  const grantsLedger = useGrants((s) => s.ledger);
  const runs = useAgents((s) => s.runs);
  const workflow = workflowId ? workflows.find((w) => w.id === workflowId) : null;
  const spend = useMemo(
    () => (workflowId ? workflowSpend(workflowId, runs) : null),
    [workflowId, runs],
  );

  const surface = useRunSurface(face.id);
  const interactive = Boolean(face.terminalId);
  const tokens = usageTotalTokens(rollup.usage);

  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-col", className)}>
      <header className="flex items-center gap-2.5 border-b border-edge px-4 py-2.5">
        <StatusDot status={face.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{thread.title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
            {face.purpose ? <Badge tone="violet">{face.purpose}</Badge> : null}
            {face.model ? <span>{face.model}</span> : null}
            <span>{formatRunCost(rollup.costUsd || thread.costUsd)}</span>
            {tokens > 0 ? <span>{formatRunTokens(tokens)} tok</span> : null}
            {working && face.startedAt ? <span>{formatElapsed(face.startedAt, nowMs)}</span> : null}
            {workflow && spend ? (
              <span className="flex items-center gap-1">
                Workflow <SpendLine costUsd={spend.costUsd} budgetUsd={workflow.budgetUsd} />
              </span>
            ) : null}
            {workflow ? <StatusBadge status={workflow.status} /> : null}
          </div>
        </div>
        {working ? (
          <Tooltip content="Cancel the live turn">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Cancel the live turn"
              onClick={() => void cancel(face.id)}
            >
              <Ban className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
        ) : null}
      </header>

      {workflow && spend ? (
        <RunContextDetails
          workflow={workflow}
          spend={spend}
          ledger={grantsLedger}
          templates={templates}
        />
      ) : null}

      {interactive ? <InteractiveRunBanner run={face} /> : null}

      {interactive && working ? (
        <InteractiveRunTerminal run={face} className="min-h-0 flex-1" />
      ) : (
        <ThreadTranscript
          items={items}
          threadId={thread.id}
          working={working && !interactive}
          renderQuestion={renderQuestion}
          renderWorker={renderWorker}
          onExpandTurn={(runId) => loadEvents(runId)}
          focusTurnId={focusTurnId}
          onCopyTurnLink={onCopyTurnLink}
          onFocusedTurn={onFocusedTurn}
        />
      )}

      <ChangesFooter run={face} surface={surface} />

      {workflow && ["completed", "failed", "cancelled"].includes(workflow.status) ? (
        <div className="border-t border-edge px-4 py-3 text-xs text-ink-muted">
          This workflow is closed. The transcript is read-only.
        </div>
      ) : (
        <ThreadComposer run={face} className="border-t border-edge" />
      )}
    </div>
  );
}

/** A nested worker's transcript inside its delegation row. */
function WorkerThread({
  worker,
  questions,
  renderQuestion,
}: {
  worker: RunNode;
  /** The chain's board question records — workers' questions live here too. */
  questions?: readonly TaskQuestion[];
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => React.ReactNode;
}) {
  const eventsByRun = useAgents((s) => s.eventsByRun);
  const loadEvents = useAgents((s) => s.loadEvents);
  useEffect(() => {
    for (const turn of worker.turns.slice(-EAGER_TURNS)) void loadEvents(turn.id);
  }, [worker.turns, loadEvents]);
  const items = useMemo(
    () =>
      buildTranscriptItems({
        turns: worker.turns,
        eventsByRun,
        questions,
        workers: worker.workers,
      }),
    [worker, eventsByRun, questions],
  );
  return (
    <ThreadTranscript
      items={items}
      threadId={worker.turns[0]!.id}
      findDisabled
      working={sessionIsWorking(worker)}
      renderQuestion={renderQuestion}
      renderWorker={(item) =>
        item.worker ? (
          <WorkerThread worker={item.worker} questions={questions} renderQuestion={renderQuestion} />
        ) : null
      }
      onExpandTurn={(runId) => loadEvents(runId)}
      className="max-h-96 flex-none"
    />
  );
}

/**
 * Compact worktree footer for isolated runs: the diffstat, land the merge
 * when the prediction is clean, hand conflicts to a resolver run, or discard.
 */
function ChangesFooter({
  run,
  surface,
}: {
  run: AgentRun;
  surface: ReturnType<typeof useRunSurface>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const preview = surface.merge.preview;

  useEffect(() => {
    setNote(null);
    setBusy(null);
  }, [run.id]);

  if (!run.worktreePath) return null;
  const statLine = surface.diff?.stat.trim().split("\n").pop()?.trim() ?? null;

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2 border-t border-edge bg-surface-1 px-3 py-1.5 text-[11px] text-ink-muted">
      <FileDiff className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate">
        {statLine ?? "Isolated worktree"}
        {surface.merge.error ? ` — ${surface.merge.error}` : ""}
        {note ? ` — ${note}` : ""}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy != null}
        onClick={() => void act("refresh", async () => {
          await surface.onRefreshDiff();
          await surface.merge.onRefresh();
        })}
      >
        <RefreshCw className="h-3 w-3" /> Refresh
      </Button>
      {preview && preview.target && preview.conflicts.length === 0 && preview.ahead > 0 ? (
        <Button
          variant="primary"
          size="sm"
          disabled={busy != null}
          onClick={() =>
            void act(
              "merge",
              () => surface.merge.onMerge(),
              `Merged to ${preview.target}`,
            )
          }
        >
          <GitMerge className="h-3 w-3" /> Merge to {preview.target}
        </Button>
      ) : null}
      {preview && preview.conflicts.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy != null}
          onClick={() =>
            void act(
              "resolve",
              () => surface.merge.onResolve(),
              "Resolver agent dispatched — it lands as a worker in this thread.",
            )
          }
        >
          <GitMerge className="h-3 w-3" /> Resolve {preview.conflicts.length} conflicts
        </Button>
      ) : null}
      <Tooltip content="Discard the worktree and its changes">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Discard the worktree"
          disabled={busy != null}
          onClick={() => void act("discard", () => surface.onDiscard(), "Worktree discarded")}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </Tooltip>
    </div>
  );
}

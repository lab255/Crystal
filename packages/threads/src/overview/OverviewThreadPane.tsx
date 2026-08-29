import { useCallback, useEffect, useMemo } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { sessionIsWorking, type RunEvent, type RunNode } from "@crystal/core";
import { QuestionCard, questionDeliveryNotice, useCrystal, type FleetQuestion } from "@crystal/client";
import { Button, EmptyState, StatusDot, type MenuEntry } from "@crystal/ui";
import { CreateProgram, ProgramSession } from "../ProgramThread.js";
import { ThreadComposer } from "../ThreadComposer.js";
import { ThreadTranscript } from "../ThreadTranscript.js";
import { buildTranscriptItems, type TranscriptItem } from "../transcript-items.js";
import type { OverviewThread } from "./overview-thread-model.js";

function NodeTranscript({ node, eventsByRun, loadEvents, questions }: { node: RunNode; eventsByRun: Record<string, RunEvent[]>; loadEvents: (id: string) => Promise<void>; questions: FleetQuestion[] }) {
  useEffect(() => { for (const turn of node.turns.slice(-2)) void loadEvents(turn.id); }, [node.turns, loadEvents]);
  const items = useMemo(() => buildTranscriptItems({ turns: node.turns, eventsByRun, workers: node.workers, questions: questions.map((row) => row.question) }), [node, eventsByRun, questions]);
  const renderWorker = useCallback((item: Extract<TranscriptItem, { kind: "delegation" }>) => item.worker ? <NodeTranscript node={item.worker} eventsByRun={eventsByRun} loadEvents={loadEvents} questions={questions} /> : null, [eventsByRun, loadEvents, questions]);
  return <ThreadTranscript items={items} threadId={node.turns[0]!.id} working={sessionIsWorking(node)} renderWorker={renderWorker} onExpandTurn={loadEvents} />;
}

export function OverviewThreadPane({ thread, creating, notice, dismissNotice, onCreated, questions, eventsByRun, loadEvents, entries, openMenu, openProject }: {
  thread: OverviewThread | null; creating: boolean; notice: string | null; dismissNotice: () => void;
  onCreated: (id: string) => void; questions: FleetQuestion[]; eventsByRun: Record<string, RunEvent[]>;
  loadEvents: (id: string) => Promise<void>; entries: MenuEntry[];
  openMenu: (event: React.MouseEvent, entries: MenuEntry[]) => void; openProject: () => void;
}) {
  const { fleet } = useCrystal();
  if (creating) return <main className="flex min-w-0 flex-1 flex-col">{notice ? <Notice text={notice} dismiss={dismissNotice} /> : null}<CreateProgram onCreated={(program) => onCreated(program.id)} /></main>;
  if (!thread) return <main className="flex flex-1 items-center justify-center"><EmptyState title="Pick a thread">Select a conversation on the left, or start a new program.</EmptyState></main>;
  if (thread.program) return <main className="flex min-w-0 flex-1 flex-col">{notice ? <Notice text={notice} dismiss={dismissNotice} /> : null}<ProgramSession program={thread.program} /></main>;
  const summary = thread.summary!;
  const face = summary.node.run;
  const client = thread.ref.kind === "workspace" ? fleet.clientOf(thread.ref.sid) : null;
  const activeQuestionRows = questions.filter((row) => row.question.runId && summary.node.turns.some((run) => run.id === row.question.runId));
  return <main className="flex min-w-0 flex-1 flex-col">
    {notice ? <Notice text={notice} dismiss={dismissNotice} /> : null}
    <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
      <button type="button" onClick={openProject} className="max-w-48 truncate rounded bg-surface-2 px-2 py-1 text-[10px] text-ink-muted">{thread.ref.kind === "workspace" ? thread.ref.ws : "Coordinator"}</button>
      <StatusDot status={face.status} /><div className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{thread.title}</div>
      <Button variant="ghost" size="icon-sm" aria-label="Thread actions" onClick={(event) => openMenu(event, entries)}><MoreHorizontal className="h-4 w-4" /></Button>
    </header>
    <NodeTranscript node={summary.node} eventsByRun={eventsByRun} loadEvents={loadEvents} questions={activeQuestionRows} />
    {activeQuestionRows.length ? <div className="space-y-2 border-t border-edge px-4 py-2">{activeQuestionRows.map((row) => <QuestionCard key={row.question.id} context={<span>{row.projectName} / {row.taskTitle}</span>} question={row.question.text} options={row.question.options.map((value) => ({ value, label: value }))} recommended={row.question.recommended} onAnswer={async (answer) => {
      if (!client || thread.ref.kind !== "workspace") throw new Error("This bridge is disconnected.");
      const result = await client.request("task.answer", { ws: thread.ref.ws, path: row.projectPath, taskId: row.taskId, questionId: row.question.id, answer });
      if (!result.ok) throw new Error(result.reason); return { notice: questionDeliveryNotice(result.delivery) };
    }} />)}</div> : null}
    {thread.workflow && ["completed", "failed", "cancelled"].includes(thread.workflow.status) ? <div className="border-t border-edge px-4 py-3 text-xs text-ink-muted">This workflow is closed. The transcript is read-only.</div> : <>
      {thread.workflow?.status === "paused" ? <div className="border-t border-edge px-4 py-2 text-xs text-ink-muted">Paused by {thread.workflow.pausedBy ?? "user"} — use the thread menu to resume.</div> : null}
      {thread.ref.kind === "workspace" ? <ThreadComposer run={face} sid={thread.ref.sid} ws={thread.ref.ws} className="border-t border-edge" /> : null}
    </>}
  </main>;
}

function Notice({ text, dismiss }: { text: string; dismiss: () => void }) { return <div role="alert" className="flex items-center gap-2 border-b border-danger/40 bg-surface-2 px-4 py-2 text-xs text-danger"><span className="flex-1">{text}</span><button type="button" aria-label="Dismiss error" onClick={dismiss}><X className="h-3.5 w-3.5" /></button></div>; }

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  GitBranch,
  History,
  Link,
} from "lucide-react";
import { formatRunCost, formatRunDuration } from "@crystal/client";
import { Badge, Spinner, StatusDot, cn } from "@crystal/ui";
import type { TranscriptItem, WorkEntry } from "./transcript-items.js";

export interface QuestionAnswerResult {
  notice?: string;
}

/**
 * The chat transcript: renders the items `buildTranscriptItems` folded.
 * Purely presentational — answering, permission decisions and worker
 * expansion arrive as callbacks so the same renderer serves workspace
 * threads, nested workers and the program-manager chat.
 */
export function ThreadTranscript({
  items,
  threadId,
  /** Render the answering surface for a pending question item. */
  renderQuestion,
  /** Render an expanded worker's nested transcript (delegation rows). */
  renderWorker,
  /** Fetch a collapsed turn's events (the row shows a spinner meanwhile). */
  onExpandTurn,
  focusTurnId,
  onCopyTurnLink,
  /** Live thread: show the working shimmer under the last item. */
  working = false,
  className,
}: {
  items: readonly TranscriptItem[];
  /** Scroll state is per-thread; switching threads re-follows the tail. */
  threadId: string;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
  onExpandTurn?: (runId: string) => void | Promise<void>;
  /** Scroll to and briefly highlight a turn once its rows are rendered. */
  focusTurnId?: string;
  /** When supplied, exposes a per-turn copy-link action. */
  onCopyTurnLink?: (runId: string) => void | Promise<void>;
  working?: boolean;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastFocused = useRef<string | null>(null);
  const [highlightedTurnId, setHighlightedTurnId] = useState<string | null>(null);
  const turns = useMemo(() => groupItemsByTurn(items), [items]);

  useEffect(() => {
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadId]);

  // Key the tail-follow on `items` (a fresh array per fold), not its length:
  // streamed text merges into the LAST item in place (assistant prose,
  // work-entry growth), so length alone misses in-place growth.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, working]);

  useEffect(() => {
    if (!focusTurnId || lastFocused.current === `${threadId}:${focusTurnId}`) return;
    if (!turns.some((turn) => turn.runId === focusTurnId)) return;
    const target = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? [],
    ).find((element) => element.dataset.turnId === focusTurnId);
    if (!target) return;
    lastFocused.current = `${threadId}:${focusTurnId}`;
    stickToBottom.current = false;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightedTurnId(focusTurnId);
  }, [focusTurnId, items, threadId, turns]);

  useEffect(() => {
    if (!highlightedTurnId) return;
    const timer = window.setTimeout(() => setHighlightedTurnId(null), 1_500);
    return () => window.clearTimeout(timer);
  }, [highlightedTurnId]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className={cn("min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3", className)}
    >
      {turns.map((turn, index) => (
        <div
          key={turn.runId}
          data-turn-id={turn.runId}
          className={cn(
            "group/turn relative space-y-2 rounded-lg transition-colors duration-500",
            highlightedTurnId === turn.runId
              && "bg-accent-blue/10 ring-2 ring-accent-blue/40",
          )}
        >
          {onCopyTurnLink ? (
            <button
              type="button"
              aria-label="Copy link to turn"
              title={`Copy link to turn ${index + 1}`}
              onClick={() => void onCopyTurnLink(turn.runId)}
              className={cn(
                "absolute right-1 top-1 z-10 rounded p-1 text-ink-faint opacity-0",
                "hover:bg-surface-2 hover:text-ink group-hover/turn:opacity-100",
                "focus-visible:opacity-100",
              )}
            >
              <Link className="h-3 w-3" />
            </button>
          ) : null}
          {turn.items.map((item) => (
            <TranscriptItemRow
              key={item.id}
              item={item}
              focusTurnId={focusTurnId}
              renderQuestion={renderQuestion}
              renderWorker={renderWorker}
              onExpandTurn={onExpandTurn}
            />
          ))}
        </div>
      ))}
      {working ? (
        <div className="flex items-center gap-2 px-1 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Working…
        </div>
      ) : null}
    </div>
  );
}

function itemTurnId(item: TranscriptItem): string {
  if ("runId" in item) return item.runId;
  // Transcript item ids follow the `${turnId}:${seq}` contract from transcript-items.ts.
  return item.id.slice(0, item.id.lastIndexOf(":"));
}

function groupItemsByTurn(items: readonly TranscriptItem[]) {
  const groups: Array<{ runId: string; items: TranscriptItem[] }> = [];
  for (const item of items) {
    const runId = itemTurnId(item);
    const tail = groups[groups.length - 1];
    if (tail?.runId === runId) tail.items.push(item);
    else groups.push({ runId, items: [item] });
  }
  return groups;
}

function TranscriptItemRow({
  item,
  focusTurnId,
  renderQuestion,
  renderWorker,
  onExpandTurn,
}: {
  item: TranscriptItem;
  focusTurnId?: string;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
  onExpandTurn?: (runId: string) => void | Promise<void>;
}) {
  switch (item.kind) {
    case "user":
      return <UserRow text={item.text} />;
    case "assistant":
      return <AssistantRow text={item.text} thinking={item.thinking} />;
    case "work":
      return <WorkRow item={item} />;
    case "question":
      return <QuestionRow item={item} renderQuestion={renderQuestion} />;
    case "delegation":
      return (
        <DelegationRow
          item={item}
          focusTurnId={focusTurnId}
          renderWorker={renderWorker}
        />
      );
    case "permission":
      return (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed text-ink",
            item.state === "pending"
              ? "border-warn/30 bg-warn/10"
              : item.state === "allowed"
                ? "border-ok/25 bg-ok/8"
                : "border-danger/25 bg-danger/8",
          )}
        >
          <CircleHelp
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              item.state === "pending" ? "text-warn" : item.state === "allowed" ? "text-ok" : "text-danger",
            )}
          />
          <span className="whitespace-pre-wrap">
            {item.state === "pending"
              ? `Waiting for permission: ${item.detail ?? item.tool}`
              : `Permission ${item.state}: ${item.detail ?? item.tool}`}
          </span>
        </div>
      );
    case "turn-end":
      return (
        <div className="flex items-center gap-2 px-1 text-[10px] text-ink-faint">
          {item.ok ? (
            <CircleCheck className="h-3 w-3 text-ok" />
          ) : (
            <CircleX className="h-3 w-3 text-danger" />
          )}
          <span className={cn(!item.ok && "text-danger")}>
            {item.ok ? "Turn settled" : item.resultText || "Turn failed"}
          </span>
          <span>·</span>
          <span>{formatRunCost(item.costUsd)}</span>
          <span>{formatRunDuration(item.durationMs)}</span>
        </div>
      );
    case "system":
      return (
        <div
          className={cn(
            "px-1 text-[10px]",
            item.tone === "warn" ? "text-warn" : "text-ink-faint",
          )}
        >
          {item.text}
        </div>
      );
    case "collapsed-turn":
      return <CollapsedTurnRow item={item} onExpandTurn={onExpandTurn} />;
    default:
      return null;
  }
}

function UserRow({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 600 || text.split("\n").length > 8;
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-crystal-500/12 px-3.5 py-2 text-xs leading-relaxed text-ink",
          long && !expanded && "line-clamp-6 cursor-pointer",
        )}
        onClick={long && !expanded ? () => setExpanded(true) : undefined}
        title={long && !expanded ? "Show the full message" : undefined}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantRow({ text, thinking }: { text: string; thinking: string | null }) {
  const [showThinking, setShowThinking] = useState(false);
  return (
    <div className="max-w-[92%]">
      {thinking ? (
        <button
          type="button"
          onClick={() => setShowThinking((v) => !v)}
          className="mb-1 flex items-center gap-1.5 px-1 text-[10px] italic text-ink-faint hover:text-ink-muted"
        >
          <Brain className="h-3 w-3" /> {showThinking ? "Hide thinking" : "Thought for a while…"}
        </button>
      ) : null}
      {showThinking && thinking ? (
        <div className="mb-1.5 whitespace-pre-wrap rounded-lg border border-edge/70 bg-surface-1 px-3 py-2 text-[11px] italic leading-relaxed text-ink-faint">
          {thinking}
        </div>
      ) : null}
      <div className="whitespace-pre-wrap px-1 text-xs leading-relaxed text-ink">{text}</div>
    </div>
  );
}

function WorkRow({ item }: { item: Extract<TranscriptItem, { kind: "work" }> }) {
  // Errors open loud; routine exploration stays a one-line summary.
  const [open, setOpen] = useState(item.hasError);
  return (
    <div
      className={cn(
        "rounded-lg border",
        item.hasError ? "border-danger/25 bg-danger/5" : "border-edge/70 bg-surface-1",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-ink-muted"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {item.pending ? <Spinner className="mr-1.5 inline-block h-3 w-3 align-[-2px]" /> : null}
          {item.title}
        </span>
        {item.hasError ? <Badge tone="rose">error</Badge> : null}
      </button>
      {open ? (
        <div className="space-y-1 border-t border-edge/70 px-2.5 py-1.5">
          {item.entries.map((entry) => (
            <WorkEntryRow key={entry.toolUseId} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkEntryRow({ entry }: { entry: WorkEntry }) {
  const [open, setOpen] = useState(entry.isError);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px]",
          entry.isError ? "text-danger" : "text-ink-muted hover:text-ink",
        )}
      >
        {open ? (
          <ChevronDown className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <ChevronRight className="h-2.5 w-2.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{entry.title}</span>
        {entry.result === null ? <Spinner className="h-2.5 w-2.5" /> : null}
      </button>
      {open ? (
        <pre className="mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-edge/60 bg-surface-2/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-muted">
          {entry.input}
          {entry.result != null ? `\n\n— result —\n${entry.result || "(empty)"}` : ""}
        </pre>
      ) : null}
    </div>
  );
}

function QuestionRow({
  item,
  renderQuestion,
}: {
  item: Extract<TranscriptItem, { kind: "question" }>;
  renderQuestion?: (item: Extract<TranscriptItem, { kind: "question" }>) => ReactNode;
}) {
  const answered = item.record?.answer != null;
  if (!answered && renderQuestion) {
    const custom = renderQuestion(item);
    if (custom) return <>{custom}</>;
  }
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs leading-relaxed",
        answered ? "border-edge/70 bg-surface-1 text-ink-muted" : "border-warn/30 bg-warn/10 text-ink",
      )}
    >
      <div className="flex items-start gap-2">
        <CircleHelp className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", answered ? "text-ink-faint" : "text-warn")} />
        <div className="min-w-0">
          <span className="whitespace-pre-wrap">{item.text}</span>
          {answered ? (
            <div className="mt-1 whitespace-pre-wrap text-[11px] text-ink">
              <span className="font-semibold">Answer:</span> {item.record!.answer}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-ink-faint">Waiting for your answer.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function DelegationRow({
  item,
  focusTurnId,
  renderWorker,
}: {
  item: Extract<TranscriptItem, { kind: "delegation" }>;
  focusTurnId?: string;
  renderWorker?: (item: Extract<TranscriptItem, { kind: "delegation" }>) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const worker = item.worker;
  const canExpand = worker != null && renderWorker != null;
  const containsFocus = worker != null
    && focusTurnId != null
    && nodeContainsTurn(worker, focusTurnId);
  useEffect(() => {
    if (containsFocus) setOpen(true);
  }, [containsFocus]);
  return (
    <div className="rounded-lg border border-crystal-500/25 bg-crystal-500/5">
      <button
        type="button"
        onClick={canExpand ? () => setOpen((o) => !o) : undefined}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-ink",
          !canExpand && "cursor-default",
        )}
      >
        {canExpand ? (
          open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
          )
        ) : (
          <GitBranch className="h-3 w-3 shrink-0 text-crystal-300" />
        )}
        {worker ? <StatusDot status={worker.run.status} /> : null}
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink-faint">Worker · </span>
          {item.headline}
        </span>
        {worker?.run.costUsd != null ? (
          <span className="shrink-0 text-[10px] text-ink-faint">{formatRunCost(worker.run.costUsd)}</span>
        ) : null}
      </button>
      {open && canExpand ? (
        <div className="border-t border-crystal-500/20 pl-3">{renderWorker(item)}</div>
      ) : null}
    </div>
  );
}

type WorkerNode = NonNullable<Extract<TranscriptItem, { kind: "delegation" }>["worker"]>;

function nodeContainsTurn(node: WorkerNode, runId: string): boolean {
  return node.turns.some((turn) => turn.id === runId)
    || node.workers.some((worker) => nodeContainsTurn(worker, runId));
}

function CollapsedTurnRow({
  item,
  onExpandTurn,
}: {
  item: Extract<TranscriptItem, { kind: "collapsed-turn" }>;
  onExpandTurn?: (runId: string) => void | Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button"
      disabled={!onExpandTurn || loading}
      onClick={async () => {
        if (!onExpandTurn) return;
        setLoading(true);
        try {
          await onExpandTurn(item.runId);
        } finally {
          setLoading(false);
        }
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-edge/70 px-3 py-1.5 text-left text-[11px] text-ink-faint hover:text-ink-muted"
    >
      {loading ? <Spinner className="h-3 w-3" /> : <History className="h-3 w-3" />}
      {item.headline} — show what happened
    </button>
  );
}

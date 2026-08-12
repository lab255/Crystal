import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  GitBranch,
  Terminal,
  Wrench,
} from "lucide-react";
import type { RunEvent, TerminalStream } from "@crystal/core";
import { Badge, Spinner, cn } from "@crystal/ui";
import { agentEventToChunk } from "./agent-event-chunk.js";

/** How much of each event a transcript shows. */
export type TranscriptDensity = "comfortable" | "compact";

/**
 * The streamed transcript of one agent run, as a pure presentational
 * component: it takes events and renders them, with no store or bridge
 * coupling. Every place that shows an agent thinking — the orchestrator's run
 * view, the hub's program-manager session — renders through this, so a
 * transcript looks and behaves the same wherever it appears.
 */
export function RunTranscript({
  events,
  /**
   * The run being shown. Scroll state is per-run: without this, switching to
   * another turn keeps the previous run's scroll position and "the user
   * scrolled up" flag, so a live transcript silently stops following.
   */
  runId,
  /** Show the "starting…" spinner while a live run has not emitted anything yet. */
  starting = false,
  /**
   * "comfortable" renders each event as a full block; "compact" flattens the
   * stream to the terminal console's one-line chunks (`agentEventToChunk`) —
   * the same model, so the two densities never drift.
   */
  density = "comfortable",
  className,
}: {
  events: readonly RunEvent[];
  runId?: string | null;
  starting?: boolean;
  density?: TranscriptDensity;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Follow the tail while the user is at the bottom; stop the moment they
  // scroll up to read something.
  const stickToBottom = useRef(true);

  useEffect(() => {
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className={cn("min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3", className)}
    >
      {events.length === 0 && starting ? (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <Spinner className="h-3.5 w-3.5" /> Starting Claude Code…
        </div>
      ) : null}
      {density === "compact"
        ? events.map((e) => <CompactEventRow key={e.seq} runEvent={e} />)
        : events.map((e) => <RunEventRow key={e.seq} runEvent={e} />)}
    </div>
  );
}

const COMPACT_STREAM_CLASSES: Record<TerminalStream, string> = {
  stdout: "text-ink",
  stderr: "text-warn",
  system: "text-ink-faint",
  input: "text-crystal-300",
};

/** One event as its flattened one-line console chunk (null = hidden). */
function CompactEventRow({ runEvent }: { runEvent: RunEvent }) {
  const chunk = agentEventToChunk(runEvent.event);
  if (!chunk) return null;
  return (
    <div
      className={cn(
        "whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed",
        COMPACT_STREAM_CLASSES[chunk.stream],
      )}
    >
      {chunk.text.replace(/\n$/, "")}
    </div>
  );
}

/** One event of a run's stream. */
function RunEventRow({ runEvent }: { runEvent: RunEvent }) {
  const { event } = runEvent;
  switch (event.type) {
    case "init":
      return (
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          <Terminal className="h-3 w-3" />
          session {event.sessionId.slice(0, 8)} · {event.model} · {event.tools.length} tools
        </div>
      );
    case "text":
      return (
        <div className="whitespace-pre-wrap rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink">
          {event.text}
        </div>
      );
    case "thinking":
      return (
        <div className="flex gap-2 px-1 text-[11px] italic leading-relaxed text-ink-faint">
          <Brain className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap line-clamp-4">{event.text}</span>
        </div>
      );
    case "tool_use":
      return <Collapsible icon={Wrench} title={event.name} body={pretty(event.input)} tone="tool" />;
    case "tool_result":
      return (
        <Collapsible
          icon={event.isError ? CircleX : ChevronRight}
          title={event.isError ? "error" : "result"}
          body={event.content}
          tone={event.isError ? "error" : "result"}
        />
      );
    case "result":
      return (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed",
            event.ok ? "border-ok/25 bg-ok/8 text-ink" : "border-danger/25 bg-danger/8 text-ink",
          )}
        >
          {event.ok ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
          ) : (
            <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          )}
          <div className="min-w-0">
            <span className="whitespace-pre-wrap">
              {event.resultText || (event.ok ? "Completed" : "Failed")}
            </span>
            <div className="mt-1 flex gap-2 text-[10px] text-ink-faint">
              <span>{formatRunCost(event.costUsd)}</span>
              <span>{formatRunDuration(event.durationMs)}</span>
              {event.turns != null ? <span>{event.turns} turns</span> : null}
            </div>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-ink">
          <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
          <div className="min-w-0">
            <span className="whitespace-pre-wrap">{event.text}</span>
            <div className="mt-1 text-[10px] text-ink-faint">
              Waiting for the human owner — answer it from the task on the board.
            </div>
          </div>
        </div>
      );
    case "permission":
      return (
        <div
          className={cn(
            "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed text-ink",
            event.state === "pending"
              ? "border-warn/30 bg-warn/10"
              : event.state === "allowed"
                ? "border-ok/25 bg-ok/8"
                : "border-danger/25 bg-danger/8",
          )}
        >
          <CircleHelp
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0",
              event.state === "pending"
                ? "text-warn"
                : event.state === "allowed"
                  ? "text-ok"
                  : "text-danger",
            )}
          />
          <div className="min-w-0">
            <span className="whitespace-pre-wrap">
              {event.state === "pending"
                ? `Waiting for permission: ${event.detail ?? event.tool}`
                : `Permission ${event.state}: ${event.detail ?? event.tool}`}
            </span>
            {event.state === "pending" ? (
              <div className="mt-1 text-[10px] text-ink-faint">
                Grant the tool in the Agents tab&apos;s grants panel, or answer the question on
                the task — the run continues the moment it is decided.
              </div>
            ) : null}
          </div>
        </div>
      );
    case "dispatch":
      return (
        <div className="flex items-start gap-2 rounded-lg border border-crystal-500/30 bg-crystal-500/10 px-3 py-2 text-xs leading-relaxed text-ink">
          <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-crystal-300" />
          <div className="min-w-0">
            <span className="whitespace-pre-wrap">
              Dispatched worker: {event.spec.prompt.split("\n")[0]}
            </span>
            <div className="mt-1 text-[10px] text-ink-faint">
              Runs as a tracked worker beneath this manager.
            </div>
          </div>
        </div>
      );
    // Per-turn token bookkeeping; headers show the accumulated total.
    case "usage":
      return null;
    case "stderr":
      return <div className="px-1 font-mono text-[10px] text-warn/80">{event.text}</div>;
    case "status":
      return (
        <div className="px-1 text-[10px] uppercase tracking-wider text-ink-faint">
          {event.status}
          {event.message && event.message !== event.status ? ` — ${event.message}` : ""}
        </div>
      );
    default:
      return null;
  }
}

function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function Collapsible({
  icon: Icon,
  title,
  body,
  tone,
}: {
  icon: typeof Wrench;
  title: string;
  body: string;
  tone: "tool" | "result" | "error";
}) {
  const [open, setOpen] = useState(false);
  const preview = useMemo(() => {
    const first = body.split("\n").find((l) => l.trim()) ?? "";
    return first.length > 80 ? first.slice(0, 80) + "…" : first;
  }, [body]);

  return (
    <div
      className={cn(
        "rounded-lg border",
        tone === "error" ? "border-danger/25 bg-danger/5" : "border-edge bg-surface-1",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <Icon
          className={cn("h-3 w-3 shrink-0", tone === "error" ? "text-danger" : "text-crystal-300")}
        />
        <Badge tone={tone === "error" ? "rose" : "violet"}>{title}</Badge>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
            {preview}
          </span>
        ) : null}
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-edge px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
          {body || "(empty)"}
        </pre>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared run formatters                                               */
/* ------------------------------------------------------------------ */

/**
 * A run's dollar cost. Null is *unknown* (a run that has not reported yet) and
 * renders as a dash; zero is a known zero and renders as `$0.00` — reporting
 * `<$0.01` for something that cost nothing overstates it, which matters on a
 * program rollup where most deliveries have not started.
 * (`formatCost` in core renders a CostRollup — a different thing.)
 */
export function formatRunCost(costUsd: number | null | undefined): string {
  if (costUsd == null) return "—";
  if (costUsd === 0) return "$0.00";
  return costUsd < 0.01 ? "<$0.01" : `$${costUsd.toFixed(2)}`;
}

export function formatRunTokens(count: number | null | undefined): string {
  if (count == null || count === 0) return "—";
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatRunDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A live run's wall-clock elapsed time, rendered as a compact digital clock. */
export function formatElapsed(startedAtIso: string, nowMs: number): string {
  const startedAtMs = Date.parse(startedAtIso);
  const elapsedMs =
    Number.isFinite(startedAtMs) && Number.isFinite(nowMs)
      ? Math.max(0, nowMs - startedAtMs)
      : 0;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  const minutes = Math.floor(totalSeconds / 60);

  if (totalSeconds < 3600) return `${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${Math.floor(totalSeconds / 3600)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

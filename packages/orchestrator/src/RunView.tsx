import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Terminal,
  Wrench,
} from "lucide-react";
import type { AgentEvent, AgentRun, RunEvent } from "@crystal/core";
import { useAgents } from "@crystal/client";
import { Badge, Button, Spinner, StatusDot, cn } from "@crystal/ui";
import { formatCost, formatDuration } from "./prompt.js";

/** Live (or historical) view of a single agent run. */
export function RunView({ run }: { run: AgentRun }) {
  const events = useAgents((s) => s.eventsByRun[run.id] ?? EMPTY_EVENTS);
  const loadEvents = useAgents((s) => s.loadEvents);
  const cancel = useAgents((s) => s.cancel);

  useEffect(() => {
    void loadEvents(run.id);
  }, [run.id, loadEvents]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-edge px-3 py-2">
        <StatusDot status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ink">{run.prompt.split("\n")[0]}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-faint">
            {run.model ? <span>{run.model}</span> : null}
            <span>{formatCost(run.costUsd)}</span>
            <span>{formatDuration(run.durationMs)}</span>
            {run.turns != null ? <span>{run.turns} turns</span> : null}
            <span className="font-mono">{run.cwd}</span>
          </div>
        </div>
        {run.status === "running" ? (
          <Button variant="danger" size="xs" onClick={() => void cancel(run.id)}>
            <Ban className="h-3 w-3" /> Cancel
          </Button>
        ) : null}
      </header>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3"
      >
        {events.length === 0 && run.status === "running" ? (
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <Spinner className="h-3.5 w-3.5" /> Starting Claude Code…
          </div>
        ) : null}
        {events.map((e) => (
          <EventRow key={e.seq} runEvent={e} />
        ))}
      </div>
    </div>
  );
}

const EMPTY_EVENTS: RunEvent[] = [];

function EventRow({ runEvent }: { runEvent: RunEvent }) {
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
            event.ok
              ? "border-ok/25 bg-ok/8 text-ink"
              : "border-danger/25 bg-danger/8 text-ink",
          )}
        >
          {event.ok ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
          ) : (
            <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
          )}
          <div className="min-w-0">
            <span className="whitespace-pre-wrap">{event.resultText || (event.ok ? "Completed" : "Failed")}</span>
            <div className="mt-1 flex gap-2 text-[10px] text-ink-faint">
              <span>{formatCost(event.costUsd)}</span>
              <span>{formatDuration(event.durationMs)}</span>
              {event.turns != null ? <span>{event.turns} turns</span> : null}
            </div>
          </div>
        </div>
      );
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
        <Icon className={cn("h-3 w-3 shrink-0", tone === "error" ? "text-danger" : "text-crystal-300")} />
        <Badge tone={tone === "error" ? "rose" : "violet"}>{title}</Badge>
        {!open && preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">{preview}</span>
        ) : null}
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto border-t border-edge px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-muted whitespace-pre-wrap">
          {body || "(empty)"}
        </pre>
      ) : null}
    </div>
  );
}

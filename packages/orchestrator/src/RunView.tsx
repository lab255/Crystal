import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  GitBranch,
  RefreshCw,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { usageTotalTokens, type AgentEvent, type AgentRun, type RunEvent } from "@crystal/core";
import { useAgents, useCrystal } from "@crystal/client";
import { Badge, Button, Spinner, StatusDot, Tooltip, cn } from "@crystal/ui";
import { formatCost, formatDuration, formatTokens } from "./prompt.js";

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
            {run.purpose ? <Badge tone="violet">{run.purpose}</Badge> : null}
            {run.model ? <span>{run.model}</span> : null}
            <span>{formatCost(run.costUsd)}</span>
            {run.usage ? <span>{formatTokens(usageTotalTokens(run.usage))} tok</span> : null}
            {run.usage?.apiCalls ? <span>{run.usage.apiCalls} calls</span> : null}
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
      {run.worktreePath ? <ChangesPanel run={run} /> : null}
    </div>
  );
}

/** Diff of an isolated run's worktree, loaded on demand and refreshable live. */
function ChangesPanel({ run }: { run: AgentRun }) {
  const { client } = useCrystal();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<{ diff: string; stat: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await client.request("agent.diff", { runId: run.id });
      setDiff(result);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-edge bg-surface-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs font-medium text-ink"
          onClick={() => {
            setOpen((o) => !o);
            if (!open && !diff) void load();
          }}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <GitBranch className="h-3.5 w-3.5 text-crystal-300" />
          Changes
          <span className="font-normal text-ink-faint">worktree</span>
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">
          {run.worktreePath}
        </span>
        <Tooltip content="Refresh diff">
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Refresh diff">
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
          </Button>
        </Tooltip>
        <Tooltip content="Discard worktree and its changes">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove worktree"
            onClick={() => void client.request("agent.cleanupWorktree", { runId: run.id })}
          >
            <Trash2 className="h-3 w-3 text-danger" />
          </Button>
        </Tooltip>
      </div>
      {open ? (
        <div className="max-h-72 overflow-auto border-t border-edge px-3 py-2">
          {diff === null ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : diff.diff.trim() === "" ? (
            <div className="py-2 text-xs text-ink-faint">No changes in the worktree yet.</div>
          ) : (
            <>
              <pre className="mb-2 whitespace-pre-wrap font-mono text-[10.5px] leading-relaxed text-ink-muted">
                {diff.stat.trim()}
              </pre>
              <DiffText diff={diff.diff} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DiffText({ diff }: { diff: string }) {
  return (
    <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => (
        <span
          key={i}
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-ok/10 text-ok"
              : line.startsWith("-") && !line.startsWith("---")
                ? "bg-danger/10 text-danger"
                : line.startsWith("@@")
                  ? "text-prism-400"
                  : line.startsWith("diff ") || line.startsWith("index ")
                    ? "text-ink-faint"
                    : "text-ink-muted",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
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
    // Per-turn token bookkeeping; the header shows the accumulated total.
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

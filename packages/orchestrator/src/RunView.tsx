import { useEffect, useState } from "react";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  GitBranch,
  RefreshCw,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { usageTotalTokens, type AgentRun, type RunEvent } from "@crystal/core";
import { RunTranscript, useAgents, useCrystal, useTerminals, useWorkspaces } from "@crystal/client";
import { Badge, Button, Spinner, StatusDot, Tooltip, cn } from "@crystal/ui";
import { formatCost, formatDuration, formatTokens } from "./prompt.js";

/** Live (or historical) view of a single agent run. */
export function RunView({ run }: { run: AgentRun }) {
  const events = useAgents((s) => s.eventsByRun[run.id] ?? EMPTY_EVENTS);
  const loadEvents = useAgents((s) => s.loadEvents);
  const cancel = useAgents((s) => s.cancel);
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);

  useEffect(() => {
    void loadEvents(run.id);
  }, [run.id, loadEvents]);

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
      {run.terminalId ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-2/50 px-3 py-1.5 text-[11px] text-ink-muted">
          <TerminalSquare className="h-3 w-3 shrink-0 text-crystal-300" />
          {run.status === "running"
            ? "This run is a native interactive session — its transcript lives in its terminal."
            : "This run was a native interactive session — its transcript lived in its terminal."}
          {run.status === "running" ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const ws = run.terminalWs ?? activeWs;
                if (ws && run.terminalId) void focusTerminal(ws, run.terminalId);
              }}
            >
              Open its terminal →
            </Button>
          ) : null}
        </div>
      ) : null}
      <RunTranscript
        events={events}
        runId={run.id}
        // An interactive run streams no events here — without this the pane
        // would show a "starting…" spinner for the session's whole life.
        starting={run.status === "running" && !run.terminalId}
      />
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

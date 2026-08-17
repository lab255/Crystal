import { useEffect, useMemo, useState } from "react";
import { Bot, Clock3 } from "lucide-react";
import type { AgentRun } from "@crystal/core";
import {
  EMPTY_RUNS,
  formatElapsed,
  useAttentionJump,
  useFleet,
  useFleetConnections,
  wsKey,
} from "@crystal/client";
import { StatusDot } from "@crystal/ui";

interface LiveRunEntry {
  run: AgentRun;
  sid: string;
  ws: string;
  workspaceName: string;
}

/** Fleet-wide working set: every queued/running conversation, one click from its session. */
export function LiveRunsPanel() {
  const connections = useFleetConnections();
  const runsByWs = useFleet((s) => s.runsByWs);
  const jump = useAttentionJump();

  const entries = useMemo(() => {
    const live: LiveRunEntry[] = [];
    for (const connection of connections) {
      for (const workspace of connection.workspaces) {
        const runs = runsByWs[wsKey(connection.sid, workspace.id)] ?? EMPTY_RUNS;
        for (const run of runs) {
          if (run.status === "running" || run.status === "queued") {
            live.push({
              run,
              sid: connection.sid,
              ws: workspace.id,
              workspaceName: workspace.name,
            });
          }
        }
      }
    }
    return live;
  }, [connections, runsByWs]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasEntries = entries.length > 0;
  useEffect(() => {
    if (!hasEntries) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasEntries]);

  if (entries.length === 0) return null;

  return (
    <section id="live-runs" aria-label="Working now" className="mb-5 scroll-mt-4">
      <div className="max-h-72 w-full overflow-y-auto rounded-xl border border-edge bg-surface-1">
        <div className="sticky top-0 z-10 border-b border-edge bg-surface-1 px-3 py-2 text-xs font-semibold text-ink">
          Working now · {entries.length}
        </div>
        <div className="divide-y divide-edge/70">
          {entries.map((entry) => {
            const startedAt = entry.run.startedAt ?? entry.run.createdAt;
            return <button
              key={`${entry.sid}:${entry.ws}:${entry.run.id}`}
              type="button"
              onClick={() => jump({ kind: "run", sid: entry.sid, ws: entry.ws, run: entry.run })}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <Bot className="h-4 w-4 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-ink">{entry.run.purpose || entry.run.prompt || "Agent run"}</span>
                <span className="block truncate text-[10px] text-ink-faint">{entry.workspaceName}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-ink-faint">
                <Clock3 className="h-3 w-3" />{formatElapsed(startedAt, nowMs)}
              </span>
              <StatusDot status={entry.run.status} />
            </button>;
          })}
        </div>
      </div>
    </section>
  );
}

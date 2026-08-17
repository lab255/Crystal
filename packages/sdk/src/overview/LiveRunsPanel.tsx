import { useMemo } from "react";
import type { AgentRun } from "@crystal/core";
import {
  EMPTY_RUNS,
  useAttentionJump,
  useFleet,
  useFleetConnections,
  wsKey,
} from "@crystal/client";
import { RunList } from "@crystal/orchestrator";

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

  const entryByRun = useMemo(
    () => new Map(entries.map((entry) => [entry.run.id, entry])),
    [entries],
  );

  if (entries.length === 0) return null;

  return (
    <section id="live-runs" aria-label="Working now" className="mb-5 scroll-mt-4">
      <RunList
        runs={entries.map((entry) => entry.run)}
        selectedRunId={null}
        onSelect={(id) => {
          const entry = entryByRun.get(id);
          if (entry) jump({ kind: "run", sid: entry.sid, ws: entry.ws, run: entry.run });
        }}
        title={`Working now · ${entries.length}`}
        wsNameOf={(run) => entryByRun.get(run.id)?.workspaceName}
        className="h-72 w-full rounded-xl border border-edge bg-surface-1"
      />
    </section>
  );
}

import { useCallback, type ReactNode } from "react";
import { Bot } from "lucide-react";
import type { AgentRun } from "@crystal/core";
import { RunSurface, useCrystal, useFollowChain, useRunSurface } from "@crystal/client";
import { EmptyState } from "@crystal/ui";
import { messageRun } from "./message-run.js";
import { RunList } from "./RunList.js";

/**
 * The one RunList + RunSurface split layout — the Runs tab and the Agents
 * tab both render this instead of each composing the pair themselves.
 * Selection is caller-owned (nav store / local state); everything else —
 * events, chain, diff verbs, cancel, and message routing via
 * {@link messageRun} — is wired here through `useRunSurface`.
 */
export function RunsPane({
  runs,
  selectedRunId,
  onSelect,
  title,
  emptyHint,
  listHeader,
  emptyState,
  attention,
}: {
  /** The runs shown in the sidepane (callers filter to their scope). */
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  /** RunList sidepane header; pass `null` for the bare list. */
  title?: string | null;
  emptyHint?: string;
  /** Rendered above the run list inside the sidepane (e.g. filter chips). */
  listHeader?: ReactNode;
  /** Right pane when no run is selected (defaults to a generic prompt). */
  emptyState?: ReactNode;
  /** Run ids currently requiring operator attention. */
  attention?: ReadonlySet<string>;
}) {
  const { client } = useCrystal();
  const surface = useRunSurface(selectedRunId);
  const run = surface.run;

  const onSend = useCallback(
    async (text: string) => {
      if (!run) return;
      const result = await messageRun(client, run, text);
      // A delivered message resumed the chain as a fresh turn — follow it, or
      // the user is stranded watching the superseded turn while the reply
      // streams into a run they'd have to find themselves.
      if (result.runId && result.runId !== run.id) onSelect(result.runId);
      return result;
    },
    [client, run, onSelect],
  );

  useFollowChain(runs, selectedRunId, onSelect);

  const list = (
    <RunList
      runs={runs}
      selectedRunId={selectedRunId}
      onSelect={onSelect}
      title={title}
      emptyHint={emptyHint}
      attention={attention}
      className={listHeader ? "w-full border-r-0" : undefined}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      {listHeader ? (
        <div className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
          {listHeader}
          <div className="min-h-0 flex-1">{list}</div>
        </div>
      ) : (
        list
      )}
      <main className="min-w-0 flex-1">
        {run ? (
          <RunSurface
            run={run}
            events={surface.events}
            chain={surface.chain}
            diff={surface.diff}
            onRefreshDiff={surface.onRefreshDiff}
            onApplyBranch={surface.onApplyBranch}
            onDiscard={surface.onDiscard}
            merge={surface.merge}
            onSend={onSend}
            onCancel={surface.onCancel}
            onSelectTurn={onSelect}
          />
        ) : (
          (emptyState ?? (
            <EmptyState icon={Bot} title="Select a run">
              Live output streams here while Claude Code works — tool calls, edits, costs,
              results.
            </EmptyState>
          ))
        )}
      </main>
    </div>
  );
}

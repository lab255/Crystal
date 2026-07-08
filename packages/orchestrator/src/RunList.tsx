import type { AgentRun } from "@crystal/core";
import { StatusDot, cn } from "@crystal/ui";
import { formatCost } from "./prompt.js";

/**
 * Reusable agent-run sidepane. Renders a scrollable, selectable list of runs —
 * the same surface the Orchestrate "Runs" tab shows, but decoupled so it can
 * also dock beside the board (per-task agent progress), the Jobs hub, or any
 * future manager/worker dispatch view. Callers filter `runs` to whatever scope
 * they care about (all runs, one task's runs, one purpose) and own the
 * selection via `selectedRunId` / `onSelect`.
 */
export function RunList({
  runs,
  selectedRunId,
  onSelect,
  title = "Agent runs",
  emptyHint = "No runs yet.",
  className,
}: {
  runs: AgentRun[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  /** Sidepane header; pass `null` to render the bare list with no header. */
  title?: string | null;
  /** Shown when `runs` is empty. */
  emptyHint?: string;
  /** Extra classes on the `<aside>` (e.g. width or border overrides). */
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1",
        className,
      )}
    >
      {title !== null ? (
        <div className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-2">
        {runs.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-ink-faint">{emptyHint}</div>
        ) : (
          runs.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              selected={selectedRunId === run.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/** One run row: status, prompt headline, timestamp and cost. */
function RunListItem({
  run,
  selected,
  onSelect,
}: {
  run: AgentRun;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
        selected ? "bg-crystal-500/15" : "hover:bg-surface-2",
      )}
    >
      <StatusDot status={run.status} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{run.prompt.split("\n")[0]}</span>
        <span className="mt-0.5 block text-[10px] text-ink-faint">
          {new Date(run.createdAt).toLocaleString()} · {formatCost(run.costUsd)}
        </span>
      </span>
    </button>
  );
}

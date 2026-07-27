import { useMemo } from "react";
import { GitBranch, TerminalSquare } from "lucide-react";
import { groupRunsByManager, type AgentRun } from "@crystal/core";
import { StatusDot, cn } from "@crystal/ui";
import { formatCost } from "./prompt.js";

/**
 * Reusable agent-run sidepane. Renders a scrollable, selectable list of runs —
 * the same surface the Orchestrate "Runs" tab shows, but decoupled so it can
 * also dock beside the board (per-task agent progress), the Jobs hub, or the
 * Agents dispatch view. Callers filter `runs` to whatever scope they care about
 * (all runs, one task's runs, one purpose) and own selection via
 * `selectedRunId` / `onSelect`.
 *
 * Runs are grouped into a manager→worker forest ({@link groupRunsByManager}):
 * a manager's dispatched workers nest beneath it; standalone runs render flat.
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
  const nodes = useMemo(() => groupRunsByManager(runs), [runs]);

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
        {nodes.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-ink-faint">{emptyHint}</div>
        ) : (
          nodes.map((node) => (
            <div key={node.run.id}>
              <RunListItem
                run={node.run}
                selected={selectedRunId === node.run.id}
                onSelect={onSelect}
                workerCount={node.workers.length}
              />
              {node.workers.length > 0 ? (
                <div className="ml-3.5 mt-1 space-y-1 border-l border-edge/70 pl-1.5">
                  {node.workers.map((w) => (
                    <RunListItem
                      key={w.id}
                      run={w}
                      selected={selectedRunId === w.id}
                      onSelect={onSelect}
                      worker
                    />
                  ))}
                </div>
              ) : null}
            </div>
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
  workerCount = 0,
  worker = false,
}: {
  run: AgentRun;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Number of workers dispatched by this run (shown as a manager badge). */
  workerCount?: number;
  /** Render as a nested worker row (denser). */
  worker?: boolean;
}) {
  const isManager = run.role === "manager" || workerCount > 0;
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 text-left transition-colors",
        worker ? "py-1.5" : "py-2",
        selected ? "bg-crystal-500/15" : "hover:bg-surface-2",
      )}
    >
      <StatusDot status={run.status} className="mt-1" />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-1.5",
            worker ? "text-[11px] text-ink-muted" : "text-xs text-ink",
          )}
        >
          <span className="truncate">{run.prompt.split("\n")[0]}</span>
          {run.terminalId ? (
            <span
              className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-surface-3 px-1.5 text-[9px] font-medium text-ink-muted"
              title="Native interactive session — its transcript lives in its terminal"
            >
              <TerminalSquare className="h-2.5 w-2.5" />
              interactive
            </span>
          ) : null}
          {isManager ? (
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded-full bg-crystal-500/15 px-1.5 text-[9px] font-medium text-crystal-300",
                !run.terminalId && "ml-auto",
              )}
            >
              <GitBranch className="h-2.5 w-2.5" />
              {workerCount || ""}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[10px] text-ink-faint">
          {new Date(run.createdAt).toLocaleString()} · {formatCost(run.costUsd)}
        </span>
      </span>
    </button>
  );
}

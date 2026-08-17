import { useMemo } from "react";
import { GitBranch, MessagesSquare, TerminalSquare } from "lucide-react";
import {
  groupRunsByManager,
  sessionDescendantCount,
  sessionDisplayStatus,
  sessionHeadline,
  sessionSubtreeCost,
  sessionWorkflowId,
  type AgentRun,
  type RunNode,
  type SessionNamingContext,
} from "@crystal/core";
import { formatRunCost } from "@crystal/client";
import { StatusDot, cn } from "@crystal/ui";
import { MANAGER_PREAMBLE } from "./prompt.js";

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Prompt-only headline, delegating to core's sessionHeadline policy. Prefer
 * sessionHeadline with a real node + naming context; this shim serves callers
 * that only hold a prompt string. Two edge behaviors inherited from the
 * policy: an empty prompt yields "Session" (was ""), and a workflow-manager
 * prompt yields the quoted workflow name (was the boilerplate line).
 */
export function runHeadline(prompt: string): string {
  // Satisfies the fields sessionHeadline reads; a wider read in core fails
  // the typecheck here instead of silently seeing undefined.
  const run = {
    prompt,
    tags: [] as string[],
    purpose: null,
    role: null,
    taskId: null,
  } satisfies Partial<AgentRun> as AgentRun;
  return sessionHeadline({ run, turns: [run], workers: [] }, {
    stripPrefixes: [MANAGER_PREAMBLE],
  });
}

/**
 * Reusable agent-run sidepane. Renders a scrollable, selectable list of runs —
 * the same surface the Orchestrate "Runs" tab shows, but decoupled so it can
 * also dock beside the board (per-task agent progress), the Jobs hub, or the
 * Agents dispatch view. Callers filter `runs` to whatever scope they care about
 * (all runs, one task's runs, one purpose) and own selection via
 * `selectedRunId` / `onSelect`.
 *
 * Runs are grouped into a session forest ({@link groupRunsByManager}): a
 * resume chain collapses to one row faced by its latest turn (steering an
 * agent grows the conversation, it never mints a new row), and a manager's
 * dispatched workers nest beneath it. A row is selected when *any* turn of
 * its chain is — the surface's turn strip handles picking older turns.
 */
export function RunList({
  runs,
  selectedRunId,
  onSelect,
  title = "Agent runs",
  emptyHint = "No runs yet.",
  className,
  wsNameOf,
  attention = EMPTY_SET,
  namingContext,
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
  /**
   * Workspace badge per row for cross-workspace lists (fleet / attention
   * queue): a run record carries no workspace id, so the caller — who knows
   * which store each run came from — supplies the name. Unset = no chip.
   */
  wsNameOf?: (run: AgentRun) => string | null | undefined;
  /** Run ids currently requiring operator attention. */
  attention?: ReadonlySet<string>;
  /** Shared session-title lookups for workflow and board identity. */
  namingContext?: SessionNamingContext;
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
            <RunTreeRow
              key={node.run.id}
              node={node}
              depth={0}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
              wsNameOf={wsNameOf}
              attention={attention}
              namingContext={namingContext}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function RunTreeRow({
  node,
  depth,
  selectedRunId,
  onSelect,
  wsNameOf,
  attention,
  namingContext,
}: {
  node: RunNode;
  depth: number;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  wsNameOf?: (run: AgentRun) => string | null | undefined;
  attention: ReadonlySet<string>;
  namingContext?: SessionNamingContext;
}) {
  return (
    <div>
      <RunListItem
        node={node}
        depth={depth}
        selectedRunId={selectedRunId}
        onSelect={onSelect}
        wsName={wsNameOf?.(node.run)}
        attention={attention}
        namingContext={namingContext}
      />
      {node.workers.length > 0 ? (
        <div className="ml-3.5 mt-1 space-y-1 border-l border-edge/70 pl-1.5">
          {node.workers.map((worker) => (
            <RunTreeRow
              key={worker.run.id}
              node={worker}
              depth={depth + 1}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
              wsNameOf={wsNameOf}
              attention={attention}
              namingContext={namingContext}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One session row: status, prompt headline, turn count, timestamp and cost. */
function RunListItem({
  node,
  depth,
  selectedRunId,
  onSelect,
  wsName,
  attention,
  namingContext,
}: {
  node: RunNode;
  depth: number;
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  /** Workspace name chip (cross-workspace lists only). */
  wsName?: string | null;
  attention: ReadonlySet<string>;
  namingContext?: SessionNamingContext;
}) {
  const run = node.run;
  const isManager = run.role === "manager" || node.workers.length > 0;
  const displayStatus = sessionDisplayStatus(node, attention);
  const descendantCount = sessionDescendantCount(node);
  const workflowId = sessionWorkflowId(node);
  const selected =
    selectedRunId != null && node.turns.some((t) => t.id === selectedRunId);
  // The whole subtree's bill — the face turn alone under-reports a steered
  // session. Unreadable spend stays null ("—"), never a confident $0.00.
  const costUsd = isManager
    ? sessionSubtreeCost(node)
    : node.turns.some((t) => t.costUsd != null)
      ? node.turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
      : null;
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 text-left transition-colors",
        depth > 0 ? "py-1.5" : "py-2",
        selected ? "bg-crystal-500/15" : "hover:bg-surface-2",
      )}
    >
      <StatusDot
        status={displayStatus === "working" ? "running" : displayStatus}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "flex items-center gap-1.5",
            depth > 0 ? "text-[11px] text-ink-muted" : "text-xs text-ink",
          )}
        >
          {/* The conversation is titled by how it started, not the latest wake-up prompt. */}
          <span className="truncate">{sessionHeadline(node, namingContext)}</span>
          {run.terminalId ? (
            <span
              className="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-surface-3 px-1.5 text-[9px] font-medium text-ink-muted"
              title="Native interactive session — its transcript lives in its terminal"
            >
              <TerminalSquare className="h-2.5 w-2.5" />
              interactive
            </span>
          ) : null}
          {node.turns.length > 1 ? (
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded-full bg-surface-3 px-1.5 text-[9px] font-medium text-ink-muted",
                !run.terminalId && "ml-auto",
              )}
              title={`${node.turns.length} turns in this session`}
            >
              <MessagesSquare className="h-2.5 w-2.5" />
              {node.turns.length}
            </span>
          ) : null}
          {isManager ? (
            <span
              className={cn(
                "flex shrink-0 items-center gap-0.5 rounded-full bg-crystal-500/15 px-1.5 text-[9px] font-medium text-crystal-300",
                !run.terminalId && node.turns.length === 1 && "ml-auto",
              )}
            >
              <GitBranch className="h-2.5 w-2.5" />
              {descendantCount || ""}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-faint">
          <span className="truncate">
            {new Date(node.turns[0]!.createdAt).toLocaleString()} · {formatRunCost(costUsd)}
          </span>
          {wsName ? (
            <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] font-medium text-ink-faint">
              {wsName}
            </span>
          ) : null}
          {workflowId ? (
            <span
              className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[9px] font-medium text-ink-faint"
              title={`Workflow ${workflowId}`}
            >
              {workflowId.slice(0, 8)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

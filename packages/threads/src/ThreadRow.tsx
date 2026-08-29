import { Pin } from "lucide-react";
import { formatRunCost } from "@crystal/client";
import { StatusDot, cn, type StatusKind } from "@crystal/ui";
import type { ThreadIndicator } from "./thread-model.js";

export interface ThreadRowData {
  title: string;
  indicator: ThreadIndicator;
  pinned: boolean;
  lastActivity: string | null;
  costUsd: number | null;
  workerCount?: number;
}

const INDICATOR_STATUS: Record<ThreadIndicator, StatusKind> = {
  "needs-input": "needs-you",
  running: "running",
  failed: "failed",
  unread: "queued",
  idle: "idle",
};

const INDICATOR_LABEL: Record<ThreadIndicator, string> = {
  "needs-input": "Waiting on you",
  running: "Working",
  failed: "Failed",
  unread: "New activity",
  idle: "Idle",
};

/** Compact "5m" / "2h" / "3d" recency, absolute date beyond a week. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString();
}

/** One shared row keeps workspace and coordinator threads visually comparable. */
export function ThreadRow({
  thread,
  selected,
  nowMs,
  onSelect,
  onTogglePin,
  onContextMenu,
}: {
  thread: ThreadRowData;
  selected: boolean;
  nowMs: number;
  onSelect: () => void;
  onTogglePin: () => void;
  onContextMenu?: React.MouseEventHandler;
}) {
  const workers = thread.workerCount ?? 0;
  return (
    <div
      className={cn(
        "group relative rounded-lg",
        selected ? "bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        aria-selected={selected}
        role="option"
        title={INDICATOR_LABEL[thread.indicator]}
        className={cn(
          "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crystal-400/60",
        )}
      >
        <StatusDot status={INDICATOR_STATUS[thread.indicator]} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "truncate text-xs",
              thread.indicator === "unread" || thread.indicator === "needs-input"
                ? "font-semibold text-ink"
                : "font-medium text-ink-muted",
              selected && "text-ink",
            )}
          >
            {thread.title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
            {thread.lastActivity ? <span>{relativeTime(thread.lastActivity, nowMs)}</span> : null}
            {thread.costUsd != null ? (
              <>
                <span>·</span>
                <span>{formatRunCost(thread.costUsd)}</span>
              </>
            ) : null}
            {workers > 0 ? (
              <>
                <span>·</span>
                <span>
                  {workers} {workers === 1 ? "worker" : "workers"}
                </span>
              </>
            ) : null}
            {thread.pinned ? <Pin className="h-2.5 w-2.5" /> : null}
          </div>
        </div>
      </button>
      <button
        type="button"
        aria-label={thread.pinned ? "Unpin thread" : "Pin thread"}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin();
        }}
        className={cn(
          "absolute right-1.5 top-1.5 hidden rounded p-1 text-ink-faint hover:text-ink group-hover:block",
          thread.pinned && "block",
        )}
      >
        <Pin className={cn("h-3 w-3", thread.pinned && "fill-current")} />
      </button>
    </div>
  );
}

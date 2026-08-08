import { Fragment } from "react";
import { AlertTriangle, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import {
  EMPTY_PENDING_PERMISSIONS,
  useAttentionJump,
  useAttentionNotifications,
  useFleet,
  useFleetNeedsYou,
  type WorkspaceNeedsYou,
} from "@crystal/client";
import type { PendingPermission } from "@crystal/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crystal/ui";

/**
 * The global "N need you" pill (operator-oss's titlebar pill): open questions,
 * parked permissions and unrecovered failures rolled up across every open
 * workspace on every connection. The dropdown groups items per workspace;
 * each row jumps straight to the waiting task or run — cross-server, from any
 * mode. The orchestrator keeps its own per-workspace pill with the same count.
 *
 * This component also hosts the attention notifier: it subscribes to the same
 * fleet slices anyway, and a leaf keeps those re-renders out of the shell.
 */
export function NeedsYouPill() {
  useAttentionNotifications();
  const { rows } = useFleetNeedsYou();
  const permissionsByWs = useFleet((s) => s.permissionsByWs);
  const count = fleetNeedsYouCount(rows, permissionsByWs);
  const jump = useAttentionJump();
  if (count === 0) return null;
  const waiting = rows.filter(
    (row) => row.count + (permissionsByWs[row.key]?.length ?? 0) > 0,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-0.5 text-[11px] font-medium text-warn transition-colors hover:bg-warn/20"
        >
          <MessageCircleQuestion className="h-3.5 w-3.5" />
          {count} need{count === 1 ? "s" : ""} you
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
        {waiting.map((row, i) => (
          <Fragment key={row.key}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="flex items-baseline gap-2">
              <span className="truncate">{row.name}</span>
              {row.serverLabel ? (
                <span className="truncate text-[10px] font-normal text-ink-faint">
                  {row.serverLabel}
                </span>
              ) : null}
            </DropdownMenuLabel>
            {row.questions.map((q) => (
              <DropdownMenuItem
                key={q.question.id}
                onSelect={() =>
                  jump({ kind: "question", sid: row.sid, ws: row.ws, question: q })
                }
              >
                <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-warn" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{q.question.text}</span>
                  <span className="block truncate text-[10px] text-ink-faint">
                    {q.projectName} · {q.taskTitle}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
            {(permissionsByWs[row.key] ?? EMPTY_PENDING_PERMISSIONS).map((permission) => {
              const run = row.runs.find((candidate) => candidate.id === permission.runId);
              return (
                <DropdownMenuItem
                  key={permission.id}
                  disabled={!run}
                  onSelect={() =>
                    run && jump({ kind: "run", sid: row.sid, ws: row.ws, run })
                  }
                >
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-warn" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{permission.tool} needs permission</span>
                    <span className="block truncate text-[10px] text-ink-faint">
                      {permission.summary}
                    </span>
                  </span>
                </DropdownMenuItem>
              );
            })}
            {row.failures.map((run) => (
              <DropdownMenuItem
                key={run.id}
                onSelect={() => jump({ kind: "failure", sid: row.sid, ws: row.ws, run })}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {run.failure?.kind.replace(/_/g, " ") ?? "failed"} — needs recovery
                  </span>
                  <span className="block truncate text-[10px] text-ink-faint">{run.prompt}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function fleetNeedsYouCount(
  rows: readonly Pick<WorkspaceNeedsYou, "key" | "count">[],
  permissionsByWs: Readonly<Record<string, readonly PendingPermission[]>>,
): number {
  return rows.reduce(
    (count, row) => count + row.count + (permissionsByWs[row.key]?.length ?? 0),
    0,
  );
}

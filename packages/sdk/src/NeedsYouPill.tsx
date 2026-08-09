import { Fragment } from "react";
import { AlertTriangle, Inbox, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import {
  EMPTY_PENDING_PERMISSIONS,
  useAttentionJump,
  useAttentionNotifications,
  useFleet,
  useFleetNeedsYou,
  useNavUpdate,
} from "@crystal/client";
import { fleetNeedsYouCount } from "@crystal/core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crystal/ui";

/**
 * The global "N need you" pill (operator-oss's titlebar pill): actionable questions,
 * parked permissions and unrecovered failures rolled up across every open
 * workspace on every connection. The dropdown groups items per workspace;
 * each row jumps straight to the waiting task or run — cross-server, from any
 * mode. Stale rows collapse to one Overview-inbox link after the actionable
 * groups. The orchestrator keeps its own per-workspace pill with the same count.
 *
 * This component also hosts the attention notifier: it subscribes to the same
 * fleet slices anyway, and a leaf keeps those re-renders out of the shell.
 */
export function NeedsYouPill() {
  useAttentionNotifications();
  const { rows } = useFleetNeedsYou();
  const permissionsByWs = useFleet((s) => s.permissionsByWs);
  const count = fleetNeedsYouCount(rows, permissionsByWs);
  const staleCount = rows.reduce((total, row) => total + row.staleQuestions.length, 0);
  const jump = useAttentionJump();
  const nav = useNavUpdate();
  if (count === 0 && staleCount === 0) return null;
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
          {count > 0 ? `${count} need${count === 1 ? "s" : ""} you` : "Questions"}
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
            {row.actionableQuestions.map((q) => (
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
        {staleCount > 0 ? (
          <>
            {waiting.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onSelect={() => nav({ mode: "projects", projects: { view: "inbox" } })}
              title="Open the Overview inbox"
              className="text-ink-faint"
            >
              <Inbox className="h-3.5 w-3.5 shrink-0" />
              <span>
                {staleCount} stale question{staleCount === 1 ? "" : "s"}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The count policy moved to core/attention.ts with the rest of the attention
// lane; re-exported here for existing SDK importers.
export { fleetNeedsYouCount };

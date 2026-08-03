import { useState } from "react";
import { FolderPlus, Unplug } from "lucide-react";
import { useFleetConnections } from "@crystal/client";
import { Button, EmptyState } from "@crystal/ui";
import { OpenWorkspaceDialog } from "../OpenWorkspaceDialog.js";
import { FleetPulse } from "./FleetPulse.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

/**
 * Projects mode — mission control across every open workspace of every
 * connected bridge server. Each card shows the workspace's traffic light,
 * what its agents are doing, and its todo list, so switching codebases starts
 * with context instead of archaeology. With more than one server, cards group
 * under a server heading; a disconnected server keeps its heading (dimmed) so
 * a dead connection is visible rather than silently absent.
 */
export function OverviewMode() {
  const connections = useFleetConnections();
  const [openDialog, setOpenDialog] = useState(false);

  const multiServer = connections.length > 1;
  const total = connections.reduce((n, c) => n + c.workspaces.length, 0);

  return (
    <div className="h-full overflow-y-auto bg-surface-0">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <header className="mb-5 flex items-center gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Projects</h2>
            <p className="text-xs text-ink-muted">
              {multiServer
                ? "Every workspace across your connected bridges — traffic lights, agents and todos in one place."
                : "Every workspace on this bridge — traffic lights, agents and todos in one place."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpenDialog(true)}
            className="ml-auto"
          >
            <FolderPlus className="h-3.5 w-3.5" /> Open workspace…
          </Button>
        </header>

        {/* Insights + costs headline — the agent system's pulse, fleet-wide. */}
        <FleetPulse />

        {total === 0 ? (
          <EmptyState title="No workspaces open">
            Open a workspace to start tracking its agents and todos.
          </EmptyState>
        ) : (
          <div className="space-y-6">
            {connections.map((c) => {
              if (c.workspaces.length === 0 && !multiServer) return null;
              const offline = c.state !== "open";
              return (
                <section key={c.sid}>
                  {multiServer ? (
                    <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      {c.label}
                      {offline ? (
                        <span className="flex items-center gap-1 normal-case tracking-normal text-danger">
                          <Unplug className="h-3 w-3" /> disconnected
                        </span>
                      ) : null}
                    </h3>
                  ) : null}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {c.workspaces.map((w) => (
                      <WorkspaceCard
                        key={`${c.sid}:${w.id}`}
                        sid={c.sid}
                        ws={w}
                        serverLabel={multiServer ? c.label : null}
                        offline={offline}
                      />
                    ))}
                  </div>
                  {multiServer && c.workspaces.length === 0 ? (
                    <p className="text-[11px] text-ink-faint">
                      {offline ? "Unreachable — its workspaces will return on reconnect." : "No workspaces open."}
                    </p>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <OpenWorkspaceDialog open={openDialog} onOpenChange={setOpenDialog} />
    </div>
  );
}

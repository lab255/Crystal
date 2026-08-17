import { useEffect, useState } from "react";
import { Bot, FolderPlus, Inbox, LayoutGrid, Unplug } from "lucide-react";
import type { OverviewViewId } from "@crystal/core";
import { useFleetConnections, useHub, useNav, useNavUpdate } from "@crystal/client";
import { Button, EmptyState, Input, Tooltip, cn } from "@crystal/ui";
import { CoordinatorChat, QuestionsView } from "@crystal/hub";
import { OpenWorkspaceDialog } from "../OpenWorkspaceDialog.js";
import { FleetPulse } from "./FleetPulse.js";
import { LiveRunsPanel } from "./LiveRunsPanel.js";
import { WorkspaceCard } from "./WorkspaceCard.js";
import { attentionLegendText } from "../shell-labels.js";

const ATTENTION_LEGEND = attentionLegendText();

/**
 * The Overview — mission control. Three faces on one cross-project level:
 * the dashboard (every workspace's traffic light, agents and todos), the
 * coordinator chat (the program-manager session the hub mode used to hold),
 * and the inbox (every unanswered agent question across the portfolio).
 */
export function OverviewMode() {
  const view = useNav((l) => l.projects?.view) ?? "dashboard";
  const find = useNav((l) => l.projects?.find) ?? "";
  const updateNav = useNavUpdate();
  const refresh = useHub((s) => s.refresh);
  const waiting = useHub((s) =>
    Object.values(s.questions).reduce((n, qs) => n + qs.length, 0),
  );
  const livePrograms = useHub((s) => s.programs.filter((p) => p.status === "running").length);

  // The hub store used to be primed by the hub mode; the Overview owns it now.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tab = (id: OverviewViewId, label: string, icon: React.ReactNode, badge?: number) => (
    <button
      type="button"
      onClick={() => updateNav({ projects: { view: id } })}
      aria-pressed={view === id}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        view === id ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {icon}
      {label}
      {badge ? (
        <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-0.5 text-[9px] font-bold text-surface-0">
          {badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {tab("dashboard", "Dashboard", <LayoutGrid className="h-3.5 w-3.5" />)}
          {tab("chat", "Coordinator", <Bot className="h-3.5 w-3.5" />, livePrograms)}
          {tab("inbox", "Inbox", <Inbox className="h-3.5 w-3.5" />, waiting)}
        </div>
        {view === "inbox" ? (
          <Input
            value={find}
            onChange={(e) => updateNav({ projects: { find: e.target.value || null } })}
            placeholder="Filter questions…"
            aria-label="Filter questions"
            className="h-6 w-56 rounded-md px-2 text-xs"
          />
        ) : null}
      </div>

      {view === "chat" ? (
        <CoordinatorChat />
      ) : view === "inbox" ? (
        <QuestionsView find={find} />
      ) : (
        <Dashboard />
      )}
    </div>
  );
}

/**
 * The dashboard face — every open workspace of every connected bridge server.
 * With more than one server, cards group under a server heading; a
 * disconnected server keeps its heading (dimmed) so a dead connection is
 * visible rather than silently absent.
 */
function Dashboard() {
  const connections = useFleetConnections();
  const [openDialog, setOpenDialog] = useState(false);

  const multiServer = connections.length > 1;
  const total = connections.reduce((n, c) => n + c.workspaces.length, 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <header className="mb-5 flex items-center gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Projects</h2>
            <p className="text-xs text-ink-muted">
              {multiServer
                ? "Every workspace across your connected bridges — traffic lights, agents and todos in one place."
                : "Every workspace on this bridge — traffic lights, agents and todos in one place."}
            </p>
            <Tooltip content={ATTENTION_LEGEND} side="bottom">
              <button
                type="button"
                className="mt-1 text-[10px] text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink-muted"
              >
                What do the colors mean?
              </button>
            </Tooltip>
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

        <LiveRunsPanel />

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

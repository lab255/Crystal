import { useEffect, useState } from "react";
import { FolderOpen, LayoutGrid, Plug, Plus, Unplug, X } from "lucide-react";
import {
  DEFAULT_SERVER_SID,
  workspaceLight,
  type RecentWorkspace,
  type TrafficLight,
} from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  useCrystal,
  useFleet,
  useFleetConnections,
  useWorkspaces,
  wsKey,
} from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TrafficLightDot,
  cn,
} from "@crystal/ui";
import { isCrossProjectMode, type CrystalMode } from "./modes.js";
import { ConnectBridgeDialog } from "./ConnectBridgeDialog.js";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog.js";
import { RecentWorkspaceRowContent } from "./RecentWorkspaceRow.js";

/**
 * Top-level navigation: the Overview (cross-workspace home) tab, one tab per
 * open workspace of every connected bridge server, and the opener. Workspaces
 * are the first-level construct — the facet tabs underneath navigate *within*
 * the active one. With more than one server connected, tabs group under a
 * subtle server-name divider; a dead added connection keeps its divider (with
 * a disconnected marker and a way to forget it) so it never silently vanishes.
 * Each workspace tab carries its traffic light so cross-project attention
 * stays visible.
 */
export function WorkspaceTabs({
  mode,
  attention,
  onHome,
  onSelectWorkspace,
}: {
  mode: CrystalMode;
  /** Worst traffic light across the non-active workspaces — the Overview badge. */
  attention: TrafficLight;
  onHome: () => void;
  onSelectWorkspace: (sid: string, id: string) => void;
}) {
  const { fleet, activeSid } = useCrystal();
  const connections = useFleetConnections();
  // Recents + open-folder act on the ACTIVE connection (its server owns them).
  const recents = useWorkspaces((s) => s.recents);
  const activeId = useWorkspaces((s) => s.activeId);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);

  const [dialog, setDialog] = useState<{
    open: boolean;
    initialPath?: string;
    initialError?: string;
  }>({ open: false });
  const [connectOpen, setConnectOpen] = useState(false);

  // The command palette (or any embedder) can summon the opener.
  useEffect(() => {
    const onOpen = () => setDialog({ open: true });
    window.addEventListener("crystal:open-workspace", onOpen);
    return () => window.removeEventListener("crystal:open-workspace", onOpen);
  }, []);

  // "Home" = the cross-workspace overview; anything else means a workspace is entered.
  const entered = !isCrossProjectMode(mode);
  const lightFor = (sid: string, ws: string) => {
    const key = wsKey(sid, ws);
    return workspaceLight(
      todosByWs[key] ?? EMPTY_TODOS,
      runsByWs[key] ?? EMPTY_RUNS,
      seenAtByWs[key] ?? null,
      questionsByWs[key] ?? 0,
    );
  };
  const multiServer = connections.length > 1;
  const activeConn = connections.find((c) => c.sid === activeSid);
  const openRoots = new Set((activeConn?.workspaces ?? []).map((w) => w.root));
  const reopenable = recents.filter((r) => !openRoots.has(r.root));
  // Global tab index for the Ctrl+Alt+n shortcuts (counted across servers).
  let tabIndex = 0;

  async function reopen(recent: RecentWorkspace) {
    try {
      await openWorkspace(recent.root);
    } catch (err) {
      // Hand the failure to the dialog, prefilled, so the user can correct the path.
      setDialog({ open: true, initialPath: recent.root, initialError: (err as Error).message });
    }
  }

  function closeOn(sid: string, wsId: string): void {
    if (sid === activeSid) {
      void closeWorkspace(wsId);
    } else {
      // Another server's workspace: close over its own bridge; its bundle
      // syncs through the workspaces.changed broadcast.
      void fleet.clientOf(sid)?.request("workspaces.close", { ws: wsId }).catch(() => {});
    }
  }

  return (
    <>
      <Tooltip content="All workspaces at a glance" shortcut="Ctrl+1">
        <button
          type="button"
          onClick={onHome}
          aria-pressed={!entered}
          className={cn(
            "relative flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
            !entered
              ? "bg-crystal-500/20 text-crystal-200"
              : "text-ink-muted hover:bg-surface-3 hover:text-ink",
          )}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          Overview
          {attention === "red" || attention === "yellow" ? (
            <TrafficLightDot light={attention} className="absolute -right-0.5 -top-0.5" />
          ) : null}
        </button>
      </Tooltip>

      <span className="h-4 w-px shrink-0 bg-edge" />

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {connections.map((c) => {
          const disconnected = c.state !== "open";
          return (
            <div key={c.sid} className="flex shrink-0 items-center gap-1">
              {multiServer ? (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 pl-1.5 pr-0.5 text-[10px] font-medium uppercase tracking-wide",
                    disconnected ? "text-ink-faint" : "text-ink-muted",
                  )}
                  title={c.endpoint ?? "this bridge"}
                >
                  <span className="h-3 w-px bg-edge" />
                  {c.label}
                  {disconnected ? <Unplug className="h-3 w-3 text-danger" /> : null}
                  {c.sid !== DEFAULT_SERVER_SID ? (
                    <button
                      type="button"
                      aria-label={`Disconnect from ${c.label}`}
                      title="Disconnect and forget this bridge"
                      onClick={() => fleet.removeConnection(c.sid)}
                      className="rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-danger"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  ) : null}
                </span>
              ) : null}
              {c.workspaces.map((w) => {
                const isActive = c.sid === activeSid && activeId === w.id;
                const i = tabIndex++;
                return (
                  <Tooltip
                    key={`${c.sid}:${w.id}`}
                    content={multiServer ? `${c.label} · ${w.root}` : w.root}
                    shortcut={i < 9 ? `Ctrl+Alt+${i + 1}` : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectWorkspace(c.sid, w.id)}
                      aria-pressed={entered && isActive}
                      className={cn(
                        "group/wstab flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
                        disconnected && "opacity-60",
                        entered && isActive
                          ? "bg-crystal-500/20 text-crystal-200"
                          : isActive
                            ? "text-ink hover:bg-surface-3"
                            : "text-ink-muted hover:bg-surface-3 hover:text-ink",
                      )}
                    >
                      <TrafficLightDot light={lightFor(c.sid, w.id)} />
                      <span className="max-w-40 truncate">{w.name}</span>
                      {c.workspaces.length > 1 || multiServer ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`Close workspace ${w.name}`}
                          className="-mr-0.5 rounded p-0.5 text-ink-faint opacity-0 hover:bg-surface-3 hover:text-danger group-hover/wstab:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeOn(c.sid, w.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      ) : null}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open a workspace"
              className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="min-w-72">
            {reopenable.length > 0 ? (
              <>
                <DropdownMenuLabel>Recent</DropdownMenuLabel>
                {reopenable.map((r) => (
                  <DropdownMenuItem
                    key={r.root}
                    disabled={r.missing}
                    onSelect={() => void reopen(r)}
                    className="gap-2"
                  >
                    <RecentWorkspaceRowContent recent={r} />
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => setDialog({ open: true })} className="gap-2 text-ink-muted">
              <FolderOpen className="h-3.5 w-3.5" /> Open folder…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConnectOpen(true)} className="gap-2 text-ink-muted">
              <Plug className="h-3.5 w-3.5" /> Connect to bridge…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <OpenWorkspaceDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initialPath={dialog.initialPath}
        initialError={dialog.initialError}
      />
      <ConnectBridgeDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}

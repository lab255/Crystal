import { useEffect, useState } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  FolderGit2,
  FolderOpen,
  LayoutGrid,
  Plug,
  Plus,
  Settings,
  Target,
  TerminalSquare,
  Unplug,
  X,
} from "lucide-react";
import {
  DEFAULT_SERVER_SID,
  countActionableQuestionRows,
  workspaceLight,
  type RecentWorkspace,
  type TrafficLight,
} from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_QUESTIONS,
  EMPTY_TODOS,
  useCrystal,
  useFleet,
  useFleetConnections,
  useSettings,
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
  useContextMenu,
} from "@crystal/ui";
import { isCrossProjectMode, type CrystalMode } from "./modes.js";
import { ConnectBridgeDialog } from "./ConnectBridgeDialog.js";
import { DevServersButton } from "./DevServersButton.js";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog.js";
import { RecentWorkspaceRowContent } from "./RecentWorkspaceRow.js";
import { attentionLegendText } from "./shell-labels.js";
import {
  MODE_SHORTCUTS,
  SHELL_SHORTCUTS,
  shortcutHint,
  workspaceShortcutHint,
} from "./shortcuts.js";

const ATTENTION_LEGEND = attentionLegendText();

/**
 * The far-left workspace rail — Slack-style. Top: the cross-project levels
 * (Overview, Hub). Middle: one tile per open workspace of every connected
 * server, its traffic light riding the tile so cross-project attention stays
 * visible from anywhere. Bottom: the opener and settings. The rail expands
 * (names + server groups) or collapses to icons; the preference persists in
 * the settings store.
 */
export function WorkspaceRail({
  mode,
  attention,
  waitingBadge,
  gitOpen,
  terminalOpen,
  onHome,
  onToggleGit,
  onToggleTerminal,
  onSelectWorkspace,
  onOpenSettings,
}: {
  mode: CrystalMode;
  /** Worst light across the non-active workspaces — the Overview badge. */
  attention: TrafficLight;
  /** Unanswered agent questions across the portfolio — outranks the light. */
  waitingBadge: number;
  gitOpen: boolean;
  terminalOpen: boolean;
  onHome: () => void;
  onToggleGit: () => void;
  onToggleTerminal: () => void;
  onSelectWorkspace: (sid: string, id: string) => void;
  onOpenSettings: () => void;
}) {
  const { fleet, activeSid } = useCrystal();
  const connections = useFleetConnections();
  const recents = useWorkspaces((s) => s.recents);
  const activeId = useWorkspaces((s) => s.activeId);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  const expanded = useSettings((s) => s.railExpanded);
  const setSettings = useSettings((s) => s.set);
  const menu = useContextMenu();

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

  const entered = !isCrossProjectMode(mode);
  const lightFor = (sid: string, ws: string) => {
    const key = wsKey(sid, ws);
    return workspaceLight(
      todosByWs[key] ?? EMPTY_TODOS,
      runsByWs[key] ?? EMPTY_RUNS,
      seenAtByWs[key] ?? null,
      countActionableQuestionRows(questionsByWs[key] ?? EMPTY_QUESTIONS),
    );
  };
  const multiServer = connections.length > 1;
  const activeConn = connections.find((c) => c.sid === activeSid);
  const openRoots = new Set((activeConn?.workspaces ?? []).map((w) => w.root));
  const reopenable = recents.filter((r) => !openRoots.has(r.root));
  let tabIndex = 0;

  async function reopen(recent: RecentWorkspace) {
    try {
      await openWorkspace(recent.root);
    } catch (err) {
      setDialog({ open: true, initialPath: recent.root, initialError: (err as Error).message });
    }
  }

  function closeOn(sid: string, wsId: string): void {
    if (sid === activeSid) {
      void closeWorkspace(wsId);
    } else {
      void fleet.clientOf(sid)?.request("workspaces.close", { ws: wsId }).catch(() => {});
    }
  }

  function workspaceMenu(e: React.MouseEvent, sid: string, wsId: string, root: string): void {
    menu.open(e, [
      {
        type: "item",
        label: "Open terminal here",
        icon: TerminalSquare,
        onSelect: () =>
          window.dispatchEvent(
            new CustomEvent("crystal:open-terminal", { detail: { ws: wsId, sid } }),
          ),
      },
      {
        type: "item",
        label: "Copy path",
        onSelect: () => void navigator.clipboard.writeText(root).catch(() => {}),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Close workspace",
        danger: true,
        onSelect: () => closeOn(sid, wsId),
      },
    ]);
  }

  const levelButton = (opts: {
    label: string;
    shortcut?: string;
    icon: React.ReactNode;
    active: boolean;
    onClick: () => void;
    badge?: React.ReactNode;
  }) => {
    const inner = (
      <button
        type="button"
        onClick={opts.onClick}
        aria-label={opts.label}
        aria-pressed={opts.active}
        className={cn(
          "relative flex h-9 items-center rounded-lg transition-colors",
          expanded ? "w-full gap-2 px-2" : "w-9 justify-center",
          opts.active
            ? "bg-crystal-500/20 text-crystal-300"
            : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
        )}
      >
        {opts.icon}
        {expanded ? <span className="truncate text-xs font-medium">{opts.label}</span> : null}
        {opts.badge}
      </button>
    );
    return expanded ? (
      inner
    ) : (
      <Tooltip content={opts.label} shortcut={opts.shortcut} side="right">
        {inner}
      </Tooltip>
    );
  };

  return (
    <>
      <nav
        aria-label="Workspaces"
        className={cn(
          "flex min-h-0 shrink-0 flex-col border-r border-edge bg-surface-1 py-2",
          expanded ? "w-52 px-2" : "w-12 items-center px-1.5",
        )}
      >
        {levelButton({
          label: "Overview",
          shortcut: shortcutHint(MODE_SHORTCUTS[0]!),
          icon: <LayoutGrid className="h-4.5 w-4.5 shrink-0" />,
          active: mode === "projects",
          onClick: onHome,
          // Waiting questions outrank the fleet light: a stopped run waiting
          // on a human is the thing to see from any mode.
          badge:
            waitingBadge > 0 ? (
              <span className="absolute right-1 top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-0.5 text-[9px] font-bold text-surface-0">
                {waitingBadge}
              </span>
            ) : attention === "red" || attention === "yellow" ? (
              <TrafficLightDot light={attention} className="absolute right-1 top-1" />
            ) : null,
        })}

        <div className={cn("my-2 h-px shrink-0 bg-edge", expanded ? "" : "w-8")} />

        {/* Workspace tiles — the scrollable middle. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto",
            expanded ? "" : "items-center",
          )}
        >
          {connections.map((c) => {
            const disconnected = c.state !== "open";
            return (
              <div key={c.sid} className={cn("flex flex-col gap-1", expanded ? "" : "items-center")}>
                {multiServer ? (
                  expanded ? (
                    <div
                      className={cn(
                        "flex items-center gap-1 px-1 pt-1 text-[10px] font-medium uppercase tracking-wide",
                        disconnected ? "text-ink-faint" : "text-ink-muted",
                      )}
                      title={c.endpoint ?? "this bridge"}
                    >
                      <span className="truncate">{c.label}</span>
                      {disconnected ? <Unplug className="h-3 w-3 text-danger" /> : null}
                      {c.sid !== DEFAULT_SERVER_SID ? (
                        <button
                          type="button"
                          aria-label={`Disconnect from ${c.label}`}
                          title="Disconnect and forget this bridge"
                          onClick={() => fleet.removeConnection(c.sid)}
                          className="ml-auto rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-danger"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="my-0.5 h-px w-6 shrink-0 bg-edge-strong" title={c.label} />
                  )
                ) : null}
                {c.workspaces.map((w) => {
                  const isActive = c.sid === activeSid && activeId === w.id;
                  const i = tabIndex++;
                  const light = lightFor(c.sid, w.id);
                  const tile = (
                    <button
                      type="button"
                      onClick={() => onSelectWorkspace(c.sid, w.id)}
                      onContextMenu={(e) => workspaceMenu(e, c.sid, w.id, w.root)}
                      aria-pressed={entered && isActive}
                      className={cn(
                        "group/wstile relative flex h-9 shrink-0 items-center rounded-lg transition-colors",
                        expanded ? "w-full gap-2 px-1.5" : "w-9 justify-center",
                        disconnected && "opacity-60",
                        entered && isActive
                          ? "bg-crystal-500/20"
                          : "hover:bg-surface-3",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold uppercase",
                          entered && isActive
                            ? "bg-crystal-500 text-white"
                            : "bg-surface-3 text-ink-muted group-hover/wstile:bg-surface-active group-hover/wstile:text-ink",
                        )}
                      >
                        {w.name.slice(0, 1)}
                      </span>
                      {expanded ? (
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-left text-xs font-medium",
                            entered && isActive ? "text-crystal-200" : "text-ink-muted",
                          )}
                        >
                          {w.name}
                        </span>
                      ) : null}
                      {/* Attention dot — the whole point of the rail tile. */}
                      {light === "red" || light === "yellow" ? (
                        <Tooltip content={ATTENTION_LEGEND} side="right">
                          <span
                            className={cn(
                              "absolute inline-flex",
                              expanded ? "right-1.5" : "right-0.5 top-0.5",
                            )}
                          >
                            <TrafficLightDot light={light} />
                          </span>
                        </Tooltip>
                      ) : null}
                      {expanded && (c.workspaces.length > 1 || multiServer) ? (
                        <span
                          role="button"
                          tabIndex={-1}
                          aria-label={`Close workspace ${w.name}`}
                          className="rounded p-0.5 text-ink-faint opacity-0 hover:bg-surface-active hover:text-danger group-hover/wstile:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeOn(c.sid, w.id);
                          }}
                        >
                          <X className="h-3 w-3" />
                        </span>
                      ) : null}
                    </button>
                  );
                  return expanded ? (
                    <span key={`${c.sid}:${w.id}`}>{tile}</span>
                  ) : (
                    <Tooltip
                      key={`${c.sid}:${w.id}`}
                      content={multiServer ? `${c.label} · ${w.name}` : w.name}
                      shortcut={workspaceShortcutHint(i)}
                      side="right"
                    >
                      {tile}
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
                className={cn(
                  "flex h-9 shrink-0 items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink",
                  expanded ? "w-full gap-2 px-2" : "w-9 justify-center",
                )}
              >
                <Plus className="h-4 w-4 shrink-0" />
                {expanded ? <span className="text-xs font-medium">Add workspace</span> : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" className="min-w-72">
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

        {/* Workspace tools: runners (dev servers), git tree, terminal — the
            panel toggles live on the rail so they're one click away from any
            mode, cross-project ones included. */}
        <div
          className={cn(
            "mt-2 flex shrink-0 gap-1 border-t border-edge pt-1.5",
            expanded ? "flex-row items-center justify-center" : "flex-col items-center",
          )}
        >
          <DevServersButton side={expanded ? "top" : "right"} />
          <Tooltip
            content="Git tree & log"
            shortcut={shortcutHint(SHELL_SHORTCUTS.git)}
            side={expanded ? "top" : "right"}
          >
            <button
              type="button"
              onClick={onToggleGit}
              aria-label="Toggle git panel"
              aria-pressed={gitOpen}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                gitOpen
                  ? "bg-crystal-500/20 text-crystal-300"
                  : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
              )}
            >
              <FolderGit2 className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip
            content="Toggle the terminal panel"
            shortcut={shortcutHint(SHELL_SHORTCUTS.terminal)}
            side={expanded ? "top" : "right"}
          >
            <button
              type="button"
              onClick={onToggleTerminal}
              aria-label="Toggle terminal panel"
              aria-pressed={terminalOpen}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                terminalOpen
                  ? "bg-crystal-500/20 text-crystal-300"
                  : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
              )}
            >
              <TerminalSquare className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        {/* Bottom: collapse toggle + settings. */}
        <div
          className={cn(
            "mt-1.5 flex shrink-0 flex-col gap-1 border-t border-edge pt-1.5",
            expanded ? "" : "items-center",
          )}
        >
          {levelButton({
            label: expanded ? "Collapse" : "Expand",
            icon: expanded ? (
              <ChevronsLeft className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronsRight className="h-4 w-4 shrink-0" />
            ),
            active: false,
            onClick: () => setSettings({ railExpanded: !expanded }),
          })}
          {levelButton({
            label: "Settings",
            icon: <Settings className="h-4 w-4 shrink-0" />,
            active: false,
            onClick: onOpenSettings,
          })}
        </div>
      </nav>
      {menu.element}

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

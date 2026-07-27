import { useEffect, useState } from "react";
import { FolderOpen, History, LayoutGrid, Plus, X } from "lucide-react";
import { workspaceLight, type RecentWorkspace, type TrafficLight } from "@crystal/core";
import { EMPTY_RUNS, EMPTY_TODOS, useFleet, useWorkspaces } from "@crystal/client";
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
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog.js";

/**
 * Top-level navigation: the Overview (cross-workspace home) tab, one tab per
 * open workspace, and the opener. Workspaces are the first-level construct —
 * the facet tabs underneath navigate *within* the active one. Each workspace
 * tab carries its traffic light so cross-project attention stays visible.
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
  onSelectWorkspace: (id: string) => void;
}) {
  const workspaces = useWorkspaces((s) => s.workspaces);
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

  // The command palette (or any embedder) can summon the opener.
  useEffect(() => {
    const onOpen = () => setDialog({ open: true });
    window.addEventListener("crystal:open-workspace", onOpen);
    return () => window.removeEventListener("crystal:open-workspace", onOpen);
  }, []);

  // "Home" = the cross-workspace overview; anything else means a workspace is entered.
  const entered = !isCrossProjectMode(mode);
  const lightFor = (ws: string) =>
    workspaceLight(
      todosByWs[ws] ?? EMPTY_TODOS,
      runsByWs[ws] ?? EMPTY_RUNS,
      seenAtByWs[ws] ?? null,
      questionsByWs[ws] ?? 0,
    );
  const openRoots = new Set(workspaces.map((w) => w.root));
  const reopenable = recents.filter((r) => !openRoots.has(r.root));

  async function reopen(recent: RecentWorkspace) {
    try {
      await openWorkspace(recent.root);
    } catch (err) {
      // Hand the failure to the dialog, prefilled, so the user can correct the path.
      setDialog({ open: true, initialPath: recent.root, initialError: (err as Error).message });
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
        {workspaces.map((w, i) => {
          const isActive = activeId === w.id;
          return (
            <Tooltip
              key={w.id}
              content={w.root}
              shortcut={i < 9 ? `Ctrl+Alt+${i + 1}` : undefined}
            >
              <button
                type="button"
                onClick={() => onSelectWorkspace(w.id)}
                aria-pressed={entered && isActive}
                className={cn(
                  "group/wstab flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
                  entered && isActive
                    ? "bg-crystal-500/20 text-crystal-200"
                    : isActive
                      ? "text-ink hover:bg-surface-3"
                      : "text-ink-muted hover:bg-surface-3 hover:text-ink",
                )}
              >
                <TrafficLightDot light={lightFor(w.id)} />
                <span className="max-w-40 truncate">{w.name}</span>
                {workspaces.length > 1 ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Close workspace ${w.name}`}
                    className="-mr-0.5 rounded p-0.5 text-ink-faint opacity-0 hover:bg-surface-3 hover:text-danger group-hover/wstab:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeWorkspace(w.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                ) : null}
              </button>
            </Tooltip>
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
                    <History className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{r.name}</span>
                      <span className="block truncate text-[10px] text-ink-faint">{r.root}</span>
                    </span>
                    {r.missing ? (
                      <span className="shrink-0 text-[9px] text-danger">missing</span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => setDialog({ open: true })} className="gap-2 text-ink-muted">
              <FolderOpen className="h-3.5 w-3.5" /> Open folder…
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
    </>
  );
}

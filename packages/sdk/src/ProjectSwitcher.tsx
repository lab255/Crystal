import { useState } from "react";
import {
  AppWindow,
  Check,
  ChevronsUpDown,
  Copy,
  FolderOpen,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import { workspaceLight } from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  openNewWindow,
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
  TrafficLightDot,
  cn,
} from "@crystal/ui";

/**
 * The header's project context menu — clicking the active project's name
 * opens its settings/actions (settings, terminal, copy path, new window,
 * close). Pure actions on the ACTIVE workspace; switching lives next door in
 * {@link ProjectSwitcher}.
 */
export function ProjectMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const activeWs = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId) ?? null);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const { activeSid } = useCrystal();
  if (!activeWs) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project menu for ${activeWs.name}`}
          className="flex h-6 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface-3"
        >
          <span className="min-w-0 max-w-40 truncate">{activeWs.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="min-w-60">
        <DropdownMenuLabel className="max-w-72 truncate font-normal text-ink-faint">
          {activeWs.root}
        </DropdownMenuLabel>
        {/* These are the machine-local app settings (theme, keymap, publish) —
            calling them "Project settings" sent users here hunting for the
            roster/grants/services, which live in their own modes. */}
        <DropdownMenuItem onSelect={onOpenSettings} className="gap-2">
          <Settings2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" /> App settings…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            window.dispatchEvent(
              new CustomEvent("crystal:open-terminal", {
                detail: { ws: activeWs.id, sid: activeSid },
              }),
            )
          }
          className="gap-2"
        >
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-ink-faint" /> Open terminal here
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void navigator.clipboard.writeText(activeWs.root).catch(() => {})}
          className="gap-2"
        >
          <Copy className="h-3.5 w-3.5 shrink-0 text-ink-faint" /> Copy path
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openNewWindow()} className="gap-2">
          <AppWindow className="h-3.5 w-3.5 shrink-0 text-ink-faint" /> New window
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void closeWorkspace(activeWs.id)}
          className="gap-2 text-danger"
        >
          <X className="h-3.5 w-3.5 shrink-0" /> Close workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The header's project switcher — same component language as the branch
 * switcher beside it: a compact trigger, a menu of every open workspace
 * across every connected bridge (traffic lights riding along), and the
 * opener at the bottom.
 */
export function ProjectSwitcher({
  onSelectWorkspace,
}: {
  onSelectWorkspace: (sid: string, id: string) => void;
}) {
  const { activeSid } = useCrystal();
  const connections = useFleetConnections();
  const activeId = useWorkspaces((s) => s.activeId);
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  const [open, setOpen] = useState(false);

  const multiServer = connections.length > 1;
  const total = connections.reduce((n, c) => n + c.workspaces.length, 0);
  if (total === 0) return null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch project"
          title="Switch project"
          className="flex h-6 shrink-0 items-center rounded-md px-1 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="min-w-64">
        {connections.map((c) => (
          <div key={c.sid}>
            {multiServer ? <DropdownMenuLabel>{c.label}</DropdownMenuLabel> : null}
            {c.workspaces.map((w) => {
              const isActive = c.sid === activeSid && w.id === activeId;
              const key = wsKey(c.sid, w.id);
              const light = workspaceLight(
                todosByWs[key] ?? EMPTY_TODOS,
                runsByWs[key] ?? EMPTY_RUNS,
                seenAtByWs[key] ?? null,
                questionsByWs[key]?.length ?? 0,
              );
              return (
                <DropdownMenuItem
                  key={key}
                  onSelect={() => onSelectWorkspace(c.sid, w.id)}
                  className="gap-2"
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold uppercase",
                      isActive ? "bg-crystal-500 text-white" : "bg-surface-3 text-ink-muted",
                    )}
                  >
                    {w.name.slice(0, 1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {light === "red" || light === "yellow" ? <TrafficLightDot light={light} /> : null}
                  {isActive ? <Check className="h-3.5 w-3.5 shrink-0 text-crystal-300" /> : null}
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => window.dispatchEvent(new CustomEvent("crystal:open-workspace"))}
          className="gap-2 text-ink-muted"
        >
          <FolderOpen className="h-3.5 w-3.5" /> Open folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

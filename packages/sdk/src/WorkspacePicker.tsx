import { useState } from "react";
import { Check, ChevronsUpDown, FolderPlus, X } from "lucide-react";
import { workspaceLight } from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  useActiveWorkspace,
  useFleet,
  useWorkspaces,
} from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TrafficLightDot,
  cn,
} from "@crystal/ui";
import { OpenWorkspaceDialog } from "./OpenWorkspaceDialog.js";

/**
 * Top-bar workspace picker: switch between the workspaces open on the
 * bridge server, open new ones by path, close ones you're done with. Each row
 * carries the workspace's traffic light so cross-project attention is visible
 * from any mode.
 */
export function WorkspacePicker() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const active = useActiveWorkspace();
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);

  const [openDialog, setOpenDialog] = useState(false);

  const lightFor = (ws: string) =>
    workspaceLight(todosByWs[ws] ?? EMPTY_TODOS, runsByWs[ws] ?? EMPTY_RUNS, seenAtByWs[ws] ?? null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1 text-ink-muted hover:bg-surface-3 hover:text-ink"
            aria-label="Switch workspace"
            title={active?.root}
          >
            {active ? <TrafficLightDot light={lightFor(active.id)} /> : null}
            <span className="max-w-48 truncate">{active?.name ?? "No workspace"}</span>
            {workspaces.length > 1 ? (
              <span className="rounded-full bg-surface-3 px-1 text-[9px] text-ink-faint">
                {workspaces.length}
              </span>
            ) : null}
            <ChevronsUpDown className="h-3 w-3 text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="min-w-64">
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => setActive(w.id)}
              className="group/ws gap-2"
            >
              <Check
                className={cn("h-3.5 w-3.5 shrink-0", w.id === active?.id ? "text-crystal-300" : "opacity-0")}
              />
              <TrafficLightDot light={lightFor(w.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{w.name}</span>
                <span className="block truncate text-[10px] text-ink-faint">{w.root}</span>
              </span>
              {workspaces.length > 1 ? (
                <Tooltip content="Close workspace">
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Close workspace ${w.name}`}
                    className="rounded p-0.5 text-ink-faint opacity-0 hover:bg-surface-3 hover:text-danger group-hover/ws:opacity-100"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeWorkspace(w.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                </Tooltip>
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onSelect={() => setOpenDialog(true)} className="gap-2 text-ink-muted">
            <FolderPlus className="h-3.5 w-3.5" /> Open workspace…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <OpenWorkspaceDialog open={openDialog} onOpenChange={setOpenDialog} />
    </>
  );
}

import { useState } from "react";
import { Check, ChevronsUpDown, FolderOpen, FolderPlus, X } from "lucide-react";
import { useActiveWorkspace, useWorkspaces } from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  cn,
} from "@crystal/ui";

/**
 * Status-bar workspace picker: switch between the workspaces open on the
 * bridge server, open new ones by path, close ones you're done with.
 */
export function WorkspacePicker() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const setActive = useWorkspaces((s) => s.setActive);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const closeWorkspace = useWorkspaces((s) => s.closeWorkspace);
  const active = useActiveWorkspace();

  const [openDialog, setOpenDialog] = useState(false);
  const [root, setRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleOpen() {
    const trimmed = root.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(trimmed);
      setRoot("");
      setOpenDialog(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
            <span className="max-w-48 truncate">{active?.name ?? "No workspace"}</span>
            {workspaces.length > 1 ? (
              <span className="rounded-full bg-surface-3 px-1 text-[9px] text-ink-faint">
                {workspaces.length}
              </span>
            ) : null}
            <ChevronsUpDown className="h-3 w-3 text-ink-faint" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="min-w-64">
          {workspaces.map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => setActive(w.id)}
              className="group/ws gap-2"
            >
              <Check
                className={cn("h-3.5 w-3.5 shrink-0", w.id === active?.id ? "text-crystal-300" : "opacity-0")}
              />
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

      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent
          title="Open workspace"
          description="Absolute path to a directory on the machine running the bridge server."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleOpen();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="C:\Users\me\Workspaces\my-product"
              spellCheck={false}
            />
            {error ? <div className="text-[11px] text-danger">{error}</div> : null}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={!root.trim() || busy}>
                <FolderOpen className="h-3.5 w-3.5" /> Open
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

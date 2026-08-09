import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useWorkspaces } from "@crystal/client";
import { Button, Dialog, DialogContent } from "@crystal/ui";

/**
 * The safe-mode prompt: the previous boot's workspace restore never completed
 * (the server most likely crashed opening one of these roots), so the server
 * held them back rather than walk into the same crash. The user decides —
 * restore anyway (marker-guarded, so a repeat crash re-arms this prompt) or
 * start without them (they stay in the recents list, nothing is lost).
 * Closing the dialog just hides it for this session; the choice comes back
 * next launch while safe mode is still armed.
 */
export function RestorePrompt() {
  const pending = useWorkspaces((s) => s.pendingRestore);
  const restorePending = useWorkspaces((s) => s.restorePending);
  const dismissRestore = useWorkspaces((s) => s.dismissRestore);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<"restore" | "dismiss" | null>(null);

  if (!pending || hidden) return null;

  const act = (kind: "restore" | "dismiss") => {
    setBusy(kind);
    void (kind === "restore" ? restorePending() : dismissRestore()).finally(() =>
      setBusy(null),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && setHidden(true)}>
      <DialogContent
        title={
          <span className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-warn" />
            Restore workspaces?
          </span>
        }
        description="Crystal didn't finish restoring your workspaces last time — opening one of them may have crashed it. It started in safe mode without them."
      >
        <ul className="mb-3 max-h-40 space-y-1 overflow-y-auto rounded-md border border-edge bg-surface-1 p-2">
          {pending.map((root) => (
            <li key={root} className="truncate font-mono text-[11px] text-ink-muted" title={root}>
              {root}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy != null}
            onClick={() => act("dismiss")}
          >
            {busy === "dismiss" ? "Removing…" : "Start without"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy != null}
            onClick={() => act("restore")}
          >
            {busy === "restore" ? "Restoring…" : `Restore ${pending.length > 1 ? `${pending.length} workspaces` : "workspace"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

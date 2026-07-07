import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { useWorkspaces } from "@crystal/client";
import { Button, Dialog, DialogClose, DialogContent, Input } from "@crystal/ui";

/** Dialog for opening a workspace by absolute path on the bridge host. */
export function OpenWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
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
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
  );
}

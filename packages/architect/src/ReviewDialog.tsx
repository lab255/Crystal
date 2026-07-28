import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { RefCombobox, useWorkspace } from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  Field,
  Select,
  Spinner,
} from "@crystal/ui";

/**
 * "Review a commit / branch" — pick a git ref, and the server snapshots the
 * code architecture at that ref and materializes it as a draft for the
 * split-pane review. A PR is just its head ref: local branches and anything
 * fetched (`origin/feature-x`) work directly. The shared ref picker offers
 * branches/remotes/tags plus recent commits, so no separate commit list.
 */

const EMPTY_REPOS: never[] = [];

export function ReviewDialog({
  open,
  onOpenChange,
  archPath,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archPath: string;
  onCreated: (draftPath: string) => void;
}) {
  const repos = useWorkspace((s) => s.info?.manifest.repos ?? EMPTY_REPOS);
  const createFromRef = useWorkspace((s) => s.createArchDraftFromRef);

  const [repoPath, setRepoPath] = useState(".");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function review(target: string) {
    const trimmed = target.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createFromRef(
        archPath,
        trimmed,
        repoPath === "." ? undefined : repoPath,
      );
      onOpenChange(false);
      setRef("");
      onCreated(created.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        title="Review a commit or branch"
        description="Snapshot the code architecture at a git ref and compare it against the current diagram as a draft."
      >
        <div className="space-y-3">
          {repos.length > 1 ? (
            <Field label="Repository">
              <Select
                size="sm"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                options={repos.map((r) => ({ value: r.path, label: r.name }))}
              />
            </Field>
          ) : null}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void review(ref);
            }}
          >
            <RefCombobox
              value={ref}
              onChange={setRef}
              onSubmit={(v) => void review(v)}
              repoPath={repoPath === "." ? undefined : repoPath}
              commitLimit={30}
              placeholder="branch, tag or commit — e.g. origin/feature-x"
              className="min-w-0 flex-1"
              disabled={busy}
            />
            <Button type="submit" variant="primary" size="sm" disabled={!ref.trim() || busy}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
              Review
            </Button>
          </form>

          {error ? (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

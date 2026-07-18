import { useEffect, useState } from "react";
import { GitCommit as GitCommitIcon, History } from "lucide-react";
import { useGitRefs, useWorkspace } from "@crystal/client";
import {
  Badge,
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  Spinner,
  cn,
} from "@crystal/ui";

/**
 * "Review a commit / branch" — pick a git ref, and the server snapshots the
 * code architecture at that ref and materializes it as a draft for the
 * split-pane review. A PR is just its head ref: local branches and anything
 * fetched (`origin/feature-x`) work directly.
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

  // Shared picker data — branches/remotes/tags plus recent commits, refreshed
  // on every open (and whenever the repo selection changes, via `reload`'s
  // repo-scoped identity).
  const {
    commits,
    options: refOptions,
    error: refsError,
    reload: reloadRefs,
  } = useGitRefs({ repoPath: repoPath === "." ? undefined : repoPath, commitLimit: 30 });
  useEffect(() => {
    if (!open) return;
    setError(null);
    reloadRefs();
  }, [open, reloadRefs]);

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
            <label className="block">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Repository
              </div>
              <select
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="w-full rounded-lg border border-edge bg-surface-1 px-2 py-1.5 text-xs text-ink outline-none"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void review(ref);
            }}
          >
            <Combobox
              value={ref}
              onChange={setRef}
              onSubmit={(v) => void review(v)}
              options={refOptions}
              placeholder="branch, tag or commit — e.g. origin/feature-x"
              className="min-w-0 flex-1"
              disabled={busy}
            />
            <Button type="submit" variant="primary" size="sm" disabled={!ref.trim() || busy}>
              {busy ? <Spinner className="h-3.5 w-3.5" /> : <History className="h-3.5 w-3.5" />}
              Review
            </Button>
          </form>

          {(error ?? refsError) ? (
            <div className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] text-danger">
              {error ?? refsError}
            </div>
          ) : null}

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
              Recent commits
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-edge">
              {commits === null ? (
                <div className="flex items-center justify-center py-6">
                  <Spinner />
                </div>
              ) : commits.length === 0 ? (
                <div className="px-3 py-4 text-center text-[11px] text-ink-faint">
                  No commits found{refsError ? "" : " — is this directory a git repository?"}
                </div>
              ) : (
                commits.map((c) => (
                  <button
                    key={c.hash}
                    type="button"
                    disabled={busy}
                    onClick={() => void review(c.hash)}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-edge px-2.5 py-1.5 text-left text-xs last:border-b-0",
                      "text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50",
                    )}
                  >
                    <GitCommitIcon className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
                    <code className="shrink-0 font-mono text-[10px] text-ink-faint">{c.shortHash}</code>
                    <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                    {c.refs.slice(0, 2).map((r) => (
                      <Badge key={r} tone="neutral">
                        {r}
                      </Badge>
                    ))}
                    <span className="shrink-0 text-[10px] text-ink-faint">
                      {c.date ? new Date(c.date).toLocaleDateString() : ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

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

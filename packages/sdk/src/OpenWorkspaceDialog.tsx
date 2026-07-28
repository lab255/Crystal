import { useEffect, useRef, useState } from "react";
import { ArrowUp, Folder, FolderGit2, FolderOpen, Gem, Package } from "lucide-react";
import type { BrowseEntry } from "@crystal/core";
import { useCrystal, useWorkspaces } from "@crystal/client";
import { Button, Dialog, DialogClose, DialogContent, Input, Spinner, cn } from "@crystal/ui";
import { RecentWorkspaceRowContent } from "./RecentWorkspaceRow.js";

type Listing = { path: string; parent: string | null; entries: BrowseEntry[] };

/**
 * Open a workspace on the bridge host: reopen a recent one with a click,
 * browse the host's directories, or type/paste an absolute path. The browser
 * follows the path input (debounced), so both affordances stay in sync.
 */
export function OpenWorkspaceDialog({
  open,
  onOpenChange,
  initialPath,
  initialError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill the path input (e.g. retrying a failed reopen). */
  initialPath?: string;
  initialError?: string;
}) {
  const { client } = useCrystal();
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const recents = useWorkspaces((s) => s.recents);

  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // Stale-response guard: only the latest browse call may land.
  const browseSeq = useRef(0);

  const openRoots = new Set(workspaces.map((w) => w.root));
  const reopenable = recents.filter((r) => !openRoots.has(r.root)).slice(0, 5);

  async function browse(target: string | undefined, { intoInput = false } = {}): Promise<void> {
    const seq = ++browseSeq.current;
    setBrowsing(true);
    try {
      const result = await client.request("workspaces.browse", target ? { path: target } : {});
      if (seq !== browseSeq.current) return;
      setListing(result);
      if (intoInput) setPath(result.path);
    } catch {
      if (seq !== browseSeq.current) return;
      // Not a directory (yet) — keep the last good listing while the user types.
    } finally {
      if (seq === browseSeq.current) setBrowsing(false);
    }
  }

  // (Re)initialize whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPath(initialPath ?? "");
    setError(initialError ?? null);
    setBusy(false);
    void browse(initialPath || undefined);
  }, [open]);

  // The browser follows the typed path (debounced; stale responses dropped).
  const pendingBrowse = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (pendingBrowse.current) clearTimeout(pendingBrowse.current);
    },
    [],
  );
  function onPathChange(next: string): void {
    setPath(next);
    setError(null);
    if (pendingBrowse.current) clearTimeout(pendingBrowse.current);
    pendingBrowse.current = setTimeout(() => void browse(next || undefined), 250);
  }

  async function handleOpen(target?: string): Promise<void> {
    const trimmed = (target ?? path).trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await openWorkspace(trimmed);
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
        description="A directory on the machine running the bridge server."
        className="w-[540px]"
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
            value={path}
            onChange={(e) => onPathChange(e.target.value)}
            placeholder="C:\Users\me\Workspaces\my-product"
            spellCheck={false}
          />

          {reopenable.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                Recent
              </div>
              <div className="space-y-0.5">
                {reopenable.map((r) => (
                  <button
                    key={r.root}
                    type="button"
                    disabled={r.missing || busy}
                    onClick={() => void handleOpen(r.root)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                      r.missing
                        ? "cursor-default opacity-40"
                        : "text-ink-muted hover:bg-surface-3 hover:text-ink",
                    )}
                  >
                    <RecentWorkspaceRowContent recent={r} />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="overflow-hidden rounded-lg border border-edge">
            <div className="flex h-7 items-center gap-1.5 border-b border-edge bg-surface-1 px-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Parent directory"
                disabled={!listing?.parent || browsing}
                onClick={() => listing?.parent && void browse(listing.parent, { intoInput: true })}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
                {listing?.path ?? ""}
              </span>
              {browsing ? <Spinner className="h-3 w-3" /> : null}
            </div>
            <div className="max-h-52 overflow-y-auto p-1">
              {listing?.entries.map((entry) => {
                const MarkerIcon =
                  entry.marker === "crystal"
                    ? Gem
                    : entry.marker === "repo"
                      ? FolderGit2
                      : entry.marker === "package"
                        ? Package
                        : Folder;
                return (
                  <div key={entry.path} className="group/dir flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void browse(entry.path, { intoInput: true })}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-surface-3 hover:text-ink"
                    >
                      <MarkerIcon
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          entry.marker === "crystal"
                            ? "text-crystal-300"
                            : entry.marker
                              ? "text-ink-muted"
                              : "text-ink-faint",
                        )}
                      />
                      <span className="truncate">{entry.name}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleOpen(entry.path)}
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] text-crystal-300 hover:bg-crystal-500/20",
                        entry.marker ? "" : "opacity-0 group-hover/dir:opacity-100",
                      )}
                    >
                      Open
                    </button>
                  </div>
                );
              })}
              {listing && listing.entries.length === 0 ? (
                <div className="px-2 py-3 text-center text-[11px] text-ink-faint">
                  No sub-directories
                </div>
              ) : null}
            </div>
          </div>

          {error ? <div className="text-[11px] text-danger">{error}</div> : null}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary" size="sm" disabled={!path.trim() || busy}>
              <FolderOpen className="h-3.5 w-3.5" /> Open
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

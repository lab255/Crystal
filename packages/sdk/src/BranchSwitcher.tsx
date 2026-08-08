import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FolderGit2, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { type GitStatusResult, type GitSyncOp } from "@crystal/core";
import { useCrystal, useGitRefs, useWorkspaces } from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@crystal/ui";

/**
 * Top-navbar dropdown for the active workspace's git state: remote sync,
 * switch local branches, jump between linked worktrees (each opens as its own
 * workspace). Hidden when nothing is open. Lenses/facets live in the LensBar —
 * this menu is git only.
 */
export function BranchSwitcher() {
  const { client } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);

  // Shared refs fetch (branches + worktrees; no commits needed here) — the
  // hook clears on workspace switch so another repo's branches never linger.
  const { refs, error: refsError, load: loadRefs, reload: reloadRefs } = useGitRefs({
    commitLimit: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [syncing, setSyncing] = useState<GitSyncOp | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Ahead/behind for the trigger badge and the Pull/Push rows — quietly
  // absent when the workspace isn't a repo.
  const loadStatus = useCallback(() => {
    client
      .request("git.status", { repoPath: "." })
      .then((s) => setStatus(s.isRepo ? s : null))
      .catch(() => setStatus(null));
  }, [client]);

  const load = useCallback(() => {
    setError(null);
    loadRefs();
    loadStatus();
  }, [loadRefs, loadStatus]);

  // Opening the menu re-fetches — branches move underneath us (fetches,
  // checkouts in a terminal…).
  const refresh = useCallback(() => {
    setError(null);
    reloadRefs();
    loadStatus();
  }, [reloadRefs, loadStatus]);

  // The trigger shows the current branch, so refresh on workspace switch too —
  // not just when the menu opens. Stale data is cleared first.
  useEffect(() => {
    setStatus(null);
    setError(null);
    setSyncMsg(null);
    if (activeWsId) load();
  }, [activeWsId, load]);

  const checkout = useCallback(
    async (ref: string) => {
      setError(null);
      try {
        await client.request("git.checkout", { ref });
        reloadRefs();
        loadStatus();
      } catch (err) {
        // Git's own message (dirty tree, conflicts…) shown inline in the menu.
        setError((err as Error).message);
      }
    },
    [client, reloadRefs, loadStatus],
  );

  const sync = useCallback(
    async (op: GitSyncOp) => {
      if (syncing) return;
      setError(null);
      setSyncMsg(null);
      setSyncing(op);
      try {
        // Network op — give it more rope than the default request timeout,
        // matching the server's own 120 s deadline.
        const res = await client.request("git.sync", { op }, { timeoutMs: 150_000 });
        setStatus(res.status.isRepo ? res.status : null);
        // The last line is git's own outcome ("Already up to date.",
        // "Fast-forward", the pushed range…) — one line says enough.
        const lines = res.summary.split("\n").filter((l) => l.trim());
        setSyncMsg(lines[lines.length - 1] ?? `${op} complete`);
        reloadRefs();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSyncing(null);
      }
    },
    [client, syncing, reloadRefs],
  );

  const openWorktree = useCallback(
    async (path: string) => {
      setError(null);
      try {
        // openWorkspace opens (or focuses) and switches to it in one step.
        await openWorkspace(path);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [openWorkspace],
  );

  if (!activeWsId) return null;

  const worktrees = refs?.worktrees ?? [];

  return (
    <DropdownMenu onOpenChange={(open) => open && refresh()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Branch and worktree switcher"
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <GitBranch className="h-3.5 w-3.5" />
          {refs ? (
            <span className="max-w-40 truncate">{refs.current ?? "detached"}</span>
          ) : null}
          {status && (status.ahead > 0 || status.behind > 0) ? (
            <span
              className="flex items-center text-[10px] text-ink-faint"
              title={`${status.ahead} ahead, ${status.behind} behind ${status.upstream ?? "upstream"}`}
            >
              {status.ahead > 0 ? (
                <>
                  {status.ahead}
                  <ArrowUp className="h-3 w-3" />
                </>
              ) : null}
              {status.behind > 0 ? (
                <>
                  {status.behind}
                  <ArrowDown className="h-3 w-3" />
                </>
              ) : null}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="min-w-56">
        {status ? (
          <>
            <DropdownMenuLabel className="flex items-baseline gap-1.5">
              Remote
              <span className="truncate text-[10px] font-normal text-ink-faint">
                {status.upstream ?? "no upstream"}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem
              disabled={!!syncing || !status.upstream}
              onSelect={(e) => {
                // Keep the menu open — the outcome line lands right below.
                e.preventDefault();
                void sync("pull");
              }}
              className="gap-2"
            >
              {syncing === "pull" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-faint" />
              ) : (
                <ArrowDown className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1">Pull</span>
              {status.behind > 0 ? (
                <span className="shrink-0 text-[10px] text-ink-faint">{status.behind} behind</span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!!syncing}
              onSelect={(e) => {
                e.preventDefault();
                void sync("push");
              }}
              className="gap-2"
            >
              {syncing === "push" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-faint" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1">Push</span>
              {status.ahead > 0 ? (
                <span className="shrink-0 text-[10px] text-ink-faint">{status.ahead} ahead</span>
              ) : status.upstream ? null : (
                <span className="shrink-0 text-[10px] text-ink-faint">sets upstream</span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!!syncing}
              onSelect={(e) => {
                e.preventDefault();
                void sync("fetch");
              }}
              className="gap-2"
            >
              {syncing === "fetch" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-faint" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 flex-1">Fetch</span>
            </DropdownMenuItem>
            {syncMsg ? (
              <div className="max-w-64 truncate px-2 py-1 text-[10px] text-ink-faint" title={syncMsg}>
                {syncMsg}
              </div>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={refs?.current ?? ""}
          onValueChange={(b) => void checkout(b)}
        >
          {(refs?.branches ?? []).map((b) => (
            <DropdownMenuRadioItem
              key={b}
              value={b}
              disabled={refs?.current === b}
              // Keep the menu open: success moves the checkmark, failure
              // shows git's error inline right here.
              onSelect={(e) => e.preventDefault()}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">{b}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {refs && refs.branches.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-ink-faint">No local branches</div>
        ) : null}
        {(error ?? refsError) ? (
          <div className="max-w-64 whitespace-pre-wrap break-words px-2 py-1 text-[10px] text-danger">
            {error ?? refsError}
          </div>
        ) : null}

        {worktrees.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Worktrees</DropdownMenuLabel>
            {worktrees.map((wt) => (
              <DropdownMenuItem
                key={wt.path}
                onSelect={() => void openWorktree(wt.path)}
                className="gap-2"
              >
                <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{wt.branch ?? "detached"}</span>
                  <span className="block truncate text-[10px] text-ink-faint">{wt.path}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

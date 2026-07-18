import { useCallback, useEffect, useState } from "react";
import { Check, Focus, FolderGit2, GitBranch } from "lucide-react";
import { suggestIndexFacets, type IndexFacetSuggestion } from "@crystal/core";
import { useCrystal, useGitRefs, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@crystal/ui";

/**
 * Top-navbar dropdown for the active workspace's git state: switch local
 * branches, jump between linked worktrees (each opens as its own workspace),
 * and drop a facet lens over the code graph. Hidden when nothing is open.
 */
export function BranchSwitcher() {
  const { client } = useCrystal();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const openWorkspace = useWorkspaces((s) => s.openWorkspace);
  const lensParam = useNav((l) => l.architect?.lens ?? null);
  const updateNav = useNavUpdate();

  // Shared refs fetch (branches + worktrees; no commits needed here) — the
  // hook clears on workspace switch so another repo's branches never linger.
  const { refs, error: refsError, load: loadRefs, reload: reloadRefs } = useGitRefs({
    commitLimit: 0,
  });
  const [facets, setFacets] = useState<IndexFacetSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFacets = useCallback(() => {
    client
      .request("codeindex.get", {})
      .then((res) => setFacets(suggestIndexFacets(res.index).slice(0, 6)))
      .catch(() => setFacets([]));
  }, [client]);

  const load = useCallback(() => {
    setError(null);
    loadRefs();
    loadFacets();
  }, [loadRefs, loadFacets]);

  // Opening the menu re-fetches — branches move underneath us (fetches,
  // checkouts in a terminal…).
  const refresh = useCallback(() => {
    setError(null);
    reloadRefs();
    loadFacets();
  }, [reloadRefs, loadFacets]);

  // The trigger shows the current branch, so refresh on workspace switch too —
  // not just when the menu opens. Stale data is cleared first.
  useEffect(() => {
    setFacets(null);
    setError(null);
    if (activeWsId) load();
  }, [activeWsId, load]);

  const checkout = useCallback(
    async (ref: string) => {
      setError(null);
      try {
        await client.request("git.checkout", { ref });
        reloadRefs();
      } catch (err) {
        // Git's own message (dirty tree, conflicts…) shown inline in the menu.
        setError((err as Error).message);
      }
    },
    [client, reloadRefs],
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

  const applyLens = useCallback(
    (s: IndexFacetSuggestion) => {
      updateNav({ mode: "architect", architect: { view: "systems", lens: s.tags.join(",") } });
    },
    [updateNav],
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
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="min-w-56">
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        {(refs?.branches ?? []).map((b) => {
          const isCurrent = refs?.current === b;
          return (
            <DropdownMenuItem
              key={b}
              disabled={isCurrent}
              onSelect={(e) => {
                // Keep the menu open: success moves the checkmark, failure
                // shows git's error inline right here.
                e.preventDefault();
                void checkout(b);
              }}
              className="gap-2"
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">{b}</span>
              {isCurrent ? <Check className="h-3.5 w-3.5 shrink-0 text-ok" /> : null}
            </DropdownMenuItem>
          );
        })}
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

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Facet lens</DropdownMenuLabel>
        {facets && facets.length > 0 ? (
          facets.map((s) => {
            const active = lensParam === s.tags.join(",");
            return (
              <DropdownMenuItem key={s.tags.join(",")} onSelect={() => applyLens(s)} className="gap-2">
                <Focus className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className={cn("shrink-0 text-[10px]", active ? "text-ok" : "text-ink-faint")}>
                  {active ? "active" : `${s.members} members`}
                </span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0 text-ok" /> : null}
              </DropdownMenuItem>
            );
          })
        ) : (
          <div className="px-2 py-1 text-[11px] text-ink-faint">
            No facets yet — run indexing from Jobs
          </div>
        )}
        {lensParam ? (
          <DropdownMenuItem
            onSelect={() => updateNav({ architect: { lens: null } })}
            className="gap-2 text-ink-muted"
          >
            <Focus className="h-3.5 w-3.5 shrink-0" /> Clear lens
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

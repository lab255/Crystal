import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  RefreshCw,
  Tag,
  X,
} from "lucide-react";
import type { GitCommit, GitStatusResult } from "@crystal/core";
import { useCrystal, useGitRefs, useWorkspaces } from "@crystal/client";
import { Badge, Spinner, Tooltip, cn } from "@crystal/ui";

const LOG_LIMIT = 50;

/**
 * The git sidebar: the workspace repo's ref tree (branches / remotes / tags /
 * worktrees) over its recent history. Toggled from the mode rail — it reuses
 * the same `git.refs`/`git.log`/`git.status` plumbing as the BranchSwitcher
 * dropdown, but stays open beside the mode content instead of vanishing on
 * every glance. Clicking a local branch checks it out (same semantics as the
 * BranchSwitcher: git's own message surfaces on conflict).
 */
export function GitPanel({ onClose }: { onClose: () => void }) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const { refs, commits, error, load, reload } = useGitRefs({ commitLimit: LOG_LIMIT });
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchStatus = useCallback(() => {
    client
      .request("git.status", { repoPath: "." })
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [client]);

  useEffect(() => {
    load();
    fetchStatus();
  }, [load, fetchStatus, activeWs]);

  const refresh = useCallback(() => {
    reload();
    fetchStatus();
  }, [reload, fetchStatus]);

  const checkout = useCallback(
    async (ref: string) => {
      setBusyRef(ref);
      setActionError(null);
      try {
        await client.request("git.checkout", { ref });
        refresh();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyRef(null);
      }
    },
    [client, refresh],
  );

  const dirtyCount = status?.files.length ?? 0;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-edge px-2.5">
        <FolderGit2 className="h-3.5 w-3.5 text-ink-faint" />
        <span className="text-xs font-medium text-ink">Git</span>
        {status?.branch ? (
          <Badge tone="cyan" className="max-w-28 truncate font-mono">
            {status.branch}
          </Badge>
        ) : null}
        {status && (status.ahead > 0 || status.behind > 0) ? (
          <span className="text-[10px] text-ink-faint">
            {status.ahead > 0 ? `↑${status.ahead}` : ""}
            {status.behind > 0 ? `↓${status.behind}` : ""}
          </span>
        ) : null}
        {dirtyCount > 0 ? (
          <Tooltip content={`${dirtyCount} changed file${dirtyCount > 1 ? "s" : ""}`}>
            <span className="text-[10px] text-warn">●{dirtyCount}</span>
          </Tooltip>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Tooltip content="Refresh">
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh git panel"
              className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close git panel"
            className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 text-xs">
        {error ? (
          <div className="px-1 py-2 text-[11px] text-danger">{error}</div>
        ) : !refs ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <>
            {actionError ? (
              <div className="mb-1.5 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger">
                {actionError}
              </div>
            ) : null}
            <RefGroup
              icon={<GitBranch className="h-3 w-3" />}
              label="Branches"
              count={refs.branches.length}
              defaultOpen
            >
              {refs.branches.map((b) => (
                <RefRow
                  key={b}
                  label={b}
                  current={b === refs.current}
                  busy={busyRef === b}
                  onActivate={b === refs.current ? undefined : () => void checkout(b)}
                  title={b === refs.current ? "Current branch" : `Check out ${b}`}
                />
              ))}
            </RefGroup>
            <RefGroup
              icon={<Cloud className="h-3 w-3" />}
              label="Remotes"
              count={refs.remoteBranches.length}
            >
              {refs.remoteBranches.map((b) => (
                <RefRow key={b} label={b} />
              ))}
            </RefGroup>
            <RefGroup icon={<Tag className="h-3 w-3" />} label="Tags" count={refs.tags.length}>
              {refs.tags.map((t) => (
                <RefRow key={t} label={t} />
              ))}
            </RefGroup>
            {refs.worktrees.length > 1 ? (
              <RefGroup
                icon={<FolderGit2 className="h-3 w-3" />}
                label="Worktrees"
                count={refs.worktrees.length}
              >
                {refs.worktrees.map((w) => (
                  <div
                    key={w.path}
                    className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-ink-muted"
                    title={w.path}
                  >
                    <span className="min-w-0 truncate font-mono text-[11px]">
                      {w.branch ?? "(detached)"}
                    </span>
                    <span className="min-w-0 truncate text-[10px] text-ink-faint">{w.path}</span>
                  </div>
                ))}
              </RefGroup>
            ) : null}

            <div className="mt-2 border-t border-edge pt-1.5">
              <div className="flex items-center gap-1.5 px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                <GitCommitHorizontal className="h-3 w-3" /> History
              </div>
              {commits === null ? (
                <div className="flex justify-center py-3">
                  <Spinner />
                </div>
              ) : commits.length === 0 ? (
                <div className="px-1.5 py-1 text-[11px] text-ink-faint">No commits.</div>
              ) : (
                commits.map((c) => <CommitRow key={c.hash} commit={c} />)
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function RefGroup({
  icon,
  label,
  count,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-faint hover:bg-surface-2 hover:text-ink-muted"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {label}
        <span className="ml-auto tabular-nums">{count}</span>
      </button>
      {open ? <div className="ml-2">{children}</div> : null}
    </div>
  );
}

function RefRow({
  label,
  current = false,
  busy = false,
  onActivate,
  title,
}: {
  label: string;
  current?: boolean;
  busy?: boolean;
  onActivate?: () => void;
  title?: string;
}) {
  const inner = (
    <>
      <span
        className={cn(
          "min-w-0 truncate font-mono text-[11px]",
          current ? "text-crystal-300" : "text-ink-muted",
        )}
      >
        {label}
      </span>
      {current ? <span className="text-[9px] text-crystal-400">current</span> : null}
      {busy ? <Spinner className="h-3 w-3" /> : null}
    </>
  );
  if (!onActivate)
    return (
      <div className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5" title={title}>
        {inner}
      </div>
    );
  return (
    <button
      type="button"
      onClick={onActivate}
      disabled={busy}
      title={title}
      className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-surface-2"
    >
      {inner}
    </button>
  );
}

function CommitRow({ commit }: { commit: GitCommit }) {
  const date = useMemo(() => {
    const d = new Date(commit.date);
    return Number.isNaN(d.getTime()) ? commit.date : d.toLocaleString();
  }, [commit.date]);
  return (
    <div
      className="group flex min-w-0 items-start gap-1.5 rounded px-1.5 py-0.5 hover:bg-surface-2"
      title={`${commit.hash}\n${commit.author} · ${date}`}
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-edge group-hover:bg-crystal-400" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">{commit.shortHash}</span>
          <span className="min-w-0 truncate text-[11px] text-ink-muted">{commit.subject}</span>
        </div>
        {commit.refs.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {commit.refs.map((r) => (
              <Badge key={r} tone="violet" className="max-w-40 truncate">
                {r}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

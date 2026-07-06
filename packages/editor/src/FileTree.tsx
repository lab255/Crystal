import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import type { FileEntry } from "@crystal/core";
import { useCrystal, useWorkspace } from "@crystal/client";
import { Button, Tooltip, cn } from "@crystal/ui";

interface DirState {
  entries: FileEntry[];
  loading: boolean;
}

/** "M " / " M" → modified, "??"/"A " → new. */
type GitDecoration = "modified" | "added";

function decorationFor(code: string): GitDecoration {
  return code === "??" || code.startsWith("A") ? "added" : "modified";
}

const DECORATION_CLASSES: Record<GitDecoration, string> = {
  modified: "text-warn",
  added: "text-ok",
};

const EMPTY_REPOS: never[] = [];

export function FileTree({
  activePath,
  onOpenFile,
}: {
  activePath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const { client } = useCrystal();
  const repos = useWorkspace((s) => s.info?.manifest.repos ?? EMPTY_REPOS);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [gitStatus, setGitStatus] = useState<Map<string, GitDecoration>>(new Map());

  const loadGitStatus = useCallback(async () => {
    const map = new Map<string, GitDecoration>();
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const status = await client.request("git.status", { repoPath: repo.path });
          for (const file of status.files) {
            const full = repo.path === "." ? file.path : `${repo.path}/${file.path}`;
            const deco = decorationFor(file.code);
            map.set(full, deco);
            // Bubble a "modified" hint up parent directories.
            let dir = full;
            while (dir.includes("/")) {
              dir = dir.slice(0, dir.lastIndexOf("/"));
              if (!map.has(dir)) map.set(dir, "modified");
            }
          }
        } catch {
          // Not a git repo / git unavailable — no decorations.
        }
      }),
    );
    setGitStatus(map);
  }, [client, repos]);

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((d) => ({ ...d, [path]: { entries: d[path]?.entries ?? [], loading: true } }));
      try {
        const { entries } = await client.request("fs.list", { path: path || "." });
        setDirs((d) => ({ ...d, [path]: { entries, loading: false } }));
      } catch {
        setDirs((d) => ({ ...d, [path]: { entries: [], loading: false } }));
      }
    },
    [client],
  );

  useEffect(() => {
    void loadDir("");
    void loadGitStatus();
    const dispose = client.events.on("fs.changed", ({ ws }) => {
      // Only the active workspace is shown here; other workspaces' events
      // would just cause pointless refetch churn.
      if (client.scope && ws !== client.scope) return;
      // Refresh only directories we currently show.
      setExpanded((exp) => {
        for (const dir of exp) void loadDir(dir);
        return exp;
      });
      void loadGitStatus();
    });
    return dispose;
  }, [client, loadDir, loadGitStatus]);

  function toggle(path: string): void {
    setExpanded((exp) => {
      const next = new Set(exp);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs[path]) void loadDir(path);
      }
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Files
        </span>
        <Tooltip content="Refresh">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              void loadDir("");
              void loadGitStatus();
            }}
            aria-label="Refresh files"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        <TreeLevel
          path=""
          depth={0}
          dirs={dirs}
          expanded={expanded}
          activePath={activePath}
          gitStatus={gitStatus}
          onToggle={toggle}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
}

function TreeLevel({
  path,
  depth,
  dirs,
  expanded,
  activePath,
  gitStatus,
  onToggle,
  onOpenFile,
}: {
  path: string;
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  activePath: string | null;
  gitStatus: Map<string, GitDecoration>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const state = dirs[path];
  if (!state) return null;

  return (
    <>
      {state.entries.map((entry) => {
        const isOpen = expanded.has(entry.path);
        const indent = { paddingLeft: `${10 + depth * 12}px` };
        const decoration = gitStatus.get(entry.path);
        if (entry.kind === "dir") {
          return (
            <div key={entry.path}>
              <button
                type="button"
                style={indent}
                onClick={() => onToggle(entry.path)}
                className="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
                )}
                {isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-amber/80" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-accent-amber/60" />
                )}
                <span className="truncate">{entry.name}</span>
                {decoration && !isOpen ? (
                  <span className={cn("ml-auto pr-1 text-[13px] leading-none", DECORATION_CLASSES[decoration])}>
                    •
                  </span>
                ) : null}
              </button>
              {isOpen ? (
                <TreeLevel
                  path={entry.path}
                  depth={depth + 1}
                  dirs={dirs}
                  expanded={expanded}
                  activePath={activePath}
                  gitStatus={gitStatus}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                />
              ) : null}
            </div>
          );
        }
        return (
          <button
            key={entry.path}
            type="button"
            style={{ paddingLeft: `${10 + depth * 12 + 14}px` }}
            onClick={() => onOpenFile(entry.path)}
            className={cn(
              "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12.5px] transition-colors",
              activePath === entry.path
                ? "bg-crystal-500/15 text-ink"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink",
            )}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className={cn("truncate", decoration && DECORATION_CLASSES[decoration])}>
              {entry.name}
            </span>
            {decoration ? (
              <span className={cn("ml-auto pr-1 text-[10px] font-semibold", DECORATION_CLASSES[decoration])}>
                {decoration === "added" ? "U" : "M"}
              </span>
            ) : null}
          </button>
        );
      })}
    </>
  );
}

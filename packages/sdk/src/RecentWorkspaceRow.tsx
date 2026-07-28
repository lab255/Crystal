import { History } from "lucide-react";
import type { RecentWorkspace } from "@crystal/core";

/**
 * The one rendering of a recent workspace's identity — history icon, name
 * over root, a "missing" badge when the directory is gone. The workspace-tabs
 * `+` menu and the open-workspace dialog both wrap this in their own
 * interactive host (menu item / button row), so the identity treatment can't
 * drift between them.
 */
export function RecentWorkspaceRowContent({ recent }: { recent: RecentWorkspace }) {
  return (
    <>
      <History className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{recent.name}</span>
        <span className="block truncate text-[10px] text-ink-faint">{recent.root}</span>
      </span>
      {recent.missing ? <span className="shrink-0 text-[9px] text-danger">missing</span> : null}
    </>
  );
}

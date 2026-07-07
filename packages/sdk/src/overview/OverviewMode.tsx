import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { useWorkspaces } from "@crystal/client";
import { Button, EmptyState } from "@crystal/ui";
import { OpenWorkspaceDialog } from "../OpenWorkspaceDialog.js";
import { WorkspaceCard } from "./WorkspaceCard.js";

/**
 * Projects mode — mission control across every open workspace. Each card
 * shows the workspace's traffic light, what its agents are doing, and its
 * todo list, so switching codebases starts with context instead of
 * archaeology.
 */
export function OverviewMode() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const [openDialog, setOpenDialog] = useState(false);

  return (
    <div className="h-full overflow-y-auto bg-surface-0">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <header className="mb-5 flex items-center gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Projects</h2>
            <p className="text-xs text-ink-muted">
              Every workspace on this bridge — traffic lights, agents and todos in one place.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpenDialog(true)}
            className="ml-auto"
          >
            <FolderPlus className="h-3.5 w-3.5" /> Open workspace…
          </Button>
        </header>

        {workspaces.length === 0 ? (
          <EmptyState title="No workspaces open">
            Open a workspace to start tracking its agents and todos.
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {workspaces.map((w) => (
              <WorkspaceCard key={w.id} ws={w} active={w.id === activeId} />
            ))}
          </div>
        )}
      </div>

      <OpenWorkspaceDialog open={openDialog} onOpenChange={setOpenDialog} />
    </div>
  );
}

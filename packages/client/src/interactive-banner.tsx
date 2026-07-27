import { TerminalSquare } from "lucide-react";
import type { AgentRun } from "@crystal/core";
import { Button, cn } from "@crystal/ui";
import { useTerminals, useWorkspaces } from "./provider.js";

/**
 * The one banner for a run hosted as a native interactive Claude session: its
 * transcript lives in its terminal, not in the run's event stream. Rendered by
 * the run view, the workflow manager pane and the hub manager pane — identical
 * semantics, one definition. Null for ordinary (headless) runs.
 */
export function InteractiveRunBanner({
  run,
  className,
}: {
  run: AgentRun;
  className?: string;
}) {
  const activeWs = useWorkspaces((s) => s.activeId);
  const focusTerminal = useTerminals((s) => s.focusTerminal);
  if (!run.terminalId) return null;
  const live = run.status === "running" || run.status === "queued";
  // Hub-owned runs carry the hosting workspace; workspace runs live where
  // the viewer already is.
  const ws = run.terminalWs ?? activeWs;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 bg-surface-2/50 px-3 py-1.5 text-[11px] text-ink-muted",
        className,
      )}
    >
      <TerminalSquare className="h-3 w-3 shrink-0 text-crystal-300" />
      {live
        ? "Runs interactively — talk to it in its terminal."
        : "Ran interactively — its transcript lived in its terminal."}
      {live && ws ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void focusTerminal(ws, run.terminalId!)}
        >
          Open its terminal →
        </Button>
      ) : null}
    </div>
  );
}

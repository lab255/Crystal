import { useEffect, useState } from "react";
import { Boxes, Code2, Gem, KanbanSquare, type LucideIcon } from "lucide-react";
import { useAgents, useConnectionState, useWorkspace } from "@crystal/client";
import { ArchitectMode } from "@crystal/architect";
import { OrchestratorMode } from "@crystal/orchestrator";
import { EditorMode } from "@crystal/editor";
import { StatusDot, Tooltip, TooltipProvider, cn } from "@crystal/ui";
import { CommandPalette } from "./CommandPalette.js";
import { CRYSTAL_MODES, MODE_LABELS, type CrystalMode } from "./modes.js";

const MODE_ICONS: Record<CrystalMode, LucideIcon> = {
  architect: Boxes,
  orchestrate: KanbanSquare,
  code: Code2,
};

export interface CrystalShellProps {
  initialMode?: CrystalMode;
  onModeChange?: (mode: CrystalMode) => void;
  /** Hide the bottom status bar (for tight embeds). */
  hideStatusBar?: boolean;
}

export function CrystalShell({ initialMode, onModeChange, hideStatusBar }: CrystalShellProps) {
  const [mode, setMode] = useState<CrystalMode>(initialMode ?? "architect");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const connection = useConnectionState();
  const workspaceName = useWorkspace((s) => s.info?.manifest.name);
  const workspaceRoot = useWorkspace((s) => s.info?.root);
  const saving = useWorkspace((s) => Object.keys(s.pendingSaves).length > 0);
  const wsError = useWorkspace((s) => s.error);
  const runningRuns = useAgents((s) => s.runs.filter((r) => r.status === "running").length);

  function switchMode(next: CrystalMode): void {
    setMode(next);
    onModeChange?.(next);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        switchMode(CRYSTAL_MODES[Number(e.key) - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-surface-0 text-ink">
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface-1 py-2.5">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-crystal-500 to-prism-500 shadow-lg shadow-crystal-500/30">
              <Gem className="h-4.5 w-4.5 text-white" />
            </div>
            {CRYSTAL_MODES.map((m, i) => {
              const Icon = MODE_ICONS[m];
              return (
                <Tooltip key={m} content={MODE_LABELS[m]} shortcut={`Ctrl+${i + 1}`} side="right">
                  <button
                    type="button"
                    onClick={() => switchMode(m)}
                    aria-label={MODE_LABELS[m]}
                    aria-pressed={mode === m}
                    className={cn(
                      "relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                      mode === m
                        ? "bg-crystal-500/20 text-crystal-300"
                        : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
                    )}
                  >
                    {mode === m ? (
                      <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-crystal-400" />
                    ) : null}
                    <Icon className="h-4.5 w-4.5" />
                    {m === "orchestrate" && runningRuns > 0 ? (
                      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-0.5 text-[9px] font-bold text-surface-0">
                        {runningRuns}
                      </span>
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1">
            {/* Keep all three modes mounted so canvas/editor state survives switches. */}
            <div className={cn("h-full", mode !== "architect" && "hidden")}>
              <ArchitectMode />
            </div>
            <div className={cn("h-full", mode !== "orchestrate" && "hidden")}>
              <OrchestratorMode />
            </div>
            <div className={cn("h-full", mode !== "code" && "hidden")}>
              <EditorMode />
            </div>
          </div>
        </div>

        {!hideStatusBar ? (
          <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-surface-1 px-3 text-[11px] text-ink-faint">
            <span className="flex items-center gap-1.5">
              <StatusDot
                status={
                  connection === "open" ? "completed" : connection === "connecting" ? "running" : "failed"
                }
              />
              {connection === "open" ? "bridge" : connection}
            </span>
            {workspaceName ? (
              <Tooltip content={workspaceRoot ?? ""}>
                <span className="text-ink-muted">{workspaceName}</span>
              </Tooltip>
            ) : null}
            {saving ? <span className="text-info">saving…</span> : null}
            {wsError ? <span className="max-w-96 truncate text-danger">{wsError}</span> : null}
            <span className="ml-auto flex items-center gap-3">
              {runningRuns > 0 ? (
                <span className="text-info">
                  {runningRuns} agent{runningRuns > 1 ? "s" : ""} running
                </span>
              ) : null}
              <span>Crystal 0.1</span>
            </span>
          </footer>
        ) : null}

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSwitchMode={switchMode} />
      </div>
    </TooltipProvider>
  );
}

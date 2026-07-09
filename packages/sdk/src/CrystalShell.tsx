import { Suspense, lazy, useEffect, useState } from "react";
import {
  Activity,
  Boxes,
  Check,
  Code2,
  Gem,
  KanbanSquare,
  LayoutGrid,
  Link2,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { parseDeepLink, workspaceLight, worstLight, type TrafficLight } from "@crystal/core";
import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  useAgents,
  useConnectionState,
  useCrystal,
  useFleet,
  useNav,
  useNavUpdate,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { Spinner, StatusDot, Tooltip, TooltipProvider, TrafficLightDot, cn } from "@crystal/ui";
import { CommandPalette } from "./CommandPalette.js";
import { useDeepLinks } from "./deeplinks.js";
import { CRYSTAL_MODES, MODE_LABELS, type CrystalMode } from "./modes.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { WorkspacePicker } from "./WorkspacePicker.js";

// Each mode is a lazy chunk: react-flow/dagre and Monaco only download when
// their mode is first opened. Once visited, a mode stays mounted so canvas and
// editor state survive switches.
const ArchitectMode = lazy(() =>
  import("@crystal/architect").then((m) => ({ default: m.ArchitectMode })),
);
const OrchestratorMode = lazy(() =>
  import("@crystal/orchestrator").then((m) => ({ default: m.OrchestratorMode })),
);
const EditorMode = lazy(() =>
  import("@crystal/editor").then((m) => ({ default: m.EditorMode })),
);
const OverviewMode = lazy(() =>
  import("./overview/OverviewMode.js").then((m) => ({ default: m.OverviewMode })),
);
const JobsMode = lazy(() =>
  import("./jobs/JobsMode.js").then((m) => ({ default: m.JobsMode })),
);

const MODE_COMPONENTS: Record<CrystalMode, React.LazyExoticComponent<() => React.JSX.Element>> = {
  projects: OverviewMode,
  architect: ArchitectMode,
  orchestrate: OrchestratorMode,
  code: EditorMode,
  jobs: JobsMode,
};

const MODE_ICONS: Record<CrystalMode, LucideIcon> = {
  projects: LayoutGrid,
  architect: Boxes,
  orchestrate: KanbanSquare,
  code: Code2,
  jobs: Activity,
};

export interface CrystalShellProps {
  initialMode?: CrystalMode;
  onModeChange?: (mode: CrystalMode) => void;
  /** Hide the bottom status bar (for tight embeds). */
  hideStatusBar?: boolean;
  /** Sync views to the URL hash for shareable deep links (default on; turn off for embeds that own the URL). */
  deepLinking?: boolean;
}

export function CrystalShell({
  initialMode,
  onModeChange,
  hideStatusBar,
  deepLinking = true,
}: CrystalShellProps) {
  // Peek at the hash before the first render so a deep-linked mode doesn't
  // flash (and lazily download) the default mode first.
  const [urlMode] = useState(() =>
    deepLinking && typeof window !== "undefined"
      ? parseDeepLink(window.location.hash).mode
      : undefined,
  );
  const fallbackMode = urlMode ?? initialMode ?? "architect";
  const mode = useNav((l) => l.mode) ?? fallbackMode;
  const updateNav = useNavUpdate();
  useDeepLinks(deepLinking, initialMode ?? "architect");

  const [visited, setVisited] = useState<ReadonlySet<CrystalMode>>(() => new Set([fallbackMode]));
  useEffect(() => {
    setVisited((v) => (v.has(mode) ? v : new Set(v).add(mode)));
  }, [mode]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  const { terminalsStore, workspacesStore } = useCrystal();
  const connection = useConnectionState();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const saving = useWorkspace((s) => Object.keys(s.pendingSaves).length > 0);
  const wsError = useWorkspace((s) => s.error);
  const runningRuns = useAgents((s) => s.runs.filter((r) => r.status === "running").length);
  const runningJobs = useAgents(
    (s) =>
      s.runs.filter(
        (r) => r.status === "running" && (r.purpose === "index" || r.purpose === "survey"),
      ).length,
  );
  const attention = useFleetAttention(activeWsId);

  function switchMode(next: CrystalMode): void {
    updateNav({ mode: next });
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
      } else if ((e.ctrlKey || e.metaKey) && ["1", "2", "3", "4", "5"].includes(e.key)) {
        e.preventDefault();
        switchMode(CRYSTAL_MODES[Number(e.key) - 1]!);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        setTerminalOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    // Cross-mode navigation: "open file" requests (e.g. from the code map)
    // switch to the editor, which handles the actual opening. The path is also
    // parked in sessionStorage for the case where the editor mounts lazily
    // after this event has already fired.
    const onOpenFile = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; line?: number }>).detail;
      if (typeof detail?.path === "string") {
        try {
          // JSON so an optional target line travels with the path.
          sessionStorage.setItem(
            "crystal.pendingOpenFile",
            JSON.stringify({ path: detail.path, line: detail.line ?? null }),
          );
        } catch {
          /* storage unavailable — the live listener still works */
        }
      }
      switchMode("code");
    };
    window.addEventListener("crystal:open-file", onOpenFile);
    // "Open a terminal in workspace X" requests (e.g. from a project card).
    const onOpenTerminal = (e: Event) => {
      const detail = (e as CustomEvent<{ ws?: string; kind?: "shell" | "agent" }>).detail;
      const ws = detail?.ws ?? workspacesStore.getState().activeId;
      if (!ws) return;
      setTerminalOpen(true);
      if (detail?.kind === "agent") terminalsStore.getState().openAgentConsole(ws);
      else void terminalsStore.getState().openShell(ws);
    };
    window.addEventListener("crystal:open-terminal", onOpenTerminal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crystal:open-file", onOpenFile);
      window.removeEventListener("crystal:open-terminal", onOpenTerminal);
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-surface-0 text-ink">
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-crystal-500 to-prism-500 shadow-lg shadow-crystal-500/30">
            <Gem className="h-4 w-4 text-white" />
          </div>
          <WorkspacePicker />
        </header>
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface-1 py-2.5">
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
                    {m === "projects" && (attention === "red" || attention === "yellow") ? (
                      <TrafficLightDot light={attention} className="absolute -right-0.5 -top-0.5" />
                    ) : null}
                    {m === "jobs" && runningJobs > 0 ? (
                      <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-0.5 text-[9px] font-bold text-surface-0">
                        {runningJobs}
                      </span>
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              {/* Keyed by workspace: switching remounts modes with fresh, correctly-scoped
                  state. The projects overview is cross-workspace, so it survives switches. */}
              {CRYSTAL_MODES.filter((m) => visited.has(m)).map((m) => {
                const ModeComponent = MODE_COMPONENTS[m];
                const key = m === "projects" ? m : `${m}:${activeWsId ?? ""}`;
                return (
                  <div key={key} className={cn("h-full", mode !== m && "hidden")}>
                    <ModeComponent />
                  </div>
                );
              })}
            </Suspense>
          </div>
        </div>

        {terminalOpen ? <TerminalPanel onClose={() => setTerminalOpen(false)} /> : null}

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
            <Tooltip content="Toggle the terminal panel" shortcut="Ctrl+`">
              <button
                type="button"
                aria-label="Toggle terminal panel"
                aria-pressed={terminalOpen}
                onClick={() => setTerminalOpen((open) => !open)}
                className={cn(
                  "flex items-center gap-1 rounded px-1 hover:bg-surface-3 hover:text-ink",
                  terminalOpen ? "text-ink" : "text-ink-muted",
                )}
              >
                <TerminalSquare className="h-3 w-3" /> terminal
              </button>
            </Tooltip>
            {saving ? <span className="text-info">saving…</span> : null}
            {wsError ? <span className="max-w-96 truncate text-danger">{wsError}</span> : null}
            <span className="ml-auto flex items-center gap-3">
              {runningRuns > 0 ? (
                <span className="text-info">
                  {runningRuns} agent{runningRuns > 1 ? "s" : ""} running
                </span>
              ) : null}
              {deepLinking ? <CopyLinkButton /> : null}
              <span>Crystal 0.1</span>
            </span>
          </footer>
        ) : null}

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onSwitchMode={switchMode} />
      </div>
    </TooltipProvider>
  );
}

/**
 * Worst traffic light across the *other* workspaces — the rail badge that says
 * "something elsewhere needs you". The active workspace is excluded: its run
 * results are auto-acknowledged while you're looking at it.
 */
function useFleetAttention(activeWsId: string | null): TrafficLight {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);
  return worstLight(
    workspaces
      .filter((w) => w.id !== activeWsId)
      .map((w) =>
        workspaceLight(
          todosByWs[w.id] ?? EMPTY_TODOS,
          runsByWs[w.id] ?? EMPTY_RUNS,
          seenAtByWs[w.id] ?? null,
        ),
      ),
  );
}

/** Copies the current deep link — the URL always encodes the active view. */
function CopyLinkButton() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip content="Copy a shareable link to this view">
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(window.location.href)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
        className={cn(
          "flex items-center gap-1 transition-colors",
          copied ? "text-ok" : "text-ink-faint hover:text-ink-muted",
        )}
      >
        {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
        {copied ? "copied" : "share"}
      </button>
    </Tooltip>
  );
}

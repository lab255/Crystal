import { Suspense, lazy, useEffect, useState } from "react";
import { Boxes, Check, Code2, Gem, KanbanSquare, Link2, type LucideIcon } from "lucide-react";
import { parseDeepLink } from "@crystal/core";
import {
  useAgents,
  useConnectionState,
  useNav,
  useNavUpdate,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { Spinner, StatusDot, Tooltip, TooltipProvider, cn } from "@crystal/ui";
import { CommandPalette } from "./CommandPalette.js";
import { useDeepLinks } from "./deeplinks.js";
import { CRYSTAL_MODES, MODE_LABELS, type CrystalMode } from "./modes.js";
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

const MODE_COMPONENTS: Record<CrystalMode, React.LazyExoticComponent<() => React.JSX.Element>> = {
  architect: ArchitectMode,
  orchestrate: OrchestratorMode,
  code: EditorMode,
};

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

  const connection = useConnectionState();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const saving = useWorkspace((s) => Object.keys(s.pendingSaves).length > 0);
  const wsError = useWorkspace((s) => s.error);
  const runningRuns = useAgents((s) => s.runs.filter((r) => r.status === "running").length);

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
      } else if ((e.ctrlKey || e.metaKey) && ["1", "2", "3"].includes(e.key)) {
        e.preventDefault();
        switchMode(CRYSTAL_MODES[Number(e.key) - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    // Cross-mode navigation: "open file" requests (e.g. from the code map)
    // switch to the editor, which handles the actual opening. The path is also
    // parked in sessionStorage for the case where the editor mounts lazily
    // after this event has already fired.
    const onOpenFile = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (typeof path === "string") {
        try {
          sessionStorage.setItem("crystal.pendingOpenFile", path);
        } catch {
          /* storage unavailable — the live listener still works */
        }
      }
      switchMode("code");
    };
    window.addEventListener("crystal:open-file", onOpenFile);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crystal:open-file", onOpenFile);
    };
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
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              {/* Keyed by workspace: switching remounts modes with fresh, correctly-scoped state. */}
              {CRYSTAL_MODES.filter((m) => visited.has(m)).map((m) => {
                const ModeComponent = MODE_COMPONENTS[m];
                return (
                  <div key={`${m}:${activeWsId ?? ""}`} className={cn("h-full", mode !== m && "hidden")}>
                    <ModeComponent />
                  </div>
                );
              })}
            </Suspense>
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
            <WorkspacePicker />
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

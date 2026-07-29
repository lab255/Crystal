import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { Check, DownloadCloud, FolderGit2, Gem, Link2, TerminalSquare } from "lucide-react";
import { parseDeepLink, workspaceLight, worstLight, type TrafficLight } from "@crystal/core";

import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  checkForDesktopUpdateNow,
  useAgents,
  useCrystal,
  useDesktopUpdate,
  useFleet,
  useFleetConnections,
  useHub,
  useNav,
  useNavUpdate,
  useTerminals,
  useWorkspace,
  useWorkspaces,
  wsKey,
  type ConnectionState,
} from "@crystal/client";
import { Spinner, StatusDot, Tooltip, TooltipProvider, TrafficLightDot, cn } from "@crystal/ui";
import { BranchSwitcher } from "./BranchSwitcher.js";
import { CommandPalette } from "./CommandPalette.js";
import { LensBar } from "./LensBar.js";
import { useDeepLinks } from "./deeplinks.js";
import {
  CRYSTAL_MODES,
  MODE_ICONS,
  MODE_LABELS,
  isCrossProjectMode,
  type CrystalMode,
} from "./modes.js";
import { GitPanel } from "./GitPanel.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { WorkspaceTabs } from "./WorkspaceTabs.js";

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
const SurfacesMode = lazy(() =>
  import("@crystal/surfaces").then((m) => ({ default: m.SurfacesMode })),
);
const QualityMode = lazy(() =>
  import("@crystal/quality").then((m) => ({ default: m.QualityMode })),
);
const HubMode = lazy(() => import("@crystal/hub").then((m) => ({ default: m.HubMode })));

const MODE_COMPONENTS: Record<CrystalMode, React.LazyExoticComponent<() => React.JSX.Element>> = {
  projects: OverviewMode,
  hub: HubMode,
  architect: ArchitectMode,
  surfaces: SurfacesMode,
  orchestrate: OrchestratorMode,
  code: EditorMode,
  quality: QualityMode,
  jobs: JobsMode,
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
  // Panel visibility lives in the terminals store so anything dispatching an
  // interactive agent session can reveal the panel (see focusTerminal).
  const terminalOpen = useTerminals((s) => s.panelOpen);
  const setTerminalOpen = useTerminals((s) => s.setPanelOpen);
  const [gitOpen, setGitOpen] = useState(false);

  const { terminalsStore, navStore, fleet, activeSid, selectWorkspace: focusWorkspace } =
    useCrystal();
  const connections = useFleetConnections();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const activeWsRoot = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.root ?? null,
  );
  const saving = useWorkspace((s) => Object.keys(s.pendingSaves).length > 0);
  const wsError = useWorkspace((s) => s.error);
  const runningRuns = useAgents((s) => s.runs.filter((r) => r.status === "running").length);
  const runningJobs = useAgents(
    (s) =>
      s.runs.filter(
        (r) => r.status === "running" && (r.purpose === "index" || r.purpose === "survey"),
      ).length,
  );
  const attention = useFleetAttention(activeSid, activeWsId);
  // Programs still in flight across every project — the Hub's rail badge.
  const liveProgramCount = useHub(
    (s) => s.programs.filter((p) => p.status === "running").length,
  );
  // Unanswered agent questions across the portfolio: they outrank the live
  // count on the rail — a stopped run waiting on a human is the thing to see
  // from any mode.
  const hubWaiting = useHub((s) =>
    Object.values(s.questions).reduce((n, qs) => n + qs.length, 0),
  );

  const switchMode = useCallback(
    (next: CrystalMode): void => {
      updateNav({ mode: next });
      onModeChange?.(next);
    },
    [updateNav, onModeChange],
  );

  // Last facet visited per (server, workspace): re-entering a workspace from
  // the Overview restores where you were in it.
  const lastFacet = useRef(new Map<string, CrystalMode>());
  useEffect(() => {
    if (!isCrossProjectMode(mode) && activeWsId) {
      lastFacet.current.set(wsKey(activeSid, activeWsId), mode);
    }
  }, [mode, activeSid, activeWsId]);

  const selectWorkspace = useCallback(
    (sid: string, id: string): void => {
      // Cross-server aware: focusing another connection's workspace also swaps
      // the active store bundle (the per-workspace modes re-key below).
      focusWorkspace(sid, id);
      // From the Overview, entering a workspace restores its last facet; from a
      // facet, the facet is preserved — flipping between two workspaces'
      // architectures is a single click per flip.
      const current = navStore.getState().link.mode;
      if (!current || isCrossProjectMode(current)) {
        switchMode(lastFacet.current.get(wsKey(sid, id)) ?? "architect");
      }
    },
    [focusWorkspace, navStore, switchMode],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGitOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && /^[1-9]$/.test(e.key)) {
        // Workspace tabs are the top level: Ctrl+Alt+n jumps to the nth
        // workspace, counted across every connected server in tab order.
        const all = fleet.store
          .getState()
          .connections.flatMap((c) => c.workspaces.map((w) => ({ sid: c.sid, id: w.id })));
        const ws = all[Number(e.key) - 1];
        if (ws) {
          e.preventDefault();
          selectWorkspace(ws.sid, ws.id);
        }
      } else if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        Number(e.key) >= 1 &&
        Number(e.key) <= CRYSTAL_MODES.length
      ) {
        e.preventDefault();
        switchMode(CRYSTAL_MODES[Number(e.key) - 1]!);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        terminalsStore.getState().setPanelOpen(!terminalsStore.getState().panelOpen);
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
    // `sid` targets a specific server; absent means the active connection.
    const onOpenTerminal = (e: Event) => {
      const detail = (e as CustomEvent<{ ws?: string; sid?: string; kind?: "shell" | "agent" }>)
        .detail;
      const sid = detail?.sid ?? fleet.activeSid;
      const ws = detail?.ws ?? fleet.connection(sid)?.activeWs;
      if (!ws) return;
      terminalsStore.getState().setPanelOpen(true);
      if (detail?.kind === "agent") terminalsStore.getState().openAgentConsole(ws, sid);
      else void terminalsStore.getState().openShell(ws, undefined, undefined, undefined, sid);
    };
    window.addEventListener("crystal:open-terminal", onOpenTerminal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("crystal:open-file", onOpenFile);
      window.removeEventListener("crystal:open-terminal", onOpenTerminal);
    };
  }, [switchMode, selectWorkspace, fleet, terminalsStore]);

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col bg-surface-0 text-ink">
        {/* Top level: workspaces (plus the cross-workspace Overview and the opener). */}
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-surface-1 px-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-crystal-500 to-prism-500 shadow-lg shadow-crystal-500/30">
            <Gem className="h-4 w-4 text-white" />
          </div>
          <WorkspaceTabs
            mode={mode}
            attention={attention}
            onHome={() => switchMode("projects")}
            onSelectWorkspace={selectWorkspace}
          />
          <BranchSwitcher />
          <LensBar onOpenTerminal={() => setTerminalOpen(true)} />
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Mode rail: one icon per mode, Overview first. Badges surface work
              happening elsewhere (running agents/jobs, cross-project attention). */}
          <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface-1 py-2.5">
            {CRYSTAL_MODES.map((m, i) => {
              const Icon = MODE_ICONS[m];
              const badge =
                m === "orchestrate"
                  ? runningRuns
                  : m === "jobs"
                    ? runningJobs
                    : m === "hub"
                      ? hubWaiting || liveProgramCount
                      : 0;
              const badgeWarns = m === "hub" && hubWaiting > 0;
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
                    {badge > 0 ? (
                      <span
                        className={cn(
                          "absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-bold text-surface-0",
                          badgeWarns ? "bg-warn" : "bg-info",
                        )}
                      >
                        {badge}
                      </span>
                    ) : null}
                    {m === "projects" && (attention === "red" || attention === "yellow") ? (
                      <TrafficLightDot light={attention} className="absolute -right-0.5 -top-0.5" />
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}

            {/* Bottom rail: panel toggles, kept apart from the mode list —
                these overlay/augment the current mode rather than replace it. */}
            <div className="mt-auto flex flex-col items-center gap-1 border-t border-edge pt-1.5">
              <Tooltip content="Git tree & log" shortcut="Ctrl+Shift+G" side="right">
                <button
                  type="button"
                  onClick={() => setGitOpen((o) => !o)}
                  aria-label="Toggle git panel"
                  aria-pressed={gitOpen}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                    gitOpen
                      ? "bg-crystal-500/20 text-crystal-300"
                      : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
                  )}
                >
                  <FolderGit2 className="h-4.5 w-4.5" />
                </button>
              </Tooltip>
              <Tooltip content="Toggle the terminal panel" shortcut="Ctrl+`" side="right">
                <button
                  type="button"
                  onClick={() => setTerminalOpen(!terminalOpen)}
                  aria-label="Toggle terminal panel"
                  aria-pressed={terminalOpen}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                    terminalOpen
                      ? "bg-crystal-500/20 text-crystal-300"
                      : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
                  )}
                >
                  <TerminalSquare className="h-4.5 w-4.5" />
                </button>
              </Tooltip>
            </div>
          </nav>

          {gitOpen ? <GitPanel onClose={() => setGitOpen(false)} /> : null}

          <div className="min-w-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              {/* Keyed by (server, workspace): switching remounts modes with fresh,
                  correctly-scoped state — the sid matters because two servers can host
                  the same repo path and then share a wsId. Cross-project modes
                  (Overview, Hub) span workspaces, so they survive switches. */}
              {CRYSTAL_MODES.filter((m) => visited.has(m)).map((m) => {
                const ModeComponent = MODE_COMPONENTS[m];
                const key = isCrossProjectMode(m) ? m : `${m}:${activeSid}:${activeWsId ?? ""}`;
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
            <BridgeStatus connections={connections} />
            {saving ? <span className="text-info">saving…</span> : null}
            {wsError ? <span className="max-w-96 truncate text-danger">{wsError}</span> : null}
            {activeWsRoot ? (
              <span className="min-w-0 truncate" title={activeWsRoot}>
                {activeWsRoot}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-3">
              {runningRuns > 0 ? (
                <span className="text-info">
                  {runningRuns} agent{runningRuns > 1 ? "s" : ""} running
                </span>
              ) : null}
              {deepLinking ? <CopyLinkButton /> : null}
              <VersionBadge />
            </span>
          </footer>
        ) : null}

        {/* The palette lists the ACTIVE connection's workspaces (fleet v1). */}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onSwitchMode={switchMode}
          onSelectWorkspace={(id) => selectWorkspace(activeSid, id)}
        />
      </div>
    </TooltipProvider>
  );
}

/**
 * Worst traffic light across every *other* (server, workspace) in the fleet —
 * the rail badge that says "something elsewhere needs you". The active pair is
 * excluded: its run results are auto-acknowledged while you're looking at it.
 */
function useFleetAttention(activeSid: string, activeWsId: string | null): TrafficLight {
  const connections = useFleetConnections();
  const runsByWs = useFleet((s) => s.runsByWs);
  const todosByWs = useFleet((s) => s.todosByWs);
  const seenAtByWs = useFleet((s) => s.seenAtByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  return worstLight(
    connections.flatMap((c) =>
      c.workspaces
        .filter((w) => !(c.sid === activeSid && w.id === activeWsId))
        .map((w) => {
          const key = wsKey(c.sid, w.id);
          return workspaceLight(
            todosByWs[key] ?? EMPTY_TODOS,
            runsByWs[key] ?? EMPTY_RUNS,
            seenAtByWs[key] ?? null,
            questionsByWs[key] ?? 0,
          );
        }),
    ),
  );
}

/**
 * Footer bridge indicator across every connection: the worst state wins the
 * dot, the tooltip lists each server. A dead *added* connection shows as
 * degraded here (and on its tabs) but never blocks the default server.
 */
function BridgeStatus({
  connections,
}: {
  connections: ReturnType<typeof useFleetConnections>;
}) {
  const rank: Record<ConnectionState, number> = { open: 0, connecting: 1, closed: 2 };
  const worst = connections.reduce<ConnectionState>(
    (acc, c) => (rank[c.state] > rank[acc] ? c.state : acc),
    "open",
  );
  const label =
    connections.length <= 1
      ? worst === "open"
        ? "bridge"
        : worst
      : `${connections.filter((c) => c.state === "open").length}/${connections.length} bridges`;
  return (
    <Tooltip
      content={
        connections.length <= 1
          ? "Bridge connection"
          : connections.map((c) => `${c.label}: ${c.state}`).join(" · ")
      }
    >
      <span className="flex items-center gap-1.5">
        <StatusDot
          status={worst === "open" ? "completed" : worst === "connecting" ? "running" : "failed"}
        />
        {label}
      </span>
    </Tooltip>
  );
}

/**
 * The footer version — sourced from the build (`__CRYSTAL_VERSION__`, baked in
 * by Vite from the root package.json), never a hand-maintained literal. In the
 * desktop shell it doubles as the "check for updates" action and surfaces the
 * updater's progress; in the browser it's plain text.
 */
function VersionBadge() {
  const supported = useDesktopUpdate((s) => s.supported);
  const phase = useDesktopUpdate((s) => s.phase);
  const pending = useDesktopUpdate((s) => s.version);
  const updateError = useDesktopUpdate((s) => s.error);
  const version =
    typeof __CRYSTAL_VERSION__ === "string" && __CRYSTAL_VERSION__ ? __CRYSTAL_VERSION__ : "dev";
  if (!supported) return <span>Crystal {version}</span>;

  const label =
    phase === "checking"
      ? "checking…"
      : phase === "downloading"
        ? `downloading ${pending ?? "update"}…`
        : phase === "restarting"
          ? "restarting…"
          : phase === "uptodate"
            ? `Crystal ${version} · up to date`
            : `Crystal ${version}`;
  const busy = phase === "checking" || phase === "downloading" || phase === "restarting";
  return (
    <Tooltip
      content={
        phase === "error" && updateError
          ? `Update check failed: ${updateError} — click to retry`
          : "Check for updates"
      }
    >
      <button
        type="button"
        onClick={() => void checkForDesktopUpdateNow()}
        disabled={busy}
        className={cn(
          "flex items-center gap-1 transition-colors",
          phase === "error" ? "text-warn" : "text-ink-faint hover:text-ink-muted",
          busy && "cursor-default",
        )}
      >
        {busy ? <Spinner className="h-3 w-3" /> : <DownloadCloud className="h-3 w-3" />}
        {label}
      </button>
    </Tooltip>
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

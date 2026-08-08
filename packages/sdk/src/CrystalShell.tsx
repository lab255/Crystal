import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  DownloadCloud,
  Gem,
  Inbox,
  Link2,
  Plus,
  Search,
} from "lucide-react";
import {
  countOpenQuestions,
  countUnrecoveredFailures,
  parseDeepLink,
  workspaceLight,
  worstLight,
  type ProjectEntry,
  type TrafficLight,
} from "@crystal/core";

import {
  EMPTY_RUNS,
  EMPTY_TODOS,
  checkForDesktopUpdateNow,
  initTheme,
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
import { Kbd, Spinner, StatusDot, Tooltip, TooltipProvider, cn } from "@crystal/ui";
import { BranchSwitcher } from "./BranchSwitcher.js";
import { CommandPalette } from "./CommandPalette.js";
import { LensBar } from "./LensBar.js";
import { useDeepLinks } from "./deeplinks.js";
import {
  CRYSTAL_MODES,
  MODE_LABELS,
  isCrossProjectMode,
  type CrystalMode,
} from "./modes.js";
import { GitPanel } from "./GitPanel.js";
import { NeedsYouPill } from "./NeedsYouPill.js";
import { ProjectNav } from "./ProjectNav.js";
import { ProjectMenu, ProjectSwitcher } from "./ProjectSwitcher.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { TabStrip } from "./TabStrip.js";
import { tabsStore } from "./tabs.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { WorkspaceRail } from "./WorkspaceRail.js";

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
const MODE_COMPONENTS: Record<CrystalMode, React.LazyExoticComponent<() => React.JSX.Element>> = {
  projects: OverviewMode,
  architect: ArchitectMode,
  surfaces: SurfacesMode,
  orchestrate: OrchestratorMode,
  code: EditorMode,
  quality: QualityMode,
  jobs: JobsMode,
};


const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Panel visibility lives in the terminals store so anything dispatching an
  // interactive agent session can reveal the panel (see focusTerminal).
  const terminalOpen = useTerminals((s) => s.panelOpen);
  const setTerminalOpen = useTerminals((s) => s.setPanelOpen);
  const [gitOpen, setGitOpen] = useState(false);

  // Theme preference lands on <html> before anything paints twice.
  useEffect(() => initTheme(), []);

  // The shell is an app, not a document: suppress page-level zoom (ctrl/pinch
  // wheel and WebKit gesture magnification) at the document. Canvas zoom
  // (react-flow, Monaco) attaches its own handlers and is unaffected —
  // preventDefault only cancels the browser's whole-page scale. Page scroll
  // is locked in CSS (html/body overflow hidden, see ui/styles.css).
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    document.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("gesturestart", onGesture);
    document.addEventListener("gesturechange", onGesture);
    document.addEventListener("gestureend", onGesture);
    return () => {
      document.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("gesturechange", onGesture);
      document.removeEventListener("gestureend", onGesture);
    };
  }, []);

  const { terminalsStore, navStore, fleet, activeSid, selectWorkspace: focusWorkspace } =
    useCrystal();

  // Every nav change is snapshotted into the active shell tab, so switching
  // back to a tab restores exactly where it was.
  useEffect(() => {
    tabsStore.getState().syncActive(navStore.getState().link);
    return navStore.subscribe(() => tabsStore.getState().syncActive(navStore.getState().link));
  }, [navStore]);
  const connections = useFleetConnections();
  const activeWsId = useWorkspaces((s) => s.activeId);
  const activeWsRoot = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.root ?? null,
  );
  const activeWsName = useWorkspaces(
    (s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? null,
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
  // Unanswered agent questions across the portfolio — the navbar inbox badge
  // and the Overview rail badge: a stopped run waiting on a human is the
  // thing to see from any mode.
  const hubWaiting = useHub((s) =>
    Object.values(s.questions).reduce((n, qs) => n + qs.length, 0),
  );
  const overviewView = useNav((l) => l.projects?.view);
  // Count-only selectors (primitives): the shell must not re-render on every
  // stream event that replaces the runs array — only when a count changes.
  const needsYouCount =
    useAgents((s) => countUnrecoveredFailures(s.runs)) +
    useWorkspace((s) => countOpenQuestions(s.info?.projects ?? EMPTY_PROJECT_ENTRIES));

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
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "l") {
        // Copy a shareable link to the current view (the header button shows
        // the feedback). Browsers reserve Cmd+L for the address bar; in the
        // desktop shell it's ours.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("crystal:copy-link"));
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "[" || e.key === "]")) {
        // In-app history — mirrors the header back/forward buttons.
        e.preventDefault();
        if (e.key === "[") history.back();
        else history.forward();
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
          // JSON so an optional target line travels with the path. The ws stamp
          // lets a lazily-mounting editor drop a request parked before a
          // workspace switch instead of reading it against the wrong root.
          sessionStorage.setItem(
            "crystal.pendingOpenFile",
            JSON.stringify({
              path: detail.path,
              line: detail.line ?? null,
              ws: fleet.connection(fleet.activeSid)?.activeWs ?? null,
            }),
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
      {/* overflow-hidden: the shell owns the viewport — a too-tall child (e.g.
          the nav rail with the terminal panel dragged high) must clip inside
          its row, never grow the document and scroll the page. */}
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-0 text-ink">
        {/* Top navbar, three lanes: context on the left (history ▸ project ▸
            switcher ▸ branch), search dead-center, global constructs on the
            right (needs-you, inbox, copy link, lens). */}
        <header className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_minmax(10rem,26rem)_minmax(0,1fr)] items-center gap-2 border-b border-edge bg-surface-1 px-2.5">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <div className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-crystal-500 to-prism-500 shadow-lg shadow-crystal-500/30">
              <Gem className="h-4 w-4 text-white" />
            </div>
            {deepLinking ? (
              <>
                <Tooltip content="Back" shortcut="Ctrl+[">
                  <button
                    type="button"
                    aria-label="Back"
                    onClick={() => history.back()}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="Forward" shortcut="Ctrl+]">
                  <button
                    type="button"
                    aria-label="Forward"
                    onClick={() => history.forward()}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="New tab">
                  <button
                    type="button"
                    aria-label="New tab"
                    onClick={() => {
                      tabsStore.getState().activate(tabsStore.getState().open({ mode: "projects" }).id);
                      navStore.getState().apply({ mode: "projects" });
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </>
            ) : null}
            {isCrossProjectMode(mode) || !activeWsName ? (
              <span className="ml-0.5 min-w-0 truncate text-xs font-medium text-ink">
                {isCrossProjectMode(mode) ? MODE_LABELS[mode] : "No workspace"}
              </span>
            ) : (
              <>
                <ProjectMenu onOpenSettings={() => setSettingsOpen(true)} />
                <ProjectSwitcher onSelectWorkspace={selectWorkspace} />
                <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
                <BranchSwitcher />
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search and commands"
            className="flex h-6.5 w-full min-w-0 items-center gap-2 rounded-md border border-edge bg-surface-0 px-2 text-xs text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-muted"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">Search or jump to…</span>
            <Kbd>Ctrl+K</Kbd>
          </button>

          <div className="flex min-w-0 items-center justify-end gap-1.5">
          {/* Fleet-wide "needs you" (also hosts the attention notifier). */}
          <NeedsYouPill />
          <Tooltip content="Inbox — agent questions across every project">
            <button
              type="button"
              onClick={() => updateNav({ mode: "projects", projects: { view: "inbox" } })}
              aria-label="Open the questions inbox"
              className={cn(
                "relative flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md transition-colors",
                mode === "projects" && overviewView === "inbox"
                  ? "bg-crystal-500/20 text-crystal-300"
                  : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
              )}
            >
              <Inbox className="h-4 w-4" />
              {hubWaiting > 0 ? (
                <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warn px-0.5 text-[9px] font-bold text-surface-0">
                  {hubWaiting}
                </span>
              ) : null}
            </button>
          </Tooltip>
          {deepLinking ? <CopyLinkButton /> : null}
          <LensBar onOpenTerminal={() => setTerminalOpen(true)} />
          </div>
        </header>

        <TabStrip />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Level 1: the workspace rail (Slack-style). Level 2: the project
              menu — sections per facet, only when a workspace is entered. */}
          <WorkspaceRail
            mode={mode}
            attention={attention}
            waitingBadge={hubWaiting}
            gitOpen={gitOpen}
            terminalOpen={terminalOpen}
            onHome={() => switchMode("projects")}
            onToggleGit={() => setGitOpen((o) => !o)}
            onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
            onSelectWorkspace={selectWorkspace}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {!isCrossProjectMode(mode) ? (
            <ProjectNav
              mode={mode}
              runningRuns={runningRuns}
              needsYouCount={needsYouCount}
              runningJobs={runningJobs}
              onSwitchMode={switchMode}
            />
          ) : null}

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
              <VersionBadge />
            </span>
          </footer>
        ) : null}

        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

        {/* The palette lists the ACTIVE connection's workspaces (fleet v1). */}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onSwitchMode={switchMode}
          onSelectWorkspace={(id) => selectWorkspace(activeSid, id)}
          onOpenSettings={() => setSettingsOpen(true)}
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
            questionsByWs[key]?.length ?? 0,
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

/**
 * Copies the current deep link — the URL always encodes the active view.
 * Ctrl/Cmd+L triggers the same copy via the `crystal:copy-link` event (the
 * shell's keydown dispatches it), so the feedback lands on this button.
 */
function CopyLinkButton() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    const onCopy = () => {
      navigator.clipboard
        .writeText(window.location.href)
        .then(() => setCopied(true))
        .catch(() => {});
    };
    window.addEventListener("crystal:copy-link", onCopy);
    return () => window.removeEventListener("crystal:copy-link", onCopy);
  }, []);
  return (
    <Tooltip content="Copy a shareable link to this view" shortcut="Ctrl+L">
      <button
        type="button"
        aria-label="Copy link to this view"
        onClick={() => window.dispatchEvent(new CustomEvent("crystal:copy-link"))}
        className={cn(
          "flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md transition-colors",
          copied ? "text-ok" : "text-ink-faint hover:bg-surface-3 hover:text-ink-muted",
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
      </button>
    </Tooltip>
  );
}

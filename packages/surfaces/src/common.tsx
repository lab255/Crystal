import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalLink, Globe, MonitorPlay, MonitorX, RefreshCw, Webhook } from "lucide-react";
import { endpointKey, formatHighlightSel, storybookStorySlug } from "@crystal/core";
import type {
  ApiTrace,
  ApiTraceCall,
  ComponentSurface,
  DevServerInfo,
  DevServerKind,
  LensMatcher,
  SurfaceMapReport,
  SurfacesReport,
  SystemModule,
  SystemOverview,
} from "@crystal/core";
import { requestOpenFile, useCrystal, useLens, useNavUpdate, useWorkspaces } from "@crystal/client";
import { Spinner, Tooltip, cn } from "@crystal/ui";
import { makeSystemAttributor } from "./system-attribution.js";

const EMPTY_SYSTEMS: SystemModule[] = [];

/* ------------------------------------------------------------------ */
/* Data: surfaces report + systems overview, refreshed on code changes */
/* ------------------------------------------------------------------ */

export interface SurfacesData {
  report: SurfacesReport | null;
  /** The logical systems overview — powers the architecture side pane and file→system attribution. */
  overview: SystemOverview | null;
  /**
   * Screen→endpoint reachability for the system map (`surfaces.map`). Null
   * until it resolves — or when the method fails; the map renders systems
   * and screens without call edges then.
   */
  map: SurfaceMapReport | null;
  /** file → owning system, longest part-path prefix wins (null outside any system). */
  systemOfFile: (file: string) => SystemModule | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const SurfacesCtx = createContext<SurfacesData | null>(null);

export function SurfacesProvider({ children }: { children: React.ReactNode }) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [report, setReport] = useState<SurfacesReport | null>(null);
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [map, setMap] = useState<SurfaceMapReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([client.request("surfaces.get", {}), client.request("codemap.overview", {})])
      .then(([res, ov]) => {
        if (cancelled) return;
        setReport(res);
        setOverview(ov);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, activeWs, generation]);

  // The map join rides the same generation, but failures stay non-fatal: the
  // system map must render systems/screens without call edges until the
  // server grows `surfaces.map` (or when a trace errors out).
  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    client
      .request("surfaces.map", {})
      .then((res) => {
        if (!cancelled) setMap(res);
      })
      .catch(() => {
        if (!cancelled) setMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, activeWs, generation]);

  // Workspace switch drops the previous workspace's data outright — screen
  // ids and workspace-relative files collide across workspaces, so a stale
  // report (or the slow `surfaces.map` join) rendered against the new
  // workspace's screens would show another codebase's traffic as this one's.
  useEffect(() => {
    setReport(null);
    setOverview(null);
    setMap(null);
    setError(null);
    setLoading(true);
  }, [activeWs]);

  useEffect(() => {
    const bump = ({ ws }: { ws: string }) => {
      if (ws === activeWs) setGeneration((g) => g + 1);
    };
    const d1 = client.events.on("codemap.changed", bump);
    const d2 = client.events.on("codeindex.changed", bump);
    return () => {
      d1();
      d2();
    };
  }, [client, activeWs]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  // One attribution rule for the whole mode — the map's edge targeting uses
  // the same helper, so the canvas and the panes can't disagree on ownership.
  const systemOfFile = useMemo(
    () => makeSystemAttributor(overview?.systems ?? EMPTY_SYSTEMS),
    [overview],
  );

  return (
    <SurfacesCtx.Provider
      value={{ report, overview, map, systemOfFile, loading, error, refresh }}
    >
      {children}
    </SurfacesCtx.Provider>
  );
}

export function useSurfaces(): SurfacesData {
  const ctx = useContext(SurfacesCtx);
  if (!ctx) throw new Error("useSurfaces outside SurfacesProvider");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Architecture side pane semantics (flamegraph convention):           */
/*   single click  → highlight the node in the embedded systems pane   */
/*   double click  → navigate (full architecture view / the editor)    */
/* ------------------------------------------------------------------ */

export interface ArchHighlight {
  /** Open the pane and select a system in it. */
  system: (systemId: string) => void;
  /** Open the pane and select a boundary edge ("source->target"). */
  edge: (edgeId: string) => void;
  /**
   * Open the pane focused on a served route's `ep:` node — the surface→API
   * relation as a real edge on the canvas, not side-pane prose. The key is
   * `endpointKey` ("METHOD /path"); the pane keeps the endpoints layer on.
   */
  endpoint: (epKey: string) => void;
  /** Highlight the system owning a file; falls back to opening the file when unattributed. */
  file: (file: string, line?: number) => void;
  /**
   * Highlight one symbol: selects the owning system AND pins the highlight
   * (`architect.sel`), so the systems view marks the exact component/export —
   * the surfaces→architecture side of the bidirectional link.
   */
  symbol: (file: string, symbol: string, line?: number) => void;
  /** Leave surfaces for the full architecture view, pane selection intact. */
  expand: () => void;
}

/**
 * Live dev-server URLs for embedding/curling, by kind. A *running* server's
 * observed URL always beats the report's static script guess (root-only and
 * port-blind, historically wrong on every monorepo) — the guess is only the
 * fallback so the affordances still render before anything is started.
 */
export interface DevUrlTarget {
  url: string;
  availability: "live" | "expected";
}

/** A URL is live only after a probe; unverified process and analyzer guesses stay expectations. */
export function classifyDevUrl(
  probedUrl: string | null,
  responding: boolean,
  guessedUrl: string | null,
): DevUrlTarget | null {
  if (probedUrl && responding) return { url: probedUrl, availability: "live" };
  const expected = probedUrl ?? guessedUrl;
  return expected ? { url: expected, availability: "expected" } : null;
}

async function probeDevUrl(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal });
    return true;
  } catch {
    return false;
  }
}

export interface DevServerControl {
  target: DevUrlTarget | null;
  candidate: DevServerInfo | null;
  busy: boolean;
  error: string | null;
  /** Start a stopped candidate, or restart one whose process is up but URL is dead. */
  launch: () => void;
}

export interface LiveDevUrls {
  app: DevServerControl;
  storybook: DevServerControl;
  /** URL fallback retained for non-preview consumers such as curl defaults. */
  appUrl: string | null;
  storybookUrl: string | null;
}

/** Storybook's canvas URL for one CSF story. */
export function storybookStoryUrl(base: string, title: string, name: string): string {
  return `${base.replace(/\/$/, "")}/iframe.html?id=${storybookStorySlug(title, name)}&viewMode=story`;
}

export interface ComponentGroup {
  id: string;
  name: string;
  components: ComponentSurface[];
}

/** Group components by their attributed system, with the unattributed group always last. */
export function groupComponentsBySystem(
  components: readonly ComponentSurface[],
  systemOfFile: (file: string) => SystemModule | null,
): ComponentGroup[] {
  const grouped = new Map<string, ComponentGroup>();
  for (const component of components) {
    const system = systemOfFile(component.file);
    const id = system?.id ?? "__other__";
    const group = grouped.get(id) ?? { id, name: system?.name ?? "Other", components: [] };
    group.components.push(component);
    grouped.set(id, group);
  }
  for (const group of grouped.values()) group.components.sort((a, b) => b.usedBy - a.usedBy);
  return [...grouped.values()].sort((a, b) => {
    if (a.id === "__other__") return 1;
    if (b.id === "__other__") return -1;
    return b.components.length - a.components.length || a.name.localeCompare(b.name);
  });
}

/** Shared responding/stopped dev-server preview, optionally with an editable URL. */
export function DevServerPreview({
  control,
  url,
  title,
  hint,
  noUrlHint,
  open = true,
  onOpenChange,
  manualUrl = false,
  kind = "app",
}: {
  control: DevServerControl;
  url: string | null;
  title: string;
  hint: React.ReactNode;
  noUrlHint?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  manualUrl?: boolean;
  kind?: "app" | "storybook";
}) {
  const live = control.target?.availability === "live";
  const expected = control.target?.url ?? null;
  const [frameUrl, setFrameUrl] = useState(url ?? "");
  const [frameNonce, setFrameNonce] = useState(0);
  const [frameFailed, setFrameFailed] = useState(false);
  useEffect(() => setFrameUrl(url ?? ""), [url]);
  useEffect(() => setFrameFailed(false), [url, frameNonce]);
  const storybook = kind === "storybook";
  const label = storybook ? "Storybook" : "dev server";

  if (!url && live) {
    return <div className="text-[11px] text-ink-faint">{noUrlHint}</div>;
  }

  if (!live || !url) {
    return (
      <div className="space-y-2 text-[11px] text-ink-faint">
        <div>
          {expected ? (
            <>
              {storybook ? "Storybook" : "The app"} is expected at{" "}
              <code className="text-ink-muted">{expected}</code>, but it is not responding. Use{" "}
              <span className="text-ink-muted">Dev servers</span> in the workspace rail to inspect
              its output.
            </>
          ) : (
            <>
              No responding {storybook ? "Storybook" : "app"} server was found. Open{" "}
              <span className="text-ink-muted">Dev servers</span> in the workspace rail to start or
              configure one.
            </>
          )}
        </div>
        {control.candidate ? (
          <button
            type="button"
            disabled={control.busy}
            onClick={control.launch}
            className="flex items-center gap-1.5 rounded-lg border border-ok/40 bg-ok/10 px-2.5 py-1.5 text-[11px] font-medium text-ok hover:brightness-110 disabled:opacity-50"
          >
            {control.busy ? <Spinner className="h-3.5 w-3.5" /> : <MonitorPlay className="h-3.5 w-3.5" />}
            {control.candidate.status === "running" ? `Restart ${label}` : `Start ${label}`}
          </button>
        ) : null}
        {control.error ? <div className="text-danger">{control.error}</div> : null}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange?.(true)}
        className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-muted hover:text-ink"
      >
        <MonitorPlay className="h-3.5 w-3.5 text-ok" /> {hint}
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            setFrameFailed(false);
            setFrameNonce((nonce) => nonce + 1);
          }}
          className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
        >
          <RefreshCw className="h-3 w-3" /> reload
        </button>
      </div>
      {manualUrl ? (
        <div className="flex items-center gap-1.5">
          <input
            value={frameUrl}
            onChange={(event) => setFrameUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setFrameNonce((nonce) => nonce + 1);
            }}
            spellCheck={false}
            aria-label="Preview URL"
            className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-1 px-2 py-1 font-mono text-[10.5px] text-ink outline-none focus:border-crystal-500/60"
          />
          <Tooltip content="Open in browser">
            <button
              type="button"
              onClick={() => window.open(frameUrl, "_blank", "noopener")}
              className="rounded-md border border-edge bg-surface-2 p-1 text-ink-muted hover:text-ink"
              aria-label="Open in browser"
            >
              <Globe className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      ) : null}
      {typeof hint !== "string" ? hint : null}
      {frameFailed ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.05] px-4 text-center text-[11px] text-ink-muted">
          <MonitorX className="h-5 w-5 text-warn" />
          {storybook ? "Storybook" : "The preview"} did not load. Check the Dev servers launcher
          for errors, then reload.
        </div>
      ) : (
        <iframe
          key={frameNonce}
          src={manualUrl ? frameUrl : url}
          title={title}
          onError={() => setFrameFailed(true)}
          className="h-[28rem] w-full rounded-lg border border-edge bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      )}
    </div>
  );
}

export function useLiveDevUrls(): LiveDevUrls {
  const { client } = useCrystal();
  const { report } = useSurfaces();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [servers, setServers] = useState<DevServerInfo[]>([]);
  const [respondingUrls, setRespondingUrls] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [launchError, setLaunchError] = useState<string | null>(null);
  const refreshId = useRef(0);
  const workspaceEpoch = useRef(0);

  const refresh = useCallback(() => {
    const id = ++refreshId.current;
    client
      .request("devservers.list", {})
      .then(({ servers: next }) => {
        if (id === refreshId.current) setServers(next);
      })
      .catch(() => {
        if (id === refreshId.current) setServers([]);
      });
  }, [client]);

  useEffect(() => {
    workspaceEpoch.current++;
    refreshId.current++;
    setServers([]);
    setRespondingUrls(new Set());
    setBusy(new Set());
    setLaunchError(null);
    if (!activeWs) return;
    refresh();
    const dispose = client.events.on("devservers.changed", ({ ws }) => {
      if (ws === activeWs) refresh();
    });
    return dispose;
  }, [client, activeWs, refresh]);

  const candidateFor = useCallback(
    (kind: DevServerKind) =>
      servers.find((server) => server.kind === kind && server.status === "running") ??
      servers.find((server) => server.kind === kind) ??
      null,
    [servers],
  );
  const appCandidate = candidateFor("app");
  const storybookCandidate = candidateFor("storybook");
  const appExpectedUrl =
    (appCandidate?.status === "running" ? appCandidate.url : null) ??
    appCandidate?.urlGuess ??
    report?.demo.appUrl ??
    null;
  const storybookExpectedUrl =
    (storybookCandidate?.status === "running" ? storybookCandidate.url : null) ??
    storybookCandidate?.urlGuess ??
    report?.demo.storybookUrl ??
    null;
  const probeUrls = useMemo(
    () => [...new Set([appExpectedUrl, storybookExpectedUrl].filter((url): url is string => !!url))],
    [appExpectedUrl, storybookExpectedUrl],
  );
  const probeKey = probeUrls.join("\n");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    setRespondingUrls(new Set());
    const probeAll = async () => {
      const results = await Promise.all(
        probeUrls.map(async (url) => ({ url, responding: await probeDevUrl(url, controller.signal) })),
      );
      if (controller.signal.aborted) return;
      setRespondingUrls(
        new Set(results.filter((result) => result.responding).map((result) => result.url)),
      );
      if (results.some((result) => !result.responding)) {
        timer = setTimeout(() => void probeAll(), 5_000);
      }
    };
    if (probeUrls.length > 0) void probeAll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // The joined value keeps identical server snapshots from restarting probes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey]);

  const appTarget = classifyDevUrl(
    appExpectedUrl,
    appExpectedUrl ? respondingUrls.has(appExpectedUrl) : false,
    appExpectedUrl,
  );
  const storybookTarget = classifyDevUrl(
    storybookExpectedUrl,
    storybookExpectedUrl ? respondingUrls.has(storybookExpectedUrl) : false,
    storybookExpectedUrl,
  );

  const launch = useCallback(
    (candidate: DevServerInfo | null) => {
      if (!candidate) return;
      const startedInWorkspace = workspaceEpoch.current;
      setBusy((current) => new Set(current).add(candidate.id));
      setLaunchError(null);
      const request =
        candidate.status === "running"
          ? client.request("devservers.restart", { id: candidate.id })
          : client.request("devservers.start", { id: candidate.id });
      void request
        .catch((error: unknown) => {
          if (startedInWorkspace === workspaceEpoch.current) {
            setLaunchError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (startedInWorkspace !== workspaceEpoch.current) return;
          setBusy((current) => {
            const next = new Set(current);
            next.delete(candidate.id);
            return next;
          });
          refresh();
        });
    },
    [client, refresh],
  );

  return {
    app: {
      target: appTarget,
      candidate: appCandidate,
      busy: appCandidate ? busy.has(appCandidate.id) : false,
      error: launchError,
      launch: () => launch(appCandidate),
    },
    storybook: {
      target: storybookTarget,
      candidate: storybookCandidate,
      busy: storybookCandidate ? busy.has(storybookCandidate.id) : false,
      error: launchError,
      launch: () => launch(storybookCandidate),
    },
    appUrl: appTarget?.url ?? null,
    storybookUrl: storybookTarget?.url ?? null,
  };
}

export function useArchHighlight(): ArchHighlight {
  const nav = useNavUpdate();
  const { systemOfFile } = useSurfaces();
  return useMemo(
    () => ({
      system: (systemId) =>
        nav({
          surfaces: { arch: true },
          architect: { view: "architecture", system: systemId, edge: null },
        }),
      edge: (edgeId) =>
        nav({
          surfaces: { arch: true },
          architect: { view: "architecture", edge: edgeId, system: null },
        }),
      endpoint: (epKey) =>
        nav({
          surfaces: { arch: true },
          architect: { view: "architecture", system: `ep:${epKey}`, edge: null },
        }),
      file: (file, line) => {
        const sys = systemOfFile(file);
        if (sys)
          nav({
            surfaces: { arch: true },
            architect: { view: "architecture", system: sys.id, edge: null },
          });
        else requestOpenFile(file, line);
      },
      symbol: (file, symbol, line) => {
        const sys = systemOfFile(file);
        if (!sys) {
          requestOpenFile(file, line);
          return;
        }
        const sel = formatHighlightSel({ file, symbol, label: symbol });
        nav({
          surfaces: { arch: true },
          architect: { view: "architecture", system: sys.id, edge: null, ...(sel ? { sel } : {}) },
        });
      },
      // Selection (system/edge) lives in the architect section and merges, so
      // the full view opens exactly where the pane was pointing.
      expand: () => nav({ mode: "architect", architect: { view: "architecture" } }),
    }),
    [nav, systemOfFile],
  );
}

/* ------------------------------------------------------------------ */
/* Global lens — dim non-members, same treatment as find-dimming       */
/* ------------------------------------------------------------------ */

/**
 * The global lens as the surfaces views consume it. `active` means a lens is
 * set and resolved to a non-empty member set — dim non-members. `empty` means
 * it resolved to nothing (clean worktree, dangling facet) — render undimmed
 * but say so, instead of dimming everything to oblivion.
 */
export interface SurfacesLens {
  active: boolean;
  empty: boolean;
  matcher: LensMatcher;
}

export function useSurfacesLens(): SurfacesLens {
  const spec = useLens((s) => s.spec);
  const status = useLens((s) => s.status);
  const matcher = useLens((s) => s.matcher);
  const ready = spec != null && status === "ready";
  return useMemo(
    () => ({ active: ready && !matcher.empty, empty: ready && matcher.empty, matcher }),
    [ready, matcher],
  );
}

/** The dimming applied to lens non-members — same opacity the map's find-dimming uses. */
export const LENS_DIM_CLASS = "opacity-25";

/** "lens: 12 of 87" (or "lens matches nothing here") next to a list header. */
export function LensHint({
  lens,
  matched,
  total,
}: {
  lens: SurfacesLens;
  matched: number;
  total: number;
}) {
  if (lens.empty) {
    return <span className="text-[10px] text-warn">lens matches nothing here</span>;
  }
  if (!lens.active) return null;
  return (
    <Tooltip content="The global lens — non-members dim">
      <span className="text-[10px] text-crystal-300">
        lens: {matched} of {total}
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits and pieces                                              */
/* ------------------------------------------------------------------ */

/** Mono file:line hyperlink into the editor. */
export function FileLink({
  file,
  line,
  className,
}: {
  file: string;
  line?: number;
  className?: string;
}) {
  return (
    <Tooltip content="Open in the editor">
      <button
        type="button"
        onClick={() => requestOpenFile(file, line)}
        className={cn(
          "flex min-w-0 items-center gap-1 font-mono text-[10px] text-ink-faint hover:text-ink",
          className,
        )}
      >
        <span className="min-w-0 truncate">
          {file}
          {line != null ? `:${line}` : ""}
        </span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </button>
    </Tooltip>
  );
}

/** Detail-pane section: uppercase title, optional hint tooltip and actions. */
export function DetailSection({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-edge/60 px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {title}
        </h3>
        {hint ? (
          <Tooltip content={hint}>
            <span className="min-w-0 truncate text-[10px] text-ink-faint/80">{hint}</span>
          </Tooltip>
        ) : null}
        <span className="ml-auto">{actions}</span>
      </div>
      {children}
    </section>
  );
}

/** List-pane header: icon, uppercase title, shown/total counter, extras. */
export function ListHeader({
  icon: Icon,
  title,
  shown,
  total,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  shown: number;
  total: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </span>
      <span className="text-[10px] text-ink-faint">
        {shown === total ? total : `${shown}/${total}`}
      </span>
      {children}
    </div>
  );
}

/** Collapsible group header inside a list pane. */
export function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  icon,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left"
    >
      <span
        className={cn(
          "text-[8px] text-ink-faint transition-transform",
          collapsed ? "" : "rotate-90",
        )}
      >
        ▶
      </span>
      {icon}
      <span className="min-w-0 truncate text-[11px] font-semibold text-ink">{label}</span>
      <span className="text-[9px] text-ink-faint">{count}</span>
    </button>
  );
}

/** Copy text with a "copied" flash on the trigger's tooltip. */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * The frontend→backend chain of one component/hook: every HTTP call its call
 * graph reaches (`codemap.apiTrace`), matched to the endpoint serving it.
 * Click a row to highlight the boundary in the architecture pane; the webhook
 * link continues into the API explorer (handler definition, trace, callers).
 * Renders nothing when the component makes no API calls.
 */
export function ApiCallsSection({ file, symbol }: { file: string; symbol?: string }) {
  const { client } = useCrystal();
  const { systemOfFile } = useSurfaces();
  const arch = useArchHighlight();
  const nav = useNavUpdate();
  const [trace, setTrace] = useState<ApiTrace | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    setFailed(false);
    client
      .request("codemap.apiTrace", { file, symbol })
      .then((t) => !cancelled && setTrace(t))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [client, file, symbol]);

  // Most components never talk to the network — stay out of the way then.
  if (failed || (trace != null && trace.calls.length === 0)) return null;

  const highlight = (call: ApiTraceCall) => {
    // A matched route focuses its ep: node — the exact surface→API edge on
    // the pane's canvas — rather than degrading to the system boundary.
    if (call.endpoint) arch.endpoint(endpointKey(call.endpoint));
    else arch.file(call.file, call.line);
  };

  return (
    <DetailSection
      title={`API calls · ${trace ? trace.calls.length : "…"}`}
      hint="HTTP calls reachable from here, matched to the endpoints serving them"
    >
      {trace == null ? (
        <div className="text-[11px] text-ink-faint">Tracing the call graph…</div>
      ) : (
        <div className="space-y-0.5">
          {trace.calls.map((call, i) => {
            const targetSystem = call.endpoint ? systemOfFile(call.endpoint.file) : null;
            return (
              <div
                key={`${call.file}:${call.line ?? 0}:${i}`}
                role="button"
                tabIndex={0}
                onClick={() => highlight(call)}
                onDoubleClick={() => requestOpenFile(call.file, call.line ?? undefined)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") highlight(call);
                }}
                title="Click: highlight the boundary in the architecture pane · double-click: open the call site"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                  {call.method}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[10px] text-ink" title={call.path}>
                    {call.path}
                  </span>
                  <span className="block truncate text-[9px] text-ink-faint">
                    {call.via && call.via.depth > 0 ? `via ${call.via.symbol}() · ` : ""}
                    {call.endpoint
                      ? `→ ${call.endpoint.handler ?? call.endpoint.file}${targetSystem ? ` · ${targetSystem.name}` : ""}`
                      : "no matching endpoint in this workspace"}
                  </span>
                </span>
                {call.endpoint ? (
                  <Tooltip content="Open in the API explorer — handler, trace and callers">
                    <button
                      type="button"
                      aria-label={`Open ${call.endpoint.method} ${call.endpoint.path} in the API explorer`}
                      onClick={(e) => {
                        e.stopPropagation();
                        nav({
                          surfaces: {
                            view: "apis",
                            api: `${call.endpoint!.method} ${call.endpoint!.path}`,
                          },
                        });
                      }}
                      className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                    >
                      <Webhook className="h-3 w-3" />
                    </button>
                  </Tooltip>
                ) : null}
                <Tooltip content="Open the call site in the editor">
                  <button
                    type="button"
                    aria-label={`Open ${call.file} in the editor`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestOpenFile(call.file, call.line ?? undefined);
                    }}
                    className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            );
          })}
          {trace.truncated ? (
            <div className="px-1.5 pt-1 text-[10px] text-ink-faint">
              Call graph capped — deeper calls may exist.
            </div>
          ) : null}
        </div>
      )}
    </DetailSection>
  );
}

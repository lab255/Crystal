import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ExternalLink, Webhook } from "lucide-react";
import { formatHighlightSel } from "@crystal/core";
import type {
  ApiTrace,
  ApiTraceCall,
  SurfacesReport,
  SystemModule,
  SystemOverview,
} from "@crystal/core";
import { requestOpenFile, useCrystal, useNavUpdate, useWorkspaces } from "@crystal/client";
import { Tooltip, cn } from "@crystal/ui";

/* ------------------------------------------------------------------ */
/* Data: surfaces report + systems overview, refreshed on code changes */
/* ------------------------------------------------------------------ */

export interface SurfacesData {
  report: SurfacesReport | null;
  /** The logical systems overview — powers the architecture side pane and file→system attribution. */
  overview: SystemOverview | null;
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

  const systemOfFile = useMemo(() => {
    const parts: { path: string; system: SystemModule }[] = [];
    for (const s of overview?.systems ?? [])
      for (const p of s.parts) parts.push({ path: p.path, system: s });
    parts.sort((a, b) => b.path.length - a.path.length);
    return (file: string): SystemModule | null =>
      parts.find((p) => file === p.path || file.startsWith(`${p.path}/`))?.system ?? null;
  }, [overview]);

  return (
    <SurfacesCtx.Provider
      value={{ report, overview, systemOfFile, loading, error, refresh }}
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

export function useArchHighlight(): ArchHighlight {
  const nav = useNavUpdate();
  const { systemOfFile } = useSurfaces();
  return useMemo(
    () => ({
      system: (systemId) =>
        nav({
          surfaces: { arch: true },
          architect: { view: "systems", system: systemId, edge: null },
        }),
      edge: (edgeId) =>
        nav({
          surfaces: { arch: true },
          architect: { view: "systems", edge: edgeId, system: null },
        }),
      file: (file, line) => {
        const sys = systemOfFile(file);
        if (sys)
          nav({
            surfaces: { arch: true },
            architect: { view: "systems", system: sys.id, edge: null },
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
          architect: { view: "systems", system: sys.id, edge: null, ...(sel ? { sel } : {}) },
        });
      },
      // Selection (system/edge) lives in the architect section and merges, so
      // the full view opens exactly where the pane was pointing.
      expand: () => nav({ mode: "architect", architect: { view: "systems" } }),
    }),
    [nav, systemOfFile],
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
    const src = systemOfFile(file);
    const tgt = call.endpoint ? systemOfFile(call.endpoint.file) : null;
    if (src && tgt && src.id !== tgt.id) arch.edge(`${src.id}->${tgt.id}`);
    else if (tgt) arch.system(tgt.id);
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

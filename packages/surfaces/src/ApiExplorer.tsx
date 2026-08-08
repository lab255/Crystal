import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe2,
  ListFilter,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Webhook,
  X,
} from "lucide-react";
import {
  createApiRequestDef,
  endpointKey,
  type ApiEnvConfig,
  type ApiRequestDef,
  type EndpointValidation,
  type SystemEndpoint,
  type SystemModule,
  type SystemOverview,
} from "@crystal/core";
import {
  requestOpenFile,
  useCrystal,
  useNav,
  useNavUpdate,
  useSymbolMenu,
  useWorkspaces,
} from "@crystal/client";
import {
  EmptyState,
  Pane as SplitPane,
  Select,
  Split,
  Spinner,
  Tooltip,
  cn,
  useContextMenu,
} from "@crystal/ui";
import { ROLE_META } from "@crystal/architect";
import {
  DetailSection,
  LENS_DIM_CLASS,
  LensHint,
  copyText,
  useArchHighlight,
  useSurfaces,
  useSurfacesLens,
} from "./common.js";
import { TraceSection, endpointHandlerCandidates, useEndpointTrace } from "./trace.js";
import { EnvConfigPanel, RequestEditor, useApiClient } from "./ApiRequestWorkbench.js";

/**
 * API explorer — every served route in the workspace, one selection away from
 * everything known about it:
 *
 *   definition — the enclosing symbol's source (signature included);
 *   trace      — the static call graph from the handler as an interactive
 *                flamegraph / call profile (runtime `.crystal/traces` overlay);
 *   callers    — every call site addressing the route, attributed to the
 *                calling systems, plus the boundary contracts it rides.
 *
 * Lives in the surfaces mode (`#/surfaces/apis?api=GET /x&system=…`); the
 * architecture view's context menus jump here, and old `#/architect/apis`
 * links redirect.
 */

const METHOD_CLASS: Record<string, string> = {
  GET: "bg-accent-emerald/15 text-accent-emerald",
  POST: "bg-accent-cyan/15 text-accent-cyan",
  PUT: "bg-accent-amber/15 text-accent-amber",
  PATCH: "bg-accent-violet/15 text-accent-violet",
  DELETE: "bg-accent-rose/15 text-accent-rose",
  ALL: "bg-surface-3 text-ink-muted",
};

export function MethodChip({ method, className }: { method: string; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 font-mono text-[9px] font-semibold uppercase",
        METHOD_CLASS[method] ?? METHOD_CLASS.ALL,
        className,
      )}
    >
      {method}
    </span>
  );
}

const apiKeyOf = endpointKey;
const EMPTY_REQUESTS: ApiRequestDef[] = [];

/** Kind badge palette for validation chips — semantic accents only. */
const VALIDATION_KIND_CLASS: Record<EndpointValidation["kind"], string> = {
  zod: "bg-accent-emerald/15 text-accent-emerald",
  joi: "bg-accent-amber/15 text-accent-amber",
  celebrate: "bg-accent-violet/15 text-accent-violet",
  "express-validator": "bg-accent-cyan/15 text-accent-cyan",
  middleware: "bg-surface-3 text-ink-muted",
};

/** Distinct validation kinds in chain order — the list row's tooltip. */
function validationKindsOf(validation: readonly EndpointValidation[]): string {
  return [...new Set(validation.map((v) => v.kind))].join(", ");
}

/** `curl -X POST 'http://localhost:3000/api/x'` for the copy menu. */
function curlOf(ep: { method: string; path: string }, baseUrl: string | null): string {
  const base = baseUrl ?? "http://localhost:3000";
  const method = ep.method === "ALL" ? "GET" : ep.method;
  return `curl -X ${method} '${base}${ep.path}'`;
}

interface EndpointRow {
  system: SystemModule;
  ep: SystemEndpoint;
  key: string;
}

export function ApiExplorer({ appUrl }: { appUrl: string | null }) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const nav = useNavUpdate();
  const arch = useArchHighlight();
  const selectedKey = useNav((l) => l.surfaces?.api ?? null);
  const selectedRequestId = useNav((l) => l.surfaces?.request ?? null);
  const systemFilter = useNav((l) => l.surfaces?.system ?? null);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useContextMenu();
  const symbolMenu = useSymbolMenu();
  const lens = useSurfacesLens();
  const apiClient = useApiClient();

  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [envPanelOpen, setEnvPanelOpen] = useState(false);
  const [savedCollapsed, setSavedCollapsed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    client
      .request("codemap.overview", {})
      .then((res) => {
        if (!cancelled) setOverview(res);
      })
      .catch(() => {})
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

  const rows = useMemo<EndpointRow[]>(() => {
    const out: EndpointRow[] = [];
    for (const system of overview?.systems ?? []) {
      for (const ep of system.endpoints) out.push({ system, ep, key: apiKeyOf(ep) });
    }
    return out;
  }, [overview]);
  const activeSystemFilter = rows.some((row) => row.system.id === systemFilter)
    ? systemFilter
    : null;

  /** Lens members (null when no lens dims) — non-member rows render dimmed. */
  const lensMembers = useMemo(
    () => (lens.active ? new Set(rows.filter((r) => lens.matcher.file(r.ep.file))) : null),
    [lens, rows],
  );

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (activeSystemFilter && r.system.id !== activeSystemFilter) return false;
      if (!find) return true;
      return (
        r.key.toLowerCase().includes(find) ||
        r.ep.file.toLowerCase().includes(find) ||
        r.system.name.toLowerCase().includes(find)
      );
    });
  }, [activeSystemFilter, rows, find]);

  /** Grouped for the list: serving system → its routes. */
  const groups = useMemo(() => {
    const bySystem = new Map<string, EndpointRow[]>();
    for (const r of visible) {
      const list = bySystem.get(r.system.id) ?? [];
      list.push(r);
      bySystem.set(r.system.id, list);
    }
    return [...bySystem.values()].sort(
      (a, b) => b.length - a.length || a[0]!.system.name.localeCompare(b[0]!.system.name),
    );
  }, [visible]);

  const savedRequests = apiClient.state?.requests ?? EMPTY_REQUESTS;
  const visibleRequests = useMemo(
    () =>
      savedRequests.filter(
        (request) =>
          !find ||
          request.name.toLowerCase().includes(find) ||
          request.method.toLowerCase().includes(find) ||
          request.url.toLowerCase().includes(find),
      ),
    [find, savedRequests],
  );
  const selectedRequest =
    savedRequests.find((request) => request.id === selectedRequestId) ?? null;

  // The system disambiguates when two systems serve the same method+path.
  const selected = selectedRequest
    ? null
    : (rows.find(
        (r) =>
          r.key === selectedKey &&
          (!activeSystemFilter || r.system.id === activeSystemFilter),
      ) ??
      rows.find((r) => r.key === selectedKey) ??
      null);

  const filterName = activeSystemFilter
    ? (overview?.systems.find((s) => s.id === activeSystemFilter)?.name ?? activeSystemFilter)
    : null;

  const requestCfg = useMemo<ApiEnvConfig>(
    () =>
      apiClient.activeCfg.baseUrl || !appUrl
        ? apiClient.activeCfg
        : { ...apiClient.activeCfg, baseUrl: appUrl },
    [apiClient.activeCfg, appUrl],
  );

  const addSavedRequest = (over: Partial<ApiRequestDef> = {}) => {
    const request = apiClient.addRequest(over);
    if (request) nav({ surfaces: { request: request.id, api: null } });
  };

  const openHandler = async (ep: SystemEndpoint): Promise<void> => {
    try {
      const detail = await client.request("codemap.file", { path: ep.file });
      for (const candidate of endpointHandlerCandidates(ep, detail)) {
        try {
          const source = await client.request("codemap.symbolSource", candidate);
          requestOpenFile(source.file, source.startLine);
          return;
        } catch {
          // A syntactic handler reference may not resolve to a top-level symbol.
        }
      }
    } catch {
      // The registration remains a useful fallback when code indexing is unavailable.
    }
    requestOpenFile(ep.file, ep.line);
  };

  if ((loading && !overview) || !apiClient.state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const rowMenu = (r: EndpointRow): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: r.key },
    {
      type: "item",
      label: "Highlight serving system",
      icon: Boxes,
      hint: r.system.name,
      onSelect: () => arch.system(r.system.id),
    },
    {
      type: "item",
      label: "Open in architecture view",
      icon: Boxes,
      onSelect: () =>
        nav({ mode: "architect", architect: { view: "architecture", system: r.system.id } }),
    },
    {
      type: "item",
      label: activeSystemFilter === r.system.id ? "Clear system filter" : "Filter to this system",
      icon: ListFilter,
      onSelect: () =>
        nav({ surfaces: { system: activeSystemFilter === r.system.id ? null : r.system.id } }),
    },
    {
      type: "item",
      label: "Open registration",
      icon: ExternalLink,
      hint: r.ep.line != null ? `${r.ep.file}:${r.ep.line}` : r.ep.file,
      onSelect: () => requestOpenFile(r.ep.file, r.ep.line),
    },
    // The shared block describes the handler symbol, so its editor action
    // resolves that declaration instead of opening the route registration.
    ...symbolMenu(
      {
        file: r.ep.file,
        line: r.ep.line,
        symbol: r.ep.handler,
        label: r.key,
      },
      { openFile: () => void openHandler(r.ep) },
    ),
    {
      type: "item",
      label: "Copy route",
      icon: Copy,
      hint: r.key,
      onSelect: () => copyText(r.key),
    },
    {
      type: "item",
      label: "Copy as curl",
      icon: TerminalSquare,
      onSelect: () => copyText(curlOf(r.ep, requestCfg.baseUrl ?? appUrl)),
    },
  ];

  const savedSectionCollapsed = savedCollapsed ?? savedRequests.length === 0;

  return (
    <Split storageKey="surfaces:apis" direction="horizontal">
      <SplitPane defaultSize={320} minSize={240} maxSize={520}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <div className="flex items-center gap-2 px-3 py-2">
            <Webhook className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              API surface
            </span>
            <span className="text-[10px] text-ink-faint">
              {visible.length}/{rows.length}
            </span>
            <LensHint lens={lens} matched={lensMembers?.size ?? 0} total={rows.length} />
            {filterName ? (
              <span className="ml-auto flex min-w-0 items-center gap-1 rounded-lg border border-edge bg-surface-2 px-1.5 py-0.5">
                <ListFilter className="h-3 w-3 shrink-0 text-accent-cyan" />
                <span className="min-w-0 truncate text-[10px] text-ink">{filterName}</span>
                <button
                  type="button"
                  onClick={() => nav({ surfaces: { system: null } })}
                  aria-label="Clear system filter"
                >
                  <X className="h-3 w-3 text-ink-faint hover:text-ink" />
                </button>
              </span>
            ) : (
              <span className="ml-auto" />
            )}
            <Tooltip content="Environment base URL and variables">
              <button
                type="button"
                onClick={() => setEnvPanelOpen((open) => !open)}
                aria-label="Configure API environments"
                aria-pressed={envPanelOpen}
                className={cn(
                  "rounded p-1",
                  envPanelOpen
                    ? "bg-crystal-500/20 text-crystal-300"
                    : "text-ink-faint hover:bg-surface-3 hover:text-ink",
                )}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="New saved request">
              <button
                type="button"
                onClick={() => addSavedRequest()}
                disabled={!apiClient.state}
                aria-label="New saved request"
                className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 border-y border-edge px-2 py-1.5">
            <Globe2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            {apiClient.environments.length > 0 ? (
              <Select
                size="sm"
                value={apiClient.activeEnvId ?? ""}
                onChange={(e) => apiClient.setActiveEnvId(e.target.value || null)}
                options={apiClient.environments.map((env) => ({ value: env.id, label: env.name }))}
                aria-label="Active API environment"
                className="min-w-0 max-w-32"
              />
            ) : (
              <span className="text-[10px] text-ink-faint">No environments</span>
            )}
            <span
              className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-ink-faint"
              title={requestCfg.baseUrl ?? undefined}
            >
              {requestCfg.baseUrl ?? "no base URL"}
            </span>
          </div>
          {envPanelOpen && apiClient.activeEnvId ? (
            <EnvConfigPanel cfg={apiClient.activeCfg} onChange={apiClient.setActiveCfg} />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <div className="mb-1.5 border-b border-edge/60 pb-1.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSavedCollapsed(!savedSectionCollapsed)}
                  aria-expanded={!savedSectionCollapsed}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left"
                >
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 shrink-0 text-ink-faint transition-transform",
                      savedSectionCollapsed && "-rotate-90",
                    )}
                  />
                  <Send className="h-3 w-3 shrink-0 text-accent-violet" />
                  <span className="min-w-0 truncate text-[11px] font-semibold text-ink">
                    Saved requests
                  </span>
                  <span className="text-[9px] text-ink-faint">{savedRequests.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => addSavedRequest()}
                  disabled={!apiClient.state}
                  aria-label="New saved request"
                  className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              {!savedSectionCollapsed
                ? visibleRequests.map((request) => (
                    <button
                      key={request.id}
                      type="button"
                      onClick={() =>
                        nav({ surfaces: { request: request.id, api: null } })
                      }
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                        selectedRequest?.id === request.id
                          ? "bg-crystal-500/15 text-ink"
                          : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <MethodChip method={request.method} />
                      <span className="min-w-0 flex-1 truncate text-[11px]">
                        {request.name}
                      </span>
                    </button>
                  ))
                : null}
            </div>
            {groups.map((group) => {
              const system = group[0]!.system;
              const meta = ROLE_META[system.role];
              const Icon = meta.icon;
              return (
                <div key={system.id} className="mb-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      nav({
                        surfaces: {
                          system: activeSystemFilter === system.id ? null : system.id,
                        },
                      })
                    }
                    className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left"
                    title="Filter to this system"
                  >
                    <Icon className="h-3 w-3 shrink-0" style={{ color: meta.accent }} />
                    <span className="min-w-0 truncate text-[11px] font-semibold text-ink">
                      {system.name}
                    </span>
                    <span className="text-[9px] text-ink-faint">{group.length}</span>
                  </button>
                  {group.map((r) => (
                    <button
                      key={`${r.system.id}|${r.key}|${r.ep.file}`}
                      type="button"
                      onClick={() =>
                        nav({
                          surfaces: { api: r.key, system: r.system.id, request: null },
                        })
                      }
                      onContextMenu={(e) => menu.open(e, rowMenu(r))}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                        selected === r
                          ? "bg-crystal-500/15 text-ink"
                          : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                        lensMembers && !lensMembers.has(r) && LENS_DIM_CLASS,
                      )}
                    >
                      <MethodChip method={r.ep.method} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                        {r.ep.path}
                      </span>
                      {r.ep.validation && r.ep.validation.length > 0 ? (
                        <Tooltip content={`Validated: ${validationKindsOf(r.ep.validation)}`}>
                          <ShieldCheck className="h-3 w-3 shrink-0 text-accent-emerald" />
                        </Tooltip>
                      ) : null}
                    </button>
                  ))}
                </div>
              );
            })}
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-ink-faint">
                {rows.length === 0
                  ? "No served routes detected — create a saved request to call any URL."
                  : "Nothing matches the current filter."}
              </div>
            ) : null}
          </div>
        </aside>
      </SplitPane>

      <SplitPane minSize="40%">
        {selectedRequest ? (
          <RequestEditor
            key={selectedRequest.id}
            request={selectedRequest}
            cfg={requestCfg}
            onChange={(patch) => apiClient.updateRequest(selectedRequest.id, patch)}
            onDelete={() => {
              apiClient.deleteRequest(selectedRequest.id);
              nav({ surfaces: { request: null } });
            }}
          />
        ) : selected && overview ? (
          <ApiDetail
            key={`${selected.system.id}|${selected.key}|${selected.ep.file}`}
            row={selected}
            overview={overview}
            appUrl={appUrl}
            cfg={requestCfg}
            onSaveRequest={(request) => {
              addSavedRequest({
                name: request.name,
                method: request.method,
                url: request.url,
                headers: request.headers,
                body: request.body,
              });
            }}
          />
        ) : (
          <EmptyState icon={Webhook} title="Pick a route or saved request">
            Inspect a detected endpoint and try it, or open a saved request against the active
            environment.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * What request validation this route actually enforces — the middleware chain
 * and in-handler schema parses the analyzer saw at the registration site.
 * One row per detected check; rows with a known line open the code there.
 * "None detected" is a result worth showing, not an omission.
 */
function ValidationSection({ ep }: { ep: SystemEndpoint }) {
  const validation = ep.validation ?? [];
  return (
    <DetailSection
      title={validation.length > 0 ? `Validation · ${validation.length}` : "Validation"}
      hint="what the registration enforces on the request"
    >
      {validation.length === 0 ? (
        <div className="text-[11px] text-ink-faint">
          No request validation detected at this route's registration.
        </div>
      ) : (
        <div className="space-y-0.5">
          {validation.map((v, i) => {
            const openable = v.line != null;
            const open = () => {
              if (openable) requestOpenFile(ep.file, v.line);
            };
            return (
              <div
                key={`${v.kind}:${v.label}:${i}`}
                role={openable ? "button" : undefined}
                tabIndex={openable ? 0 : undefined}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter") open();
                }}
                title={openable ? `Open ${ep.file}:${v.line} in the editor` : undefined}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
                  openable && "cursor-pointer hover:bg-surface-2",
                )}
              >
                <ShieldCheck className="h-3 w-3 shrink-0 text-accent-emerald" />
                <span
                  className={cn(
                    "shrink-0 rounded px-1 font-mono text-[9px] font-semibold",
                    VALIDATION_KIND_CLASS[v.kind],
                  )}
                >
                  {v.kind}
                </span>
                {v.target ? (
                  <span className="shrink-0 rounded bg-surface-3 px-1 text-[8.5px] uppercase text-ink-faint">
                    {v.target}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted">
                  {v.label}
                </span>
                {openable ? (
                  <ExternalLink className="h-3 w-3 shrink-0 text-ink-faint" />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </DetailSection>
  );
}

/* ------------------------------------------------------------------ */
/* Detail pane                                                         */
/* ------------------------------------------------------------------ */

const SNIPPET_COLLAPSED_LINES = 14;

function ApiDetail({
  row,
  overview,
  appUrl,
  cfg,
  onSaveRequest,
}: {
  row: EndpointRow;
  overview: SystemOverview;
  appUrl: string | null;
  cfg: ApiEnvConfig;
  onSaveRequest: (request: ApiRequestDef) => void;
}) {
  const { client } = useCrystal();
  const nav = useNavUpdate();
  const arch = useArchHighlight();
  const { systemOfFile } = useSurfaces();
  const { system, ep } = row;

  const [sites, setSites] = useState<
    { file: string; line?: number; method: string; path: string }[] | null
  >(null);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tryOpen, setTryOpen] = useState(false);
  const [tryRequest, setTryRequest] = useState<ApiRequestDef>(() =>
    createApiRequestDef({
      name: `${ep.method} ${ep.path}`,
      method: ep.method === "ALL" ? "GET" : ep.method,
      url: ep.path,
    }),
  );

  // Handler resolution + static call graph — shared with the system map's
  // endpoint inspector (trace.tsx).
  const traceState = useEndpointTrace(ep);
  const { fileDetail, resolved, source } = traceState;

  useEffect(() => {
    let cancelled = false;
    client
      .request("codemap.apiSites", { method: ep.method, path: ep.path })
      .then((r) => !cancelled && setSites(r.sites))
      .catch(() => !cancelled && setSites([]));
    return () => {
      cancelled = true;
    };
  }, [client, ep.method, ep.path]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  /** Caller systems, heaviest first — the chips above the raw site list. */
  const callerSystems = useMemo(() => {
    const counts = new Map<string, { system: SystemModule; count: number }>();
    for (const site of sites ?? []) {
      const sys = systemOfFile(site.file);
      if (!sys || sys.id === system.id) continue;
      const entry = counts.get(sys.id) ?? { system: sys, count: 0 };
      entry.count += 1;
      counts.set(sys.id, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [sites, systemOfFile, system.id]);

  /** Boundary contracts carrying this route (the systems-view edges). */
  const boundaries = useMemo(
    () =>
      overview.links.filter(
        (l) =>
          l.target === system.id &&
          (l.apis ?? []).some((a) => a.method === ep.method && a.path === ep.path),
      ),
    [overview, system.id, ep.method, ep.path],
  );
  const nameOf = (id: string) => overview.systems.find((s) => s.id === id)?.name ?? id;

  const snippetLines = source?.text.split("\n") ?? null;
  const snippetClipped =
    snippetLines != null && !snippetOpen && snippetLines.length > SNIPPET_COLLAPSED_LINES;
  const shownSnippet = snippetClipped
    ? snippetLines!.slice(0, SNIPPET_COLLAPSED_LINES).join("\n")
    : (source?.text ?? "");
  // Call signature: the declaration's first source line (params + return type).
  const signature = source?.text.split("\n")[0]?.trim() ?? null;

  const meta = ROLE_META[system.role];
  const SysIcon = meta.icon;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-surface-0">
      {/* header */}
      <div className="border-b border-edge bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <MethodChip method={ep.method} className="px-1.5 py-0.5 text-[11px]" />
          <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-semibold text-ink">
            {ep.path}
          </span>
          <Tooltip content={copied ? "Copied!" : "Copy as curl"}>
            <button
              type="button"
              onClick={() => {
                copyText(curlOf(ep, cfg.baseUrl ?? appUrl));
                setCopied(true);
              }}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 text-[10px]",
                copied ? "text-ok" : "text-ink-muted hover:text-ink",
              )}
            >
              <TerminalSquare className="h-3 w-3" /> curl
            </button>
          </Tooltip>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
          <Tooltip content="Click: highlight in the architecture pane · double-click: open the full view">
            <button
              type="button"
              onClick={() => arch.system(system.id)}
              onDoubleClick={() =>
                nav({ mode: "architect", architect: { view: "architecture", system: system.id } })
              }
              className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 hover:text-ink"
            >
              <SysIcon className="h-3 w-3" style={{ color: meta.accent }} />
              {system.name}
            </button>
          </Tooltip>
          <Tooltip content={`Open route registration at ${ep.file}${ep.line != null ? `:${ep.line}` : ""}`}>
            <button
              type="button"
              onClick={() => requestOpenFile(ep.file, ep.line)}
              className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-ink-faint hover:text-ink"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="shrink-0 font-sans">registration</span>
              <span className="min-w-0 truncate">
                {ep.file}
                {ep.line != null ? `:${ep.line}` : ""}
              </span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* definition */}
      <DetailSection
        title={resolved ? `Definition · ${resolved.symbol}` : "Definition"}
        hint={signature ?? undefined}
        actions={
          source ? (
            <Tooltip content={`Open handler at ${source.file}:${source.startLine}`}>
              <button
                type="button"
                onClick={() => requestOpenFile(source.file, source.startLine)}
                className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
              >
                <ExternalLink className="h-3 w-3" /> handler
              </button>
            </Tooltip>
          ) : undefined
        }
      >
        {source ? (
          <>
            <pre className="overflow-x-auto rounded-lg border border-edge bg-surface-1 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted">
              {shownSnippet}
              {snippetClipped ? "\n…" : ""}
            </pre>
            {snippetLines && snippetLines.length > SNIPPET_COLLAPSED_LINES ? (
              <button
                type="button"
                onClick={() => setSnippetOpen((o) => !o)}
                className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
                aria-expanded={snippetOpen}
              >
                <ChevronDown className={cn("h-3 w-3 transition-transform", snippetOpen && "rotate-180")} />
                {snippetOpen ? "Collapse" : `Show all ${snippetLines.length} lines`}
              </button>
            ) : null}
          </>
        ) : (
          <div className="text-[11px] text-ink-faint">
            {fileDetail ? "No enclosing symbol found for the registration." : "Loading…"}
          </div>
        )}
      </DetailSection>

      {/* validation — what the registration actually enforces on requests. */}
      <ValidationSection ep={ep} />

      <DetailSection
        title="Try it"
        hint={cfg.baseUrl ? `against ${cfg.baseUrl}` : "configure an environment base URL"}
        actions={
          <button
            type="button"
            onClick={() => setTryOpen((open) => !open)}
            aria-expanded={tryOpen}
            className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
          >
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", tryOpen && "rotate-180")}
            />
            {tryOpen ? "Collapse" : "Open runner"}
          </button>
        }
      >
        {tryOpen ? (
          <RequestEditor
            request={tryRequest}
            cfg={cfg}
            onChange={(patch) =>
              setTryRequest((request) => ({ ...request, ...patch }))
            }
            onSave={() => onSaveRequest(tryRequest)}
            embedded
          />
        ) : (
          <button
            type="button"
            onClick={() => setTryOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface-1 px-2.5 py-2 text-left text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <MethodChip method={tryRequest.method} />
            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
              {cfg.baseUrl ? `${cfg.baseUrl.replace(/\/$/, "")}${ep.path}` : ep.path}
            </span>
            <span className="text-[10px] text-crystal-300">Edit and send</span>
          </button>
        )}
      </DetailSection>

      {/* trace — single click highlights the owning system in the
          architecture pane; double click opens the code. */}
      <TraceSection state={traceState} />

      {/* callers */}
      <DetailSection
        title={`Callers · ${sites?.length ?? "…"}`}
        hint="every call site whose path addresses this route"
      >
        {callerSystems.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {callerSystems.map(({ system: sys, count }) => {
              const m = ROLE_META[sys.role];
              const Icon = m.icon;
              return (
                <Tooltip
                  key={sys.id}
                  content="Click: highlight in the architecture pane · double-click: open the full view"
                >
                  <button
                    type="button"
                    onClick={() => arch.system(sys.id)}
                    onDoubleClick={() =>
                      nav({ mode: "architect", architect: { view: "architecture", system: sys.id } })
                    }
                    className="flex items-center gap-1 rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-[10px] text-ink-muted hover:text-ink"
                  >
                    <Icon className="h-3 w-3" style={{ color: m.accent }} />
                    {sys.name}
                    <span className="text-ink-faint">×{count}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ) : null}
        {boundaries.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {boundaries.map((l) => (
              <Tooltip
                key={`${l.source}->${l.target}`}
                content="Click: highlight this integration in the architecture pane · double-click: open the full view"
              >
                <button
                  type="button"
                  onClick={() => arch.edge(`${l.source}->${l.target}`)}
                  onDoubleClick={() =>
                    nav({
                      mode: "architect",
                      architect: { view: "architecture", system: null, edge: `${l.source}->${l.target}` },
                    })
                  }
                  className="flex items-center gap-1 rounded-full border border-accent-amber/40 bg-accent-amber/10 px-2 py-0.5 text-[10px] text-accent-amber hover:brightness-110"
                >
                  {nameOf(l.source)} <ArrowRight className="h-3 w-3" /> {nameOf(l.target)}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
        {sites == null ? (
          <div className="text-[11px] text-ink-faint">Scanning call sites…</div>
        ) : sites.length === 0 ? (
          <div className="text-[11px] text-ink-faint">
            No calls found in this workspace — external clients (or the analyzer can't see the
            call path yet).
          </div>
        ) : (
          <div className="space-y-0.5">
            {sites.map((site, i) => (
              <div
                key={`${site.file}:${site.line ?? 0}:${i}`}
                role="button"
                tabIndex={0}
                onClick={() => arch.file(site.file, site.line)}
                onDoubleClick={() => requestOpenFile(site.file, site.line)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") arch.file(site.file, site.line);
                }}
                title="Click: highlight the calling system in the architecture pane · double-click: open the code"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <MethodChip method={site.method} />
                <span className="min-w-0 shrink-[2] truncate font-mono text-[10px] text-ink-muted">
                  {site.path}
                </span>
                <span className="ml-auto flex min-w-0 items-center gap-1 font-mono text-[9.5px] text-ink-faint">
                  <span className="min-w-0 truncate">
                    {site.file}
                    {site.line != null ? `:${site.line}` : ""}
                  </span>
                  {systemOfFile(site.file) ? (
                    <span className="rounded bg-surface-3 px-1 text-[8.5px] uppercase">
                      {systemOfFile(site.file)!.name}
                    </span>
                  ) : null}
                </span>
                <Tooltip content="View in code">
                  <button
                    type="button"
                    aria-label={`Open ${site.file} in the editor`}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestOpenFile(site.file, site.line);
                    }}
                    className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  );
}

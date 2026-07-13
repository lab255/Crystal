import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  Copy,
  ExternalLink,
  ListFilter,
  Maximize2,
  Minimize2,
  TerminalSquare,
  Webhook,
  X,
} from "lucide-react";
import {
  createArchitectureGraph,
  type CodeFileDetail,
  type CodeSymbolSource,
  type CodeTrace,
  type SystemEndpoint,
  type SystemModule,
  type SystemOverview,
} from "@crystal/core";
import { requestOpenFile, useCrystal, useNav, useNavUpdate, useWorkspaces } from "@crystal/client";
import { EmptyState, Pane as SplitPane, Split, Spinner, Tooltip, cn } from "@crystal/ui";
import { JourneyProfilePanel, ROLE_META } from "@crystal/architect";
import { DetailSection, copyText, useArchHighlight, useMenu, useSurfaces } from "./common.js";

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
 * architecture systems view's context menus jump here, and old
 * `#/architect/apis` links redirect.
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

const apiKeyOf = (ep: { method: string; path: string }): string => `${ep.method} ${ep.path}`;

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
  const systemFilter = useNav((l) => l.surfaces?.system ?? null);
  const find = (useNav((l) => l.surfaces?.find) ?? "").trim().toLowerCase();
  const menu = useMenu();

  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

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

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (systemFilter && r.system.id !== systemFilter) return false;
      if (!find) return true;
      return (
        r.key.toLowerCase().includes(find) ||
        r.ep.file.toLowerCase().includes(find) ||
        r.system.name.toLowerCase().includes(find)
      );
    });
  }, [rows, systemFilter, find]);

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

  // The system disambiguates when two systems serve the same method+path.
  const selected =
    rows.find((r) => r.key === selectedKey && (!systemFilter || r.system.id === systemFilter)) ??
    rows.find((r) => r.key === selectedKey) ??
    null;

  const filterName = systemFilter
    ? (overview?.systems.find((s) => s.id === systemFilter)?.name ?? systemFilter)
    : null;

  if (loading && !overview) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState icon={Webhook} title="No served routes detected">
        Routes appear when the analyzer sees registrations (`app.get("/x", h)`, `*Router.post`,
        Next route files…). API calls without a matching server in this workspace show up on the
        architecture systems view as external traffic instead.
      </EmptyState>
    );
  }

  const rowMenu = (r: EndpointRow): Parameters<typeof menu.open>[1] => [
    { type: "heading", label: r.key },
    {
      type: "item",
      label: "Open registration in editor",
      icon: ExternalLink,
      hint: `${r.ep.file.split("/").at(-1)}${r.ep.line != null ? `:${r.ep.line}` : ""}`,
      onSelect: () => requestOpenFile(r.ep.file, r.ep.line),
    },
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
        nav({ mode: "architect", architect: { view: "systems", system: r.system.id } }),
    },
    { type: "separator" },
    {
      type: "item",
      label: systemFilter === r.system.id ? "Clear system filter" : "Filter to this system",
      icon: ListFilter,
      onSelect: () =>
        nav({ surfaces: { system: systemFilter === r.system.id ? null : r.system.id } }),
    },
    { type: "separator" },
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
      onSelect: () => copyText(curlOf(r.ep, appUrl)),
    },
  ];

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
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {groups.map((group) => {
              const system = group[0]!.system;
              const meta = ROLE_META[system.role];
              const Icon = meta.icon;
              return (
                <div key={system.id} className="mb-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      nav({ surfaces: { system: systemFilter === system.id ? null : system.id } })
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
                      onClick={() => nav({ surfaces: { api: r.key, system: r.system.id } })}
                      onContextMenu={(e) => menu.open(e, rowMenu(r))}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left",
                        selected === r
                          ? "bg-crystal-500/15 text-ink"
                          : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <MethodChip method={r.ep.method} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                        {r.ep.path}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
            {visible.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-ink-faint">
                Nothing matches the current filter.
              </div>
            ) : null}
          </div>
        </aside>
      </SplitPane>

      <SplitPane minSize="40%">
        {selected && overview ? (
          <ApiDetail
            key={`${selected.system.id}|${selected.key}|${selected.ep.file}`}
            row={selected}
            overview={overview}
            appUrl={appUrl}
          />
        ) : (
          <EmptyState icon={Webhook} title="Pick a route">
            Definition, call signature, an interactive trace of everything it reaches, and every
            caller — one route at a time.
          </EmptyState>
        )}
      </SplitPane>
      {menu.element}
    </Split>
  );
}

/* ------------------------------------------------------------------ */
/* Detail pane                                                         */
/* ------------------------------------------------------------------ */

const EMPTY_GRAPH = createArchitectureGraph("API trace");
const SNIPPET_COLLAPSED_LINES = 14;

function ApiDetail({
  row,
  overview,
  appUrl,
}: {
  row: EndpointRow;
  overview: SystemOverview;
  appUrl: string | null;
}) {
  const { client } = useCrystal();
  const nav = useNavUpdate();
  const arch = useArchHighlight();
  const { systemOfFile } = useSurfaces();
  const { system, ep } = row;

  const [fileDetail, setFileDetail] = useState<CodeFileDetail | null>(null);
  const [source, setSource] = useState<CodeSymbolSource | null>(null);
  const [trace, setTrace] = useState<CodeTrace | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [sites, setSites] = useState<
    { file: string; line?: number; method: string; path: string }[] | null
  >(null);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [traceTall, setTraceTall] = useState(false);
  const [copied, setCopied] = useState(false);

  // The symbol the definition/trace anchor on — resolved, best first:
  //   1. the registration's handler reference ("Controller.createForm"),
  //      followed through the route file's imports to its declaring file;
  //   2. the top-level symbol enclosing the registration line;
  //   3. the file's first exported function-ish symbol (file-convention routes).
  const [resolved, setResolved] = useState<{ file: string; symbol: string } | null>(null);

  const candidates = useMemo(() => {
    if (!fileDetail) return [];
    const out: { file: string; symbol: string }[] = [];
    if (ep.handler) {
      const [root, prop] = ep.handler.split(".") as [string, string?];
      // Named import of the root wins; namespace imports are tried for the
      // property (`import * as C` … `C.handle` → handle in the resolved file).
      const named = fileDetail.imports.find((i) => i.resolved && i.names.includes(root));
      if (named?.resolved) {
        if (prop) out.push({ file: named.resolved, symbol: prop });
        out.push({ file: named.resolved, symbol: root });
      } else if (prop) {
        for (const i of fileDetail.imports) {
          if (i.resolved && i.names.some((n) => n === "*" || n === "default"))
            out.push({ file: i.resolved, symbol: prop });
        }
      }
      if (prop) out.push({ file: ep.file, symbol: prop });
      out.push({ file: ep.file, symbol: root });
    }
    const symbols = fileDetail.symbols;
    if (ep.line != null) {
      const enclosing = symbols.find((s) => ep.line! >= s.line && ep.line! <= (s.endLine ?? s.line));
      if (enclosing) out.push({ file: ep.file, symbol: enclosing.name });
      const above = symbols.filter((s) => s.line <= ep.line!);
      if (above.length > 0) out.push({ file: ep.file, symbol: above[above.length - 1]!.name });
    }
    const firstFn = symbols.find(
      (s) => s.exported && (s.kind === "function" || s.kind === "const" || s.kind === "component"),
    );
    if (firstFn) out.push({ file: ep.file, symbol: firstFn.name });
    const seen = new Set<string>();
    return out.filter((c) => {
      const key = `${c.file} ${c.symbol}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [fileDetail, ep.handler, ep.file, ep.line]);

  useEffect(() => {
    let cancelled = false;
    client
      .request("codemap.file", { path: ep.file })
      .then((d) => !cancelled && setFileDetail(d))
      .catch(() => {});
    client
      .request("codemap.apiSites", { method: ep.method, path: ep.path })
      .then((r) => !cancelled && setSites(r.sites))
      .catch(() => !cancelled && setSites([]));
    return () => {
      cancelled = true;
    };
  }, [client, ep.file, ep.method, ep.path]);

  useEffect(() => {
    if (candidates.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const c of candidates) {
        try {
          const t = await client.request("codemap.trace", { file: c.file, symbol: c.symbol });
          if (cancelled) return;
          setTrace(t);
          setResolved(c);
          setTraceError(null);
          client
            .request("codemap.symbolSource", { file: c.file, symbol: c.symbol })
            .then((s) => !cancelled && setSource(s))
            .catch(() => {});
          return;
        } catch {
          // Not a top-level symbol there — try the next candidate.
        }
      }
      if (!cancelled) {
        setTrace(null);
        setResolved(null);
        setTraceError("No traceable handler symbol found for this route.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, candidates]);

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
                copyText(curlOf(ep, appUrl));
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
                nav({ mode: "architect", architect: { view: "systems", system: system.id } })
              }
              className="flex items-center gap-1 rounded-md border border-edge bg-surface-2 px-1.5 py-0.5 hover:text-ink"
            >
              <SysIcon className="h-3 w-3" style={{ color: meta.accent }} />
              {system.name}
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => requestOpenFile(ep.file, ep.line)}
            className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-ink-faint hover:text-ink"
            title="Open in the editor"
          >
            <span className="min-w-0 truncate">
              {ep.file}
              {ep.line != null ? `:${ep.line}` : ""}
            </span>
            <ExternalLink className="h-3 w-3 shrink-0" />
          </button>
        </div>
      </div>

      {/* definition */}
      <DetailSection
        title={resolved ? `Definition · ${resolved.symbol}` : "Definition"}
        hint={signature ?? undefined}
        actions={
          source ? (
            <button
              type="button"
              onClick={() => requestOpenFile(source.file, source.startLine)}
              className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            >
              <ExternalLink className="h-3 w-3" /> open
            </button>
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

      {/* trace */}
      <DetailSection
        title={resolved ? `Trace · from ${resolved.symbol}` : "Trace"}
        hint="static call graph — drop runtime profiles in .crystal/traces/ to overlay"
        actions={
          trace ? (
            <button
              type="button"
              onClick={() => setTraceTall((t) => !t)}
              className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
              aria-expanded={traceTall}
            >
              {traceTall ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              {traceTall ? "shrink" : "expand"}
            </button>
          ) : undefined
        }
      >
        {trace ? (
          <div
            className={cn(
              "overflow-hidden rounded-lg border border-edge",
              traceTall ? "h-[36rem]" : "h-72",
            )}
          >
            {/* Flamegraph semantics: single click highlights the owning
                system in the architecture pane; double click opens the code. */}
            <JourneyProfilePanel
              trace={trace}
              graph={EMPTY_GRAPH}
              summary={null}
              onOpenStep={(step) => requestOpenFile(step.ref.file, step.line)}
              onSelectStep={(step) => arch.file(step.ref.file, step.line)}
            />
          </div>
        ) : traceError ? (
          <div className="text-[11px] text-danger">{traceError}</div>
        ) : (
          <div className="text-[11px] text-ink-faint">
            {candidates.length > 0 || !fileDetail
              ? "Tracing…"
              : "No handler symbol to trace from."}
          </div>
        )}
      </DetailSection>

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
                      nav({ mode: "architect", architect: { view: "systems", system: sys.id } })
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
                      architect: { view: "systems", system: null, edge: `${l.source}->${l.target}` },
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

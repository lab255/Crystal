import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Webhook,
  X,
} from "lucide-react";
import type {
  CodeSymbolSites,
  PartCrossing,
  PartCrossings,
  SymbolSite,
  SystemLink,
  SystemLinkSymbol,
  SystemModule,
} from "@crystal/core";
import { useCrystal, useNavUpdate } from "@crystal/client";
import { Button, CodeSnippet, Spinner, Tooltip, cn } from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";
import { ROLE_META } from "./role-meta.js";

/**
 * Contract inspector — the full split-pane opened by clicking a boundary edge
 * on the systems overview. Everything travelling the edge, inspectable in
 * place: each imported symbol expands into its declaration (the export site),
 * the import statements bringing it across, and the call sites invoking it —
 * all with source inline, each jumping into the editor. ←/→ walk every
 * visible boundary by traffic; ⇄ flips to the reverse edge when one exists.
 */

export const linkKeyOf = (l: Pick<SystemLink, "source" | "target">): string =>
  `${l.source}->${l.target}`;

interface Snippet {
  loading?: boolean;
  error?: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  truncated?: boolean;
}

/** Use-site lookup (import + call sites) state for one expanded symbol. */
interface SitesState {
  loading?: boolean;
  error?: string;
  data?: CodeSymbolSites;
}

/** Crossing lookup state for one expanded part pair ("Where it crosses"). */
interface CrossingState {
  loading?: boolean;
  error?: string;
  data?: PartCrossings;
}

export function ContractInspector({
  link,
  links,
  systems,
  nameOf,
  onSelectEdge,
  onSelectSystem,
  onClose,
}: {
  link: SystemLink;
  /** Visible boundaries, traffic-sorted — powers the prev/next navigation. */
  links: readonly SystemLink[];
  systems: readonly SystemModule[];
  nameOf: (id: string) => string;
  onSelectEdge: (key: string) => void;
  onSelectSystem: (id: string) => void;
  onClose: () => void;
}) {
  const { client } = useCrystal();
  const nav = useNavUpdate();
  const key = linkKeyOf(link);
  const apis = link.apis ?? [];
  const apiOnly = link.weight === 0 && apis.length > 0;

  const index = links.findIndex((l) => linkKeyOf(l) === key);
  const reverse = links.find((l) => l.source === link.target && l.target === link.source);
  const source = systems.find((s) => s.id === link.source) ?? null;
  const target = systems.find((s) => s.id === link.target) ?? null;

  // Details when the overview provides them; bare names as a fallback shape.
  const details = useMemo<SystemLinkSymbol[]>(
    () => link.details ?? link.symbols.map((name) => ({ name, kind: "const", count: 0 })),
    [link],
  );

  const [openSymbols, setOpenSymbols] = useState<ReadonlySet<string>>(() => new Set());
  const [snippets, setSnippets] = useState<ReadonlyMap<string, Snippet>>(() => new Map());
  const [sites, setSites] = useState<ReadonlyMap<string, SitesState>>(() => new Map());
  // Use-site sections are open by default — collapsing is remembered per key.
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(() => new Set());
  const [openCrossings, setOpenCrossings] = useState<ReadonlySet<string>>(() => new Set());
  const [crossings, setCrossings] = useState<ReadonlyMap<string, CrossingState>>(() => new Map());
  const scroller = useRef<HTMLDivElement | null>(null);

  // Switching edges resets the inspection state and scroll position.
  useEffect(() => {
    setOpenSymbols(new Set());
    setSnippets(new Map());
    setSites(new Map());
    setClosedSections(new Set());
    setOpenCrossings(new Set());
    setCrossings(new Map());
    scroller.current?.scrollTo({ top: 0 });
  }, [key]);

  /** Does a use site sit inside the boundary's consuming (source) system? */
  const inSourceSystem = useCallback(
    (file: string) =>
      source?.parts.some((p) => file === p.path || file.startsWith(`${p.path}/`)) ?? false,
    [source],
  );

  /**
   * Open/close one "Where it crosses" pair; first open fetches the concrete
   * integration points (each import statement crossing the pair). Both
   * systems' full part lists ride along so the server attributes files to
   * parts by longest prefix, exactly like the overview did.
   */
  const toggleCrossing = (p: { sourcePart: string; targetPart: string }) => {
    const crossKey = `${p.sourcePart}->${p.targetPart}`;
    setOpenCrossings((prev) => {
      const next = new Set(prev);
      if (next.has(crossKey)) next.delete(crossKey);
      else next.add(crossKey);
      return next;
    });
    if (!crossings.has(crossKey)) {
      setCrossings((m) => new Map(m).set(crossKey, { loading: true }));
      // Every system's parts form the ownership universe — a file inside a
      // sibling system's nested part must not count as this part's traffic.
      const allParts = systems.flatMap((s) => s.parts.map((part) => part.path));
      client
        .request("codemap.partCrossings", {
          sourcePart: p.sourcePart,
          targetPart: p.targetPart,
          sourceParts: allParts.length > 0 ? allParts : [p.sourcePart],
          targetParts: allParts.length > 0 ? allParts : [p.targetPart],
        })
        .then((data) => setCrossings((m) => new Map(m).set(crossKey, { data })))
        .catch((err: Error) =>
          setCrossings((m) => new Map(m).set(crossKey, { error: err.message })),
        );
    }
  };

  const toggleSection = (sectionKey: string) => {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  };

  const toggleSymbol = (d: SystemLinkSymbol) => {
    if (!d.file) return;
    const snippetKey = `${d.file}#${d.name}`;
    setOpenSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(snippetKey)) next.delete(snippetKey);
      else next.add(snippetKey);
      return next;
    });
    if (!snippets.has(snippetKey)) {
      setSnippets((m) => new Map(m).set(snippetKey, { loading: true }));
      client
        .request("codemap.symbolSource", { file: d.file, symbol: d.name })
        .then((src) =>
          setSnippets((m) =>
            new Map(m).set(snippetKey, {
              startLine: src.startLine,
              endLine: src.endLine,
              text: src.text,
              truncated: src.truncated,
            }),
          ),
        )
        .catch((err: Error) =>
          setSnippets((m) => new Map(m).set(snippetKey, { error: err.message })),
        );
    }
    if (!sites.has(snippetKey)) {
      setSites((m) => new Map(m).set(snippetKey, { loading: true }));
      client
        .request("codemap.symbolSites", { file: d.file, symbol: d.name })
        .then((data) => setSites((m) => new Map(m).set(snippetKey, { data })))
        .catch((err: Error) =>
          setSites((m) => new Map(m).set(snippetKey, { error: err.message })),
        );
    }
  };

  const systemChip = (sys: SystemModule | null, id: string) => {
    const meta = sys ? ROLE_META[sys.role] : null;
    const Icon = meta?.icon;
    return (
      <button
        type="button"
        onClick={() => onSelectSystem(id)}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-2"
        title={sys ? `${meta!.label} · ${sys.fileCount} files` : id}
      >
        {Icon ? (
          <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta!.accent }} />
        ) : null}
        <span className="min-w-0">
          <span className="block truncate text-[12px] font-semibold text-ink">{nameOf(id)}</span>
          {sys ? (
            <span className="block text-[9px] text-ink-faint">
              {meta!.label.toLowerCase()} · {sys.fileCount} files
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-edge bg-surface-1">
      {/* Header: the boundary + navigation across boundaries. */}
      <div className="border-b border-edge px-3 py-2">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Contract
          </span>
          {index !== -1 ? (
            <span className="text-[10px] text-ink-faint">
              {index + 1} of {links.length}
            </span>
          ) : null}
          <div className="ml-auto flex items-center">
            <Tooltip content="Previous boundary (by traffic)">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={index <= 0}
                onClick={() => index > 0 && onSelectEdge(linkKeyOf(links[index - 1]!))}
                aria-label="Previous boundary"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Tooltip content="Next boundary (by traffic)">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={index === -1 || index >= links.length - 1}
                onClick={() =>
                  index < links.length - 1 && onSelectEdge(linkKeyOf(links[index + 1]!))
                }
                aria-label="Next boundary"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Tooltip
              content={
                reverse
                  ? `Flip to ${nameOf(link.target)} → ${nameOf(link.source)}`
                  : "No imports flow the other way"
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!reverse}
                onClick={() => reverse && onSelectEdge(linkKeyOf(reverse))}
                aria-label="Reverse boundary"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-1 flex items-center gap-1">
          {systemChip(source, link.source)}
          <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-faint" />
          {systemChip(target, link.target)}
        </div>
        <div className="mt-1 text-[10px] text-ink-faint">
          {apiOnly
            ? "API-only — talks over the wire, no imports cross the boundary"
            : `${link.weight} import${link.weight === 1 ? "" : "s"} across the boundary`}
          {apis.length > 0 && !apiOnly
            ? ` · ${apis.length} API route${apis.length === 1 ? "" : "s"}`
            : ""}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {/* The consumed surface — each symbol expandable into its declaration. */}
        <div className="border-b border-edge/60 px-1.5 py-2">
          <div className="flex items-center px-1.5 pb-1">
            <span className="text-[9px] font-medium uppercase tracking-wide text-ink-faint">
              Surface · {details.length} symbol{details.length === 1 ? "" : "s"}
            </span>
            {link.symbols.length > 0 ? (
              <Tooltip content="Copy symbol list">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(link.symbols.join(", "))}
                  className="ml-auto text-ink-faint hover:text-ink"
                  aria-label="Copy symbols"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </Tooltip>
            ) : null}
          </div>
          {details.length === 0 && (
            <div className="px-1.5 py-0.5 text-[10px] text-ink-faint">
              {apiOnly ? "No symbols — HTTP calls only." : "Side-effect or namespace imports only."}
            </div>
          )}
          {details.map((d) => {
            const snippetKey = `${d.file}#${d.name}`;
            const open = d.file != null && openSymbols.has(snippetKey);
            const snippet = snippets.get(snippetKey);
            const siteState = sites.get(snippetKey);
            return (
              <div key={d.name} className="rounded-md hover:bg-surface-2/60">
                <div
                  className={cn(
                    "flex w-full items-baseline gap-1.5 px-1.5 py-1 text-left",
                    d.file && "cursor-pointer",
                  )}
                  onClick={() => toggleSymbol(d)}
                  role={d.file ? "button" : undefined}
                  aria-expanded={d.file ? open : undefined}
                >
                  {d.file ? (
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 shrink-0 self-center text-ink-faint transition-transform",
                        !open && "-rotate-90",
                      )}
                    />
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[11px] text-ink">{d.name}</span>
                  <span className="shrink-0 rounded bg-surface-3 px-1 py-px text-[8px] uppercase tracking-wide text-ink-faint">
                    {d.kind}
                  </span>
                  {d.count > 0 ? (
                    <Tooltip content={`${d.count} import statement${d.count === 1 ? "" : "s"} bring this across`}>
                      <span className="shrink-0 text-[9px] text-ink-faint">×{d.count}</span>
                    </Tooltip>
                  ) : null}
                  {d.file ? (
                    <Tooltip content={`Open ${d.file} in the editor`}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          requestOpenFile(d.file!, snippet?.startLine);
                        }}
                        className="ml-auto shrink-0 text-ink-faint hover:text-ink"
                        aria-label={`Open ${d.name} in the editor`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </Tooltip>
                  ) : null}
                </div>
                {d.signature && !open ? (
                  <div
                    className="truncate px-1.5 pb-1 pl-6 font-mono text-[9px] text-ink-faint"
                    title={d.signature}
                  >
                    {d.signature}
                  </div>
                ) : null}
                {open ? (
                  <div className="mx-1.5 mb-1.5 ml-6 flex flex-col gap-1.5">
                    {/* Export site: the declaration, source inline. */}
                    <div className="overflow-hidden rounded-md border border-edge bg-surface-0">
                      <div className="flex items-center gap-1.5 border-b border-edge/60 px-2 py-1">
                        <span className="shrink-0 text-[8px] font-medium uppercase tracking-wide text-ink-faint">
                          Export site
                        </span>
                        <span className="min-w-0 truncate font-mono text-[9px] text-ink-muted" title={d.file}>
                          {d.file}
                          {snippet?.startLine != null ? `:${snippet.startLine}` : ""}
                        </span>
                        <button
                          type="button"
                          onClick={() => requestOpenFile(d.file!, snippet?.startLine)}
                          className="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-ink-faint hover:text-ink"
                        >
                          <ExternalLink className="h-3 w-3" /> open
                        </button>
                      </div>
                      {snippet?.loading ? (
                        <div className="flex items-center gap-2 px-2 py-2 text-[10px] text-ink-faint">
                          <Spinner className="h-3 w-3" /> reading source…
                        </div>
                      ) : snippet?.error ? (
                        <div className="px-2 py-2 text-[10px] text-danger">{snippet.error}</div>
                      ) : snippet?.text != null ? (
                        <CodeSnippet
                          code={snippet.text}
                          startLine={snippet.startLine}
                          truncated={snippet.truncated}
                          className="max-h-64 rounded-none border-0"
                        />
                      ) : null}
                    </div>
                    {/* Where consumers pick it up and where they invoke it. */}
                    {siteState?.loading ? (
                      <div className="flex items-center gap-2 px-1 py-0.5 text-[9px] text-ink-faint">
                        <Spinner className="h-3 w-3" /> finding use sites…
                      </div>
                    ) : siteState?.error ? (
                      <div className="px-1 py-0.5 text-[9px] text-danger">{siteState.error}</div>
                    ) : siteState?.data ? (
                      <>
                        <SiteSection
                          title="Import sites"
                          sites={siteState.data.imports}
                          truncated={siteState.data.truncated}
                          emptyNote="No import statements found — namespace or dynamic imports aren't matched by name."
                          open={!closedSections.has(`${snippetKey}|imports`)}
                          onToggle={() => toggleSection(`${snippetKey}|imports`)}
                          inSource={inSourceSystem}
                          sourceName={nameOf(link.source)}
                        />
                        <SiteSection
                          title="Call sites"
                          sites={siteState.data.calls}
                          truncated={siteState.data.truncated}
                          emptyNote="No call sites resolved — types, constants and dynamic dispatch aren't traced."
                          open={!closedSections.has(`${snippetKey}|calls`)}
                          onToggle={() => toggleSection(`${snippetKey}|calls`)}
                          inSource={inSourceSystem}
                          sourceName={nameOf(link.source)}
                        />
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {apis.length > 0 && (
          <div className="border-b border-edge/60 px-1.5 py-2">
            <div className="px-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
              API calls · {apis.length}
            </div>
            {apis.map((a) => (
              <div
                key={`${a.method} ${a.path}`}
                className="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-2/60"
              >
                <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                  {a.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {a.path}
                </span>
                <span className="shrink-0 text-[9px] text-ink-faint">×{a.weight}</span>
                <Tooltip content="Open in the API explorer — handler, trace and callers">
                  <button
                    type="button"
                    onClick={() =>
                      nav({
                        mode: "surfaces",
                        surfaces: { view: "apis", api: `${a.method} ${a.path}` },
                      })
                    }
                    aria-label={`Open ${a.method} ${a.path} in the API explorer`}
                    className="shrink-0 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Webhook className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}

        {(link.parts?.length ?? 0) > 0 && (
          <div className="border-b border-edge/60 px-1.5 py-2">
            <div className="px-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
              Where it crosses
            </div>
            {link.parts!.map((p) => {
              const crossKey = `${p.sourcePart}->${p.targetPart}`;
              return (
                <CrossingPair
                  key={crossKey}
                  pair={p}
                  open={openCrossings.has(crossKey)}
                  state={crossings.get(crossKey)}
                  onToggle={() => toggleCrossing(p)}
                />
              );
            })}
          </div>
        )}

        {/* Standing context: what else leans on this provider. */}
        {target ? (
          <div className="px-3 py-2 text-[10px] text-ink-faint">
            {nameOf(link.target)} exposes {target.exports.length} consumed export
            {target.exports.length === 1 ? "" : "s"} ({target.exportedTotal} exported) ·{" "}
            {links.filter((l) => l.target === link.target).length} system
            {links.filter((l) => l.target === link.target).length === 1 ? "" : "s"} depend on it
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One part-pair of the boundary, expandable into its concrete integration
 * points: every import statement crossing from the source part into the
 * target part — file:line, the statement itself, and the names it brings
 * across — each jumping into the editor.
 */
function CrossingPair({
  pair,
  open,
  state,
  onToggle,
}: {
  pair: { sourcePart: string; targetPart: string; weight: number };
  open: boolean;
  state: CrossingState | undefined;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-md">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-2/60"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-ink-faint transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-muted"
          title={pair.sourcePart}
        >
          {pair.sourcePart}
        </span>
        <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-muted"
          title={pair.targetPart}
        >
          {pair.targetPart}
        </span>
        <span className="shrink-0 text-[9px] text-ink-faint">×{pair.weight}</span>
      </button>
      {open ? (
        <div className="mx-1.5 mb-1.5 ml-5 overflow-hidden rounded-md border border-edge bg-surface-0">
          {state?.loading ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[9px] text-ink-faint">
              <Spinner className="h-3 w-3" /> finding integration points…
            </div>
          ) : state?.error ? (
            <div className="px-2 py-1.5 text-[9px] text-danger">{state.error}</div>
          ) : state?.data ? (
            state.data.crossings.length === 0 ? (
              <div className="px-2 py-1.5 text-[9px] text-ink-faint">
                No import statements resolved — the analyzer may have re-attributed these files
                since the overview was built.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {state.data.crossings.map((c, i) => (
                  <CrossingEntry key={`${c.file}:${c.line ?? "?"}:${i}`} crossing={c} />
                ))}
                {state.data.truncated ? (
                  <div className="px-2 py-1 text-[8px] text-ink-faint">
                    List capped — the heaviest crossings are shown.
                  </div>
                ) : null}
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** In-pane inspection state for one imported name of one crossing. */
interface NameInspection {
  def?: Snippet;
  /** Declaring file the server resolved to (barrels followed) — may differ from the import target. */
  defFile?: string;
  sites?: SitesState;
}

/**
 * One concrete crossing (an import statement bringing names across the
 * boundary). Each imported name is a chip that expands in-pane into the
 * export's definition (from the target file) and its usage sites inside the
 * importing file — the intersection made concrete, no editor jump needed.
 * Namespace imports (`* as X`) carry no single symbol, so their chip opens
 * the target file instead.
 */
function CrossingEntry({ crossing: c }: { crossing: PartCrossing }) {
  const { client } = useCrystal();
  const [openName, setOpenName] = useState<string | null>(null);
  const [inspections, setInspections] = useState<ReadonlyMap<string, NameInspection>>(
    () => new Map(),
  );

  const toggleName = (name: string) => {
    const next = openName === name ? null : name;
    setOpenName(next);
    if (next == null || inspections.has(name)) return;
    setInspections((m) => new Map(m).set(name, { def: { loading: true }, sites: { loading: true } }));
    client
      .request("codemap.symbolSource", { file: c.targetFile, symbol: name })
      .then((src) =>
        setInspections((m) =>
          new Map(m).set(name, {
            ...m.get(name),
            defFile: src.file,
            def: {
              startLine: src.startLine,
              endLine: src.endLine,
              text: src.text,
              truncated: src.truncated,
            },
          }),
        ),
      )
      .catch((err: Error) =>
        setInspections((m) => new Map(m).set(name, { ...m.get(name), def: { error: err.message } })),
      );
    client
      .request("codemap.symbolSites", { file: c.targetFile, symbol: name })
      .then((data) =>
        setInspections((m) => new Map(m).set(name, { ...m.get(name), sites: { data } })),
      )
      .catch((err: Error) =>
        setInspections((m) =>
          new Map(m).set(name, { ...m.get(name), sites: { error: err.message } }),
        ),
      );
  };

  const inspection = openName != null ? inspections.get(openName) : undefined;
  // "What's imported, where it's used": only sites inside this importing file.
  const usagesHere = useMemo(() => {
    const data = inspection?.sites?.data;
    if (!data) return [];
    return data.calls.filter((s) => s.file === c.file);
  }, [inspection, c.file]);

  return (
    <div className="group border-b border-edge/40 px-2 py-1 last:border-b-0 hover:bg-surface-2/40">
      <button
        type="button"
        onClick={() => requestOpenFile(c.file, c.line ?? undefined)}
        className="flex w-full items-center gap-1.5 text-left"
        title={`Open ${c.file} in the editor`}
      >
        <span className="min-w-0 truncate font-mono text-[9px] text-ink-muted">
          {c.file}
          {c.line != null ? `:${c.line}` : ""}
        </span>
        <ExternalLink className="ml-auto h-2.5 w-2.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
      {c.text ? (
        <div className="truncate font-mono text-[9px] leading-4 text-ink/80" title={c.text}>
          {c.text}
        </div>
      ) : null}
      {c.names.length > 0 ? (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {c.names.map((name) => {
            const namespace = name.startsWith("* as ");
            return (
              <Tooltip
                key={name}
                content={
                  namespace
                    ? "Namespace import — open the exporting file"
                    : "Inspect the export's definition and where this file uses it"
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    namespace ? requestOpenFile(c.targetFile) : toggleName(name)
                  }
                  aria-expanded={namespace ? undefined : openName === name}
                  className={cn(
                    "rounded border px-1 py-px font-mono text-[9px]",
                    openName === name
                      ? "border-crystal-500/50 bg-crystal-500/15 text-crystal-300"
                      : "border-edge text-ink-muted hover:bg-surface-2 hover:text-ink",
                  )}
                >
                  {name}
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => requestOpenFile(c.targetFile)}
        className="block max-w-full truncate text-left font-mono text-[8px] leading-4 text-ink-faint hover:text-ink-muted"
        title={`Open ${c.targetFile} in the editor`}
      >
        → {c.targetFile}
      </button>
      {openName != null && inspection ? (
        <div className="mb-1 mt-1 flex flex-col gap-1.5">
          <div className="overflow-hidden rounded-md border border-edge bg-surface-0">
            <div className="flex items-center gap-1.5 border-b border-edge/60 px-2 py-1">
              <span className="shrink-0 text-[8px] font-medium uppercase tracking-wide text-ink-faint">
                Definition
              </span>
              <span
                className="min-w-0 truncate font-mono text-[9px] text-ink-muted"
                title={inspection.defFile ?? c.targetFile}
              >
                {inspection.defFile ?? c.targetFile}
                {inspection.def?.startLine != null ? `:${inspection.def.startLine}` : ""}
              </span>
              <button
                type="button"
                onClick={() =>
                  requestOpenFile(inspection.defFile ?? c.targetFile, inspection.def?.startLine)
                }
                className="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-ink-faint hover:text-ink"
              >
                <ExternalLink className="h-3 w-3" /> open
              </button>
            </div>
            {inspection.def?.loading ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[9px] text-ink-faint">
                <Spinner className="h-3 w-3" /> reading source…
              </div>
            ) : inspection.def?.error ? (
              <div className="px-2 py-1.5 text-[9px] text-danger">{inspection.def.error}</div>
            ) : inspection.def?.text != null ? (
              <CodeSnippet
                code={inspection.def.text}
                startLine={inspection.def.startLine}
                truncated={inspection.def.truncated}
                className="max-h-48 rounded-none border-0"
              />
            ) : null}
          </div>
          <div className="overflow-hidden rounded-md border border-edge bg-surface-0">
            <div className="flex items-center gap-1.5 border-b border-edge/60 px-2 py-1">
              <span className="shrink-0 text-[8px] font-medium uppercase tracking-wide text-ink-faint">
                Used in this file
              </span>
              {inspection.sites?.data ? (
                <span className="text-[9px] text-ink-faint">{usagesHere.length}</span>
              ) : null}
            </div>
            {inspection.sites?.loading ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[9px] text-ink-faint">
                <Spinner className="h-3 w-3" /> finding usages…
              </div>
            ) : inspection.sites?.error ? (
              <div className="px-2 py-1.5 text-[9px] text-danger">{inspection.sites.error}</div>
            ) : inspection.sites?.data ? (
              usagesHere.length === 0 ? (
                <div className="px-2 py-1.5 text-[9px] text-ink-faint">
                  No call sites resolved in this file — types, constants and dynamic dispatch
                  aren't traced.
                </div>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  {usagesHere.map((s, i) => (
                    <button
                      key={`${s.line ?? "?"}:${i}`}
                      type="button"
                      onClick={() => requestOpenFile(s.file, s.line ?? undefined)}
                      className="block w-full px-2 py-1 text-left hover:bg-surface-2/60"
                      title={`Open ${s.file} in the editor`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="shrink-0 font-mono text-[9px] text-ink-faint">
                          :{s.line ?? "?"}
                        </span>
                        {s.symbol ? (
                          <span className="shrink-0 font-mono text-[9px] text-accent-violet/80">
                            {s.symbol}()
                          </span>
                        ) : null}
                      </span>
                      {s.text ? (
                        <span
                          className="block truncate font-mono text-[9px] leading-4 text-ink/80"
                          title={s.text}
                        >
                          {s.text}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One collapsible use-site list (import sites or call sites) inside a
 * symbol's accordion. Sites inside the boundary's consuming system sort
 * first and render brighter; the rest are context from elsewhere.
 */
function SiteSection({
  title,
  sites,
  truncated,
  emptyNote,
  open,
  onToggle,
  inSource,
  sourceName,
}: {
  title: string;
  sites: SymbolSite[];
  truncated: boolean;
  emptyNote: string;
  open: boolean;
  onToggle: () => void;
  inSource: (file: string) => boolean;
  sourceName: string;
}) {
  const ordered = useMemo(
    () => [...sites].sort((a, b) => Number(inSource(b.file)) - Number(inSource(a.file))),
    [sites, inSource],
  );
  const fromSource = useMemo(() => sites.filter((s) => inSource(s.file)).length, [sites, inSource]);
  return (
    <div className="overflow-hidden rounded-md border border-edge bg-surface-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-surface-2/60"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-ink-faint transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="text-[8px] font-medium uppercase tracking-wide text-ink-faint">
          {title}
        </span>
        <span className="text-[9px] text-ink-faint">
          {sites.length}
          {truncated ? "+" : ""}
        </span>
        {fromSource > 0 ? (
          <span className="ml-auto min-w-0 truncate text-[8px] text-ink-faint">
            {fromSource} in {sourceName}
          </span>
        ) : null}
      </button>
      {open ? (
        sites.length === 0 ? (
          <div className="border-t border-edge/60 px-2 py-1.5 text-[9px] text-ink-faint">
            {emptyNote}
          </div>
        ) : (
          <div className="max-h-48 overflow-y-auto border-t border-edge/60">
            {ordered.map((s, i) => (
              <div key={`${s.file}:${s.line ?? "?"}:${i}`} className="group px-2 py-1 hover:bg-surface-2/60">
                <button
                  type="button"
                  onClick={() => requestOpenFile(s.file, s.line ?? undefined)}
                  className="flex w-full items-center gap-1.5 text-left"
                  title={`Open ${s.file} in the editor`}
                >
                  <span
                    className={cn(
                      "min-w-0 truncate font-mono text-[9px]",
                      inSource(s.file) ? "text-ink-muted" : "text-ink-faint",
                    )}
                  >
                    {s.file}
                    {s.line != null ? `:${s.line}` : ""}
                  </span>
                  {s.symbol ? (
                    <span className="shrink-0 font-mono text-[9px] text-accent-violet/80">
                      {s.symbol}()
                    </span>
                  ) : null}
                  <ExternalLink className="ml-auto h-2.5 w-2.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
                {s.text ? (
                  <div
                    className="truncate font-mono text-[9px] leading-4 text-ink/80"
                    title={s.text}
                  >
                    {s.text}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

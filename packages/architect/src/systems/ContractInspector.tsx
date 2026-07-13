import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  X,
} from "lucide-react";
import type { SystemLink, SystemLinkSymbol, SystemModule } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Button, Spinner, Tooltip, cn } from "@crystal/ui";
import { requestOpenFile } from "../codemap/CodeMapView.js";
import { ROLE_META } from "./role-meta.js";

/**
 * Contract inspector — the full split-pane opened by clicking a boundary edge
 * on the systems overview. Everything travelling the edge, inspectable in
 * place: each imported symbol expands into its declaration source (fetched
 * on demand), jumps into the editor, and the API/part attribution sections
 * give the boundary its context. ←/→ walk every visible boundary by traffic;
 * ⇄ flips to the reverse edge when one exists.
 */

export const linkKeyOf = (l: Pick<SystemLink, "source" | "target">): string =>
  `${l.source}->${l.target}`;

interface Snippet {
  loading?: boolean;
  error?: string;
  startLine?: number;
  endLine?: number;
  text?: string;
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
  const scroller = useRef<HTMLDivElement | null>(null);

  // Switching edges resets the inspection state and scroll position.
  useEffect(() => {
    setOpenSymbols(new Set());
    setSnippets(new Map());
    scroller.current?.scrollTo({ top: 0 });
  }, [key]);

  const toggleSymbol = (d: SystemLinkSymbol) => {
    if (!d.file) return;
    const snippetKey = `${d.file}#${d.name}`;
    setOpenSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(snippetKey)) next.delete(snippetKey);
      else next.add(snippetKey);
      return next;
    });
    if (snippets.has(snippetKey)) return;
    setSnippets((m) => new Map(m).set(snippetKey, { loading: true }));
    client
      .request("codemap.symbolSource", { file: d.file, symbol: d.name })
      .then((src) =>
        setSnippets((m) =>
          new Map(m).set(snippetKey, {
            startLine: src.startLine,
            endLine: src.endLine,
            text: src.text,
          }),
        ),
      )
      .catch((err: Error) =>
        setSnippets((m) => new Map(m).set(snippetKey, { error: err.message })),
      );
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
                  <div className="mx-1.5 mb-1.5 ml-6 overflow-hidden rounded-md border border-edge bg-surface-0">
                    <div className="flex items-center gap-1.5 border-b border-edge/60 px-2 py-1">
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
                      <pre className="max-h-64 overflow-auto px-2 py-1.5 text-[10px] leading-4 text-ink-muted">
                        {snippet.text.split("\n").map((line, i) => (
                          <div key={i} className="flex">
                            <span className="w-8 shrink-0 select-none pr-2 text-right text-ink-faint/60">
                              {(snippet.startLine ?? 1) + i}
                            </span>
                            <span className="whitespace-pre">{line}</span>
                          </div>
                        ))}
                      </pre>
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
              <div key={`${a.method} ${a.path}`} className="flex items-center gap-1.5 px-1.5 py-0.5">
                <span className="shrink-0 rounded bg-accent-amber/15 px-1 font-mono text-[9px] font-semibold uppercase text-accent-amber">
                  {a.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink">
                  {a.path}
                </span>
                <span className="shrink-0 text-[9px] text-ink-faint">×{a.weight}</span>
              </div>
            ))}
          </div>
        )}

        {(link.parts?.length ?? 0) > 0 && (
          <div className="border-b border-edge/60 px-1.5 py-2">
            <div className="px-1.5 pb-1 text-[9px] font-medium uppercase tracking-wide text-ink-faint">
              Where it crosses
            </div>
            {link.parts!.map((p) => (
              <div
                key={`${p.sourcePart}->${p.targetPart}`}
                className="flex items-center gap-1 px-1.5 py-0.5"
              >
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-muted"
                  title={p.sourcePart}
                >
                  {p.sourcePart}
                </span>
                <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-faint" />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-muted"
                  title={p.targetPart}
                >
                  {p.targetPart}
                </span>
                <span className="shrink-0 text-[9px] text-ink-faint">×{p.weight}</span>
              </div>
            ))}
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

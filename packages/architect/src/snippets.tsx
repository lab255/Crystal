import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Code2, ExternalLink, X } from "lucide-react";
import type { CodeFileDetail, CodeModuleDetail, CodeSymbolSource } from "@crystal/core";
import { useCrystal } from "@crystal/client";
import { Badge, Button, CodeSnippet, Spinner, cn } from "@crystal/ui";

/**
 * Symbol source snippets — fetched over `codemap.symbolSource`, cached until
 * the code map re-analyzes (`codemap.changed` clears everything; snippets are
 * cheap to refetch and correctness beats cleverness here).
 */

const sourceCache = new Map<string, CodeSymbolSource>();
let cacheWired = false;

function keyOf(ws: string | undefined, file: string, symbol: string): string {
  return `${ws ?? ""}|${file}#${symbol}`;
}

export interface SymbolSourceState {
  source: CodeSymbolSource | null;
  loading: boolean;
  error: string | null;
}

export function useSymbolSource(
  file: string | null,
  symbol: string | null,
  ws?: string,
): SymbolSourceState {
  const { client } = useCrystal();
  const [state, setState] = useState<SymbolSourceState>({ source: null, loading: false, error: null });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (cacheWired) return;
    cacheWired = true;
    client.events.on("codemap.changed", () => sourceCache.clear());
  }, [client]);

  // Re-render (and refetch through the now-empty cache) when the map changes.
  useEffect(() => {
    return client.events.on("codemap.changed", () => setGeneration((g) => g + 1));
  }, [client]);

  useEffect(() => {
    if (!file || !symbol) {
      setState({ source: null, loading: false, error: null });
      return;
    }
    const key = keyOf(ws, file, symbol);
    const cached = sourceCache.get(key);
    if (cached) {
      setState({ source: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ source: null, loading: true, error: null });
    client
      .request("codemap.symbolSource", { ws, file, symbol })
      .then((source) => {
        sourceCache.set(key, source);
        if (!cancelled) setState({ source, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ source: null, loading: false, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [client, file, symbol, ws, generation]);

  return state;
}

/** Fetch-and-render snippet for one symbol. */
export function SymbolSnippet({
  file,
  symbol,
  ws,
  className,
}: {
  file: string;
  symbol: string;
  ws?: string;
  className?: string;
}) {
  const { source, loading, error } = useSymbolSource(file, symbol, ws);
  if (loading) {
    return (
      <div className={cn("flex items-center gap-2 py-2 text-[11px] text-ink-faint", className)}>
        <Spinner className="h-3 w-3" /> loading source…
      </div>
    );
  }
  if (error) {
    return <div className={cn("py-2 text-[11px] text-warn", className)}>{error}</div>;
  }
  if (!source) return null;
  return (
    <CodeSnippet
      code={source.text}
      startLine={source.startLine}
      truncated={source.truncated}
      className={cn("max-h-72", className)}
    />
  );
}

/**
 * "Peek code" panel for a diagram node linked to a code module: the module's
 * files (most exports first), each file's top-level symbols, and an inline
 * snippet for the selected symbol — without leaving the diagram.
 */
export function PeekPanel({
  module,
  nodeLabel,
  ws,
  onClose,
  onOpenFile,
}: {
  module: string;
  nodeLabel: string;
  ws?: string;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { client } = useCrystal();
  const [detail, setDetail] = useState<CodeModuleDetail | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<CodeFileDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .request("codemap.module", { ws, path: module })
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        const best = [...d.files].sort((a, b) => b.exportCount - a.exportCount)[0];
        setFile(best?.path ?? null);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [client, ws, module]);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setFileDetail(null);
    setSelected(null);
    client
      .request("codemap.file", { ws, path: file })
      .then((d) => !cancelled && setFileDetail(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [client, ws, file]);

  const files = useMemo(
    () => (detail ? [...detail.files].sort((a, b) => b.exportCount - a.exportCount) : []),
    [detail],
  );
  const symbols = fileDetail?.symbols ?? [];

  return (
    <div className="absolute left-3 top-16 z-20 flex max-h-[70vh] w-[26rem] flex-col rounded-xl border border-edge bg-surface-2/95 shadow-2xl shadow-black/40 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Code2 className="h-3.5 w-3.5 shrink-0 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {nodeLabel} <span className="font-mono text-[10px] text-ink-faint">{module}</span>
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close code peek">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? <div className="text-[11px] text-warn">{error}</div> : null}
        {!detail && !error ? (
          <div className="flex items-center gap-2 text-[11px] text-ink-faint">
            <Spinner className="h-3 w-3" /> loading module…
          </div>
        ) : null}
        {files.length > 0 ? (
          <select
            className="mb-2 h-7 w-full rounded-lg border border-edge bg-surface-1 px-2 text-[11px] text-ink focus:border-crystal-500/60 focus:outline-none"
            value={file ?? ""}
            onChange={(e) => setFile(e.target.value)}
            aria-label="File"
          >
            {files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path} {f.exportCount ? `· ${f.exportCount} exports` : ""}
              </option>
            ))}
          </select>
        ) : null}
        {symbols.map((sym) => (
          <div key={sym.name}>
            <button
              type="button"
              onClick={() => setSelected(selected === sym.name ? null : sym.name)}
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] hover:bg-surface-3"
            >
              <ChevronRight
                className={cn("h-3 w-3 shrink-0 text-ink-faint transition-transform", selected === sym.name && "rotate-90")}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-ink">{sym.name}</span>
              {!sym.exported ? <Badge tone="neutral">internal</Badge> : null}
              <span className="text-[9px] text-ink-faint">:{sym.line}</span>
            </button>
            {selected === sym.name && file ? (
              <SymbolSnippet file={file} symbol={sym.name} ws={ws} className="mb-2 ml-4 mt-1" />
            ) : null}
          </div>
        ))}
        {fileDetail && symbols.length === 0 ? (
          <div className="text-[11px] text-ink-faint">No top-level symbols in this file.</div>
        ) : null}
      </div>
      {file && onOpenFile ? (
        <div className="border-t border-edge px-3 py-2">
          <Button variant="secondary" size="xs" onClick={() => onOpenFile(file)}>
            <ExternalLink className="h-3 w-3" /> Open in editor
          </Button>
        </div>
      ) : null}
    </div>
  );
}

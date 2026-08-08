import { useEffect, useMemo, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  createArchitectureGraph,
  type CodeFileDetail,
  type CodeSymbolSource,
  type CodeTrace,
  type CodeTraceStep,
  type SystemEndpoint,
} from "@crystal/core";
import { requestOpenFile, useCrystal } from "@crystal/client";
import { cn } from "@crystal/ui";
import { JourneyProfilePanel } from "@crystal/architect";
import { DetailSection, useArchHighlight } from "./common.js";

/**
 * Endpoint call-trace plumbing, shared by the API explorer's detail pane and
 * the system map's endpoint inspector: resolve the route registration to a
 * traceable handler symbol, fetch its static call graph, and render it as the
 * house flamegraph (single click highlights, double click opens the code).
 */

const EMPTY_GRAPH = createArchitectureGraph("API trace");

export interface EndpointTraceState {
  fileDetail: CodeFileDetail | null;
  /** Candidate (file, symbol) trace roots, best first. */
  candidates: { file: string; symbol: string }[];
  /** The candidate that actually traced. */
  resolved: { file: string; symbol: string } | null;
  trace: CodeTrace | null;
  /** The resolved symbol's source (definition snippet / signature). */
  source: CodeSymbolSource | null;
  error: string | null;
}

/** Resolve the route's displayed handler reference to likely declaration symbols. */
export function endpointHandlerCandidates(
  ep: SystemEndpoint,
  fileDetail: CodeFileDetail,
): { file: string; symbol: string }[] {
  const out: { file: string; symbol: string }[] = [];
  if (ep.handler) {
    const [root, prop] = ep.handler.split(".") as [string, string?];
    const named = fileDetail.imports.find((entry) => entry.resolved && entry.names.includes(root));
    if (named?.resolved) {
      if (prop) out.push({ file: named.resolved, symbol: prop });
      out.push({
        file: named.resolved,
        symbol: named.defaultName === root ? "default" : root,
      });
    } else if (prop) {
      for (const entry of fileDetail.imports) {
        if (entry.resolved && entry.names.some((name) => name === "*" || name === "default")) {
          out.push({ file: entry.resolved, symbol: prop });
        }
      }
    }
    if (prop) out.push({ file: ep.file, symbol: prop });
    out.push({ file: ep.file, symbol: root });
  }
  if (ep.line != null) {
    const enclosing = fileDetail.symbols.find(
      (symbol) => ep.line! >= symbol.line && ep.line! <= (symbol.endLine ?? symbol.line),
    );
    if (enclosing) out.push({ file: ep.file, symbol: enclosing.name });
    const above = fileDetail.symbols.filter((symbol) => symbol.line <= ep.line!);
    if (above.length > 0) out.push({ file: ep.file, symbol: above[above.length - 1]!.name });
  }
  const firstFn = fileDetail.symbols.find(
    (symbol) =>
      symbol.exported &&
      (symbol.kind === "function" || symbol.kind === "const" || symbol.kind === "component"),
  );
  if (firstFn) out.push({ file: ep.file, symbol: firstFn.name });

  const seen = new Set<string>();
  return out.filter((candidate) => {
    const key = `${candidate.file} ${candidate.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The symbol the definition/trace anchor on — resolved, best first:
 *   1. the registration's handler reference ("Controller.createForm"),
 *      followed through the route file's imports to its declaring file;
 *   2. the top-level symbol enclosing the registration line;
 *   3. the file's first exported function-ish symbol (file-convention routes).
 */
export function useEndpointTrace(ep: SystemEndpoint | null): EndpointTraceState {
  const { client } = useCrystal();
  const [fileDetail, setFileDetail] = useState<CodeFileDetail | null>(null);
  const [trace, setTrace] = useState<CodeTrace | null>(null);
  const [resolved, setResolved] = useState<{ file: string; symbol: string } | null>(null);
  const [source, setSource] = useState<CodeSymbolSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Identity by value, not reference — scene rebuilds hand out fresh endpoint
  // objects for the same route, and those must not retrigger the fetches.
  const epId = ep ? `${ep.method} ${ep.path} ${ep.file} ${ep.line ?? ""} ${ep.handler ?? ""}` : null;

  useEffect(() => {
    setFileDetail(null);
    setTrace(null);
    setResolved(null);
    setSource(null);
    setError(null);
    if (!ep) return;
    let cancelled = false;
    client
      .request("codemap.file", { path: ep.file })
      .then((d) => !cancelled && setFileDetail(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, epId]);

  const candidates = useMemo(() => {
    if (!fileDetail || !ep) return [];
    return endpointHandlerCandidates(ep, fileDetail);
  }, [fileDetail, ep]);

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
          setError(null);
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
        setError("No traceable handler symbol found for this route.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, candidates]);

  return { fileDetail, candidates, resolved, trace, source, error };
}

/**
 * The trace as a DetailSection — flamegraph + call profile with the expand
 * toggle and the loading/error states. Single click highlights (the embedded
 * architecture pane by default; pass `onSelectStep` to spotlight elsewhere,
 * e.g. the system map pans to the owning system); double click opens the code.
 */
export function TraceSection({
  state,
  onSelectStep,
}: {
  state: EndpointTraceState;
  onSelectStep?: (step: CodeTraceStep) => void;
}) {
  const arch = useArchHighlight();
  const [tall, setTall] = useState(false);
  const { trace, resolved, source, error, candidates, fileDetail } = state;
  const selectStep = onSelectStep ?? ((step: CodeTraceStep) => arch.file(step.ref.file, step.line));
  return (
    <DetailSection
      title={resolved ? `Trace · from ${source?.symbol ?? resolved.symbol}` : "Trace"}
      hint="static call graph — drop runtime profiles in .crystal/traces/ to overlay"
      actions={
        trace ? (
          <button
            type="button"
            onClick={() => setTall((t) => !t)}
            className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            aria-expanded={tall}
          >
            {tall ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
            {tall ? "shrink" : "expand"}
          </button>
        ) : undefined
      }
    >
      {trace ? (
        <div
          className={cn(
            "overflow-hidden rounded-lg border border-edge",
            tall ? "h-[36rem]" : "h-72",
          )}
        >
          {/* Flamegraph semantics: single click highlights, double click opens the code. */}
          <JourneyProfilePanel
            trace={trace}
            graph={EMPTY_GRAPH}
            summary={null}
            onOpenStep={(step) => requestOpenFile(step.ref.file, step.line)}
            onSelectStep={selectStep}
          />
        </div>
      ) : error ? (
        <div className="text-[11px] text-danger">{error}</div>
      ) : (
        <div className="text-[11px] text-ink-faint">
          {candidates.length > 0 || !fileDetail ? "Tracing…" : "No handler symbol to trace from."}
        </div>
      )}
    </DetailSection>
  );
}

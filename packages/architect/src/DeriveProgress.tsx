import type { CodeMapProgress } from "@crystal/core";
import { cn, ProgressBar, Spinner } from "@crystal/ui";
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deriveOverallFraction, deriveStages, type DeriveStage, type DeriveStageId } from "./derive-progress.js";

const N = new Intl.NumberFormat();

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Wall-clock per stage, kept on the client (the server sends no timestamps). */
function useStageTimings(stages: DeriveStage[], now: number): Map<DeriveStageId, { start: number; end: number | null }> {
  const ref = useRef(new Map<DeriveStageId, { start: number; end: number | null }>());
  for (const st of stages) {
    const t = ref.current.get(st.id);
    if (st.status === "active" && !t) ref.current.set(st.id, { start: now, end: null });
    if (st.status === "done" && t && t.end == null) t.end = now;
    if (st.status === "done" && !t) ref.current.set(st.id, { start: now, end: now });
    if (st.status === "pending" && t) ref.current.delete(st.id);
  }
  return ref.current;
}

export function DeriveProgress({
  ws,
  progress,
  loading,
  hasData,
  rendered,
  error,
}: {
  ws: string | null;
  progress: CodeMapProgress | null;
  loading: boolean;
  hasData: boolean;
  rendered: boolean;
  error?: string | null;
}) {
  const stages = deriveStages({ progress, loading, hasData, rendered });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const timings = useStageTimings(stages, now);
  const active = stages.find((s) => s.status === "active");
  const started = [...timings.values()].reduce((m, t) => Math.min(m, t.start), now);

  return (
    <div className="flex w-80 flex-col gap-3 text-left">
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Spinner className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{active?.label ?? "Finishing"}…</span>
        <span className="ml-auto tabular-nums text-[10px] text-ink-faint">{fmtMs(now - started)}</span>
      </div>

      {/* Segmented multi-stage bar */}
      <ol className="flex gap-1" aria-label="Derivation stages">
        {stages.map((st) => (
          <li key={st.id} className="flex flex-1 flex-col gap-1" title={st.label}>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  st.status === "done" ? "bg-accent" : st.status === "active" ? "bg-accent/70" : "bg-transparent",
                  st.status === "active" && st.fraction == null && "animate-pulse",
                )}
                style={{ width: `${Math.round((st.status === "active" && st.fraction == null ? 1 : (st.fraction ?? 0)) * 100)}%` }}
              />
            </div>
            <span
              className={cn(
                "truncate text-[9px] leading-tight",
                st.status === "active" ? "text-ink" : st.status === "done" ? "text-ink-muted" : "text-ink-faint",
              )}
            >
              {st.label}
            </span>
          </li>
        ))}
      </ol>

      <ProgressBar
        value={deriveOverallFraction(stages) * 100}
        max={100}
        label="Overall derivation progress"
      />

      {/* Accordion: the exact state */}
      <details className="group rounded-lg border border-edge bg-surface-2/60 text-[11px]">
        <summary className="flex cursor-pointer select-none items-center gap-1 px-2 py-1.5 text-ink-muted hover:text-ink">
          <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
          Details
        </summary>
        <div className="border-t border-edge px-2 py-1.5">
          <ul className="flex flex-col gap-1">
            {stages.map((st) => {
              const t = timings.get(st.id);
              const elapsed = t ? (t.end ?? now) - t.start : null;
              return (
                <li key={st.id} className="flex items-center gap-2">
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {st.status === "done" ? (
                      <Check className="h-3 w-3 text-accent" />
                    ) : st.status === "active" ? (
                      <Spinner className="h-3 w-3" />
                    ) : (
                      <span className="h-1.5 w-1.5 rounded-full bg-edge" />
                    )}
                  </span>
                  <span className={cn("flex-1 truncate", st.status === "pending" ? "text-ink-faint" : "text-ink")}>
                    {st.label}
                    {st.id === "parse" && st.status === "active" && progress?.total != null ? (
                      <span className="text-ink-muted">
                        {" "}· {N.format(progress.done ?? 0)} / {N.format(progress.total)} files
                      </span>
                    ) : null}
                    {st.id === "derive" && st.status === "active" ? (
                      <span className="text-ink-muted"> · building code index + system overview (no per-file progress)</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-ink-faint">{elapsed != null ? fmtMs(elapsed) : "—"}</span>
                </li>
              );
            })}
          </ul>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-t border-edge pt-1.5 text-[10px] text-ink-faint">
            <dt>Workspace</dt>
            <dd className="truncate font-mono text-ink-muted">{ws ?? "—"}</dd>
            <dt>Server phase</dt>
            <dd className="font-mono text-ink-muted">{progress?.phase ?? "(no event yet)"}</dd>
            <dt>Files</dt>
            <dd className="font-mono text-ink-muted">
              {progress?.total != null ? `${N.format(progress.done ?? 0)} / ${N.format(progress.total)}` : "—"}
            </dd>
            <dt>Request</dt>
            <dd className="font-mono text-ink-muted">
              {loading ? "codemap.get + codemap.overview pending" : hasData ? "inputs received" : "idle"}
            </dd>
            {error ? (
              <>
                <dt>Last error</dt>
                <dd className="text-danger">{error}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </details>
    </div>
  );
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, CircleDot, SkipForward, X } from "lucide-react";
import type {
  CoverageMetric,
  CoverageReport,
  QualityRun,
  TestCaseStatus,
  TestRunnerInfo,
} from "@crystal/core";
import { coverageBand } from "@crystal/core";
import { useCrystal, useNavUpdate, useWorkspaces } from "@crystal/client";
import { ContextMenu, Spinner, Tooltip, cn, type MenuEntry } from "@crystal/ui";

/* ------------------------------------------------------------------ */
/* Data: runner info + runs + coverage, live over the bridge           */
/* ------------------------------------------------------------------ */

export interface QualityData {
  info: TestRunnerInfo | null;
  runs: QualityRun[];
  /** The in-flight run, when one exists. */
  liveRun: QualityRun | null;
  coverage: CoverageReport | null;
  loading: boolean;
  error: string | null;
  /** Start a run; scope/coverage optional. Surfaces errors via `error`. */
  run: (params: { file?: string; testName?: string; coverage?: boolean }) => void;
  cancel: (runId: string) => void;
  refresh: () => void;
}

const QualityCtx = createContext<QualityData | null>(null);

export function QualityProvider({ children }: { children: React.ReactNode }) {
  const { client } = useCrystal();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [info, setInfo] = useState<TestRunnerInfo | null>(null);
  const [runs, setRuns] = useState<QualityRun[]>([]);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      client.request("quality.detect", {}),
      client.request("quality.runs", {}),
      client.request("quality.coverage", {}),
    ])
      .then(([detected, runList, cov]) => {
        if (cancelled) return;
        setInfo(detected);
        setRuns(runList.runs);
        setCoverage(cov.coverage);
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

  // Live: replace/insert the changed run; refetch coverage when it lands.
  useEffect(() => {
    const d1 = client.events.on("quality.runChanged", ({ ws, run }) => {
      if (ws !== activeWs) return;
      setRuns((prev) => {
        const i = prev.findIndex((r) => r.id === run.id);
        if (i === -1) return [run, ...prev].slice(0, 20);
        const next = [...prev];
        next[i] = run;
        return next;
      });
    });
    const d2 = client.events.on("quality.coverageChanged", ({ ws }) => {
      if (ws !== activeWs) return;
      client
        .request("quality.coverage", {})
        .then((cov) => setCoverage(cov.coverage))
        .catch(() => {});
    });
    return () => {
      d1();
      d2();
    };
  }, [client, activeWs]);

  const nav = useNavUpdate();
  const run = useCallback(
    (params: { file?: string; testName?: string; coverage?: boolean }) => {
      setError(null);
      // A new run supersedes any pinned historical run — otherwise the view
      // stays frozen on the pin and the fresh results never appear.
      nav({ quality: { run: null } });
      client
        .request("quality.run", params)
        .then(({ run: started }) => {
          setRuns((prev) =>
            prev.some((r) => r.id === started.id) ? prev : [started, ...prev].slice(0, 20),
          );
        })
        .catch((err: Error) => setError(err.message));
    },
    [client, nav],
  );

  const cancel = useCallback(
    (runId: string) => {
      client.request("quality.cancel", { runId }).catch(() => {});
    },
    [client],
  );

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const liveRun = useMemo(() => runs.find((r) => r.status === "running") ?? null, [runs]);

  return (
    <QualityCtx.Provider
      value={{ info, runs, liveRun, coverage, loading, error, run, cancel, refresh }}
    >
      {children}
    </QualityCtx.Provider>
  );
}

export function useQuality(): QualityData {
  const ctx = useContext(QualityCtx);
  if (!ctx) throw new Error("useQuality outside QualityProvider");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Status + coverage presentation conventions                          */
/* ------------------------------------------------------------------ */

export function StatusIcon({
  status,
  running,
  className,
}: {
  status: TestCaseStatus | null;
  /** Overrides to a spinner (a run is in flight and may rewrite this row). */
  running?: boolean;
  className?: string;
}) {
  const cls = cn("h-3.5 w-3.5 shrink-0", className);
  if (running) return <Spinner className={cls} />;
  if (status === "pass") return <Check className={cn(cls, "text-ok")} />;
  if (status === "fail") return <X className={cn(cls, "text-danger")} />;
  if (status === "skip") return <SkipForward className={cn(cls, "text-ink-faint")} />;
  if (status === "todo") return <CircleDot className={cn(cls, "text-warn")} />;
  return <CircleDashed className={cn(cls, "text-ink-faint/60")} />;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const BAND_TEXT = { ok: "text-ok", warn: "text-warn", danger: "text-danger" } as const;
const BAND_BG = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger" } as const;

/** Percentage, colored by the shared coverage band convention. */
export function PctLabel({ metric, className }: { metric: CoverageMetric; className?: string }) {
  const pct = metric.total === 0 ? 100 : metric.pct;
  return (
    <Tooltip content={`${metric.covered}/${metric.total} covered`}>
      <span className={cn("font-mono text-[10px] tabular-nums", BAND_TEXT[coverageBand(pct)], className)}>
        {pct.toFixed(1)}%
      </span>
    </Tooltip>
  );
}

/** Horizontal coverage bar, banded ok/warn/danger. */
export function CoverageBar({ metric, className }: { metric: CoverageMetric; className?: string }) {
  const pct = metric.total === 0 ? 100 : metric.pct;
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-surface-3", className)}>
      <div
        className={cn("h-full rounded-full", BAND_BG[coverageBand(pct)])}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Context-menu plumbing (same shape as the surfaces mode's)           */
/* ------------------------------------------------------------------ */

export function useMenu(): {
  open: (e: React.MouseEvent, entries: MenuEntry[]) => void;
  element: React.ReactNode;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const open = useCallback((e: React.MouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (entries.length === 0) return;
    setMenu({ x: e.clientX, y: e.clientY, entries });
  }, []);
  const element = menu ? (
    <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />
  ) : null;
  return { open, element };
}

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

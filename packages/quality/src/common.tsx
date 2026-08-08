import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, CircleDot, SkipForward, X } from "lucide-react";
import type {
  CoverageMetric,
  CoverageReport,
  LensMatcher,
  QualityRun,
  TestCaseStatus,
  TestRunnerInfo,
} from "@crystal/core";
import { coverageBand, lensLabel } from "@crystal/core";
import { useCrystal, useLens, useNavUpdate, useWorkspaces } from "@crystal/client";
import { Spinner, Tooltip, cn } from "@crystal/ui";
import { loadQualitySources, performQualityAction } from "./quality-state.js";

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
  infoLoading: boolean;
  runsLoading: boolean;
  coverageLoading: boolean;
  infoError: string | null;
  runsError: string | null;
  coverageError: string | null;
  actionError: string | null;
  /** Start a run; scope/coverage optional. Rejections surface via `actionError`. */
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
  const [infoLoading, setInfoLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [coverageLoading, setCoverageLoading] = useState(true);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setInfo(null);
    setRuns([]);
    setCoverage(null);
    setInfoError(null);
    setRunsError(null);
    setCoverageError(null);
    setActionError(null);
    setInfoLoading(activeWs != null);
    setRunsLoading(activeWs != null);
    setCoverageLoading(activeWs != null);
  }, [activeWs]);

  useEffect(() => {
    if (!activeWs) return;
    let cancelled = false;
    setInfoLoading(true);
    setRunsLoading(true);
    setCoverageLoading(true);
    setInfoError(null);
    setRunsError(null);
    setCoverageError(null);
    void loadQualitySources(
      {
        info: () => client.request("quality.detect", {}),
        runs: () => client.request("quality.runs", {}).then((result) => result.runs),
        coverage: () => client.request("quality.coverage", {}).then((result) => result.coverage),
      },
      (result) => {
        if (cancelled) return;
        if (result.source === "info") {
          setInfoLoading(false);
          if ("error" in result) setInfoError(result.error);
          else setInfo(result.data);
        } else if (result.source === "runs") {
          setRunsLoading(false);
          if ("error" in result) setRunsError(result.error);
          else setRuns(result.data);
        } else {
          setCoverageLoading(false);
          if ("error" in result) setCoverageError(result.error);
          else setCoverage(result.data);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, activeWs, generation]);

  // Live: replace/insert the changed run; refetch coverage when it lands.
  useEffect(() => {
    let disposed = false;
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
      setCoverageLoading(true);
      setCoverageError(null);
      client
        .request("quality.coverage", {})
        .then((cov) => {
          if (!disposed) setCoverage(cov.coverage);
        })
        .catch((err: Error) => {
          if (!disposed) setCoverageError(err.message);
        })
        .finally(() => {
          if (!disposed) setCoverageLoading(false);
        });
    });
    return () => {
      disposed = true;
      d1();
      d2();
    };
  }, [client, activeWs]);

  const nav = useNavUpdate();
  const run = useCallback(
    (params: { file?: string; testName?: string; coverage?: boolean }) => {
      setActionError(null);
      // A new run supersedes any pinned historical run — otherwise the view
      // stays frozen on the pin and the fresh results never appear.
      nav({ quality: { run: null } });
      void performQualityAction(
        () => client.request("quality.run", params),
        setActionError,
      ).then((result) => {
        if (result) {
          const started = result.run;
          setRuns((prev) =>
            prev.some((r) => r.id === started.id) ? prev : [started, ...prev].slice(0, 20),
          );
        }
      });
    },
    [client, nav],
  );

  const cancel = useCallback(
    (runId: string) => {
      setActionError(null);
      void performQualityAction(
        () => client.request("quality.cancel", { runId }),
        setActionError,
      );
    },
    [client],
  );

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const liveRun = useMemo(() => runs.find((r) => r.status === "running") ?? null, [runs]);
  const loading = infoLoading || runsLoading || coverageLoading;

  return (
    <QualityCtx.Provider
      value={{
        info,
        runs,
        liveRun,
        coverage,
        loading,
        infoLoading,
        runsLoading,
        coverageLoading,
        infoError,
        runsError,
        coverageError,
        actionError,
        run,
        cancel,
        refresh,
      }}
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
/* Lens: the global cross-mode filter, applied here as dimming         */
/* ------------------------------------------------------------------ */

export interface QualityLens {
  /** A lens is selected (whatever its resolution state). */
  active: boolean;
  /** Resolved with members — dim non-members. */
  dimming: boolean;
  /** Resolved to nothing (e.g. a clean worktree diff) — hint, don't dim. */
  matchesNothing: boolean;
  matcher: LensMatcher;
  label: string | null;
}

export function useQualityLens(): QualityLens {
  const spec = useLens((s) => s.spec);
  const matcher = useLens((s) => s.matcher);
  const status = useLens((s) => s.status);
  const facets = useLens((s) => s.facets);
  return useMemo(() => {
    const ready = spec !== null && status === "ready";
    return {
      active: spec !== null,
      dimming: ready && !matcher.empty,
      matchesNothing: ready && matcher.empty,
      matcher,
      label: spec ? lensLabel(spec, facets) : null,
    };
  }, [spec, matcher, status, facets]);
}

/**
 * Is this test file in the lens? Direct membership, or the lens touches its
 * directory — so a review-diff lens keeps the sibling tests of changed
 * sources actionable.
 */
export function testFileInLens(matcher: LensMatcher, path: string): boolean {
  if (matcher.file(path)) return true;
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  return dir !== "" && matcher.under(dir);
}

/** "lens: 4 of 31 test files" (or the matches-nothing notice) for a list header. */
export function LensHint({
  lens,
  member,
  total,
  noun,
}: {
  lens: QualityLens;
  member: number;
  total: number;
  noun: string;
}) {
  if (lens.matchesNothing) {
    return (
      <span className="text-[10px] italic text-ink-faint">lens matches nothing here</span>
    );
  }
  if (!lens.dimming) return null; // no lens, or still resolving / errored
  return (
    <Tooltip content={lens.label ?? "Active lens"}>
      <span className="text-[10px] text-crystal-300">
        lens: {member} of {total} {noun}
      </span>
    </Tooltip>
  );
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

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

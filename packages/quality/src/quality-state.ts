import type {
  CoverageReport,
  FileCoverage,
  QualityRun,
  TestFileResult,
  TestRunnerInfo,
} from "@crystal/core";

export type QualityLoadResult =
  | { source: "info"; data: TestRunnerInfo }
  | { source: "runs"; data: QualityRun[] }
  | { source: "coverage"; data: CoverageReport | null }
  | { source: "info" | "runs" | "coverage"; error: string };

interface QualityLoadRequests {
  info: () => Promise<TestRunnerInfo>;
  runs: () => Promise<QualityRun[]>;
  coverage: () => Promise<CoverageReport | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Publish each quality source as soon as it settles; none gates the others. */
export function loadQualitySources(
  requests: QualityLoadRequests,
  publish: (result: QualityLoadResult) => void,
): Promise<void[]> {
  const load = async <K extends keyof QualityLoadRequests>(source: K): Promise<void> => {
    try {
      const data = await requests[source]();
      publish({ source, data } as QualityLoadResult);
    } catch (error) {
      publish({ source, error: errorMessage(error) });
    }
  };
  return Promise.all([load("info"), load("runs"), load("coverage")]);
}

/** Run an imperative action while routing a rejection to the visible action error. */
export async function performQualityAction<T>(
  action: () => Promise<T>,
  publishError: (message: string) => void,
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    publishError(errorMessage(error));
    return null;
  }
}

export interface QualityRunProjection {
  /** Full-suite baseline (or the only available run). */
  baseRun: QualityRun | null;
  /** Latest one-file run layered over its file in the baseline. */
  rerun: QualityRun | null;
}

/** Keep a one-file rerun from impersonating the state of the whole suite. */
export function projectQualityRuns(
  runs: readonly QualityRun[],
  selectedRunId: string | null,
): QualityRunProjection {
  const selected = runs.find((run) => run.id === selectedRunId);
  if (selected) return { baseRun: selected, rerun: null };

  const latest = runs[0] ?? null;
  if (!latest?.scope.file) return { baseRun: latest, rerun: null };
  const fullRun = runs.find((run) => run.scope.file == null) ?? null;
  return fullRun ? { baseRun: fullRun, rerun: latest } : { baseRun: latest, rerun: null };
}

/** Overlay only the rerun's reported file; every other result remains from the baseline. */
export function projectQualityFiles(
  baseRun: QualityRun | null,
  rerun: QualityRun | null,
): Map<string, TestFileResult> {
  const byFile = new Map<string, TestFileResult>();
  for (const file of baseRun?.files ?? []) byFile.set(file.file, file);
  for (const file of rerun?.files ?? []) byFile.set(file.file, file);
  return byFile;
}

/** Reporter ancestry uses ` > `; runner name filters match the space-joined full name. */
export function testNamePattern(name: string): string {
  return name
    .split(" > ")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(" ");
}

export function latestCoverageRunWithoutData(runs: readonly QualityRun[]): QualityRun | null {
  return (
    runs.find(
      (run) => run.withCoverage && (run.status === "passed" || run.status === "failed"),
    ) ?? null
  );
}

export function coverageFileForPath(
  coverage: CoverageReport | null,
  selectedPath: string | null,
): FileCoverage | null {
  if (!coverage || !selectedPath) return null;
  return coverage.files.find((file) => file.path === selectedPath) ?? null;
}

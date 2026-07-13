/**
 * Quality — the workspace's test runner and coverage model. The server
 * detects the workspace's own test setup (vitest / jest / a package.json
 * `test` script), spawns runs with JSON reporters, streams progress as
 * `quality.runChanged` events, and parses istanbul coverage output into a
 * per-file summary the coverage visualiser renders.
 */

export type QualityViewId = "tests" | "coverage";

export type TestRunnerKind = "vitest" | "jest" | "script";

/** What `quality.detect` found — how (and whether) this workspace can run tests. */
export interface TestRunnerInfo {
  /** null: no test setup detected — the tests view explains instead of running. */
  runner: TestRunnerKind | null;
  /** Workspace-relative config file backing the detection, when one exists. */
  configFile: string | null;
  /** The package.json `test` script text (runner "script", or informational). */
  script: string | null;
  /** A coverage provider is resolvable — coverage runs are offered. */
  coverageCapable: boolean;
  /** Workspace-relative test files (capped), for the tree before any run. */
  testFiles: string[];
}

export type TestCaseStatus = "pass" | "fail" | "skip" | "todo";

export interface TestError {
  message: string;
  /** First relevant stack line, workspace-relative when resolvable. */
  stack?: string;
  expected?: string;
  actual?: string;
  /** 1-based line in the test file, when the reporter provides it. */
  line?: number;
}

export interface TestCaseResult {
  /** Full name including describe blocks, " > " separated. */
  name: string;
  status: TestCaseStatus;
  durationMs?: number;
  error?: TestError;
}

export interface TestFileResult {
  /** Workspace-relative test file path. */
  file: string;
  status: TestCaseStatus;
  durationMs?: number;
  tests: TestCaseResult[];
}

export type QualityRunStatus = "running" | "passed" | "failed" | "error" | "cancelled";

/** What subset a run targets; absent fields mean "all". */
export interface QualityRunScope {
  /** Run only this test file (workspace-relative). */
  file?: string;
  /** Filter to tests whose full name contains this (runner `-t`). */
  testName?: string;
}

export interface QualityRunSummary {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface QualityRun {
  id: string;
  status: QualityRunStatus;
  /** ISO-8601. */
  startedAt: string;
  finishedAt?: string;
  scope: QualityRunScope;
  withCoverage: boolean;
  summary?: QualityRunSummary;
  /** Per-file results — stream in while running, complete when settled. */
  files: TestFileResult[];
  /** Runner-level failure (spawn error, config error) — tail of stderr. */
  error?: string;
}

export interface CoverageMetric {
  covered: number;
  total: number;
  /** 0–100, one decimal. `total === 0` reports 100. */
  pct: number;
}

export interface FileCoverage {
  /** Workspace-relative source file path. */
  path: string;
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
  /** 1-based uncovered line numbers (capped; present when detail was parsed). */
  uncoveredLines?: number[];
}

export interface CoverageReport {
  /** ISO-8601 mtime of the coverage data this was parsed from. */
  generatedAt: string;
  total: {
    lines: CoverageMetric;
    statements: CoverageMetric;
    functions: CoverageMetric;
    branches: CoverageMetric;
  };
  files: FileCoverage[];
}

export function coveragePct(m: CoverageMetric): number {
  return m.total === 0 ? 100 : m.pct;
}

/** Traffic-light band for a coverage percentage — one convention everywhere. */
export function coverageBand(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 80) return "ok";
  if (pct >= 50) return "warn";
  return "danger";
}

/** Aggregate several metrics (directory rollups). */
export function sumCoverage(metrics: CoverageMetric[]): CoverageMetric {
  const covered = metrics.reduce((n, m) => n + m.covered, 0);
  const total = metrics.reduce((n, m) => n + m.total, 0);
  return { covered, total, pct: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10 };
}

import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Emitter,
  nowIso,
  type CoverageMetric,
  type CoverageReport,
  type FileCoverage,
  type QualityRun,
  type QualityRunScope,
  type QualityRunSummary,
  type TestCaseResult,
  type TestCaseStatus,
  type TestError,
  type TestFileResult,
  type TestRunnerInfo,
  type TestRunnerKind,
} from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";

/** Cap on test files listed by detect(). */
const MAX_TEST_FILES = 500;
/** Cap on uncovered line numbers reported per file. */
const MAX_UNCOVERED_LINES = 500;
/** Runs kept in history (the live run included). */
const MAX_RUN_HISTORY = 20;
/** Kill a runaway test run after this long. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** stdout/stderr tails kept per run. */
const MAX_TAIL_BYTES = 64 * 1024;

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NPM_PLACEHOLDER_SCRIPT = 'echo "Error: no test specified" && exit 1';

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
  "vitest.config.cts",
  "vitest.config.cjs",
];
const JEST_CONFIGS = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
];

// ---------------------------------------------------------------------------
// Arg building (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Strip everything outside a conservative allowlist. Runs go through
 * `shell: true` on Windows (the .cmd shims require it), which joins args into
 * a single command string — so user-provided test names must never carry
 * shell metacharacters (`&`, `|`, `"`, `` ` ``, `$`, `%`, `^`, …).
 */
export function sanitizeTestName(name: string): string {
  return name.replace(/[^\w\s.,:/#()[\]{}'>=<-]/g, "").trim();
}

/** Quote an arg for the win32 shell-joined command line when it needs it. */
function quoteArg(arg: string, windows: boolean): string {
  return windows && /\s/.test(arg) ? `"${arg}"` : arg;
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface RunArgScope {
  file?: string;
  testName?: string;
  coverage?: boolean;
}

/** CLI args for a scoped vitest run writing JSON results to `outputFile`. */
export function buildVitestArgs(
  scope: RunArgScope,
  outputFile: string,
  windows: boolean = process.platform === "win32",
): string[] {
  const args = ["run", "--reporter=default", "--reporter=json"];
  args.push(
    windows && /\s/.test(outputFile) ? `--outputFile="${outputFile}"` : `--outputFile=${outputFile}`,
  );
  if (scope.file) args.push(quoteArg(normalizeRel(scope.file), windows));
  if (scope.testName) {
    const name = sanitizeTestName(scope.testName);
    args.push("-t", windows ? `"${name}"` : name);
  }
  if (scope.coverage) {
    args.push("--coverage.enabled", "--coverage.reporter=json", "--coverage.reporter=json-summary");
  }
  return args;
}

/** CLI args for a scoped jest run writing JSON results to `outputFile`. */
export function buildJestArgs(
  scope: RunArgScope,
  outputFile: string,
  windows: boolean = process.platform === "win32",
): string[] {
  const args = ["--json"];
  args.push(
    windows && /\s/.test(outputFile) ? `--outputFile="${outputFile}"` : `--outputFile=${outputFile}`,
  );
  args.push("--testLocationInResults");
  if (scope.file) args.push("--runTestsByPath", quoteArg(normalizeRel(scope.file), windows));
  if (scope.testName) {
    const name = sanitizeTestName(scope.testName);
    args.push("-t", windows ? `"${name}"` : name);
  }
  if (scope.coverage) {
    args.push("--coverage", "--coverageReporters=json", "--coverageReporters=json-summary");
  }
  return args;
}

// ---------------------------------------------------------------------------
// Reporter JSON parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

interface JestishAssertion {
  ancestorTitles?: string[];
  title?: string;
  fullName?: string;
  status?: string;
  duration?: number | null;
  failureMessages?: string[];
  location?: { line?: number; column?: number } | null;
}

interface JestishTestResult {
  name?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  perfStats?: { start?: number; end?: number; runtime?: number };
  assertionResults?: JestishAssertion[];
}

interface JestishJson {
  testResults?: JestishTestResult[];
}

function mapCaseStatus(status: string | undefined): TestCaseStatus {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "todo":
      return "todo";
    default:
      // pending / skipped / disabled / focused-out
      return "skip";
  }
}

/** A stack frame line like `    at fn (C:\ws\a.test.ts:12:3)` or `    at /ws/a.test.ts:12:3`. */
const STACK_FRAME_RE = /^\s+at\s+(?:.*?\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Build a TestError from a jest/vitest failure message: strip ANSI codes,
 * separate the message from the stack, pull `Expected:` / `Received:` lines
 * and locate the first stack frame that points at the test file itself.
 */
function extractError(rawMessage: string, root: string, relTestFile: string): TestError {
  const clean = stripAnsi(rawMessage);
  const lines = clean.split(/\r?\n/);
  const firstStackIdx = lines.findIndex((l) => STACK_FRAME_RE.test(l));
  const messageLines = firstStackIdx === -1 ? lines : lines.slice(0, firstStackIdx);
  const message = messageLines.join("\n").trim().slice(0, 2000) || clean.trim().slice(0, 2000);

  const error: TestError = { message };

  const expected = /^\s*Expected:\s*(.+)$/m.exec(clean);
  const actual = /^\s*Received:\s*(.+)$/m.exec(clean);
  if (expected?.[1]) error.expected = expected[1].trim();
  if (actual?.[1]) error.actual = actual[1].trim();

  const wanted = normalizeRel(relTestFile).toLowerCase();
  let firstFrame: { line: string; file: string; lineNo: number } | null = null;
  for (const line of firstStackIdx === -1 ? [] : lines.slice(firstStackIdx)) {
    const m = STACK_FRAME_RE.exec(line);
    if (!m) continue;
    const file = (m[1] ?? "").replace(/\\/g, "/");
    const lineNo = Number(m[2]);
    if (!firstFrame) firstFrame = { line, file, lineNo };
    if (file.toLowerCase().endsWith(wanted)) {
      error.line = lineNo;
      error.stack = frameText(line, root);
      return error;
    }
  }
  if (firstFrame) error.stack = frameText(firstFrame.line, root);
  return error;
}

/** Trim a stack line and relativize an absolute workspace path inside it. */
function frameText(line: string, root: string): string {
  const rootFwd = root.replace(/\\/g, "/");
  return line
    .trim()
    .replace(/\\/g, "/")
    .split(rootFwd + "/")
    .join("")
    .slice(0, 500);
}

/** Workspace-relative forward-slash path; null when outside the root. */
function relativeTo(root: string, filePath: string): string | null {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export interface ParsedRunResults {
  files: TestFileResult[];
  summary: QualityRunSummary;
}

/**
 * Map jest-shaped JSON reporter output (jest `--json` and vitest
 * `--reporter=json` share the format) to the core result model.
 */
export function parseJestishJson(json: unknown, root: string): ParsedRunResults | null {
  const data = json as JestishJson | null;
  if (!data || typeof data !== "object" || !Array.isArray(data.testResults)) return null;

  const files: TestFileResult[] = [];
  for (const tr of data.testResults) {
    const relFile = typeof tr.name === "string" ? (relativeTo(root, tr.name) ?? normalizeRel(tr.name)) : "";
    const tests: TestCaseResult[] = [];
    for (const assertion of tr.assertionResults ?? []) {
      const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
      const title = assertion.title ?? assertion.fullName ?? "(unnamed test)";
      const status = mapCaseStatus(assertion.status);
      const test: TestCaseResult = {
        name: [...ancestors, title].filter(Boolean).join(" > "),
        status,
      };
      if (typeof assertion.duration === "number") test.durationMs = assertion.duration;
      if (status === "fail") {
        const raw = assertion.failureMessages?.[0];
        test.error = raw ? extractError(raw, root, relFile) : { message: "Test failed" };
        if (test.error.line === undefined && typeof assertion.location?.line === "number") {
          test.error.line = assertion.location.line;
        }
      }
      tests.push(test);
    }

    const fileStatus: TestCaseStatus = tests.some((t) => t.status === "fail")
      ? "fail"
      : tests.some((t) => t.status === "pass")
        ? "pass"
        : tests.some((t) => t.status === "skip")
          ? "skip"
          : tests.length > 0
            ? "todo"
            : mapCaseStatus(tr.status);

    const file: TestFileResult = { file: relFile, status: fileStatus, tests };
    const duration = fileDuration(tr, tests);
    if (duration !== undefined) file.durationMs = duration;
    files.push(file);
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const f of files) {
    for (const t of f.tests) {
      if (t.status === "pass") passed++;
      else if (t.status === "fail") failed++;
      else skipped++;
    }
  }
  const summary: QualityRunSummary = {
    files: files.length,
    passed,
    failed,
    skipped,
    durationMs: Math.round(files.reduce((n, f) => n + (f.durationMs ?? 0), 0)),
  };
  return { files, summary };
}

function fileDuration(tr: JestishTestResult, tests: TestCaseResult[]): number | undefined {
  if (typeof tr.startTime === "number" && typeof tr.endTime === "number" && tr.endTime >= tr.startTime) {
    return tr.endTime - tr.startTime;
  }
  if (typeof tr.perfStats?.runtime === "number") return tr.perfStats.runtime;
  const sum = tests.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

/** vitest `--reporter=json` output is jest-shaped — same parser. */
export const parseVitestJson = parseJestishJson;
/** jest `--json` output. */
export const parseJestJson = parseJestishJson;

// ---------------------------------------------------------------------------
// Istanbul coverage parsing (pure, exported for tests)
// ---------------------------------------------------------------------------

interface IstanbulLoc {
  start?: { line?: number };
}

interface IstanbulFileEntry {
  path?: string;
  statementMap?: Record<string, IstanbulLoc>;
  s?: Record<string, number>;
  fnMap?: Record<string, unknown>;
  f?: Record<string, number>;
  branchMap?: Record<string, unknown>;
  b?: Record<string, number[]>;
  data?: IstanbulFileEntry;
}

function metric(covered: number, total: number): CoverageMetric {
  return {
    covered,
    total,
    pct: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10,
  };
}

/**
 * Parse istanbul `coverage-final.json` into the core coverage model. Paths
 * become workspace-relative (files outside the root are skipped); line
 * coverage derives from statement start-lines. Returns null when the map is
 * empty (no files inside the workspace).
 */
export function parseIstanbulCoverage(
  json: unknown,
  root: string,
  generatedAt: string,
): CoverageReport | null {
  if (!json || typeof json !== "object") return null;
  const files: FileCoverage[] = [];

  for (const [key, rawEntry] of Object.entries(json as Record<string, IstanbulFileEntry>)) {
    const entry = rawEntry?.data ?? rawEntry;
    if (!entry || typeof entry !== "object") continue;
    const filePath = typeof entry.path === "string" ? entry.path : key;
    const rel = relativeTo(root, filePath);
    if (!rel) continue;

    const statementMap = entry.statementMap ?? {};
    const s = entry.s ?? {};
    const stmtIds = Object.keys(statementMap);
    const stmtCovered = stmtIds.filter((id) => (s[id] ?? 0) > 0).length;

    const f = entry.f ?? {};
    const fnIds = Object.keys(entry.fnMap ?? {});
    const fnCovered = fnIds.filter((id) => (f[id] ?? 0) > 0).length;

    const b = entry.b ?? {};
    let branchTotal = 0;
    let branchCovered = 0;
    for (const id of Object.keys(entry.branchMap ?? {})) {
      const hits = Array.isArray(b[id]) ? b[id] : [];
      branchTotal += hits.length;
      branchCovered += hits.filter((n) => n > 0).length;
    }

    // A line = the set of statement start-lines; covered when any statement
    // starting on it ran.
    const lineHit = new Map<number, boolean>();
    for (const id of stmtIds) {
      const line = statementMap[id]?.start?.line;
      if (typeof line !== "number") continue;
      lineHit.set(line, (lineHit.get(line) ?? false) || (s[id] ?? 0) > 0);
    }
    const allLines = [...lineHit.keys()].sort((a, z) => a - z);
    const coveredLines = allLines.filter((l) => lineHit.get(l)).length;
    const uncoveredLines = allLines.filter((l) => !lineHit.get(l)).slice(0, MAX_UNCOVERED_LINES);

    files.push({
      path: rel,
      lines: metric(coveredLines, allLines.length),
      statements: metric(stmtCovered, stmtIds.length),
      functions: metric(fnCovered, fnIds.length),
      branches: metric(branchCovered, branchTotal),
      uncoveredLines,
    });
  }

  if (files.length === 0) return null;
  files.sort((a, z) => a.path.localeCompare(z.path));

  const sum = (pick: (f: FileCoverage) => CoverageMetric): CoverageMetric => {
    const covered = files.reduce((n, f) => n + pick(f).covered, 0);
    const total = files.reduce((n, f) => n + pick(f).total, 0);
    return metric(covered, total);
  };

  return {
    generatedAt,
    total: {
      lines: sum((f) => f.lines),
      statements: sum((f) => f.statements),
      functions: sum((f) => f.functions),
      branches: sum((f) => f.branches),
    },
    files,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  jest?: unknown;
}

interface DetectedCore {
  runner: TestRunnerKind | null;
  configFile: string | null;
  script: string | null;
  coverageCapable: boolean;
}

interface LiveRun {
  run: QualityRun;
  child: ChildProcess;
  mode: TestRunnerKind;
  tmpJson: string | null;
  cancelled: boolean;
  timedOut: boolean;
  timer: NodeJS.Timeout;
  stdoutTail: string;
  stderrTail: string;
}

/**
 * Test-runner + coverage service for one workspace. Detects the workspace's
 * own test setup, spawns scoped runs with JSON reporters (one live run at a
 * time), keeps a capped run history and parses istanbul coverage output —
 * emitting `runChanged` / `coverageChanged` as things move.
 */
export class QualityService {
  readonly events = new Emitter<{
    runChanged: { run: QualityRun };
    coverageChanged: Record<string, never>;
  }>();

  private history: QualityRun[] = [];
  private live: LiveRun | null = null;
  private counter = 0;
  private coverageCache: { mtimeMs: number; report: CoverageReport | null } | null = null;
  private readonly coverageFinalPath: string;
  private disposed = false;

  constructor(private readonly root: string) {
    this.coverageFinalPath = path.join(root, "coverage", "coverage-final.json");
    // Poll-watch coverage output — catches coverage produced outside Crystal
    // too (fs.watchFile tolerates the file not existing yet).
    fsSync.watchFile(this.coverageFinalPath, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        this.coverageCache = null;
        this.events.emit("coverageChanged", {});
      }
    });
  }

  // -- detect ---------------------------------------------------------------

  async detect(): Promise<TestRunnerInfo> {
    const core = await this.detectCore();
    return { ...core, testFiles: await this.collectTestFiles() };
  }

  private async detectCore(): Promise<DetectedCore> {
    const pkg = await this.readPackageJson();
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const rawScript = typeof pkg.scripts?.test === "string" ? pkg.scripts.test : null;
    const script = rawScript && rawScript.trim() !== NPM_PLACEHOLDER_SCRIPT ? rawScript : null;

    const vitestConfig = await this.firstExisting(VITEST_CONFIGS);
    if (vitestConfig || deps["vitest"]) {
      const coverageCapable =
        Boolean(deps["@vitest/coverage-v8"] || deps["@vitest/coverage-istanbul"]) ||
        (await this.dirExists(path.join(this.root, "node_modules", "@vitest", "coverage-v8"))) ||
        (await this.dirExists(path.join(this.root, "node_modules", "@vitest", "coverage-istanbul")));
      return { runner: "vitest", configFile: vitestConfig, script, coverageCapable };
    }

    const jestConfig = await this.firstExisting(JEST_CONFIGS);
    if (jestConfig || pkg.jest !== undefined || deps["jest"]) {
      // jest bundles its own coverage collection.
      return { runner: "jest", configFile: jestConfig, script, coverageCapable: true };
    }

    if (script) return { runner: "script", configFile: null, script, coverageCapable: false };
    return { runner: null, configFile: null, script, coverageCapable: false };
  }

  private async readPackageJson(): Promise<PackageJson> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.root, "package.json"), "utf8")) as PackageJson;
    } catch {
      return {};
    }
  }

  private async firstExisting(names: string[]): Promise<string | null> {
    for (const name of names) {
      if (await this.fileExists(path.join(this.root, name))) return name;
    }
    return null;
  }

  private fileExists(abs: string): Promise<boolean> {
    return fs.stat(abs).then((st) => st.isFile(), () => false);
  }

  private dirExists(abs: string): Promise<boolean> {
    return fs.stat(abs).then((st) => st.isDirectory(), () => false);
  }

  private async collectTestFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= MAX_TEST_FILES) return;
      let entries: fsSync.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, z) => a.name.localeCompare(z.name));
      for (const entry of entries) {
        if (out.length >= MAX_TEST_FILES) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!isIgnoredDir(entry.name)) await walk(abs);
        } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
          out.push(toRelPath(this.root, abs));
        }
      }
    };
    await walk(this.root);
    return out.sort();
  }

  // -- run ------------------------------------------------------------------

  async run(params: { file?: string; testName?: string; coverage?: boolean }): Promise<{ run: QualityRun }> {
    if (this.live && this.live.run.status === "running") {
      throw new Error("A test run is already in progress");
    }

    // Validate the file scope before creating the run — traversal throws.
    const scopeFile = params.file ? normalizeRel(params.file) : undefined;
    if (scopeFile) resolveInRoot(this.root, scopeFile);

    const core = await this.detectCore();
    const scope: QualityRunScope = {};
    if (scopeFile) scope.file = scopeFile;
    if (params.testName) scope.testName = params.testName;

    const run: QualityRun = {
      id: `q-${++this.counter}`,
      status: "running",
      startedAt: nowIso(),
      scope,
      withCoverage: false,
      files: [],
    };
    this.history.unshift(run);
    if (this.history.length > MAX_RUN_HISTORY) this.history.length = MAX_RUN_HISTORY;
    this.emitRun(run);

    // Resolve which mode actually executes: vitest/jest need their local
    // binary; fall back to the package.json test script when it's missing.
    const win = process.platform === "win32";
    let mode: TestRunnerKind | null = core.runner;
    let bin: string | null = null;
    if (mode === "vitest" || mode === "jest") {
      const candidate = path.join(this.root, "node_modules", ".bin", mode + (win ? ".cmd" : ""));
      if (await this.fileExists(candidate)) {
        bin = candidate;
      } else if (core.script) {
        mode = "script";
      } else {
        return this.settleEarly(
          run,
          "error",
          `${mode} is configured but its binary is missing (expected ${toRelPath(this.root, candidate)}). Install dependencies first.`,
        );
      }
    }
    if (mode === null) {
      return this.settleEarly(run, "error", "No test runner detected in this workspace.");
    }

    run.withCoverage = Boolean(params.coverage) && mode !== "script" && core.coverageCapable;

    let cmd: string;
    let args: string[];
    let tmpJson: string | null = null;
    if (mode === "script") {
      cmd = (await this.fileExists(path.join(this.root, "pnpm-lock.yaml")))
        ? "pnpm"
        : (await this.fileExists(path.join(this.root, "yarn.lock")))
          ? "yarn"
          : "npm";
      args = ["test"];
    } else {
      tmpJson = path.join(os.tmpdir(), `crystal-quality-${run.id}.json`);
      const argScope: RunArgScope = {
        file: scope.file,
        testName: scope.testName,
        coverage: run.withCoverage,
      };
      args = mode === "vitest" ? buildVitestArgs(argScope, tmpJson, win) : buildJestArgs(argScope, tmpJson, win);
      cmd = win && /\s/.test(bin!) ? `"${bin!}"` : bin!;
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: this.root,
        // vitest/jest/pnpm are .cmd shims on Windows npm installs.
        shell: win,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return this.settleEarly(run, "error", `Failed to spawn ${mode}: ${(err as Error).message}`);
    }

    const live: LiveRun = {
      run,
      child,
      mode,
      tmpJson,
      cancelled: false,
      timedOut: false,
      timer: setTimeout(() => {
        live.timedOut = true;
        this.killTree(child);
      }, RUN_TIMEOUT_MS),
      stdoutTail: "",
      stderrTail: "",
    };
    this.live = live;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      live.stdoutTail = (live.stdoutTail + chunk).slice(-MAX_TAIL_BYTES);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      live.stderrTail = (live.stderrTail + chunk).slice(-MAX_TAIL_BYTES);
    });

    child.on("error", (err) => {
      void this.settle(live, null, `Failed to spawn ${mode}: ${err.message}`);
    });
    child.on("close", (code) => {
      void this.settle(live, code, null);
    });

    return { run: { ...run } };
  }

  /** Settle a run that never got a process off the ground. */
  private settleEarly(run: QualityRun, status: "error", message: string): { run: QualityRun } {
    run.status = status;
    run.error = message;
    run.finishedAt = nowIso();
    this.emitRun(run);
    return { run: { ...run } };
  }

  private async settle(live: LiveRun, exitCode: number | null, spawnError: string | null): Promise<void> {
    const { run } = live;
    if (run.status !== "running") return; // error + close both fire — first wins
    clearTimeout(live.timer);
    if (this.live === live) this.live = null;

    const tail = () => (live.stderrTail + live.stdoutTail).trim().slice(-2000);

    if (live.cancelled) {
      run.status = "cancelled";
    } else if (spawnError) {
      run.status = "error";
      run.error = spawnError;
    } else if (live.timedOut) {
      run.status = "error";
      run.error = `Test run timed out after ${RUN_TIMEOUT_MS / 60000} minutes.\n${tail()}`.trim();
    } else if (live.mode === "script") {
      run.status = exitCode === 0 ? "passed" : "failed";
      if (exitCode !== 0) run.error = tail();
    } else {
      // Failing tests exit non-zero but still write valid JSON — always
      // prefer the reporter output over the exit code.
      const parsed = await this.readRunJson(live.tmpJson);
      if (parsed) {
        run.files = parsed.files;
        run.summary = parsed.summary;
        run.status = parsed.summary.failed > 0 ? "failed" : "passed";
      } else if (exitCode !== 0 && this.looksLikeRunnerFailure(live.stderrTail)) {
        run.status = "error";
        run.error = tail();
      } else if (exitCode !== 0) {
        run.status = "failed";
        run.error = tail();
      } else {
        run.status = "error";
        run.error = `Runner exited 0 but produced no JSON results.\n${tail()}`.trim();
      }
    }

    if (live.tmpJson) await fs.unlink(live.tmpJson).catch(() => {});
    run.finishedAt = nowIso();
    this.emitRun(run);

    if (run.withCoverage && (run.status === "passed" || run.status === "failed")) {
      this.coverageCache = null;
      await this.readCoverage();
      this.events.emit("coverageChanged", {});
    }
  }

  private async readRunJson(tmpJson: string | null): Promise<ParsedRunResults | null> {
    if (!tmpJson) return null;
    try {
      const raw = await fs.readFile(tmpJson, "utf8");
      return parseJestishJson(JSON.parse(raw), this.root);
    } catch {
      return null;
    }
  }

  private looksLikeRunnerFailure(stderr: string): boolean {
    return /(failed to load config|cannot find module|cannot find package|ENOENT|is not recognized|command not found|SyntaxError|Error: Cannot)/i.test(
      stderr,
    );
  }

  private emitRun(run: QualityRun): void {
    this.events.emit("runChanged", { run: { ...run } });
  }

  // -- cancel / runs --------------------------------------------------------

  async cancel(runId: string): Promise<{ ok: true }> {
    const live = this.live;
    if (live && live.run.id === runId && live.run.status === "running") {
      live.cancelled = true;
      this.killTree(live.child);
    }
    return { ok: true }; // idempotent — already-settled runs are fine
  }

  private killTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      // Kill the whole tree — the .cmd shim spawns node underneath.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false });
    } else {
      child.kill("SIGTERM");
    }
  }

  async runs(): Promise<{ runs: QualityRun[] }> {
    return { runs: this.history.map((r) => ({ ...r })) };
  }

  // -- coverage -------------------------------------------------------------

  async coverage(): Promise<{ coverage: CoverageReport | null }> {
    return { coverage: await this.readCoverage() };
  }

  private async readCoverage(): Promise<CoverageReport | null> {
    let st: fsSync.Stats;
    try {
      st = await fs.stat(this.coverageFinalPath);
    } catch {
      this.coverageCache = null;
      return null;
    }
    if (this.coverageCache && this.coverageCache.mtimeMs === st.mtimeMs) {
      return this.coverageCache.report;
    }
    try {
      const json = JSON.parse(await fs.readFile(this.coverageFinalPath, "utf8")) as unknown;
      const report = parseIstanbulCoverage(json, this.root, st.mtime.toISOString());
      this.coverageCache = { mtimeMs: st.mtimeMs, report };
      return report;
    } catch {
      return null;
    }
  }

  // -- dispose --------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.live) {
      clearTimeout(this.live.timer);
      this.live.cancelled = true;
      this.killTree(this.live.child);
      this.live = null;
    }
    fsSync.unwatchFile(this.coverageFinalPath);
    this.events.clear();
  }
}

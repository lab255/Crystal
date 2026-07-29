import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  QualityService,
  buildJestArgs,
  buildPlaywrightArgs,
  buildVitestArgs,
  owningPackageDir,
  parseIstanbulCoverage,
  parseJestJson,
  parseJestishJson,
  parsePlaywrightJson,
  parseVitestJson,
  pickSetupForFile,
  planRunJobs,
  sanitizeTestName,
} from "./quality-runner.js";
import type { PackageTestSetup } from "@crystal/core";

/** Platform-appropriate fake workspace root (C:\ws on Windows, /ws on posix). */
const ROOT = path.resolve(path.sep, "ws");
const ESC = String.fromCharCode(27);
const red = (s: string) => `${ESC}[31m${s}${ESC}[39m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[39m`;

// ---------------------------------------------------------------------------
// parseIstanbulCoverage
// ---------------------------------------------------------------------------

describe("parseIstanbulCoverage", () => {
  const fileA = path.join(ROOT, "src", "a.ts"); // fully covered
  const fileB = path.join(ROOT, "src", "b.ts"); // partially covered
  const fileC = path.join(ROOT, "src", "c.ts"); // empty (no statements)
  const outside = path.resolve(path.sep, "elsewhere", "d.ts");

  const fixture = {
    [fileA]: {
      path: fileA,
      statementMap: { "0": { start: { line: 1 } }, "1": { start: { line: 2 } } },
      s: { "0": 3, "1": 1 },
      fnMap: { "0": {} },
      f: { "0": 2 },
      branchMap: { "0": {} },
      b: { "0": [1, 2] },
    },
    [fileB]: {
      path: fileB,
      statementMap: {
        "0": { start: { line: 1 } },
        "1": { start: { line: 2 } },
        "2": { start: { line: 4 } },
        "3": { start: { line: 4 } }, // two statements on line 4
      },
      s: { "0": 1, "1": 0, "2": 0, "3": 0 },
      fnMap: { "0": {}, "1": {} },
      f: { "0": 1, "1": 0 },
      branchMap: { "0": {}, "1": {} },
      b: { "0": [1, 0], "1": [0, 0] },
    },
    [fileC]: { path: fileC, statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} },
    [outside]: {
      path: outside,
      statementMap: { "0": { start: { line: 1 } } },
      s: { "0": 0 },
      fnMap: {},
      f: {},
      branchMap: {},
      b: {},
    },
  };

  it("maps files to workspace-relative metrics and skips files outside the root", () => {
    const report = parseIstanbulCoverage(fixture, ROOT, "2026-07-13T00:00:00.000Z");
    expect(report).not.toBeNull();
    expect(report!.generatedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(report!.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("computes per-file statement/function/branch/line metrics", () => {
    const report = parseIstanbulCoverage(fixture, ROOT, "x")!;
    const a = report.files[0]!;
    const b = report.files[1]!;
    const c = report.files[2]!;

    expect(a.statements).toEqual({ covered: 2, total: 2, pct: 100 });
    expect(a.functions).toEqual({ covered: 1, total: 1, pct: 100 });
    expect(a.branches).toEqual({ covered: 2, total: 2, pct: 100 });
    expect(a.lines).toEqual({ covered: 2, total: 2, pct: 100 });
    expect(a.uncoveredLines).toEqual([]);

    expect(b.statements).toEqual({ covered: 1, total: 4, pct: 25 });
    expect(b.functions).toEqual({ covered: 1, total: 2, pct: 50 });
    // Each branch-arm counts individually: [1,0] + [0,0] = 1/4.
    expect(b.branches).toEqual({ covered: 1, total: 4, pct: 25 });
    // Lines derive from statement start-lines: {1: hit, 2: miss, 4: miss}.
    expect(b.lines).toEqual({ covered: 1, total: 3, pct: 33.3 });
    expect(b.uncoveredLines).toEqual([2, 4]);

    // No statements at all → everything 100 by convention.
    expect(c.statements).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(c.lines.pct).toBe(100);
    expect(c.branches.pct).toBe(100);
  });

  it("sums totals across files with one-decimal rounding", () => {
    const report = parseIstanbulCoverage(fixture, ROOT, "x")!;
    expect(report.total.statements).toEqual({ covered: 3, total: 6, pct: 50 });
    expect(report.total.functions).toEqual({ covered: 2, total: 3, pct: 66.7 });
    expect(report.total.branches).toEqual({ covered: 3, total: 6, pct: 50 });
    expect(report.total.lines).toEqual({ covered: 3, total: 5, pct: 60 });
  });

  it("returns null for empty or invalid maps", () => {
    expect(parseIstanbulCoverage({}, ROOT, "x")).toBeNull();
    expect(parseIstanbulCoverage(null, ROOT, "x")).toBeNull();
    expect(parseIstanbulCoverage("nope", ROOT, "x")).toBeNull();
    // Only files outside the root → effectively empty.
    expect(parseIstanbulCoverage({ [outside]: fixture[outside] }, ROOT, "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// vitest/jest reporter JSON mapping
// ---------------------------------------------------------------------------

describe("parseJestishJson", () => {
  const fooAbs = path.join(ROOT, "src", "foo.test.ts");
  const barAbs = path.join(ROOT, "src", "bar.test.ts");

  const failureMessage =
    red("Error: expect(received).toBe(expected) // Object.is equality") +
    "\n\n" +
    `Expected: ${green("3")}\n` +
    `Received: ${red("2")}\n` +
    `    at Object.<anonymous> (${fooAbs}:12:15)\n` +
    "    at processTicksAndRejections (node:internal/process/task_queues:95:5)";

  const fixture = {
    numTotalTests: 5,
    testResults: [
      {
        name: fooAbs,
        status: "failed",
        startTime: 1000,
        endTime: 1500,
        assertionResults: [
          { ancestorTitles: ["math"], title: "adds", fullName: "math adds", status: "passed", duration: 5 },
          {
            ancestorTitles: ["math"],
            title: "compares",
            fullName: "math compares",
            status: "failed",
            duration: 7,
            failureMessages: [failureMessage],
            location: { line: 11, column: 3 },
          },
          { ancestorTitles: [], title: "later", fullName: "later", status: "pending" },
          { ancestorTitles: [], title: "someday", fullName: "someday", status: "todo" },
        ],
      },
      {
        name: barAbs,
        status: "passed",
        startTime: 2000,
        endTime: 2100,
        assertionResults: [
          { ancestorTitles: [], title: "works", fullName: "works", status: "passed", duration: 3 },
        ],
      },
    ],
  };

  it("maps statuses, names and workspace-relative paths", () => {
    const parsed = parseJestishJson(fixture, ROOT)!;
    expect(parsed.files.map((f) => f.file)).toEqual(["src/foo.test.ts", "src/bar.test.ts"]);
    const foo = parsed.files[0]!;
    const bar = parsed.files[1]!;
    expect(foo.status).toBe("fail");
    expect(bar.status).toBe("pass");
    expect(foo.tests.map((t) => t.status)).toEqual(["pass", "fail", "skip", "todo"]);
    expect(foo.tests[0]!.name).toBe("math > adds");
    expect(foo.tests[1]!.name).toBe("math > compares");
    expect(foo.durationMs).toBe(500);
    expect(bar.durationMs).toBe(100);
  });

  it("extracts errors: ANSI stripped, expected/actual, line from the test-file stack frame", () => {
    const parsed = parseJestishJson(fixture, ROOT)!;
    const error = parsed.files[0]!.tests[1]!.error!;
    expect(error.message).toContain("expect(received).toBe(expected)");
    expect(error.message).not.toContain(ESC);
    expect(error.expected).toBe("3");
    expect(error.actual).toBe("2");
    // From the stack frame pointing at the test file — not location.line (11).
    expect(error.line).toBe(12);
    expect(error.stack).toContain("src/foo.test.ts:12:15");
  });

  it("falls back to the reporter location when no stack frame hits the test file", () => {
    const parsed = parseJestishJson(
      {
        testResults: [
          {
            name: fooAbs,
            status: "failed",
            assertionResults: [
              {
                ancestorTitles: [],
                title: "boom",
                status: "failed",
                failureMessages: ["Error: boom\n    at helper (node:internal/foo:1:1)"],
                location: { line: 42, column: 1 },
              },
            ],
          },
        ],
      },
      ROOT,
    )!;
    expect(parsed.files[0]!.tests[0]!.error!.line).toBe(42);
  });

  it("computes the run summary (todo/pending count as skipped)", () => {
    const parsed = parseJestishJson(fixture, ROOT)!;
    expect(parsed.summary).toEqual({
      files: 2,
      passed: 2,
      failed: 1,
      skipped: 2,
      durationMs: 600,
    });
  });

  it("returns null for non-reporter JSON and shares one impl for vitest/jest", () => {
    expect(parseJestishJson({}, ROOT)).toBeNull();
    expect(parseJestishJson(null, ROOT)).toBeNull();
    expect(parseVitestJson).toBe(parseJestishJson);
    expect(parseJestJson).toBe(parseJestishJson);
  });
});

// ---------------------------------------------------------------------------
// Arg building + sanitization
// ---------------------------------------------------------------------------

describe("arg building", () => {
  const out = "/tmp/crystal-quality-q-1.json";

  it("builds baseline vitest args", () => {
    expect(buildVitestArgs({}, out, false)).toEqual([
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${out}`,
    ]);
  });

  it("builds baseline jest args", () => {
    expect(buildJestArgs({}, out, false)).toEqual([
      "--json",
      `--outputFile=${out}`,
      "--testLocationInResults",
    ]);
  });

  it("adds coverage flags per runner", () => {
    expect(buildVitestArgs({ coverage: true }, out, false)).toContain("--coverage.enabled");
    expect(buildVitestArgs({ coverage: true }, out, false)).toContain("--coverage.reporter=json");
    expect(buildVitestArgs({ coverage: true }, out, false)).toContain(
      "--coverage.reporter=json-summary",
    );
    const jest = buildJestArgs({ coverage: true }, out, false);
    expect(jest).toContain("--coverage");
    expect(jest).toContain("--coverageReporters=json");
    expect(jest).toContain("--coverageReporters=json-summary");
  });

  it("scopes to a file with forward slashes, quoting spaces on windows", () => {
    expect(buildVitestArgs({ file: "src\\deep\\a.test.ts" }, out, false)).toContain(
      "src/deep/a.test.ts",
    );
    expect(buildVitestArgs({ file: "src/my tests/a.test.ts" }, out, true)).toContain(
      '"src/my tests/a.test.ts"',
    );
    const jest = buildJestArgs({ file: "src/a.test.ts" }, out, false);
    expect(jest.slice(-2)).toEqual(["--runTestsByPath", "src/a.test.ts"]);
  });

  it("sanitizes test names of shell metacharacters and quotes them on windows", () => {
    expect(sanitizeTestName('adds 1 + 1 & del "everything" | rm $HOME `boom`')).toBe(
      "adds 1  1  del everything  rm HOME boom",
    );
    expect(sanitizeTestName("renders <App/> (variant #2) > nested [case]")).toBe(
      "renders <App/> (variant #2) > nested [case]",
    );
    const win = buildVitestArgs({ testName: 'evil & "name"' }, out, true);
    expect(win.slice(-2)).toEqual(["-t", '"evil  name"']);
    const posix = buildJestArgs({ testName: 'evil & "name"' }, out, false);
    expect(posix.slice(-2)).toEqual(["-t", "evil  name"]);
  });

  it("quotes an output file containing spaces on windows", () => {
    const spaced = "C:\\Users\\Some One\\Temp\\out.json";
    expect(buildVitestArgs({}, spaced, true)).toContain(`--outputFile="${spaced}"`);
    expect(buildJestArgs({}, spaced, true)).toContain(`--outputFile="${spaced}"`);
  });
});

// ---------------------------------------------------------------------------
// detect() against temp workspaces
// ---------------------------------------------------------------------------

describe("QualityService.detect", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function makeWorkspace(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-quality-test-"));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    }
    return dir;
  }

  async function detectIn(files: Record<string, string>) {
    const root = await makeWorkspace(files);
    const service = new QualityService(root);
    try {
      return await service.detect();
    } finally {
      service.dispose();
    }
  }

  it("detects vitest via config file, with a resolvable coverage provider", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
      "vitest.config.ts": "export default {};",
      "node_modules/@vitest/coverage-v8/package.json": "{}",
      "src/b.test.ts": "",
      "src/a.spec.tsx": "",
      "src/not-a-test.ts": "",
      "node_modules/pkg/x.test.ts": "",
      "dist/y.test.ts": "",
    });
    expect(info.runner).toBe("vitest");
    expect(info.configFile).toBe("vitest.config.ts");
    expect(info.coverageCapable).toBe(true);
    expect(info.script).toBeNull();
    // Ignored dirs (node_modules, dist) are excluded; results sorted.
    expect(info.testFiles).toEqual(["src/a.spec.tsx", "src/b.test.ts"]);
  });

  it("detects vitest via deps alone, without coverage capability", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
    });
    expect(info.runner).toBe("vitest");
    expect(info.configFile).toBeNull();
    expect(info.coverageCapable).toBe(false);
  });

  it("detects jest via the package.json jest key (coverage bundled)", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ jest: { testEnvironment: "node" } }),
    });
    expect(info.runner).toBe("jest");
    expect(info.coverageCapable).toBe(true);
  });

  it("detects jest via a config file", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({}),
      "jest.config.js": "module.exports = {};",
    });
    expect(info.runner).toBe("jest");
    expect(info.configFile).toBe("jest.config.js");
  });

  it("falls back to a real test script", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ scripts: { test: "node run-tests.js" } }),
    });
    expect(info.runner).toBe("script");
    expect(info.script).toBe("node run-tests.js");
    expect(info.coverageCapable).toBe(false);
  });

  it("treats the npm placeholder script as no runner", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    });
    expect(info.runner).toBeNull();
    expect(info.script).toBeNull();
  });

  it("reports no runner for an empty workspace", async () => {
    const info = await detectIn({});
    expect(info.runner).toBeNull();
    expect(info.testFiles).toEqual([]);
  });

  it("returns null coverage when no istanbul output exists", async () => {
    const root = await makeWorkspace({});
    const service = new QualityService(root);
    try {
      expect((await service.coverage()).coverage).toBeNull();
      expect((await service.runs()).runs).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("parses istanbul output from disk with the file mtime as generatedAt", async () => {
    const root = await makeWorkspace({});
    const src = path.join(root, "src", "x.ts");
    await fs.mkdir(path.join(root, "coverage"), { recursive: true });
    await fs.writeFile(
      path.join(root, "coverage", "coverage-final.json"),
      JSON.stringify({
        [src]: {
          path: src,
          statementMap: { "0": { start: { line: 1 } }, "1": { start: { line: 2 } } },
          s: { "0": 1, "1": 0 },
          fnMap: {},
          f: {},
          branchMap: {},
          b: {},
        },
      }),
      "utf8",
    );
    const service = new QualityService(root);
    try {
      const { coverage } = await service.coverage();
      expect(coverage).not.toBeNull();
      expect(coverage!.files).toHaveLength(1);
      expect(coverage!.files[0]!.path).toBe("src/x.ts");
      expect(coverage!.files[0]!.statements).toEqual({ covered: 1, total: 2, pct: 50 });
      expect(coverage!.files[0]!.uncoveredLines).toEqual([2]);
      expect(Date.parse(coverage!.generatedAt)).not.toBeNaN();
      // Cached by mtime — same object on a second read.
      const again = await service.coverage();
      expect(again.coverage).toBe(coverage);
    } finally {
      service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Monorepo detection + run planning
// ---------------------------------------------------------------------------

describe("QualityService.detect (monorepo)", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function detectIn(files: Record<string, string>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-quality-mono-"));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, ...rel.split("/"));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    }
    const service = new QualityService(root);
    try {
      return await service.detect();
    } finally {
      service.dispose();
    }
  }

  it("finds per-package runners when the root has none", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({
        name: "mono",
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
      "packages/api/package.json": JSON.stringify({
        name: "@mono/api",
        devDependencies: { vitest: "^3.0.0" },
      }),
      "packages/api/src/a.spec.ts": "",
      "packages/web/package.json": JSON.stringify({
        name: "@mono/web",
        devDependencies: { vitest: "^3.0.0", "@vitest/coverage-v8": "^3.0.0" },
      }),
      "packages/untested/package.json": JSON.stringify({ name: "@mono/untested" }),
    });
    expect(info.runner).toBe("vitest");
    expect(info.packages.map((p) => p.dir)).toEqual(["packages/api", "packages/web"]);
    expect(info.packages[0]).toMatchObject({ name: "@mono/api", runner: "vitest" });
    // One package with a provider makes the workspace coverage-capable.
    expect(info.coverageCapable).toBe(true);
    expect(info.testFiles).toEqual(["packages/api/src/a.spec.ts"]);
  });

  it("keeps the root runner as the headline when the root has one", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ name: "mono", devDependencies: { vitest: "^3.0.0" } }),
      "vitest.config.ts": "export default {};",
      "packages/api/package.json": JSON.stringify({
        name: "@mono/api",
        jest: { testEnvironment: "node" },
      }),
    });
    expect(info.runner).toBe("vitest");
    expect(info.configFile).toBe("vitest.config.ts");
    expect(info.packages.map((p) => p.dir)).toEqual([".", "packages/api"]);
  });

  it("resolves a package's coverage provider from the hoisted root node_modules", async () => {
    const info = await detectIn({
      "package.json": JSON.stringify({ name: "mono" }),
      "node_modules/@vitest/coverage-v8/package.json": "{}",
      "packages/api/package.json": JSON.stringify({
        name: "@mono/api",
        devDependencies: { vitest: "^3.0.0" },
      }),
    });
    expect(info.packages[0]?.coverageCapable).toBe(true);
  });
});

describe("planRunJobs", () => {
  const pkg = (over: Partial<PackageTestSetup>): PackageTestSetup => ({
    dir: ".",
    name: "x",
    runner: "vitest",
    configFile: null,
    script: null,
    coverageCapable: false,
    ...over,
  });

  it("fans an unscoped run out across every vitest/jest package", () => {
    const plans = planRunJobs(
      [
        pkg({ dir: "packages/api", coverageCapable: true }),
        pkg({ dir: "packages/web", runner: "jest", coverageCapable: true }),
        pkg({ dir: "packages/scripts-only", runner: "script", script: "node t.js" }),
      ],
      { coverage: true },
    );
    expect(plans).toEqual([
      { dir: "packages/api", mode: "vitest", script: null, coverage: true },
      { dir: "packages/web", mode: "jest", script: null, coverage: true },
    ]);
  });

  it("routes a file-scoped run to the owning package only", () => {
    const plans = planRunJobs(
      [pkg({ dir: "." }), pkg({ dir: "packages/api", coverageCapable: true })],
      { file: "packages/api/src/a.spec.ts", coverage: true },
    );
    expect(plans).toEqual([
      { dir: "packages/api", mode: "vitest", script: null, coverage: true },
    ]);
  });

  it("falls back to the root for files outside any package", () => {
    const plans = planRunJobs(
      [pkg({ dir: "." }), pkg({ dir: "packages/api" })],
      { file: "tools/x.spec.ts" },
    );
    expect(plans).toEqual([{ dir: ".", mode: "vitest", script: null, coverage: false }]);
  });

  it("uses the root test script only when no real runner exists anywhere", () => {
    const plans = planRunJobs([pkg({ dir: ".", runner: "script", script: "node t.js" })], {});
    expect(plans).toEqual([{ dir: ".", mode: "script", script: "node t.js", coverage: false }]);
    expect(planRunJobs([], {})).toEqual([]);
  });

  it("fans an unscoped run across playwright setups too, without coverage", () => {
    const plans = planRunJobs(
      [pkg({ dir: ".", coverageCapable: true }), pkg({ dir: ".", runner: "playwright" })],
      { coverage: true },
    );
    expect(plans).toEqual([
      { dir: ".", mode: "vitest", script: null, coverage: true },
      { dir: ".", mode: "playwright", script: null, coverage: false },
    ]);
  });

  it("routes e2e spec files to the coexisting playwright setup", () => {
    const packages = [pkg({ dir: "." }), pkg({ dir: ".", runner: "playwright" })];
    expect(planRunJobs(packages, { file: "e2e/login.spec.ts" })[0]!.mode).toBe("playwright");
    expect(planRunJobs(packages, { file: "src/a.spec.ts" })[0]!.mode).toBe("vitest");
  });
});

describe("pickSetupForFile", () => {
  const pkg = (over: Partial<PackageTestSetup>): PackageTestSetup => ({
    dir: ".",
    name: "x",
    runner: "vitest",
    configFile: null,
    script: null,
    coverageCapable: false,
    ...over,
  });

  it("prefers the unit runner outside e2e dirs, playwright inside them", () => {
    const both = [pkg({}), pkg({ runner: "playwright" })];
    expect(pickSetupForFile(both, "src/thing.test.ts")?.runner).toBe("vitest");
    expect(pickSetupForFile(both, "e2e/flow.spec.ts")?.runner).toBe("playwright");
    expect(pickSetupForFile(both, "tests/playwright/x.spec.ts")?.runner).toBe("playwright");
  });

  it("uses playwright when it is the only setup", () => {
    expect(pickSetupForFile([pkg({ runner: "playwright" })], "src/x.spec.ts")?.runner).toBe(
      "playwright",
    );
  });
});

describe("buildPlaywrightArgs / parsePlaywrightJson", () => {
  it("builds a scoped run with the json reporter", () => {
    expect(buildPlaywrightArgs({ file: "e2e/a.spec.ts", testName: "logs in" }, false)).toEqual([
      "test",
      "--reporter=json",
      "e2e/a.spec.ts",
      "-g",
      "logs in",
    ]);
  });

  it("maps playwright suites/specs to file results, rebased on the package dir", () => {
    const json = {
      suites: [
        {
          title: "login.spec.ts",
          file: "login.spec.ts",
          suites: [
            {
              title: "auth",
              file: "login.spec.ts",
              specs: [
                {
                  title: "logs in",
                  file: "login.spec.ts",
                  line: 5,
                  tests: [
                    {
                      projectName: "chromium",
                      status: "expected",
                      results: [{ status: "passed", duration: 1200 }],
                    },
                  ],
                },
                {
                  title: "rejects bad password",
                  file: "login.spec.ts",
                  line: 12,
                  tests: [
                    {
                      projectName: "chromium",
                      status: "unexpected",
                      results: [
                        {
                          status: "failed",
                          duration: 900,
                          error: { message: `Expect ${red("failed")}: locator not found` },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = parsePlaywrightJson(json, ROOT, "apps/web");
    expect(parsed).not.toBeNull();
    expect(parsed!.files).toHaveLength(1);
    const file = parsed!.files[0]!;
    expect(file.file).toBe("apps/web/login.spec.ts");
    expect(file.status).toBe("fail");
    expect(file.tests.map((t) => t.status)).toEqual(["pass", "fail"]);
    expect(file.tests[0]!.name).toBe("auth > logs in > [chromium]");
    expect(file.tests[1]!.error?.message).toContain("locator not found");
    expect(file.tests[1]!.error?.line).toBe(12);
    expect(parsed!.summary).toMatchObject({ files: 1, passed: 1, failed: 1, skipped: 0 });
  });

  it("treats flaky as pass and skipped as skip", () => {
    const json = {
      suites: [
        {
          title: "a.spec.ts",
          file: "a.spec.ts",
          specs: [
            { title: "flaky one", file: "a.spec.ts", tests: [{ status: "flaky", results: [] }] },
            { title: "skipped one", file: "a.spec.ts", tests: [{ status: "skipped", results: [] }] },
          ],
        },
      ],
    };
    const parsed = parsePlaywrightJson(json, ROOT, ".");
    expect(parsed!.files[0]!.tests.map((t) => t.status)).toEqual(["pass", "skip"]);
    expect(parsed!.files[0]!.status).toBe("pass");
  });

  it("returns null on non-playwright JSON", () => {
    expect(parsePlaywrightJson({ testResults: [] }, ROOT)).toBeNull();
  });
});

describe("owningPackageDir", () => {
  const packages = [
    { dir: ".", name: "root" },
    { dir: "packages/api", name: "api" },
    { dir: "packages/api/nested", name: "nested" },
  ] as PackageTestSetup[];

  it("picks the deepest containing package", () => {
    expect(owningPackageDir(packages, "packages/api/nested/x.test.ts")).toBe(
      "packages/api/nested",
    );
    expect(owningPackageDir(packages, "packages/api/src/x.test.ts")).toBe("packages/api");
    expect(owningPackageDir(packages, "docs/x.test.ts")).toBe(".");
  });
});

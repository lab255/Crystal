import { describe, expect, it, vi } from "vitest";
import type { QualityRun, TestFileResult, TestRunnerInfo } from "@crystal/core";
import {
  coverageFileForPath,
  latestCoverageRunWithoutData,
  loadQualitySources,
  performQualityAction,
  projectQualityFiles,
  projectQualityRuns,
  testNamePattern,
  type QualityLoadResult,
} from "./quality-state.js";

const info: TestRunnerInfo = {
  runner: "vitest",
  configFile: "vitest.config.ts",
  script: "vitest",
  coverageCapable: true,
  packages: [],
  testFiles: ["src/a.test.ts", "src/b.test.ts"],
};

function result(file: string, status: TestFileResult["status"]): TestFileResult {
  return { file, status, tests: [] };
}

function run(
  id: string,
  files: TestFileResult[],
  scope: QualityRun["scope"] = {},
): QualityRun {
  return {
    id,
    status: "passed",
    startedAt: `2026-08-09T00:00:0${id}.000Z`,
    scope,
    withCoverage: false,
    files,
  };
}

describe("quality state", () => {
  it("publishes successful detection and history without waiting for failed coverage", async () => {
    let rejectCoverage!: (error: Error) => void;
    const coverage = new Promise<null>((_resolve, reject) => {
      rejectCoverage = reject;
    });
    const published: QualityLoadResult[] = [];

    const pending = loadQualitySources(
      {
        info: async () => info,
        runs: async () => [run("1", [])],
        coverage: () => coverage,
      },
      (value) => published.push(value),
    );
    await Promise.resolve();

    expect(published).toEqual([
      { source: "info", data: info },
      { source: "runs", data: [run("1", [])] },
    ]);

    rejectCoverage(new Error("coverage JSON is unreadable"));
    await pending;
    expect(published.at(-1)).toEqual({
      source: "coverage",
      error: "coverage JSON is unreadable",
    });
  });

  it("routes action failures to the surfaced error callback", async () => {
    const publish = vi.fn();
    await expect(
      performQualityAction(async () => {
        throw new Error("could not cancel run");
      }, publish),
    ).resolves.toBeNull();
    expect(publish).toHaveBeenCalledWith("could not cancel run");
  });

  it("keeps a full run as the baseline and overlays only the rerun file", () => {
    const full = run("1", [result("src/a.test.ts", "pass"), result("src/b.test.ts", "pass")]);
    const rerun = run("2", [result("src/a.test.ts", "fail")], { file: "src/a.test.ts" });

    const projected = projectQualityRuns([rerun, full], null);
    expect(projected).toEqual({ baseRun: full, rerun });
    expect([...projectQualityFiles(projected.baseRun, projected.rerun).values()]).toEqual([
      result("src/a.test.ts", "fail"),
      result("src/b.test.ts", "pass"),
    ]);
    expect(projectQualityRuns([rerun, full], rerun.id)).toEqual({ baseRun: rerun, rerun: null });
  });

  it("uses the describe ancestry in the runner name filter", () => {
    expect(testNamePattern("authentication > login form > rejects an expired token")).toBe(
      "authentication login form rejects an expired token",
    );
    expect(testNamePattern("standalone test")).toBe("standalone test");
  });

  it("recognizes a settled coverage run when no report was produced", () => {
    const coverageRun = { ...run("2", []), withCoverage: true, status: "failed" as const };
    expect(latestCoverageRunWithoutData([coverageRun, run("1", [])])).toBe(coverageRun);
    expect(
      latestCoverageRunWithoutData([
        { ...coverageRun, status: "cancelled" },
        { ...coverageRun, id: "3", status: "running" },
      ]),
    ).toBeNull();
  });

  it("distinguishes an absent coverage deep-link target from no selection", () => {
    const metric = { covered: 1, total: 1, pct: 100 };
    const coverage = {
      generatedAt: "2026-08-09T00:00:00.000Z",
      total: { lines: metric, statements: metric, functions: metric, branches: metric },
      files: [
        {
          path: "src/covered.ts",
          lines: metric,
          statements: metric,
          functions: metric,
          branches: metric,
        },
      ],
    };
    expect(coverageFileForPath(coverage, "src/covered.ts")?.path).toBe("src/covered.ts");
    expect(coverageFileForPath(coverage, "src/missing.ts")).toBeNull();
    expect(coverageFileForPath(coverage, null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { buildCodeIndex, type IndexSourceFile } from "./code-index.js";
import { computeReviewFindings, type ReviewSourceFile } from "./code-review.js";
import type { DuplicateCluster } from "./codemap.js";

const file = (over: Partial<ReviewSourceFile> & Pick<ReviewSourceFile, "path" | "module">): ReviewSourceFile => ({
  entry: false,
  test: false,
  symbols: [],
  imports: [],
  reexports: [],
  ...over,
});

const fn = (name: string, line = 1, exported = true) => ({
  name,
  kind: "function" as const,
  line,
  exported,
});

describe("unused exports (barrel-aware)", () => {
  const files: ReviewSourceFile[] = [
    // pkg/a barrel re-exports util; app imports `used` through the barrel.
    file({
      path: "pkg/a/src/index.ts",
      module: "pkg/a",
      entry: true,
      imports: [{ specifier: "./util.js", resolved: "pkg/a/src/util.ts", names: ["*"] }],
      reexports: [{ name: "*", specifier: "./util.js" }],
    }),
    file({
      path: "pkg/a/src/util.ts",
      module: "pkg/a",
      symbols: [fn("used", 1), fn("spare", 9)],
    }),
    file({
      path: "app/src/main.ts",
      module: "app",
      entry: true,
      symbols: [fn("main", 1, false)],
      imports: [{ specifier: "@pkg/a", resolved: "pkg/a/src/index.ts", names: ["used"] }],
    }),
    file({
      path: "app/src/orphan.ts",
      module: "app",
      symbols: [fn("helper", 1), fn("other", 5)],
    }),
  ];

  it("resolves usage through star re-export barrels", () => {
    const findings = computeReviewFindings(files);
    const unused = findings.filter((f) => f.kind === "unused-export");
    expect(unused.map((f) => `${f.ref.file}#${f.ref.symbol}`)).not.toContain(
      "pkg/a/src/util.ts#used",
    );
  });

  it("demotes barrel-re-exported-but-unused symbols to public-API info", () => {
    const findings = computeReviewFindings(files);
    const spare = findings.find((f) => f.ref.symbol === "spare");
    expect(spare?.kind).toBe("unused-export");
    expect(spare?.severity).toBe("info");
  });

  it("flags dead files instead of their individual exports", () => {
    const findings = computeReviewFindings(files);
    const dead = findings.find((f) => f.kind === "dead-file");
    expect(dead?.ref.file).toBe("app/src/orphan.ts");
    expect(findings.some((f) => f.kind === "unused-export" && f.ref.file === "app/src/orphan.ts")).toBe(false);
  });

  it("namespace imports mark every export of the target as used", () => {
    const withNs = files.map((f) =>
      f.path === "app/src/main.ts"
        ? {
            ...f,
            imports: [
              ...f.imports,
              { specifier: "./orphan.js", resolved: "app/src/orphan.ts", names: ["* as orphan"] },
            ],
          }
        : f,
    );
    const findings = computeReviewFindings(withNs);
    expect(findings.some((f) => f.ref.file === "app/src/orphan.ts")).toBe(false);
  });
});

describe("boundary leaks", () => {
  it("flags relative imports that cross package boundaries", () => {
    const files: ReviewSourceFile[] = [
      file({
        path: "server/src/handlers.ts",
        module: "server",
        entry: true,
        symbols: [fn("handle")],
        imports: [
          { specifier: "../../worker/src/jobs.js", resolved: "worker/src/jobs.ts", names: ["chunk"] },
          { specifier: "./local.js", resolved: "server/src/local.ts", names: ["helper"] },
        ],
      }),
      file({ path: "server/src/local.ts", module: "server", symbols: [fn("helper")] }),
      file({ path: "worker/src/jobs.ts", module: "worker", entry: true, symbols: [fn("chunk")] }),
    ];
    const findings = computeReviewFindings(files);
    const leaks = findings.filter((f) => f.kind === "boundary-leak");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]!.title).toContain("server reaches into worker");
    expect(leaks[0]!.detail).toContain("chunk");
  });
});

describe("duplicates and shared utilities", () => {
  const files: ReviewSourceFile[] = [
    file({
      path: "packages/shared/src/util.ts",
      module: "packages/shared",
      symbols: [fn("clamp")],
    }),
    file({ path: "apps/web/src/format.ts", module: "apps/web", symbols: [fn("formatMoney")] }),
    file({ path: "worker/src/format.ts", module: "worker", symbols: [fn("formatMoney")] }),
    file({
      path: "worker/src/entry.ts",
      module: "worker",
      entry: true,
      symbols: [fn("start", 1, false)],
      imports: [{ specifier: "./format.js", resolved: "worker/src/format.ts", names: ["formatMoney"] }],
    }),
    file({
      path: "apps/web/src/main.ts",
      module: "apps/web",
      entry: true,
      symbols: [fn("boot", 1, false)],
      imports: [
        { specifier: "./format.js", resolved: "apps/web/src/format.ts", names: ["formatMoney"] },
        // web reaches the queue's util helper cross-module:
        { specifier: "@q/queue", resolved: "queue/src/index.ts", names: ["nowIso"] },
      ],
    }),
    file({
      path: "queue/src/index.ts",
      module: "queue",
      entry: true,
      imports: [{ specifier: "./util.js", resolved: "queue/src/util.ts", names: ["*"] }],
      reexports: [{ name: "*", specifier: "./util.js" }],
    }),
    file({ path: "queue/src/util.ts", module: "queue", symbols: [fn("nowIso")] }),
  ];
  const index = buildCodeIndex(
    files.map(
      (f): IndexSourceFile => ({
        path: f.path,
        module: f.module,
        hash: `h-${f.path}`,
        importerModules: 0,
        symbols: f.symbols,
      }),
    ),
  );
  const clusters: DuplicateCluster[] = [
    {
      hash: "abc123",
      tokenCount: 40,
      instances: [
        { file: "apps/web/src/format.ts", module: "apps/web", symbol: "formatMoney", line: 3, endLine: 9, exported: true },
        { file: "worker/src/format.ts", module: "worker", symbol: "formatMoney", line: 3, endLine: 9, exported: true },
      ],
    },
  ];

  it("labels a test/production duplicate as a test mirror, without a hoist", () => {
    const withTestCopy: ReviewSourceFile[] = [
      ...files,
      file({
        path: "worker/src/format.spec.ts",
        module: "worker",
        test: true,
        symbols: [fn("formatMoneyMirror")],
      }),
    ];
    const mirrorClusters: DuplicateCluster[] = [
      {
        hash: "mirror1",
        tokenCount: 40,
        instances: [
          { file: "worker/src/format.ts", module: "worker", symbol: "formatMoney", line: 3, endLine: 9, exported: true },
          { file: "worker/src/format.spec.ts", module: "worker", symbol: "formatMoneyMirror", line: 12, endLine: 18, exported: false },
        ],
      },
    ];
    const findings = computeReviewFindings(withTestCopy, mirrorClusters, index);
    const dup = findings.find((f) => f.kind === "duplicate");
    expect(dup?.title).toBe("a test re-implements formatMoney instead of importing it");
    expect(dup?.detail).toContain("format.spec.ts#formatMoneyMirror");
    expect(dup?.detail).toContain("drift");
    expect(dup?.refactor).toBeNull();
  });

  it("turns duplicate clusters into findings with a deterministic hoist intent", () => {
    const findings = computeReviewFindings(files, clusters, index);
    const dup = findings.find((f) => f.kind === "duplicate");
    expect(dup?.title).toBe("formatMoney is implemented 2 times");
    expect(dup?.refactor?.kind).toBe("hoist");
    expect(dup?.refactor?.targetModule).toBe("packages/shared");
    expect(dup?.related).toHaveLength(1);
  });

  it("flags cross-module use of a util file outside shared packages", () => {
    const findings = computeReviewFindings(files, clusters, index);
    const util = findings.find((f) => f.kind === "shared-util");
    expect(util?.ref.file).toBe("queue/src/util.ts");
    expect(util?.detail).toContain("apps/web");
    // The shared package's own util is exempt.
    expect(
      findings.some((f) => f.kind === "shared-util" && f.ref.file === "packages/shared/src/util.ts"),
    ).toBe(false);
  });

  it("is deterministic", () => {
    expect(computeReviewFindings(files, clusters, index)).toEqual(
      computeReviewFindings(files, clusters, index),
    );
  });
});

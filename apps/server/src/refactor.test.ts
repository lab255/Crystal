import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMoveFileIntent, createMoveIntent } from "@crystal/core";
import { CodeMapAnalyzer } from "./code-map.js";
import {
  RefactorEngine,
  firstDiffPreview,
  planManualFileMove,
  planManualMove,
  replaceSpecifier,
  specifierBetween,
} from "./refactor.js";

describe("specifierBetween", () => {
  it("builds relative .js specifiers", () => {
    expect(specifierBetween("src/a.ts", "src/util/b.ts")).toBe("./util/b.js");
    expect(specifierBetween("src/deep/a.tsx", "src/b.ts")).toBe("../b.js");
  });
});

describe("firstDiffPreview", () => {
  it("excerpts around the first changed line", () => {
    const oldText = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const newText = ["1", "2", "3", "4", "5", "6", "CHANGED", "8"].join("\n");
    const preview = firstDiffPreview(oldText, newText);
    expect(preview).toContain("CHANGED");
    expect(preview.split("\n")[0]).toBe("2"); // 5 lines of context
  });
});

describe("planManualMove", () => {
  const fromText = `export function keep() {}\n\nexport function move(a: number) {\n  return a * 2;\n}\n`;
  const sym = { start: fromText.indexOf("export function move"), end: fromText.indexOf("}\n", fromText.indexOf("move")) + 1, exported: true };

  it("relocates the declaration and leaves a re-export shim", () => {
    const plan = planManualMove({
      intent: createMoveIntent("move", "src/a.ts", "packages/shared", "packages/shared/src/move.ts"),
      sym,
      fromText,
      toFile: "packages/shared/src/move.ts",
      toText: null,
    });
    const from = plan.writes.find((w) => w.file === "src/a.ts")!;
    const to = plan.writes.find((w) => w.file === "packages/shared/src/move.ts")!;
    expect(from.content).not.toContain("return a * 2");
    expect(from.content).toContain('export { move } from "../packages/shared/src/move.js"');
    expect(to.created).toBe(true);
    expect(to.content).toContain("export function move");
    expect(plan.warnings.join(" ")).toContain("re-export shim");
  });

  it("adds a back-import when the source still uses a non-exported symbol", () => {
    const text = `function helper() {\n  return 1;\n}\nexport function api() {\n  return helper();\n}\n`;
    const plan = planManualMove({
      intent: createMoveIntent("helper", "src/a.ts", ".", "src/b.ts"),
      sym: { start: 0, end: text.indexOf("}\n") + 1, exported: false },
      fromText: text,
      toFile: "src/b.ts",
      toText: "export const existing = 1;\n",
    });
    const from = plan.writes.find((w) => w.file === "src/a.ts")!;
    const to = plan.writes.find((w) => w.file === "src/b.ts")!;
    expect(from.content).toContain('import { helper } from "./b.js"');
    expect(to.content).toContain("export const existing");
    expect(to.content).toContain("export function helper"); // exported so the import resolves
  });
});

describe("replaceSpecifier", () => {
  it("replaces only exact quoted specifiers", () => {
    const text = `import { a } from "./a.js";\nimport { aa } from "./a.js/nested";\nconst s = './a.js';\n`;
    const out = replaceSpecifier(text, "./a.js", "../lib/a.js");
    expect(out).toContain(`from "../lib/a.js"`);
    expect(out).toContain(`"./a.js/nested"`); // longer specifier untouched
    expect(out).toContain(`'../lib/a.js'`);
  });
});

describe("planManualFileMove", () => {
  it("rewrites the moved file's own imports and every importer", () => {
    const intent = createMoveFileIntent("src/util.ts", "packages/shared", "packages/shared/src/util.ts");
    const plan = planManualFileMove({
      intent,
      toFile: "packages/shared/src/util.ts",
      fromText: `import { base } from "./base.js";\nexport const twice = (n: number) => base(n) * 2;\n`,
      ownImports: [{ specifier: "./base.js", resolved: "src/base.ts" }],
      importers: [
        {
          file: "src/app.ts",
          text: `import { twice } from "./util.js";\nexport const x = twice(2);\n`,
          specifiers: ["./util.js"],
        },
      ],
    });
    expect(plan.deletes).toEqual(["src/util.ts"]);
    const moved = plan.writes.find((w) => w.file === "packages/shared/src/util.ts")!;
    expect(moved.created).toBe(true);
    expect(moved.content).toContain(`from "../../../src/base.js"`);
    const importer = plan.writes.find((w) => w.file === "src/app.ts")!;
    expect(importer.content).toContain(`from "../packages/shared/src/util.js"`);
    expect(plan.warnings.join(" ")).toContain("importer");
  });
});

describe("RefactorEngine (integration)", () => {
  let root: string;
  let engine: RefactorEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-refactor-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "esnext", target: "es2022", moduleResolution: "bundler" } }),
    );
    await fs.writeFile(
      path.join(root, "source.ts"),
      `export function stays() {\n  return 1;\n}\n\nexport function moves(a: number) {\n  return a + stays();\n}\n`,
    );
    await fs.writeFile(
      path.join(root, "consumer.ts"),
      `import { moves } from "./source.js";\n\nexport const result = moves(2);\n`,
    );
    await fs.writeFile(path.join(root, "target.ts"), `export const anchor = true;\n`);
    engine = new RefactorEngine(root, new CodeMapAnalyzer(root));
  });

  afterEach(async () => {
    engine.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("previews a move without writing", async () => {
    const intent = createMoveIntent("moves", "source.ts", ".", "target.ts");
    const { plans } = await engine.preview([intent]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.changes.length).toBeGreaterThanOrEqual(2);
    // Nothing written.
    const source = await fs.readFile(path.join(root, "source.ts"), "utf8");
    expect(source).toContain("function moves");
    const target = await fs.readFile(path.join(root, "target.ts"), "utf8");
    expect(target).not.toContain("moves");
  });

  it("applies a move: declaration relocates and importers still resolve", async () => {
    const intent = createMoveIntent("moves", "source.ts", ".", "target.ts");
    const result = await engine.apply([intent]);
    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(1);

    const source = await fs.readFile(path.join(root, "source.ts"), "utf8");
    const target = await fs.readFile(path.join(root, "target.ts"), "utf8");
    expect(target).toContain("function moves");
    expect(source).not.toMatch(/function moves/);
    // Either the LS rewrote the consumer's import, or the manual shim keeps
    // the old specifier valid — both must leave `moves` importable.
    const consumer = await fs.readFile(path.join(root, "consumer.ts"), "utf8");
    const consumerStillOld = consumer.includes('from "./source.js"');
    if (consumerStillOld) {
      expect(source).toContain("export { moves }");
    } else {
      expect(consumer).toContain('from "./target.js"');
    }
  }, 30_000);

  it("fails unknown symbols individually while applying the rest", async () => {
    const bad = createMoveIntent("nope", "source.ts", ".", "target.ts");
    const good = createMoveIntent("moves", "source.ts", ".", "target.ts");
    const result = await engine.apply([bad, good]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("nope");
    expect(result.applied).toHaveLength(1);
  }, 30_000);

  it("applies a whole-file move: file relocates, importers keep resolving", async () => {
    const intent = createMoveFileIntent("source.ts", ".", "lib/source.ts");
    const result = await engine.apply([intent]);
    expect(result.failed).toEqual([]);
    expect(result.applied).toHaveLength(1);
    expect(result.pathsTouched).toContain("source.ts");
    expect(result.pathsTouched).toContain("lib/source.ts");

    // old file gone, new file carries the declarations
    await expect(fs.access(path.join(root, "source.ts"))).rejects.toThrow();
    const moved = await fs.readFile(path.join(root, "lib/source.ts"), "utf8");
    expect(moved).toContain("function moves");
    expect(moved).toContain("function stays");

    // the importer's specifier now points at the new location
    const consumer = await fs.readFile(path.join(root, "consumer.ts"), "utf8");
    expect(consumer).toContain('from "./lib/source.js"');
  }, 30_000);

  it("previews a whole-file move without touching disk", async () => {
    const intent = createMoveFileIntent("source.ts", ".", "lib/source.ts");
    const { plans } = await engine.preview([intent]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.changes.some((c) => c.file === "lib/source.ts")).toBe(true);
    expect(plans[0]!.changes.some((c) => c.file === "source.ts" && c.summary.includes("deleted"))).toBe(true);
    await expect(fs.access(path.join(root, "source.ts"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "lib/source.ts"))).rejects.toThrow();
  }, 30_000);

  it("refuses to overwrite an existing destination file", async () => {
    const intent = createMoveFileIntent("source.ts", ".", "target.ts");
    const result = await engine.apply([intent]);
    expect(result.applied).toEqual([]);
    expect(result.failed[0]!.error).toContain("already exists");
  });

  it("rejects hoist intents from apply", async () => {
    const result = await engine.apply([
      {
        id: "h1",
        kind: "hoist",
        symbols: [
          { file: "source.ts", symbol: "stays" },
          { file: "target.ts", symbol: "anchor" },
        ],
        targetModule: ".",
        targetFile: null,
        newName: null,
      },
    ]);
    expect(result.failed[0]!.error).toContain("agent");
  });
});

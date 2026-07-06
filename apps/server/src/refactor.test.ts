import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMoveIntent } from "@crystal/core";
import { CodeMapAnalyzer } from "./code-map.js";
import { RefactorEngine, firstDiffPreview, planManualMove, specifierBetween } from "./refactor.js";

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

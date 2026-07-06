import { describe, expect, it } from "vitest";
import type { CodeSymbol } from "./codemap.js";
import {
  createHoistIntent,
  createMoveFileIntent,
  createMoveIntent,
  validateRefactorIntents,
} from "./refactor.js";

const sym = (name: string): CodeSymbol => ({ name, kind: "function", line: 1 });

describe("validateRefactorIntents", () => {
  const index = (files: Record<string, string[]>) => (file: string) =>
    files[file] ? files[file].map(sym) : null;

  it("passes intents whose symbols still exist", () => {
    const move = createMoveIntent("helper", "a.ts", "packages/core");
    const hoist = createHoistIntent(
      [
        { file: "a.ts", symbol: "dup" },
        { file: "b.ts", symbol: "dup" },
      ],
      "packages/core",
    );
    const problems = validateRefactorIntents(
      [move, hoist],
      index({ "a.ts": ["helper", "dup"], "b.ts": ["dup"] }),
    );
    expect(problems).toEqual([]);
  });

  it("flags missing files and missing symbols", () => {
    const move = createMoveIntent("gone", "a.ts", "packages/core");
    const hoist = createHoistIntent(
      [
        { file: "missing.ts", symbol: "dup" },
        { file: "a.ts", symbol: "dup" },
      ],
      "packages/core",
    );
    const problems = validateRefactorIntents([move, hoist], index({ "a.ts": ["dup"] }));
    expect(problems).toHaveLength(2);
    expect(problems[0]!.problem).toContain('"gone" no longer exists');
    expect(problems[1]!.problem).toContain("missing.ts is no longer in the code map");
  });

  it("validates whole-file moves by source-file existence only", () => {
    const ok = createMoveFileIntent("a.ts", "packages/core");
    const gone = createMoveFileIntent("missing.ts", "packages/core");
    const problems = validateRefactorIntents([ok, gone], index({ "a.ts": ["helper"] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.intent).toBe(gone);
    expect(problems[0]!.problem).toContain("missing.ts is no longer in the code map");
  });
});

import { describe, expect, it } from "vitest";
import { createHoistIntent } from "@crystal/core";
import { buildHoistPrompt } from "./refactor-prompts.js";

describe("buildHoistPrompt", () => {
  const intent = createHoistIntent(
    [
      { file: "apps/web/src/a.ts", symbol: "formatDate" },
      { file: "apps/server/src/b.ts", symbol: "fmtDate" },
    ],
    "packages/shared",
    "formatDate",
  );

  it("names every instance with its range and source", () => {
    const prompt = buildHoistPrompt(intent, [
      { file: "apps/web/src/a.ts", symbol: "formatDate", startLine: 3, endLine: 9, text: "function formatDate() {}" },
      { file: "apps/server/src/b.ts", symbol: "fmtDate", startLine: 12, endLine: 18, text: "function fmtDate() {}" },
    ]);
    expect(prompt).toContain("apps/web/src/a.ts");
    expect(prompt).toContain("lines 3-9");
    expect(prompt).toContain("apps/server/src/b.ts");
    expect(prompt).toContain("lines 12-18");
    expect(prompt).toContain("function fmtDate() {}");
    expect(prompt).toContain("packages/shared");
    expect(prompt).toContain("`formatDate`");
    expect(prompt).toContain("pnpm typecheck");
  });

  it("falls back to the first duplicate's name when newName is unset", () => {
    const anonymous = { ...intent, newName: null };
    const prompt = buildHoistPrompt(anonymous, []);
    expect(prompt).toContain("`formatDate`");
  });
});

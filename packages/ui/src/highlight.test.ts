import { describe, expect, it } from "vitest";
import { highlightLines, highlightTs } from "./highlight.js";

const typesOf = (code: string) => highlightTs(code).map((t) => `${t.type}:${t.text}`);

describe("highlightTs", () => {
  it("classifies keywords, strings, numbers, comments", () => {
    const tokens = typesOf(`const x = "hi"; // note`);
    expect(tokens).toContain("keyword:const");
    expect(tokens).toContain('string:"hi"');
    expect(tokens).toContain("comment:// note");
  });

  it("keeps template interpolation inside the string token", () => {
    const tokens = highlightTs("`a ${b} c`");
    expect(tokens).toEqual([{ text: "`a ${b} c`", type: "string" }]);
  });

  it("handles block comments spanning lines", () => {
    const tokens = highlightTs("/* one\ntwo */ let x = 1;");
    expect(tokens[0]).toEqual({ text: "/* one\ntwo */", type: "comment" });
    expect(tokens.some((t) => t.type === "keyword" && t.text === "let")).toBe(true);
    expect(tokens.some((t) => t.type === "number" && t.text === "1")).toBe(true);
  });

  it("round-trips the source text exactly", () => {
    const code = `export function f(a: number) {\n  return \`v=\${a * 2}\`; // done\n}`;
    expect(highlightTs(code).map((t) => t.text).join("")).toBe(code);
  });

  it("stays linear on pathological input", () => {
    const long = `${"((([[".repeat(2000)}"unterminated`;
    const start = performance.now();
    highlightTs(long);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("highlightLines", () => {
  it("splits tokens across line boundaries", () => {
    const lines = highlightLines(`const a = 1;\nconst b = "x";`);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.some((t) => t.type === "number" && t.text === "1")).toBe(true);
    expect(lines[0]!.some((t) => t.type === "string")).toBe(false);
    expect(lines[1]!.some((t) => t.type === "string" && t.text === '"x"')).toBe(true);
    // Each line's tokens re-join to that line's exact source.
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual(["const a = 1;", 'const b = "x";']);
  });
});

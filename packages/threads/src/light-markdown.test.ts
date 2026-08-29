import { describe, expect, it } from "vitest";
import { renderLightMarkdown } from "./light-markdown.js";

describe("renderLightMarkdown", () => {
  it("parses bold, italic, and inline code", () => {
    expect(renderLightMarkdown("Use **care**, *please*, with `rm`.")[0]).toEqual({
      type: "paragraph",
      spans: [
        { type: "text", text: "Use " },
        { type: "bold", text: "care" },
        { type: "text", text: ", " },
        { type: "italic", text: "please" },
        { type: "text", text: ", with " },
        { type: "code", text: "rm" },
        { type: "text", text: "." },
      ],
    });
  });

  it("parses headings at levels one through three", () => {
    expect(renderLightMarkdown("# One\n## Two\n### Three").map((block) => block.type === "heading" && block.level))
      .toEqual([1, 2, 3]);
  });

  it("parses bullet and ordered lists", () => {
    expect(renderLightMarkdown("- a\n- b\n\n1. one\n2. two")).toMatchObject([
      { type: "list", ordered: false, items: [[{ text: "a" }], [{ text: "b" }]] },
      { type: "list", ordered: true, items: [[{ text: "one" }], [{ text: "two" }]] },
    ]);
  });

  it("preserves ordered-list starts and continues lists across one blank line", () => {
    expect(renderLightMarkdown("3. three\n\n4. four\n\nafter")).toMatchObject([
      { type: "list", ordered: true, start: 3, items: [[{ text: "three" }], [{ text: "four" }]] },
      { type: "paragraph", spans: [{ text: "after" }] },
    ]);
    expect(renderLightMarkdown("- one\n\n- two")).toMatchObject([
      { type: "list", ordered: false, items: [[{ text: "one" }], [{ text: "two" }]] },
    ]);
  });

  it("parses fenced code with its language", () => {
    expect(renderLightMarkdown("```ts\nconst x = 1;\n```")).toEqual([
      { type: "code", language: "ts", text: "const x = 1;" },
    ]);
  });

  it("accepts trailing whitespace on a closing fence", () => {
    expect(renderLightMarkdown("```ts\nconst x = 1;\n```  \t")).toEqual([
      { type: "code", language: "ts", text: "const x = 1;" },
    ]);
  });

  it("accepts only http(s) links", () => {
    expect(renderLightMarkdown("[safe](https://example.com) [no](javascript:alert(1))")[0])
      .toMatchObject({ spans: [
        { type: "link", text: "safe", href: "https://example.com" },
        { type: "text", text: " [no](javascript:alert(1))" },
      ] });
  });

  it("leaves unbalanced markers literal", () => {
    expect(renderLightMarkdown("**bold and `code")).toEqual([
      { type: "paragraph", spans: [{ type: "text", text: "**bold and `code" }] },
    ]);
  });

  it("does not italicize whitespace-flanked arithmetic stars", () => {
    expect(renderLightMarkdown("2 * 3 * 4 and ** spaced **")).toEqual([
      { type: "paragraph", spans: [{ type: "text", text: "2 * 3 * 4 and ** spaced **" }] },
    ]);
  });

  it.each([
    ["opening brackets", "[".repeat(50_000)],
    ["opening then closing brackets", `${"[".repeat(25_000)}${"]".repeat(25_000)}`],
    ["an incomplete link", `[${"a".repeat(49_988)}](https://x`],
  ])("parses 50 KB of %s in under 50 ms", (_label, input) => {
    const started = performance.now();
    renderLightMarkdown(input);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("flattens nested list markers", () => {
    expect(renderLightMarkdown("- parent\n  - child\n    - grandchild")[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [[{ text: "parent" }], [{ text: "child" }], [{ text: "grandchild" }]],
    });
  });
});

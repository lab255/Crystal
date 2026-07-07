import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  enrichHighlight,
  formatHighlightSel,
  hasHighlight,
  matchHighlight,
  moduleForFile,
  parseHighlightSel,
} from "./highlight.js";
import { createArchNode, createArchitectureGraph } from "./architecture.js";
import type { CodeModule } from "./codemap.js";

const mod = (path: string, name = path): CodeModule => ({ path, name, fileCount: 3 });

describe("matchHighlight", () => {
  it("matches nothing without a ref", () => {
    expect(matchHighlight(null, { file: "a.ts" })).toBeNull();
    expect(matchHighlight(undefined, { file: "a.ts" })).toBeNull();
  });

  it("matches same node exactly regardless of code facets", () => {
    expect(matchHighlight({ node: "n1" }, { node: "n1", module: "x" })).toBe("exact");
    expect(matchHighlight({ node: "n1", file: "a.ts" }, { node: "n1" })).toBe("exact");
  });

  it("matches symbol/file/module at equal sharpness", () => {
    expect(
      matchHighlight({ file: "a.ts", symbol: "foo" }, { file: "a.ts", symbol: "foo" }),
    ).toBe("exact");
    expect(matchHighlight({ file: "a.ts" }, { file: "a.ts" })).toBe("exact");
    expect(matchHighlight({ module: "packages/core" }, { module: "packages/core" })).toBe("exact");
    expect(
      matchHighlight({ file: "a.ts", symbol: "foo" }, { file: "a.ts", symbol: "bar" }),
    ).toBe("kin"); // same file, different symbol
  });

  it("reports lineage as kin", () => {
    // symbol ↔ its file
    expect(matchHighlight({ file: "a.ts", symbol: "foo" }, { file: "a.ts" })).toBe("kin");
    // file ↔ its module
    expect(
      matchHighlight({ file: "packages/core/src/a.ts" }, { module: "packages/core" }),
    ).toBe("kin");
    expect(
      matchHighlight({ module: "packages/core" }, { file: "packages/core/src/a.ts" }),
    ).toBe("kin");
    // nested modules
    expect(matchHighlight({ module: "packages" }, { module: "packages/core" })).toBe("kin");
  });

  it("uses nodePath for diagram containment", () => {
    expect(matchHighlight({ node: "grp" }, { node: "leaf", nodePath: ["sys", "grp"] })).toBe("kin");
    expect(matchHighlight({ node: "leaf", nodePath: ["sys", "grp"] }, { node: "grp" })).toBe("kin");
    expect(matchHighlight({ node: "grp" }, { node: "leaf", nodePath: ["sys"] })).toBeNull();
  });

  it("does not match unrelated entities", () => {
    expect(matchHighlight({ file: "a.ts" }, { file: "b.ts" })).toBeNull();
    expect(matchHighlight({ module: "packages/core" }, { module: "packages/ui" })).toBeNull();
    expect(matchHighlight({ node: "n1" }, { node: "n2" })).toBeNull();
  });
});

describe("sel codec", () => {
  it("round-trips each facet, sharpest first", () => {
    expect(formatHighlightSel({ file: "a/b.ts", symbol: "foo" })).toBe("sym:a/b.ts#foo");
    expect(formatHighlightSel({ file: "a/b.ts" })).toBe("file:a/b.ts");
    expect(formatHighlightSel({ module: "packages/core" })).toBe("mod:packages/core");
    expect(formatHighlightSel({ node: "n1" })).toBe("node:n1");
    expect(formatHighlightSel({})).toBeNull();

    for (const sel of ["sym:a/b.ts#foo", "file:a/b.ts", "mod:packages/core", "node:n1"]) {
      const ref = parseHighlightSel(sel);
      expect(ref).not.toBeNull();
      expect(formatHighlightSel(ref!)).toBe(sel);
    }
  });

  it("rejects malformed input", () => {
    expect(parseHighlightSel(null)).toBeNull();
    expect(parseHighlightSel("")).toBeNull();
    expect(parseHighlightSel("nope")).toBeNull();
    expect(parseHighlightSel("sym:a.ts#")).toBeNull();
    expect(parseHighlightSel("sym:#foo")).toBeNull();
    expect(parseHighlightSel("file:")).toBeNull();
    expect(parseHighlightSel("what:x")).toBeNull();
  });

  it("hasHighlight requires at least one facet", () => {
    expect(hasHighlight(null)).toBe(false);
    expect(hasHighlight({})).toBe(false);
    expect(hasHighlight({ label: "x" })).toBe(false);
    expect(hasHighlight({ module: "m" })).toBe(true);
  });
});

describe("graph helpers", () => {
  function sampleGraph() {
    const graph = createArchitectureGraph("t");
    const sys = createArchNode("system", "Sys", { x: 0, y: 0 });
    const grp = createArchNode("group", "Grp", { x: 0, y: 0 }, sys.id);
    const leaf = createArchNode("service", "Leaf", { x: 0, y: 0 }, grp.id);
    leaf.codeModule = "packages/core";
    graph.nodes = [sys, grp, leaf];
    return { graph, sys, grp, leaf };
  }

  it("ancestorsOf returns the chain root-first", () => {
    const { graph, sys, grp, leaf } = sampleGraph();
    expect(ancestorsOf(graph, leaf.id).map((n) => n.id)).toEqual([sys.id, grp.id]);
    expect(ancestorsOf(graph, sys.id)).toEqual([]);
  });

  it("moduleForFile picks the longest owning module", () => {
    const modules = [mod("."), mod("packages"), mod("packages/core")];
    expect(moduleForFile("packages/core/src/a.ts", modules)).toBe("packages/core");
    expect(moduleForFile("scripts/build.ts", modules)).toBe(".");
    expect(moduleForFile("scripts/build.ts", [mod("packages/core")])).toBeNull();
  });

  it("enrichHighlight fills module, node and nodePath without overwriting", () => {
    const { graph, sys, grp, leaf } = sampleGraph();
    const ref = enrichHighlight(
      { file: "packages/core/src/a.ts", symbol: "foo" },
      { graph, modules: [mod("packages/core")] },
    );
    expect(ref.module).toBe("packages/core");
    expect(ref.node).toBe(leaf.id);
    expect(ref.nodePath).toEqual([sys.id, grp.id]);
    expect(ref.label).toBe("Leaf");

    const kept = enrichHighlight({ module: "elsewhere", node: grp.id }, { graph, modules: [] });
    expect(kept.module).toBe("elsewhere");
    expect(kept.node).toBe(grp.id);
    expect(kept.nodePath).toEqual([sys.id]);
  });
});

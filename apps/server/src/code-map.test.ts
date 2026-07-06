import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCallGraph,
  callKey,
  CodeMapAnalyzer,
  parseSource,
  rankJourneySuggestions,
  type CallGraphRecord,
  type JourneySourceRecord,
} from "./code-map.js";

describe("parseSource", () => {
  it("extracts imports with names", () => {
    const { imports } = parseSource(
      "a.ts",
      `import React from "react";
import { useState, useEffect } from "react";
import * as path from "node:path";
import { helper } from "./util.js";
const lazy = () => import("./heavy.js");
export { thing } from "./things.js";
export * from "./all.js";`,
    );
    expect(imports.map((i) => i.specifier)).toEqual([
      "react",
      "react",
      "node:path",
      "./util.js",
      "./things.js",
      "./all.js",
      "./heavy.js",
    ]);
    expect(imports[0]!.names).toEqual(["React"]);
    expect(imports[1]!.names).toEqual(["useState", "useEffect"]);
    expect(imports[2]!.names).toEqual(["* as path"]);
  });

  it("extracts exported symbols with kinds", () => {
    const { exports } = parseSource(
      "widget.tsx",
      `export function makeThing() {}
export class Store {}
export interface Options {}
export enum Mode { A, B }
export type Alias = string;
export const VALUE = 1;
export const Widget = () => null;
export default function main() {}`,
    );
    const byName = Object.fromEntries(exports.map((e) => [e.name, e.kind]));
    expect(byName).toMatchObject({
      makeThing: "function",
      Store: "class",
      Options: "interface",
      Mode: "enum",
      Alias: "type",
      VALUE: "const",
      Widget: "component",
      main: "default",
    });
    expect(exports.find((e) => e.name === "Store")!.line).toBe(2);
  });

  it("marks re-exports and counts loc", () => {
    const parsed = parseSource("index.ts", `export { A, B } from "./a.js";\nexport * from "./b.js";\n`);
    expect(parsed.exports.map((e) => e.kind)).toEqual(["reexport", "reexport", "reexport"]);
    expect(parsed.loc).toBeGreaterThan(1);
  });

  it("detects components only in tsx-ish files", () => {
    const ts = parseSource("x.ts", `export const Widget = () => null;`);
    expect(ts.exports[0]!.kind).toBe("const");
    const tsx = parseSource("x.tsx", `export const Widget = () => null;`);
    expect(tsx.exports[0]!.kind).toBe("component");
  });

  it("captures all top-level symbols with ranges and export flags", () => {
    const { symbols } = parseSource(
      "a.ts",
      `export function pub() {
  return 1;
}
function priv() {
  return 2;
}
const arrow = () => 3;
export class Store {}
interface Hidden {}`,
    );
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]));
    expect(byName.pub).toMatchObject({ kind: "function", exported: true, line: 1, endLine: 3 });
    expect(byName.priv).toMatchObject({ kind: "function", exported: false, line: 4, endLine: 6 });
    expect(byName.arrow).toMatchObject({ kind: "const", exported: false, line: 7, endLine: 7 });
    expect(byName.Store).toMatchObject({ kind: "class", exported: true });
    expect(byName.Hidden).toMatchObject({ kind: "interface", exported: false });
    expect(byName.pub!.start).toBeLessThan(byName.pub!.end);
  });

  it("collects calls including namespace receivers", () => {
    const { symbols } = parseSource(
      "a.ts",
      `import * as ns from "./b.js";
function run() {
  helper();
  ns.deep();
  obj.method();
  console.log("x");
}`,
    );
    const calls = symbols.find((s) => s.name === "run")!.calls;
    expect(calls).toContainEqual({ name: "helper", receiver: null });
    expect(calls).toContainEqual({ name: "deep", receiver: "ns" });
    expect(calls).toContainEqual({ name: "method", receiver: "obj" });
  });

  it("fingerprints ignore whitespace and comments, respect content", () => {
    const body = (text: string) =>
      parseSource("a.ts", text).symbols.find((s) => s.name === "f")!;
    const base = body(
      `function f(a, b) { const total = a + b; const scaled = total * 2; return scaled + a + b + total; }`,
    );
    const spaced = body(
      `function f(a, b) {
  // a comment
  const total = a + b;
  const scaled = total * 2;
  return scaled + a + b + total;
}`,
    );
    const changed = body(
      `function f(a, b) { const total = a - b; const scaled = total * 2; return scaled + a + b + total; }`,
    );
    expect(base.fingerprint).not.toBeNull();
    expect(base.fingerprint).toBe(spaced.fingerprint);
    expect(base.fingerprint).not.toBe(changed.fingerprint);
  });

  it("skips fingerprints for tiny bodies", () => {
    const { symbols } = parseSource("a.ts", `function f() { return 1; }`);
    expect(symbols[0]!.fingerprint).toBeNull();
  });
});

function record(path: string, text: string, resolve: Record<string, string> = {}): CallGraphRecord {
  const parsed = parseSource(path, text);
  return {
    path,
    symbols: parsed.symbols,
    resolvedImports: parsed.imports.map(({ specifier, names }) => ({
      specifier,
      resolved: resolve[specifier] ?? null,
      names,
    })),
  };
}

function recordsOf(...recs: CallGraphRecord[]): Map<string, CallGraphRecord> {
  return new Map(recs.map((r) => [r.path, r]));
}

describe("buildCallGraph", () => {
  it("resolves same-file and named-import calls", () => {
    const a = record(
      "a.ts",
      `import { helper } from "./b.js";
export function main() { local(); helper(); mystery(); }
function local() {}`,
      { "./b.js": "b.ts" },
    );
    const b = record("b.ts", `export function helper() {}`);
    const graph = buildCallGraph(recordsOf(a, b));
    const main = graph.get(callKey({ file: "a.ts", symbol: "main" }))!;
    expect(main.resolved).toContainEqual({ file: "a.ts", symbol: "local" });
    expect(main.resolved).toContainEqual({ file: "b.ts", symbol: "helper" });
    expect(main.unresolved).toEqual(["mystery"]);
  });

  it("resolves namespace-import calls", () => {
    const a = record(
      "a.ts",
      `import * as util from "./b.js";
export function main() { util.deep(); }`,
      { "./b.js": "b.ts" },
    );
    const b = record("b.ts", `export function deep() {}`);
    const graph = buildCallGraph(recordsOf(a, b));
    expect(graph.get("a.ts#main")!.resolved).toEqual([{ file: "b.ts", symbol: "deep" }]);
  });

  it("follows barrel re-export chains", () => {
    const a = record(
      "a.ts",
      `import { helper } from "./index.js";
export function main() { helper(); }`,
      { "./index.js": "index.ts" },
    );
    const barrel = record("index.ts", `export { helper } from "./impl.js";\nexport * from "./more.js";`, {
      "./impl.js": "impl.ts",
      "./more.js": "more.ts",
    });
    const impl = record("impl.ts", `export function helper() {}`);
    const more = record("more.ts", `export function other() {}`);
    const graph = buildCallGraph(recordsOf(a, barrel, impl, more));
    expect(graph.get("a.ts#main")!.resolved).toEqual([{ file: "impl.ts", symbol: "helper" }]);
  });

  it("keeps instance-method calls in unresolved and drops ambient globals", () => {
    const a = record(
      "a.ts",
      `export function main() { thing.save(); console.log("x"); setTimeout(main, 1); }`,
    );
    const graph = buildCallGraph(recordsOf(a));
    expect(graph.get("a.ts#main")!.unresolved).toEqual(["thing.save"]);
  });

  it("is cycle-safe through mutually recursive symbols", () => {
    const a = record("a.ts", `export function ping() { pong(); }\nexport function pong() { ping(); }`);
    const graph = buildCallGraph(recordsOf(a));
    expect(graph.get("a.ts#ping")!.resolved).toEqual([{ file: "a.ts", symbol: "pong" }]);
    expect(graph.get("a.ts#pong")!.resolved).toEqual([{ file: "a.ts", symbol: "ping" }]);
  });
});

/** Parse fixture sources and resolve their relative imports against each other. */
function analyzeFixture(fixture: Record<string, { module: string; text: string }>) {
  const fileSet = new Set(Object.keys(fixture));
  const records = new Map<string, JourneySourceRecord>();
  const importedBy = new Map<string, Set<string>>();
  for (const [file, { module, text }] of Object.entries(fixture)) {
    const parsed = parseSource(file, text);
    const resolvedImports = parsed.imports.map(({ specifier, names }) => {
      let resolved: string | null = null;
      if (specifier.startsWith(".")) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, ".ts")]) {
          if (fileSet.has(candidate)) {
            resolved = candidate;
            break;
          }
        }
      }
      if (resolved) {
        let set = importedBy.get(resolved);
        if (!set) importedBy.set(resolved, (set = new Set()));
        set.add(file);
      }
      return { specifier, resolved, names };
    });
    records.set(file, { path: file, module, symbols: parsed.symbols, resolvedImports });
  }
  return { records, importedBy, graph: buildCallGraph(records) };
}

const JOURNEY_FIXTURE = {
  "apps/web/src/main.ts": {
    module: "apps/web",
    text: `import { render } from "./app.js";
export function start() { render(); }`,
  },
  "apps/web/src/app.ts": {
    module: "apps/web",
    text: `import { fetchOrders } from "../../../packages/core/src/orders.js";
export function render() { fetchOrders(); paint(); }
function paint() {}`,
  },
  "packages/core/src/index.ts": {
    module: "packages/core",
    text: `export * from "./orders.js";`,
  },
  "packages/core/src/orders.ts": {
    module: "packages/core",
    text: `import { query } from "./db.js";
export function fetchOrders() { return query(); }`,
  },
  "packages/core/src/db.ts": {
    module: "packages/core",
    text: `export function query() { return connect(); }
function connect() {}`,
  },
  "scripts/tiny.ts": {
    module: ".",
    text: `export function tiny() { console.log("hi"); }`,
  },
  "apps/web/src/flow.test.ts": {
    module: "apps/web",
    text: `import { fetchOrders } from "../../../packages/core/src/orders.js";
export function testFlow() { fetchOrders(); }`,
  },
};

describe("rankJourneySuggestions", () => {
  it("suggests entry points that fan out across modules, widest first", () => {
    const { records, importedBy, graph } = analyzeFixture(JOURNEY_FIXTURE);
    const suggestions = rankJourneySuggestions(records, graph, importedBy);
    const [top] = suggestions;
    expect(top!.entry).toEqual({ file: "apps/web/src/main.ts", symbol: "start" });
    expect(top!.entryModule).toBe("apps/web");
    expect(top!.moduleSpan).toBe(2); // apps/web + packages/core
    // start → render → {fetchOrders, paint} → query → connect
    expect(top!.stepCount).toBe(6);
    // render (one importer — reached via main) qualifies too, ranked below start.
    expect(suggestions.map((s) => s.entry.symbol)).toEqual(["start", "render"]);
  });

  it("excludes test files and trivially shallow traces", () => {
    const { records, importedBy, graph } = analyzeFixture(JOURNEY_FIXTURE);
    const files = rankJourneySuggestions(records, graph, importedBy).map((s) => s.entry.file);
    expect(files).not.toContain("apps/web/src/flow.test.ts"); // spans 2 modules, but a test
    expect(files).not.toContain("scripts/tiny.ts"); // only ambient calls
  });

  it("skips shared utilities — files with many importers", () => {
    const { records, importedBy, graph } = analyzeFixture(JOURNEY_FIXTURE);
    // orders.ts is imported by app.ts, the core barrel, and the test file (3 > 2).
    expect(importedBy.get("packages/core/src/orders.ts")!.size).toBeGreaterThan(2);
    const symbols = rankJourneySuggestions(records, graph, importedBy).map((s) => s.entry.symbol);
    expect(symbols).not.toContain("fetchOrders");
  });

  it("caps suggestions per entry module for diversity", () => {
    const alt = (n: string) => ({
      module: "apps/web",
      text: `import { render } from "./app.js";
export function ${n}() { render(); }`,
    });
    const { records, importedBy, graph } = analyzeFixture({
      ...JOURNEY_FIXTURE,
      "apps/web/src/alt1.ts": alt("altOne"),
      "apps/web/src/alt2.ts": alt("altTwo"),
      "apps/web/src/alt3.ts": alt("altThree"),
    });
    const suggestions = rankJourneySuggestions(records, graph, importedBy);
    expect(suggestions.filter((s) => s.entryModule === "apps/web")).toHaveLength(2);
  });
});

describe("CodeMapAnalyzer symbol queries", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  const DUP_BODY = `{
  const parts = input.split(",").map((p) => p.trim());
  const filtered = parts.filter((p) => p.length > 0);
  return filtered.map((p) => p.toUpperCase()).join("|");
}`;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-codemap-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "entry.ts"),
      `import { helper } from "./lib.js";
export function main() {
  helper();
  loop();
}
function loop() {
  main();
  unknownThing.go();
}
export function dupA(input: string) ${DUP_BODY}
`,
    );
    await fs.writeFile(
      path.join(root, "lib.ts"),
      `export function helper() {
  return leaf();
}
function leaf() {
  return 42;
}
function dupB(input: string) ${DUP_BODY}
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("traces BFS with depths, cycle-safety, and unresolved calls", async () => {
    const trace = await analyzer.trace("entry.ts", "main");
    const at = (file: string, symbol: string) =>
      trace.steps.find((s) => s.ref.file === file && s.ref.symbol === symbol);
    expect(at("entry.ts", "main")).toMatchObject({ depth: 0 });
    expect(at("entry.ts", "loop")).toMatchObject({ depth: 1 });
    expect(at("lib.ts", "helper")).toMatchObject({ depth: 1 });
    expect(at("lib.ts", "leaf")).toMatchObject({ depth: 2 });
    // Each symbol appears once despite the main↔loop cycle.
    expect(trace.steps.filter((s) => s.ref.symbol === "main")).toHaveLength(1);
    expect(trace.truncated).toBe(false);
    expect(trace.unresolvedCalls).toContainEqual({
      from: { file: "entry.ts", symbol: "loop" },
      callee: "unknownThing.go",
    });
  });

  it("throws on unknown trace entries", async () => {
    await expect(analyzer.trace("entry.ts", "nope")).rejects.toThrow(/No top-level symbol/);
  });

  it("clusters duplicate function bodies across files", async () => {
    const clusters = await analyzer.duplicates();
    const cluster = clusters.find((c) => c.instances.some((i) => i.symbol === "dupA"));
    expect(cluster).toBeDefined();
    expect(cluster!.instances.map((i) => `${i.file}#${i.symbol}`).sort()).toEqual([
      "entry.ts#dupA",
      "lib.ts#dupB",
    ]);
    expect(cluster!.instances.find((i) => i.symbol === "dupB")!.exported).toBe(false);
  });

  it("returns symbol source slices with line info", async () => {
    const src = await analyzer.symbolSource("lib.ts", "helper");
    expect(src.startLine).toBe(1);
    expect(src.endLine).toBe(3);
    expect(src.text).toBe(`export function helper() {\n  return leaf();\n}`);
    expect(src.truncated).toBe(false);
  });

  it("searches symbols ranking exported and prefix matches first", async () => {
    const hits = await analyzer.searchSymbols("dup");
    expect(hits.map((h) => h.name)).toEqual(["dupA", "dupB"]);
    expect(hits[0]).toMatchObject({ file: "entry.ts", exported: true });
  });
});

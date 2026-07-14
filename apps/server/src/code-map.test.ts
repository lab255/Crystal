import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCallGraph,
  callKey,
  CodeMapAnalyzer,
  declaredEntryPaths,
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

  it("captures signatures for function-like exports", () => {
    const { exports } = parseSource(
      "svc.ts",
      `export function getForm(id: string, opts?: { deep: boolean }): Promise<Form> { return load(id); }
export const submit = async (payload: Payload) => send(payload);
export const LIMIT = 25;
export interface Form { id: string }`,
    );
    const byName = Object.fromEntries(exports.map((e) => [e.name, e.signature]));
    expect(byName["getForm"]).toBe("(id: string, opts?: { deep: boolean }): Promise<Form>");
    expect(byName["submit"]).toBe("(payload: Payload)");
    expect(byName["LIMIT"]).toBeUndefined();
    expect(byName["Form"]).toBeUndefined();
  });

  it("detects served routes on registrar receivers, not map lookups", () => {
    const { endpoints, apiCalls } = parseSource(
      "routes.ts",
      `import express from "express";
const app = express();
app.get("/api/forms", listForms);
app.post("/api/forms/:formId/submissions", submitForm);
app.get("/no-handler");
cache.get("/api/forms");
const map = new Map();
map.get("/api/forms", extra);`,
    );
    expect(endpoints).toEqual([
      { method: "GET", path: "/api/forms", line: 3, handler: "listForms" },
      { method: "POST", path: "/api/forms/:formId/submissions", line: 4, handler: "submitForm" },
    ]);
    expect(apiCalls).toEqual([]);
  });

  it("detects outgoing HTTP calls: fetch, axios, template holes", () => {
    const { endpoints, apiCalls } = parseSource(
      "client.ts",
      `import axios from "axios";
await fetch("/api/forms");
await fetch(\`/api/forms/\${id}\`, { method: "DELETE" });
await axios.post("https://api.stripe.com/v1/charges", body);
await fetch(relativeUrl);`,
    );
    expect(endpoints).toEqual([]);
    expect(apiCalls).toEqual([
      { method: "GET", path: "/api/forms", line: 2 },
      { method: "DELETE", path: "/api/forms/*", line: 3 },
      { method: "POST", path: "/v1/charges", line: 4 },
    ]);
  });

  it("reads instance-named clients and suffix-named routers", () => {
    // Frontend convention: a named axios instance in another file — the
    // calling file imports the instance, not the HTTP package.
    const client = parseSource(
      "features/user/UserService.ts",
      `import { ApiService } from "../../services/ApiService";
await ApiService.put("/user/settings", body);
await ApiService.get(\`/user/\${id}\`);
rapid.get("/not-an-api");`,
    );
    expect(client.endpoints).toEqual([]);
    expect(client.apiCalls).toEqual([
      { method: "PUT", path: "/user/settings", line: 2 },
      { method: "GET", path: "/user/*", line: 3 },
    ]);

    // Backend convention: nested routers named *Router registering tails.
    const server = parseSource(
      "routes/admin-forms.routes.ts",
      `import { Router } from "express";
export const AdminFormsRouter = Router();
AdminFormsRouter.get("/:formId/fields", AdminFormsController.handleGet);`,
    );
    expect(server.endpoints).toEqual([
      {
        method: "GET",
        path: "/:formId/fields",
        line: 3,
        handler: "AdminFormsController.handleGet",
      },
    ]);
    expect(server.apiCalls).toEqual([]);

    // An api-named receiver registering an inline handler is not a call.
    const inline = parseSource(
      "routes/inline.ts",
      `api.get("/ping", (req, res) => res.send("pong"));`,
    );
    expect(inline.apiCalls).toEqual([]);
  });

  it("resolves same-file endpoint constants in call paths", () => {
    const { apiCalls } = parseSource(
      "features/admin-form/AdminViewFormService.ts",
      `import { ApiService } from "~services/ApiService";
export const ADMIN_FORM_ENDPOINT = "/admin/forms";
await ApiService.get(\`\${ADMIN_FORM_ENDPOINT}/\${formId}/fields\`);
await ApiService.post(ADMIN_FORM_ENDPOINT, body);
await ApiService.get(\`\${UNKNOWN_BASE}/settings\`);`,
    );
    expect(apiCalls).toEqual([
      { method: "GET", path: "/admin/forms/*/fields", line: 3 },
      { method: "POST", path: "/admin/forms", line: 4 },
      // Unresolved prefix drops out; suffix route matching absorbs the mount.
      { method: "GET", path: "/settings", line: 5 },
    ]);
  });

  it("derives routes from Next-style file conventions", () => {
    const appRoute = parseSource(
      "apps/web/app/api/forms/[formId]/route.ts",
      `export async function GET(req: Request) { return ok(); }
export async function POST(req: Request) { return ok(); }
export function helper() {}`,
    );
    expect(appRoute.endpoints).toEqual([
      { method: "GET", path: "/api/forms/:formId" },
      { method: "POST", path: "/api/forms/:formId" },
    ]);
    const pagesApi = parseSource("apps/web/pages/api/forms/index.ts", `export default function handler() {}`);
    expect(pagesApi.endpoints).toEqual([{ method: "ALL", path: "/api/forms" }]);
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
    expect(calls).toContainEqual({ name: "helper", receiver: null, line: 3 });
    expect(calls).toContainEqual({ name: "deep", receiver: "ns", line: 4 });
    expect(calls).toContainEqual({ name: "method", receiver: "obj", line: 5 });
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

  it("locates a symbol's import and call sites with inline source", async () => {
    const sites = await analyzer.symbolSites("lib.ts", "helper");
    expect(sites.declaration).toMatchObject({ line: 1, endLine: 3 });
    expect(sites.imports).toContainEqual({
      file: "entry.ts",
      line: 1,
      text: `import { helper } from "./lib.js";`,
    });
    expect(sites.calls).toContainEqual({
      file: "entry.ts",
      line: 3,
      symbol: "main",
      text: "helper();",
    });
    expect(sites.truncated).toBe(false);
  });

  it("searches symbols ranking exported and prefix matches first", async () => {
    const hits = await analyzer.searchSymbols("dup");
    expect(hits.map((h) => h.name)).toEqual(["dupA", "dupB"]);
    expect(hits[0]).toMatchObject({ file: "entry.ts", exported: true });
  });

  it("bulkDetails serves every module and file in one pass", async () => {
    const { modules, files } = await analyzer.bulkDetails();
    expect(modules.map((m) => m.module.path)).toEqual(["."]);
    expect(files.map((f) => f.path).sort()).toEqual(["entry.ts", "lib.ts"]);
    // matches the single-call results exactly
    expect(files.find((f) => f.path === "lib.ts")).toEqual(await analyzer.fileDetail("lib.ts"));
    expect(modules[0]).toEqual(await analyzer.moduleDetail("."));
    // an explicit module list narrows the pass
    const scoped = await analyzer.bulkDetails(["."]);
    expect(scoped.modules).toHaveLength(1);
    await expect(analyzer.bulkDetails(["nope"])).rejects.toThrow(/Unknown module/);
  });
});

describe("CodeMapAnalyzer api sites", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-apisites-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "routes.ts"),
      `import { Router } from "express";
export const FormsRouter = Router();
FormsRouter.get("/:formId/fields", handleGet);
`,
    );
    await fs.writeFile(
      path.join(root, "client.ts"),
      `import axios from "axios";
export const FORMS = "/api/v3/admin/forms";
await axios.get(\`\${FORMS}/\${id}/fields\`);
await axios.get(\`\${FORMS}/\${id}/settings\`);
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds call sites addressing a served route, through router mounts", async () => {
    const { sites } = await analyzer.apiSites("GET", "/:formId/fields");
    expect(sites).toEqual([
      { file: "client.ts", line: 3, method: "GET", path: "/api/v3/admin/forms/*/fields" },
    ]);
    // Non-matching tails don't count.
    const none = await analyzer.apiSites("POST", "/:formId/fields");
    expect(none.sites).toEqual([]);
  });
});

describe("CodeMapAnalyzer part crossings", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-crossings-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    const write = async (rel: string, text: string) => {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text);
    };
    await write(
      "src/auth/login.ts",
      `import { query } from "../db/client.js";
import { users } from "../db/schema/tables.js";
export function login() {
  return query(users);
}
`,
    );
    await write(
      "src/auth/session.ts",
      `import { query } from "../db/client.js";
export function session() {
  return query("sessions");
}
`,
    );
    await write("src/db/client.ts", `export function query(x: unknown) {\n  return x;\n}\n`);
    await write("src/db/schema/tables.ts", `export const users = "users";\n`);
    await write(
      "src/other/report.ts",
      `import { query } from "../db/client.js";
export const report = query("report");
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists import statements crossing a part pair with inline source", async () => {
    const res = await analyzer.partCrossings("src/auth", "src/db");
    expect(res.sourcePart).toBe("src/auth");
    expect(res.truncated).toBe(false);
    // Without part lists, ownership is plain prefix — the nested schema
    // import counts as src/db traffic too.
    expect(res.crossings).toEqual([
      {
        file: "src/auth/login.ts",
        line: 1,
        names: ["query"],
        targetFile: "src/db/client.ts",
        text: `import { query } from "../db/client.js";`,
      },
      {
        file: "src/auth/login.ts",
        line: 2,
        names: ["users"],
        targetFile: "src/db/schema/tables.ts",
        text: `import { users } from "../db/schema/tables.js";`,
      },
      {
        file: "src/auth/session.ts",
        line: 1,
        names: ["query"],
        targetFile: "src/db/client.ts",
        text: `import { query } from "../db/client.js";`,
      },
    ]);
  });

  it("resolves ownership by longest prefix over the provided part lists", async () => {
    const targetParts = ["src/db", "src/db/schema"];
    // Files under the nested schema part no longer count as src/db traffic…
    const db = await analyzer.partCrossings("src/auth", "src/db", ["src/auth"], targetParts);
    expect(db.crossings.map((c) => c.targetFile)).toEqual([
      "src/db/client.ts",
      "src/db/client.ts",
    ]);
    // …they belong to the schema pair instead.
    const schema = await analyzer.partCrossings(
      "src/auth",
      "src/db/schema",
      ["src/auth"],
      targetParts,
    );
    expect(schema.crossings).toHaveLength(1);
    expect(schema.crossings[0]).toMatchObject({
      file: "src/auth/login.ts",
      targetFile: "src/db/schema/tables.ts",
      names: ["users"],
    });
  });

  it("ignores files outside the source part", async () => {
    const res = await analyzer.partCrossings("src/other", "src/db");
    expect(res.crossings.map((c) => c.file)).toEqual(["src/other/report.ts"]);
  });
});

describe("CodeMapAnalyzer tsconfig paths aliases", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-tspaths-"));
    const app = path.join(root, "packages", "app");
    await fs.mkdir(path.join(app, "src", "pages"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture-root" }));
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    await fs.writeFile(
      path.join(app, "package.json"),
      JSON.stringify({ name: "@fixture/app" }),
    );
    await fs.writeFile(
      path.join(app, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { baseUrl: "./src", paths: { "@/*": ["./*"] } },
      }),
    );
    await fs.writeFile(
      path.join(app, "src", "main.tsx"),
      `import { HomePage } from "@/pages/home";
export function App() {
  return HomePage();
}
`,
    );
    await fs.writeFile(
      path.join(app, "src", "pages", "home.tsx"),
      `export function HomePage() {
  return null;
}
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves @/ alias imports so aliased files are not orphaned", async () => {
    const detail = await analyzer.fileDetail("packages/app/src/pages/home.tsx");
    expect(detail.importedBy).toEqual(["packages/app/src/main.tsx"]);
  });

  it("threads alias resolution into the call graph", async () => {
    const trace = await analyzer.trace("packages/app/src/main.tsx", "App");
    expect(trace.steps.map((s) => s.ref.symbol)).toContain("HomePage");
  });
});

describe("declaredEntryPaths", () => {
  it("collects bin/main/exports targets and script-referenced files", () => {
    const entries = declaredEntryPaths("packages/cli", {
      main: "./dist/appliance.js",
      bin: { appliance: "./bin/appliance.js" },
      exports: { ".": { import: "./dist/esm/index.js" } },
      scripts: { postinstall: "node scripts/install-binary.mjs", lint: "eslint ." },
    });
    expect(entries).toContain("packages/cli/bin/appliance.js");
    expect(entries).toContain("packages/cli/scripts/install-binary.mjs");
    // Built outputs map back to their likely sources.
    expect(entries).toContain("packages/cli/src/appliance.ts");
    expect(entries).toContain("packages/cli/src/esm/index.ts");
  });

  it("handles the workspace root and rejects escapes", () => {
    const entries = declaredEntryPaths(".", { main: "index.js", bin: "../evil.js" });
    expect(entries).toContain("index.js");
    expect(entries).toContain("index.ts");
    expect(entries.some((e) => e.includes(".."))).toBe(false);
  });
});

describe("dead-file entry awareness", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-entries-"));
    const cli = path.join(root, "packages", "cli");
    await fs.mkdir(path.join(cli, "bin"), { recursive: true });
    await fs.mkdir(path.join(cli, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "vite.config.ts"),
      "export default { server: { port: 5173 } };",
    );
    await fs.writeFile(
      path.join(cli, "package.json"),
      JSON.stringify({
        name: "@fixture/cli",
        main: "dist/cli.js",
        bin: { fixture: "./bin/fixture.js" },
      }),
    );
    await fs.writeFile(path.join(cli, "bin", "fixture.js"), "export const run = () => {};");
    await fs.writeFile(path.join(cli, "src", "cli.ts"), "export function main() {}");
    await fs.writeFile(path.join(cli, "src", "orphan.ts"), "export function nobody() {}");
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("treats declared and convention entries as alive, real orphans as dead", async () => {
    const files = await analyzer.reviewSourceFiles();
    const entryOf = Object.fromEntries(files.map((f) => [f.path, f.entry]));
    expect(entryOf["vite.config.ts"]).toBe(true); // config convention
    expect(entryOf["packages/cli/bin/fixture.js"]).toBe(true); // declared bin
    expect(entryOf["packages/cli/src/cli.ts"]).toBe(true); // dist main → src source
    expect(entryOf["packages/cli/src/orphan.ts"]).toBe(false); // genuinely dead
  });
});

describe("instance-method dispatch", () => {
  it("records calls through non-null-asserted receivers", () => {
    const { symbols } = parseSource(
      "page.tsx",
      `export function Page() {
  const r = client!.listDeployments({ limit: 100 });
  const s = (api as ApiClient).fetchUsers();
  return r && s;
}
`,
    );
    const calls = symbols[0]!.calls;
    expect(calls).toContainEqual({ name: "listDeployments", receiver: "client", line: 2 });
    expect(calls).toContainEqual({ name: "fetchUsers", receiver: "api", line: 3 });
  });

  it("records class method names on the class symbol", () => {
    const { symbols } = parseSource(
      "client.ts",
      `export class ApiClient {
  async listDeployments() { return fetch("/api/v1/deployments"); }
  async cancelDeployment(id: string) { return fetch("/api/v1/deployments/" + id, { method: "POST" }); }
}
`,
    );
    expect(symbols[0]!.methods?.map((m) => m.name)).toEqual([
      "listDeployments",
      "cancelDeployment",
    ]);
    expect(symbols[0]!.methods?.[0]).toMatchObject({ line: 2, endLine: 2 });
  });

  it("resolves a receiver call to the unique class declaring the method", () => {
    const records = new Map<string, CallGraphRecord>([
      [
        "page.tsx",
        {
          path: "page.tsx",
          symbols: [
            {
              name: "Page", kind: "component", line: 1, endLine: 4, start: 0, end: 100,
              exported: true, fingerprint: null, tokenCount: 0,
              calls: [{ name: "listDeployments", receiver: "client", line: 2 }],
            },
          ],
          resolvedImports: [],
        },
      ],
      [
        "client.ts",
        {
          path: "client.ts",
          symbols: [
            {
              name: "ApiClient", kind: "class", line: 1, endLine: 8, start: 0, end: 300,
              exported: true, fingerprint: null, tokenCount: 0,
              calls: [], methods: [{ name: "listDeployments", line: 2, endLine: 4 }],
            },
          ],
          resolvedImports: [],
        },
      ],
    ]);
    const graph = buildCallGraph(records);
    const page = graph.get(callKey({ file: "page.tsx", symbol: "Page" }))!;
    expect(page.resolved).toEqual([{ file: "client.ts", symbol: "ApiClient" }]);
  });

  it("keeps ambiguous and generic method names unresolved", () => {
    const classRec = (file: string, cls: string): [string, CallGraphRecord] => [
      file,
      {
        path: file,
        symbols: [
          {
            name: cls, kind: "class", line: 1, endLine: 5, start: 0, end: 100,
            exported: true, fingerprint: null, tokenCount: 0,
            calls: [],
            methods: [
              { name: "refreshThings", line: 2, endLine: 2 },
              { name: "toString", line: 3, endLine: 3 },
              { name: "get", line: 4, endLine: 4 },
            ],
          },
        ],
        resolvedImports: [],
      },
    ];
    const records = new Map<string, CallGraphRecord>([
      classRec("a.ts", "AClient"),
      classRec("b.ts", "BClient"),
      [
        "page.tsx",
        {
          path: "page.tsx",
          symbols: [
            {
              name: "Page", kind: "component", line: 1, endLine: 6, start: 0, end: 100,
              exported: true, fingerprint: null, tokenCount: 0,
              calls: [
                { name: "refreshThings", receiver: "client", line: 2 }, // ambiguous: two classes
                { name: "toString", receiver: "client", line: 3 }, // generic
                { name: "get", receiver: "client", line: 4 }, // too short
              ],
            },
          ],
          resolvedImports: [],
        },
      ],
    ]);
    const page = buildCallGraph(records).get(callKey({ file: "page.tsx", symbol: "Page" }))!;
    expect(page.resolved).toEqual([]);
  });
});

describe("CodeMapAnalyzer apiTrace through a client class", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-apitrace-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "src", "server.ts"),
      `import express from "express";
const router = express.Router();
router.get("/api/v1/deployments", (req, res) => res.json([]));
export default router;
`,
    );
    await fs.writeFile(
      path.join(root, "src", "client.ts"),
      `export class ApiClient {
  baseUrl = "";
  async listDeployments() {
    return this.request("GET", \`/api/v1/deployments\${""}\`);
  }
  async deleteEverything() {
    return this.request("DELETE", "/api/v1/everything");
  }
  private async request(method: string, path: string) {
    return fetch(this.baseUrl + path, { method });
  }
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "page.tsx"),
      `import { ApiClient } from "./client";
const client: ApiClient | null = new ApiClient();
export function DeploymentsPage() {
  const data = client!.listDeployments();
  return data;
}
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("follows component → client method → request helper → served endpoint", async () => {
    const trace = await analyzer.apiTrace("src/page.tsx", "DeploymentsPage");
    expect(trace.calls.length).toBeGreaterThan(0);
    const call = trace.calls.find((c) => c.path === "/api/v1/deployments")!;
    expect(call.file).toBe("src/client.ts");
    expect(call.endpoint).toMatchObject({ method: "GET", path: "/api/v1/deployments", file: "src/server.ts" });
  });

  it("only reports the methods the page actually invokes, not the whole client", async () => {
    const trace = await analyzer.apiTrace("src/page.tsx", "DeploymentsPage");
    expect(trace.calls.some((c) => c.path === "/api/v1/everything")).toBe(false);
  });
});

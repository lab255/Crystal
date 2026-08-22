import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeIndex, CodeMapProgress } from "@crystal/core";
import {
  buildCallGraph,
  callKey,
  CodeMapAnalyzer,
  declaredEntryPaths,
  dirModuleOwner,
  parseSource,
  rankJourneySuggestions,
  synthesizeDirModules,
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

  it("names identifier default exports and marks their symbol exported", () => {
    const { exports, symbols, imports } = parseSource(
      "routes.ts",
      `import { Router } from "express";
const router = Router();
router.get("/forms", (req, res) => res.json([]));
export default router;`,
    );
    expect(exports).toEqual([{ name: "router", kind: "default", line: 4 }]);
    expect(symbols.find((s) => s.name === "router")!.exported).toBe(true);
    expect(imports[0]!.defaultName).toBeUndefined();
  });

  it("records the default-import binding as defaultName", () => {
    const { imports } = parseSource(
      "app.ts",
      `import formsRouter from "./routes";
import express, { json } from "express";
import { named } from "./other";`,
    );
    expect(imports[0]).toMatchObject({ names: ["formsRouter"], defaultName: "formsRouter" });
    expect(imports[1]).toMatchObject({ names: ["express", "json"], defaultName: "express" });
    expect(imports[2]!.defaultName).toBeUndefined();
  });

  it("keeps non-identifier default exports anonymous", () => {
    const { exports } = parseSource("config.ts", `export default { port: 4517 };`);
    expect(exports).toEqual([{ name: "default", kind: "default", line: 1 }]);
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

  it("detects celebrate validation middleware on served routes", () => {
    const { endpoints } = parseSource(
      "routes.ts",
      `import express from "express";
import { celebrate } from "celebrate";
const app = express();
app.post("/api/forms", celebrate({ body: createFormSchema }), createForm);`,
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.validation).toEqual([
      {
        kind: "celebrate",
        label: "celebrate({ body: createFormSchema })",
        target: "request",
        line: 4,
      },
    ]);
  });

  it("detects zod parses inside inline handlers", () => {
    const { endpoints } = parseSource(
      "routes.ts",
      `import express from "express";
const app = express();
app.post("/api/forms", (req, res) => {
  const data = formSchema.parse(req.body);
  res.json(data);
});`,
    );
    expect(endpoints).toHaveLength(1);
    const validation = endpoints[0]!.validation!;
    expect(validation).toHaveLength(1);
    expect(validation[0]).toMatchObject({ kind: "zod", target: "body" });
  });

  it("omits the validation key on unvalidated routes", () => {
    const { endpoints } = parseSource(
      "routes.ts",
      `import express from "express";
const app = express();
app.get("/api/forms", (req, res) => res.json([]));`,
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).not.toHaveProperty("validation");
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

  it("propagates paths through a same-file fetch wrapper (template + const base)", () => {
    const { apiCalls } = parseSource(
      "admin/src/api.ts",
      `const BASE = "/api";
async function get<T>(path: string): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`, { headers: { "x-session-id": sid() } });
  return res.json();
}
export function fetchInvoices() {
  return get("/invoices");
}
export function fetchAging() {
  return get("/reports/aging");
}`,
    );
    expect(apiCalls).toEqual([
      // The wrapper's own degenerate "GET /api" is dropped; call sites carry
      // the real routes, joined to the helper's resolved prefix.
      { method: "GET", path: "/api/invoices", line: 7 },
      { method: "GET", path: "/api/reports/aging", line: 10 },
    ]);
  });

  it("propagates paths through a class request helper with call-site methods", () => {
    const { apiCalls } = parseSource(
      "apps/web/src/api/client.ts",
      `export class ApiClient {
  constructor(private config: { baseUrl: string }) {}
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.config.baseUrl + path, { ...init });
    return response.json();
  }
  async createBooking(body: unknown) {
    return this.request("/api/bookings", { method: "POST", body: JSON.stringify(body) });
  }
  async searchAvailability(qs: string) {
    return this.request("/api/availability?" + qs);
  }
}`,
    );
    expect(apiCalls).toEqual([
      // Unseen base URL drops out (suffix matching absorbs it); the method
      // comes from the call site's init when the helper spreads it through.
      { method: "POST", path: "/api/bookings", line: 8 },
      { method: "GET", path: "/api/availability", line: 11 },
    ]);
  });

  it("verb-first request helpers take the method from the call site, once", () => {
    const { apiCalls } = parseSource(
      "src/client.ts",
      `export class Api {
  async send<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(path, { method, body: JSON.stringify(body) });
    return res.json();
  }
  createOrder(body: unknown) {
    return this.send("/api/orders", "POST", body);
  }
  listOrders() {
    return this.send("/api/orders", "GET");
  }
}`,
    );
    expect(apiCalls).toEqual([
      { method: "POST", path: "/api/orders", line: 7 },
      { method: "GET", path: "/api/orders", line: 10 },
    ]);
  });

  it("id-parameterized URLs are not wrappers — the wildcard call survives", () => {
    const { apiCalls } = parseSource(
      "src/users.ts",
      `export function fetchProfile(id: string) {
  return fetch(\`/api/users/\${id}/profile\`);
}
export function loadCurrent() {
  return fetchProfile("me");
}`,
    );
    // The path parameter isn't final — classic hole-as-segment behavior wins,
    // and the call site emits nothing extra.
    expect(apiCalls).toEqual([{ method: "GET", path: "/api/users/*/profile", line: 2 }]);
  });

  it("wrappers invoked only with computed arguments keep their wildcard call", () => {
    const { apiCalls } = parseSource(
      "src/api.ts",
      `function get(path: string) {
  return fetch(\`/api/\${path}\`);
}
export function load(route: { url: string }) {
  return get(route.url);
}`,
    );
    expect(apiCalls).toEqual([{ method: "GET", path: "/api/*", line: 2 }]);
  });

  it("does not match wrappers through instance receivers or registration shapes", () => {
    const { apiCalls, endpoints } = parseSource(
      "src/mixed.ts",
      `import axios from "axios";
function get(path: string) {
  return fetch("/internal" + path);
}
export function loadUsers() {
  return axios.get("/users");
}
export function setup(app: unknown) {
  get("/probe", () => {});
}
export function warm() {
  return get("/warmup");
}`,
    );
    // axios.get stays the clientish branch's own call — no /internal prefix
    // gluing; the handler-shaped call emits nothing; the plain call resolves.
    expect(apiCalls).toEqual([
      { method: "GET", path: "/users", line: 6 },
      { method: "GET", path: "/internal/warmup", line: 12 },
    ]);
    expect(endpoints).toEqual([]);
  });

  it("rejects concatenated paths for server registrations and mounts", () => {
    const { endpoints, mounts, apiCalls } = parseSource(
      "src/routes.ts",
      `import express from "express";
const app = express();
const BASE = "/admin";
app.get(BASE + "/users", listUsers);
app.use(BASE + "/sub", subRouter);
app.get("/plain", listPlain);
`,
    );
    expect(endpoints).toEqual([{ method: "GET", path: "/plain", line: 6, handler: "listPlain" }]);
    expect(mounts).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it("marks JSX elements as render calls and namespaced tags as the compound root", () => {
    const { symbols } = parseSource(
      "src/Screen.tsx",
      `import { Tabs } from "./tabs.js";
import { Header } from "./header.js";
export function Screen() {
  const load = () => refresh();
  return (
    <div>
      <Header />
      <Tabs.Item />
    </div>
  );
}`,
    );
    const screen = symbols.find((s) => s.name === "Screen")!;
    const renders = screen.calls.filter((c) => c.render);
    expect(renders.map((c) => c.name).sort()).toEqual(["Header", "Tabs"]);
    expect(renders.every((c) => c.receiver === null)).toBe(true);
    expect(screen.calls.some((c) => c.name === "refresh" && !c.render)).toBe(true);
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
    exports: parsed.exports,
    resolvedImports: parsed.imports.map(({ specifier, names, defaultName }) => ({
      specifier,
      resolved: resolve[specifier] ?? null,
      names,
      ...(defaultName ? { defaultName } : {}),
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

describe("dynamic references", () => {
  it("collects handler references from call arguments, arrays, tables, and JSX props", () => {
    const { symbols } = parseSource(
      "src/wiring.tsx",
      `import { save } from "./svc.js";
function handler() {}
function mw() {}
export function setup(app) {
  app.get("/x", mw, handler);
  app.use([mw, ...extras]);
}
export const table = { create: handler, remove: save };
export function Screen() {
  return <button onClick={save} />;
}
export const chain = [mw, handler] as unknown[];`,
    );
    const setup = symbols.find((s) => s.name === "setup")!;
    expect(setup.calls.filter((c) => c.dynamic).map((c) => c.name)).toEqual([
      "mw",
      "handler",
      "mw",
      "extras",
    ]);
    const table = symbols.find((s) => s.name === "table")!;
    expect(table.calls).toEqual([
      { name: "handler", receiver: null, line: 8, dynamic: true },
      { name: "save", receiver: null, line: 8, dynamic: true },
    ]);
    // FormSG-style middleware chain: an `as`-wrapped array of handlers.
    const chain = symbols.find((s) => s.name === "chain")!;
    expect(chain.calls).toEqual([
      { name: "mw", receiver: null, line: 12, dynamic: true },
      { name: "handler", receiver: null, line: 12, dynamic: true },
    ]);
    const screen = symbols.find((s) => s.name === "Screen")!;
    expect(screen.calls).toContainEqual({ name: "save", receiver: null, line: 10, dynamic: true });
  });

  it("collects shorthand property references", () => {
    const { symbols } = parseSource(
      "src/store.ts",
      `function fetchUser() {}
export function makeStore() {
  return { fetchUser };
}`,
    );
    const store = symbols.find((s) => s.name === "makeStore")!;
    expect(store.calls).toContainEqual({ name: "fetchUser", receiver: null, line: 3, dynamic: true });
  });

  it("attributes module-scope router registrations to the router symbol", () => {
    const { symbols, endpoints } = parseSource(
      "src/routes.ts",
      `import { Router } from "express";
import { requireAuth } from "./auth.js";
import * as controller from "./controller.js";
export const router = Router();
router.get("/forms", requireAuth, controller.listForms);
router.route("/forms/:id").delete(controller.removeForm);
router.use(audit);`,
    );
    const router = symbols.find((s) => s.name === "router")!;
    const refs = router.calls
      .filter((c) => c.dynamic)
      .map((c) => (c.receiver ? `${c.receiver}.${c.name}` : c.name));
    expect(refs).toEqual(["requireAuth", "controller.listForms", "controller.removeForm", "audit"]);
    // The registrar calls themselves stay framework surface, not callees.
    expect(router.calls.some((c) => !c.dynamic && c.receiver === "router")).toBe(false);
    // Endpoint detection is untouched by the attribution.
    expect(endpoints).toContainEqual({
      method: "GET",
      path: "/forms",
      line: 5,
      handler: "controller.listForms",
    });
  });

  it("resolves references to callable targets only, silently dropping the rest", () => {
    const app = record(
      "app.ts",
      `import { router } from "./routes.js";
const app = express();
app.use("/api", router);
app.listen(PORT);`,
      { "./routes.js": "routes.ts" },
    );
    const routes = record(
      "routes.ts",
      `import { requireAuth } from "./auth.js";
export const router = Router();
export const LIMIT = 5;
router.get("/forms", requireAuth, listForms);
function listForms() {}
export function check() { validate(LIMIT); }
function validate(n) {}`,
      { "./auth.js": "auth.ts" },
    );
    const auth = record("auth.ts", `export function requireAuth() {}`);
    const graph = buildCallGraph(recordsOf(app, routes, auth));
    // app.use("/api", router) → the imported router const, flagged dynamic.
    expect(graph.get("app.ts#app")!.resolved).toEqual([
      { file: "routes.ts", symbol: "router", dynamic: true },
    ]);
    const router = graph.get("routes.ts#router")!;
    expect(router.resolved).toContainEqual({ file: "auth.ts", symbol: "requireAuth", dynamic: true });
    expect(router.resolved).toContainEqual({ file: "routes.ts", symbol: "listForms", dynamic: true });
    // Data constants never become reference targets, and the unresolved
    // reference (PORT) stays silent.
    const check = graph.get("routes.ts#check")!;
    expect(check.resolved).toEqual([{ file: "routes.ts", symbol: "validate" }]);
    expect(graph.get("app.ts#app")!.unresolved).toEqual([]);
  });

  it("keeps a target reached both directly and by reference as a call edge", () => {
    const a = record(
      "a.ts",
      `function job() {}
export function run() {
  job();
  schedule(job);
}`,
    );
    const graph = buildCallGraph(recordsOf(a));
    expect(graph.get("a.ts#run")!.resolved).toEqual([{ file: "a.ts", symbol: "job" }]);
  });

  it("falls back to the receiver symbol for member references without a unique owner", () => {
    const handlers = record(
      "handlers.ts",
      `function createForm() {}
export const handlers = { create: createForm };`,
    );
    const routes = record(
      "routes.ts",
      `import { handlers } from "./handlers.js";
const router = Router();
router.post("/forms", handlers.create);`,
      { "./handlers.js": "handlers.ts" },
    );
    const graph = buildCallGraph(recordsOf(handlers, routes));
    // `create` is too short for instance dispatch — the reference lands on
    // the handler table itself, whose own references continue the chain.
    expect(graph.get("routes.ts#router")!.resolved).toEqual([
      { file: "handlers.ts", symbol: "handlers", dynamic: true },
    ]);
    expect(graph.get("handlers.ts#handlers")!.resolved).toEqual([
      { file: "handlers.ts", symbol: "createForm", dynamic: true },
    ]);
  });

  it("resolves default-import references to the target's default-exported symbol", () => {
    const routes = record(
      "routes.ts",
      `import { Router } from "express";
const router = Router();
router.get("/forms", (req, res) => res.json([]));
export default router;`,
    );
    const app = record(
      "app.ts",
      `import express from "express";
import formsRouter from "./routes.js";
export const app = express();
app.use("/api/forms", formsRouter);`,
      { "./routes.js": "routes.ts" },
    );
    const graph = buildCallGraph(recordsOf(app, routes));
    // The alias `formsRouter` names nothing in routes.ts — the reference must
    // land on the default-exported `router` symbol for the trace to descend.
    expect(graph.get("app.ts#app")!.resolved).toContainEqual({
      file: "routes.ts",
      symbol: "router",
      dynamic: true,
    });
  });

  it("falls back to the default export for default-imported member references", () => {
    const controller = record(
      "controller.ts",
      `function createForm() {}
const controller = { create: createForm };
export default controller;`,
    );
    const routes = record(
      "routes.ts",
      `import formController from "./controller.js";
const router = Router();
router.post("/forms", formController.create);`,
      { "./controller.js": "controller.ts" },
    );
    const graph = buildCallGraph(recordsOf(controller, routes));
    expect(graph.get("routes.ts#router")!.resolved).toEqual([
      { file: "controller.ts", symbol: "controller", dynamic: true },
    ]);
    expect(graph.get("controller.ts#controller")!.resolved).toEqual([
      { file: "controller.ts", symbol: "createForm", dynamic: true },
    ]);
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

describe("CodeMapAnalyzer trace through express handler chains", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-dyntrace-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      `import express from "express";
import { formsRouter } from "./routes";
export const app = express();
app.use("/api/forms", formsRouter);
`,
    );
    await fs.writeFile(
      path.join(root, "src", "routes.ts"),
      `import { Router } from "express";
import { requireAuth } from "./auth";
export const formsRouter = Router();
formsRouter.get("/:id", requireAuth, getForm);
function getForm(req, res) {
  res.json({});
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "auth.ts"),
      `export function requireAuth(req, res, next) {
  next();
}
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("walks mount → router → middleware and handler on dynamic edges", async () => {
    const trace = await analyzer.trace("src/app.ts", "app");
    const at = (symbol: string) => trace.steps.find((s) => s.ref.symbol === symbol);
    expect(at("formsRouter")).toMatchObject({ ref: { file: "src/routes.ts" }, depth: 1 });
    expect(at("requireAuth")).toMatchObject({ ref: { file: "src/auth.ts" }, depth: 2 });
    expect(at("getForm")).toMatchObject({ ref: { file: "src/routes.ts" }, depth: 2 });
    const mountEdge = trace.edges.find((e) => e.to.symbol === "formsRouter")!;
    expect(mountEdge.dynamic).toBe(true);
    const chainEdges = trace.edges.filter((e) => e.from.symbol === "formsRouter");
    expect(chainEdges.map((e) => `${e.to.symbol}${e.dynamic ? "*" : ""}`).sort()).toEqual([
      "getForm*",
      "requireAuth*",
    ]);
  });
});

describe("CodeMapAnalyzer trace through a default-export router", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-defaulttrace-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      `import express from "express";
import formsRouter from "./routes";
export const app = express();
app.use("/api/forms", formsRouter);
`,
    );
    await fs.writeFile(
      path.join(root, "src", "routes.ts"),
      `import { Router } from "express";
const router = Router();
router.get("/:id", getForm);
function getForm(req, res) {
  res.json({});
}
export default router;
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("walks mount → default-exported router → handler on dynamic edges", async () => {
    const trace = await analyzer.trace("src/app.ts", "app");
    const at = (symbol: string) => trace.steps.find((s) => s.ref.symbol === symbol);
    expect(at("router")).toMatchObject({ ref: { file: "src/routes.ts" }, depth: 1 });
    expect(at("getForm")).toMatchObject({ ref: { file: "src/routes.ts" }, depth: 2 });
    const mountEdge = trace.edges.find((e) => e.to.symbol === "router")!;
    expect(mountEdge.dynamic).toBe(true);
  });

  it('resolves the "default" pseudo-symbol to the router', async () => {
    const trace = await analyzer.trace("src/routes.ts", "default");
    expect(trace.entry).toEqual({ file: "src/routes.ts", symbol: "router" });
    expect(trace.steps.some((s) => s.ref.symbol === "getForm")).toBe(true);
  });

  it("marks the default-exported router symbol exported in the file detail", async () => {
    const detail = await analyzer.fileDetail("src/routes.ts");
    expect(detail.symbols.find((s) => s.name === "router")!.exported).toBe(true);
    expect(detail.exports).toEqual([{ name: "router", kind: "default", line: 7 }]);
    expect(detail.imports.some((i) => i.defaultName)).toBe(false);
    const appDetail = await analyzer.fileDetail("src/app.ts");
    expect(appDetail.imports.find((i) => i.resolved === "src/routes.ts")!.defaultName).toBe(
      "formsRouter",
    );
  });
});

describe("synthesizeDirModules", () => {
  it("derives modules from top-level dirs, descending into transparent containers", () => {
    const modules = synthesizeDirModules([
      "vite.config.ts",
      "src/App.tsx",
      "src/store.ts",
      "src/core/solver.ts",
      "src/core/expr.ts",
      "src/geometry/kernel.ts",
      "scripts/smoke.mjs",
    ]);
    expect(modules).toEqual([
      { path: "scripts", name: "scripts" },
      { path: "src", name: "src" },
      { path: "src/core", name: "core" },
      { path: "src/geometry", name: "geometry" },
    ]);
  });

  it("returns [] when the layout has fewer than two directories", () => {
    expect(synthesizeDirModules(["index.ts", "lib.ts"])).toEqual([]);
    expect(synthesizeDirModules(["src/a.ts", "src/b.ts"])).toEqual([]);
  });

  it("keeps full paths as names when basenames collide", () => {
    const modules = synthesizeDirModules(["src/utils/a.ts", "lib/utils/b.ts", "lib/utils/c.ts"]);
    expect(modules.map((m) => m.name).sort()).toEqual(["lib/utils", "src/utils"]);
  });

  it("assigns files to the deepest owning module", () => {
    const paths = ["src", "src/core", "scripts"];
    expect(dirModuleOwner("src/core/solver.ts", paths)).toBe("src/core");
    expect(dirModuleOwner("src/App.tsx", paths)).toBe("src");
    expect(dirModuleOwner("vite.config.ts", paths)).toBe(".");
  });
});

describe("single-package directory modules (analyzer)", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-dirmod-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "solo" }));
    await fs.mkdir(path.join(root, "src/core"), { recursive: true });
    await fs.mkdir(path.join(root, "src/ui"), { recursive: true });
    await fs.writeFile(path.join(root, "src/app.ts"), `import { solve } from "./core/solver.js";\nexport const app = () => solve();\n`);
    await fs.writeFile(path.join(root, "src/core/solver.ts"), `export function solve() { return 1; }\n`);
    await fs.writeFile(path.join(root, "src/ui/panel.tsx"), `import { solve } from "../core/solver.js";\nexport const Panel = () => <div>{solve()}</div>;\n`);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("splits a single-package workspace into directory modules with deps", async () => {
    const analyzer = new CodeMapAnalyzer(root);
    const summary = await analyzer.summary();
    expect(summary.modules.map((m) => m.path).sort()).toEqual([".", "src", "src/core", "src/ui"]);
    expect(summary.modules.find((m) => m.path === "src/core")).toMatchObject({ fileCount: 1 });
    expect(summary.deps).toContainEqual({ source: "src", target: "src/core", weight: 1 });
    expect(summary.deps).toContainEqual({ source: "src/ui", target: "src/core", weight: 1 });
  });
});

describe("CodeMapAnalyzer refresh lifecycle", () => {
  it("emits phase and file-count progress for a full pass", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-progress-"));
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
      await fs.writeFile(path.join(root, "b.ts"), "export const b = 2;\n");
      const progress: Omit<CodeMapProgress, "ws">[] = [];
      const analyzer = new CodeMapAnalyzer(root, (update) => progress.push(update));

      await analyzer.summary();

      expect(progress.map((update) => update.phase)).toEqual(
        expect.arrayContaining(["discovering", "parsing", "resolving", "done"]),
      );
      expect(progress.find((update) => update.phase === "parsing")).toMatchObject({
        done: 0,
        total: 2,
      });
      expect(progress.at(-1)).toEqual({ phase: "done", done: 2, total: 2 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves a completed stale summary while one shared refresh runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-stale-map-"));
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
      let waitForRefresh = false;
      let resolveRefresh!: () => void;
      const refreshed = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });
      const analyzer = new CodeMapAnalyzer(root, (update) => {
        if (waitForRefresh && update.phase === "done") resolveRefresh();
      });
      expect((await analyzer.summary()).fileTotal).toBe(1);

      await fs.writeFile(path.join(root, "b.ts"), "export const b = 2;\n");
      waitForRefresh = true;
      analyzer.invalidate();
      expect((await analyzer.summary()).fileTotal).toBe(1);

      await refreshed;
      expect((await analyzer.summary()).fileTotal).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("CodeMapAnalyzer exclusions and payload bounds", () => {
  it("excludes generated paths and content, while config include overrides exclusions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-exclusions-"));
    try {
      await fs.mkdir(path.join(root, "src", "generated"), { recursive: true });
      await fs.mkdir(path.join(root, "src", "manual"), { recursive: true });
      await fs.mkdir(path.join(root, ".crystal"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
      await fs.writeFile(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
      await fs.writeFile(path.join(root, "src", "generated", "client.ts"), "export const client = 1;\n");
      await fs.writeFile(path.join(root, "src", "model.generated.ts"), "export const model = 1;\n");
      await fs.writeFile(
        path.join(root, "src", "content.ts"),
        "// This file was automatically generated\nexport const content = 1;\n",
      );
      await fs.writeFile(path.join(root, "src", "manual", "hidden.ts"), "export const hidden = 1;\n");
      await fs.writeFile(path.join(root, "src", "manual", "allowed.ts"), "// @generated\nexport const allowed = 1;\n");
      await fs.writeFile(
        path.join(root, ".crystal", "codemap.json"),
        JSON.stringify({ exclude: ["src/manual/**"], include: ["src/manual/allowed.ts"] }),
      );

      const analyzer = new CodeMapAnalyzer(root);
      const summary = await analyzer.summary();
      expect(summary.fileTotal).toBe(2);
      expect(summary.excluded).toEqual({
        files: 4,
        roots: [
          { path: "src", files: 2 },
          { path: "src/generated", files: 1 },
          { path: "src/manual", files: 1 },
        ],
      });
      await expect(analyzer.fileDetail("src/manual/allowed.ts")).resolves.toBeTruthy();
      await expect(analyzer.fileDetail("src/generated/client.ts")).rejects.toThrow(
        "Not an analyzed code file",
      );
      expect((await analyzer.overviewSourceFiles()).map((file) => file.path).sort()).toEqual([
        "src/keep.ts",
        "src/manual/allowed.ts",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits a package module whose files are all excluded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-excluded-module-"));
    try {
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
      await fs.writeFile(path.join(root, "main.ts"), "export const main = 1;\n");
      await fs.mkdir(path.join(root, "packages", "generated"), { recursive: true });
      await fs.writeFile(
        path.join(root, "packages", "generated", "package.json"),
        JSON.stringify({ name: "generated-package" }),
      );
      await fs.writeFile(path.join(root, "packages", "generated", "index.ts"), "export const x = 1;\n");
      const summary = await new CodeMapAnalyzer(root).summary();
      expect(summary.modules.map((module) => module.path)).toEqual(["."]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("caps importedBy and reports its true total", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-importers-cap-"));
    try {
      await fs.writeFile(path.join(root, "barrel.ts"), "export const value = 1;\n");
      await Promise.all(
        Array.from({ length: 81 }, (_, index) =>
          fs.writeFile(
            path.join(root, `use-${String(index).padStart(2, "0")}.ts`),
            'import { value } from "./barrel.js";\nexport const used = value;\n',
          ),
        ),
      );
      const detail = await new CodeMapAnalyzer(root).fileDetail("barrel.ts");
      expect(detail.importedBy).toHaveLength(80);
      expect(detail.importedByTotal).toBe(81);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("memoizes the system overview until invalidation and refresh", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-overview-memo-"));
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
      const analyzer = new CodeMapAnalyzer(root);
      const first = await analyzer.systemOverview(null);
      expect(await analyzer.systemOverview(null)).toBe(first);
      const indexed = await analyzer.systemOverview({
        schemaVersion: 1,
        generatedAt: "one",
        files: [],
      } satisfies CodeIndex);
      expect(indexed).not.toBe(first);
      expect(
        await analyzer.systemOverview({ schemaVersion: 1, generatedAt: "one", files: [] }),
      ).toBe(indexed);
      expect(
        await analyzer.systemOverview({ schemaVersion: 1, generatedAt: "two", files: [] }),
      ).not.toBe(indexed);
      await fs.writeFile(path.join(root, "b.ts"), "export const b = 2;\n");
      analyzer.invalidate();
      await analyzer.fileDetail("b.ts");
      expect(await analyzer.systemOverview(null)).not.toBe(first);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("working-set changes (no VCS)", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-changes-"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    // Aged file (3 days old) importing a freshly rewritten one.
    await fs.writeFile(path.join(root, "old.ts"), `import { fresh } from "./fresh.js";\nexport const o = fresh;\n`);
    const aged = new Date(Date.now() - 72 * 3600 * 1000);
    await fs.utimes(path.join(root, "old.ts"), aged, aged);
    await fs.writeFile(path.join(root, "fresh.ts"), `export const fresh = 1;\n`);
    await fs.writeFile(path.join(root, "brand.ts"), `export const brand = 2;\n`);
    await fs.writeFile(path.join(root, "brand.test.ts"), `import { brand } from "./brand.js";\nbrand;\n`);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports touched files with wiring, skipping files outside the window", async () => {
    const analyzer = new CodeMapAnalyzer(root);
    const report = await analyzer.changes(24);
    const paths = report.files.map((f) => f.path);
    expect(paths).not.toContain("old.ts");
    expect(paths).toEqual(expect.arrayContaining(["fresh.ts", "brand.ts", "brand.test.ts"]));
    expect(report.total).toBe(3);

    // fresh.ts has a new inode but an importer untouched inside the window —
    // it predates the window, so it must not read as "added".
    const fresh = report.files.find((f) => f.path === "fresh.ts")!;
    expect(fresh.status).toBe("modified");
    expect(fresh.importedBy).toBe(1);
    expect(fresh.dependents).toEqual(["old.ts"]);

    const brand = report.files.find((f) => f.path === "brand.ts")!;
    expect(brand.status).toBe("added");
    // brand.test.ts is in the changed set, so it is not an outside dependent…
    expect(brand.dependents).toEqual([]);
    // …and being imported (by anything) keeps brand.ts out of `unwired`.
    expect(report.unwired).toEqual([]);

    const rollup = report.modules.find((m) => m.module === ".")!;
    expect(rollup).toMatchObject({ added: 2, modified: 1, testsTouched: true });
  });
});

describe("CodeMapAnalyzer surfaceMap over react-router screens", () => {
  let root: string;
  let analyzer: CodeMapAnalyzer;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-surfacemap-"));
    await fs.mkdir(path.join(root, "src", "views"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(root, "src", "router.tsx"),
      `import { createBrowserRouter } from "react-router-dom";
import Home from "./views/Home.js";
import { Settings } from "./views/Settings.js";
import Dashboard from "./views/Dashboard.js";
export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/alt", element: <Home /> },
  { path: "/settings", Component: Settings },
  { path: "/dash", element: <Dashboard /> },
]);
`,
    );
    await fs.writeFile(
      path.join(root, "src", "views", "Dashboard.tsx"),
      `import { fetchReports } from "../api/client.js";
export default function Dashboard() {
  const load = () => fetchReports();
  return <div>{String(load)}</div>;
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "api", "client.ts"),
      `export function fetchReports() {
  return fetch("/api/reports");
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "views", "Home.tsx"),
      `export default function Home() {
  const load = () => fetch("/api/items");
  const reload = () => fetch("/api/items");
  const pay = () => fetch("https://api.stripe.com/v1/charges", { method: "POST" });
  return <div>{String([load, reload, pay])}</div>;
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "views", "Settings.tsx"),
      `import { AuditLog } from "../widgets/AuditLog.js";
export const Settings = () => (
  <div>
    <AuditLog />
  </div>
);
`,
    );
    await fs.mkdir(path.join(root, "src", "widgets"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "widgets", "AuditLog.tsx"),
      `export function AuditLog() {
  const load = () => fetch("/api/audit");
  return <ul onClick={load} />;
}
`,
    );
    await fs.writeFile(
      path.join(root, "src", "api", "routes.ts"),
      `import express from "express";
const app = express();
app.get("/api/items", listItems);
app.get("/api/reports", listReports);
`,
    );
    analyzer = new CodeMapAnalyzer(root);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("joins each screen's calls to served routes and dedupes repeat call sites", async () => {
    const report = await analyzer.surfaceMap();
    const home = report.calls.filter((c) => c.screen === "react-router:/");
    expect(home).toHaveLength(2); // two /api/items sites collapse to one edge
    const items = home.find((c) => c.path === "/api/items")!;
    expect(items).toMatchObject({ method: "GET", file: "src/views/Home.tsx", line: 2 });
    expect(items.endpoint).toMatchObject({
      method: "GET",
      path: "/api/items",
      file: "src/api/routes.ts",
    });
    const external = home.find((c) => c.path === "/v1/charges")!;
    expect(external.method).toBe("POST");
    expect(external.endpoint).toBeUndefined();
    expect(report.truncated).toBe(false);
  });

  it("screens sharing an entry file report the same calls", async () => {
    const report = await analyzer.surfaceMap();
    const alt = report.calls.filter((c) => c.screen === "react-router:/alt");
    expect(alt.map((c) => `${c.method} ${c.path}`).sort()).toEqual([
      "GET /api/items",
      "POST /v1/charges",
    ]);
  });

  it("walks JSX renders — a screen reaches the fetches of components it renders", async () => {
    const report = await analyzer.surfaceMap();
    const settings = report.calls.filter((c) => c.screen === "react-router:/settings");
    expect(settings.map((c) => `${c.method} ${c.path} @${c.file}`)).toEqual([
      "GET /api/audit @src/widgets/AuditLog.tsx",
    ]);
  });

  it("walks the call graph into API-client modules the component delegates to", async () => {
    const report = await analyzer.surfaceMap();
    const dash = report.calls.filter((c) => c.screen === "react-router:/dash");
    expect(dash).toHaveLength(1);
    const call = dash[0]!;
    expect(call).toMatchObject({
      method: "GET",
      path: "/api/reports",
      file: "src/api/client.ts",
    });
    expect(call.endpoint).toMatchObject({ path: "/api/reports", file: "src/api/routes.ts" });
  });

  it("memoizes until the analyzer is invalidated", async () => {
    const first = await analyzer.surfaceMap();
    expect(await analyzer.surfaceMap()).toBe(first);
    analyzer.invalidate();
    const second = await analyzer.surfaceMap();
    expect(second).not.toBe(first);
    expect(second.calls).toEqual(first.calls);
  });
});

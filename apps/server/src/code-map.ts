import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { aggregateExternalDeps, bestServedRoute, routeSegments, routesMatchSuffix } from "@crystal/core";
import type {
  ApiTrace,
  ApiTraceCall,
  CodeFileDetail,
  CodeFileSummary,
  CodeImport,
  CodeMapSummary,
  CodeModule,
  CodeModuleDep,
  CodeModuleDetail,
  CodeSymbol,
  CodeSymbolKind,
  CodeSymbolRef,
  CodeSymbolSites,
  CodeSymbolSource,
  CodeTrace,
  CodeTraceEdge,
  CodeTraceStep,
  DuplicateCluster,
  HttpEndpoint,
  IndexSourceFile,
  JourneySuggestion,
  OverviewSourceFile,
  PartCrossing,
  PartCrossings,
  ReviewSourceFile,
  ScreenApiCall,
  SurfaceMapReport,
  SurfacesReport,
  SymbolSearchHit,
  SymbolSite,
} from "@crystal/core";
import { isIgnoredDir, resolveInRoot, toRelPath } from "./paths.js";
import { buildSurfacesReport, computeMountPrefixes, joinMountedPath } from "./surfaces-report.js";
import {
  loadTsPathsConfig,
  sortTsPathsConfigs,
  tsPathsCandidates,
  type TsPathsConfig,
} from "./ts-paths.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
const MAX_FILES = 8000;
const MAX_MODULE_FILES_SHOWN = 150;
/** Function bodies shorter than this many tokens are not fingerprinted. */
const MIN_FINGERPRINT_TOKENS = 25;
const TRACE_MAX_DEPTH = 12;
const TRACE_MAX_NODES = 300;
/** Exported components traced per screen entry file (fallback when the
 *  routed component is unknown); dropping more sets the report's `truncated`. */
const SCREEN_TRACE_SYMBOL_CAP = 3;
const MAX_DUPLICATE_CLUSTERS = 100;
const SNIPPET_MAX_LINES = 200;
const SNIPPET_MAX_BYTES = 16 * 1024;
/** Per-list cap on `symbolSites` results (import sites / call sites). */
const SITES_MAX = 60;
/** A use site's inline source line is trimmed to this many characters. */
const SITE_TEXT_MAX = 160;
/** Cap on `partCrossings` results (import statements across one part pair). */
const CROSSINGS_MAX = 80;
/** Re-export chains (barrel files) are followed at most this far. */
const REEXPORT_MAX_HOPS = 3;
const JOURNEY_MAX_CANDIDATES = 200;
const JOURNEY_BFS_DEPTH = 8;
const JOURNEY_BFS_NODES = 200;
/** At most this many suggestions per entry module, for diversity. */
const JOURNEY_PER_MODULE = 2;
const JOURNEY_DEFAULT_LIMIT = 8;
/** A trace this shallow isn't a journey worth suggesting. */
const JOURNEY_MIN_STEPS = 3;

/** A callee reference found inside a symbol's body. */
export interface SymbolCall {
  name: string;
  /** Namespace receiver for `ns.foo()` calls, when it is a plain identifier. */
  receiver: string | null;
  /** 1-based line of the call expression. */
  line?: number;
  /**
   * A JSX render (`<Foo/>`) rather than a genuine call expression. Render
   * edges let the API trace walk into a screen's component tree, but ranking
   * heuristics (journeys) and unresolved-dependency listings ignore them —
   * a presentational component is not an entry point, and a third-party
   * `<Dialog/>` is not a missing local callee.
   */
  render?: boolean;
}

/** Every top-level declaration, exported or not, with its source range. */
export interface ParsedSymbol {
  name: string;
  kind: CodeSymbolKind;
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
  /** Character offsets of the whole declaration statement. */
  start: number;
  end: number;
  exported: boolean;
  calls: SymbolCall[];
  /** Methods with ranges, for class symbols — instance-dispatch resolution. */
  methods?: { name: string; line: number; endLine: number }[];
  /** Normalized token-stream hash; null for non-functions / tiny bodies. */
  fingerprint: string | null;
  tokenCount: number;
}

interface ParsedFile {
  mtimeMs: number;
  /** FNV-1a 64 hash of the file text (the code-index enrichment freshness key). */
  hash: string;
  loc: number;
  imports: { specifier: string; names: string[]; line?: number }[];
  exports: CodeSymbol[];
  symbols: ParsedSymbol[];
  /** `export … from` statements; name is "*" for star re-exports. */
  reexports: { name: string; specifier: string }[];
  /** HTTP routes this file serves (verb calls on router objects, route files). */
  endpoints: HttpEndpoint[];
  /** Outgoing HTTP calls (`fetch`, axios-style verb calls). */
  apiCalls: HttpEndpoint[];
  /** Router mounts (`app.use("/prefix", router)`): prefix + mounted identifier. */
  mounts: { prefix: string; target: string; line?: number }[];
}

interface FileRecord extends ParsedFile {
  /** Workspace-relative path. */
  path: string;
  /** Module path that owns this file. */
  module: string;
  /** Resolved internal import targets (workspace-relative paths). */
  resolvedImports: { specifier: string; resolved: string | null; names: string[]; line?: number }[];
  /** Mounts whose router identifier resolved to an imported file. */
  resolvedMounts: { prefix: string; resolved: string }[];
}

export function isCodeFile(name: string): boolean {
  const ext = path.extname(name);
  return CODE_EXTENSIONS.has(ext) && !name.endsWith(".d.ts");
}

/** Probe a base path against the file set with the usual suffix/index endings. */
function probeFileSet(base: string, fileSet: Set<string>): string | null {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (fileSet.has(candidate)) return candidate;
    // TS "./x.js" convention for "./x.ts"
    if (suffix === "" && /\.js$/.test(candidate)) {
      const asTs = candidate.replace(/\.js$/, ".ts");
      if (fileSet.has(asTs)) return asTs;
      const asTsx = candidate.replace(/\.js$/, ".tsx");
      if (fileSet.has(asTsx)) return asTsx;
    }
  }
  return null;
}

/**
 * Resolve one import specifier against a known file set: relative paths (with
 * the usual suffix/index probing and the TS "./x.js" → "./x.ts" convention),
 * tsconfig `paths` aliases (`@/…`), and workspace-package specifiers via
 * `packageNameToModule`. Standalone so ref snapshots (files enumerated from
 * git, not disk) resolve identically.
 */
export function resolveImportSpecifier(
  fromRel: string,
  specifier: string,
  fileSet: Set<string>,
  packageNameToModule: Map<string, string>,
  tsPaths: TsPathsConfig[] = [],
): string | null {
  if (specifier.startsWith(".")) {
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromRel), specifier),
    );
    return probeFileSet(base, fileSet);
  }
  // tsconfig `paths` alias — the governing config's mapping beats package
  // resolution, mirroring TypeScript's own order.
  for (const candidate of tsPathsCandidates(fromRel, specifier, tsPaths)) {
    const hit = probeFileSet(candidate, fileSet);
    if (hit) return hit;
  }
  // Workspace package import (optionally with a subpath).
  const parts = specifier.split("/");
  const pkgName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const moduleDir = packageNameToModule.get(pkgName);
  if (moduleDir) {
    // Point at the module's entry file when we can find one.
    for (const entry of ["src/index.ts", "src/index.tsx", "index.ts", "src/main.ts"]) {
      const candidate = moduleDir === "." ? entry : `${moduleDir}/${entry}`;
      if (fileSet.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Package name of a bare specifier ("@scope/pkg/sub" → "@scope/pkg"). */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

/** What one workspace offers to / consumes from other workspaces. */
export interface CrossSurface {
  /** Package name → owning module path within this workspace. */
  packages: Map<string, string>;
  /** External (unresolved, non-relative) imports: fromModule + package + names. */
  externalImports: { fromModule: string; pkg: string; names: string[] }[];
  fileTotal: number;
}

function symbolKindFor(node: ts.Node, name: string, fileName: string): CodeSymbolKind {
  if (ts.isFunctionDeclaration(node)) {
    return /^[A-Z]/.test(name) && /\.[jt]sx$/.test(fileName) ? "component" : "function";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  return "const";
}

/** FNV-1a 64-bit over a string, as fixed-width hex. */
function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Fingerprint of a body's token stream: whitespace- and comment-insensitive,
 * identifiers and literals verbatim. Catches copy-paste clones without the
 * false positives alpha-renaming would introduce.
 */
function fingerprintBody(bodyText: string): { fingerprint: string | null; tokenCount: number } {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, /*skipTrivia*/ true, undefined, bodyText);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  if (tokens.length < MIN_FINGERPRINT_TOKENS) return { fingerprint: null, tokenCount: tokens.length };
  return { fingerprint: fnv1a64(tokens.join(" ")), tokenCount: tokens.length };
}

/** Strip wrappers that don't change what's being called: `x!`, `(x)`, `x as T`. */
function unwrapReceiver(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isNonNullExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * Callee identifiers inside a node: `foo()` and `ns.foo()` (identifier
 * receiver only). JSX component elements count as calls — `<BookingForm/>`
 * is how a screen invokes a component, and the API trace has to walk that
 * edge to reach the fetches the rendered tree makes. Lowercase (intrinsic)
 * tags are skipped.
 */
function collectCalls(root: ts.Node, out: SymbolCall[], lineOf?: (node: ts.Node) => number): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        out.push({ name: callee.text, receiver: null, line: lineOf?.(node) });
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const recv = unwrapReceiver(callee.expression);
        if (ts.isIdentifier(recv)) {
          out.push({ name: callee.name.text, receiver: recv.text, line: lineOf?.(node) });
        }
      }
    } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName;
      if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text)) {
        out.push({ name: tag.text, receiver: null, line: lineOf?.(node), render: true });
      } else if (
        ts.isPropertyAccessExpression(tag) &&
        ts.isIdentifier(tag.name) &&
        ts.isIdentifier(tag.expression)
      ) {
        // `<Tabs.Item/>` renders the compound component `Tabs` — resolving
        // the member name through instance dispatch would bind the render to
        // whatever class happens to declare a same-named method.
        out.push({ name: tag.expression.text, receiver: null, line: lineOf?.(node), render: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/* ------------------------------------------------------------------ */
/* HTTP surface detection                                              */
/* ------------------------------------------------------------------ */

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);
/** Packages whose presence marks a file as server-side route code. */
const SERVER_FRAMEWORK_PKGS = new Set([
  "express", "fastify", "koa", "@koa/router", "hono", "restify", "@hapi/hapi",
  "polka", "itty-router",
]);
/** Packages whose presence marks a file as HTTP-client code. */
const HTTP_CLIENT_PKGS = new Set([
  "axios", "ky", "got", "superagent", "node-fetch", "undici", "wretch",
  "redaxios", "cross-fetch",
]);
/** Receiver identifiers that read as a route registrar (`app.get("/x", h)`). */
const SERVER_RECEIVERS = new Set(["app", "router", "server", "fastify", "routes", "api"]);
/** Receiver identifiers that read as an HTTP client (`api.get("/x")`). */
const CLIENT_RECEIVERS = new Set(["axios", "ky", "got", "superagent", "http", "client", "api", "fetcher"]);
/** Receivers that are HTTP clients no matter what the file imports. */
const ALWAYS_CLIENT_RECEIVERS = new Set(["axios", "ky", "got", "superagent"]);
const SIGNATURE_MAX = 160;

/**
 * URL/route argument → normalized path (template holes become "*"), or null
 * when not one. `consts` maps same-file string constants — the widespread
 * `ApiService.get(\`${ADMIN_FORM_ENDPOINT}/${id}\`)` convention resolves
 * through it; unresolved holes stay wildcards. A wildcard *prefix* is dropped
 * rather than fatal (`${BASE_URL}/admin/forms` still yields /admin/forms —
 * suffix route matching absorbs the missing mount).
 */
function httpPathOf(
  arg: ts.Expression | undefined,
  consts?: ReadonlyMap<string, string>,
): string | null {
  const text = urlTextOf(arg, consts);
  return text ? normalizeHttpPath(text) : null;
}

/**
 * URL-ish expression → text with unresolved holes as "*", or null when the
 * expression carries no literal at all. Handles literals, templates,
 * same-file const identifiers and `+` concatenation.
 */
function urlTextOf(
  arg: ts.Expression | undefined,
  consts?: ReadonlyMap<string, string>,
): string | null {
  if (!arg) return null;
  const resolve = (expr: ts.Expression): string | null =>
    ts.isIdentifier(expr) ? (consts?.get(expr.text) ?? null) : null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    return (
      arg.head.text +
      arg.templateSpans.map((s) => `${resolve(s.expression) ?? "*"}${s.literal.text}`).join("")
    );
  }
  if (ts.isIdentifier(arg)) return resolve(arg);
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = urlTextOf(arg.left, consts);
    const right = urlTextOf(arg.right, consts);
    if (left == null && right == null) return null;
    return `${left ?? "*"}${right ?? "*"}`;
  }
  return null;
}

/** Normalize resolved URL text into a route path (see httpPathOf). */
function normalizeHttpPath(rawText: string): string | null {
  let text = rawText;
  if (/^https?:\/\//i.test(text)) {
    const m = /^https?:\/\/[^/]*(\/[^?#]*)?/i.exec(text);
    text = m?.[1] ?? "/";
  }
  if (text.startsWith("*/")) text = text.slice(1);
  if (!text.startsWith("/")) return null;
  let cleaned = text.split(/[?#]/, 1)[0] ?? text;
  // A hole glued to a segment ("…/deployments${query}") is almost always an
  // optional query-string suffix — drop it. A hole that IS a segment
  // ("…/deployments/${id}") stays a wildcard path param.
  if (cleaned.length > 2 && cleaned.endsWith("*") && !cleaned.endsWith("/*")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned;
}

const HTTP_METHOD_ARGS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** `fetch(url, { method: "POST" })` → "POST"; defaults to GET. */
function fetchMethodOf(init: ts.Expression | undefined): string {
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const prop of init.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "method" &&
        (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
      ) {
        return prop.initializer.text.toUpperCase();
      }
    }
  }
  return "GET";
}

/**
 * File-convention routes: Next-style `app/…/route.ts` (exports named after
 * verbs) and `pages/api/…` (one catch-all handler). Grouping/slot segments
 * drop out; `[param]` segments become `:param`, catch-alls become `*`.
 */
function fileConventionRoutes(fileRel: string, exportNames: readonly string[]): HttpEndpoint[] {
  const routeSeg = (seg: string): string | null => {
    if (/^\(.*\)$/.test(seg) || seg.startsWith("@")) return null;
    if (/^\[\[?\.\.\..*$/.test(seg)) return "*";
    const param = /^\[(.+)\]$/.exec(seg);
    return param ? `:${param[1]}` : seg;
  };
  const appRoute = /(?:^|\/)app\/(.+)\/route\.[cm]?[jt]sx?$/.exec(fileRel);
  if (appRoute) {
    const path = `/${appRoute[1]!.split("/").map(routeSeg).filter((s): s is string => s != null).join("/")}`;
    return exportNames
      .filter((n) => HTTP_VERBS.has(n.toLowerCase()) && n === n.toUpperCase())
      .map((n) => ({ method: n, path }));
  }
  const pagesApi = /(?:^|\/)pages\/(api\/.+?)\.[cm]?[jt]sx?$/.exec(fileRel);
  if (pagesApi) {
    const segs = pagesApi[1]!.split("/").map(routeSeg).filter((s): s is string => s != null);
    if (segs.at(-1) === "index") segs.pop();
    return [{ method: "ALL", path: `/${segs.join("/")}` }];
  }
  return [];
}

/** Parse one source file: imports (static + dynamic + re-exports) and exported symbols. */
export function parseSource(fileRel: string, text: string): Omit<ParsedFile, "mtimeMs" | "hash"> {
  const scriptKind = fileRel.endsWith(".tsx") || fileRel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileRel, text, ts.ScriptTarget.ES2022, false, scriptKind);
  const imports: ParsedFile["imports"] = [];
  const exports: CodeSymbol[] = [];
  const symbols: ParsedSymbol[] = [];
  const reexports: ParsedFile["reexports"] = [];
  const endpoints: HttpEndpoint[] = [];
  const apiCalls: HttpEndpoint[] = [];
  const mounts: ParsedFile["mounts"] = [];

  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const endLineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  /** "(a: string, b?: number): Promise<Foo>" for function-like declarations. */
  const signatureOf = (node: ts.Node | null | undefined): string | undefined => {
    if (!node || !ts.isFunctionLike(node)) return undefined;
    const collapse = (t: string): string => t.replace(/\s+/g, " ").trim();
    const params = node.parameters.map((p) => collapse(p.getText(source))).join(", ");
    const ret = node.type ? `: ${collapse(node.type.getText(source))}` : "";
    const sig = `(${params})${ret}`;
    return sig.length > SIGNATURE_MAX ? `${sig.slice(0, SIGNATURE_MAX - 1)}…` : sig;
  };

  /** Record a top-level declaration; `body` (when function-like) feeds calls + fingerprint. */
  const recordSymbol = (
    statement: ts.Statement,
    name: string,
    kind: CodeSymbolKind,
    exported: boolean,
    body: ts.Node | null,
    methods?: { name: string; line: number; endLine: number }[],
  ): void => {
    const calls: SymbolCall[] = [];
    let fingerprint: string | null = null;
    let tokenCount = 0;
    if (body) {
      collectCalls(body, calls, lineOf);
      if (kind === "function" || kind === "component" || kind === "const") {
        ({ fingerprint, tokenCount } = fingerprintBody(text.slice(body.getStart(source), body.getEnd())));
      }
    }
    symbols.push({
      name,
      kind,
      line: lineOf(statement),
      endLine: endLineOf(statement),
      start: statement.getStart(source),
      end: statement.getEnd(),
      exported,
      calls,
      ...(methods && methods.length > 0 ? { methods } : {}),
      fingerprint,
      tokenCount,
    });
  };

  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const isDefault = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

  for (const statement of source.statements) {
    // --- imports ---
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const names: string[] = [];
      const clause = statement.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) names.push(`* as ${clause.namedBindings.name.text}`);
        else for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      imports.push({ specifier: statement.moduleSpecifier.text, names, line: lineOf(statement) });
      continue;
    }
    // --- re-exports: export { x } from "./y"; export * from "./z" ---
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const names: string[] = [];
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const el of statement.exportClause.elements) {
            names.push(el.name.text);
            exports.push({ name: el.name.text, kind: "reexport", line: lineOf(el) });
            reexports.push({ name: el.name.text, specifier: statement.moduleSpecifier.text });
          }
        } else {
          names.push("*");
          exports.push({ name: `* from ${statement.moduleSpecifier.text}`, kind: "reexport", line: lineOf(statement) });
          reexports.push({ name: "*", specifier: statement.moduleSpecifier.text });
        }
        imports.push({ specifier: statement.moduleSpecifier.text, names, line: lineOf(statement) });
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          exports.push({ name: el.name.text, kind: "const", line: lineOf(el) });
        }
      }
      continue;
    }
    // --- export default ---
    if (ts.isExportAssignment(statement)) {
      exports.push({ name: "default", kind: "default", line: lineOf(statement) });
      continue;
    }
    // --- top-level declarations (exported or not) → symbols with ranges ---
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        const init = decl.initializer ?? null;
        const fnLike = init != null && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const isComponent =
          /^[A-Z]/.test(name) &&
          init != null &&
          (fnLike || ts.isCallExpression(init)) &&
          /\.[jt]sx$/.test(fileRel);
        recordSymbol(
          statement,
          name,
          isComponent ? "component" : "const",
          hasExportModifier(statement),
          fnLike ? init : null,
        );
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      recordSymbol(statement, name, symbolKindFor(statement, name, fileRel), hasExportModifier(statement), statement.body ?? null);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      // Calls inside methods are attributed to the class symbol; method names
      // (with ranges) let the call graph resolve `instance.method()` dispatch
      // back here and let apiTrace narrow collection to the method invoked.
      const methods = statement.members.flatMap((m) =>
        ts.isMethodDeclaration(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
          ? [{ name: m.name.text, line: lineOf(m), endLine: endLineOf(m) }]
          : [],
      );
      recordSymbol(statement, statement.name.text, "class", hasExportModifier(statement), statement, methods);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      const name = statement.name.text;
      recordSymbol(statement, name, symbolKindFor(statement, name, fileRel), hasExportModifier(statement), null);
    }

    // --- exported declarations ---
    if (hasExportModifier(statement)) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const isComponent =
              /^[A-Z]/.test(name) &&
              decl.initializer != null &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer) ||
                ts.isCallExpression(decl.initializer)) &&
              /\.[jt]sx$/.test(fileRel);
            exports.push({
              name,
              kind: isComponent ? "component" : "const",
              line: lineOf(decl),
              signature: signatureOf(decl.initializer),
            });
          }
        }
      } else if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      ) {
        const name = statement.name?.text ?? "default";
        exports.push({
          name,
          kind: isDefault(statement) ? "default" : symbolKindFor(statement, name, fileRel),
          line: lineOf(statement),
          signature: signatureOf(statement),
        });
      }
    }
  }

  // Which side of the wire does this file sit on? Framework imports beat
  // receiver-name guesses when a name like `api` could be either.
  const importsServer = imports.some((i) => {
    const pkg = packageNameOf(i.specifier);
    return pkg != null && SERVER_FRAMEWORK_PKGS.has(pkg);
  });
  const importsClient = imports.some((i) => {
    const pkg = packageNameOf(i.specifier);
    return pkg != null && HTTP_CLIENT_PKGS.has(pkg);
  });

  // Same-file string constants (`const ADMIN_FORM_ENDPOINT = '/admin/forms'`)
  // — the resolver behind httpPathOf's template substitution.
  const stringConsts = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        (ts.isStringLiteral(decl.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(decl.initializer))
      )
        stringConsts.set(decl.name.text, decl.initializer.text);
    }
  }

  // Dynamic import("...") and HTTP surface calls anywhere in the file.
  // `sawFetchish` gates the wrapper-propagation pass below — most files have
  // no fetch at all and skip its extra AST walks entirely.
  let sawFetchish = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        imports.push({ specifier: node.arguments[0].text, names: ["(dynamic)"], line: lineOf(node) });
      } else if (ts.isIdentifier(callee) && callee.text === "fetch") {
        sawFetchish = true;
        const p = httpPathOf(node.arguments[0], stringConsts);
        if (p)
          apiCalls.push({ method: fetchMethodOf(node.arguments[1]), path: p, line: lineOf(node) });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        ts.isIdentifier(callee.expression) &&
        callee.name.text === "use" &&
        node.arguments.length >= 2
      ) {
        // `app.use("/prefix", …middleware, router)` — the mount that gives a
        // route file's paths their real URL prefix. The mounted router is the
        // last plain-identifier argument (middleware sits in between).
        const recv = callee.expression.text.toLowerCase();
        const serverishRecv =
          SERVER_RECEIVERS.has(recv) || recv.endsWith("router") || recv.endsWith("routes");
        // Concatenated prefixes (`app.use(BASE + "/x", …)`) are loop/config
        // driven — registering a truncated guess poisons route matching.
        const prefix = ts.isBinaryExpression(node.arguments[0]!)
          ? null
          : httpPathOf(node.arguments[0], stringConsts);
        if (serverishRecv && prefix) {
          const target = [...node.arguments].reverse().find(ts.isIdentifier);
          if (target) mounts.push({ prefix, target: target.text, line: lineOf(node) });
        }
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        /^request/i.test(callee.name.text) &&
        node.arguments.length >= 2
      ) {
        // API-client helper convention: `this.request("GET", "/path", …)` /
        // `client.requestText(method, path)` — the verb is a literal first
        // argument, the URL the second.
        const verbArg = node.arguments[0]!;
        const verb =
          ts.isStringLiteral(verbArg) || ts.isNoSubstitutionTemplateLiteral(verbArg)
            ? verbArg.text.toUpperCase()
            : null;
        if (verb && HTTP_METHOD_ARGS.has(verb)) {
          const p = httpPathOf(node.arguments[1], stringConsts);
          if (p) apiCalls.push({ method: verb, path: p, line: lineOf(node) });
        }
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        ts.isIdentifier(callee.expression) &&
        HTTP_VERBS.has(callee.name.text)
      ) {
        const verb = callee.name.text;
        const recv = callee.expression.text;
        if (ALWAYS_CLIENT_RECEIVERS.has(recv.toLowerCase())) sawFetchish = true;
        const p = httpPathOf(node.arguments[0], stringConsts);
        if (p) {
          const method = verb === "all" ? "ALL" : verb.toUpperCase();
          const lower = recv.toLowerCase();
          // Word-split the receiver ("ApiService" → api, service) so instance
          // names read correctly without matching substrings like "rapid".
          const words = recv
            .split(/(?=[A-Z])|[_\-$]/)
            .map((w) => w.toLowerCase())
            .filter(Boolean);
          // Registrar names: the known set, plus the near-universal convention
          // of suffixing nested express routers ("AdminFormsRouter").
          const serverish =
            (SERVER_RECEIVERS.has(lower) || lower.endsWith("router") || lower.endsWith("routes")) &&
            (importsServer || (!importsClient && lower !== "api"));
          // `api.get("/x", (req, res) => …)` reads as a registration even on a
          // client-looking name — an inline function argument marks it.
          const arg1 = node.arguments[1];
          const handlerish =
            arg1 != null && (ts.isArrowFunction(arg1) || ts.isFunctionExpression(arg1));
          const clientish =
            ALWAYS_CLIENT_RECEIVERS.has(lower) ||
            (importsClient && CLIENT_RECEIVERS.has(lower)) ||
            (!serverish &&
              !handlerish &&
              (words.includes("api") || lower.endsWith("client") || lower.endsWith("http")));
          if (clientish && verb !== "all") {
            apiCalls.push({ method, path: p, line: lineOf(node) });
          } else if (
            serverish &&
            node.arguments.length >= 2 &&
            // Served routes must be literal-derived: a concatenated path
            // (`app.get("/admin" + sub.path, h)` in a loop) would register a
            // bogus truncated route that suffix-matching then hits.
            !ts.isBinaryExpression(node.arguments[0]!)
          ) {
            // A route registration takes a handler; `map.get("/x")` does not.
            // The (last) handler reference is the natural trace root.
            const last = node.arguments[node.arguments.length - 1]!;
            const handlerName = ts.isIdentifier(last)
              ? last.text
              : ts.isPropertyAccessExpression(last) &&
                  ts.isIdentifier(last.expression) &&
                  ts.isIdentifier(last.name)
                ? `${last.expression.text}.${last.name.text}`
                : undefined;
            endpoints.push({
              method,
              path: p,
              line: lineOf(node),
              ...(handlerName ? { handler: handlerName } : {}),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  // --- same-file API-wrapper propagation ---
  // The dominant client convention hides `fetch` behind a tiny helper —
  // `get(path)` / `this.request(path, init)` — so the fetch site only sees a
  // parameter hole while the real routes sit at the helper's call sites.
  // Detect function-like declarations whose HTTP path flows from a parameter,
  // emit one call per call site (helper's static prefix + the site's literal),
  // and drop the helper's own degenerate call (a bare prefix at best).
  interface ApiWrapper {
    /** Const-resolved static text before the path parameter's hole. */
    prefix: string;
    /** Which argument carries the path. */
    pathIndex: number;
    /** Method fixed by the helper body; null = read it off the call site. */
    fixedMethod: string | null;
    /** Line of the helper's own fetch — its degenerate apiCall is removed. */
    fetchLine: number;
    /** Free function (`get("/x")`) or class method (`this.request("/x")`). */
    kind: "fn" | "method";
  }

  /**
   * Split a URL expression into resolved text and the position of the path
   * parameter. Unknown holes before the parameter drop out (same philosophy
   * as httpPathOf's wildcard prefix — suffix route matching absorbs a base
   * URL we can't see). The parameter must be the FINAL piece: a URL with
   * anything after the hole (`/users/${id}/profile`, `${ver}${path}` at the
   * ver hole) is parameterized by an id or a base, not by a route path — for
   * those the classic wildcard call the main visitor emitted stays right.
   */
  const wrapperUrlOf = (
    expr: ts.Expression,
    params: ReadonlyMap<string, number>,
  ): { prefix: string; pathIndex: number } | null => {
    let prefix = "";
    let pathIndex: number | null = null;
    let trailing = false; // anything at all after the param hole
    const flatten = (e: ts.Expression): void => {
      if (trailing) return;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        if (pathIndex != null) trailing = e.text.length > 0;
        else prefix += e.text;
      } else if (ts.isTemplateExpression(e)) {
        if (pathIndex != null) {
          trailing = true;
          return;
        }
        prefix += e.head.text;
        for (const s of e.templateSpans) {
          flatten(s.expression);
          if (trailing) return;
          if (pathIndex != null) {
            if (s.literal.text.length > 0) trailing = true;
          } else prefix += s.literal.text;
        }
      } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(e.left);
        flatten(e.right);
      } else if (ts.isIdentifier(e)) {
        const param = params.get(e.text);
        if (pathIndex != null) trailing = true;
        else if (param != null) pathIndex = param;
        else prefix += stringConsts.get(e.text) ?? "";
      } else if (pathIndex != null) {
        trailing = true;
      }
      // Pre-hole non-identifiers (config lookups, calls) are an unseen base URL.
    };
    flatten(expr);
    return pathIndex == null || trailing ? null : { prefix, pathIndex };
  };

  /** Helper-body init → fixed method, or null when the call site decides. */
  const fixedMethodOf = (init: ts.Expression | undefined): string | null => {
    if (!init) return "GET";
    if (!ts.isObjectLiteralExpression(init)) return null; // init flows from a param
    let sawSpread = false;
    for (const prop of init.properties) {
      if (ts.isSpreadAssignment(prop)) sawSpread = true;
      else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "method") {
        return null; // `{ method }` — the method is a helper parameter
      } else if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "method"
      ) {
        return ts.isStringLiteral(prop.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(prop.initializer)
          ? prop.initializer.text.toUpperCase()
          : null;
      }
    }
    return sawSpread ? null : "GET";
  };

  const wrappers = new Map<string, ApiWrapper>();
  const detectWrapper = (
    name: string,
    fn: ts.SignatureDeclaration & { body?: ts.Node },
    kind: ApiWrapper["kind"],
  ): void => {
    if (wrappers.has(name) || !fn.body) return;
    const params = new Map<string, number>();
    fn.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) params.set(p.name.text, i);
    });
    if (params.size === 0) return;
    let found: ApiWrapper | null = null;
    const scan = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isFetch = ts.isIdentifier(callee) && callee.text === "fetch";
        const clientVerb =
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.name) &&
          ts.isIdentifier(callee.expression) &&
          HTTP_VERBS.has(callee.name.text) &&
          ALWAYS_CLIENT_RECEIVERS.has(callee.expression.text.toLowerCase());
        if ((isFetch || clientVerb) && node.arguments[0]) {
          const url = wrapperUrlOf(node.arguments[0], params);
          if (url) {
            found = {
              ...url,
              fixedMethod: isFetch
                ? fixedMethodOf(node.arguments[1])
                : (callee as ts.PropertyAccessExpression & { name: ts.Identifier }).name.text.toUpperCase(),
              fetchLine: lineOf(node),
              kind,
            };
            return;
          }
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(fn.body);
    if (found) wrappers.set(name, found);
  };

  for (const statement of sawFetchish ? source.statements : []) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      detectWrapper(statement.name.text, statement, "fn");
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        )
          detectWrapper(decl.name.text, decl.initializer, "fn");
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name))
          detectWrapper(member.name.text, member, "method");
      }
    }
  }

  if (wrappers.size > 0) {
    const seen = new Set(apiCalls.map((c) => `${c.method} ${c.path} @${c.line ?? "?"}`));
    const emitted: HttpEndpoint[] = [];
    const emittedBy = new Set<string>();
    /** A string-literal HTTP verb among the args (`request("POST", …)` style). */
    const verbArgOf = (args: readonly ts.Expression[], skip: number): string | null => {
      for (let i = 0; i < args.length; i++) {
        if (i === skip) continue;
        const a = args[i]!;
        if (
          (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) &&
          HTTP_METHOD_ARGS.has(a.text.toUpperCase())
        )
          return a.text.toUpperCase();
      }
      return null;
    };
    const visitCallSites = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        // Free-function wrappers match bare calls; method wrappers match
        // `this.x(...)` only. Instance receivers (`httpClient.get(...)`) are
        // NOT matched — an imported client object's method is not this file's
        // helper, and the clientish-receiver convention already covers it.
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.name) &&
              callee.expression.kind === ts.SyntaxKind.ThisKeyword
            ? callee.name.text
            : null;
        const wrapper = name ? wrappers.get(name) : undefined;
        const expectedKind = ts.isIdentifier(callee) ? "fn" : "method";
        // Registration-shaped calls (`get("/x", handler)`) are route setups
        // or callback APIs, not path requests.
        const last = node.arguments[node.arguments.length - 1];
        const handlerish = last != null && (ts.isArrowFunction(last) || ts.isFunctionExpression(last));
        if (wrapper && wrapper.kind === expectedKind && !handlerish) {
          const raw = urlTextOf(node.arguments[wrapper.pathIndex], stringConsts);
          const path = raw != null ? normalizeHttpPath(wrapper.prefix + raw) : null;
          if (path) {
            const method =
              wrapper.fixedMethod ??
              verbArgOf(node.arguments, wrapper.pathIndex) ??
              fetchMethodOf(node.arguments[wrapper.pathIndex + 1]);
            const key = `${method} ${path} @${lineOf(node)}`;
            if (!seen.has(key)) {
              seen.add(key);
              emitted.push({ method, path, line: lineOf(node) });
              emittedBy.add(name!);
            }
          }
        }
      }
      ts.forEachChild(node, visitCallSites);
    };
    ts.forEachChild(source, visitCallSites);

    // Drop a helper's own degenerate call (a bare prefix) only when its call
    // sites produced something better — a helper invoked purely with computed
    // arguments keeps its wildcard call so the route stays visible at all.
    const degenerate = new Set(
      [...wrappers.entries()].filter(([n]) => emittedBy.has(n)).map(([, w]) => w.fetchLine),
    );
    if (degenerate.size > 0) {
      const kept = apiCalls.filter((c) => !degenerate.has(c.line ?? -1));
      apiCalls.length = 0;
      apiCalls.push(...kept);
    }
    apiCalls.push(...emitted);
  }

  // Routes declared by file convention rather than registrar calls.
  endpoints.push(...fileConventionRoutes(fileRel, exports.map((e) => e.name)));

  return { loc: source.getLineStarts().length, imports, exports, symbols, reexports, endpoints, apiCalls, mounts };
}

/* ------------------------------------------------------------------ */
/* Call graph                                                          */
/* ------------------------------------------------------------------ */

/** The record shape `buildCallGraph` needs (satisfied by `FileRecord`). */
export interface CallGraphRecord {
  path: string;
  symbols: ParsedSymbol[];
  resolvedImports: { specifier: string; resolved: string | null; names: string[] }[];
}

export interface CallGraphNode {
  ref: CodeSymbolRef;
  resolved: CodeSymbolRef[];
  unresolved: string[];
}

export type CallGraph = Map<string, CallGraphNode>;

export function callKey(ref: CodeSymbolRef): string {
  return `${ref.file}#${ref.symbol}`;
}

/** Ambient callees that would only add noise to `unresolved`. */
const GLOBAL_RECEIVERS = new Set([
  "console", "JSON", "Math", "Object", "Array", "Promise", "Number", "String",
  "Date", "Reflect", "Symbol", "performance", "window", "document", "navigator",
  "process", "crypto", "localStorage", "sessionStorage",
]);
const GLOBAL_CALLEES = new Set([
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch",
  "structuredClone", "parseInt", "parseFloat", "isNaN", "isFinite",
  "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "String", "Number", "Boolean", "Array", "Object", "Symbol", "BigInt",
  "Error", "TypeError", "RangeError", "Promise", "RegExp", "Date",
  "Map", "Set", "WeakMap", "WeakSet", "encodeURIComponent", "decodeURIComponent",
]);

/**
 * Method names too generic (or too framework-ambient) to attribute to one
 * class by name alone — instance dispatch through these stays unresolved.
 */
const AMBIENT_METHOD_NAMES = new Set([
  "constructor", "toString", "toJSON", "valueOf", "render", "dispose",
  "init", "start", "stop", "open", "close", "connect", "disconnect",
  "next", "then", "catch", "finally", "push", "emit", "send", "write",
]);

/**
 * Syntax-only call graph over top-level symbols. Callees resolve through
 * same-file declarations, named imports, `* as ns` namespaces, barrel
 * re-export chains (≤ REEXPORT_MAX_HOPS), and — for `instance.method()`
 * dispatch — the unique class declaring that method name (API-client methods
 * like `listDeployments` are distinctive; ambiguous or generic names stay
 * unresolved rather than guessing).
 */
export function buildCallGraph(records: Map<string, CallGraphRecord>): CallGraph {
  /** Symbol named `name` declared in (or re-exported through) `file`. */
  const resolveInFile = (file: string, name: string, hops: number): CodeSymbolRef | null => {
    const rec = records.get(file);
    if (!rec) return null;
    if (rec.symbols.some((s) => s.name === name)) return { file, symbol: name };
    if (hops >= REEXPORT_MAX_HOPS) return null;
    for (const imp of rec.resolvedImports) {
      if (!imp.resolved) continue;
      if (imp.names.includes(name) || imp.names.includes("*")) {
        const hit = resolveInFile(imp.resolved, name, hops + 1);
        if (hit) return hit;
      }
    }
    return null;
  };

  // Method name → the one class declaring it (null when several classes do).
  const methodOwners = new Map<string, CodeSymbolRef | null>();
  for (const rec of records.values()) {
    if (isTestFile(rec.path)) continue;
    for (const sym of rec.symbols) {
      for (const method of sym.methods ?? []) {
        if (method.name.length < 4 || AMBIENT_METHOD_NAMES.has(method.name)) continue;
        methodOwners.set(
          method.name,
          methodOwners.has(method.name) ? null : { file: rec.path, symbol: sym.name },
        );
      }
    }
  }

  const graph: CallGraph = new Map();
  for (const rec of records.values()) {
    const localNames = new Set(rec.symbols.map((s) => s.name));
    const namedImports = new Map<string, string>();
    const namespaceImports = new Map<string, string>();
    for (const imp of rec.resolvedImports) {
      if (!imp.resolved) continue;
      for (const name of imp.names) {
        const ns = /^\* as (.+)$/.exec(name);
        if (ns) namespaceImports.set(ns[1]!, imp.resolved);
        else if (name !== "*" && name !== "(dynamic)") namedImports.set(name, imp.resolved);
      }
    }

    for (const symbol of rec.symbols) {
      const ref: CodeSymbolRef = { file: rec.path, symbol: symbol.name };
      const resolved: CodeSymbolRef[] = [];
      const unresolved: string[] = [];
      const seenResolved = new Set<string>();
      const seenUnresolved = new Set<string>();
      for (const call of symbol.calls) {
        let hit: CodeSymbolRef | null = null;
        if (call.receiver) {
          const nsFile = namespaceImports.get(call.receiver);
          if (nsFile) hit = resolveInFile(nsFile, call.name, 0);
          // Instance dispatch: the unique class declaring this method.
          if (!hit) {
            const owner = methodOwners.get(call.name);
            if (owner && callKey(owner) !== callKey(ref)) hit = owner;
          }
        } else if (localNames.has(call.name)) {
          if (call.name !== symbol.name) hit = { file: rec.path, symbol: call.name };
        } else {
          const importFile = namedImports.get(call.name);
          if (importFile) hit = resolveInFile(importFile, call.name, 0);
        }
        if (hit) {
          const key = callKey(hit);
          if (!seenResolved.has(key)) {
            seenResolved.add(key);
            resolved.push(hit);
          }
        } else {
          // Unresolved renders are third-party components (<Dialog/> from a
          // UI library), not missing local callees — pure noise in the list.
          if (call.render) continue;
          const ambient = call.receiver
            ? GLOBAL_RECEIVERS.has(call.receiver)
            : GLOBAL_CALLEES.has(call.name);
          if (ambient) continue;
          const label = call.receiver ? `${call.receiver}.${call.name}` : call.name;
          if (!seenUnresolved.has(label)) {
            seenUnresolved.add(label);
            unresolved.push(label);
          }
        }
      }
      graph.set(callKey(ref), { ref, resolved, unresolved });
    }
  }
  return graph;
}

/* ------------------------------------------------------------------ */
/* Journey suggestions                                                  */
/* ------------------------------------------------------------------ */

/** What journey ranking needs per file (satisfied by `FileRecord`). */
export interface JourneySourceRecord extends CallGraphRecord {
  module: string;
}

const MODULE_ENTRY_RELATIVES = new Set([
  "src/index.ts",
  "src/index.tsx",
  "src/main.ts",
  "src/main.tsx",
  "index.ts",
  "main.ts",
]);

export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(path) || path.includes("__tests__/");
}

function isModuleEntryFile(rec: JourneySourceRecord): boolean {
  const rel = rec.module === "." ? rec.path : rec.path.slice(rec.module.length + 1);
  return MODULE_ENTRY_RELATIVES.has(rel);
}

/**
 * Files that are execution entry points by convention rather than by import:
 * tool configs (vite.config.ts), bin/ and scripts/ contents, app mains,
 * infra entrypoints, and node's server.js convention. Nothing imports these —
 * flagging them dead is noise, not signal.
 */
const CONVENTION_ENTRY_RES: readonly RegExp[] = [
  /(^|\/)[^/]+\.config\.[cm]?[jt]sx?$/, // vite.config.ts, tailwind.config.js…
  /(^|\/)(bin|scripts)\/[^/]+\.[cm]?[jt]sx?$/, // CLIs and tooling scripts
  /(^|\/)src\/main\.[cm]?[jt]sx?$/, // app mains, wherever they nest
  /(^|\/)entry(point)?\.[cm]?[jt]sx?$/, // pulumi/webpack-style entrypoints
  /(^|\/)(server|index|main)\.[cm]?js$/, // node conventions in JS packages
];

function isConventionEntryFile(rel: string): boolean {
  return CONVENTION_ENTRY_RES.some((re) => re.test(rel));
}

/**
 * Entry paths a package.json declares: main/module/types/bin/exports targets
 * and path-looking tokens inside scripts ("node scripts/build.mjs"). Built
 * outputs (dist/…) also map back to their likely src/ sources so the
 * *sources* of published entries count as reachable.
 */
export function declaredEntryPaths(pkgDir: string, json: unknown): string[] {
  const out = new Set<string>();
  const prefix = pkgDir === "." || pkgDir === "" ? "" : `${pkgDir}/`;
  const addSourceVariants = (rel: string): void => {
    const bases = [rel, rel.replace(/^(dist|build|lib|out|output)\//, ""), ...(
      /^(dist|build|lib|out|output)\//.test(rel)
        ? [rel.replace(/^(dist|build|lib|out|output)\//, "src/")]
        : []
    )];
    const extSwaps = (p: string): string[] => [
      p,
      p.replace(/\.d\.ts$/, ".ts"),
      p.replace(/\.m?js$/, ".ts"),
      p.replace(/\.m?js$/, ".tsx"),
      p.replace(/\.cjs$/, ".cts"),
      p.replace(/\.mjs$/, ".mts"),
    ];
    for (const base of bases) {
      for (const variant of extSwaps(base)) {
        out.add(path.posix.normalize(prefix + variant));
      }
    }
  };
  const addTarget = (value: unknown): void => {
    if (typeof value !== "string" || !value) return;
    const clean = value.replace(/^\.\//, "").split("?")[0]!;
    if (!/\.[cm]?[jt]sx?$/.test(clean) || clean.startsWith("..")) return;
    addSourceVariants(clean);
  };

  const pkg = json as {
    main?: unknown;
    module?: unknown;
    types?: unknown;
    bin?: unknown;
    exports?: unknown;
    scripts?: Record<string, unknown>;
  } | null;
  if (!pkg || typeof pkg !== "object") return [];
  addTarget(pkg.main);
  addTarget(pkg.module);
  addTarget(pkg.types);
  if (typeof pkg.bin === "string") addTarget(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object") {
    for (const v of Object.values(pkg.bin)) addTarget(v);
  }
  const walkExports = (v: unknown): void => {
    if (typeof v === "string") addTarget(v);
    else if (v && typeof v === "object") for (const inner of Object.values(v)) walkExports(inner);
  };
  walkExports(pkg.exports);
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    if (typeof cmd !== "string") continue;
    for (const token of cmd.split(/\s+/)) {
      if (/^[\w@./-]+\.[cm]?[jt]sx?$/.test(token) && !token.startsWith("-")) addTarget(token);
    }
  }
  return [...out];
}

/** Files with more importers than this are shared utilities, not entry points. */
const JOURNEY_MAX_IMPORTERS = 2;

/**
 * Rank entry points by how widely their call graph fans out — the codebase's
 * "top user journeys". Candidates are symbols with calls in entry-shaped
 * files: root files (nothing imports them — mains, app shells), module entry
 * files, and low-fan-in files (≤2 importers — top-level components reached
 * through a barrel). High-fan-in files are shared utilities, not entries.
 * Each candidate is scored with a bounded BFS counting reached symbols and
 * distinct modules.
 */
export function rankJourneySuggestions(
  records: Map<string, JourneySourceRecord>,
  graph: CallGraph,
  importedBy: Map<string, Set<string>>,
  limit = JOURNEY_DEFAULT_LIMIT,
): JourneySuggestion[] {
  const candidates: { rec: JourneySourceRecord; sym: ParsedSymbol; priority: number }[] = [];
  const paths = [...records.keys()].sort();
  for (const path of paths) {
    const rec = records.get(path)!;
    if (isTestFile(rec.path)) continue;
    const importers = importedBy.get(rec.path)?.size ?? 0;
    const root = importers === 0;
    const entry = isModuleEntryFile(rec);
    if (!root && !entry && importers > JOURNEY_MAX_IMPORTERS) continue;
    const priority = root ? 0 : entry ? 1 : 2;
    for (const sym of rec.symbols) {
      if (sym.kind !== "function" && sym.kind !== "component" && sym.kind !== "const") continue;
      // Render-only symbols are presentational components, not entry points —
      // a widget tree is not a user journey.
      if (!sym.calls.some((c) => !c.render)) continue;
      if (!sym.exported && !root) continue;
      candidates.push({ rec, sym, priority });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.rec.path.localeCompare(b.rec.path));
  candidates.length = Math.min(candidates.length, JOURNEY_MAX_CANDIDATES);

  const score = (entry: CodeSymbolRef, entryModule: string) => {
    const visited = new Set([callKey(entry)]);
    const modules = new Set([entryModule]);
    let queue: CodeSymbolRef[] = [entry];
    let depth = 0;
    while (queue.length > 0 && depth < JOURNEY_BFS_DEPTH) {
      const next: CodeSymbolRef[] = [];
      for (const ref of queue) {
        const node = graph.get(callKey(ref));
        if (!node) continue;
        for (const target of node.resolved) {
          const key = callKey(target);
          if (visited.has(key) || visited.size >= JOURNEY_BFS_NODES) continue;
          visited.add(key);
          modules.add(records.get(target.file)?.module ?? ".");
          next.push(target);
        }
      }
      queue = next;
      depth += 1;
    }
    return { stepCount: visited.size, moduleSpan: modules.size };
  };

  const scored: JourneySuggestion[] = [];
  for (const { rec, sym } of candidates) {
    const entry: CodeSymbolRef = { file: rec.path, symbol: sym.name };
    const { stepCount, moduleSpan } = score(entry, rec.module);
    if (stepCount < JOURNEY_MIN_STEPS) continue;
    scored.push({ entry, kind: sym.kind, entryModule: rec.module, moduleSpan, stepCount });
  }
  scored.sort(
    (a, b) =>
      b.moduleSpan - a.moduleSpan ||
      b.stepCount - a.stepCount ||
      a.entry.symbol.localeCompare(b.entry.symbol) ||
      a.entry.file.localeCompare(b.entry.file),
  );

  const perModule = new Map<string, number>();
  const out: JourneySuggestion[] = [];
  for (const s of scored) {
    const used = perModule.get(s.entryModule) ?? 0;
    if (used >= JOURNEY_PER_MODULE) continue;
    perModule.set(s.entryModule, used + 1);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/** A served route registration, mount-composed, ready for suffix matching. */
interface ServedRoute {
  method: string;
  segs: string[];
  path: string;
  file: string;
  line?: number;
  handler?: string;
}

/**
 * Analyzes the workspace into the three-level code map. Results are cached by
 * file mtime; call `analyze()` again after changes — unchanged files are not
 * re-parsed.
 */
export class CodeMapAnalyzer {
  private parseCache = new Map<string, ParsedFile>();
  private records = new Map<string, FileRecord>();
  private importedBy = new Map<string, Set<string>>();
  private modules: CodeModule[] = [];
  private packageNameToModule = new Map<string, string>();
  private tsPaths: TsPathsConfig[] = [];
  /** Entry files declared by package manifests (bin/main/exports/scripts). */
  private declaredEntries = new Set<string>();
  private analyzing: Promise<void> | null = null;
  private dirty = true;
  private callGraphMemo: CallGraph | null = null;
  private surfacesMemo: Promise<SurfacesReport> | null = null;
  private surfaceMapMemo: Promise<SurfaceMapReport> | null = null;

  constructor(private readonly root: string) {}

  invalidate(): void {
    this.dirty = true;
  }

  private async ensureFresh(): Promise<void> {
    if (!this.dirty && !this.analyzing) return;
    this.analyzing ??= this.analyze().finally(() => {
      this.analyzing = null;
    });
    await this.analyzing;
  }

  /** Full workspace pass (cheap on re-runs thanks to the mtime cache). */
  private async analyze(): Promise<void> {
    this.dirty = false;
    this.packageNameToModule.clear();
    this.declaredEntries.clear();
    const moduleDirs = await this.discoverModules();
    const files = await this.collectFiles(moduleDirs);

    const records = new Map<string, FileRecord>();
    await Promise.all(
      files.map(async ({ rel, module }) => {
        const abs = resolveInRoot(this.root, rel);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          return;
        }
        let parsed = this.parseCache.get(rel);
        if (!parsed || parsed.mtimeMs !== stat.mtimeMs) {
          try {
            const text = await fs.readFile(abs, "utf8");
            parsed = { mtimeMs: stat.mtimeMs, hash: fnv1a64(text), ...parseSource(rel, text) };
            this.parseCache.set(rel, parsed);
          } catch {
            return;
          }
        }
        records.set(rel, {
          ...parsed,
          path: rel,
          module,
          resolvedImports: [],
          resolvedMounts: [],
        });
      }),
    );

    // Resolve imports now that the full file set is known.
    const fileSet = new Set(records.keys());
    const importedBy = new Map<string, Set<string>>();
    for (const record of records.values()) {
      record.resolvedImports = record.imports.map(({ specifier, names, line }) => {
        const resolved = this.resolveSpecifier(record.path, specifier, fileSet);
        if (resolved) {
          let set = importedBy.get(resolved);
          if (!set) importedBy.set(resolved, (set = new Set()));
          set.add(record.path);
        }
        return { specifier, resolved, names, line };
      });
      // A mount's router identifier resolves through the import that binds it.
      record.resolvedMounts = record.mounts.flatMap(({ prefix, target }) => {
        const imp = record.resolvedImports.find(
          (i) => i.resolved && (i.names.includes(target) || i.names.includes(`* as ${target}`)),
        );
        return imp?.resolved ? [{ prefix, resolved: imp.resolved }] : [];
      });
    }

    this.records = records;
    this.importedBy = importedBy;
    this.callGraphMemo = null;
    this.surfacesMemo = null;
    this.surfaceMapMemo = null;
    this.modules = moduleDirs.map((m) => ({
      ...m,
      fileCount: [...records.values()].filter((r) => r.module === m.path).length,
    }));
  }

  /** package.json dirs (deepest wins for file ownership); "." is always a module. */
  private async discoverModules(): Promise<CodeModule[]> {
    const found: { path: string; name: string; versioned?: boolean }[] = [];
    const readWorkspaceFile = async (rel: string): Promise<string | null> => {
      try {
        return await fs.readFile(resolveInRoot(this.root, rel), "utf8");
      } catch {
        return null;
      }
    };
    const tsPathsConfigs: TsPathsConfig[] = [];
    const walk = async (rel: string, depth: number): Promise<void> => {
      const abs = resolveInRoot(this.root, rel === "" ? "." : rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      // Any tsconfig here may declare `paths` aliases governing files below
      // (Vite splits them into tsconfig.app.json / tsconfig.node.json).
      for (const entry of entries) {
        if (!entry.isFile() || !/^tsconfig[^/]*\.json$/.test(entry.name)) continue;
        const configRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        const config = await loadTsPathsConfig(readWorkspaceFile, configRel);
        if (config) tsPathsConfigs.push(config);
      }
      const pkg = entries.find((e) => e.isFile() && e.name === "package.json");
      if (pkg) {
        let name = rel === "" ? path.basename(path.resolve(this.root)) : path.basename(rel);
        try {
          const json = JSON.parse(await fs.readFile(path.join(abs, "package.json"), "utf8"));
          if (typeof json.name === "string" && json.name) {
            name = json.name;
            this.packageNameToModule.set(json.name, rel === "" ? "." : rel);
          }
          for (const entry of declaredEntryPaths(rel === "" ? "." : rel, json)) {
            this.declaredEntries.add(entry);
          }
        } catch {
          /* unparseable package.json — directory name is fine */
        }
        // A nested `.git` means this module is versioned separately from the
        // workspace (submodule / vendored repo) — a repository, not a package.
        const versioned = rel !== "" && entries.some((e) => e.name === ".git");
        found.push({ path: rel === "" ? "." : rel, name, ...(versioned ? { versioned } : {}) });
      }
      if (depth >= 3) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !isIgnoredDir(entry.name) && !entry.name.startsWith(".")) {
          await walk(rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1);
        }
      }
    };
    await walk("", 0);
    this.tsPaths = sortTsPathsConfigs(tsPathsConfigs);
    if (!found.some((m) => m.path === ".")) {
      found.unshift({ path: ".", name: path.basename(path.resolve(this.root)) });
    }
    return found.map((m) => ({ ...m, fileCount: 0 }));
  }

  /** All code files, each owned by the deepest module containing it. */
  private async collectFiles(
    modules: CodeModule[],
  ): Promise<{ rel: string; module: string }[]> {
    const modulePaths = [...modules.map((m) => m.path)].sort((a, b) => b.length - a.length);
    const ownerOf = (rel: string): string =>
      modulePaths.find((m) => m !== "." && (rel === m || rel.startsWith(m + "/"))) ?? ".";

    const out: { rel: string; module: string }[] = [];
    const walk = async (rel: string): Promise<void> => {
      if (out.length >= MAX_FILES) return;
      const abs = resolveInRoot(this.root, rel === "" ? "." : rel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!isIgnoredDir(entry.name) && !entry.name.startsWith(".")) await walk(childRel);
        } else if (entry.isFile() && isCodeFile(entry.name)) {
          out.push({ rel: childRel, module: ownerOf(childRel) });
          if (out.length >= MAX_FILES) return;
        }
      }
    };
    await walk("");
    return out;
  }

  private resolveSpecifier(fromRel: string, specifier: string, fileSet: Set<string>): string | null {
    return resolveImportSpecifier(fromRel, specifier, fileSet, this.packageNameToModule, this.tsPaths);
  }

  private moduleOf(rel: string): string {
    return this.records.get(rel)?.module ?? ".";
  }

  async summary(): Promise<CodeMapSummary> {
    await this.ensureFresh();
    const weights = new Map<string, number>();
    const externalImports: { module: string; pkg: string }[] = [];
    for (const record of this.records.values()) {
      for (const imp of record.resolvedImports) {
        if (!imp.resolved) {
          const pkg = packageNameOf(imp.specifier);
          if (pkg) externalImports.push({ module: record.module, pkg });
          continue;
        }
        const target = this.moduleOf(imp.resolved);
        if (target === record.module) continue;
        const key = `${record.module} ${target}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
    const deps: CodeModuleDep[] = [...weights.entries()].map(([key, weight]) => {
      const [source, target] = key.split(" ") as [string, string];
      return { source, target, weight };
    });
    return {
      modules: this.modules,
      deps,
      externals: aggregateExternalDeps(externalImports),
      fileTotal: this.records.size,
      generatedAt: new Date().toISOString(),
    };
  }

  async moduleDetail(modulePath: string, prefer?: readonly string[]): Promise<CodeModuleDetail> {
    await this.ensureFresh();
    const module = this.modules.find((m) => m.path === modulePath);
    if (!module) throw new Error(`Unknown module: ${modulePath}`);

    const records = [...this.records.values()].filter((r) => r.module === modulePath);
    const prefix = modulePath === "." ? "" : modulePath + "/";

    const summaries: CodeFileSummary[] = records.map((r) => {
      const inModule = prefix ? r.path.slice(prefix.length) : r.path;
      return {
        path: r.path,
        name: path.posix.basename(r.path),
        dir: path.posix.dirname(inModule) === "." ? "" : path.posix.dirname(inModule),
        importCount: r.resolvedImports.length,
        exportCount: r.exports.length,
      };
    });

    const edges = [];
    const crossWeights = new Map<string, number>();
    for (const r of records) {
      for (const imp of r.resolvedImports) {
        if (!imp.resolved) continue;
        const targetModule = this.moduleOf(imp.resolved);
        if (targetModule === modulePath) {
          edges.push({ source: r.path, target: imp.resolved });
        } else {
          crossWeights.set(targetModule, (crossWeights.get(targetModule) ?? 0) + 1);
        }
      }
    }
    const moduleDeps: CodeModuleDep[] = [...crossWeights.entries()].map(([target, weight]) => ({
      source: modulePath,
      target,
      weight,
    }));

    // Keep the canvas readable: prefer connected files when truncating.
    // `prefer` entries (files or dir prefixes — the caller's facet lens) rank
    // above connectedness: a lens member cut here would render the drilled
    // system as an empty shell client-side.
    let shown = summaries;
    let truncated = false;
    if (summaries.length > MAX_MODULE_FILES_SHOWN) {
      const preferred = new Set(
        prefer && prefer.length > 0
          ? summaries
              .filter((s) => prefer.some((d) => s.path === d || s.path.startsWith(`${d}/`)))
              .map((s) => s.path)
          : [],
      );
      const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
      shown = summaries
        .sort(
          (a, b) =>
            Number(preferred.has(b.path)) - Number(preferred.has(a.path)) ||
            Number(connected.has(b.path)) - Number(connected.has(a.path)),
        )
        .slice(0, MAX_MODULE_FILES_SHOWN);
      truncated = true;
    }
    const shownSet = new Set(shown.map((s) => s.path));

    return {
      module,
      files: shown,
      edges: edges.filter((e) => shownSet.has(e.source) && shownSet.has(e.target)),
      moduleDeps,
      truncated,
    };
  }

  /**
   * All call sites addressing a served route — the API explorer's "who calls
   * this". Same matching as the overview's API links: method-compatible and
   * the served path matches the call path (or a suffix of it, for calls that
   * dial through a router mount the file-level route can't see).
   */
  async apiSites(
    method: string,
    servedPath: string,
  ): Promise<{ sites: { file: string; line?: number; method: string; path: string }[] }> {
    await this.ensureFresh();
    const servedSegs = routeSegments(servedPath);
    const sites: { file: string; line?: number; method: string; path: string }[] = [];
    for (const record of this.records.values()) {
      for (const call of record.apiCalls) {
        if (!(method === "ALL" || call.method === "ALL" || call.method === method)) continue;
        if (!routesMatchSuffix(routeSegments(call.path), servedSegs)) continue;
        sites.push({ file: record.path, line: call.line, method: call.method, path: call.path });
      }
    }
    sites.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
    return { sites };
  }

  /** Cross-workspace analysis input: published packages + external imports. */
  async crossSurface(): Promise<CrossSurface> {
    await this.ensureFresh();
    const externalImports: CrossSurface["externalImports"] = [];
    for (const record of this.records.values()) {
      for (const imp of record.resolvedImports) {
        if (imp.resolved) continue;
        const pkg = packageNameOf(imp.specifier);
        if (pkg) externalImports.push({ fromModule: record.module, pkg, names: imp.names });
      }
    }
    return {
      packages: new Map(this.packageNameToModule),
      externalImports,
      fileTotal: this.records.size,
    };
  }

  async fileDetail(rel: string): Promise<CodeFileDetail> {
    await this.ensureFresh();
    const record = this.records.get(rel);
    if (!record) throw new Error(`Not an analyzed code file: ${rel}`);
    const imports: CodeImport[] = record.resolvedImports.map((imp) => ({
      specifier: imp.specifier,
      resolved: imp.resolved,
      targetModule: imp.resolved ? this.moduleOf(imp.resolved) : null,
      names: imp.names,
      external: !imp.resolved && !imp.specifier.startsWith("."),
    }));
    return {
      path: rel,
      module: record.module,
      loc: record.loc,
      imports,
      exports: record.exports,
      symbols: record.symbols.map(({ name, kind, line, endLine, exported }) => ({
        name,
        kind,
        line,
        endLine,
        exported,
      })),
      importedBy: [...(this.importedBy.get(rel) ?? [])].sort(),
    };
  }

  /**
   * Bulk expansion for the LoD slider: details of the listed modules (all
   * when omitted) plus every file they show, one call instead of N+1. File
   * lists honor the same per-module truncation as `moduleDetail`.
   */
  async bulkDetails(
    modulePaths?: string[],
    prefer?: readonly string[],
  ): Promise<{ modules: CodeModuleDetail[]; files: CodeFileDetail[] }> {
    await this.ensureFresh();
    const wanted =
      modulePaths ?? this.modules.filter((m) => m.fileCount > 0).map((m) => m.path);
    const modules: CodeModuleDetail[] = [];
    const files: CodeFileDetail[] = [];
    for (const path of wanted) {
      const detail = await this.moduleDetail(path, prefer);
      modules.push(detail);
      for (const file of detail.files) files.push(await this.fileDetail(file.path));
    }
    return { modules, files };
  }

  /* ---------------- accessors for the refactor engine ---------------- */

  /** Range + metadata of one top-level symbol (throws when unknown). */
  async symbolMeta(file: string, symbol: string): Promise<ParsedSymbol> {
    await this.ensureFresh();
    return this.symbolIn(file, symbol).sym;
  }

  /** Files importing `file` (workspace-relative). */
  async importersOf(file: string): Promise<string[]> {
    await this.ensureFresh();
    return [...(this.importedBy.get(file) ?? [])].sort();
  }

  async filesOfModule(module: string): Promise<string[]> {
    await this.ensureFresh();
    return [...this.records.values()].filter((r) => r.module === module).map((r) => r.path);
  }

  async moduleOfFile(file: string): Promise<string> {
    await this.ensureFresh();
    return this.moduleOf(file);
  }

  /* ---------------- symbol-level queries ---------------- */

  private callGraph(): CallGraph {
    this.callGraphMemo ??= buildCallGraph(this.records);
    return this.callGraphMemo;
  }

  /**
   * Locate a top-level symbol, following barrel re-export chains when `file`
   * only re-exports it — import targets usually resolve to the barrel, not
   * the declaration, and callers (contract crossings, handler lookups) pass
   * those paths straight in.
   */
  private symbolIn(file: string, symbol: string): { record: FileRecord; sym: ParsedSymbol } {
    const start = this.records.get(file);
    if (!start) throw new Error(`Not an analyzed code file: ${file}`);
    const seen = new Set<string>();
    let queue: FileRecord[] = [start];
    for (let hops = 0; hops <= REEXPORT_MAX_HOPS && queue.length > 0; hops++) {
      const next: FileRecord[] = [];
      for (const record of queue) {
        if (seen.has(record.path)) continue;
        seen.add(record.path);
        const sym = record.symbols.find((s) => s.name === symbol);
        if (sym) return { record, sym };
        for (const rx of record.reexports) {
          if (rx.name !== symbol && rx.name !== "*") continue;
          const resolved = record.resolvedImports.find((i) => i.specifier === rx.specifier)?.resolved;
          const target = resolved ? this.records.get(resolved) : undefined;
          if (target) next.push(target);
        }
      }
      queue = next;
    }
    throw new Error(`No top-level symbol "${symbol}" in ${file}`);
  }

  async symbolSource(file: string, symbol: string): Promise<CodeSymbolSource> {
    await this.ensureFresh();
    // The record may sit behind a barrel — read (and report) the declaring file.
    const { record, sym } = this.symbolIn(file, symbol);
    const declFile = record.path;
    const text = await fs.readFile(resolveInRoot(this.root, declFile), "utf8");
    let slice = text.slice(sym.start, sym.end);
    let truncated = false;
    const lines = slice.split("\n");
    if (lines.length > SNIPPET_MAX_LINES) {
      slice = lines.slice(0, SNIPPET_MAX_LINES).join("\n");
      truncated = true;
    }
    if (Buffer.byteLength(slice, "utf8") > SNIPPET_MAX_BYTES) {
      slice = slice.slice(0, SNIPPET_MAX_BYTES);
      truncated = true;
    }
    return {
      file: declFile,
      symbol,
      startLine: sym.line,
      endLine: sym.endLine,
      text: slice,
      truncated,
    };
  }

  /**
   * Everywhere `symbol` (declared in `file`) crosses into consumers: import
   * statements that bring it in — following barrel re-export chains the same
   * way the call graph does — and call sites invoking it. Each site carries
   * its trimmed source line so UIs can show the usage inline.
   */
  async symbolSites(file: string, symbol: string): Promise<CodeSymbolSites> {
    await this.ensureFresh();
    // The query may name a barrel — anchor everything on the declaring file.
    const { record: declRecord, sym } = this.symbolIn(file, symbol);
    const declFile = declRecord.path;

    // Does an import of `symbol` from `from` land on our declaration?
    const reaches = (from: string, hops: number): boolean => {
      if (from === declFile) return true;
      if (hops >= REEXPORT_MAX_HOPS) return false;
      const rec = this.records.get(from);
      if (!rec) return false;
      // `from` declares its own `symbol` — the import stops there.
      if (rec.symbols.some((s) => s.name === symbol)) return false;
      for (const rx of rec.reexports) {
        if (rx.name !== symbol && rx.name !== "*") continue;
        const resolved = rec.resolvedImports.find((i) => i.specifier === rx.specifier)?.resolved;
        if (resolved && reaches(resolved, hops + 1)) return true;
      }
      return false;
    };

    const imports: SymbolSite[] = [];
    for (const rec of this.records.values()) {
      if (rec.path === declFile) continue;
      for (const imp of rec.resolvedImports) {
        if (!imp.resolved || !imp.names.includes(symbol)) continue;
        if (!reaches(imp.resolved, 0)) continue;
        imports.push({ file: rec.path, line: imp.line ?? null });
      }
    }

    // Call sites via the syntax call graph: every symbol whose resolved
    // callees include ours, located by its same-named call entries.
    const calls: SymbolSite[] = [];
    for (const node of this.callGraph().values()) {
      if (node.ref.file === declFile && node.ref.symbol === symbol) continue;
      if (!node.resolved.some((r) => r.file === declFile && r.symbol === symbol)) continue;
      const callerSym = this.records
        .get(node.ref.file)
        ?.symbols.find((s) => s.name === node.ref.symbol);
      const sites = callerSym?.calls.filter((c) => c.name === symbol) ?? [];
      if (sites.length === 0) {
        calls.push({ file: node.ref.file, line: callerSym?.line ?? null, symbol: node.ref.symbol });
        continue;
      }
      const seenLines = new Set<number>();
      for (const c of sites) {
        if (c.line != null && seenLines.has(c.line)) continue;
        if (c.line != null) seenLines.add(c.line);
        calls.push({ file: node.ref.file, line: c.line ?? null, symbol: node.ref.symbol });
      }
    }

    const byPlace = (a: SymbolSite, b: SymbolSite) =>
      a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0);
    imports.sort(byPlace);
    calls.sort(byPlace);
    const truncated = imports.length > SITES_MAX || calls.length > SITES_MAX;
    const cappedImports = imports.slice(0, SITES_MAX);
    const cappedCalls = calls.slice(0, SITES_MAX);

    // One read per involved file fills in each site's source line.
    const byFile = new Map<string, SymbolSite[]>();
    for (const site of [...cappedImports, ...cappedCalls]) {
      if (site.line == null) continue;
      const list = byFile.get(site.file);
      if (list) list.push(site);
      else byFile.set(site.file, [site]);
    }
    await Promise.all(
      [...byFile.entries()].map(async ([sitePath, sites]) => {
        let lines: string[];
        try {
          lines = (await fs.readFile(resolveInRoot(this.root, sitePath), "utf8")).split("\n");
        } catch {
          return; // file vanished mid-flight — sites stay line-only
        }
        for (const site of sites) {
          const text = lines[site.line! - 1]?.trim();
          if (text)
            site.text = text.length > SITE_TEXT_MAX ? `${text.slice(0, SITE_TEXT_MAX - 1)}…` : text;
        }
      }),
    );

    return {
      file: declFile,
      symbol,
      declaration: { line: sym.line, endLine: sym.endLine },
      imports: cappedImports,
      calls: cappedCalls,
      truncated,
    };
  }

  /**
   * The concrete integration points of one part-pair: every import statement
   * from files owned by `sourcePart` into files owned by `targetPart`, with
   * its source line inline. Ownership is longest-prefix over each side's part
   * list (defaulting to just the named part), matching the attribution the
   * overview uses for `SystemLink.parts` — a file under a nested sibling part
   * must not count as this part's.
   */
  async partCrossings(
    sourcePart: string,
    targetPart: string,
    sourceParts: readonly string[] = [sourcePart],
    targetParts: readonly string[] = [targetPart],
  ): Promise<PartCrossings> {
    await this.ensureFresh();
    const ownerOf = (file: string, parts: readonly string[]): string | null => {
      let best: string | null = null;
      for (const part of parts) {
        if (file !== part && !file.startsWith(`${part}/`)) continue;
        if (best === null || part.length > best.length) best = part;
      }
      return best;
    };
    const crossings: PartCrossing[] = [];
    for (const rec of [...this.records.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      // Test files are excluded so counts reconcile with the overview's
      // part weights, which never see them.
      if (isTestFile(rec.path) || ownerOf(rec.path, sourceParts) !== sourcePart) continue;
      for (const imp of rec.resolvedImports) {
        if (!imp.resolved || ownerOf(imp.resolved, targetParts) !== targetPart) continue;
        crossings.push({
          file: rec.path,
          line: imp.line ?? null,
          names: imp.names,
          targetFile: imp.resolved,
        });
      }
    }
    crossings.sort(
      (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
    );
    const truncated = crossings.length > CROSSINGS_MAX;
    const capped = crossings.slice(0, CROSSINGS_MAX);

    // One read per importing file fills in each crossing's source line.
    const byFile = new Map<string, PartCrossing[]>();
    for (const c of capped) {
      if (c.line == null) continue;
      const list = byFile.get(c.file);
      if (list) list.push(c);
      else byFile.set(c.file, [c]);
    }
    // Multi-line import statements collapse to one line, read until the
    // specifier string ends the statement (bounded lookahead).
    const statementAt = (lines: string[], start: number): string => {
      const parts: string[] = [];
      for (let i = start - 1; i < Math.min(lines.length, start + 5); i++) {
        const t = lines[i]?.trim();
        if (!t) break;
        parts.push(t);
        if (/["'][^"']*["']\s*;?\s*$/.test(t)) break;
      }
      return parts.join(" ");
    };
    await Promise.all(
      [...byFile.entries()].map(async ([sitePath, sites]) => {
        let lines: string[];
        try {
          lines = (await fs.readFile(resolveInRoot(this.root, sitePath), "utf8")).split("\n");
        } catch {
          return; // file vanished mid-flight — crossings stay line-only
        }
        for (const site of sites) {
          const text = statementAt(lines, site.line!);
          if (text)
            site.text = text.length > SITE_TEXT_MAX ? `${text.slice(0, SITE_TEXT_MAX - 1)}…` : text;
        }
      }),
    );

    return { sourcePart, targetPart, crossings: capped, truncated };
  }

  async trace(file: string, symbol: string, maxDepth = TRACE_MAX_DEPTH): Promise<CodeTrace> {
    await this.ensureFresh();
    return this.traceSync(file, symbol, maxDepth);
  }

  /**
   * `trace` on the current snapshot, no freshness check — batch callers
   * (`buildSurfaceMap`) run entirely behind one `ensureFresh`, so every trace
   * in the batch sees the same records/served routes even if the watcher
   * invalidates mid-build.
   */
  private traceSync(file: string, symbol: string, maxDepth = TRACE_MAX_DEPTH): CodeTrace {
    // Resolve through barrels — the call graph keys on the declaring file.
    const { record } = this.symbolIn(file, symbol);
    const graph = this.callGraph();
    const entry: CodeSymbolRef = { file: record.path, symbol };
    const depth = Math.max(1, Math.min(maxDepth, TRACE_MAX_DEPTH));

    const steps: CodeTraceStep[] = [];
    const edges: CodeTraceEdge[] = [];
    const unresolvedCalls: CodeTrace["unresolvedCalls"] = [];
    const visited = new Set<string>([callKey(entry)]);
    let truncated = false;
    let queue: CodeSymbolRef[] = [entry];
    let level = 0;

    while (queue.length > 0 && level <= depth) {
      const next: CodeSymbolRef[] = [];
      for (const ref of queue) {
        const record = this.records.get(ref.file);
        const sym = record?.symbols.find((s) => s.name === ref.symbol);
        steps.push({ ref, module: record?.module ?? ".", line: sym?.line ?? 1, depth: level });
        const node = graph.get(callKey(ref));
        if (!node) continue;
        for (const callee of node.unresolved) unresolvedCalls.push({ from: ref, callee });
        for (const target of node.resolved) {
          edges.push({ from: ref, to: target });
          const key = callKey(target);
          if (visited.has(key)) continue;
          if (visited.size >= TRACE_MAX_NODES) {
            truncated = true;
            continue;
          }
          visited.add(key);
          next.push(target);
        }
      }
      queue = next;
      level += 1;
    }
    if (queue.length > 0) truncated = true;

    return { entry, steps, edges, truncated, unresolvedCalls };
  }

  /**
   * Frontend→backend API trace: walk the call graph from a component/hook
   * (or take a whole file when `symbol` is omitted), collect every outgoing
   * HTTP call inside the visited symbol bodies, and match each to the best
   * served route registration — the same suffix matching the overview's
   * `SystemLink.apis` uses, so both views tell one story.
   */
  async apiTrace(file: string, symbol?: string, maxDepth?: number): Promise<ApiTrace> {
    await this.ensureFresh();
    const { calls, truncated } = this.traceApiCalls(file, symbol, maxDepth);
    this.matchServedRoutes(calls, this.servedRoutes());
    return { entry: { file, symbol }, calls, truncated };
  }

  /** Every served route registration, mount-composed for suffix matching. */
  private servedRoutes(): ServedRoute[] {
    const prefixes = computeMountPrefixes(this.records.values());
    const served: ServedRoute[] = [];
    for (const record of this.records.values()) {
      if (isTestFile(record.path)) continue;
      const prefix = prefixes.get(record.path);
      for (const ep of record.endpoints) {
        const full = prefix ? joinMountedPath(prefix, ep.path) : ep.path;
        served.push({
          method: ep.method,
          segs: routeSegments(full),
          path: full,
          file: record.path,
          line: ep.line,
          handler: ep.handler,
        });
      }
    }
    return served;
  }

  /** Resolve each call's `endpoint` to the best-matching served route. */
  private matchServedRoutes(calls: ApiTraceCall[], served: ServedRoute[]): void {
    for (const call of calls) {
      const hit = bestServedRoute(call, served);
      if (hit)
        call.endpoint = {
          method: hit.method,
          path: hit.path,
          file: hit.file,
          line: hit.line,
          handler: hit.handler,
        };
    }
  }

  /** apiTrace's traversal core: the outgoing calls, sorted, not yet matched. */
  private traceApiCalls(
    file: string,
    symbol?: string,
    maxDepth?: number,
  ): { calls: ApiTraceCall[]; truncated: boolean } {
    const calls: ApiTraceCall[] = [];
    let truncated = false;
    const collect = (rec: FileRecord, within: { line: number; endLine: number } | null, via: ApiTraceCall["via"]) => {
      for (const call of rec.apiCalls) {
        if (within && (call.line == null || call.line < within.line || call.line > within.endLine))
          continue;
        calls.push({ method: call.method, path: call.path, file: rec.path, line: call.line, via });
      }
    };

    if (symbol) {
      const trace = this.traceSync(file, symbol, maxDepth);
      truncated = trace.truncated;
      // Resolve each step's record/symbol once — both passes below reuse it.
      const steps = trace.steps.map((step) => {
        const rec = this.records.get(step.ref.file);
        return { step, rec, sym: rec?.symbols.find((s) => s.name === step.ref.symbol) };
      });
      // Which method names the path actually invoked — a class step then only
      // contributes the methods that were called, not its whole API surface.
      const calledMethods = new Set<string>();
      for (const { sym } of steps) {
        for (const call of sym?.calls ?? []) if (call.receiver) calledMethods.add(call.name);
      }
      for (const { step, rec, sym } of steps) {
        if (!rec || !sym) continue;
        const invoked = (sym.methods ?? []).filter((m) => calledMethods.has(m.name));
        if (sym.kind === "class" && invoked.length > 0) {
          for (const m of invoked) {
            collect(rec, { line: m.line, endLine: m.endLine }, { ...step.ref, depth: step.depth });
          }
        } else {
          collect(rec, { line: sym.line, endLine: sym.endLine }, { ...step.ref, depth: step.depth });
        }
      }
      // Module-scope calls in the entry file run at import time — they belong
      // to the component's story even though no symbol body contains them.
      const entryRec = this.records.get(file);
      if (entryRec) {
        const covered = new Set(calls.map((c) => `${c.file}:${c.line ?? "?"}`));
        for (const call of entryRec.apiCalls) {
          const key = `${file}:${call.line ?? "?"}`;
          const insideSymbol = entryRec.symbols.some(
            (s) => call.line != null && call.line >= s.line && call.line <= s.endLine,
          );
          if (insideSymbol || covered.has(key)) continue;
          calls.push({ method: call.method, path: call.path, file, line: call.line });
        }
      }
    } else {
      const rec = this.records.get(file);
      if (!rec) throw new Error(`Not an analyzed code file: ${file}`);
      collect(rec, null, undefined);
    }

    calls.sort((a, b) => (a.via?.depth ?? 0) - (b.via?.depth ?? 0) || (a.line ?? 0) - (b.line ?? 0));
    return { calls, truncated };
  }

  /** Per-file inputs for the review sweep (see core's code-review.ts). */
  async reviewSourceFiles(): Promise<ReviewSourceFile[]> {
    await this.ensureFresh();
    return [...this.records.values()].map((record) => ({
      path: record.path,
      module: record.module,
      entry:
        isModuleEntryFile(record) ||
        this.declaredEntries.has(record.path) ||
        isConventionEntryFile(record.path),
      test: isTestFile(record.path),
      symbols: record.symbols.map(({ name, kind, line, exported }) => ({
        name,
        kind,
        line,
        exported,
      })),
      imports: record.resolvedImports,
      reexports: record.reexports,
    }));
  }

  /** Per-file inputs for the logical system overview (see core's system-overview.ts). */
  async overviewSourceFiles(): Promise<OverviewSourceFile[]> {
    await this.ensureFresh();
    const nameOfModule = new Map(this.modules.map((m) => [m.path, m.name]));
    const prefixes = computeMountPrefixes(this.records.values());
    return [...this.records.values()].map((record) => {
      const components = record.symbols
        .filter((s) => s.kind === "component")
        .map((s) => s.name);
      const prefix = prefixes.get(record.path);
      return {
        path: record.path,
        pkg: record.module,
        pkgName: nameOfModule.get(record.module),
        test: isTestFile(record.path),
        imports: record.resolvedImports,
        exports: record.exports.map(({ name, kind, signature }) => ({ name, kind, signature })),
        endpoints: prefix
          ? record.endpoints.map((ep) => ({ ...ep, path: joinMountedPath(prefix, ep.path) }))
          : record.endpoints,
        apiCalls: record.apiCalls,
        components: components.length > 0 ? components : undefined,
      };
    });
  }

  /** Per-file inputs for the semantic code index (see core's code-index.ts). */
  async indexSourceFiles(): Promise<IndexSourceFile[]> {
    await this.ensureFresh();
    const graph = this.callGraph();
    return [...this.records.values()].map((record) => {
      const importerModules = new Set<string>();
      for (const importer of this.importedBy.get(record.path) ?? []) {
        const mod = this.moduleOf(importer);
        if (mod !== record.module) importerModules.add(mod);
      }
      return {
        path: record.path,
        module: record.module,
        hash: record.hash,
        importerModules: importerModules.size,
        symbols: record.symbols.map(({ name, kind, line, exported }) => ({
          name,
          kind,
          line,
          exported,
          calls: graph.get(callKey({ file: record.path, symbol: name }))?.resolved ?? [],
        })),
      };
    });
  }

  /**
   * Product surfaces report (screens/components/stories/APIs/schemas/demo).
   * Cached until the watcher invalidates the analyzer — `surfaces.get` runs on
   * every `codemap.changed` refetch, so recomputes must be free when idle.
   */
  async surfaces(): Promise<SurfacesReport> {
    await this.ensureFresh();
    this.surfacesMemo ??= buildSurfacesReport(this.root, this.records, this.importedBy);
    return this.surfacesMemo;
  }

  /**
   * Per-screen API reachability for the system map: every screen in the
   * surfaces report traced to its outgoing HTTP calls (call-graph walk from
   * the screen's component symbol, falling back to the file's exported
   * components, then to whole-file collection), matched to served routes.
   * Cached like the surfaces report — the analyzer rebuild clears both memos
   * together.
   */
  async surfaceMap(): Promise<SurfaceMapReport> {
    await this.ensureFresh();
    this.surfaceMapMemo ??= this.buildSurfaceMap();
    return this.surfaceMapMemo;
  }

  /**
   * Symbols worth tracing for a screen's entry file. The component symbol
   * walks the call graph into hooks and API-client modules — the common
   * delegation pattern; whole-file collection (the empty list) only sees the
   * entry file's own call sites.
   */
  private screenTraceSymbols(
    rec: FileRecord,
    component: string | undefined,
  ): { symbols: string[]; dropped: boolean } {
    if (component && rec.symbols.some((s) => s.name === component)) {
      return { symbols: [component], dropped: false };
    }
    const exported = rec.symbols.filter((s) => s.exported && s.kind === "component");
    return {
      symbols: exported.slice(0, SCREEN_TRACE_SYMBOL_CAP).map((s) => s.name),
      // Dropped exports mean dropped edges — the report's `truncated` says so.
      dropped: exported.length > SCREEN_TRACE_SYMBOL_CAP,
    };
  }

  /**
   * The whole build runs synchronously behind `surfaceMap()`'s single
   * `ensureFresh` — no per-screen awaits, so a watcher invalidation mid-build
   * can't swap `records` under the iteration and mix two analysis
   * generations in one report.
   */
  private async buildSurfaceMap(): Promise<SurfaceMapReport> {
    const { screens } = await this.surfaces();
    const served = this.servedRoutes();
    // Screens sharing an entry file (layouts, aliased routes) share one trace.
    const traceByEntry = new Map<string, { calls: ApiTraceCall[]; truncated: boolean }>();
    const calls: ScreenApiCall[] = [];
    let truncated = false;
    for (const screen of screens) {
      const entry = screen.componentFile ?? screen.file;
      const rec = this.records.get(entry);
      const traceSymbols = rec
        ? this.screenTraceSymbols(rec, screen.component)
        : { symbols: [], dropped: false };
      const { symbols } = traceSymbols;
      if (traceSymbols.dropped) truncated = true;
      const traceKey = `${entry}|${symbols.join(",")}`;
      let trace = traceByEntry.get(traceKey);
      if (!trace) {
        if (!rec) {
          trace = { calls: [], truncated: false }; // entry outside the analyzed map
        } else if (symbols.length === 0) {
          trace = this.traceApiCalls(entry);
        } else {
          // Merge the per-symbol call-graph walks (dedupe by call site).
          const merged: ApiTraceCall[] = [];
          const seen = new Set<string>();
          let anyTruncated = false;
          for (const symbol of symbols) {
            const t = this.traceApiCalls(entry, symbol);
            anyTruncated ||= t.truncated;
            for (const call of t.calls) {
              const key = `${call.file}:${call.line ?? "?"}:${call.method} ${call.path}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(call);
            }
          }
          trace = { calls: merged, truncated: anyTruncated };
        }
        this.matchServedRoutes(trace.calls, served);
        traceByEntry.set(traceKey, trace);
      }
      if (trace.truncated) truncated = true;
      // One edge per method+path; a call matched to a served route wins over
      // an unmatched duplicate, otherwise the first call site is kept.
      const byRoute = new Map<string, ApiTraceCall>();
      for (const call of trace.calls) {
        const key = `${call.method} ${call.path}`;
        const prev = byRoute.get(key);
        if (!prev || (!prev.endpoint && call.endpoint)) byRoute.set(key, call);
      }
      for (const call of byRoute.values()) {
        calls.push({
          screen: screen.id,
          method: call.method,
          path: call.path,
          file: call.file,
          line: call.line,
          endpoint: call.endpoint && {
            method: call.endpoint.method,
            path: call.endpoint.path,
            file: call.endpoint.file,
            line: call.endpoint.line,
          },
        });
      }
    }
    return { calls, truncated, generatedAt: new Date().toISOString() };
  }

  async suggestJourneys(limit = JOURNEY_DEFAULT_LIMIT): Promise<JourneySuggestion[]> {
    await this.ensureFresh();
    const capped = Math.max(1, Math.min(limit, 25));
    return rankJourneySuggestions(this.records, this.callGraph(), this.importedBy, capped);
  }

  async duplicates(minTokens = MIN_FINGERPRINT_TOKENS): Promise<DuplicateCluster[]> {
    await this.ensureFresh();
    const byHash = new Map<string, DuplicateCluster>();
    for (const record of this.records.values()) {
      for (const sym of record.symbols) {
        if (!sym.fingerprint || sym.tokenCount < minTokens) continue;
        let cluster = byHash.get(sym.fingerprint);
        if (!cluster) {
          cluster = { hash: sym.fingerprint, tokenCount: sym.tokenCount, instances: [] };
          byHash.set(sym.fingerprint, cluster);
        }
        cluster.instances.push({
          file: record.path,
          module: record.module,
          symbol: sym.name,
          line: sym.line,
          endLine: sym.endLine,
          exported: sym.exported,
        });
      }
    }
    return [...byHash.values()]
      .filter((c) => c.instances.length >= 2)
      .sort((a, b) => b.instances.length * b.tokenCount - a.instances.length * a.tokenCount)
      .slice(0, MAX_DUPLICATE_CLUSTERS);
  }

  async searchSymbols(query: string, limit = 50): Promise<SymbolSearchHit[]> {
    await this.ensureFresh();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SymbolSearchHit[] = [];
    for (const record of this.records.values()) {
      for (const sym of record.symbols) {
        if (!sym.name.toLowerCase().includes(q)) continue;
        hits.push({
          file: record.path,
          module: record.module,
          name: sym.name,
          kind: sym.kind,
          line: sym.line,
          exported: sym.exported,
        });
      }
    }
    const rank = (h: SymbolSearchHit): number =>
      (h.exported ? 0 : 2) + (h.name.toLowerCase().startsWith(q) ? 0 : 1);
    return hits
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.file.localeCompare(b.file))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }
}

export { toRelPath };

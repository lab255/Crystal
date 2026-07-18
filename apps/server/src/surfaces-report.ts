import fs from "node:fs/promises";
import ts from "typescript";
import type {
  CodeSymbol,
  CodeSymbolKind,
  ComponentSurface,
  DemoTargets,
  HttpEndpoint,
  SchemaField,
  SchemaKind,
  SchemaSurface,
  ScreenSurface,
  StorySurface,
  SurfacesReport,
  SystemEndpoint,
} from "@crystal/core";
import { resolveInRoot } from "./paths.js";

/**
 * Surfaces analysis: derives the workspace's outward-facing product surface —
 * screens (routes), exported components, Storybook stories, served endpoints,
 * data schemas, and demo URLs — from the code map's per-file parse data plus a
 * few targeted fs reads (router configs, story files, schema-ish files,
 * package.json, prisma schema). Everything is best-effort: malformed sources
 * are skipped, never thrown.
 */

/** The per-file parse data the builder consumes (satisfied by code-map's FileRecord). */
export interface SurfaceSourceRecord {
  /** Workspace-relative path. */
  path: string;
  resolvedImports: { specifier: string; resolved: string | null; names: string[]; line?: number }[];
  exports: CodeSymbol[];
  symbols: { name: string; kind: CodeSymbolKind; line: number; endLine: number; exported: boolean }[];
  endpoints: HttpEndpoint[];
  /** Router mounts: this file mounts `resolved`'s routes under `prefix`. */
  resolvedMounts?: { prefix: string; resolved: string }[];
}

const STORY_FILE_RE = /\.stories\.[jt]sx?$/;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/;
/** Directory segments / filenames that mark a file as schema-bearing. */
const SCHEMA_PATH_RE = /(model|schema|entit|dto|contract|types)/i;
const MAX_SCHEMA_FIELDS = 40;
const TYPE_TEXT_MAX = 60;
const ROUTER_SPECIFIERS = new Set(["react-router", "react-router-dom"]);
const ROUTER_FACTORIES = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
  "useRoutes",
]);
/** Named exports of a CSF file that are meta plumbing, not stories. */
const NON_STORY_EXPORTS = new Set(["meta", "default", "argTypes", "decorators", "parameters", "args", "loaders"]);

function isTestPath(p: string): boolean {
  return TEST_FILE_RE.test(p) || p.includes("__tests__/");
}

function isStoryPath(p: string): boolean {
  return STORY_FILE_RE.test(p);
}

/* ------------------------------------------------------------------ */
/* Small TS helpers                                                     */
/* ------------------------------------------------------------------ */

function createSource(fileRel: string, text: string): ts.SourceFile {
  const kind =
    fileRel.endsWith(".tsx") || fileRel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileRel, text, ts.ScriptTarget.ES2022, false, kind);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

/** Unwrap `satisfies Meta` / `as Meta` / parenthesized wrappers. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isSatisfiesExpression(e) || ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  return e;
}

function propName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function stringValue(expr: ts.Expression): string | null {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? expr.text : null;
}

/**
 * Resolve a compile-time string expression: literals, identifiers with known
 * values, and template literals over both. `onMiss` hears every identifier
 * that had no value (even when another part of the template also failed).
 */
function resolveStringExpr(
  expr: ts.Expression,
  lookup: (name: string) => string | undefined,
  onMiss?: (name: string) => void,
): string | null {
  const e = unwrapExpression(expr);
  const lit = stringValue(e);
  if (lit != null) return lit;
  if (ts.isIdentifier(e)) {
    const hit = lookup(e.text);
    if (hit === undefined) {
      onMiss?.(e.text);
      return null;
    }
    return hit;
  }
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    let ok = true;
    for (const span of e.templateSpans) {
      const part = resolveStringExpr(span.expression, lookup, onMiss);
      if (part == null) ok = false;
      else out += part + span.literal.text;
    }
    return ok ? out : null;
  }
  return null;
}

/** Top-level `const X = "…"` values, composing template consts in declaration order. */
function collectStringConsts(source: ts.SourceFile): Map<string, string> {
  const consts = new Map<string, string>();
  for (const st of source.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const value = resolveStringExpr(decl.initializer, (n) => consts.get(n));
      if (value != null) consts.set(decl.name.text, value);
    }
  }
  return consts;
}

/**
 * String-valued top-level consts of one file (`export const FOO = '/path'`,
 * including templates over earlier consts). Never throws — a malformed file
 * yields an empty map.
 */
export function extractStringConsts(fileRel: string, text: string): Map<string, string> {
  try {
    return collectStringConsts(createSource(fileRel, text));
  } catch {
    return new Map();
  }
}

/** Whitespace-collapsed, length-capped source text for field types. */
function compactType(t: string): string {
  const c = t.replace(/\s+/g, " ").trim();
  return c.length > TYPE_TEXT_MAX ? `${c.slice(0, TYPE_TEXT_MAX - 1)}…` : c;
}

/* ------------------------------------------------------------------ */
/* Screens: next file conventions                                       */
/* ------------------------------------------------------------------ */

/** `(group)`/`@slot` drop, `[...rest]`/`[[...rest]]` → "*", `[param]` → ":param". */
function nextSegment(seg: string): string | null {
  if (/^\(.*\)$/.test(seg) || seg.startsWith("@")) return null;
  if (/^\[\[?\.\.\..*$/.test(seg)) return "*";
  const param = /^\[(.+)\]$/.exec(seg);
  return param ? `:${param[1]}` : seg;
}

/** Route of a next-app `app/**\/page.*` file, or null when it isn't one. */
export function nextAppRoute(fileRel: string): string | null {
  const m = /(?:^|\/)(?:src\/)?app\/(?:(.+)\/)?page\.[jt]sx?$/.exec(fileRel);
  if (!m) return null;
  const segs = (m[1] ? m[1].split("/") : [])
    .map(nextSegment)
    .filter((s): s is string => s != null);
  return `/${segs.join("/")}`;
}

/** Route of a next-pages `pages/**\/*.{tsx,jsx}` file, or null (api/_app/_document/_error excluded). */
export function nextPagesRoute(fileRel: string): string | null {
  const m = /(?:^|\/)(?:src\/)?pages\/(.+)\.[jt]sx$/.exec(fileRel);
  if (!m) return null;
  const rel = m[1]!;
  if (rel === "api" || rel.startsWith("api/")) return null;
  const stem = rel.split("/").at(-1)!;
  if (stem === "_app" || stem === "_document" || stem === "_error") return null;
  const segs = rel
    .split("/")
    .map(nextSegment)
    .filter((s): s is string => s != null);
  if (segs.at(-1) === "index") segs.pop();
  return `/${segs.join("/")}`;
}

/* ------------------------------------------------------------------ */
/* Screens: react-router                                                */
/* ------------------------------------------------------------------ */

export interface RouterScreen {
  route: string;
  componentName?: string;
  line: number;
}

export interface RouterScreenOptions {
  /** Imported constant values (name → string) for `path={CONST}` resolution. */
  constants?: ReadonlyMap<string, string>;
  /** Receives path identifiers that resolved neither locally nor via `constants`. */
  unresolved?: Set<string>;
}

/**
 * Routes declared in one react-router file: JSX `<Route path element/Component>`
 * trees and route-object arrays passed to createBrowserRouter/useRoutes and
 * friends. Nested children join with their parent path; index routes take the
 * parent path. Parents that only group children (path but no element) are not
 * emitted themselves. `path` accepts string literals, identifiers (same-file
 * consts, then `opts.constants`), and template literals over both — an
 * unresolvable path degrades to a pathless layout route. Never throws — a
 * malformed file yields [].
 */
export function extractRouterScreens(
  fileRel: string,
  text: string,
  opts?: RouterScreenOptions,
): RouterScreen[] {
  try {
    return extractRouterScreensUnsafe(fileRel, text, opts);
  } catch {
    return [];
  }
}

function extractRouterScreensUnsafe(
  fileRel: string,
  text: string,
  opts?: RouterScreenOptions,
): RouterScreen[] {
  const source = createSource(fileRel, text);
  const out: RouterScreen[] = [];

  const localConsts = collectStringConsts(source);
  const lookup = (name: string): string | undefined =>
    localConsts.get(name) ?? opts?.constants?.get(name);
  const miss = opts?.unresolved ? (n: string): void => void opts.unresolved!.add(n) : undefined;
  const pathValue = (expr: ts.Expression): string | null =>
    resolveStringExpr(expr, lookup, miss);

  const tagText = (tag: ts.JsxTagNameExpression): string | null =>
    ts.isIdentifier(tag)
      ? tag.text
      : ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.name)
        ? tag.name.text
        : null;

  const componentNameOf = (expr: ts.Expression): string | undefined => {
    const e = unwrapExpression(expr);
    if (ts.isJsxElement(e)) return tagText(e.openingElement.tagName) ?? undefined;
    if (ts.isJsxSelfClosingElement(e)) return tagText(e.tagName) ?? undefined;
    if (ts.isIdentifier(e)) return e.text;
    return undefined;
  };

  const joinRoute = (parent: string, child: string): string => {
    if (child.startsWith("/")) return child.length > 1 ? child.replace(/\/+$/, "") : child;
    const base = parent === "/" ? "" : parent;
    const joined = child ? `${base}/${child}` : parent;
    return joined === "" ? "/" : joined;
  };

  const containsRouteTag = (n: ts.Node): boolean => {
    if (ts.isJsxElement(n) && tagText(n.openingElement.tagName) === "Route") return true;
    if (ts.isJsxSelfClosingElement(n) && tagText(n.tagName) === "Route") return true;
    return ts.forEachChild(n, containsRouteTag) ?? false;
  };

  // --- JSX: <Route path="…" element={<X/>}> nested <Route …/> ---
  const visitJsx = (node: ts.Node, parentPath: string): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (tagText(opening.tagName) === "Route") {
        let routePath: string | null = null;
        let isIndex = false;
        let componentName: string | undefined;
        for (const attr of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
          const name = attr.name.text;
          const init = attr.initializer;
          if (name === "path") {
            if (init && ts.isStringLiteral(init)) routePath = init.text;
            else if (init && ts.isJsxExpression(init) && init.expression) {
              routePath = pathValue(init.expression);
            }
          } else if (name === "index") {
            isIndex = true;
          } else if (name === "element" || name === "Component" || name === "component") {
            const expr = init && ts.isJsxExpression(init) ? init.expression : init;
            if (expr && !ts.isStringLiteral(expr)) {
              componentName = componentNameOf(expr) ?? componentName;
            }
          }
        }
        const children = ts.isJsxElement(node) ? [...node.children] : [];
        if (routePath != null || isIndex) {
          const full = joinRoute(parentPath, routePath ?? "");
          // A path with neither component nor child routes is still a screen
          // (catch-alls whose component didn't resolve stay listed).
          if (componentName || !children.some(containsRouteTag)) {
            out.push({ route: full, componentName, line: lineOf(source, node) });
          }
          for (const c of children) visitJsx(c, full);
        } else {
          // Pathless layout route: children keep the current prefix.
          for (const c of children) visitJsx(c, parentPath);
        }
        return;
      }
    }
    ts.forEachChild(node, (c) => visitJsx(c, parentPath));
  };

  // --- Object routes: createBrowserRouter([{ path, element, children }]) ---
  const visitRouteObject = (el: ts.Expression, parentPath: string): void => {
    const obj = unwrapExpression(el);
    if (!ts.isObjectLiteralExpression(obj)) return;
    let routePath: string | null = null;
    let isIndex = false;
    let componentName: string | undefined;
    let children: ts.ArrayLiteralExpression | null = null;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propName(prop.name);
      if (name === "path") routePath = pathValue(prop.initializer);
      else if (name === "index" && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) isIndex = true;
      else if (name === "element" || name === "Component" || name === "component") {
        componentName = componentNameOf(prop.initializer) ?? componentName;
      } else if (name === "children") {
        const arr = unwrapExpression(prop.initializer);
        if (ts.isArrayLiteralExpression(arr)) children = arr;
      }
    }
    const routed = routePath != null || isIndex;
    const full = routed ? joinRoute(parentPath, routePath ?? "") : parentPath;
    if (routed && (componentName || !children)) {
      out.push({ route: full, componentName, line: lineOf(source, obj) });
    }
    if (children) for (const c of children.elements) visitRouteObject(c, full);
  };

  const visitCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ROUTER_FACTORIES.has(node.expression.text)
    ) {
      const arg = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined;
      if (arg && ts.isArrayLiteralExpression(arg)) {
        for (const el of arg.elements) visitRouteObject(el, "");
      }
    }
    ts.forEachChild(node, visitCalls);
  };

  // Route tables declared as data (`const routes: RouteObject[] = […]`) and
  // handed to the factory in another file.
  const visitTypedRouteArrays = (): void => {
    for (const st of source.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (!decl.type || !decl.initializer) continue;
        if (!/\bRouteObject\b/.test(decl.type.getText(source))) continue;
        const init = unwrapExpression(decl.initializer);
        if (ts.isArrayLiteralExpression(init)) {
          for (const el of init.elements) visitRouteObject(el, "");
        }
      }
    }
  };

  visitJsx(source, "");
  visitCalls(source);
  visitTypedRouteArrays();
  return out;
}

/* ------------------------------------------------------------------ */
/* Stories (CSF)                                                        */
/* ------------------------------------------------------------------ */

export interface StoryFileParse {
  title?: string;
  componentName?: string;
  stories: { name: string; line: number }[];
}

/**
 * CSF shape of one story file: the default-export meta (inline object,
 * `export default meta` const, `satisfies Meta`/`as Meta` wrapped) and each
 * story-shaped named export. Never throws — a malformed file yields no stories.
 */
export function parseStoryFile(fileRel: string, text: string): StoryFileParse {
  try {
    return parseStoryFileUnsafe(fileRel, text);
  } catch {
    return { stories: [] };
  }
}

function parseStoryFileUnsafe(fileRel: string, text: string): StoryFileParse {
  const source = createSource(fileRel, text);
  const constInits = new Map<string, ts.Expression>();
  const candidates: { name: string; line: number }[] = [];
  let defaultExpr: ts.Expression | null = null;
  let defaultLocalName: string | null = null;

  for (const st of source.statements) {
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        if (decl.initializer) constInits.set(decl.name.text, decl.initializer);
        if (hasExportModifier(st)) {
          candidates.push({ name: decl.name.text, line: lineOf(source, decl) });
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && hasExportModifier(st) && !hasDefaultModifier(st)) {
      candidates.push({ name: st.name.text, line: lineOf(source, st) });
    } else if (ts.isExportAssignment(st)) {
      defaultExpr = st.expression;
    } else if (
      ts.isExportDeclaration(st) &&
      !st.moduleSpecifier &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === "default") defaultLocalName = (el.propertyName ?? el.name).text;
        else candidates.push({ name: el.name.text, line: lineOf(source, el) });
      }
    }
  }

  // Resolve the meta object: inline default export, or the named const it points at.
  let metaObj: ts.ObjectLiteralExpression | null = null;
  let metaConstName: string | null = defaultLocalName;
  if (defaultExpr) {
    const e = unwrapExpression(defaultExpr);
    if (ts.isIdentifier(e)) metaConstName = e.text;
    else if (ts.isObjectLiteralExpression(e)) metaObj = e;
  }
  if (!metaObj && metaConstName) {
    const init = constInits.get(metaConstName);
    if (init) {
      const e = unwrapExpression(init);
      if (ts.isObjectLiteralExpression(e)) metaObj = e;
    }
  }

  let title: string | undefined;
  let componentName: string | undefined;
  if (metaObj) {
    for (const prop of metaObj.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const name = propName(prop.name);
      if (name === "title") title = stringValue(prop.initializer) ?? title;
      else if (name === "component") {
        const e = unwrapExpression(prop.initializer);
        if (ts.isIdentifier(e)) componentName = e.text;
        else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) componentName = e.name.text;
      }
    }
  }

  const stories = candidates.filter(
    (c) => !NON_STORY_EXPORTS.has(c.name) && c.name !== metaConstName,
  );
  return { title, componentName, stories };
}

/* ------------------------------------------------------------------ */
/* Schemas                                                              */
/* ------------------------------------------------------------------ */

/**
 * Data schemas declared in one source file: top-level `z.object({...})`
 * consts, `new Schema({...})` mongoose consts, and — only in schema-ish paths
 * (model/schema/entit/dto/contract/types) — exported interfaces and
 * object-literal type aliases. `usedBy` is left 0 for the caller to fill.
 * Never throws — a malformed file yields [].
 */
export function extractSourceSchemas(fileRel: string, text: string): SchemaSurface[] {
  try {
    return extractSourceSchemasUnsafe(fileRel, text);
  } catch {
    return [];
  }
}

function extractSourceSchemasUnsafe(fileRel: string, text: string): SchemaSurface[] {
  const source = createSource(fileRel, text);
  const schemas: SchemaSurface[] = [];
  const gated = fileRel.split("/").some((seg) => SCHEMA_PATH_RE.test(seg));

  // Bindings for zod (`z`) and mongoose (`mongoose` namespace / named `Schema`).
  const zodBindings = new Set<string>();
  const mongooseNs = new Set<string>();
  const schemaBindings = new Set<string>();
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (!clause) continue;
    if (spec === "zod" || spec.startsWith("zod/")) {
      if (clause.name) zodBindings.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) zodBindings.add(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) zodBindings.add(el.name.text);
      }
    } else if (spec === "mongoose") {
      if (clause.name) mongooseNs.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) mongooseNs.add(clause.namedBindings.name.text);
        else {
          for (const el of clause.namedBindings.elements) {
            if ((el.propertyName ?? el.name).text === "Schema") schemaBindings.add(el.name.text);
          }
        }
      }
    }
  }

  /** The `{...}` argument of a `z.object({...})` call anywhere in a chain. */
  const zodObjectArg = (expr: ts.Expression): ts.ObjectLiteralExpression | null => {
    let e: ts.Expression = unwrapExpression(expr);
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const pa = e.expression;
      if (
        ts.isIdentifier(pa.expression) &&
        zodBindings.has(pa.expression.text) &&
        pa.name.text === "object"
      ) {
        const arg = e.arguments[0];
        return arg && ts.isObjectLiteralExpression(arg) ? arg : null;
      }
      e = pa.expression;
    }
    return null;
  };

  /** The `{...}` argument of `new Schema({...})` / `new mongoose.Schema({...})`. */
  const mongooseSchemaArg = (expr: ts.Expression): ts.ObjectLiteralExpression | null => {
    const e = unwrapExpression(expr);
    if (!ts.isNewExpression(e)) return null;
    const callee = e.expression;
    const isSchema =
      (ts.isIdentifier(callee) && schemaBindings.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        mongooseNs.has(callee.expression.text) &&
        callee.name.text === "Schema");
    if (!isSchema) return null;
    const arg = e.arguments?.[0];
    return arg && ts.isObjectLiteralExpression(arg) ? arg : null;
  };

  const objectLiteralFields = (
    obj: ts.ObjectLiteralExpression,
    zodOptional: boolean,
  ): { fields: SchemaField[]; truncated: boolean } => {
    const fields: SchemaField[] = [];
    let truncated = false;
    for (const prop of obj.properties) {
      let name: string | null = null;
      let type: string | undefined;
      let optional = false;
      if (ts.isPropertyAssignment(prop)) {
        name = propName(prop.name);
        const raw = prop.initializer.getText(source);
        type = compactType(raw);
        optional = zodOptional && /\.optional\s*\(/.test(raw);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        name = prop.name.text;
      } else {
        continue;
      }
      if (!name) continue;
      if (fields.length >= MAX_SCHEMA_FIELDS) {
        truncated = true;
        break;
      }
      fields.push({ name, ...(type ? { type } : {}), ...(optional ? { optional: true } : {}) });
    }
    return { fields, truncated };
  };

  const memberFields = (
    members: ts.NodeArray<ts.TypeElement>,
  ): { fields: SchemaField[]; truncated: boolean } => {
    const fields: SchemaField[] = [];
    let truncated = false;
    for (const member of members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = propName(member.name);
      if (!name) continue;
      if (fields.length >= MAX_SCHEMA_FIELDS) {
        truncated = true;
        break;
      }
      fields.push({
        name,
        ...(member.type ? { type: compactType(member.type.getText(source)) } : {}),
        ...(member.questionToken ? { optional: true } : {}),
      });
    }
    return { fields, truncated };
  };

  const push = (
    name: string,
    line: number,
    kind: SchemaKind,
    f: { fields: SchemaField[]; truncated: boolean },
  ): void => {
    schemas.push({
      id: `${fileRel}#${name}`,
      name,
      file: fileRel,
      line,
      kind,
      fields: f.fields,
      ...(f.truncated ? { fieldsTruncated: true } : {}),
      usedBy: 0,
    });
  };

  for (const st of source.statements) {
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const zodObj = zodObjectArg(decl.initializer);
        if (zodObj) {
          push(decl.name.text, lineOf(source, decl), "zod", objectLiteralFields(zodObj, true));
          continue;
        }
        const mgObj = mongooseSchemaArg(decl.initializer);
        if (mgObj) {
          push(decl.name.text, lineOf(source, decl), "mongoose", objectLiteralFields(mgObj, false));
        }
      }
    } else if (ts.isInterfaceDeclaration(st) && gated && hasExportModifier(st)) {
      push(st.name.text, lineOf(source, st), "interface", memberFields(st.members));
    } else if (
      ts.isTypeAliasDeclaration(st) &&
      gated &&
      hasExportModifier(st) &&
      ts.isTypeLiteralNode(st.type)
    ) {
      push(st.name.text, lineOf(source, st), "type", memberFields(st.type.members));
    }
  }
  return schemas;
}

/** Line-based parse of a prisma schema's `model X { field Type … }` blocks. */
export function parsePrismaSchema(fileRel: string, text: string): SchemaSurface[] {
  const out: SchemaSurface[] = [];
  let current: SchemaSurface | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!current) {
      const m = /^model\s+([A-Za-z_]\w*)\s*\{/.exec(line);
      if (m) {
        current = {
          id: `${fileRel}#${m[1]}`,
          name: m[1]!,
          file: fileRel,
          line: i + 1,
          kind: "prisma",
          fields: [],
          usedBy: 0,
        };
        out.push(current);
      }
      continue;
    }
    if (line.startsWith("}")) {
      current = null;
      continue;
    }
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const f = /^([A-Za-z_]\w*)\s+(\S+)/.exec(line);
    if (!f) continue;
    if (current.fields.length >= MAX_SCHEMA_FIELDS) {
      current.fieldsTruncated = true;
      continue;
    }
    const rawType = f[2]!;
    const optional = rawType.endsWith("?");
    current.fields.push({
      name: f[1]!,
      type: optional ? rawType.slice(0, -1) : rawType,
      ...(optional ? { optional: true } : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Demo targets                                                         */
/* ------------------------------------------------------------------ */

/** Dev-server / storybook base URLs inferred from package.json scripts. */
export function demoTargetsFromScripts(scripts: Record<string, unknown>): DemoTargets {
  const portOf = (cmd: string, flags: RegExp, fallback: number): number => {
    const m = flags.exec(cmd);
    return m ? Number(m[1]) : fallback;
  };

  let storybookUrl: string | null = null;
  for (const cmd of Object.values(scripts)) {
    if (typeof cmd !== "string") continue;
    const isServe =
      (cmd.includes("storybook dev") || cmd.trim().startsWith("storybook")) &&
      !cmd.includes("storybook build");
    if (!isServe) continue;
    const port = portOf(cmd, /(?:^|\s)(?:-p|--port)[ =](\d+)/, 6006);
    storybookUrl = `http://localhost:${port}`;
    break;
  }

  let appUrl: string | null = null;
  for (const key of ["dev", "start"]) {
    const cmd = scripts[key];
    if (typeof cmd !== "string") continue;
    if (/\bvite\b/.test(cmd)) {
      appUrl = `http://localhost:${portOf(cmd, /--port[ =](\d+)/, 5173)}`;
    } else if (/\bnext dev\b/.test(cmd)) {
      appUrl = `http://localhost:${portOf(cmd, /(?:^|\s)(?:-p|--port)[ =](\d+)/, 3000)}`;
    } else if (cmd.includes("react-scripts start")) {
      appUrl = "http://localhost:3000";
    } else if (/\bastro dev\b/.test(cmd)) {
      appUrl = "http://localhost:4321";
    }
    if (appUrl) break;
  }

  return { appUrl, storybookUrl };
}

/* ------------------------------------------------------------------ */
/* Router mount composition                                             */
/* ------------------------------------------------------------------ */

/** Join a mount prefix and a route sub-path into one URL path. */
export function joinMountedPath(prefix: string, sub: string): string {
  const a = prefix === "/" ? "" : prefix.replace(/\/+$/, "");
  if (!a) return sub;
  return sub === "/" ? a : `${a}${sub}`;
}

/**
 * Full URL prefix per route file, composed through the (transitive) chain of
 * `app.use("/prefix", router)` mounts. First mounter wins when a router is
 * mounted twice; cycles fall back to no prefix. Files that aren't mounted
 * anywhere are absent from the map.
 */
export function computeMountPrefixes(
  records: Iterable<{ path: string; resolvedMounts?: { prefix: string; resolved: string }[] }>,
): Map<string, string> {
  const mountedBy = new Map<string, { prefix: string; mounter: string }>();
  for (const rec of records) {
    for (const m of rec.resolvedMounts ?? []) {
      if (m.resolved !== rec.path && !mountedBy.has(m.resolved)) {
        mountedBy.set(m.resolved, { prefix: m.prefix, mounter: rec.path });
      }
    }
  }
  const memo = new Map<string, string>();
  const prefixOf = (file: string, seen: Set<string>): string => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    if (seen.has(file)) return "";
    seen.add(file);
    const mount = mountedBy.get(file);
    const prefix = mount ? joinMountedPath(prefixOf(mount.mounter, seen), mount.prefix) : "";
    memo.set(file, prefix === "/" ? "" : prefix);
    return memo.get(file)!;
  };
  const out = new Map<string, string>();
  for (const file of mountedBy.keys()) {
    const prefix = prefixOf(file, new Set());
    if (prefix) out.set(file, prefix);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Report builder                                                       */
/* ------------------------------------------------------------------ */

function kebabCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** File declaring `name` as seen from `rec`: its own top level, else its imports. */
function resolveComponentFile(rec: SurfaceSourceRecord, name: string): string | undefined {
  if (rec.symbols.some((s) => s.name === name)) return rec.path;
  for (const imp of rec.resolvedImports) {
    if (imp.resolved && imp.names.includes(name)) return imp.resolved;
  }
  return undefined;
}

/**
 * Assemble the full surfaces report from the analyzer's per-file parse data.
 * `root` is only used for targeted re-reads (router/story/schema files,
 * package.json, prisma schema); all paths in the report stay workspace-relative.
 */
export async function buildSurfacesReport(
  root: string,
  records: ReadonlyMap<string, SurfaceSourceRecord>,
  importedBy: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SurfacesReport> {
  const paths = [...records.keys()].sort();
  const usedByOf = (p: string): number => importedBy.get(p)?.size ?? 0;
  const readText = async (rel: string): Promise<string | null> => {
    try {
      return await fs.readFile(resolveInRoot(root, rel), "utf8");
    } catch {
      return null;
    }
  };

  /* ---------------- screens ---------------- */
  const screens: ScreenSurface[] = [];
  const seenScreens = new Set<string>();
  const pushScreen = (screen: ScreenSurface): void => {
    if (seenScreens.has(screen.id)) return;
    seenScreens.add(screen.id);
    screens.push(screen);
  };

  // Next file conventions only mean routes when the owning package actually
  // uses next (dependency or next scripts) — a Vite app's src/pages/ is just
  // a directory name.
  const nextCache = new Map<string, boolean | null>();
  const dependsOnNext = async (fileRel: string): Promise<boolean> => {
    let dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : ".";
    for (;;) {
      let usesNext = nextCache.get(dir);
      if (usesNext === undefined) {
        const text = await readText(dir === "." ? "package.json" : `${dir}/package.json`);
        usesNext = null;
        if (text != null) {
          try {
            const pkg = JSON.parse(text) as {
              dependencies?: Record<string, unknown>;
              devDependencies?: Record<string, unknown>;
              scripts?: Record<string, unknown>;
            };
            usesNext =
              "next" in (pkg.dependencies ?? {}) ||
              "next" in (pkg.devDependencies ?? {}) ||
              Object.values(pkg.scripts ?? {}).some(
                (s) => typeof s === "string" && /\bnext\s+(dev|build|start)\b/.test(s),
              );
          } catch {
            /* unparseable package.json — keep walking up */
          }
        }
        nextCache.set(dir, usesNext);
      }
      if (usesNext !== null) return usesNext; // the nearest package.json decides
      if (dir === ".") return false;
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
    }
  };

  for (const p of paths) {
    if (isTestPath(p) || isStoryPath(p)) continue;
    const rec = records.get(p)!;
    const defaultExport = rec.exports.find((e) => e.kind === "default" && e.name !== "default");
    const nextish = (route: string, source: "next-app" | "next-pages"): ScreenSurface => ({
      id: `${source}:${route}`,
      route,
      file: p,
      ...(defaultExport ? { line: defaultExport.line, component: defaultExport.name } : {}),
      source,
    });
    const appRoute = nextAppRoute(p);
    if (appRoute != null) {
      if (await dependsOnNext(p)) pushScreen(nextish(appRoute, "next-app"));
      continue;
    }
    const pagesRoute = nextPagesRoute(p);
    if (pagesRoute != null && (await dependsOnNext(p))) pushScreen(nextish(pagesRoute, "next-pages"));
  }

  // Route constants imported from shared modules (`path={ADMIN_ROUTE}`): a
  // first pass records the identifiers the router file couldn't resolve, then
  // only the files exporting those names are read for their string consts.
  const constFileCache = new Map<string, Map<string, string> | null>();
  const importedRouteConsts = async (
    rec: SurfaceSourceRecord,
    wanted: ReadonlySet<string>,
  ): Promise<Map<string, string>> => {
    const constants = new Map<string, string>();
    for (const imp of rec.resolvedImports) {
      if (!imp.resolved || !imp.names.some((n) => wanted.has(n))) continue;
      let consts = constFileCache.get(imp.resolved);
      if (consts === undefined) {
        const constText = await readText(imp.resolved);
        consts = constText != null ? extractStringConsts(imp.resolved, constText) : null;
        constFileCache.set(imp.resolved, consts);
      }
      if (!consts) continue;
      for (const n of imp.names) {
        const value = consts.get(n);
        if (value !== undefined && wanted.has(n)) constants.set(n, value);
      }
    }
    return constants;
  };

  for (const p of paths) {
    if (isTestPath(p) || isStoryPath(p)) continue;
    const rec = records.get(p)!;
    if (!rec.resolvedImports.some((i) => ROUTER_SPECIFIERS.has(i.specifier))) continue;
    const text = await readText(p);
    if (text == null) continue;
    const unresolved = new Set<string>();
    let raws = extractRouterScreens(p, text, { unresolved });
    if (unresolved.size > 0) {
      const constants = await importedRouteConsts(rec, unresolved);
      if (constants.size > 0) raws = extractRouterScreens(p, text, { constants });
    }
    for (const raw of raws) {
      const componentFile = raw.componentName
        ? resolveComponentFile(rec, raw.componentName)
        : undefined;
      pushScreen({
        id: `react-router:${raw.route}`,
        route: raw.route,
        file: p,
        line: raw.line,
        ...(raw.componentName ? { component: raw.componentName } : {}),
        ...(componentFile ? { componentFile } : {}),
        source: "react-router",
      });
    }
  }

  // Convention fallback: only when no router/framework screens were detected.
  if (screens.length === 0) {
    for (const p of paths) {
      if (isTestPath(p) || isStoryPath(p)) continue;
      if (!/(^|\/)(pages|screens|views)\//.test(p)) continue;
      const rec = records.get(p)!;
      const comp = rec.symbols.find((s) => s.exported && s.kind === "component");
      if (!comp) continue;
      const stem = p.split("/").at(-1)!.replace(/\.[jt]sx?$/, "");
      const route = stem === "index" ? "/" : `/${kebabCase(stem)}`;
      pushScreen({
        id: `convention:${route}`,
        route,
        file: p,
        line: comp.line,
        component: comp.name,
        source: "convention",
      });
    }
  }
  screens.sort((a, b) => a.route.localeCompare(b.route) || a.id.localeCompare(b.id));

  /* ---------------- stories ---------------- */
  const stories: StorySurface[] = [];
  for (const p of paths) {
    if (!isStoryPath(p)) continue;
    const rec = records.get(p)!;
    const text = await readText(p);
    if (text == null) continue;
    const parsed = parseStoryFile(p, text);
    const stem = p.split("/").at(-1)!.replace(STORY_FILE_RE, "");
    const title = parsed.title ?? parsed.componentName ?? stem;
    const componentFile = parsed.componentName
      ? resolveComponentFile(rec, parsed.componentName)
      : undefined;
    for (const story of parsed.stories) {
      stories.push({
        id: `${p}#${story.name}`,
        title,
        name: story.name,
        file: p,
        line: story.line,
        ...(parsed.componentName ? { componentName: parsed.componentName } : {}),
        ...(componentFile ? { componentFile } : {}),
      });
    }
  }

  /* ---------------- components ---------------- */
  const components: ComponentSurface[] = [];
  for (const p of paths) {
    if (isTestPath(p) || isStoryPath(p)) continue;
    const rec = records.get(p)!;
    const seen = new Set<string>();
    for (const sym of rec.symbols) {
      if (!sym.exported || sym.kind !== "component" || seen.has(sym.name)) continue;
      seen.add(sym.name);
      const signature = rec.exports.find((e) => e.name === sym.name)?.signature;
      components.push({
        name: sym.name,
        file: p,
        line: sym.line,
        endLine: sym.endLine,
        ...(signature ? { signature } : {}),
        usedBy: usedByOf(p),
        stories: stories
          .filter((s) => s.componentFile === p && s.componentName === sym.name)
          .map((s) => s.id),
        screens: screens
          .filter((s) => s.component === sym.name && (s.componentFile ?? s.file) === p)
          .map((s) => s.id),
      });
    }
  }
  components.sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));

  /* ---------------- endpoints ---------------- */
  // Dedup by method+path, first declaring file wins (same convention as the
  // systems overview's per-system endpoint dedup). Test files exercise
  // endpoints, they don't serve them.
  const prefixes = computeMountPrefixes(records.values());
  const endpointMap = new Map<string, SystemEndpoint>();
  for (const p of paths) {
    if (isTestPath(p)) continue;
    const prefix = prefixes.get(p) ?? "";
    for (const ep of records.get(p)!.endpoints) {
      const full = prefix ? joinMountedPath(prefix, ep.path) : ep.path;
      const key = `${ep.method} ${full}`;
      if (!endpointMap.has(key)) endpointMap.set(key, { ...ep, path: full, file: p });
    }
  }
  const endpoints = [...endpointMap.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  /* ---------------- schemas ---------------- */
  const schemas: SchemaSurface[] = [];
  for (const p of paths) {
    if (isTestPath(p) || isStoryPath(p)) continue;
    const rec = records.get(p)!;
    const hasZod = rec.resolvedImports.some(
      (i) => i.specifier === "zod" || i.specifier.startsWith("zod/"),
    );
    const hasMongoose = rec.resolvedImports.some((i) => i.specifier === "mongoose");
    const gated = p.split("/").some((seg) => SCHEMA_PATH_RE.test(seg));
    if (!hasZod && !hasMongoose && !gated) continue;
    const text = await readText(p);
    if (text == null) continue;
    for (const schema of extractSourceSchemas(p, text)) {
      schemas.push({ ...schema, usedBy: usedByOf(p) });
    }
  }
  for (const rel of ["prisma/schema.prisma", "schema.prisma"]) {
    const text = await readText(rel);
    if (text != null) {
      schemas.push(...parsePrismaSchema(rel, text));
      break;
    }
  }
  schemas.sort((a, b) => b.usedBy - a.usedBy || a.name.localeCompare(b.name));

  /* ---------------- demo ---------------- */
  let demo: DemoTargets = { appUrl: null, storybookUrl: null };
  const pkgText = await readText("package.json");
  if (pkgText != null) {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
      if (pkg && typeof pkg.scripts === "object" && pkg.scripts) {
        demo = demoTargetsFromScripts(pkg.scripts);
      }
    } catch {
      /* unparseable package.json — no demo targets */
    }
  }

  return {
    screens,
    components,
    stories,
    endpoints,
    schemas,
    demo,
    generatedAt: new Date().toISOString(),
  };
}

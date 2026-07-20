import type { CodeIndex } from "./code-index.js";
import {
  CONCEPT_LEXICON,
  conceptDisplayName,
  evidenceStem,
  identifierWords,
  type ConceptDef,
} from "./code-index.js";
import type { CodeSymbolKind } from "./codemap.js";
import type { EndpointValidation } from "./endpoint-validation.js";
import { classifyExternalPackage, isPlatformImport } from "./external-services.js";
import { tagDimension, tagValue } from "./tags.js";

/**
 * System overview — the codebase projected as *logical* architecture modules
 * (authentication, submission, external integrations…) rather than language
 * packages. Where the code map answers "what directories/packages exist and
 * which files import which", this answers the architect's questions:
 *
 *   1. what systems exist            → `SystemModule` (clustered units)
 *   2. what each one exports         → `SystemModule.exports` (consumed API)
 *   3. what each one consumes        → `links` (per pair) + `externals`
 *   4. how systems interact          → `SystemLink` (weighted, with symbols)
 *
 * Clustering is evidence-based and deterministic:
 *
 *  - *structural units* — directory subtrees inside each package, split at
 *    collection dirs (`modules/`, `features/`, `services/`…) and transparent
 *    wrappers (`src/`, `app/`). A DDD-ish tree (`src/auth`, `src/billing`)
 *    and a conventional one (`modules/auth`) both yield one unit per domain
 *    dir; a monolith with no such structure degrades to one unit per package
 *    (the honest fallback — no fake subsystems).
 *  - *semantic merge* — units are fused into one logical system when they
 *    share a name (`features/auth` + `modules/auth`, across packages) or a
 *    dominant `intent:` concept from the code index (heuristic + symbolic +
 *    agent tags). The index refines the structure; it never invents units.
 *
 * Pure and deterministic: same (sources, index) → same overview. The caller
 * stamps `generatedAt`.
 */

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/** What the builder needs to know about one source file. */
export interface OverviewSourceFile {
  /** Workspace-relative path. */
  path: string;
  /** Owning code-map module (package) path — "." at the workspace root. */
  pkg: string;
  /** Display name of the owning package (used to name root-level residuals). */
  pkgName?: string;
  /** Test files are excluded from clustering and edge weights. */
  test?: boolean;
  imports: {
    /** Import specifier as written. */
    specifier: string;
    /** Workspace-relative resolved file when internal, null when external. */
    resolved: string | null;
    /** Imported names ("default" / "*" included). */
    names: string[];
  }[];
  exports: { name: string; kind: CodeSymbolKind; signature?: string }[];
  /** HTTP routes this file serves (`app.get("/x")`, Next route files…). */
  endpoints?: HttpEndpoint[];
  /** Outgoing HTTP calls this file makes (`fetch("/x")`, `axios.post`…). */
  apiCalls?: HttpEndpoint[];
  /** React component names declared in this file (exported or not). */
  components?: string[];
}

/**
 * Canonical endpoint identity: `"METHOD path"`. Every producer and consumer
 * of endpoint keys — system cards, map edges, `ep:` deep links, the API
 * explorer's selection — must build the key through here so the projections
 * can't drift apart on normalization.
 */
export function endpointKey(ep: { method: string; path: string }): string {
  return `${ep.method} ${ep.path}`;
}

/** One HTTP surface point — a served route or an outgoing call. */
export interface HttpEndpoint {
  /** Upper-case verb; "ALL" when the handler catches every method. */
  method: string;
  /** Path as written ("/api/users/:id"); template holes appear as "*". */
  path: string;
  /** 1-based line of the registration/call in its file, when known. */
  line?: number;
  /**
   * Handler expression at the registration ("listForms",
   * "FormController.createForm") — the trace root for served routes.
   */
  handler?: string;
  /**
   * Request validation detected at the registration — middleware chain
   * (celebrate, express-validator, zod wrappers) plus in-handler schema
   * parses. Absent for outgoing calls; empty means "none detected".
   */
  validation?: EndpointValidation[];
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export const SYSTEM_ROLES = ["domain", "integration", "shared", "entry", "data"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/**
 * Architectural layer — the coarse frontend / backend / database /
 * dependencies-and-integrations split the systems view can group by.
 * Derived from role + file-extension evidence, never persisted.
 */
export const SYSTEM_LAYERS = ["frontend", "backend", "database", "integrations"] as const;
export type SystemLayer = (typeof SYSTEM_LAYERS)[number];

export const SYSTEM_LAYER_LABELS: Record<SystemLayer, string> = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  integrations: "Dependencies & integrations",
};

/** One structural unit (directory subtree) contributing to a system. */
export interface SystemPart {
  /** Workspace-relative directory path of the unit. */
  path: string;
  /** Owning package (code-map module path). */
  pkg: string;
  fileCount: number;
}

/** An exported symbol that code outside the system actually imports. */
export interface SystemExport {
  name: string;
  kind: CodeSymbolKind;
  /** File declaring the export. */
  file: string;
  /** Distinct outside files importing it. */
  consumers: number;
  /** Declaration signature when the export is function-like. */
  signature?: string;
}

/** An HTTP route a system serves, with the file declaring it. */
export interface SystemEndpoint extends HttpEndpoint {
  file: string;
}

/** A React component a (frontend) system declares. */
export interface SystemComponent {
  name: string;
  /** File declaring the component. */
  file: string;
  /** Distinct outside files importing it (0 for system-local components). */
  consumers: number;
}

/** An external service the system talks to (see external-services.ts). */
export interface SystemExternal {
  /** Stable service id ("stripe", "mongodb"…). */
  id: string;
  name: string;
  /** Import statements across the system's files. */
  weight: number;
}

/** An import edge between two parts of the same system. */
export interface SystemPartLink {
  /** Source part path (see SystemPart.path). */
  source: string;
  /** Target part path. */
  target: string;
  /** Import statements crossing between the parts. */
  weight: number;
}

export interface SystemModule {
  /** Stable id derived from the cluster key, e.g. "sys:auth". */
  id: string;
  /** Display name, e.g. "Authentication" or "Submission". */
  name: string;
  /** Dominant intent concept when the cluster is tag-driven, else null. */
  concept: string | null;
  role: SystemRole;
  /** Coarse architectural layer (frontend / backend / database / integrations). */
  layer: SystemLayer;
  parts: SystemPart[];
  fileCount: number;
  /** Intent profile, heaviest first (for chips/inspection). */
  intents: { value: string; weight: number }[];
  /** Externally-consumed exports, most-consumed first (capped). */
  exports: SystemExport[];
  /** Total exported symbols across the system's files. */
  exportedTotal: number;
  /** External services consumed, heaviest first (capped). */
  externals: SystemExternal[];
  /** Plain libraries leaned on (not services), heaviest first (capped). */
  libraries: { pkg: string; weight: number }[];
  /** HTTP routes served, heaviest declaring file first (capped). */
  endpoints: SystemEndpoint[];
  /** React components declared, most-consumed first (capped). */
  components: SystemComponent[];
  /** Total React components across the system's files (beyond the cap). */
  componentCount: number;
  /** Intra-system imports between parts, heaviest first (capped). Absent when nothing crosses. */
  partLinks?: SystemPartLink[];
}

/** One symbol crossing a link, with what is known about its shape. */
export interface SystemLinkSymbol {
  name: string;
  kind: CodeSymbolKind;
  /** Import statements bringing this name across the edge. */
  count: number;
  /** Declaration signature when the target export is function-like. */
  signature?: string;
  /** File declaring the symbol inside the target system (through barrels). */
  file?: string;
}

/** A directed "consumes" edge: source imports from target. */
export interface SystemLink {
  source: string;
  target: string;
  /** File-level import statements crossing the boundary. Zero for API-only links. */
  weight: number;
  /** Most-imported symbol names along this edge (capped). */
  symbols: string[];
  /** Per-symbol detail (kind, signature) aligned with `symbols`. */
  details?: SystemLinkSymbol[];
  /** HTTP calls from source matched to routes served by target (capped). */
  apis?: (HttpEndpoint & { weight: number })[];
  /** Cross-boundary imports attributed to (source part → target part) pairs, heaviest first (capped). */
  parts?: { sourcePart: string; targetPart: string; weight: number }[];
}

export interface SystemOverview {
  systems: SystemModule[];
  links: SystemLink[];
  /** Non-test files covered by the overview. */
  fileTotal: number;
  /** ISO timestamp; informational only (stamped by the server). */
  generatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Directories whose children are candidate units, not units themselves. */
const COLLECTION_DIRS = new Set([
  "modules", "features", "domains", "services", "apps", "packages", "libs", "plugins",
]);
/** Wrapper directories that never name a unit — walk straight through. */
const TRANSPARENT_DIRS = new Set(["src", "app", "source"]);
/** Units smaller than this fold into their parent's residual unit. */
const UNIT_MIN_FILES = 2;
/** A tag-dominant concept needs this share of a unit's intent weight to cluster by it. */
const CONCEPT_MERGE_SHARE = 0.75;
/** …and at least this much absolute weight. */
const CONCEPT_MERGE_WEIGHT = 3;
/** Name lists for role detection. */
const SHARED_NAMES = new Set([
  "shared", "common", "utils", "util", "helpers", "lib", "types", "constants",
  "config", "ui", "design-system",
]);
/**
 * Top-level dirs holding self-contained sample codebases. Units inside one
 * are scoped to it: a fixture's "core" must never fuse with the host repo's
 * core (or with another fixture's) just because the names match.
 */
const FIXTURE_DIRS = new Set(["examples", "example", "fixtures", "__fixtures__", "samples", "demos", "testdata"]);
const ENTRY_NAMES = new Set(["routes", "pages", "views", "main", "cli", "bin", "scripts", "loaders", "bootstrap"]);
const INTEGRATION_NAMES = new Set(["integrations", "external", "webhooks"]);
/**
 * Presentation/support directories that are structural by nature: they never
 * merge into a domain concept, however their tag mass leans (a `components/`
 * tree full of email widgets is still the component library, not the
 * notifications system).
 */
const STRUCTURAL_NAMES = new Set([
  "components", "pages", "views", "templates", "hooks", "assets", "theme",
  "styles", "icons", "stories", "mocks", "i18n",
]);
/**
 * A structural dir only becomes its own system inside a package of at least
 * this many files. A 14-file React app is one system, not four — splitting
 * its components/ and hooks/ out manufactures cycles ("App imports its own
 * pages") that no reviewer should be shown.
 */
const STRUCTURAL_SPLIT_MIN_PKG_FILES = 30;
/** Fraction of files importing a SaaS-ish external service that marks an integration unit. */
const INTEGRATION_FILE_SHARE = 0.5;
/** Fraction of files importing a database/cache client that marks a data-layer unit. */
const DATA_FILE_SHARE = 0.5;
/** A system consumed by this share of the others (≥3) plays a shared/platform role. */
const SHARED_FAN_IN_SHARE = 0.6;
const EXPORTS_CAP = 40;
const EXTERNALS_CAP = 12;
const LIBRARIES_CAP = 6;
const LINK_SYMBOLS_CAP = 12;
const LINK_APIS_CAP = 10;
const LINK_PARTS_CAP = 16;
const PART_LINKS_CAP = 40;
const ENDPOINTS_CAP = 24;
const COMPONENTS_CAP = 12;
const INTENTS_CAP = 5;
/** Names that assert a frontend unit regardless of tag mass. */
const FRONTEND_NAMES = new Set([
  "ui", "web", "client", "frontend", "www", "site", "browser", "components",
  "pages", "views", "design-system",
]);
/** Files whose extension marks UI code. */
const UI_FILE_RE = /\.(tsx|jsx|vue|svelte|astro|css|scss|less)$/;

/** Packages whose import marks a workspace as serving HTTP (has a backend). */
const SERVER_FRAMEWORK_PKGS = new Set([
  "express", "fastify", "koa", "@koa/router", "hono", "restify", "@hapi/hapi",
  "polka", "itty-router", "next", "@nestjs/core", "@nestjs/common",
]);
/** Path segments that claim server-side code even without framework imports. */
const SERVERISH_PATH_RE = /(^|\/)(api|server|backend|functions|lambda|worker)s?(\/|$)/i;
/** Share of UI-extension files that classifies a system as frontend. */
const FRONTEND_FILE_SHARE = 0.3;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** npm package name of an external specifier ("@scope/pkg/sub" → "@scope/pkg"). */
export function npmPackageOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) return null;
  const clean = specifier.startsWith("node:") ? null : specifier;
  if (!clean) return null;
  const parts = clean.split("/");
  if (clean.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

/** Join/split separator for aggregation keys — NUL never appears in ids or paths. */
const SEP = String.fromCharCode(0);

const lastSegment = (dir: string): string => dir.split("/").at(-1) ?? dir;

/** Merge key for a unit name: lowercase, naive singular so "forms" ≡ "form". */
function nameKeyOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.length > 3 && lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

/** "admin-form" → "Admin form". */
function titleCase(name: string): string {
  const words = name.replace(/[-_.]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

/** Fixture scope of a unit path ("examples/harborview"), or "" for the main tree. */
function fixtureScopeOf(unitPath: string): string {
  const [first, second] = unitPath.split("/");
  return first && second && FIXTURE_DIRS.has(first) ? `${first}/${second}` : "";
}

/**
 * Whether a workspace-relative path lives inside a self-contained sample
 * codebase (`examples/…`, `fixtures/…`). The overview keeps fixture units
 * scope-partitioned; product-level views (the system map) hide them outright —
 * a fixture's screens and systems are someone else's product.
 */
export function isFixtureScopedPath(path: string): boolean {
  return fixtureScopeOf(path) !== "";
}

/**
 * Route path → matchable segments. Parameter segments in any convention
 * (`:id`, `{id}`, `[id]`, `*`, template holes) normalize to "*"; full URLs
 * are reduced to their pathname so `fetch("https://api.x.com/v1/users")`
 * still matches a served `/v1/users`.
 */
export function routeSegments(path: string): string[] {
  let p = path.trim();
  const url = /^https?:\/\/[^/]+(\/.*)?$/i.exec(p);
  if (url) p = url[1] ?? "/";
  p = p.split(/[?#]/, 1)[0] ?? p;
  return p
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      /^[:{[*]/.test(seg) || seg.includes("*") || seg.includes("${") ? "*" : seg.toLowerCase(),
    );
}

/** Do a call path and a served route path address the same resource? */
export function routesMatch(call: string[], served: string[]): boolean {
  if (call.length !== served.length) return false;
  return call.every((seg, i) => seg === "*" || served[i] === "*" || seg === served[i]);
}

/**
 * Like `routesMatch`, but the served route may match a *suffix* of the call —
 * nested routers (`app.use("/api/v3", router)` … `router.get("/forms")`) only
 * ever register the tail of the mounted path, so the file-level route can't
 * know the caller's full prefix. Shorter-than-call matches require at least
 * one literal segment so "/:id"-style catch-alls don't swallow every call.
 */
export function routesMatchSuffix(call: string[], served: string[]): boolean {
  if (served.length === call.length) return routesMatch(call, served);
  if (served.length === 0 || served.length > call.length) return false;
  if (!served.some((seg) => seg !== "*")) return false;
  return routesMatch(call.slice(call.length - served.length), served);
}

/**
 * Best served route for one outgoing HTTP call. An exact-length match beats a
 * suffix match, then the longest (and most literal) served route —
 * "/:formId/fields" over "/:formId" for a call to /api/v3/admin/forms/1/fields.
 * Candidates carry pre-split `segs` (via `routeSegments`); `skip` excludes
 * routes that must not match (e.g. ones served by the calling system).
 */
export function bestServedRoute<T extends { method: string; segs: readonly string[] }>(
  call: { method: string; path: string },
  served: readonly T[],
  skip?: (route: T) => boolean,
): T | null {
  const segs = routeSegments(call.path);
  if (segs.length === 0) return null;
  let hit: T | null = null;
  let hitScore = -1;
  for (const r of served) {
    if (skip?.(r)) continue;
    if (!(r.method === "ALL" || call.method === "ALL" || r.method === call.method)) continue;
    if (!routesMatchSuffix(segs, [...r.segs])) continue;
    const literals = r.segs.filter((seg) => seg !== "*").length;
    const score = (r.segs.length === segs.length ? 1000 : 0) + r.segs.length * 10 + literals;
    if (score > hitScore) {
      hit = r;
      hitScore = score;
    }
  }
  return hit;
}

/* ------------------------------------------------------------------ */
/* Stage A — structural units                                          */
/* ------------------------------------------------------------------ */

interface Unit {
  /** Directory path of the unit (workspace-relative; pkg root for residuals). */
  path: string;
  /** Display-ish name: last meaningful path segment (pkg name for residuals). */
  name: string;
  pkg: string;
  files: OverviewSourceFile[];
}

interface DirNode {
  files: OverviewSourceFile[];
  children: Map<string, DirNode>;
  total: number;
}

function buildDirTree(files: readonly OverviewSourceFile[], pkgPath: string): DirNode {
  const root: DirNode = { files: [], children: new Map(), total: 0 };
  const prefix = pkgPath === "." ? "" : `${pkgPath}/`;
  for (const file of files) {
    const rel = prefix ? file.path.slice(prefix.length) : file.path;
    const segments = rel.split("/");
    let node = root;
    node.total += 1;
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment);
      if (!child) node.children.set(segment, (child = { files: [], children: new Map(), total: 0 }));
      node = child;
      node.total += 1;
    }
    node.files.push(file);
  }
  return root;
}

/**
 * Split one package into units. Recursion descends only through the package
 * root, transparent wrappers and collection dirs; every other directory is a
 * unit (whole subtree). Direct files of a split level pool into a residual
 * unit named for the package.
 */
function unitsOfPackage(pkgPath: string, pkgFiles: readonly OverviewSourceFile[]): Unit[] {
  const sorted = [...pkgFiles].sort((a, b) => a.path.localeCompare(b.path));
  const tree = buildDirTree(sorted, pkgPath);
  // Residuals are named for the package: its directory, or (at the workspace
  // root, where there is no directory to speak of) its declared name.
  const pkgName =
    pkgPath === "."
      ? lastSegment(pkgFiles[0]?.pkgName ?? "root")
      : lastSegment(pkgPath);
  const units: Unit[] = [];
  const residual: OverviewSourceFile[] = [];

  const collect = (node: DirNode, dirRel: string, split: boolean): void => {
    if (!split) {
      const all: OverviewSourceFile[] = [];
      const gather = (n: DirNode): void => {
        all.push(...n.files);
        for (const child of n.children.values()) gather(child);
      };
      gather(node);
      const dirPath = pkgPath === "." ? dirRel : dirRel ? `${pkgPath}/${dirRel}` : pkgPath;
      units.push({ path: dirPath, name: lastSegment(dirRel), pkg: pkgPath, files: all });
      return;
    }
    residual.push(...node.files);
    for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const childRel = dirRel ? `${dirRel}/${name}` : name;
      const descend = TRANSPARENT_DIRS.has(name) || COLLECTION_DIRS.has(name);
      collect(child, childRel, descend);
    }
  };

  collect(tree, "", true);

  // Tiny units fold into the residual — a one-file directory is not a system.
  // Structural dirs (components/, pages/…) fold too unless the package is big
  // enough that its presentation layers are systems in their own right.
  const smallPkg = sorted.length < STRUCTURAL_SPLIT_MIN_PKG_FILES;
  const kept: Unit[] = [];
  for (const unit of units) {
    const structural = STRUCTURAL_NAMES.has(unit.name.toLowerCase());
    if (unit.files.length < UNIT_MIN_FILES || (structural && smallPkg)) {
      residual.push(...unit.files);
    } else kept.push(unit);
  }
  if (residual.length > 0 || kept.length === 0) {
    kept.push({
      path: pkgPath,
      name: pkgName,
      pkg: pkgPath,
      files: residual.sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  return kept.filter((u) => u.files.length > 0);
}

/* ------------------------------------------------------------------ */
/* Stage B — concept profiles                                          */
/* ------------------------------------------------------------------ */

interface UnitProfile {
  unit: Unit;
  /** intent value → confidence-weighted tag mass across the unit's files. */
  intents: Map<string, number>;
  /** Dominant concept when strong enough to cluster by, else null. */
  concept: string | null;
  /** The unit's own name asserts the concept (word match). */
  nameAsserted: boolean;
  /** role:util/role:shared tag share, for role detection. */
  sharedShare: number;
}

function profileUnit(
  unit: Unit,
  index: CodeIndex | null,
  lexicon: readonly ConceptDef[],
): UnitProfile {
  const intents = new Map<string, number>();
  /** intent value → distinct lexicon-word stems seen in heuristic evidence. */
  const intentStems = new Map<string, Set<string>>();
  /** intents also carried by symbolic/agent tags — corroborated by definition. */
  const intentSupported = new Set<string>();
  let roleTags = 0;
  let sharedTags = 0;

  if (index) {
    const byPath = indexByPath(index);
    for (const file of unit.files) {
      const indexed = byPath.get(file.path);
      if (!indexed) continue;
      const addTag = (t: { tag: string; confidence: number; source: string; evidence?: string[] }): void => {
        const dimension = tagDimension(t.tag);
        if (dimension === "intent") {
          const value = tagValue(t.tag);
          intents.set(value, (intents.get(value) ?? 0) + t.confidence);
          if (t.source === "heuristic") {
            let stems = intentStems.get(value);
            if (!stems) intentStems.set(value, (stems = new Set()));
            for (const ev of t.evidence ?? []) stems.add(evidenceStem(ev));
          } else {
            intentSupported.add(value);
          }
        } else if (dimension === "role") {
          roleTags += 1;
          if (t.tag === "role:util" || t.tag === "role:shared") sharedTags += 1;
        }
      };
      for (const t of indexed.tags) addTag(t);
      for (const sym of indexed.symbols) for (const t of sym.tags) addTag(t);
    }
  }

  // The unit's own name asserting a concept is stronger evidence than any
  // tag mass — a directory called "auth" *is* the authentication module.
  // Structural and shared dirs (components/, shared/, utils/…) never take a
  // concept at all: a shared package full of money helpers is still the
  // shared package, not the payments system.
  const lowerName = unit.name.toLowerCase();
  const structural = STRUCTURAL_NAMES.has(lowerName) || SHARED_NAMES.has(lowerName);
  const nameWords = new Set(structural ? [] : identifierWords(unit.name));

  // Corroboration: one repeated lexicon word is not an intent. A parser whose
  // symbols all say "token" is about tokenizing, not authentication — an
  // intent asserted by a single stem (and by nothing else: no symbolic
  // propagation, no agent tag, not the unit's own name) is dropped.
  for (const [value, stems] of intentStems) {
    if (intentSupported.has(value) || stems.size >= 2) continue;
    const stem = [...stems][0];
    if (stem != null && (nameWords.has(stem) || nameWords.has(value))) continue;
    intents.delete(value);
  }
  let nameConcept: string | null = null;
  for (const def of lexicon) {
    if (def.words.some((w) => nameWords.has(w))) {
      nameConcept = def.value;
      break;
    }
  }
  if (!nameConcept) {
    // Agent-minted intents ("intent:submission") match on the value itself.
    for (const value of [...intents.keys()].sort()) {
      if (nameWords.has(value)) {
        nameConcept = value;
        break;
      }
    }
  }

  let concept: string | null = nameConcept;
  const nameAsserted = nameConcept != null;
  if (!concept && !structural && intents.size > 0) {
    const total = [...intents.values()].reduce((a, b) => a + b, 0);
    const [top, weight] = [...intents.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]!;
    if (weight >= CONCEPT_MERGE_WEIGHT && weight / total >= CONCEPT_MERGE_SHARE) concept = top;
  }

  return {
    unit,
    intents,
    concept,
    nameAsserted,
    sharedShare: roleTags > 0 ? sharedTags / roleTags : 0,
  };
}

const indexCache = new WeakMap<CodeIndex, Map<string, CodeIndex["files"][number]>>();
function indexByPath(index: CodeIndex): Map<string, CodeIndex["files"][number]> {
  let map = indexCache.get(index);
  if (!map) indexCache.set(index, (map = new Map(index.files.map((f) => [f.path, f]))));
  return map;
}

/* ------------------------------------------------------------------ */
/* Stage C — cluster units into systems                                */
/* ------------------------------------------------------------------ */

interface Cluster {
  key: string;
  concept: string | null;
  name: string;
  profiles: UnitProfile[];
}

/**
 * Directory names that describe structure, not product: a "utils" in the CLI
 * and a "utils" in the web app share nothing but a naming habit. They never
 * merge across packages, and their system name carries the owning package so
 * the overview doesn't fill up with anonymous "Utils" boxes.
 */
const GENERIC_UNIT_NAMES = new Set([
  "utils",
  "util",
  "helpers",
  "helper",
  "lib",
  "libs",
  "common",
  "shared",
  "misc",
  "internal",
  "support",
  "tools",
]);

function clusterUnits(profiles: UnitProfile[], lexicon: readonly ConceptDef[]): Cluster[] {
  const clusters = new Map<string, Cluster>();
  for (const profile of profiles) {
    // Concept-keyed when the unit's name asserts it or the tags dominate;
    // otherwise units of the same (singularized) name merge across packages.
    // Fixture scopes partition both kinds of merge — and mark the name, so
    // a host repo's Core and an example's Core stay tell-apart-able.
    const byConcept = profile.concept != null && (profile.nameAsserted || profile.intents.size > 0);
    const generic = !byConcept && GENERIC_UNIT_NAMES.has(nameKeyOf(profile.unit.name));
    const scope = fixtureScopeOf(profile.unit.path);
    const key =
      `${scope}::` +
      (byConcept
        ? `concept:${profile.concept}`
        : generic
          ? `name:${profile.unit.pkg}${SEP}${nameKeyOf(profile.unit.name)}`
          : `name:${nameKeyOf(profile.unit.name)}`);
    let cluster = clusters.get(key);
    if (!cluster) {
      const pkgTag = lastSegment(profile.unit.pkg) || "root";
      const base = byConcept
        ? conceptDisplayName(profile.concept!, lexicon)
        : generic && nameKeyOf(pkgTag) !== nameKeyOf(profile.unit.name)
          ? titleCase(`${pkgTag} ${profile.unit.name}`)
          : titleCase(profile.unit.name);
      const scopeTag = lastSegment(scope);
      const name = scope && slug(base) !== slug(scopeTag) ? `${base} (${scopeTag})` : base;
      clusters.set(
        key,
        (cluster = { key, concept: byConcept ? profile.concept : null, name, profiles: [] }),
      );
    }
    cluster.profiles.push(profile);
  }
  return [...clusters.values()];
}

/* ------------------------------------------------------------------ */
/* Stage D — aggregation                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the overview. Pure — same `(files, index)` in, same overview out;
 * `generatedAt` is left empty for the caller to stamp.
 */
export function buildSystemOverview(
  files: readonly OverviewSourceFile[],
  index: CodeIndex | null = null,
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): SystemOverview {
  const sources = files.filter((f) => !f.test);

  // Workspace shape: when nothing serves HTTP, no server framework is
  // imported and no path even claims to be one (api/, server/…), there is no
  // backend — a Tauri/browser app's solver or geometry kernel ships in the
  // same client bundle as its components. Non-UI systems in such a workspace
  // land in the frontend lane, not a fictitious backend.
  const clientOnly =
    sources.some((f) => UI_FILE_RE.test(f.path)) &&
    !sources.some(
      (f) =>
        (f.endpoints?.length ?? 0) > 0 ||
        SERVERISH_PATH_RE.test(f.path) ||
        f.imports.some((i) => {
          if (i.resolved) return false;
          const pkg = npmPackageOf(i.specifier);
          return pkg != null && SERVER_FRAMEWORK_PKGS.has(pkg);
        }),
    );

  // A. structural units, per package.
  const byPkg = new Map<string, OverviewSourceFile[]>();
  for (const file of sources) {
    const list = byPkg.get(file.pkg) ?? [];
    list.push(file);
    byPkg.set(file.pkg, list);
  }
  const units = [...byPkg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([pkg, pkgFiles]) => unitsOfPackage(pkg, pkgFiles));

  // B + C. semantic profiles → clusters.
  const profiles = units.map((u) => profileUnit(u, index, lexicon));
  const clusters = clusterUnits(profiles, lexicon);

  // Assemble systems (ids must be unique — slug collisions get a suffix).
  const usedIds = new Set<string>();
  const systems: SystemModule[] = [];
  const systemOfFile = new Map<string, string>();
  const partOfFile = new Map<string, string>();
  const fileMeta = new Map(sources.map((f) => [f.path, f]));

  for (const cluster of [...clusters].sort(
    (a, b) =>
      b.profiles.reduce((n, p) => n + p.unit.files.length, 0) -
        a.profiles.reduce((n, p) => n + p.unit.files.length, 0) || a.name.localeCompare(b.name),
  )) {
    let id = `sys:${slug(cluster.concept ?? cluster.name)}`;
    for (let n = 2; usedIds.has(id); n++) id = `sys:${slug(cluster.concept ?? cluster.name)}-${n}`;
    usedIds.add(id);

    // Nested units that clustered together read as one part — "services/api"
    // + "services/api/src/handlers" is just services/api to a reviewer.
    const rawParts = cluster.profiles
      .map((p) => ({ path: p.unit.path, pkg: p.unit.pkg, fileCount: p.unit.files.length }))
      .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    const parts: SystemPart[] = [];
    for (const part of rawParts) {
      const ancestor = parts.find(
        (p) => part.path === p.path || part.path.startsWith(`${p.path}/`),
      );
      if (ancestor) ancestor.fileCount += part.fileCount;
      else parts.push({ ...part });
    }
    parts.sort((a, b) => b.fileCount - a.fileCount || a.path.localeCompare(b.path));
    const memberFiles = cluster.profiles.flatMap((p) => p.unit.files);
    for (const f of memberFiles) systemOfFile.set(f.path, id);
    // Which collapsed part owns each file — powers part-level link attribution.
    // Parts are pairwise non-nested after folding, so each unit matches one.
    for (const p of cluster.profiles) {
      const owner = parts.find(
        (part) => p.unit.path === part.path || p.unit.path.startsWith(`${part.path}/`),
      );
      if (owner) for (const f of p.unit.files) partOfFile.set(f.path, owner.path);
    }

    // Intent profile (merged across units).
    const intentMass = new Map<string, number>();
    for (const p of cluster.profiles) {
      for (const [value, weight] of p.intents) {
        intentMass.set(value, (intentMass.get(value) ?? 0) + weight);
      }
    }
    const intents = [...intentMass.entries()]
      .map(([value, weight]) => ({ value, weight: Math.round(weight * 10) / 10 }))
      .sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value))
      .slice(0, INTENTS_CAP);

    // External services consumed. Databases/caches are the data layer, not
    // integrations — they feed the `data` role instead.
    const externalWeights = new Map<string, { name: string; weight: number }>();
    const libraryWeights = new Map<string, number>();
    let integrationFiles = 0;
    let dataFiles = 0;
    for (const file of memberFiles) {
      let integrates = false;
      let touchesData = false;
      for (const imp of file.imports) {
        if (imp.resolved) continue;
        const pkg = npmPackageOf(imp.specifier);
        const meta = pkg ? classifyExternalPackage(pkg) : null;
        if (!meta) {
          // Not a service — a plain library still tells a reader what this
          // system leans on (the whole external story in library-heavy apps).
          if (pkg && !isPlatformImport(pkg)) {
            libraryWeights.set(pkg, (libraryWeights.get(pkg) ?? 0) + 1);
          }
          continue;
        }
        const entry = externalWeights.get(meta.id) ?? { name: meta.name, weight: 0 };
        entry.weight += 1;
        externalWeights.set(meta.id, entry);
        if (meta.category === "database" || meta.category === "cache") touchesData = true;
        else if (meta.category !== "http") integrates = true;
      }
      if (integrates) integrationFiles += 1;
      if (touchesData) dataFiles += 1;
    }
    const externals: SystemExternal[] = [...externalWeights.entries()]
      .map(([sid, { name, weight }]) => ({ id: sid, name, weight }))
      .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
      .slice(0, EXTERNALS_CAP);
    const libraries = [...libraryWeights.entries()]
      .map(([pkg, weight]) => ({ pkg, weight }))
      .sort((a, b) => b.weight - a.weight || a.pkg.localeCompare(b.pkg))
      .slice(0, LIBRARIES_CAP);

    // Role: explicit names first, then external-usage and tag evidence.
    const names = new Set(
      cluster.profiles.flatMap((p) => [p.unit.name.toLowerCase(), nameKeyOf(p.unit.name)]),
    );
    const nameIn = (set: ReadonlySet<string>): boolean =>
      [...names].some((n) => set.has(n) || set.has(`${n}s`));
    const sharedByTags =
      cluster.profiles.reduce((s, p) => s + p.sharedShare * p.unit.files.length, 0) /
        Math.max(1, memberFiles.length) >=
      0.5;
    const memberCount = Math.max(1, memberFiles.length);
    const role: SystemRole = nameIn(INTEGRATION_NAMES)
      ? "integration"
      : integrationFiles / memberCount >= INTEGRATION_FILE_SHARE
        ? "integration"
        : dataFiles / memberCount >= DATA_FILE_SHARE || cluster.concept === "persistence"
          ? "data"
          : nameIn(ENTRY_NAMES)
            ? "entry"
            : nameIn(SHARED_NAMES) || nameIn(STRUCTURAL_NAMES) || sharedByTags
              ? "shared"
              : "domain";

    // Layer: role decides the data/integration buckets; UI-file share and
    // frontend-ish names decide frontend; everything else is backend —
    // unless the whole workspace is client-only, where it is all frontend.
    const uiFiles = memberFiles.filter((f) => UI_FILE_RE.test(f.path)).length;
    const layer: SystemLayer =
      role === "data"
        ? "database"
        : role === "integration"
          ? "integrations"
          : uiFiles / memberCount >= FRONTEND_FILE_SHARE || nameIn(FRONTEND_NAMES) || clientOnly
            ? "frontend"
            : "backend";

    // Served HTTP routes, deduped by method+path (first declaring file wins).
    const endpointMap = new Map<string, SystemEndpoint>();
    for (const file of memberFiles) {
      for (const ep of file.endpoints ?? []) {
        const key = `${ep.method} ${ep.path}`;
        if (!endpointMap.has(key)) endpointMap.set(key, { ...ep, file: file.path });
      }
    }
    const endpoints = [...endpointMap.values()]
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
      .slice(0, ENDPOINTS_CAP);

    systems.push({
      id,
      name: cluster.name,
      concept: cluster.concept,
      role,
      layer,
      parts,
      fileCount: memberFiles.length,
      intents,
      exports: [], // filled below, once cross-system imports are counted
      exportedTotal: memberFiles.reduce((n, f) => n + f.exports.length, 0),
      externals,
      libraries,
      endpoints,
      components: [], // filled below, once export consumers are counted
      componentCount: 0,
    });
  }

  // D. cross-system links + consumed exports.
  const linkAgg = new Map<
    string,
    { weight: number; names: Map<string, number>; parts: Map<string, number> }
  >();
  // (system, source part, target part) → intra-system import count.
  const intraAgg = new Map<string, number>();
  // (system, file, exportName) → distinct outside consumer files.
  const exportConsumers = new Map<string, Set<string>>();

  // Per-system export name → declaring file (built lazily; declarations beat
  // named re-exports so "open export" lands on real code, not a barrel).
  const declaringMemo = new Map<string, Map<string, string>>();
  const sortedSources = [...sources].sort((a, b) => a.path.localeCompare(b.path));
  const declaringFileOf = (system: string): Map<string, string> => {
    let map = declaringMemo.get(system);
    if (map) return map;
    declaringMemo.set(system, (map = new Map()));
    const reexports = new Set<string>();
    for (const file of sortedSources) {
      if (systemOfFile.get(file.path) !== system) continue;
      for (const e of file.exports) {
        if (!map.has(e.name)) {
          map.set(e.name, file.path);
          if (e.kind === "reexport") reexports.add(e.name);
        } else if (reexports.has(e.name) && e.kind !== "reexport") {
          map.set(e.name, file.path);
          reexports.delete(e.name);
        }
      }
    }
    return map;
  };

  for (const file of sources) {
    const sourceSystem = systemOfFile.get(file.path);
    if (!sourceSystem) continue;
    for (const imp of file.imports) {
      if (!imp.resolved) continue;
      const target = fileMeta.get(imp.resolved);
      const targetSystem = target ? systemOfFile.get(target.path) : undefined;
      if (!target || !targetSystem) continue;
      const sourcePart = partOfFile.get(file.path);
      const targetPart = partOfFile.get(target.path);
      if (targetSystem === sourceSystem) {
        if (sourcePart && targetPart && sourcePart !== targetPart) {
          const intraKey = [sourceSystem, sourcePart, targetPart].join(SEP);
          intraAgg.set(intraKey, (intraAgg.get(intraKey) ?? 0) + 1);
        }
        continue;
      }

      const key = `${sourceSystem}\u0000${targetSystem}`;
      const link = linkAgg.get(key) ?? { weight: 0, names: new Map(), parts: new Map() };
      link.weight += 1;
      if (sourcePart && targetPart) {
        const partKey = sourcePart + SEP + targetPart;
        link.parts.set(partKey, (link.parts.get(partKey) ?? 0) + 1);
      }
      for (const name of imp.names) {
        if (name === "*" || name === "default") continue;
        link.names.set(name, (link.names.get(name) ?? 0) + 1);
        // Barrel entrypoints (`export * from …`) don't declare the names they
        // serve — fall back to the file inside the system that does.
        const declaring = target.exports.some((e) => e.name === name)
          ? target.path
          : declaringFileOf(targetSystem).get(name);
        if (declaring) {
          const exportKey = `${targetSystem}\u0000${declaring}\u0000${name}`;
          const consumers = exportConsumers.get(exportKey) ?? new Set();
          consumers.add(file.path);
          exportConsumers.set(exportKey, consumers);
        }
      }
      linkAgg.set(key, link);
    }
  }

  // What one imported name looks like at its declaration inside a system —
  // kind + signature, resolved through barrels to the real declaration.
  const shapeOf = (
    system: string,
    name: string,
  ): { kind: CodeSymbolKind; signature?: string; file?: string } => {
    const declaring = declaringFileOf(system).get(name);
    const exp = declaring
      ? fileMeta.get(declaring)?.exports.find((e) => e.name === name && e.kind !== "reexport")
      : undefined;
    return { kind: exp?.kind ?? "const", signature: exp?.signature, file: declaring };
  };

  const links: SystemLink[] = [...linkAgg.entries()]
    .map(([key, { weight, names, parts }]) => {
      const [source, target] = key.split("\u0000") as [string, string];
      const details: SystemLinkSymbol[] = [...names.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, LINK_SYMBOLS_CAP)
        .map(([name, count]) => ({ name, count, ...shapeOf(target, name) }));
      const link: SystemLink = { source, target, weight, symbols: details.map((d) => d.name) };
      if (details.length > 0) link.details = details;
      const partDetail = [...parts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, LINK_PARTS_CAP)
        .map(([partKey, w]) => {
          const [sourcePart, targetPart] = partKey.split(SEP) as [string, string];
          return { sourcePart, targetPart, weight: w };
        });
      if (partDetail.length > 0) link.parts = partDetail;
      return link;
    })
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  // Intra-system part-to-part imports — the expanded ("components") view of a system.
  const intraBySystem = new Map<string, SystemPartLink[]>();
  for (const [intraKey, weight] of intraAgg) {
    const [system, source, target] = intraKey.split(SEP) as [string, string, string];
    const list = intraBySystem.get(system) ?? [];
    list.push({ source, target, weight });
    intraBySystem.set(system, list);
  }
  for (const system of systems) {
    const list = intraBySystem.get(system.id);
    if (!list) continue;
    system.partLinks = list
      .sort(
        (a, b) =>
          b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
      )
      .slice(0, PART_LINKS_CAP);
  }

  // HTTP calls matched to served routes: an outgoing call in system A whose
  // path matches a route served by system B becomes an `apis` entry on the
  // A→B link — created with weight 0 when no import edge exists (services
  // talking over the wire rather than through the module graph).
  const served = systems.flatMap((s) =>
    s.endpoints.map((ep) => ({ system: s.id, ep, method: ep.method, segs: routeSegments(ep.path) })),
  );
  if (served.length > 0) {
    const apiAgg = new Map<string, Map<string, HttpEndpoint & { weight: number }>>();
    for (const file of sources) {
      const sourceSystem = systemOfFile.get(file.path);
      if (!sourceSystem) continue;
      for (const call of file.apiCalls ?? []) {
        const hit = bestServedRoute(call, served, (r) => r.system === sourceSystem);
        if (!hit) continue;
        const linkKey = sourceSystem + SEP + hit.system;
        const byRoute = apiAgg.get(linkKey) ?? new Map<string, HttpEndpoint & { weight: number }>();
        const routeKey = `${hit.ep.method} ${hit.ep.path}`;
        const entry = byRoute.get(routeKey) ?? { method: hit.ep.method, path: hit.ep.path, weight: 0 };
        entry.weight += 1;
        byRoute.set(routeKey, entry);
        apiAgg.set(linkKey, byRoute);
      }
    }
    for (const [linkKey, byRoute] of apiAgg) {
      const [source, target] = linkKey.split(SEP) as [string, string];
      const apis = [...byRoute.values()]
        .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
        .slice(0, LINK_APIS_CAP);
      const existing = links.find((l) => l.source === source && l.target === target);
      if (existing) existing.apis = apis;
      else links.push({ source, target, weight: 0, symbols: [], apis });
    }
  }

  // Consumed exports per system.
  const exportsBySystem = new Map<string, SystemExport[]>();
  // (system, file, name) → outside consumers, for the component inventory
  // below — uncapped, unlike the EXPORTS_CAP'd list.
  const componentConsumers = new Map<string, number>();
  for (const [key, consumers] of exportConsumers) {
    const [system, file, name] = key.split("\u0000") as [string, string, string];
    const exp = fileMeta.get(file)?.exports.find((e) => e.name === name);
    const kind = exp?.kind ?? "const";
    if (kind === "component") componentConsumers.set(key, consumers.size);
    const list = exportsBySystem.get(system) ?? [];
    list.push({ name, kind, file, consumers: consumers.size, signature: exp?.signature });
    exportsBySystem.set(system, list);
  }
  for (const system of systems) {
    system.exports = (exportsBySystem.get(system.id) ?? [])
      .sort((a, b) => b.consumers - a.consumers || a.name.localeCompare(b.name) || a.file.localeCompare(b.file))
      .slice(0, EXPORTS_CAP);
  }

  // E. React component inventory per system — local (never-imported)
  // components count too; the consumed-export aggregation above only sees
  // what crosses a boundary.
  const componentsBySystem = new Map<string, SystemComponent[]>();
  for (const file of sources) {
    if (file.test || !file.components || file.components.length === 0) continue;
    const system = systemOfFile.get(file.path);
    if (!system) continue;
    const list = componentsBySystem.get(system) ?? [];
    for (const name of file.components) {
      list.push({
        name,
        file: file.path,
        consumers: componentConsumers.get(system + SEP + file.path + SEP + name) ?? 0,
      });
    }
    componentsBySystem.set(system, list);
  }
  for (const system of systems) {
    const list = componentsBySystem.get(system.id) ?? [];
    system.componentCount = list.length;
    system.components = list
      .sort(
        (a, b) =>
          b.consumers - a.consumers || a.name.localeCompare(b.name) || a.file.localeCompare(b.file),
      )
      .slice(0, COMPONENTS_CAP);
  }

  // High fan-in without a domain concept reads as platform/shared.
  const inbound = new Map<string, number>();
  for (const link of links) inbound.set(link.target, (inbound.get(link.target) ?? 0) + 1);
  for (const system of systems) {
    if (system.role !== "domain" || system.concept != null) continue;
    const others = systems.length - 1;
    const fanIn = inbound.get(system.id) ?? 0;
    if (others >= 3 && fanIn / others >= SHARED_FAN_IN_SHARE) system.role = "shared";
  }

  return {
    systems: systems.sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name)),
    links,
    fileTotal: sources.length,
    generatedAt: "",
  };
}

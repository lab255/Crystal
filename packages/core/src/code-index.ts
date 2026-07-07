import { z } from "zod";
import type { ArchFacet, ArchitectureGraph } from "./architecture.js";
import { isContainerKind } from "./architecture.js";
import { CODE_SYMBOL_KINDS } from "./codemap.js";
import { tagValue } from "./tags.js";

/**
 * Code index — semantic tags over a codebase's top-level symbols (functions,
 * constants, components…), keyed `file#symbol`. Two tag layers, one index:
 *
 *  - `heuristic` — computed from names, paths, kinds and import fan-in alone.
 *    Purely deterministic: the same source tree always produces the same
 *    tags. Rebuilt incrementally by the server whenever the code map changes;
 *    never persisted (it is derived state, like the code map itself).
 *  - `agent` — *intentions* asserted by a small, cheap model that reads the
 *    files ("this function verifies webhook signatures" → `intent:auth`).
 *    Agents write **enrichment** files to `.crystal/index/` (the durable,
 *    versionable part); each entry echoes the content hash it was derived
 *    from, so merging is deterministic too: a tag applies while its file's
 *    hash matches and silently expires when the code moves on.
 *
 * Tags use the dimensional shape from tags.ts. Two dimensions are built in:
 * `intent:<value>` (what the code is *for*: auth, payments, booking…) and
 * `role:<value>` (what the code *is*: util, shared, constant, hook, test…).
 */

export const CODE_INDEX_SCHEMA_VERSION = 1;
export const ENRICHMENT_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Index shapes                                                        */
/* ------------------------------------------------------------------ */

export const TAG_SOURCES = ["heuristic", "agent"] as const;
export const TagSourceSchema = z.enum(TAG_SOURCES);
export type TagSource = z.infer<typeof TagSourceSchema>;

export const SymbolTagSchema = z.object({
  /** Dimensional tag, e.g. "intent:auth", "role:util" (see tags.ts). */
  tag: z.string(),
  source: TagSourceSchema.catch("agent"),
  confidence: z.number().min(0).max(1).catch(1).default(1),
  /** Why the tag applies, e.g. "name: verifySignature", "reads JWT claims". */
  evidence: z.array(z.string()).default([]),
});
export type SymbolTag = z.infer<typeof SymbolTagSchema>;

export const IndexedSymbolSchema = z.object({
  name: z.string(),
  kind: z.enum(CODE_SYMBOL_KINDS).catch("const"),
  /** 1-based line of the declaration. */
  line: z.number().int().min(1).catch(1),
  exported: z.boolean().default(false),
  tags: z.array(SymbolTagSchema).default([]),
});
export type IndexedSymbol = z.infer<typeof IndexedSymbolSchema>;

export const IndexedFileSchema = z.object({
  /** Workspace-relative path. */
  path: z.string(),
  /** Code-map module path owning this file ("." at the root). */
  module: z.string().default("."),
  /** Content hash at index time (the enrichment freshness key). */
  hash: z.string(),
  /** File-level tags (path concepts, role:shared from fan-in, role:test). */
  tags: z.array(SymbolTagSchema).default([]),
  symbols: z.array(IndexedSymbolSchema).default([]),
  /** True when a fresh agent enrichment covers this file. */
  enriched: z.boolean().default(false),
});
export type IndexedFile = z.infer<typeof IndexedFileSchema>;

export const CodeIndexSchema = z.object({
  schemaVersion: z.number().int().min(1),
  /** ISO timestamp; informational only (stamped by the server, not the builder). */
  generatedAt: z.string().default(""),
  files: z.array(IndexedFileSchema).default([]),
});
export type CodeIndex = z.infer<typeof CodeIndexSchema>;

/* ------------------------------------------------------------------ */
/* Enrichment — the interchange format indexing agents emit            */
/* ------------------------------------------------------------------ */

export const EnrichmentEntrySchema = z.object({
  /** Workspace-relative file the tags describe. */
  file: z.string(),
  /** Content hash echoed from the dispatch prompt; tags expire when it drifts. */
  hash: z.string(),
  /** Top-level symbol name; null/absent applies the tags to the whole file. */
  symbol: z.string().nullish(),
  tags: z.array(SymbolTagSchema).min(1),
});
export type EnrichmentEntry = z.infer<typeof EnrichmentEntrySchema>;

export const CodeEnrichmentSchema = z.object({
  schemaVersion: z.number().int().min(1),
  generator: z
    .object({ name: z.string(), version: z.string().default("") })
    .default({ name: "unknown", version: "" }),
  /** ISO timestamp; informational only. */
  generatedAt: z.string().default(""),
  entries: z.array(EnrichmentEntrySchema).default([]),
  /** Anything the indexer wants a human to read (caveats, unknowns). */
  notes: z.array(z.string()).default([]),
});
export type CodeEnrichment = z.infer<typeof CodeEnrichmentSchema>;

/**
 * Per-version migrations for the enrichment payload, `migrations[n]` upgrading
 * version n to n+1 — same contract as `SURVEY_MIGRATIONS`. v1 is initial.
 */
export const ENRICHMENT_MIGRATIONS: Record<number, (data: unknown) => unknown> = {};

export class EnrichmentVersionError extends Error {}

/** Upgrade an older enrichment payload to the current schema version. */
export function migrateEnrichmentData(
  raw: unknown,
  migrations: Record<number, (data: unknown) => unknown> = ENRICHMENT_MIGRATIONS,
  currentVersion: number = ENRICHMENT_SCHEMA_VERSION,
): unknown {
  const version = (raw as { schemaVersion?: unknown })?.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new EnrichmentVersionError("Enrichment payload is missing an integer schemaVersion");
  }
  if (version > currentVersion) {
    throw new EnrichmentVersionError(
      `Enrichment schemaVersion ${version} is newer than this build supports (${currentVersion})`,
    );
  }
  let data = raw;
  for (let v = version; v < currentVersion; v++) {
    const step = migrations[v];
    if (!step) throw new EnrichmentVersionError(`No migration from enrichment schemaVersion ${v}`);
    data = step(data);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Deterministic heuristics                                            */
/* ------------------------------------------------------------------ */

/** One concept in the intent lexicon. */
export interface ConceptDef {
  /** Tag value: `intent:<value>`. */
  value: string;
  /** Display name for facet suggestions and chips. */
  name: string;
  /** Lowercase word tokens asserting the concept (matched whole-word). */
  words: readonly string[];
}

/**
 * The default intent lexicon. Deliberately generic — cross-domain concepts a
 * name/path match can assert with confidence. Anything subtler is the agent
 * layer's job; agents may also mint `intent:` values outside this list.
 */
export const CONCEPT_LEXICON: readonly ConceptDef[] = [
  {
    value: "auth",
    name: "Authentication",
    words: [
      "auth", "authenticate", "authentication", "login", "logout", "signin", "signup",
      "session", "sessions", "token", "tokens", "jwt", "password", "passwords",
      "credential", "credentials", "oauth", "sso", "mfa", "otp", "permission",
      "permissions", "signature", "hmac", "secret", "secrets", "apikey",
    ],
  },
  {
    value: "payments",
    name: "Payments",
    words: [
      "payment", "payments", "pay", "payout", "billing", "invoice", "invoices",
      "charge", "charges", "refund", "refunds", "stripe", "checkout", "price",
      "prices", "pricing", "fare", "fares", "currency", "money", "receipt",
      "discount", "discounts", "promo", "surcharge",
    ],
  },
  {
    value: "booking",
    name: "Booking",
    words: [
      "booking", "bookings", "book", "reservation", "reservations", "reserve",
      "availability", "slot", "slots", "itinerary", "cancellation", "sailing",
      "sailings", "seat", "seats",
    ],
  },
  {
    value: "users",
    name: "Users & accounts",
    words: [
      "user", "users", "profile", "profiles", "account", "accounts", "member",
      "members", "customer", "customers", "passenger", "passengers", "tenant",
    ],
  },
  {
    value: "notifications",
    name: "Notifications",
    words: [
      "notification", "notifications", "notify", "email", "emails", "mail",
      "sms", "alert", "alerts", "digest", "template", "templates",
    ],
  },
  {
    value: "jobs",
    name: "Background jobs",
    words: [
      "job", "jobs", "queue", "queues", "enqueue", "publish", "publisher",
      "consumer", "worker", "workers", "dispatcher", "processor", "processors",
      "cron", "webhook", "webhooks",
    ],
  },
  {
    value: "persistence",
    name: "Persistence",
    words: [
      "db", "database", "repo", "repos", "repository", "repositories", "storage",
      "persistence", "migration", "migrations", "sql", "postgres", "redis",
      "cache", "caches",
    ],
  },
  {
    value: "api",
    name: "API surface",
    words: [
      "api", "route", "routes", "router", "endpoint", "endpoints", "controller",
      "controllers", "handler", "handlers", "middleware", "request", "response",
      "http", "server",
    ],
  },
  {
    value: "validation",
    name: "Validation",
    words: ["validate", "validation", "validator", "validators", "sanitize", "parse", "parser"],
  },
  {
    value: "config",
    name: "Configuration",
    words: ["config", "configs", "configuration", "settings", "env", "flag", "flags"],
  },
  {
    value: "observability",
    name: "Observability",
    words: [
      "log", "logs", "logger", "logging", "telemetry", "metric", "metrics",
      "audit", "monitor", "monitoring",
    ],
  },
];

/** Path/name words marking utility code (the `role:util` slice). */
const UTIL_WORDS = new Set(["util", "utils", "utility", "utilities", "helper", "helpers", "shared", "common", "lib", "format", "formatting"]);

const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9_]*$/;
const HOOK_RE = /^use[A-Z]/;
const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$|__tests__\//;

/**
 * Lowercase word tokens of an identifier or path: splits camelCase, snake,
 * kebab, dots and slashes. `"verifyJWTSignature"` → `["verify","jwt","signature"]`.
 */
export function identifierWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function conceptTags(
  words: ReadonlySet<string>,
  evidenceLabel: string,
  lexicon: readonly ConceptDef[],
): SymbolTag[] {
  const out: SymbolTag[] = [];
  for (const concept of lexicon) {
    const hit = concept.words.find((w) => words.has(w));
    if (!hit) continue;
    out.push({
      tag: `intent:${concept.value}`,
      source: "heuristic",
      confidence: 1,
      evidence: [`${evidenceLabel}: ${hit}`],
    });
  }
  return out;
}

/** What the heuristic tagger needs to know about one symbol. */
export interface IndexSymbolInput {
  name: string;
  kind: (typeof CODE_SYMBOL_KINDS)[number];
  line: number;
  exported: boolean;
}

/** What the heuristic tagger needs to know about one file. */
export interface IndexSourceFile {
  /** Workspace-relative path. */
  path: string;
  /** Code-map module path owning this file. */
  module: string;
  /** Content hash of the file text. */
  hash: string;
  /** Distinct modules (other than its own) importing this file. */
  importerModules: number;
  symbols: IndexSymbolInput[];
}

/**
 * Deterministic tags for one symbol: intent concepts from its name plus role
 * tags from its kind/shape. Same inputs, same output — no I/O, no randomness.
 */
export function heuristicSymbolTags(
  symbol: IndexSymbolInput,
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): SymbolTag[] {
  const words = new Set(identifierWords(symbol.name));
  const tags = conceptTags(words, `name: ${symbol.name}`, lexicon);
  const role = (value: string, why: string): void => {
    tags.push({ tag: `role:${value}`, source: "heuristic", confidence: 1, evidence: [why] });
  };
  if (symbol.kind === "component") role("component", `kind: component`);
  else if (symbol.kind === "class") role("class", `kind: class`);
  else if (symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum") {
    role("type", `kind: ${symbol.kind}`);
  } else if (symbol.kind === "const" && UPPER_SNAKE_RE.test(symbol.name)) {
    role("constant", `name: ${symbol.name}`);
  }
  if (HOOK_RE.test(symbol.name) && (symbol.kind === "function" || symbol.kind === "const")) {
    role("hook", `name: ${symbol.name}`);
  }
  if ([...words].some((w) => UTIL_WORDS.has(w))) role("util", `name: ${symbol.name}`);
  return sortTags(tags);
}

/** Deterministic file-level tags: path concepts, util/test roles, fan-in sharing. */
export function heuristicFileTags(
  file: Pick<IndexSourceFile, "path" | "importerModules">,
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): SymbolTag[] {
  const words = new Set(identifierWords(file.path));
  const tags = conceptTags(words, `path: ${file.path}`, lexicon);
  if ([...words].some((w) => UTIL_WORDS.has(w))) {
    tags.push({ tag: "role:util", source: "heuristic", confidence: 1, evidence: [`path: ${file.path}`] });
  }
  if (TEST_FILE_RE.test(file.path)) {
    tags.push({ tag: "role:test", source: "heuristic", confidence: 1, evidence: [`path: ${file.path}`] });
  }
  if (file.importerModules >= 2) {
    tags.push({
      tag: "role:shared",
      source: "heuristic",
      confidence: 1,
      evidence: [`imported by ${file.importerModules} modules`],
    });
  }
  return sortTags(tags);
}

function sortTags(tags: SymbolTag[]): SymbolTag[] {
  return tags.sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Merge `extra` into `base`, deduplicating by tag string (evidence unions). */
function mergeTags(base: SymbolTag[], extra: SymbolTag[]): SymbolTag[] {
  const byTag = new Map(base.map((t) => [t.tag, t]));
  for (const tag of extra) {
    const existing = byTag.get(tag.tag);
    if (!existing) {
      byTag.set(tag.tag, tag);
      continue;
    }
    const evidence = [...existing.evidence];
    for (const e of tag.evidence) if (!evidence.includes(e)) evidence.push(e);
    byTag.set(tag.tag, {
      ...existing,
      confidence: Math.max(existing.confidence, tag.confidence),
      evidence,
    });
  }
  return sortTags([...byTag.values()]);
}

/**
 * Build the index: heuristic tags for every file/symbol, then agent tags from
 * enrichments folded in wherever the echoed hash still matches the file. Pure
 * and deterministic — the result is a function of (sources, enrichments)
 * alone; the caller stamps `generatedAt`.
 */
export function buildCodeIndex(
  sources: readonly IndexSourceFile[],
  enrichments: readonly CodeEnrichment[] = [],
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): CodeIndex {
  // Fresh enrichment entries per file (hash must match the current source).
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const fresh = new Map<string, EnrichmentEntry[]>();
  for (const enrichment of enrichments) {
    for (const entry of enrichment.entries) {
      if (byPath.get(entry.file)?.hash !== entry.hash) continue;
      const list = fresh.get(entry.file) ?? [];
      list.push(entry);
      fresh.set(entry.file, list);
    }
  }

  const files: IndexedFile[] = [...sources]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((source) => {
      const entries = fresh.get(source.path) ?? [];
      const agentTagsFor = (symbol: string | null): SymbolTag[] =>
        entries
          .filter((e) => (e.symbol ?? null) === symbol)
          .flatMap((e) => e.tags.map((t) => ({ ...t, source: "agent" as const })));
      return {
        path: source.path,
        module: source.module,
        hash: source.hash,
        tags: mergeTags(heuristicFileTags(source, lexicon), agentTagsFor(null)),
        symbols: [...source.symbols]
          .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
          .map((sym) => ({
            name: sym.name,
            kind: sym.kind,
            line: sym.line,
            exported: sym.exported,
            tags: mergeTags(heuristicSymbolTags(sym, lexicon), agentTagsFor(sym.name)),
          })),
        enriched: entries.length > 0,
      };
    });

  return { schemaVersion: CODE_INDEX_SCHEMA_VERSION, generatedAt: "", files };
}

/** Files with no fresh agent enrichment — the batch the next indexing run should read. */
export function staleIndexFiles(index: CodeIndex): string[] {
  return index.files.filter((f) => !f.enriched).map((f) => f.path);
}

/* ------------------------------------------------------------------ */
/* Facet suggestions                                                   */
/* ------------------------------------------------------------------ */

/** Minimum tagged symbols before an intent is worth a facet. */
const SUGGEST_MIN_SYMBOLS = 3;
/** Files sharing two intents before a combined facet is suggested. */
const SUGGEST_MIN_CO_OCCUR = 3;
/** Suggestions whose member sets overlap an existing facet this much are dropped. */
const SUGGEST_DUP_JACCARD = 0.8;
/** A facet covering more than this fraction of linked nodes trims too little. */
const SUGGEST_MAX_COVERAGE = 0.8;
const SUGGEST_LIMIT = 8;
const SUGGEST_PAIR_LIMIT = 2;

export interface FacetSuggestion {
  /** Suggested facet name, e.g. "Authentication" or "Booking + Payments". */
  name: string;
  description: string;
  /** Intent tags driving the grouping (one, or two for a combined facet). */
  tags: string[];
  /** All member node ids (intent members + shared dependencies). */
  nodeIds: string[];
  /** Subset of `nodeIds` included as shared/utility dependencies. */
  sharedNodeIds: string[];
  /** Symbols carrying the intent across the member files. */
  matchedSymbols: number;
  /** Evidence files (capped) for tooltips/inspection. */
  sampleFiles: string[];
}

interface NodeFiles {
  nodeId: string;
  files: IndexedFile[];
}

function isPathWithin(child: string, parent: string): boolean {
  return parent !== "" && parent !== "." && (child === parent || child.startsWith(`${parent}/`));
}

/** Leaf nodes with code links, each with the indexed files it covers. */
function nodeFileSets(graph: ArchitectureGraph, index: CodeIndex): NodeFiles[] {
  const out: NodeFiles[] = [];
  for (const node of graph.nodes) {
    if (isContainerKind(node.kind)) continue;
    let files: IndexedFile[] = [];
    if (node.codeFile) {
      files = index.files.filter((f) => f.path === node.codeFile);
    } else if (node.codeModule) {
      const mod = node.codeModule;
      files = index.files.filter(
        (f) => f.module === mod || isPathWithin(f.module, mod) || isPathWithin(f.path, mod),
      );
    }
    if (files.length > 0) out.push({ nodeId: node.id, files });
  }
  return out;
}

/** All tags on a file (file-level + every symbol), as a set of tag strings. */
function fileTagSet(file: IndexedFile): Set<string> {
  const set = new Set(file.tags.map((t) => t.tag));
  for (const sym of file.symbols) for (const t of sym.tags) set.add(t.tag);
  return set;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  let inter = 0;
  for (const id of new Set(b)) if (setA.has(id)) inter += 1;
  return inter / (new Set([...a, ...b]).size || 1);
}

/** Display name for an intent value: lexicon name, else title-cased value. */
export function conceptDisplayName(
  value: string,
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): string {
  const def = lexicon.find((c) => c.value === value);
  if (def) return def.name;
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
}

/**
 * Suggest facets for a diagram from the code index: one per intent with
 * enough tagged symbols, plus combined facets for intents that co-occur in
 * the same files. Each suggestion folds in *shared dependencies* — non-member
 * nodes that at least two members point edges at — so accepting "Booking"
 * yields the booking components **plus** the shared/utility packages they
 * lean on. Deterministic: sorted by weight, then name.
 */
export function suggestFacets(
  graph: ArchitectureGraph,
  index: CodeIndex,
  lexicon: readonly ConceptDef[] = CONCEPT_LEXICON,
): FacetSuggestion[] {
  const nodes = nodeFileSets(graph, index);
  if (nodes.length === 0) return [];

  // intent value → { files, weight } across the whole index (test files
  // excluded). Weight counts symbols carrying the intent *themselves*; a
  // file-level-only match counts once, so path hits don't drown name hits.
  const intents = new Map<string, { files: Set<string>; symbols: number }>();
  const intentsOfFile = new Map<string, Set<string>>();
  for (const file of index.files) {
    const tags = fileTagSet(file);
    if (tags.has("role:test")) continue;
    const values = new Set<string>();
    for (const tag of tags) if (tag.startsWith("intent:")) values.add(tagValue(tag));
    intentsOfFile.set(file.path, values);
    for (const value of values) {
      const bucket = intents.get(value) ?? { files: new Set(), symbols: 0 };
      bucket.files.add(file.path);
      const ownMatches = file.symbols.filter((s) =>
        s.tags.some((t) => t.tag === `intent:${value}`),
      ).length;
      bucket.symbols += Math.max(ownMatches, 1);
      intents.set(value, bucket);
    }
  }

  // Adjacency for shared-dependency folding: source node → target node ids.
  const edgesFrom = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const set = edgesFrom.get(edge.source) ?? new Set();
    set.add(edge.target);
    edgesFrom.set(edge.source, set);
  }

  const membersOf = (values: readonly string[]): { nodeIds: string[]; files: string[] } => {
    const nodeIds: string[] = [];
    const files = new Set<string>();
    for (const { nodeId, files: nodeFiles } of nodes) {
      const hits = nodeFiles.filter((f) =>
        values.some((v) => intentsOfFile.get(f.path)?.has(v)),
      );
      if (hits.length === 0) continue;
      nodeIds.push(nodeId);
      for (const f of hits) files.add(f.path);
    }
    return { nodeIds, files: [...files].sort() };
  };

  /** Non-members that ≥2 members depend on, or that are mostly util/shared files. */
  const sharedFor = (memberIds: readonly string[]): string[] => {
    const members = new Set(memberIds);
    const dependedBy = new Map<string, number>();
    for (const id of memberIds) {
      for (const target of edgesFrom.get(id) ?? []) {
        if (!members.has(target)) dependedBy.set(target, (dependedBy.get(target) ?? 0) + 1);
      }
    }
    const shared: string[] = [];
    for (const { nodeId, files } of nodes) {
      if (members.has(nodeId)) continue;
      const utilish =
        files.filter((f) => {
          const tags = fileTagSet(f);
          return tags.has("role:util") || tags.has("role:shared");
        }).length >=
        files.length / 2;
      if ((dependedBy.get(nodeId) ?? 0) >= 2 || utilish) shared.push(nodeId);
    }
    return shared.sort();
  };

  const linkedCount = nodes.length;
  const build = (values: string[], name: string, symbolCount: number): FacetSuggestion | null => {
    const { nodeIds, files } = membersOf(values);
    if (nodeIds.length === 0) return null;
    // A facet covering (nearly) every linked node trims nothing.
    if (nodeIds.length > SUGGEST_MAX_COVERAGE * linkedCount) return null;
    const shared = sharedFor(nodeIds);
    const all = [...nodeIds, ...shared];
    const dup = graph.facets.some(
      (f: ArchFacet) => f.nodeIds.length > 0 && jaccard(f.nodeIds, all) >= SUGGEST_DUP_JACCARD,
    );
    if (dup) return null;
    return {
      name,
      description:
        `${symbolCount} tagged symbol${symbolCount === 1 ? "" : "s"} across ` +
        `${nodeIds.length} component${nodeIds.length === 1 ? "" : "s"}` +
        (shared.length > 0 ? ` + ${shared.length} shared` : ""),
      tags: values.map((v) => `intent:${v}`),
      nodeIds: all,
      sharedNodeIds: shared,
      matchedSymbols: symbolCount,
      sampleFiles: files.slice(0, 8),
    };
  };

  const ranked = [...intents.entries()]
    .filter(([, bucket]) => bucket.symbols >= SUGGEST_MIN_SYMBOLS)
    .sort((a, b) => b[1].symbols - a[1].symbols || a[0].localeCompare(b[0]));

  const singles: FacetSuggestion[] = [];
  for (const [value, bucket] of ranked) {
    const s = build([value], conceptDisplayName(value, lexicon), bucket.symbols);
    if (s) singles.push(s);
  }

  // Combined facets for intents that genuinely co-occur in the same files —
  // ranked *after* singles (never crowding them out) and only when the pair's
  // member set isn't just one of its singles again.
  const pairs: FacetSuggestion[] = [];
  for (let i = 0; i < ranked.length && pairs.length < SUGGEST_PAIR_LIMIT; i++) {
    for (let j = i + 1; j < ranked.length && pairs.length < SUGGEST_PAIR_LIMIT; j++) {
      const [a, bucketA] = ranked[i]!;
      const [b, bucketB] = ranked[j]!;
      let coOccur = 0;
      for (const f of bucketA.files) if (bucketB.files.has(f)) coOccur += 1;
      if (coOccur < SUGGEST_MIN_CO_OCCUR) continue;
      const s = build(
        [a, b],
        `${conceptDisplayName(a, lexicon)} + ${conceptDisplayName(b, lexicon)}`,
        bucketA.symbols + bucketB.symbols,
      );
      if (!s) continue;
      const echoesSingle = singles.some(
        (single) => single.tags.length === 1 && jaccard(single.nodeIds, s.nodeIds) >= SUGGEST_DUP_JACCARD,
      );
      if (!echoesSingle) pairs.push(s);
    }
  }

  return [...singles, ...pairs].slice(0, SUGGEST_LIMIT);
}

/* ------------------------------------------------------------------ */
/* Agent dispatch                                                      */
/* ------------------------------------------------------------------ */

/**
 * A complete, valid example enrichment — embedded in indexing prompts as the
 * format specification and parsed in tests so it can never drift from the
 * schema (same contract as `EXAMPLE_SURVEY`).
 */
export const EXAMPLE_ENRICHMENT: CodeEnrichment = {
  schemaVersion: ENRICHMENT_SCHEMA_VERSION,
  generator: { name: "crystal-index-agent", version: "1" },
  generatedAt: "2026-01-01T00:00:00.000Z",
  entries: [
    {
      file: "services/api/src/handlers/webhooks.ts",
      hash: "9f2ab310c44d1e07",
      symbol: "verifySignature",
      tags: [
        {
          tag: "intent:auth",
          source: "agent",
          confidence: 0.95,
          evidence: ["computes an HMAC over the raw body and compares to the header"],
        },
      ],
    },
    {
      file: "services/api/src/handlers/webhooks.ts",
      hash: "9f2ab310c44d1e07",
      symbol: null,
      tags: [
        {
          tag: "intent:payments",
          source: "agent",
          confidence: 0.8,
          evidence: ["handles payment provider callbacks end to end"],
        },
      ],
    },
  ],
  notes: ["Skipped generated fixtures under test/__snapshots__."],
};

/**
 * The prompt a small, cheap indexing agent runs with: read the listed files,
 * assert `intent:` tags per top-level symbol, and write one enrichment file.
 * Hashes are echoed verbatim so merges stay deterministic; the file list is
 * the *whole* task — the agent never scans the tree itself.
 */
export function buildEnrichmentPrompt(opts: {
  /** Files to read, with the content hash the server indexed. */
  files: readonly { path: string; hash: string }[];
  /** Workspace-relative path the enrichment JSON must be written to. */
  outFile: string;
  lexicon?: readonly ConceptDef[];
}): string {
  const lexicon = opts.lexicon ?? CONCEPT_LEXICON;
  const fileList = opts.files.map((f) => `- ${f.path} (hash: ${f.hash})`).join("\n");
  const knownIntents = lexicon.map((c) => `intent:${c.value}`).join(", ");
  const example = JSON.stringify(
    { crystal: 1, kind: "enrichment", data: EXAMPLE_ENRICHMENT },
    null,
    2,
  );
  return `You are Crystal's code-indexing agent. Tag the *intentions* of the top-level symbols (functions, constants, classes, components) in the files listed below, then write ONE JSON file and stop.

Files to index (read each one; do not scan anything else):
${fileList}

For each file, decide which top-level symbols have a clear purpose worth tagging and emit entries with dimensional tags:
- Use "intent:<value>" tags. Prefer these known values when they fit: ${knownIntents}. Mint a new kebab-case value only when none fits.
- One entry per (file, symbol). Use "symbol": null for tags that apply to the whole file.
- Echo each file's "hash" EXACTLY as listed above — entries with a wrong hash are discarded.
- Set "confidence" (0-1) honestly and put a short reason in "evidence" (what the code does, not what it is named).
- Skip symbols with no clear intent; sparse and right beats dense and noisy. Do not re-state the obvious mechanical role (type/constant/component) — intent only.

Write the result to "${opts.outFile}" (create parent directories if needed) with exactly this envelope shape:

${example}

Do not modify any other file. When the file is written, reply with a one-line summary of how many entries you wrote.`;
}

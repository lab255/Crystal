import { describe, expect, it } from "vitest";
import {
  createArchFacet,
  createArchitectureGraph,
  type ArchEdge,
  type ArchNode,
} from "./architecture.js";
import {
  CodeEnrichmentSchema,
  EXAMPLE_ENRICHMENT,
  buildCodeIndex,
  buildEnrichmentPrompt,
  conceptDisplayName,
  heuristicFileTags,
  heuristicSymbolTags,
  identifierWords,
  indexFacetVisibility,
  parseLensTags,
  staleIndexFiles,
  suggestFacets,
  suggestIndexFacets,
  type CodeEnrichment,
  type IndexSourceFile,
} from "./code-index.js";
import { parseCrystalFile, serializeCrystalFile } from "./serialization.js";

const sym = (
  name: string,
  kind: IndexSourceFile["symbols"][number]["kind"] = "function",
  line = 1,
  exported = true,
): IndexSourceFile["symbols"][number] => ({ name, kind, line, exported });

const src = (
  path: string,
  module: string,
  symbols: IndexSourceFile["symbols"],
  importerModules = 0,
): IndexSourceFile => ({ path, module, hash: `h-${path}`, importerModules, symbols });

describe("identifierWords", () => {
  it("splits camelCase, snake, kebab and paths", () => {
    expect(identifierWords("verifyJWTSignature")).toEqual(["verify", "jwt", "signature"]);
    expect(identifierWords("services/api/src/auth-token_helper.ts")).toEqual([
      "services", "api", "src", "auth", "token", "helper", "ts",
    ]);
  });
});

describe("heuristic tagging", () => {
  it("asserts intent concepts from symbol names", () => {
    const tags = heuristicSymbolTags(sym("createBooking")).map((t) => t.tag);
    expect(tags).toContain("intent:booking");
  });

  it("derives role tags from kind and shape", () => {
    expect(heuristicSymbolTags(sym("PEAK_SURCHARGE", "const")).map((t) => t.tag)).toContain(
      "role:constant",
    );
    expect(heuristicSymbolTags(sym("useAvailability", "const")).map((t) => t.tag)).toContain(
      "role:hook",
    );
    expect(heuristicSymbolTags(sym("FareSummary", "component")).map((t) => t.tag)).toContain(
      "role:component",
    );
  });

  it("tags util files and cross-module fan-in as shared", () => {
    const tags = heuristicFileTags({ path: "packages/queue/src/util.ts", importerModules: 3 });
    const values = tags.map((t) => t.tag);
    expect(values).toContain("role:util");
    expect(values).toContain("role:shared");
  });

  it("is deterministic: same input, same tags, sorted", () => {
    const a = heuristicSymbolTags(sym("loginUser"));
    const b = heuristicSymbolTags(sym("loginUser"));
    expect(a).toEqual(b);
    expect(a.map((t) => t.tag)).toEqual([...a.map((t) => t.tag)].sort());
  });
});

const enrichment = (entries: CodeEnrichment["entries"]): CodeEnrichment => ({
  schemaVersion: 1,
  generator: { name: "test", version: "" },
  generatedAt: "",
  entries,
  notes: [],
});

describe("buildCodeIndex", () => {
  const sources = [
    src("b/auth.ts", "b", [sym("login"), sym("logout", "function", 5)]),
    src("a/pricing.ts", "a", [sym("quoteFare")]),
  ];

  it("orders files by path and symbols by line", () => {
    const index = buildCodeIndex(sources);
    expect(index.files.map((f) => f.path)).toEqual(["a/pricing.ts", "b/auth.ts"]);
    expect(index.files[1]!.symbols.map((s) => s.name)).toEqual(["login", "logout"]);
  });

  it("merges agent tags when the hash matches and marks the file enriched", () => {
    const index = buildCodeIndex(sources, [
      enrichment([
        {
          file: "b/auth.ts",
          hash: "h-b/auth.ts",
          symbol: "login",
          tags: [{ tag: "intent:users", source: "agent", confidence: 0.7, evidence: ["reads accounts"] }],
        },
      ]),
    ]);
    const auth = index.files.find((f) => f.path === "b/auth.ts")!;
    expect(auth.enriched).toBe(true);
    const login = auth.symbols.find((s) => s.name === "login")!;
    expect(login.tags.map((t) => t.tag)).toContain("intent:users");
    expect(staleIndexFiles(index)).toEqual(["a/pricing.ts"]);
  });

  it("drops enrichment entries whose hash drifted", () => {
    const index = buildCodeIndex(sources, [
      enrichment([
        {
          file: "b/auth.ts",
          hash: "old-hash",
          symbol: "login",
          tags: [{ tag: "intent:users", source: "agent", confidence: 1, evidence: [] }],
        },
      ]),
    ]);
    const auth = index.files.find((f) => f.path === "b/auth.ts")!;
    expect(auth.enriched).toBe(false);
    expect(auth.symbols[0]!.tags.map((t) => t.tag)).not.toContain("intent:users");
    expect(staleIndexFiles(index)).toContain("b/auth.ts");
  });

  it("dedupes an agent tag that repeats a heuristic tag, unioning evidence", () => {
    const index = buildCodeIndex(sources, [
      enrichment([
        {
          file: "b/auth.ts",
          hash: "h-b/auth.ts",
          symbol: "login",
          tags: [{ tag: "intent:auth", source: "agent", confidence: 0.9, evidence: ["checks password"] }],
        },
      ]),
    ]);
    const login = index.files.find((f) => f.path === "b/auth.ts")!.symbols[0]!;
    const auth = login.tags.filter((t) => t.tag === "intent:auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]!.source).toBe("heuristic");
    expect(auth[0]!.evidence).toContain("checks password");
  });
});

/* ---------------- facet suggestions ---------------- */

const node = (
  id: string,
  codeModule: string | null,
  kind: ArchNode["kind"] = "service",
): ArchNode => ({
  id,
  kind,
  label: id,
  description: "",
  parentId: null,
  position: { x: 0, y: 0 },
  size: null,
  tech: [],
  codeModule,
  placements: {},
});

const edge = (id: string, source: string, target: string): ArchEdge => ({
  id,
  source,
  target,
  kind: "dependency",
  label: "",
});

/** api + web carry auth code; both depend on core (a util-ish shared package). */
function fixture() {
  const graph = {
    ...createArchitectureGraph("test"),
    nodes: [
      node("api", "services/api"),
      node("web", "apps/web", "frontend"),
      node("core", "packages/core", "package"),
      node("worker", "services/worker"),
    ],
    edges: [
      edge("e1", "api", "core"),
      edge("e2", "web", "core"),
      edge("e3", "worker", "core"),
    ],
  };
  const index = buildCodeIndex([
    src("services/api/src/middleware/auth.ts", "services/api", [
      sym("requireApiKey"), sym("verifyToken", "function", 9), sym("readSession", "function", 20),
    ]),
    src("apps/web/src/useLogin.ts", "apps/web", [sym("useLogin", "const")]),
    src("packages/core/src/util.ts", "packages/core", [sym("clamp")], 3),
    src("services/worker/src/dispatcher.ts", "services/worker", [sym("dispatchJob")]),
  ]);
  return { graph, index };
}

describe("suggestFacets", () => {
  it("groups intent-tagged nodes and folds in shared dependencies", () => {
    const { graph, index } = fixture();
    const auth = suggestFacets(graph, index).find((s) => s.tags.includes("intent:auth"));
    expect(auth).toBeDefined();
    expect(auth!.name).toBe("Authentication");
    expect(auth!.nodeIds).toContain("api");
    expect(auth!.nodeIds).toContain("web");
    // core: depended on by both members AND util-tagged — the "+ shared" slice.
    expect(auth!.sharedNodeIds).toContain("core");
    expect(auth!.nodeIds).not.toContain("worker");
  });

  it("skips suggestions that duplicate an existing facet", () => {
    const { graph, index } = fixture();
    const auth = suggestFacets(graph, index).find((s) => s.tags.includes("intent:auth"))!;
    const withFacet = { ...graph, facets: [createArchFacet("Auth", auth.nodeIds)] };
    expect(
      suggestFacets(withFacet, index).find((s) => s.tags.includes("intent:auth")),
    ).toBeUndefined();
  });

  it("is deterministic across calls", () => {
    const { graph, index } = fixture();
    expect(suggestFacets(graph, index)).toEqual(suggestFacets(graph, index));
  });

  it("titles unknown intent values from the tag value", () => {
    expect(conceptDisplayName("auth")).toBe("Authentication");
    expect(conceptDisplayName("rate-limiting")).toBe("Rate limiting");
  });
});

/* ---------------- facet lenses over the code map ---------------- */

describe("parseLensTags", () => {
  it("splits, trims and drops empties", () => {
    expect(parseLensTags("intent:auth, intent:payments ,")).toEqual([
      "intent:auth",
      "intent:payments",
    ]);
  });
});

describe("indexFacetVisibility", () => {
  /** auth.ts matches at file level (path), http.ts only via one symbol name. */
  const index = () =>
    buildCodeIndex([
      src("services/api/src/middleware/auth.ts", "services/api", [
        sym("requireApiKey"),
        sym("readSession", "function", 9),
      ]),
      src("services/api/src/http.ts", "services/api", [
        sym("verifyToken"),
        sym("plainHelper", "function", 30),
      ]),
      src("services/api/src/auth.test.ts", "services/api", [sym("testLogin")]),
      src("packages/core/src/math.ts", "packages/core", [sym("clamp")]),
    ]);

  it("exposes whole tagged files, tagged members, and their modules", () => {
    const vis = indexFacetVisibility(index(), ["intent:auth"]);
    expect(vis.files.get("services/api/src/middleware/auth.ts")).toBe("all");
    expect(vis.files.get("services/api/src/http.ts")).toEqual(new Set(["verifyToken"]));
    expect(vis.files.has("packages/core/src/math.ts")).toBe(false);
    expect([...vis.modules]).toEqual(["services/api"]);
    // 2 from the whole file + verifyToken
    expect(vis.memberCount).toBe(3);
    expect(vis.fileCount).toBe(2);
  });

  it("excludes test files unless the lens asks for them", () => {
    expect(indexFacetVisibility(index(), ["intent:auth"]).files.has("services/api/src/auth.test.ts")).toBe(false);
    expect(indexFacetVisibility(index(), ["role:test"]).files.has("services/api/src/auth.test.ts")).toBe(true);
  });

  it("an empty tag list exposes nothing", () => {
    const vis = indexFacetVisibility(index(), []);
    expect(vis.files.size).toBe(0);
    expect(vis.memberCount).toBe(0);
  });
});

describe("suggestIndexFacets", () => {
  it("suggests intents with enough tagged members, weightiest first", () => {
    const { index } = fixture();
    const suggestions = suggestIndexFacets(index);
    const auth = suggestions.find((s) => s.tags.includes("intent:auth"));
    expect(auth).toBeDefined();
    expect(auth!.name).toBe("Authentication");
    expect(auth!.members).toBeGreaterThanOrEqual(3);
    expect(auth!.modules).toBeGreaterThanOrEqual(2);
    expect(auth!.sampleFiles.length).toBeGreaterThan(0);
    // sorted by member weight, then name
    const weights = suggestions.map((s) => s.members);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("is deterministic and graph-free", () => {
    const { index } = fixture();
    expect(suggestIndexFacets(index)).toEqual(suggestIndexFacets(index));
  });
});

/* ---------------- enrichment interchange ---------------- */

describe("enrichment format", () => {
  it("EXAMPLE_ENRICHMENT round-trips through the envelope", () => {
    const text = serializeCrystalFile("enrichment", EXAMPLE_ENRICHMENT);
    expect(parseCrystalFile("enrichment", text)).toEqual(EXAMPLE_ENRICHMENT);
  });

  it("rejects payloads from a newer schema version", () => {
    const newer = { ...EXAMPLE_ENRICHMENT, schemaVersion: 999 };
    expect(() =>
      parseCrystalFile("enrichment", serializeCrystalFile("enrichment", newer)),
    ).toThrow(/newer/);
  });

  it("tolerates unknown enum values from well-meaning writers", () => {
    const parsed = CodeEnrichmentSchema.parse({
      schemaVersion: 1,
      entries: [
        {
          file: "a.ts",
          hash: "h",
          tags: [{ tag: "intent:auth", source: "llm-v2", confidence: 3 }],
        },
      ],
    });
    expect(parsed.entries[0]!.tags[0]!.source).toBe("agent");
    expect(parsed.entries[0]!.tags[0]!.confidence).toBe(1);
  });

  it("builds a prompt embedding files, hashes and the format spec", () => {
    const prompt = buildEnrichmentPrompt({
      files: [{ path: "a/auth.ts", hash: "abc123" }],
      outFile: ".crystal/index/enrichment-1.json",
    });
    expect(prompt).toContain("a/auth.ts (hash: abc123)");
    expect(prompt).toContain('.crystal/index/enrichment-1.json');
    expect(prompt).toContain('"kind": "enrichment"');
    expect(prompt).toContain("intent:auth");
  });
});

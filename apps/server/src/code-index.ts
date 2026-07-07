import fs from "node:fs/promises";
import {
  INDEX_DIR,
  buildCodeIndex,
  buildEnrichmentPrompt,
  parseCrystalFile,
  staleIndexFiles,
  type CodeEnrichment,
  type CodeIndex,
} from "@crystal/core";
import type { CodeMapAnalyzer } from "./code-map.js";
import { resolveInRoot } from "./paths.js";

/** At most this many files per enrichment dispatch (one cheap-agent run). */
const ENRICH_MAX_FILES = 50;

/**
 * The semantic code index of one workspace: heuristic tags rebuilt live from
 * the code map, merged with agent enrichments read from `.crystal/index/`.
 * Derived state like the code map itself — cached until either input changes.
 */
export class CodeIndexService {
  private cached: { index: CodeIndex; staleFiles: string[] } | null = null;
  private building: Promise<{ index: CodeIndex; staleFiles: string[] }> | null = null;

  constructor(
    private readonly root: string,
    private readonly codemap: CodeMapAnalyzer,
  ) {}

  /** Call when code or `.crystal/index/` changes; the next get() rebuilds. */
  invalidate(): void {
    this.cached = null;
  }

  async get(): Promise<{ index: CodeIndex; staleFiles: string[] }> {
    if (this.cached) return this.cached;
    this.building ??= this.build().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  private async build(): Promise<{ index: CodeIndex; staleFiles: string[] }> {
    const sources = await this.codemap.indexSourceFiles();
    const index = buildCodeIndex(sources, await this.loadEnrichments());
    index.generatedAt = new Date().toISOString();
    this.cached = { index, staleFiles: staleIndexFiles(index) };
    return this.cached;
  }

  private async loadEnrichments(): Promise<CodeEnrichment[]> {
    const dir = resolveInRoot(this.root, INDEX_DIR);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: CodeEnrichment[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const text = await fs.readFile(resolveInRoot(this.root, `${INDEX_DIR}/${name}`), "utf8");
        out.push(parseCrystalFile("enrichment", text));
      } catch (err) {
        console.warn(`[crystal] skipping unreadable enrichment ${name}:`, (err as Error).message);
      }
    }
    return out;
  }

  /**
   * The dispatch package for one enrichment run: which files the agent should
   * read (stale ones unless pinned, tests excluded, densest-first, capped) and
   * the prompt instructing it to write a fresh enrichment file.
   */
  async enrichmentDispatch(requested?: string[]): Promise<{ prompt: string; files: string[]; outFile: string }> {
    const { index, staleFiles } = await this.get();
    const byPath = new Map(index.files.map((f) => [f.path, f]));
    const pinned = requested?.filter((p) => byPath.has(p));
    const candidates = (pinned ?? staleFiles)
      .map((p) => byPath.get(p)!)
      .filter((f) => !f.tags.some((t) => t.tag === "role:test"))
      .sort((a, b) => b.symbols.length - a.symbols.length || a.path.localeCompare(b.path))
      .slice(0, ENRICH_MAX_FILES);
    if (candidates.length === 0) throw new Error("Nothing to index — every file has a fresh enrichment");
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const outFile = `${INDEX_DIR}/enrichment-${stamp}.json`;
    const files = candidates.map((f) => f.path);
    const prompt = buildEnrichmentPrompt({
      files: candidates.map((f) => ({ path: f.path, hash: f.hash })),
      outFile,
    });
    return { prompt, files, outFile };
  }
}

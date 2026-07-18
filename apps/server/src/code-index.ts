import fs from "node:fs/promises";
import {
  INDEX_DIR,
  buildCodeIndex,
  buildEnrichmentPrompt,
  parseCrystalFile,
  staleIndexFiles,
  type AgentRun,
  type CodeEnrichment,
  type CodeIndex,
  type IndexedFile,
} from "@crystal/core";
import type { CodeMapAnalyzer } from "./code-map.js";
import { resolveInRoot } from "./paths.js";

/** At most this many files per enrichment dispatch (one cheap-agent run). */
const ENRICH_MAX_FILES = 50;

/** One dispatched enrichment run plus what the backlog still holds beyond it. */
export interface EnrichmentBatch {
  run: AgentRun;
  files: string[];
  /** Dispatchable stale files left beyond this batch. */
  remaining: number;
}

/**
 * The semantic code index of one workspace: heuristic tags rebuilt live from
 * the code map, merged with agent enrichments read from `.crystal/index/`.
 * Derived state like the code map itself — cached until either input changes.
 */
export class CodeIndexService {
  private cached: { index: CodeIndex; staleFiles: string[] } | null = null;
  private building: Promise<{ index: CodeIndex; staleFiles: string[] }> | null = null;
  /** True while drainBacklog() is chaining batches (one full index at a time). */
  private draining = false;

  constructor(
    private readonly root: string,
    // Only the (async) source pull is needed, so the worker-backed facade
    // plugs in as well as the real analyzer.
    private readonly codemap: Pick<CodeMapAnalyzer, "indexSourceFiles">,
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

  /** Stale files an agent run may read (pinned override, tests excluded), densest-first. */
  private async dispatchCandidates(requested?: string[]): Promise<IndexedFile[]> {
    const { index, staleFiles } = await this.get();
    const byPath = new Map(index.files.map((f) => [f.path, f]));
    const pinned = requested?.filter((p) => byPath.has(p));
    return (pinned ?? staleFiles)
      .map((p) => byPath.get(p)!)
      .filter((f) => !f.tags.some((t) => t.tag === "role:test"))
      .sort((a, b) => b.symbols.length - a.symbols.length || a.path.localeCompare(b.path));
  }

  /**
   * The dispatch package for one enrichment run: which files the agent should
   * read (stale ones unless pinned, tests excluded, densest-first, capped),
   * the prompt instructing it to write a fresh enrichment file, and how many
   * dispatchable files remain beyond the cap.
   */
  async enrichmentDispatch(
    requested?: string[],
  ): Promise<{ prompt: string; files: string[]; outFile: string; remaining: number }> {
    const all = await this.dispatchCandidates(requested);
    const candidates = all.slice(0, ENRICH_MAX_FILES);
    if (candidates.length === 0) throw new Error("Nothing to index — every file has a fresh enrichment");
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const outFile = `${INDEX_DIR}/enrichment-${stamp}.json`;
    const files = candidates.map((f) => f.path);
    const prompt = buildEnrichmentPrompt({
      files: candidates.map((f) => ({ path: f.path, hash: f.hash })),
      outFile,
    });
    return { prompt, files, outFile, remaining: all.length - candidates.length };
  }

  /**
   * A full index: dispatch the first batch now (returned so the caller can
   * report its run), then keep dispatching follow-up batches in the background
   * until nothing dispatchable is stale, a run fails or is cancelled, or a
   * batch makes no progress (an agent that covers nothing must not loop).
   */
  async drainBacklog(
    startBatch: () => Promise<EnrichmentBatch>,
    settled: (runId: string) => Promise<AgentRun>,
  ): Promise<EnrichmentBatch> {
    if (this.draining) throw new Error("A full index is already running");
    this.draining = true;
    let first: EnrichmentBatch;
    try {
      first = await startBatch();
    } catch (err) {
      this.draining = false;
      throw err;
    }
    void this.drainRest(first, startBatch, settled);
    return first;
  }

  private async drainRest(
    first: EnrichmentBatch,
    startBatch: () => Promise<EnrichmentBatch>,
    settled: (runId: string) => Promise<AgentRun>,
  ): Promise<void> {
    try {
      let batch = first;
      let backlog = batch.files.length + batch.remaining;
      for (;;) {
        const run = await settled(batch.run.id);
        if (run.status !== "completed") {
          console.warn(`[crystal] full index stopped: batch run ${run.id} ${run.status}`);
          return;
        }
        // The enrichment file just landed; don't wait for the watcher debounce.
        this.invalidate();
        const stale = (await this.dispatchCandidates()).length;
        if (stale === 0) return;
        if (stale >= backlog) {
          console.warn(
            `[crystal] full index stopped: ${stale} files still stale after a batch made no progress`,
          );
          return;
        }
        backlog = stale;
        batch = await startBatch();
      }
    } catch (err) {
      console.warn("[crystal] full index stopped:", (err as Error).message);
    } finally {
      this.draining = false;
    }
  }
}

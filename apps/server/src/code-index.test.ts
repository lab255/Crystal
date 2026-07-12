import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENRICHMENT_SCHEMA_VERSION,
  INDEX_DIR,
  serializeCrystalFile,
  type AgentRun,
  type IndexSourceFile,
} from "@crystal/core";
import { CodeIndexService, type EnrichmentBatch } from "./code-index.js";
import type { CodeMapAnalyzer } from "./code-map.js";

const tmpRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of tmpRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** N one-symbol source files plus a service reading them from a real temp root. */
async function makeService(fileCount: number): Promise<{ svc: CodeIndexService; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-index-"));
  tmpRoots.push(root);
  const sources: IndexSourceFile[] = Array.from({ length: fileCount }, (_, i) => ({
    path: `src/f${String(i).padStart(2, "0")}.ts`,
    module: "m",
    hash: `h${i}`,
    importerModules: 0,
    symbols: [{ name: `fn${i}`, kind: "function", line: 1, exported: true }],
  }));
  const codemap = { indexSourceFiles: async () => sources } as unknown as CodeMapAnalyzer;
  return { svc: new CodeIndexService(root, codemap), root };
}

/** Simulate an indexing agent: write an enrichment covering `files` (no entries). */
async function writeCoverage(
  root: string,
  name: string,
  files: readonly { path: string; hash: string }[],
): Promise<void> {
  const dir = path.join(root, ...INDEX_DIR.split("/"));
  await fs.mkdir(dir, { recursive: true });
  const data = {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    generator: { name: "test", version: "" },
    generatedAt: "",
    entries: [],
    covered: files.map((f) => ({ file: f.path, hash: f.hash })),
    notes: [],
  };
  await fs.writeFile(path.join(dir, name), serializeCrystalFile("enrichment", data), "utf8");
}

async function until(cond: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not reached");
}

const fakeRun = (id: string, status: AgentRun["status"] = "running"): AgentRun =>
  ({ id, status }) as AgentRun;

describe("CodeIndexService.enrichmentDispatch", () => {
  it("caps the batch and reports the dispatchable files beyond it", async () => {
    const { svc } = await makeService(60);
    const dispatch = await svc.enrichmentDispatch();
    expect(dispatch.files).toHaveLength(50);
    expect(dispatch.remaining).toBe(10);
  });
});

describe("CodeIndexService.drainBacklog", () => {
  it("chains batches until nothing dispatchable is stale", async () => {
    const { svc, root } = await makeService(60);
    let batches = 0;
    let lastBatch: { path: string; hash: string }[] = [];

    const startBatch = async (): Promise<EnrichmentBatch> => {
      const dispatch = await svc.enrichmentDispatch();
      batches += 1;
      const { index } = await svc.get();
      const byPath = new Map(index.files.map((f) => [f.path, f.hash]));
      lastBatch = dispatch.files.map((p) => ({ path: p, hash: byPath.get(p)! }));
      return { run: fakeRun(`r${batches}`), files: dispatch.files, remaining: dispatch.remaining };
    };
    // The "agent" covers every file in its batch before the run settles.
    const settled = async (runId: string): Promise<AgentRun> => {
      await writeCoverage(root, `${runId}.json`, lastBatch);
      return fakeRun(runId, "completed");
    };

    const first = await svc.drainBacklog(startBatch, settled);
    expect(first.files).toHaveLength(50);
    expect(first.remaining).toBe(10);

    await until(async () => {
      svc.invalidate();
      return (await svc.get()).staleFiles.length === 0;
    });
    expect(batches).toBe(2);
  });

  it("stops when a completed batch made no progress", async () => {
    const { svc } = await makeService(60);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let batches = 0;
    const startBatch = async (): Promise<EnrichmentBatch> => {
      const dispatch = await svc.enrichmentDispatch();
      batches += 1;
      return { run: fakeRun(`r${batches}`), files: dispatch.files, remaining: dispatch.remaining };
    };
    // The run completes but never writes an enrichment file.
    await svc.drainBacklog(startBatch, async (id) => fakeRun(id, "completed"));

    await until(() => warn.mock.calls.some((c) => String(c[0]).includes("no progress")));
    expect(batches).toBe(1);
  });

  it("rejects a second full index while one is draining", async () => {
    const { svc } = await makeService(60);
    const startBatch = async (): Promise<EnrichmentBatch> => {
      const dispatch = await svc.enrichmentDispatch();
      return { run: fakeRun("r1"), files: dispatch.files, remaining: dispatch.remaining };
    };
    const never = (): Promise<AgentRun> => new Promise(() => {});
    await svc.drainBacklog(startBatch, never);
    await expect(svc.drainBacklog(startBatch, never)).rejects.toThrow(
      "A full index is already running",
    );
  });
});

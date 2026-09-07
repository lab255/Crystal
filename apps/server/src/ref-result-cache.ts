import fs from "node:fs/promises";
import { gitResolveRef } from "./git.js";
import { resolveInRoot } from "./paths.js";
import type { JobResult } from "./job-registry.js";
import type { JobQueue } from "./job-queue.js";

type RefJob = "refOverviewSources" | "refSurfacesSnapshot";

/** Completed DTOs only: repeat reviews avoid even a worker structured clone. */
export class RefResultCache {
  private results = new Map<string, JobResult<RefJob>>();
  private disposed = false;

  constructor(private readonly queue: JobQueue) {}

  async get<N extends RefJob>(
    name: N,
    root: string,
    repoRel: string,
    ref: string,
    ws = root,
  ): Promise<JobResult<N>> {
    if (this.disposed) throw new Error("Ref result cache disposed");
    const [commit, config] = await Promise.all([
      gitResolveRef(resolveInRoot(root, repoRel || "."), ref),
      fs.readFile(resolveInRoot(root, ".crystal/codemap.json"), "utf8").catch(() => null),
    ]);
    const key = JSON.stringify([root, repoRel, commit, name, config]);
    const hit = this.results.get(key);
    if (hit) return hit as JobResult<N>;
    const result = await this.queue.run(name, [root, repoRel, commit], {
      timeoutMs: 600_000,
      coalesceKey: JSON.stringify([ws, key]),
    });
    if (!this.disposed) {
      this.results.set(key, result);
      // Match ref-snapshot's insertion-order eviction; failures never enter the cache.
      for (const k of this.results.keys()) {
        if (this.results.size <= 4) break;
        this.results.delete(k);
      }
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.results.clear();
  }
}

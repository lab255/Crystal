import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { JobName, JobArgs, JobResult } from "./job-registry.js";

function workerEntry(): string | null {
  const candidates: string[] = [];
  const base = process.env.CRYSTAL_SIDECAR_MODULE_BASE;
  if (base) candidates.push(path.join(base, "jobs-worker.cjs"));
  candidates.push(path.join(path.dirname(process.execPath), "jobs-worker.cjs"));
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(selfDir, "jobs-worker.cjs"));
    candidates.push(path.join(selfDir, "jobs-worker.ts"));
  } catch {
    /* import.meta unavailable in this build shape */
  }
  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable — try the next */
    }
  }
  return null;
}

/**
 * Boot script for running the TypeScript worker source directly (dev). The
 * parent's tsx hooks don't fully propagate into worker threads (the entry
 * transforms but `.js` → `.ts` import mapping is lost), so the worker
 * registers tsx's hooks itself before importing the entry. Any boot failure
 * exits non-zero, which the host turns into the in-process fallback.
 */
function tsBootScript(entry: string): string {
  const entryUrl = JSON.stringify(pathToFileURL(entry).href);
  let tsxApi: string | null = null;
  try {
    tsxApi = import.meta.resolve("tsx/esm/api");
  } catch {
    /* no tsx in this environment — plain import may still work */
  }
  const boot = tsxApi
    ? `import(${JSON.stringify(tsxApi)}).then((tsx) => { tsx.register(); return import(${entryUrl}); })`
    : `import(${entryUrl})`;
  return (
    boot +
    `.catch((err) => { console.error("[crystal] jobs worker boot failed:", err && err.message); process.exit(1); });`
  );
}

const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

interface Job {
  id: number;
  name: JobName;
  args: JobArgs;
  key?: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker | null;
  job?: Job;
  terminating?: boolean;
}

export class JobQueue {
  private slots: Slot[];
  private waiting: Job[] = [];
  private pending = new Map<number, Job>();
  private coalesced = new Map<string, Promise<unknown>>();
  private nextId = 1;
  private disposed = false;
  private broken = false;
  private everReady = false;
  private crashTimes: number[] = [];

  constructor(poolSize = Math.max(1, Math.min(2, os.availableParallelism() - 1))) {
    if (!Number.isInteger(poolSize) || poolSize < 1) throw new Error("Invalid job pool size");
    this.slots = Array.from({ length: poolSize }, () => ({ worker: null }));
  }

  run<N extends JobName>(
    name: N,
    args: JobArgs,
    options: { timeoutMs: number; coalesceKey?: string },
  ): Promise<JobResult<N>> {
    if (this.disposed) return Promise.reject(new Error("Job queue disposed"));
    const key = options.coalesceKey;
    const hit = key === undefined ? undefined : this.coalesced.get(key);
    if (hit) return hit as Promise<JobResult<N>>;
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job: Job = { id: this.nextId++, name, args, key, resolve, reject };
    this.pending.set(job.id, job);
    if (key !== undefined) this.coalesced.set(key, promise);
    // Include queue wait in the deadline, so queued callers cannot hang forever either.
    if (options.timeoutMs > 0) {
      job.timer = setTimeout(() => {
        const slot = this.slots.find((s) => s.job === job);
        const worker = slot?.worker;
        if (slot && worker) slot.terminating = true;
        this.finish(job, new Error(`Job ${name} timed out after ${options.timeoutMs}ms`));
        void worker?.terminate();
      }, options.timeoutMs);
    }
    this.waiting.push(job);
    this.dispatch();
    return promise as Promise<JobResult<N>>;
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots) void slot.worker?.terminate();
    for (const job of this.pending.values()) this.finish(job, new Error("Job queue disposed"));
    this.waiting = [];
  }

  private finish(job: Job, error: Error | null, result?: unknown): void {
    if (!this.pending.delete(job.id)) return;
    clearTimeout(job.timer);
    if (job.key !== undefined) this.coalesced.delete(job.key);
    this.waiting = this.waiting.filter((j) => j !== job);
    const slot = this.slots.find((s) => s.job === job);
    if (slot) slot.job = undefined;
    if (error) job.reject(error);
    else job.resolve(result);
    this.dispatch();
  }

  private dispatch(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (!this.waiting.length) break;
      if (slot.job || slot.terminating) continue;
      const job = this.waiting.shift()!;
      slot.job = job;
      const worker = this.broken ? null : this.ensureWorker(slot);
      if (worker) {
        try {
          worker.postMessage({ id: job.id, name: job.name, args: job.args });
        } catch (err) {
          this.finish(job, err as Error);
        }
      } else {
        this.runLocal(job);
      }
    }
  }

  private runLocal(job: Job): void {
    void import("./job-registry.js").then(async ({ jobs }): Promise<JobResult<JobName> | undefined> => {
      if (!this.pending.has(job.id)) return;
      if (!Object.hasOwn(jobs, job.name)) throw new Error(`Unknown job: ${job.name}`);
      return jobs[job.name](...job.args);
    }).then(
      (result) => this.finish(job, null, result),
      (err: Error) => this.finish(job, err),
    );
  }

  private ensureWorker(slot: Slot): Worker | null {
    if (slot.worker) return slot.worker;
    const entry = workerEntry();
    if (!entry) {
      this.markBroken("no worker entry found");
      return null;
    }
    let worker: Worker;
    try {
      worker = entry.endsWith(".ts")
        ? new Worker(tsBootScript(entry), { eval: true })
        : new Worker(entry);
    } catch (err) {
      this.markBroken((err as Error).message);
      return null;
    }
    slot.worker = worker;
    // Attach synchronously: a boot error must never become an unhandled error event.
    worker.on("error", (err) => {
      if (this.everReady) console.warn("[crystal] jobs worker error:", err.message);
    });
    worker.on("exit", (code) => this.onExit(slot, worker, code));
    worker.on("message", (msg: {
      type: "ready" | "reply";
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    }) => {
      if (slot.worker !== worker || slot.terminating) return;
      if (msg.type === "ready") {
        this.everReady = true;
        return;
      }
      const job = slot.job;
      if (job?.id === msg.id) {
        this.finish(job, msg.ok ? null : new Error(msg.error ?? "Job failed"), msg.result);
      }
    });
    return worker;
  }

  private onExit(slot: Slot, worker: Worker, code: number): void {
    if (slot.worker !== worker) return;
    slot.worker = null;
    const timedOut = slot.terminating;
    slot.terminating = false;
    const job = slot.job;
    if (this.disposed) return;
    if (!timedOut) {
      if (!this.everReady) this.markBroken(`worker exited with code ${code} before ready`);
      else {
        const now = Date.now();
        this.crashTimes = [...this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
        if (this.crashTimes.length > MAX_CRASHES) this.markBroken("workers crashing repeatedly");
      }
    }
    if (job) {
      if (this.broken) this.runLocal(job);
      else this.finish(job, new Error("Job worker restarted — retry"));
    }
    this.dispatch();
  }

  private markBroken(reason: string): void {
    if (this.broken) return;
    this.broken = true;
    console.warn(`[crystal] jobs running in-process (${reason})`);
  }
}

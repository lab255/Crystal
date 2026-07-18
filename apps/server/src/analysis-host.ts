import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { CodeMapAnalyzer } from "./code-map.js";

/**
 * Main-thread side of the analysis worker (see analysis-worker.ts). The
 * CPU-heavy code-map work runs in one long-lived worker thread per workspace;
 * bridge handlers talk to it through an async facade with the analyzer's own
 * method surface. If the worker can't spawn (no TS loader under vitest, a
 * missing bundle) or crash-loops, the backend degrades to an in-process
 * analyzer — slower under load, but never a dead code map.
 */

/** The analyzer's methods with every return type promoted to a Promise. */
export type CodeMapFacade = {
  [K in keyof CodeMapAnalyzer as CodeMapAnalyzer[K] extends (...args: never[]) => unknown
    ? K
    : never]: CodeMapAnalyzer[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

interface Pending {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  args: unknown[];
}

type WorkerReply = { type: "ready" } | { id: number; ok: boolean; result?: unknown; error?: string };

/**
 * Locate the worker entry. Order: staged sidecar bundle (Tauri resource dir /
 * next to the SEA executable), the built dist sibling, then the TypeScript
 * source (tsx dev — worker threads inherit tsx's loader via execArgv).
 */
function workerEntry(): string | null {
  const candidates: string[] = [];
  const base = process.env.CRYSTAL_SIDECAR_MODULE_BASE;
  if (base) candidates.push(path.join(base, "analysis-worker.cjs"));
  candidates.push(path.join(path.dirname(process.execPath), "analysis-worker.cjs"));
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(selfDir, "analysis-worker.cjs"));
    candidates.push(path.join(selfDir, "analysis-worker.ts"));
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
    `.catch((err) => { console.error("[crystal] analysis worker boot failed:", err && err.message); process.exit(1); });`
  );
}

/** Crashes within this window count toward the give-up threshold. */
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

export class AnalysisBackend {
  private worker: Worker | null = null;
  /** Some worker of ours completed boot once — later exits are crashes. */
  private everReady = false;
  /** Permanent in-process mode (spawn impossible or crash storm). */
  private broken = false;
  private disposed = false;
  private crashTimes: number[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private localAnalyzer: CodeMapAnalyzer | null = null;

  constructor(private readonly root: string) {}

  /** How calls are currently served — for logs and tests. */
  get mode(): "worker" | "local" | "idle" {
    if (this.broken) return "local";
    return this.worker ? "worker" : "idle";
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Analysis backend disposed"));
    if (this.broken) return this.callLocal(method, args);
    const worker = this.ensureWorker();
    if (!worker) return this.callLocal(method, args);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, method, args });
      worker.postMessage({ id, method, args });
    });
  }

  dispose(): void {
    this.disposed = true;
    void this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("Analysis backend disposed"));
    this.pending.clear();
  }

  private async callLocal(method: string, args: unknown[]): Promise<unknown> {
    if (!this.localAnalyzer) {
      const { CodeMapAnalyzer } = await import("./code-map.js");
      this.localAnalyzer ??= new CodeMapAnalyzer(this.root);
    }
    const target = this.localAnalyzer as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = target[method];
    if (typeof fn !== "function") throw new Error(`Unknown analysis method: ${method}`);
    return fn.apply(this.localAnalyzer, args);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    const entry = workerEntry();
    if (!entry) {
      this.markBroken("no worker entry found");
      return null;
    }
    let worker: Worker;
    try {
      worker = entry.endsWith(".ts")
        ? new Worker(tsBootScript(entry), { eval: true, workerData: { root: this.root } })
        : new Worker(entry, { workerData: { root: this.root } });
    } catch (err) {
      this.markBroken((err as Error).message);
      return null;
    }
    this.worker = worker;
    worker.on("message", (msg: WorkerReply) => {
      if ("type" in msg && msg.type === "ready") {
        this.everReady = true;
        return;
      }
      const reply = msg as Exclude<WorkerReply, { type: "ready" }>;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.result);
      else p.reject(new Error(reply.error ?? "analysis failed"));
    });
    worker.on("error", (err) => {
      // The exit handler owns recovery; this is just visibility.
      if (this.everReady) {
        console.warn(`[crystal] analysis worker error (${this.root}):`, err.message ?? err);
      }
    });
    worker.on("exit", (code) => this.onExit(worker, code));
    return worker;
  }

  private onExit(worker: Worker, code: number): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const stranded = [...this.pending.values()];
    this.pending.clear();
    if (this.disposed) {
      for (const p of stranded) p.reject(new Error("Analysis backend disposed"));
      return;
    }
    if (!this.everReady) {
      // Never booted: no TS loader (tests), missing bundle. Serve the queue
      // in-process and stay there.
      this.markBroken(`worker exited with code ${code} before ready`);
      for (const p of stranded) this.callLocal(p.method, p.args).then(p.resolve, p.reject);
      return;
    }
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashTimes.length > MAX_CRASHES) {
      this.markBroken("worker crashing repeatedly");
      for (const p of stranded) this.callLocal(p.method, p.args).then(p.resolve, p.reject);
      return;
    }
    console.warn(
      `[crystal] analysis worker exited (code ${code}) for ${this.root} — restarting on next call`,
    );
    for (const p of stranded) p.reject(new Error("Analysis worker restarted — retry"));
  }

  private markBroken(reason: string): void {
    if (this.broken) return;
    this.broken = true;
    console.warn(`[crystal] analysis running in-process for ${this.root} (${reason})`);
  }
}

/**
 * The analyzer's method surface as an async proxy over a backend. Every
 * method call becomes one worker round-trip; `invalidate` (fired from
 * watchers) never surfaces a rejection — a dead worker must not take the
 * watcher down with it.
 */
export function createCodeMapFacade(backend: AnalysisBackend): CodeMapFacade {
  const cache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return new Proxy({} as CodeMapFacade, {
    get: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      // Never look like a thenable — `await` on the facade must be a no-op.
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn =
          prop === "invalidate"
            ? (...args: unknown[]) => backend.call(prop, args).catch(() => {})
            : (...args: unknown[]) => backend.call(prop, args);
        cache.set(prop, fn);
      }
      return fn;
    },
  });
}

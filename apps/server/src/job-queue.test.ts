import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobQueue } from "./job-queue.js";

const state = vi.hoisted(() => ({ bootFails: true, workers: [] as MockWorker[] }));
const run = vi.hoisted(() => vi.fn());
vi.mock("./job-registry.js", () => ({ jobs: { refOverviewSources: run } }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() {
      super();
      state.workers.push(this as unknown as MockWorker);
      queueMicrotask(() => {
        if (state.bootFails) {
          this.emit("error", new Error("No TS loader"));
          this.emit("exit", 1);
        } else this.emit("message", { type: "ready" });
      });
    }
  },
}));
type MockWorker = EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const queues: JobQueue[] = [];
const args: [string, string, string] = ["/repo", ".", "HEAD"];
const options = { timeoutMs: 1000, coalesceKey: "same" };
const queue = (size = 1) => { const q = new JobQueue(size); queues.push(q); return q; };
beforeEach(() => { state.bootFails = true; state.workers = []; run.mockReset(); });
afterEach(() => { queues.splice(0).forEach((q) => q.dispose()); vi.useRealTimers(); });

describe("JobQueue", () => {
  it("falls back after a boot error, coalesces and clears settled keys", async () => {
    run.mockResolvedValue({ commit: "abc", sources: [] });
    const q = queue();
    const first = q.run("refOverviewSources", args, options);
    expect(q.run("refOverviewSources", args, options)).toBe(first);
    await expect(first).resolves.toEqual({ commit: "abc", sources: [] });
    expect(run).toHaveBeenCalledTimes(1);
    await q.run("refOverviewSources", args, options);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("times out fallback jobs and allows another job", async () => {
    vi.useFakeTimers();
    run.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ sources: [] });
    const q = queue();
    const first = q.run("refOverviewSources", args, options);
    const rejected = expect(first).rejects.toThrow("refOverviewSources timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await expect(q.run("refOverviewSources", args, options)).resolves.toEqual({ sources: [] });
  });

  it("dispose rejects running and queued fallback jobs", async () => {
    run.mockImplementation(() => new Promise(() => {}));
    const q = queue();
    const a = q.run("refOverviewSources", args, options);
    const b = q.run("refOverviewSources", args, { timeoutMs: 1000 });
    const checks = [expect(a).rejects.toThrow("disposed"), expect(b).rejects.toThrow("disposed")];
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    q.dispose();
    await Promise.all(checks);
    await expect(q.run("refOverviewSources", args, options)).rejects.toThrow("disposed");
  });

  it("dispatches FIFO to idle workers up to the pool limit", async () => {
    state.bootFails = false;
    const q = queue(2);
    const tasks = Array.from({ length: 3 }, () => q.run("refOverviewSources", args, { timeoutMs: 1000 }));
    expect(state.workers).toHaveLength(2);
    const a = state.workers[0]!;
    const b = state.workers[1]!;
    expect(a.postMessage).toHaveBeenCalledTimes(1);
    b.emit("message", { type: "reply", id: 2, ok: true, result: 2 });
    expect(b.postMessage.mock.calls[1]![0].id).toBe(3);
    a.emit("message", { type: "reply", id: 1, ok: true, result: 1 });
    b.emit("message", { type: "reply", id: 3, ok: true, result: 3 });
    expect(await Promise.all(tasks)).toEqual([1, 2, 3]);
  });

  it("terminates timed-out workers and lazily replaces them without crash give-up", async () => {
    vi.useFakeTimers();
    state.bootFails = false;
    const q = queue();
    for (let i = 0; i < 5; i++) {
      const task = q.run("refOverviewSources", args, options);
      const rejected = expect(task).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(state.workers).toHaveLength(i + 1);
      expect(state.workers[i]!.terminate).toHaveBeenCalledTimes(1);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

it("gives up after a crash storm and serves the stranded job locally", async () => {
  state.bootFails = false;
  run.mockResolvedValue({ commit: "abc", sources: [] });
  const q = queue();
  for (let i = 0; i < 4; i++) {
    const task = q.run("refOverviewSources", args, options);
    await Promise.resolve();
    const check = i < 3
      ? expect(task).rejects.toThrow("Job worker restarted — retry")
      : expect(task).resolves.toHaveProperty("commit", "abc");
    state.workers[i]!.emit("exit", 1);
    await check;
  }
  await q.run("refOverviewSources", args, options);
  expect(state.workers).toHaveLength(4);
  expect(run).toHaveBeenCalledTimes(2);
});

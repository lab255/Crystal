import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisBackend } from "./analysis-host.js";

const workers = vi.hoisted(() => [] as MockWorker[]);
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() {
      super();
      workers.push(this as unknown as MockWorker);
      queueMicrotask(() => this.emit("message", { type: "ready" }));
    }
  },
}));
type MockWorker = EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> };
const backends: AnalysisBackend[] = [];
afterEach(() => { backends.splice(0).forEach((b) => b.dispose()); workers.length = 0; vi.useRealTimers(); });
const backend = () => { const b = new AnalysisBackend("/repo", "ws", { summary: 100, fileDetail: 1000 }); backends.push(b); return b; };

it("coalesces identical method and args until settlement, except invalidate", async () => {
  const b = backend();
  const a = b.call("summary", []);
  expect(b.call("summary", [])).toBe(a);
  workers[0]!.emit("message", { type: "reply", id: 1, ok: true, result: {} });
  await a;
  const next = b.call("summary", []);
  expect(next).not.toBe(a);
  const x = b.call("invalidate", []);
  const y = b.call("invalidate", []);
  expect(x).not.toBe(y);
  for (const id of [2, 3, 4]) workers[0]!.emit("message", { type: "reply", id, ok: true });
  await Promise.all([next, x, y]);
});

it("timeouts terminate the worker, reject stranded calls, and never count as crashes", async () => {
  vi.useFakeTimers();
  const b = backend();
  for (let i = 0; i < 5; i++) {
    const a = b.call("summary", []);
    const stranded = b.call("fileDetail", ["a.ts"]);
    const checks = [expect(a).rejects.toThrow("summary timed out after 100ms"), expect(stranded).rejects.toThrow("Analysis worker restarted — retry")];
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(checks);
    expect(workers[i]!.terminate).toHaveBeenCalledTimes(1);
    expect(b.mode).toBe("idle");
  }
});

it("clears watchdogs on normal replies and dispose", async () => {
  vi.useFakeTimers();
  const b = backend();
  const a = b.call("summary", []);
  workers[0]!.emit("message", { type: "reply", id: 1, ok: true });
  await a;
  await vi.advanceTimersByTimeAsync(1000);
  expect(workers[0]!.terminate).not.toHaveBeenCalled();
  const pending = b.call("summary", []);
  const check = expect(pending).rejects.toThrow("disposed");
  b.dispose();
  await check;
  expect(vi.getTimerCount()).toBe(0);
});

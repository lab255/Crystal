import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerMemoController, type WorkerMemoResult } from "./use-worker-memo.js";

class FakeWorker<I, O> {
  messages: Array<{ reqId: number; input: I }> = [];
  terminated = false;
  onmessage: ((event: MessageEvent<{ reqId: number; output?: O; error?: string }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: { reqId: number; input: I }): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(reply: { reqId: number; output?: O; error?: string }): void {
    this.onmessage?.({ data: reply } as MessageEvent<typeof reply>);
  }

  fail(): void {
    this.onerror?.({} as ErrorEvent);
  }
}

function harness() {
  const workers: FakeWorker<string, string>[] = [];
  const results: WorkerMemoResult<string>[] = [];
  const computeSync = vi.fn((input: string) => `sync:${input}`);
  const controller = new WorkerMemoController<string, string>(
    () => {
      const worker = new FakeWorker<string, string>();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    computeSync,
    (result) => results.push(result),
  );
  const latest = () => results.at(-1)!;
  return { controller, workers, results, computeSync, latest };
}

describe("WorkerMemoController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("delivers a normal worker result", () => {
    const { controller, workers, computeSync, latest } = harness();
    controller.start("a");
    expect(latest()).toEqual({ value: null, pending: true });
    workers[0]!.reply({ reqId: 1, output: "worker:a" });
    expect(latest()).toEqual({ value: "worker:a", pending: false });
    expect(computeSync).not.toHaveBeenCalled();
  });

  it("retries one stall in a fresh worker with a doubled watchdog", () => {
    const { controller, workers, computeSync, latest } = harness();
    controller.start("a");
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.messages[0]).toEqual({ reqId: 1, input: "a" });

    vi.advanceTimersByTime(119_999);
    expect(latest().pending).toBe(true);
    workers[1]!.reply({ reqId: 1, output: "retried:a" });
    expect(latest()).toEqual({ value: "retried:a", pending: false });
    expect(computeSync).not.toHaveBeenCalled();
  });

  it("gives up after the retry, preserves value, and uses a fresh worker next time", () => {
    const { controller, workers, computeSync, latest } = harness();
    controller.start("good");
    workers[0]!.reply({ reqId: 1, output: "last-good" });

    controller.start("huge");
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(120_000);
    expect(latest()).toEqual({ value: "last-good", pending: false });
    expect(workers[1]!.terminated).toBe(true);
    expect(computeSync).not.toHaveBeenCalled();

    controller.start("next");
    expect(workers).toHaveLength(3);
    expect(workers[2]!.messages[0]).toEqual({ reqId: 3, input: "next" });
  });

  it("settles a compute error without disabling the worker", () => {
    const { controller, workers, computeSync, latest } = harness();
    controller.start("bad");
    workers[0]!.reply({ reqId: 1, error: "deterministic failure" });
    expect(latest()).toEqual({ value: null, pending: false });
    expect(workers[0]!.terminated).toBe(false);

    controller.start("good");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.messages[1]).toEqual({ reqId: 2, input: "good" });
    workers[0]!.reply({ reqId: 2, output: "worker:good" });
    expect(latest()).toEqual({ value: "worker:good", pending: false });
    expect(computeSync).not.toHaveBeenCalled();
  });

  it("permanently uses sync fallback after worker.onerror", () => {
    const { controller, workers, computeSync, latest } = harness();
    controller.start("a");
    workers[0]!.fail();
    expect(latest()).toEqual({ value: "sync:a", pending: false });
    expect(workers[0]!.terminated).toBe(true);

    controller.start("b");
    expect(workers).toHaveLength(1);
    expect(latest()).toEqual({ value: "sync:b", pending: false });
    expect(computeSync).toHaveBeenCalledTimes(2);
  });

  it("abandons a retry when a newer input takes over its worker", () => {
    const { controller, workers, latest } = harness();
    controller.start("old");
    vi.advanceTimersByTime(60_000);
    controller.start("new");
    workers[1]!.reply({ reqId: 2, output: "worker:new" });
    vi.advanceTimersByTime(120_000);
    expect(workers[1]!.terminated).toBe(false);
    expect(latest()).toEqual({ value: "worker:new", pending: false });
  });
});

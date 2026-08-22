import { useEffect, useRef, useState } from "react";

export interface WorkerMemoResult<O> {
  /** Last completed output — held while a newer input computes (no flicker). */
  value: O | null;
  /** True while the worker is computing a newer input than `value` reflects. */
  pending: boolean;
}

interface WorkerReply<O> {
  reqId: number;
  output?: O;
  error?: string;
}

const WORKER_STALL_MS = 60_000;

/** @internal Exported for policy tests without requiring a DOM renderer. */
export class WorkerMemoController<I, O> {
  private worker: Worker | null = null;
  private broken: boolean;
  private reqId = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private value: O | null = null;

  constructor(
    private readonly makeWorker: (() => Worker) | null,
    private readonly computeSync: (input: I) => O,
    private readonly update: (result: WorkerMemoResult<O>) => void,
  ) {
    this.broken = makeWorker === null;
  }

  start(input: I | null): void {
    const reqId = ++this.reqId;
    this.clearWatchdog();
    if (input === null) {
      this.value = null;
      this.update({ value: null, pending: false });
      return;
    }

    this.update({ value: this.value, pending: true });
    if (this.broken) {
      this.syncFallback(input, reqId);
      return;
    }
    this.run(input, reqId, 0);
  }

  destroy(): void {
    this.clearWatchdog();
    this.worker?.terminate();
    this.worker = null;
  }

  private run(input: I, reqId: number, attempt: 0 | 1): void {
    let worker = this.worker;
    if (!worker) {
      try {
        worker = this.makeWorker!();
        this.worker = worker;
      } catch (err) {
        console.warn("[crystal] scene worker unavailable:", (err as Error).message);
        this.broken = true;
        this.syncFallback(input, reqId);
        return;
      }
    }

    worker.onmessage = (event: MessageEvent<WorkerReply<O>>) => {
      const { reqId: doneReq, output, error } = event.data;
      if (doneReq !== this.reqId || doneReq !== reqId || this.worker !== worker) return;
      this.clearWatchdog();
      if (error !== undefined) {
        console.warn("[crystal] scene worker failed:", error);
        this.settle(reqId);
        return;
      }
      this.value = output as O;
      this.update({ value: this.value, pending: false });
    };
    worker.onerror = () => {
      if (this.reqId !== reqId || this.worker !== worker) return;
      this.disable(worker);
      this.broken = true;
      this.syncFallback(input, reqId);
    };

    try {
      worker.postMessage({ reqId, input });
    } catch (err) {
      console.warn("[crystal] scene worker post failed:", (err as Error).message);
      this.disable(worker);
      this.broken = true;
      this.syncFallback(input, reqId);
      return;
    }

    const stallMs = WORKER_STALL_MS * (attempt + 1);
    this.watchdog = setTimeout(() => {
      if (this.reqId !== reqId || this.worker !== worker) return;
      this.disable(worker);
      if (attempt === 0) {
        console.warn(`[crystal] scene worker stalled for ${stallMs / 1_000}s; retrying`);
        if (this.reqId === reqId) this.run(input, reqId, 1);
      } else {
        console.warn(`[crystal] scene worker retry stalled for ${stallMs / 1_000}s; giving up`);
        this.settle(reqId);
      }
    }, stallMs);
  }

  private disable(worker: Worker): void {
    worker.terminate();
    if (this.worker === worker) this.worker = null;
    this.clearWatchdog();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private settle(reqId: number): void {
    if (this.reqId === reqId) this.update({ value: this.value, pending: false });
  }

  private syncFallback(input: I, reqId: number): void {
    try {
      const output = this.computeSync(input);
      if (this.reqId === reqId) {
        this.value = output;
        this.update({ value: output, pending: false });
      }
    } catch (err) {
      console.warn("[crystal] worker-memo compute failed:", (err as Error).message);
      this.settle(reqId);
    }
  }
}

/**
 * Offload a pure input → output computation to a module Web Worker so heavy
 * scene/layout builds do not block the UI thread.
 *
 * Worker stalls retry once in a fresh worker and never fall back to the main
 * thread. Compute errors settle only their request. Worker plumbing failures,
 * unavailable workers, and non-clonable messages use the synchronous fallback.
 */
export function useWorkerMemo<I, O>(
  makeWorker: (() => Worker) | null,
  computeSync: (input: I) => O,
  input: I | null,
): WorkerMemoResult<O> {
  const [result, setResult] = useState<WorkerMemoResult<O>>({ value: null, pending: false });
  const computeRef = useRef(computeSync);
  computeRef.current = computeSync;
  const controllerRef = useRef<WorkerMemoController<I, O> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new WorkerMemoController(
      makeWorker,
      (nextInput) => computeRef.current(nextInput),
      setResult,
    );
  }

  useEffect(() => () => controllerRef.current?.destroy(), []);
  useEffect(() => controllerRef.current!.start(input), [input]);

  return result;
}

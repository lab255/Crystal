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

/**
 * Offload a pure input → output computation to a module Web Worker so heavy
 * scene/layout builds (dagre at FormSG scale) stop blocking the UI thread.
 *
 * The worker protocol is `postMessage({reqId, input})` in and
 * `postMessage({reqId, output | error})` out — see the *.worker.ts entries.
 * Both sides must be structured-clonable (Maps and Sets are fine).
 *
 * Falls back to computing synchronously — exactly the old useMemo behavior —
 * when Workers don't exist (tests, SSR) or the worker errors, so the view
 * can never end up scene-less because of worker plumbing.
 */
export function useWorkerMemo<I, O>(
  makeWorker: (() => Worker) | null,
  computeSync: (input: I) => O,
  input: I | null,
): WorkerMemoResult<O> {
  const [state, setState] = useState<{ value: O | null; forReq: number }>({
    value: null,
    forReq: 0,
  });
  const workerRef = useRef<Worker | null>(null);
  const brokenRef = useRef(makeWorker === null);
  const reqIdRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computeRef = useRef(computeSync);
  computeRef.current = computeSync;
  const makeWorkerRef = useRef(makeWorker);

  useEffect(() => {
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    if (input === null) {
      setState({ value: null, forReq: reqId });
      return;
    }
    const syncFallback = () => {
      try {
        const output = computeRef.current(input);
        if (reqIdRef.current === reqId) setState({ value: output, forReq: reqId });
      } catch (err) {
        console.warn("[crystal] worker-memo compute failed:", (err as Error).message);
        // Keep the last good value, but settle this request so callers do not
        // remain `pending` forever when both worker and fallback fail.
        if (reqIdRef.current === reqId) {
          setState((current) => ({ value: current.value, forReq: reqId }));
        }
      }
    };
    if (brokenRef.current) {
      syncFallback();
      return;
    }
    if (!workerRef.current) {
      try {
        const worker = makeWorkerRef.current!();
        workerRef.current = worker;
      } catch (err) {
        console.warn("[crystal] scene worker unavailable:", (err as Error).message);
        brokenRef.current = true;
        syncFallback();
        return;
      }
    }
    const worker = workerRef.current;
    const disableWorker = () => {
      brokenRef.current = true;
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    };
    // Refresh the handlers for every input so an error always falls back for
    // the latest request, not whichever request happened to create the worker.
    worker.onmessage = (e: MessageEvent<WorkerReply<O>>) => {
      const { reqId: doneReq, output, error } = e.data;
      if (doneReq !== reqIdRef.current) return; // stale reply
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      if (error !== undefined) {
        console.warn("[crystal] scene worker failed:", error);
        disableWorker();
        syncFallback();
        return;
      }
      setState({ value: output as O, forReq: doneReq });
    };
    worker.onerror = () => {
      // Worker plumbing broke (bundling, CSP) — degrade to the old
      // synchronous path for the rest of this view's life.
      disableWorker();
      syncFallback();
    };
    try {
      worker.postMessage({ reqId, input });
    } catch (err) {
      // Non-clonable input is a programming error; keep the view alive.
      console.warn("[crystal] scene worker post failed:", (err as Error).message);
      disableWorker();
      syncFallback();
      return;
    }
    watchdogRef.current = setTimeout(() => {
      if (reqIdRef.current !== reqId || workerRef.current !== worker) return;
      console.warn(`[crystal] scene worker stalled for ${WORKER_STALL_MS / 1_000}s; falling back`);
      disableWorker();
      syncFallback();
    }, WORKER_STALL_MS);
  }, [input]);

  return { value: state.value, pending: state.forReq !== reqIdRef.current };
}

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
  const computeRef = useRef(computeSync);
  computeRef.current = computeSync;
  const makeWorkerRef = useRef(makeWorker);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
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
      }
    };
    if (brokenRef.current) {
      syncFallback();
      return;
    }
    if (!workerRef.current) {
      try {
        const worker = makeWorkerRef.current!();
        worker.onmessage = (e: MessageEvent<WorkerReply<O>>) => {
          const { reqId: doneReq, output, error } = e.data;
          if (doneReq !== reqIdRef.current) return; // stale reply
          if (error !== undefined) {
            console.warn("[crystal] scene worker failed:", error);
            return;
          }
          setState({ value: output as O, forReq: doneReq });
        };
        worker.onerror = () => {
          // Worker plumbing broke (bundling, CSP) — degrade to the old
          // synchronous path for the rest of this view's life.
          brokenRef.current = true;
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          syncFallback();
        };
        workerRef.current = worker;
      } catch (err) {
        console.warn("[crystal] scene worker unavailable:", (err as Error).message);
        brokenRef.current = true;
        syncFallback();
        return;
      }
    }
    try {
      workerRef.current.postMessage({ reqId, input });
    } catch (err) {
      // Non-clonable input is a programming error; keep the view alive.
      console.warn("[crystal] scene worker post failed:", (err as Error).message);
      brokenRef.current = true;
      syncFallback();
    }
  }, [input]);

  return { value: state.value, pending: state.forReq !== reqIdRef.current };
}

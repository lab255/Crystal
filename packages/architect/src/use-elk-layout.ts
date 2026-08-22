import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchitectureGraph } from "@crystal/core";
import { rendersAsPen } from "./card-metrics.js";
import { elkAutoLayout, type ElkLayoutResult, type ElkRoute } from "./elk-layout.js";
import {
  decodeElkLayoutReply,
  decodeElkLayoutRequest,
  encodeElkLayoutReply,
  encodeElkLayoutRequest,
  type ElkLayoutReply,
  type ElkLayoutRequest,
  type ElkWorkerReply,
} from "./elk-layout-protocol.js";
import { autoLayoutFitted } from "./layout.js";

type Size = { width: number; height: number };
interface PublishedLayout {
  graph: ArchitectureGraph;
  dimsKey: string;
  aspectRatioKey: string;
  laid: ArchitectureGraph;
  routes: ReadonlyMap<string, ElkRoute> | null;
  /**
   * Bumped when a solve lands for a graph id that had none yet — the moment
   * the canvas should reframe. Same-level refinements (measured dims) keep
   * the revision so the viewport is not yanked while the user reads/pans.
   */
  revision: number;
}

export interface AsyncWorkerResult<O> {
  value: O | null;
  pending: boolean;
  failed?: boolean;
  error?: string;
}

const WORKER_STALL_MS = 60_000;
// Ship cold-equivalent behavior first; A/B tests exercise the gated path directly.
const ENABLE_INCREMENTAL_ELK = false;

/** @internal Exported for transport-policy tests without rendering React. */
export class AsyncLayoutController<I, O> {
  private worker: Worker | null = null;
  private broken: boolean;
  private reqId = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private value: O | null = null;

  constructor(
    private readonly makeWorker: (() => Worker) | null,
    private readonly computeLocal: (input: I) => Promise<O>,
    private readonly update: (result: AsyncWorkerResult<O>) => void,
    private readonly stallMs = WORKER_STALL_MS,
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
    if (this.broken) void this.local(input, reqId);
    else this.run(input, reqId, 0);
  }

  destroy(): void {
    ++this.reqId;
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
      } catch {
        this.broken = true;
        void this.local(input, reqId);
        return;
      }
    }
    worker.onmessage = (event: MessageEvent<ElkWorkerReply>) => {
      const reply = event.data as ElkWorkerReply & { output?: O };
      if (reply.reqId !== reqId || this.reqId !== reqId || this.worker !== worker) return;
      this.clearWatchdog();
      if (reply.error !== undefined) {
        this.update({ value: this.value, pending: false, failed: true, error: reply.error });
        return;
      }
      this.value = reply.output as O;
      this.update({ value: this.value, pending: false });
    };
    worker.onerror = () => {
      if (this.reqId !== reqId || this.worker !== worker) return;
      this.disable(worker);
      this.broken = true;
      void this.local(input, reqId);
    };
    try {
      worker.postMessage({ reqId, input });
    } catch {
      this.disable(worker);
      this.broken = true;
      void this.local(input, reqId);
      return;
    }
    this.watchdog = setTimeout(() => {
      if (this.reqId !== reqId || this.worker !== worker) return;
      this.disable(worker);
      if (attempt === 0) this.run(input, reqId, 1);
      else this.update({ value: this.value, pending: false, failed: true });
    }, this.stallMs * (attempt + 1));
  }

  private async local(input: I, reqId: number): Promise<void> {
    try {
      const output = await this.computeLocal(input);
      if (this.reqId !== reqId) return;
      this.value = output;
      this.update({ value: output, pending: false });
    } catch (error) {
      if (this.reqId === reqId) {
        this.update({
          value: this.value,
          pending: false,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
}

function dimensionsKey(dims: ReadonlyMap<string, Size> | null): string {
  if (!dims) return "";
  return JSON.stringify(
    [...dims].sort(([a], [b]) => a.localeCompare(b)).map(([id, size]) => [id, size.width, size.height]),
  );
}

function classifications(graph: ArchitectureGraph): Map<string, { parent: string | null; pen: boolean }> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const childCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }
  return new Map(
    graph.nodes.map((node) => [
      node.id,
      {
        parent: node.parentId && nodeIds.has(node.parentId) ? node.parentId : null,
        pen: rendersAsPen(node, (childCounts.get(node.id) ?? 0) > 0),
      },
    ]),
  );
}

/** Structural small-delta gate for safe semi-interactive position hints. */
export function canUseIncrementalLayout(args: {
  previous: ArchitectureGraph;
  next: ArchitectureGraph;
  previousDims: ReadonlyMap<string, Size> | null;
  nextDims: ReadonlyMap<string, Size> | null;
  previousLayoutKey: string;
  nextLayoutKey: string;
  explicitRelayout?: boolean;
}): boolean {
  if (args.explicitRelayout || args.previousLayoutKey !== args.nextLayoutKey) return false;
  const oldIds = new Set(args.previous.nodes.map((node) => node.id));
  const newIds = new Set(args.next.nodes.map((node) => node.id));
  if (oldIds.size === 0) return false;
  const retained = [...oldIds].filter((id) => newIds.has(id));
  if (retained.length / Math.max(oldIds.size, newIds.size) < 0.9) return false;
  const delta = oldIds.size + newIds.size - 2 * retained.length;
  if (delta > Math.max(8, Math.ceil(oldIds.size * 0.1))) return false;
  const oldShape = classifications(args.previous);
  const newShape = classifications(args.next);
  if (retained.some((id) => {
    const before = oldShape.get(id)!;
    const after = newShape.get(id)!;
    return before.parent !== after.parent || before.pen !== after.pen;
  })) return false;
  const measured = retained.filter((id) => args.previousDims?.has(id) && args.nextDims?.has(id));
  if (measured.length > 0) {
    const stable = measured.filter((id) => {
      const before = args.previousDims!.get(id)!;
      const after = args.nextDims!.get(id)!;
      return Math.abs(before.width - after.width) <= 2 && Math.abs(before.height - after.height) <= 2;
    });
    if (stable.length / measured.length < 0.9) return false;
  }
  return true;
}

async function computeLocal(input: ElkLayoutRequest): Promise<ElkLayoutReply> {
  const decoded = decodeElkLayoutRequest(input);
  return encodeElkLayoutReply(await elkAutoLayout(decoded.graph, decoded.opts));
}

/** @internal Encodes at the effect boundary so invalid measurements degrade like solve failures. */
export function startElkLayoutRequest(
  controller: Pick<AsyncLayoutController<ElkLayoutRequest, ElkLayoutReply>, "start">,
  graph: ArchitectureGraph,
  opts: Parameters<typeof encodeElkLayoutRequest>[1],
  failed: (result: AsyncWorkerResult<ElkLayoutReply>) => void,
): void {
  try {
    controller.start(encodeElkLayoutRequest(graph, opts));
  } catch (error) {
    failed({
      value: null,
      pending: false,
      failed: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Instant dagre first paint followed by compound-aware worker ELK geometry. */
export function useElkLayout(
  graph: ArchitectureGraph | null,
  dims: ReadonlyMap<string, Size> | null,
  aspectRatio = 1.7,
): { laid: ArchitectureGraph | null; routes: ReadonlyMap<string, ElkRoute> | null; revision: number } {
  const dimsKey = dimensionsKey(dims);
  const aspectRatioKey = Number.isFinite(aspectRatio) ? aspectRatio.toFixed(3) : "1.700";
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const warned = useRef(false);
  const cache = useRef<{ graph: ArchitectureGraph; dims: ReadonlyMap<string, Size> | null; key: string } | null>(null);
  const context = useRef<{
    graph: ArchitectureGraph;
    fallback: ArchitectureGraph;
    dims: ReadonlyMap<string, Size> | null;
    dimsKey: string;
    aspectRatioKey: string;
  } | null>(null);
  const [published, setPublished] = useState<PublishedLayout | null>(null);

  const fallback = useMemo(
    () => graph ? autoLayoutFitted(graph, { mode: "flow", reserve: dimsRef.current ?? undefined }) : null,
    [graph, dimsKey],
  );
  const publishRef = useRef<(state: AsyncWorkerResult<ElkLayoutReply>) => void>(() => {});
  publishRef.current = (state) => {
    if (state.pending) return;
    const current = context.current;
    if (!current) return;
    const revisionFor = (previous: PublishedLayout | null): number =>
      previous == null ? 1 : previous.graph.id === current.graph.id ? previous.revision : previous.revision + 1;
    if (state.failed || !state.value) {
      if (!warned.current) {
        warned.current = true;
        console.warn("ELK architecture layout failed; keeping the dagre fallback", state.error ?? "Unknown error");
      }
      setPublished((previous) =>
        previous?.graph.id === current.graph.id
          ? previous
          : { ...current, laid: current.fallback, routes: null, revision: revisionFor(previous) },
      );
      return;
    }
    const result: ElkLayoutResult = decodeElkLayoutReply(state.value);
    cache.current = { graph: result.graph, dims: current.dims, key: `${current.graph.id}:DOWN:${current.aspectRatioKey}` };
    setPublished((previous) => ({ ...current, laid: result.graph, routes: result.routes, revision: revisionFor(previous) }));
  };

  const controllerRef = useRef<AsyncLayoutController<ElkLayoutRequest, ElkLayoutReply> | null>(null);
  if (!controllerRef.current) {
    const makeWorker = typeof Worker === "undefined"
      ? null
      : () => new Worker(new URL("./elk-layout.worker.ts", import.meta.url), { type: "module" });
    controllerRef.current = new AsyncLayoutController(makeWorker, computeLocal, (state) => publishRef.current(state));
  }

  useEffect(() => () => controllerRef.current?.destroy(), []);
  useEffect(() => {
    if (!graph || !fallback) {
      context.current = null;
      controllerRef.current!.start(null);
      return;
    }
    const requestDims = dimsRef.current;
    context.current = { graph, fallback, dims: requestDims, dimsKey, aspectRatioKey };
    const key = `${graph.id}:DOWN:${aspectRatioKey}`;
    const prior = cache.current;
    const incremental = ENABLE_INCREMENTAL_ELK && prior != null && canUseIncrementalLayout({
      previous: prior.graph,
      next: graph,
      previousDims: prior.dims,
      nextDims: requestDims,
      previousLayoutKey: prior.key,
      nextLayoutKey: key,
    });
    startElkLayoutRequest(controllerRef.current!, graph, {
      dims: requestDims ?? undefined,
      aspectRatio: Number(aspectRatioKey),
      incremental,
      ...(incremental ? { previous: new Map(prior!.graph.nodes.map((node) => [node.id, node.position])) } : {}),
    }, (state) => publishRef.current(state));
  }, [graph, dimsKey, aspectRatioKey, fallback]);

  if (!graph || !fallback) return { laid: null, routes: null, revision: 0 };
  if (published?.graph === graph && published.dimsKey === dimsKey && published.aspectRatioKey === aspectRatioKey) {
    return { laid: published.laid, routes: published.routes, revision: published.revision };
  }
  if (published?.graph.id === graph.id) {
    return { laid: published.laid, routes: published.routes, revision: published.revision };
  }
  return { laid: fallback, routes: null, revision: published?.revision ?? 0 };
}

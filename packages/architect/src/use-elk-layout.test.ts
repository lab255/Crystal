import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchNode, createArchitectureGraph, type ArchitectureGraph } from "@crystal/core";
import { type ElkLayoutReply, decodeElkLayoutReply, encodeElkLayoutReply, encodeElkLayoutRequest } from "./elk-layout-protocol.js";
import { AsyncLayoutController, canUseIncrementalLayout, startElkLayoutRequest } from "./use-elk-layout.js";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postError = false;
  postMessage(value: unknown): void {
    if (this.postError) throw new Error("clone failed");
    this.posted.push(value);
  }
  terminate(): void { this.terminated = true; }
  reply(reqId: number, output?: ElkLayoutReply, error?: string): void {
    this.onmessage?.({ data: { reqId, output, error } } as MessageEvent);
  }
}

const graph = (ids: string[], parent?: Record<string, string>): ArchitectureGraph => ({
  ...createArchitectureGraph("fixture"),
  id: "arch:c4:containers",
  nodes: ids.map((id) => ({
    ...createArchNode(id.startsWith("pen:") ? "group" : "service", id, { x: 0, y: 0 }),
    id,
    ...(parent?.[id] ? { parentId: parent[id] } : {}),
  })),
});

const reply = (id: string): ElkLayoutReply => ({ graph: graph([id]), routes: [] });

afterEach(() => vi.useRealTimers());

describe("ELK layout protocol", () => {
  it("sorts tuple maps and round-trips route points and optional labels", () => {
    const request = encodeElkLayoutRequest(graph(["b", "a"]), {
      dims: new Map([["b", { width: 2, height: 3 }], ["a", { width: 4, height: 5 }]]),
      previous: new Map([["b", { x: 8, y: 9 }], ["a", { x: 6, y: 7 }]]),
      incremental: true,
    });
    expect(request.opts.dims?.map(([id]) => id)).toEqual(["a", "b"]);
    expect(request.opts.previous?.map(([id]) => id)).toEqual(["a", "b"]);

    const encoded = encodeElkLayoutReply({
      graph: request.graph,
      routes: new Map([
        ["z", { points: [{ x: 1, y: 2 }] }],
        ["a", { points: [{ x: 3, y: 4 }, { x: 5, y: 6 }], label: { x: 7, y: 8, width: 9, height: 10 } }],
      ]),
    });
    expect(encoded.routes.map(([id]) => id)).toEqual(["a", "z"]);
    expect(decodeElkLayoutReply(encoded).routes.get("a")).toEqual({
      points: [{ x: 3, y: 4 }, { x: 5, y: 6 }],
      label: { x: 7, y: 8, width: 9, height: 10 },
    });
  });

  it("rejects non-finite dimensions, positions, routes, and labels", () => {
    expect(() => encodeElkLayoutRequest(graph(["a"]), { dims: new Map([["a", { width: Infinity, height: 2 }]]) })).toThrow("Non-finite");
    expect(() => encodeElkLayoutRequest(graph(["a"]), { previous: new Map([["a", { x: NaN, y: 2 }]]) })).toThrow("Non-finite");
    expect(() => encodeElkLayoutReply({ graph: graph(["a"]), routes: new Map([["e", { points: [{ x: NaN, y: 0 }] }]]) })).toThrow("Non-finite");
  });
});

describe("AsyncLayoutController", () => {
  it("publishes only the latest request and ignores replies after destruction", () => {
    const worker = new FakeWorker();
    const updates: unknown[] = [];
    const controller = new AsyncLayoutController(() => worker as unknown as Worker, async () => reply("local"), (value) => updates.push(value));
    controller.start("one");
    controller.start("two");
    worker.reply(1, reply("old"));
    expect(updates.at(-1)).toEqual({ value: null, pending: true });
    worker.reply(2, reply("new"));
    expect((updates.at(-1) as { value: ElkLayoutReply }).value.graph.nodes[0]?.id).toBe("new");
    controller.destroy();
    worker.reply(2, reply("late"));
    expect((updates.at(-1) as { value: ElkLayoutReply }).value.graph.nodes[0]?.id).toBe("new");
  });

  it.each(["missing", "constructor", "post", "error"])("uses async local fallback for %s transport failure", async (failure) => {
    const worker = new FakeWorker();
    if (failure === "post") worker.postError = true;
    const updates: unknown[] = [];
    const make = failure === "missing" ? null : failure === "constructor" ? () => { throw new Error("no worker"); } : () => worker as unknown as Worker;
    const controller = new AsyncLayoutController(make, async () => reply("local"), (value) => updates.push(value));
    controller.start("input");
    if (failure === "error") worker.onerror?.({ message: "worker exploded" } as ErrorEvent);
    await vi.waitFor(() => expect((updates.at(-1) as { value: ElkLayoutReply }).value.graph.nodes[0]?.id).toBe("local"));
  });

  it("surfaces a worker runtime error before recovering locally", async () => {
    const worker = new FakeWorker();
    const updates: unknown[] = [];
    const controller = new AsyncLayoutController(
      () => worker as unknown as Worker,
      async () => reply("local"),
      (value) => updates.push(value),
    );
    controller.start("input");
    worker.onerror?.({ message: "worker exploded" } as ErrorEvent);
    expect(updates).toContainEqual({ value: null, pending: true, failed: true, error: "worker exploded" });
    await vi.waitFor(() => expect((updates.at(-1) as { value: ElkLayoutReply }).value.graph.nodes[0]?.id).toBe("local"));
  });

  it("restarts the first stall and settles the second without local compute", async () => {
    vi.useFakeTimers();
    const workers = [new FakeWorker(), new FakeWorker()];
    const local = vi.fn(async () => reply("local"));
    const updates: unknown[] = [];
    const controller = new AsyncLayoutController(() => workers.shift()! as unknown as Worker, local, (value) => updates.push(value), 10);
    controller.start("input");
    await vi.advanceTimersByTimeAsync(10);
    expect(workers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(local).not.toHaveBeenCalled();
    expect(updates.at(-1)).toEqual({ value: null, pending: false, failed: true });
  });

  it("settles worker algorithm errors while retaining the previous value", () => {
    const worker = new FakeWorker();
    const updates: unknown[] = [];
    const controller = new AsyncLayoutController(() => worker as unknown as Worker, async () => reply("local"), (value) => updates.push(value));
    controller.start("first");
    worker.reply(1, reply("good"));
    controller.start("second");
    worker.reply(2, undefined, "algorithm failed");
    const last = updates.at(-1) as { value: ElkLayoutReply; pending: boolean; failed: boolean };
    expect(last.value.graph.nodes[0]?.id).toBe("good");
    expect(last).toMatchObject({ pending: false, failed: true, error: "algorithm failed" });
  });

  it("keeps the old request context through the render-to-effect gap", () => {
    const worker = new FakeWorker();
    let requestContext = "old";
    const publications: string[] = [];
    const controller = new AsyncLayoutController(
      () => worker as unknown as Worker,
      async () => reply("local"),
      (state) => { if (!state.pending && state.value) publications.push(`${requestContext}:${state.value.graph.nodes[0]!.id}`); },
    );
    controller.start("old request");
    const renderedContext = "new";
    worker.reply(1, reply("old geometry"));
    expect(renderedContext).toBe("new");
    expect(publications).toEqual(["old:old geometry"]);
    requestContext = renderedContext;
    controller.start("new request");
  });

  it("routes a non-finite request dimension through the failed publish path", () => {
    const start = vi.fn();
    const failed = vi.fn();
    startElkLayoutRequest({ start }, graph(["a"]), {
      dims: new Map([["a", { width: NaN, height: 20 }]]),
    }, failed);
    expect(start).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      value: null,
      pending: false,
      failed: true,
      error: expect.stringContaining("Non-finite width"),
    }));
  });
});

describe("canUseIncrementalLayout", () => {
  const ids = Array.from({ length: 20 }, (_, index) => `n:${index}`);
  const dims = new Map(ids.map((id) => [id, { width: 100, height: 50 }]));
  it("accepts a small leaf add/remove and dimension refinement", () => {
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph([...ids, "new"]), previousDims: dims, nextDims: new Map([...dims, ["new", { width: 100, height: 50 }]]), previousLayoutKey: "key", nextLayoutKey: "key" })).toBe(true);
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(ids.slice(0, -1)), previousDims: dims, nextDims: dims, previousLayoutKey: "key", nextLayoutKey: "key" })).toBe(true);
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(ids), previousDims: dims, nextDims: new Map(ids.map((id) => [id, { width: 102, height: 48 }])), previousLayoutKey: "key", nextLayoutKey: "key" })).toBe(true);
  });

  it("rejects parent changes, large level changes, aspect buckets, and explicit relayout", () => {
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(ids, { "n:0": "n:1" }), previousDims: dims, nextDims: dims, previousLayoutKey: "key", nextLayoutKey: "key" })).toBe(false);
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(["other"]), previousDims: dims, nextDims: null, previousLayoutKey: "key", nextLayoutKey: "key" })).toBe(false);
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(ids), previousDims: dims, nextDims: dims, previousLayoutKey: "aspect:1.7", nextLayoutKey: "aspect:1.8" })).toBe(false);
    expect(canUseIncrementalLayout({ previous: graph(ids), next: graph(ids), previousDims: dims, nextDims: dims, previousLayoutKey: "key", nextLayoutKey: "key", explicitRelayout: true })).toBe(false);
  });
});

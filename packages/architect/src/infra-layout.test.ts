import { describe, expect, it, vi } from "vitest";
import type { ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import {
  bandsAreOrdered,
  buildInfraTargetLayoutInput,
  infraFreeSpaceOrigin,
  infraTargetLayoutKey,
  requestInfraTargetLayout,
  solveSeparateBands,
  solveInfraTargetLayout,
  type InfraLayoutWorkerLike,
  type InfraTargetLayoutInput,
} from "./infra-layout.js";

const base: InfraTargetLayoutInput = {
  targets: [
    { id: "entry", width: 180, height: 90, layer: "entry" },
    { id: "service-b", width: 220, height: 120, layer: "service" },
    { id: "service-a", width: 200, height: 100, layer: "service" },
    { id: "data", width: 240, height: 130, layer: "data" },
    { id: "other", width: 160, height: 80, layer: null },
  ],
  edges: [
    { id: "entry->service-a", source: "entry", target: "service-a" },
    { id: "service-a->data", source: "service-a", target: "data" },
  ],
  aspectRatio: 1.74,
  direction: "DOWN",
};

function canonical(result: Awaited<ReturnType<typeof solveInfraTargetLayout>>) {
  return result.positions.map((position) => ({ ...position, x: Math.round(position.x), y: Math.round(position.y) }));
}

describe("infra target layout DTO", () => {
  it("sorts without mutating and quarter-step quantizes the aspect", () => {
    const input = {
      ...base,
      targets: [base.targets[2]!, base.targets[4]!, base.targets[0]!, base.targets[3]!, base.targets[1]!],
      edges: [base.edges[1]!, base.edges[0]!],
    };
    const built = buildInfraTargetLayoutInput(input);
    expect(built.targets.map((target) => target.id)).toEqual(["data", "entry", "other", "service-a", "service-b"]);
    expect(built.edges.map((edge) => edge.id)).toEqual(["entry->service-a", "service-a->data"]);
    expect(built.aspectRatio).toBe(1.75);
    expect(input.targets[0]?.id).toBe("service-a");
    expect(buildInfraTargetLayoutInput({ ...base, aspectRatio: 1.86 }).aspectRatio).toBe(1.75);
    expect(buildInfraTargetLayoutInput({ ...base, aspectRatio: 1.89 }).aspectRatio).toBe(2);
  });

  it("keeps the content key stable for resize changes inside one aspect bucket", () => {
    const first = buildInfraTargetLayoutInput({ ...base, aspectRatio: 1.76 });
    const second = buildInfraTargetLayoutInput({ ...base, aspectRatio: 1.84 });
    expect(infraTargetLayoutKey(first)).toBe(infraTargetLayoutKey(second));
    expect(first).toEqual(second);
  });

  it("starts below the deepest visible root zone or root target pin", () => {
    expect(infraFreeSpaceOrigin([])).toEqual({ x: 48, y: 96 });
    expect(infraFreeSpaceOrigin([
      { x: 0, y: 40, width: 700, height: 500 },
      { x: 900, y: 700, width: 220, height: 120 },
    ])).toEqual({ x: 48, y: 924 });
  });
});

describe("infra target ELK solve", () => {
  it("is permutation invariant and returns finite positions", async () => {
    const normal = canonical(await solveInfraTargetLayout(base));
    const permuted = canonical(await solveInfraTargetLayout({
      ...base,
      targets: [base.targets[3]!, base.targets[0]!, base.targets[4]!, base.targets[1]!, base.targets[2]!],
      edges: [base.edges[1]!, base.edges[0]!],
    }));
    expect(permuted).toEqual(normal);
    expect(normal.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it("keeps entry, service, data, and other in ordered non-overlapping bands with adversarial back edges", async () => {
    const result = await solveInfraTargetLayout({
      ...base,
      edges: [
        ...base.edges,
        { id: "data->entry", source: "data", target: "entry" },
        { id: "other->service-b", source: "other", target: "service-b" },
      ],
    });
    const y = new Map(result.positions.map((position) => [position.id, position.y]));
    const bottom = (id: string) => y.get(id)! + base.targets.find((target) => target.id === id)!.height;
    expect(y.get("entry")!).toBeLessThanOrEqual(Math.min(y.get("service-a")!, y.get("service-b")!));
    expect(bottom("entry")).toBeLessThanOrEqual(Math.min(y.get("service-a")!, y.get("service-b")!));
    expect(Math.max(bottom("service-a"), bottom("service-b"))).toBeLessThanOrEqual(y.get("data")!);
    expect(bottom("data")).toBeLessThanOrEqual(y.get("other")!);
  });

  it("detects unordered bands and explicitly takes the separate-band fallback", async () => {
    const unordered = base.targets.map((target, index) => ({ id: target.id, x: index * 10, y: 0 }));
    expect(bandsAreOrdered(base, unordered)).toBe(false);
    let calls = 0;
    const engine = {
      layout: vi.fn(async (graph: { children?: { id: string }[] }) => {
        calls++;
        if (calls === 1) return { ...graph, children: unordered };
        return { ...graph, children: graph.children?.map((node, index) => ({ ...node, x: index * 20, y: 0 })) };
      }),
    } as unknown as ElkEngine;
    const result = await solveInfraTargetLayout(base, engine);
    expect(calls).toBe(5); // one combined attempt, then four partition solves
    expect(bandsAreOrdered(base, result.positions)).toBe(true);

    calls = 1;
    const direct = await solveSeparateBands(base, engine);
    expect(calls).toBe(5);
    expect(bandsAreOrdered(base, direct.positions)).toBe(true);
  });
});

describe("infra target async coordinator seam", () => {
  it("uses in-process fallback without a worker while preserving the previous scene until landing", async () => {
    let release!: (output: { positions: [] }) => void;
    const solve = vi.fn(() => new Promise<{ positions: [] }>((resolve) => { release = resolve; }));
    let scene: { positions: { id: string; x: number; y: number }[] } = { positions: [{ id: "old", x: 1, y: 2 }] };
    const landing = requestInfraTargetLayout(base, null, 1, solve).then((output) => { scene = output; });
    expect(scene.positions[0]?.id).toBe("old");
    release({ positions: [] });
    await landing;
    expect(scene.positions).toEqual([]);
    expect(solve).toHaveBeenCalledOnce();
  });

  it("warns once and retries in-process for worker error replies", async () => {
    const warn = vi.fn();
    const solve = vi.fn(async () => ({ positions: [] }));
    const worker: InfraLayoutWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        queueMicrotask(() => this.onmessage?.({ data: { reqId: message.reqId, error: "boom" } } as MessageEvent));
      },
    };
    await requestInfraTargetLayout(base, worker, 7, solve, warn);
    await requestInfraTargetLayout(base, worker, 8, solve, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(solve).toHaveBeenCalledTimes(2);
  });
});

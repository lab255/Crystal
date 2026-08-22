import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import type { ArchLayer } from "@crystal/core";
import type { InfraTargetEdge } from "./infra.js";

export interface InfraTargetRect {
  id: string;
  width: number;
  height: number;
  layer: ArchLayer | null;
}

export interface InfraTargetLayoutInput {
  targets: InfraTargetRect[];
  edges: InfraTargetEdge[];
  aspectRatio: number;
  direction: "DOWN";
}

export interface InfraTargetLayoutOutput {
  positions: { id: string; x: number; y: number }[];
}

export interface InfraOccupiedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PARTITION: Record<ArchLayer, number> = { entry: 0, service: 1, data: 2 };
export const GROUP_GAP = 56;
export const BAND_GAP = 104;
export const LAYOUT_TOP = 96;

let defaultElk: ElkEngine | undefined;
let warnedWorkerFailure = false;

export interface InfraLayoutWorkerLike {
  onmessage: ((event: MessageEvent<{ reqId: number; output?: InfraTargetLayoutOutput; error?: string }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: { reqId: number; input: InfraTargetLayoutInput }): void;
}

/** Conservative free space: reserve one top slab containing every root pin/zone. */
export function infraFreeSpaceOrigin(
  occupied: readonly InfraOccupiedRect[],
  layoutX = 48,
  layoutTop = 96,
  gap = BAND_GAP,
): { x: number; y: number } {
  if (occupied.length === 0) return { x: layoutX, y: layoutTop };
  return {
    x: layoutX,
    y: Math.max(layoutTop, ...occupied.map((rect) => rect.y + rect.height)) + gap,
  };
}

function finite(value: number | undefined, what: string): number {
  if (value == null || !Number.isFinite(value)) throw new Error(`ELK produced a non-finite ${what}`);
  return value;
}

export function buildInfraTargetLayoutInput(input: InfraTargetLayoutInput): InfraTargetLayoutInput {
  return {
    targets: [...input.targets]
      .map((target) => ({ ...target }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...input.edges]
      .map((edge) => ({ ...edge }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    aspectRatio: Math.round(Math.max(0.5, Math.min(3, input.aspectRatio)) * 4) / 4,
    direction: "DOWN",
  };
}

/** Stable identity for the canonical, solver-relevant request content. */
export function infraTargetLayoutKey(input: InfraTargetLayoutInput): string {
  return JSON.stringify(buildInfraTargetLayoutInput(input));
}

/** Worker transport with an async in-process fallback, kept separate for deterministic tests. */
export function requestInfraTargetLayout(
  input: InfraTargetLayoutInput,
  worker: InfraLayoutWorkerLike | null,
  reqId: number,
  solve: (input: InfraTargetLayoutInput) => Promise<InfraTargetLayoutOutput> = solveInfraTargetLayout,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<InfraTargetLayoutOutput> {
  if (!worker) return solve(input).catch(() => provisionalInfraTargetLayout(buildInfraTargetLayoutInput(input)));
  return new Promise((resolve) => {
    let fellBack = false;
    const fallback = (error?: string) => {
      if (fellBack) return;
      fellBack = true;
      if (error && !warnedWorkerFailure) {
        warnedWorkerFailure = true;
        warn("Infra target layout worker failed; retrying in-process", error);
      }
      void solve(input).then(
        resolve,
        () => resolve(provisionalInfraTargetLayout(buildInfraTargetLayoutInput(input))),
      );
    };
    worker.onmessage = (event) => {
      if (event.data.reqId !== reqId) return;
      if (event.data.output) resolve(event.data.output);
      else if (event.data.error) fallback(event.data.error);
    };
    worker.onerror = () => fallback("Worker runtime error");
    worker.postMessage({ reqId, input });
  });
}

function elkNode(target: InfraTargetRect): ElkNode {
  const partition = target.layer == null ? 3 : PARTITION[target.layer];
  return {
    id: target.id,
    width: target.width,
    height: target.height,
    layoutOptions: {
      "org.eclipse.elk.partitioning.partition": String(partition),
    },
  };
}

/** Deterministic, dependency-free last resort. Targets remain in layer bands. */
export function provisionalInfraTargetLayout(input: InfraTargetLayoutInput): InfraTargetLayoutOutput {
  const positions: InfraTargetLayoutOutput["positions"] = [];
  let cursorY = 0;
  for (const partition of [0, 1, 2, 3]) {
    const targets = input.targets.filter((target) => (target.layer == null ? 3 : PARTITION[target.layer]) === partition);
    if (targets.length === 0) continue;
    let cursorX = 0;
    let bandHeight = 0;
    for (const target of targets) {
      positions.push({ id: target.id, x: cursorX, y: cursorY });
      cursorX += target.width + GROUP_GAP;
      bandHeight = Math.max(bandHeight, target.height);
    }
    cursorY += bandHeight + BAND_GAP;
  }
  return { positions: positions.sort((a, b) => a.id.localeCompare(b.id)) };
}

function root(input: InfraTargetLayoutInput, targets = input.targets, edges = input.edges): ElkNode {
  const ids = new Set(targets.map((target) => target.id));
  return {
    id: "__infra_targets__",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": input.direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(BAND_GAP),
      "elk.spacing.nodeNode": String(GROUP_GAP),
      "elk.spacing.componentComponent": String(GROUP_GAP),
      "elk.aspectRatio": String(input.aspectRatio),
    },
    children: targets.map(elkNode),
    edges: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

function positionsOf(graph: ElkNode): InfraTargetLayoutOutput["positions"] {
  return (graph.children ?? [])
    .map((node) => ({ id: node.id, x: finite(node.x, `${node.id} x`), y: finite(node.y, `${node.id} y`) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function bandsAreOrdered(input: InfraTargetLayoutInput, positions: InfraTargetLayoutOutput["positions"]): boolean {
  const pos = new Map(positions.map((item) => [item.id, item]));
  let previousBottom = -Infinity;
  for (const partition of [0, 1, 2, 3]) {
    const band = input.targets.filter((target) => (target.layer == null ? 3 : PARTITION[target.layer]) === partition);
    if (band.length === 0) continue;
    const top = Math.min(...band.map((target) => pos.get(target.id)?.y ?? Infinity));
    const bottom = Math.max(...band.map((target) => (pos.get(target.id)?.y ?? -Infinity) + target.height));
    if (top < previousBottom) return false;
    previousBottom = bottom;
  }
  return true;
}

export async function solveSeparateBands(input: InfraTargetLayoutInput, elk: ElkEngine): Promise<InfraTargetLayoutOutput> {
  const positions: InfraTargetLayoutOutput["positions"] = [];
  let cursorY = 0;
  for (const partition of [0, 1, 2, 3]) {
    const targets = input.targets.filter((target) => (target.layer == null ? 3 : PARTITION[target.layer]) === partition);
    if (targets.length === 0) continue;
    const ids = new Set(targets.map((target) => target.id));
    const graph = await elk.layout(root(input, targets, input.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))));
    const local = positionsOf(graph);
    const top = Math.min(...local.map((item) => item.y));
    const bottom = Math.max(...local.map((item) => item.y + (targets.find((target) => target.id === item.id)?.height ?? 0)));
    positions.push(...local.map((item) => ({ ...item, y: cursorY + item.y - top })));
    cursorY += bottom - top + BAND_GAP;
  }
  return { positions: positions.sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Solve only free target rectangles; zones and pins never enter this graph. */
export async function solveInfraTargetLayout(raw: InfraTargetLayoutInput, engine?: ElkEngine): Promise<InfraTargetLayoutOutput> {
  const input = buildInfraTargetLayoutInput(raw);
  if (input.targets.length === 0) return { positions: [] };
  const elk = engine ?? (defaultElk ??= new ELK());
  try {
    const positions = positionsOf(await elk.layout(root(input)));
    if (bandsAreOrdered(input, positions)) return { positions };
  } catch {
    // Invalid/adversarial cross-band edges can make a combined layered solve fail.
  }
  try {
    return await solveSeparateBands(input, elk);
  } catch {
    return provisionalInfraTargetLayout(input);
  }
}

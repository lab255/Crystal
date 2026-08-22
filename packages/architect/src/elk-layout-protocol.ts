import type { ArchitectureGraph } from "@crystal/core";
import type { ElkLayoutOptions, ElkLayoutResult, ElkRoute } from "./elk-layout.js";

export type ElkDimensions = readonly [id: string, width: number, height: number][];
export type ElkPreviousPositions = readonly [id: string, x: number, y: number][];

export interface ElkLayoutRequest {
  graph: ArchitectureGraph;
  opts: {
    dims?: ElkDimensions;
    direction?: "DOWN" | "RIGHT";
    aspectRatio?: number;
    previous?: ElkPreviousPositions;
    incremental?: boolean;
  };
}

export interface ElkLayoutReply {
  graph: ArchitectureGraph;
  routes: readonly [edgeId: string, route: ElkRoute][];
}

export interface ElkWorkerRequest {
  reqId: number;
  input: ElkLayoutRequest;
}

export interface ElkWorkerReply {
  reqId: number;
  output?: ElkLayoutReply;
  error?: string;
}

function finite(value: number, description: string): number {
  if (!Number.isFinite(value)) throw new Error(`Non-finite ${description}`);
  return value;
}

export function encodeElkLayoutRequest(
  graph: ArchitectureGraph,
  opts: ElkLayoutOptions = {},
): ElkLayoutRequest {
  return {
    graph,
    opts: {
      ...(opts.dims
        ? {
            dims: [...opts.dims]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, size]) => [id, finite(size.width, `width for ${id}`), finite(size.height, `height for ${id}`)] as const),
          }
        : {}),
      ...(opts.direction ? { direction: opts.direction } : {}),
      ...(opts.aspectRatio != null
        ? { aspectRatio: finite(opts.aspectRatio, "aspect ratio") }
        : {}),
      ...(opts.previous
        ? {
            previous: [...opts.previous]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, point]) => [id, finite(point.x, `previous x for ${id}`), finite(point.y, `previous y for ${id}`)] as const),
          }
        : {}),
      ...(opts.incremental != null ? { incremental: opts.incremental } : {}),
    },
  };
}

export function decodeElkLayoutRequest(input: ElkLayoutRequest): {
  graph: ArchitectureGraph;
  opts: ElkLayoutOptions;
} {
  return {
    graph: input.graph,
    opts: {
      ...(input.opts.dims
        ? {
            dims: new Map(
              input.opts.dims.map(([id, width, height]) => [
                id,
                { width: finite(width, `width for ${id}`), height: finite(height, `height for ${id}`) },
              ]),
            ),
          }
        : {}),
      ...(input.opts.direction ? { direction: input.opts.direction } : {}),
      ...(input.opts.aspectRatio != null
        ? { aspectRatio: finite(input.opts.aspectRatio, "aspect ratio") }
        : {}),
      ...(input.opts.previous
        ? {
            previous: new Map(
              input.opts.previous.map(([id, x, y]) => [
                id,
                { x: finite(x, `previous x for ${id}`), y: finite(y, `previous y for ${id}`) },
              ]),
            ),
          }
        : {}),
      ...(input.opts.incremental != null ? { incremental: input.opts.incremental } : {}),
    },
  };
}

export function encodeElkLayoutReply(result: ElkLayoutResult): ElkLayoutReply {
  return {
    graph: result.graph,
    routes: [...result.routes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, route]) => [
        id,
        {
          points: route.points.map((point) => ({
            x: finite(point.x, `route x for ${id}`),
            y: finite(point.y, `route y for ${id}`),
          })),
          ...(route.label
            ? {
                label: {
                  x: finite(route.label.x, `label x for ${id}`),
                  y: finite(route.label.y, `label y for ${id}`),
                  width: finite(route.label.width, `label width for ${id}`),
                  height: finite(route.label.height, `label height for ${id}`),
                },
              }
            : {}),
        },
      ] as const),
  };
}

export function decodeElkLayoutReply(reply: ElkLayoutReply): ElkLayoutResult {
  return { graph: reply.graph, routes: new Map(reply.routes) };
}

import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { roundedPath } from "../edge-routing.js";
import type { ArchRfEdge } from "../model.js";

function longestSegmentMidpoint(
  points: readonly { x: number; y: number }[],
): { x: number; y: number } {
  let longest = -1;
  let midpoint = points[0] ?? { x: 0, y: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length <= longest) continue;
    longest = length;
    midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }
  return midpoint;
}

/** ELK's absolute orthogonal polyline rendered with the canvas edge palette. */
export function ElkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerStart,
  markerEnd,
  label,
  labelStyle,
  data,
  selected,
}: EdgeProps<ArchRfEdge>) {
  // The route is required for `type: "elk"`; endpoint fallback keeps the
  // component defensive if stale external edge data reaches React Flow.
  const route =
    data?.route?.points ??
    [
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
    ];
  const midpoint = data?.route?.label
    ? {
        x: data.route.label.x + data.route.label.width / 2,
        y: data.route.label.y + data.route.label.height / 2,
      }
    : longestSegmentMidpoint(route);

  return (
    <>
      <BaseEdge
        id={id}
        path={roundedPath(route)}
        style={selected ? { ...style, strokeWidth: 2.4, opacity: 1 } : style}
        markerStart={markerStart as string | undefined}
        markerEnd={markerEnd as string | undefined}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute whitespace-nowrap rounded bg-surface-1/90 px-1 py-px text-[10px] text-ink-muted"
            style={{
              transform: `translate(-50%, -50%) translate(${midpoint.x}px, ${midpoint.y}px)`,
              ...(labelStyle as React.CSSProperties | undefined),
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

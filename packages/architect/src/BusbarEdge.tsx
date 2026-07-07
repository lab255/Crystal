import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { busbarPath } from "./edge-routing.js";
import type { ArchRfEdge } from "./model.js";

/**
 * Orthogonal bus-bar edge: straight vertical/horizontal runs with rounded
 * bends, one shared trunk lane per source node (see edge-routing.ts). Used
 * automatically once a diagram outgrows curves.
 */
export function BusbarEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  label,
  labelStyle,
  data,
  selected,
}: EdgeProps<ArchRfEdge>) {
  const lane = data?.lane ?? 0;
  const { path, labelX, labelY } = busbarPath(sourceX, sourceY, targetX, targetY, lane);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={selected ? { ...style, strokeWidth: 2.4, opacity: 1 } : style}
        markerEnd={markerEnd as string | undefined}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded bg-surface-1/90 px-1 py-px text-[10px] text-ink-muted"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
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

import { useMemo } from "react";
import type { ScreenApiCall, ScreenSurface } from "@crystal/core";
import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { useCanonicalArchitecture } from "./use-canonical-architecture.js";

/**
 * The canonical architecture as an embeddable pane — the surfaces mode docks
 * this beside its lists so callers/callees/integrations highlight in place
 * (single click pins via the shared highlight store; the pane resolves and
 * reveals foreign pins like the full view does). It IS the real canvas over
 * the real derived∘overlay graph, so edits made here persist exactly like
 * edits made in the architect mode.
 *
 * `surfaces` (passed by the host — the pane cannot reach the surfaces mode's
 * provider from here) turns on the screens + endpoints layers, so the pane
 * shows screen→route flow edges: the surface→API contract as edges.
 */
export function ArchPane({
  surfaces,
}: {
  surfaces?: { screens: readonly ScreenSurface[]; calls: readonly ScreenApiCall[] } | null;
}) {
  // Stable input — a fresh object every render would re-derive the graph.
  const surfacesInput = useMemo(
    () => (surfaces ? { ...surfaces, endpoints: true } : null),
    [surfaces],
  );
  const { overviewData, codeSummary, rendered, commitEdited } = useCanonicalArchitecture({
    surfaces: surfacesInput,
  });
  if (!rendered) return null;
  return (
    <ArchitectCanvas
      graph={rendered}
      onChange={commitEdited}
      codeSummary={codeSummary}
      overview={overviewData}
    />
  );
}

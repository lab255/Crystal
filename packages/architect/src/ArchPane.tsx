import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { ScreenApiCall, ScreenSurface } from "@crystal/core";
import { useWorkspaces } from "@crystal/client";
import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { layoutMessiness, shouldOfferMessyLayout } from "./layout-messiness.js";
import { useCanonicalArchitecture } from "./use-canonical-architecture.js";
import { useElkLayout } from "./use-elk-layout.js";

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
  const activeWs = useWorkspaces((state) => state.activeId);
  const { metrics, revision } = useElkLayout(rendered, null);
  const dismissKey = `${activeWs ?? ""}:codebase-embed:${revision}`;
  const [dismissedMessiness, setDismissedMessiness] = useState<string | null>(null);
  const showMessinessBanner = metrics != null
    && shouldOfferMessyLayout(layoutMessiness(metrics), false, 0)
    && dismissedMessiness !== dismissKey;
  if (!rendered) return null;
  return (
    <ArchitectCanvas
      graph={rendered}
      onChange={commitEdited}
      headerExtra={({ runAutoLayout }) => showMessinessBanner ? (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-surface-2/95 px-3 py-1.5 text-xs text-ink shadow-lg backdrop-blur">
          <span>This layout looks tangled</span>
          <button
            type="button"
            className="font-medium text-crystal-300 hover:text-crystal-200"
            onClick={() => runAutoLayout("flow")}
          >
            Re-layout
          </button>
          <button
            type="button"
            className="ml-1 text-ink-faint hover:text-ink"
            aria-label="Dismiss tangled layout suggestion"
            onClick={() => setDismissedMessiness(dismissKey)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
      codeSummary={codeSummary}
      overview={overviewData}
    />
  );
}

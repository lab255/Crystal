import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { useCanonicalArchitecture } from "./use-canonical-architecture.js";

/**
 * The canonical architecture as an embeddable pane — the surfaces mode docks
 * this beside its lists so callers/callees/integrations highlight in place
 * (single click pins via the shared highlight store; the pane resolves and
 * reveals foreign pins like the full view does). It IS the real canvas over
 * the real derived∘overlay graph, so edits made here persist exactly like
 * edits made in the architect mode.
 */
export function ArchPane() {
  const { overviewData, codeSummary, rendered, commitEdited } = useCanonicalArchitecture();
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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canonicalSystemIds,
  composeArchitecture,
  deriveArchGraph,
  deriveC4Model,
  extractOverlay,
  reconcileOverlay,
  type ArchOverlay,
  type ArchitectureGraph,
  type C4Model,
  type CodeMapSummary,
  type ScreenApiCall,
  type ScreenSurface,
  type SystemOverview,
} from "@crystal/core";
import {
  useConnectionState,
  useCrystal,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import { autoLayoutFitted } from "./layout.js";
import { estimateModuleFootprint } from "./live-code.js";
import { buildSystemCardFacts, maxSlot, systemCardSlot } from "./system-card.js";

/**
 * The one canonical architecture, as a hook: fetches the overview + code map
 * (following `codemap.changed`), loads the overlay, derives, reconciles,
 * composes and lays out — returning the graph every host renders and the
 * commit path that turns a canvas edit back into overlay ops. Shared by the
 * architect mode's architecture/infra views and the surfaces mode's
 * embedded architecture pane, so they can never drift apart on the model.
 */
export function useCanonicalArchitecture(options?: {
  /**
   * Screens layer input (the folded-in surfaces map); null/absent = layer
   * off. `endpoints` additionally materializes called routes as `ep:` nodes
   * and retargets the flow edges at them.
   */
  surfaces?: {
    screens: readonly ScreenSurface[];
    calls: readonly ScreenApiCall[];
    endpoints?: boolean;
  } | null;
}): {
  overviewData: SystemOverview | null;
  codeSummary: CodeMapSummary | null;
  derived: ArchitectureGraph | null;
  /**
   * The C4 tier over the same derivation (containers, persons, external
   * split) — the architecture view's projection input. Derived here so its
   * aggregate ids count as known during overlay reconciliation.
   */
  c4Model: C4Model | null;
  reconciled: ArchOverlay | null;
  /**
   * Composed + auto-laid-out at reserved LOD footprints; nodes with explicit
   * x/y overrides keep their own coordinates. This is also the `rendered`
   * baseline `extractOverlay` diffs drags against.
   */
  rendered: ArchitectureGraph | null;
  /**
   * Persist a canvas edit. The edit must be free of anything that is not the
   * user's (review ghosts, view-filtered nodes re-injected) — callers with
   * such decorations clean the graph first.
   */
  commitEdited: (edited: ArchitectureGraph) => void;
} {
  const { client } = useCrystal();
  const connection = useConnectionState();
  const activeWs = useWorkspaces((s) => s.activeId);
  const overlay = useWorkspace((s) => s.archOverlay);
  const loadArchOverlay = useWorkspace((s) => s.loadArchOverlay);
  const updateArchOverlay = useWorkspace((s) => s.updateArchOverlay);
  const surfaces = options?.surfaces ?? null;

  useEffect(() => {
    if (connection === "open") void loadArchOverlay();
  }, [connection, loadArchOverlay]);

  const [codeSummary, setCodeSummary] = useState<CodeMapSummary | null>(null);
  const [overviewData, setOverviewData] = useState<SystemOverview | null>(null);
  const fetchDeriveInputs = useCallback(async () => {
    try {
      const [summary, overview] = await Promise.all([
        client.request("codemap.get", {}),
        client.request("codemap.overview", {}),
      ]);
      setCodeSummary(summary);
      setOverviewData(overview);
    } catch {
      // No analyzable code yet — the canvas stays empty until it appears.
    }
  }, [client]);
  useEffect(() => {
    if (connection === "open") void fetchDeriveInputs();
  }, [fetchDeriveInputs, connection]);
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) void fetchDeriveInputs();
      }),
    [client, fetchDeriveInputs, activeWs],
  );

  const derived = useMemo(
    () =>
      overviewData && codeSummary
        ? deriveArchGraph({
            overview: overviewData,
            externals: codeSummary.externals ?? [],
            modules: codeSummary.modules,
            surfaces,
          })
        : null,
    [overviewData, codeSummary, surfaces],
  );
  const c4Model = useMemo(
    () =>
      overviewData && codeSummary
        ? deriveC4Model({
            overview: overviewData,
            externals: codeSummary.externals ?? [],
            modules: codeSummary.modules,
            deps: codeSummary.deps,
            screens: surfaces?.screens ?? null,
          })
        : null,
    [overviewData, codeSummary, surfaces],
  );
  // Fold the fresh derivation through the overlay (drops dead positional
  // overrides, keeps semantic ones as stale). The C4 aggregates count as
  // known ids so per-level pins and renamed containers survive.
  const reconciled = useMemo(
    () =>
      overlay && derived
        ? reconcileOverlay(
            overlay,
            derived,
            c4Model
              ? ["c4:system", "person:user", ...c4Model.containers.map((c) => c.id)]
              : undefined,
          ).overlay
        : null,
    [overlay, derived, c4Model],
  );
  const rendered = useMemo(() => {
    if (!derived || !reconciled) return null;
    const composed = composeArchitecture(derived, reconciled);
    // Reserved LOD footprints, same convention as the canvas's own
    // auto-layout: each code-linked node is laid out at the size its zoomed
    // expansion needs — raised to its semantic card body's own height where
    // the exports/consumes sections need more — so neither zooming into code
    // nor the card content ever overlaps neighbors.
    const reserve = new Map<string, { width: number; height: number }>();
    if (overviewData) {
      const idOfRaw = canonicalSystemIds(overviewData.systems);
      const cards = buildSystemCardFacts(overviewData);
      for (const s of overviewData.systems) {
        const id = idOfRaw.get(s.id) ?? s.id;
        const footprint = s.fileCount > 0 ? estimateModuleFootprint(s.fileCount) : undefined;
        const card = cards.get(id);
        const slot = card ? maxSlot(footprint, systemCardSlot(card)) : footprint;
        if (slot) reserve.set(id, slot);
      }
    }
    const laid = autoLayoutFitted(composed, { mode: "flow", reserve });
    // Auto-layout owns every node without an explicit x/y override — manual
    // nodes included until their first drag records one.
    const pinned = new Set<string>();
    for (const [id, o] of Object.entries(reconciled.overrides)) {
      if (o.x != null && o.y != null) pinned.add(id);
    }
    if (pinned.size === 0) return laid;
    const composedById = new Map(composed.nodes.map((n) => [n.id, n]));
    return {
      ...laid,
      nodes: laid.nodes.map((n) => (pinned.has(n.id) ? (composedById.get(n.id) ?? n) : n)),
    };
  }, [derived, reconciled, overviewData]);

  const commitEdited = useCallback(
    (edited: ArchitectureGraph) => {
      if (!derived || !rendered || !reconciled) return;
      updateArchOverlay(extractOverlay({ derived, rendered, edited, prev: reconciled }));
    },
    [derived, rendered, reconciled, updateArchOverlay],
  );

  return { overviewData, codeSummary, derived, c4Model, reconciled, rendered, commitEdited };
}

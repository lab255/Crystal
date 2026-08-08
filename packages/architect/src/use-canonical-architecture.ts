import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalSystemIds,
  composeArchitecture,
  deriveArchGraph,
  deriveC4Model,
  extractOverlay,
  reconcileOverlay,
  schemaNodeId,
  type ArchOverlay,
  type ArchitectureGraph,
  type C4Model,
  type CodeMapProgress,
  type CodeMapSummary,
  type ScreenApiCall,
  type SchemaSurface,
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
import { buildSystemCardFacts, systemCardSlot } from "./system-card.js";

const DERIVE_TIMEOUT_MS = 180_000;
const MAX_AUTO_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

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
  /**
   * Screens as *information* (container screen counts, surfaces links) even
   * while the screens layer is off — never adds nodes to the derivation.
   * The layer's own screens win when both are set.
   */
  screens?: readonly ScreenSurface[] | null;
  /** Schema ids that exist only in C4 projections, kept known to the overlay. */
  schemas?: readonly SchemaSurface[] | null;
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
   * Composed + auto-laid-out (system cards at their card slots); nodes with
   * explicit x/y overrides keep their own coordinates. This is also the
   * `rendered` baseline `extractOverlay` diffs drags against.
   */
  rendered: ArchitectureGraph | null;
  /** True while the overview/code-map inputs are being fetched or retried. */
  loading: boolean;
  /** Last derive-input request failure; cleared by the next attempt. */
  error: string | null;
  /** Latest server-side full-pass progress for the active workspace. */
  progress: CodeMapProgress | null;
  /** Immediately retry a failed derive-input request. */
  retry: () => void;
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
  const screensInfo = options?.screens ?? null;
  const schemasInfo = options?.schemas ?? null;

  useEffect(() => {
    if (connection === "open") void loadArchOverlay();
  }, [connection, loadArchOverlay]);

  const [codeSummary, setCodeSummary] = useState<CodeMapSummary | null>(null);
  const [overviewData, setOverviewData] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CodeMapProgress | null>(null);
  const activeWsRef = useRef(activeWs);
  const connectionRef = useRef(connection);
  const dataWsRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<{ ws: string; requestId: number } | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  activeWsRef.current = activeWs;
  connectionRef.current = connection;

  const clearRetryTimer = useCallback(() => {
    if (!retryTimerRef.current) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const fetchDeriveInputs = useCallback(
    async function fetchDeriveInputs(ws: string, attempt = 0): Promise<void> {
      if (connectionRef.current !== "open" || activeWsRef.current !== ws) return;
      if (inFlightRef.current?.ws === ws) return;
      clearRetryTimer();
      const requestId = ++requestIdRef.current;
      inFlightRef.current = { ws, requestId };
      setLoading(true);
      setError(null);
      try {
        const [summary, overview] = await Promise.all([
          client.request("codemap.get", { ws }, { timeoutMs: DERIVE_TIMEOUT_MS }),
          client.request("codemap.overview", { ws }, { timeoutMs: DERIVE_TIMEOUT_MS }),
        ]);
        if (
          requestIdRef.current !== requestId ||
          activeWsRef.current !== ws ||
          connectionRef.current !== "open"
        )
          return;
        dataWsRef.current = ws;
        setCodeSummary(summary);
        setOverviewData(overview);
        setLoading(false);
      } catch (err) {
        if (requestIdRef.current !== requestId || activeWsRef.current !== ws) return;
        if (connectionRef.current !== "open") {
          setLoading(false);
          return;
        }
        const message = (err as Error).message || "Architecture analysis failed";
        console.warn(`[crystal] architecture inputs failed for ${ws}:`, message);
        setLoading(false);
        setError(message);
        if (attempt < MAX_AUTO_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void fetchDeriveInputs(ws, attempt + 1);
          }, delay);
        }
      } finally {
        if (inFlightRef.current?.requestId === requestId) inFlightRef.current = null;
      }
    },
    [client, clearRetryTimer],
  );

  const retry = useCallback(() => {
    const ws = activeWsRef.current;
    if (!ws || connectionRef.current !== "open") return;
    clearRetryTimer();
    void fetchDeriveInputs(ws);
  }, [clearRetryTimer, fetchDeriveInputs]);

  useEffect(
    () =>
      client.events.on("codemap.progress", (update) => {
        if (update.ws !== activeWsRef.current) return;
        setProgress(update);
        if (update.phase !== "done" && dataWsRef.current !== update.ws) setLoading(true);
      }),
    [client],
  );
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (ws === activeWsRef.current) void fetchDeriveInputs(ws);
      }),
    [client, fetchDeriveInputs],
  );
  useEffect(() => {
    clearRetryTimer();
    requestIdRef.current += 1;
    inFlightRef.current = null;
    if (dataWsRef.current !== activeWs) {
      dataWsRef.current = null;
      setCodeSummary(null);
      setOverviewData(null);
      setError(null);
      setProgress(null);
    }
    if (connection !== "open" || !activeWs) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchDeriveInputs(activeWs);
  }, [activeWs, connection, clearRetryTimer, fetchDeriveInputs]);
  useEffect(
    () => () => {
      clearRetryTimer();
      requestIdRef.current += 1;
      inFlightRef.current = null;
    },
    [clearRetryTimer],
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
            screens: surfaces?.screens ?? screensInfo,
          })
        : null,
    [overviewData, codeSummary, surfaces, screensInfo],
  );
  // The surfaces report arrives independently of the code map. Until it
  // resolves, preserve existing schema projection ids so a quick edit cannot
  // prune their pins; an eventual empty report still removes genuinely stale
  // ids because [] is distinct from the loading null.
  const knownSchemaIds = useMemo(() => {
    if (schemasInfo != null) return schemasInfo.map((schema) => schemaNodeId(schema.id));
    if (!overlay) return [];
    const ids = new Set(Object.keys(overlay.overrides).filter((id) => id.startsWith("schema:")));
    for (const positions of Object.values(overlay.c4Layouts)) {
      for (const id of Object.keys(positions)) if (id.startsWith("schema:")) ids.add(id);
    }
    return [...ids];
  }, [schemasInfo, overlay]);
  // Fold the fresh derivation through the overlay (drops dead positional
  // overrides, keeps semantic ones as stale). The C4 aggregates count as
  // known ids so per-level pins, schema entity pins, and renamed containers
  // survive without ever entering the flat graph/extractOverlay path.
  const reconciled = useMemo(
    () =>
      overlay && derived
        ? reconcileOverlay(
            overlay,
            derived,
            c4Model
              ? [
                  "c4:system",
                  "person:user",
                  ...c4Model.containers.map((c) => c.id),
                  ...knownSchemaIds,
                ]
              : undefined,
          ).overlay
        : null,
    [overlay, derived, c4Model, knownSchemaIds],
  );
  const rendered = useMemo(() => {
    if (!derived || !reconciled) return null;
    const composed = composeArchitecture(derived, reconciled);
    // System cards lay out at their card slots (semantic body height), same
    // convention as the canvas's own auto-layout — compact by design; a live
    // code expansion displaces neighbors instead of pre-claiming space.
    const reserve = new Map<string, { width: number; height: number }>();
    if (overviewData) {
      const idOfRaw = canonicalSystemIds(overviewData.systems);
      const cards = buildSystemCardFacts(overviewData);
      for (const s of overviewData.systems) {
        const id = idOfRaw.get(s.id) ?? s.id;
        const card = cards.get(id);
        if (card) reserve.set(id, systemCardSlot(card));
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

  return {
    overviewData,
    codeSummary,
    derived,
    c4Model,
    reconciled,
    rendered,
    loading,
    error,
    progress,
    retry,
    commitEdited,
  };
}

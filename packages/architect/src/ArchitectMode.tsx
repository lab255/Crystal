import "@xyflow/react/dist/style.css";
import "./architect.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Boxes,
  Check,
  CloudUpload,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Globe2,
  Layers,
  MoreHorizontal,
  PencilRuler,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  ARCH_OVERLAY_FILE,
  canonicalSystemIds,
  composeArchitecture,
  countMarks,
  createArchDraft as newArchDraft,
  createArchFacet,
  createEpic,
  createTask,
  deriveArchGraph,
  diffSystemOverviews,
  extractOverlay,
  formatDiffCounts,
  overviewDiffGhosts,
  overviewDiffMarks,
  graphsEqual,
  matchAgent,
  mergeDiagramIntoOverlay,
  mergeGraphs,
  reconcileOverlay,
  suggestFacets,
  type ArchDraft,
  type ArchOverlay,
  type ArchitectureGraph,
  type CodeIndex,
  type CodeMapSummary,
  type CodeTrace,
  type CodeTraceStep,
  type FacetSuggestion,
  type SurfaceMapReport,
  type SurfacesReport,
  type SystemOverview,
  type TaskItem,
} from "@crystal/core";
import {
  DiagramLegend,
  RefReviewBar,
  useAgents,
  useConnectionState,
  useCrystal,
  useNav,
  useNavUpdate,
  useRefReview,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Pane,
  Split,
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";
import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { CodeMapView, requestOpenFile } from "./codemap/CodeMapView.js";
import { ChangesPanel } from "./codemap/ChangesPanel.js";
import { DuplicatesPanel } from "./codemap/DuplicatesPanel.js";
import { ReviewPanel } from "./codemap/ReviewPanel.js";
import type { MoveLikeIntent } from "./codemap/map-model.js";
import { projectTrace, stepKeyOf } from "./dataflow.js";
import { InfraView } from "./InfraView.js";
import { ContractsPanel } from "./panels/ContractsPanel.js";
import { DiffPanel } from "./panels/DiffPanel.js";
import { InsightsPanel } from "./panels/InsightsPanel.js";
import { FlowStepsPanel, JourneysSection, type JourneySeed } from "./JourneyPanel.js";
import { JourneyProfilePanel } from "./ProfilePanel.js";
import { useRefactorIntents } from "./refactor-intents.js";
import { buildHoistPrompt } from "./refactor-prompts.js";
import { ApplyRefactorsDialog, RefactorChip, useIntentProblems } from "./RefactorPanel.js";
import { autoLayout } from "./layout.js";
import { estimateModuleFootprint } from "./live-code.js";
import { ReviewView } from "./ReviewView.js";
import { SurveySection } from "./SurveyPanel.js";
import { SystemsView, type OpenCodeFacet } from "./systems/SystemsView.js";

const EMPTY_DRAFTS: never[] = [];
const EMPTY_REFACTORS: never[] = [];
const EMPTY_PROJECTS: never[] = [];
const EMPTY_RUNS: never[] = [];
const REF_NEED_OVERVIEW = ["overview"] as const;
const DIFF_LEGEND = [
  { swatchClassName: "border border-ok/70 bg-ok/20", label: "added" },
  { swatchClassName: "border border-dashed border-danger/70 bg-danger/15", label: "removed" },
  { swatchClassName: "border border-warn/70 bg-warn/20", label: "changed" },
] as const;

type ArchitectView = "systems" | "architecture" | "infra" | "codebase";

export function ArchitectMode() {
  // View + draft selection live in the deep-linkable nav store.
  const nav = useNavUpdate();
  const rawView = useNav((l) => l.architect?.view) ?? "systems";
  // Consolidated ids: `architecture` absorbs the old `diagrams` canvas and
  // `codebase` the old `codemap` — legacy links land on their successors.
  const view: ArchitectView =
    rawView === "diagrams" ? "architecture" : rawView === "codemap" ? "codebase" : rawView;
  const setView = useCallback(
    (v: ArchitectView) => nav({ architect: { view: v } }),
    [nav],
  );
  // "Zoom into this module/file" — the canvas expands the matching node in place.
  const expandNonce = useRef(0);
  const [expandRequest, setExpandRequest] = useState<{
    module: string;
    file?: string;
    nonce: number;
  } | null>(null);
  // "Open in code" from the systems view also carries the slice being looked
  // at — DiagramsView materializes it as a facet and activates it, so the
  // destination (view + diagram + facet) is a shareable deep link.
  const [facetRequest, setFacetRequest] = useState<(OpenCodeFacet & { nonce: number }) | null>(
    null,
  );
  // "Start journey here…" on a symbol prefills the journey dialog.
  const [journeySeed, setJourneySeed] = useState<JourneySeed | null>(null);
  // Lifted here so the code map sees the open draft (drag-refactor targets it).
  const draftPath = useNav((l) => l.architect?.draft) ?? null;
  const setDraftPath = useCallback(
    // Leaving draft mode also leaves review mode — review is a draft lens.
    (path: string | null) => nav({ architect: path ? { draft: path } : { draft: null, review: false } }),
    [nav],
  );

  const activeWs = useWorkspaces((s) => s.activeId);
  const setActiveWs = useWorkspaces((s) => s.setActive);

  /** Drilling stays in the unified canvas: expand the node linked to the module. */
  const expandCode = useCallback(
    (module: string, file?: string, facet?: OpenCodeFacet) => {
      setView("architecture");
      setExpandRequest({ module, file, nonce: ++expandNonce.current });
      if (facet) setFacetRequest({ ...facet, nonce: expandNonce.current });
    },
    [setView],
  );

  /** The standalone map: cross-workspace level, plus drilled module/file deep links. */
  const openWorkspacesMap = useCallback(
    () => nav({ architect: { view: "codebase", codemap: { kind: "all" } } }),
    [nav],
  );

  const startJourneyFromCode = useCallback(
    (seed: JourneySeed) => {
      setJourneySeed(seed);
      setView("architecture");
    },
    [setView],
  );

  /** Systems-view "Open in code": reveal the module, carrying the facet along. */
  const openCodeFromSystems = useCallback(
    (module: string, facet?: OpenCodeFacet) => expandCode(module, undefined, facet),
    [expandCode],
  );

  // Global find — one query shared by every subview (each dims its misses);
  // lives in nav so it survives view switches and deep-links (?find=…).
  const find = useNav((l) => l.architect?.find) ?? "";
  const setFind = useCallback((v: string) => nav({ architect: { find: v || null } }), [nav]);
  const findRef = useRef<HTMLInputElement | null>(null);
  const activeMode = useNav((l) => l.mode) ?? "architect";
  useEffect(() => {
    if (activeMode !== "architect") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode]);

  const tab = (
    v: ArchitectView,
    icon: React.ReactNode,
    label: React.ReactNode,
    onClick: () => void = () => setView(v),
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        view === v ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
        <span className="text-[13px] font-semibold text-ink">Architecture</span>
        <div className="ml-3 flex w-60 items-center gap-1.5 rounded-lg border border-edge bg-surface-2 px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-ink-faint" />
          <input
            ref={findRef}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFind("");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Find in all views…"
            aria-label="Find across systems, code and infrastructure"
            className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
          {find ? (
            <button type="button" onClick={() => setFind("")} aria-label="Clear find">
              <X className="h-3 w-3 text-ink-faint hover:text-ink" />
            </button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {/* Cross-workspace map — always one click away when reviewing how the systems relate. */}
          {/* Restores its last drill level; the in-view breadcrumb reaches the cross-workspace map. */}
          {tab("codebase", <Layers className="h-3.5 w-3.5" />, "Codebase")}
          {tab("systems", <Boxes className="h-3.5 w-3.5" />, "Systems")}
          {tab(
            "architecture",
            <PencilRuler className="h-3.5 w-3.5" />,
            <>
              Architecture
              <span className="rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">live</span>
            </>,
          )}
          {tab("infra", <Globe2 className="h-3.5 w-3.5" />, "Infrastructure")}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {view === "systems" ? (
          <SystemsView onOpenCode={openCodeFromSystems} />
        ) : view === "codebase" ? (
          <CodeMapView
            origin={{ label: "Architecture", onExit: () => setView("architecture") }}
            onEnterWorkspace={(ws) => {
              if (ws !== activeWs) setActiveWs(ws);
              setView("architecture");
            }}
            onStartJourney={startJourneyFromCode}
            onRevealInDiagram={expandCode}
            activeDraftPath={draftPath}
            onOpenDraft={setDraftPath}
          />
        ) : (
          <DiagramsView
            variant={view}
            expandRequest={expandRequest}
            facetRequest={facetRequest}
            onExpandCode={expandCode}
            onOpenWorkspacesMap={openWorkspacesMap}
            journeySeed={journeySeed}
            onStartJourney={startJourneyFromCode}
            onJourneySeedConsumed={() => setJourneySeed(null)}
            draftPath={draftPath}
            onDraftPathChange={setDraftPath}
          />
        )}
      </div>
    </div>
  );
}

function DiagramsView({
  variant,
  expandRequest,
  facetRequest,
  onExpandCode,
  onOpenWorkspacesMap,
  journeySeed,
  onStartJourney,
  onJourneySeedConsumed,
  draftPath,
  onDraftPathChange: setDraftPath,
}: {
  variant: "architecture" | "infra";
  expandRequest: { module: string; file?: string; nonce: number } | null;
  facetRequest: (OpenCodeFacet & { nonce: number }) | null;
  onExpandCode: (module: string, file?: string) => void;
  onOpenWorkspacesMap: () => void;
  journeySeed: JourneySeed | null;
  onStartJourney: (seed: JourneySeed) => void;
  onJourneySeedConsumed: () => void;
  draftPath: string | null;
  onDraftPathChange: (path: string | null) => void;
}) {
  const archDrafts = useWorkspace((s) => s.info?.archDrafts ?? EMPTY_DRAFTS);
  const loading = useWorkspace((s) => s.loading && !s.info);
  const pendingSaves = useWorkspace((s) => s.pendingSaves);
  const overlay = useWorkspace((s) => s.archOverlay);
  const loadArchOverlay = useWorkspace((s) => s.loadArchOverlay);
  const updateArchOverlay = useWorkspace((s) => s.updateArchOverlay);
  const updateArchDraft = useWorkspace((s) => s.updateArchDraft);
  const createDraftFile = useWorkspace((s) => s.createArchDraft);
  const deleteArchDraft = useWorkspace((s) => s.deleteArchDraft);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const updateProject = useWorkspace((s) => s.updateProject);
  const roster = useWorkspace((s) => s.roster);

  const nav = useNavUpdate();
  const infoLoaded = useWorkspace((s) => s.info != null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);

  // Split-pane draft review (deep-linkable: ?draft=…&review=1).
  const reviewOn = useNav((l) => l.architect?.review) ?? false;
  const setReviewOn = useCallback(
    (on: boolean) => nav({ architect: { review: on } }),
    [nav],
  );

  // Live code map for the diagram overlay — kept fresh by codemap.changed.
  const { client } = useCrystal();
  const connection = useConnectionState();
  const activeWs = useWorkspaces((s) => s.activeId);
  const overlayOn = useNav((l) => l.architect?.overlay) ?? false;
  const setOverlayOn = useCallback(
    (on: boolean) => nav({ architect: { overlay: on } }),
    [nav],
  );
  const [codeSummary, setCodeSummary] = useState<CodeMapSummary | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setCodeSummary(await client.request("codemap.get", {}));
    } catch {
      // Bridge closed or workspace has no analyzable code; overlay stays off.
    }
  }, [client]);

  useEffect(() => {
    if (connection === "open") void fetchSummary();
  }, [fetchSummary, connection]);
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) void fetchSummary();
      }),
    [client, fetchSummary, activeWs],
  );

  /* ---- the one canonical architecture: derived ∘ overlay ---- */

  useEffect(() => {
    if (connection === "open") void loadArchOverlay();
  }, [connection, loadArchOverlay]);

  // The logical overview drives the derivation; follows the code.
  const [overviewData, setOverviewData] = useState<SystemOverview | null>(null);
  const fetchOverview = useCallback(async () => {
    try {
      setOverviewData(await client.request("codemap.overview", {}));
    } catch {
      // No analyzable code yet — the canvas stays empty until it appears.
    }
  }, [client]);
  useEffect(() => {
    if (connection === "open") void fetchOverview();
  }, [fetchOverview, connection]);
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) void fetchOverview();
      }),
    [client, fetchOverview, activeWs],
  );

  // Screens layer (the folded-in surfaces map): screens + their API call
  // flows join the derivation when the `layers` param asks for them.
  const layersParam = useNav((l) => l.architect?.layers) ?? null;
  const screensOn = layersParam?.split(",").includes("screens") ?? false;
  const setScreensOn = useCallback(
    (on: boolean) => nav({ architect: { layers: on ? "screens" : null } }),
    [nav],
  );
  const [screensData, setScreensData] = useState<{
    screens: SurfacesReport["screens"];
    calls: SurfaceMapReport["calls"];
  } | null>(null);
  const fetchScreens = useCallback(async () => {
    try {
      const [report, map] = await Promise.all([
        client.request("surfaces.get", {}),
        client.request("surfaces.map", {}),
      ]);
      setScreensData({ screens: report.screens, calls: map.calls });
    } catch {
      // No analyzable frontend — the layer simply stays empty.
    }
  }, [client]);
  useEffect(() => {
    if (!screensOn) return;
    if (connection === "open") void fetchScreens();
  }, [screensOn, connection, fetchScreens]);
  useEffect(() => {
    if (!screensOn) return;
    return client.events.on("codemap.changed", ({ ws }) => {
      if (!activeWs || ws === activeWs) void fetchScreens();
    });
  }, [client, screensOn, fetchScreens, activeWs]);

  const derived = useMemo(
    () =>
      overviewData && codeSummary
        ? deriveArchGraph({
            overview: overviewData,
            externals: codeSummary.externals ?? [],
            modules: codeSummary.modules,
            surfaces: screensOn ? screensData : null,
          })
        : null,
    [overviewData, codeSummary, screensOn, screensData],
  );
  // Fold the fresh derivation through the overlay (drops dead positional
  // overrides, keeps semantic ones as stale).
  const reconciled = useMemo(
    () => (overlay && derived ? reconcileOverlay(overlay, derived).overlay : null),
    [overlay, derived],
  );
  /**
   * What the canvas shows: composed, then auto-laid-out — except nodes the
   * user positioned (overrides) or created (manual), which keep their own
   * coordinates. This is also the `rendered` baseline `extractOverlay` diffs
   * drags against, so deterministic layout positions never persist.
   */
  const rendered = useMemo(() => {
    if (!derived || !reconciled) return null;
    const composed = composeArchitecture(derived, reconciled);
    // Reserved LOD footprints, same convention as the canvas's own
    // auto-layout: each code-linked node is laid out at the size its zoomed
    // expansion needs, so zooming into code never overlaps neighbors.
    const reserve = new Map<string, { width: number; height: number }>();
    if (overviewData) {
      const idOfRaw = canonicalSystemIds(overviewData.systems);
      for (const s of overviewData.systems) {
        if (s.fileCount > 0)
          reserve.set(idOfRaw.get(s.id) ?? s.id, estimateModuleFootprint(s.fileCount));
      }
    }
    const laid = autoLayout(composed, { mode: "flow", reserve });
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

  /* ---- ref review: "vs <ref>" on the canonical architecture ---- */

  const vsParam = useNav((l) => l.architect?.vs ?? null);
  const setVsParam = useCallback((ref: string | null) => nav({ architect: { vs: ref } }), [nav]);
  const refReview = useRefReview({
    param: vsParam,
    setParam: setVsParam,
    need: REF_NEED_OVERVIEW,
  });
  const archDiff = useMemo(() => {
    const base = refReview.snapshot?.overview;
    if (!base || !overviewData) return null;
    const idOfRaw = canonicalSystemIds(overviewData.systems);
    const idOf = (raw: string) => idOfRaw.get(raw) ?? raw;
    const diff = diffSystemOverviews(base, overviewData);
    return {
      diff,
      marks: overviewDiffMarks(diff, idOf),
      ghosts: overviewDiffGhosts(diff, idOf),
    };
  }, [refReview.snapshot, overviewData]);
  const ghostIds = useMemo(
    () =>
      new Set([
        ...(archDiff?.ghosts.nodes.map((n) => n.id) ?? []),
        ...(archDiff?.ghosts.edges.map((e) => e.id) ?? []),
      ]),
    [archDiff],
  );
  /**
   * What the canvas shows under a review: the rendered graph plus base-only
   * ghosts, laid out together so removals occupy space. `rendered` itself
   * stays ghost-free — it is the baseline drafts and overlay extraction
   * diff against.
   */
  const displayGraph = useMemo(() => {
    if (!rendered || !archDiff || ghostIds.size === 0) return rendered;
    const nodeIds = new Set(rendered.nodes.map((n) => n.id));
    const merged: ArchitectureGraph = {
      ...rendered,
      nodes: [...rendered.nodes, ...archDiff.ghosts.nodes.filter((g) => !nodeIds.has(g.id))],
      edges: [
        ...rendered.edges,
        ...archDiff.ghosts.edges.filter((g) => !rendered.edges.some((e) => e.id === g.id)),
      ],
    };
    const laid = autoLayout(merged, { mode: "flow" });
    const renderedById = new Map(rendered.nodes.map((n) => [n.id, n]));
    return {
      ...laid,
      nodes: laid.nodes.map((n) => renderedById.get(n.id) ?? n),
    };
  }, [rendered, archDiff, ghostIds]);

  /** A canvas edit of the canonical graph → overlay ops, debounce-persisted. */
  const commitCanonical = useCallback(
    (edited: ArchitectureGraph) => {
      if (!derived || !rendered || !reconciled) return;
      // Review ghosts exist only at the base ref — never part of the edit.
      const clean =
        ghostIds.size === 0
          ? edited
          : {
              ...edited,
              nodes: edited.nodes.filter((n) => !ghostIds.has(n.id)),
              edges: edited.edges.filter((e) => !ghostIds.has(e.id)),
            };
      updateArchOverlay(extractOverlay({ derived, rendered, edited: clean, prev: reconciled }));
    },
    [derived, rendered, reconciled, ghostIds, updateArchOverlay],
  );

  // Old `?diagram=` deep links resolve to the facet their diagram migrated to.
  const diagramParam = useNav((l) => l.architect?.diagram) ?? null;
  useEffect(() => {
    if (!diagramParam || !reconciled) return;
    const facet = reconciled.facets.find((f) => f.sourcePath === diagramParam);
    nav({ architect: { diagram: null, ...(facet ? { facet: facet.id } : {}) } });
  }, [diagramParam, reconciled, nav]);

  const activeDraft = archDrafts.find((d) => d.path === draftPath) ?? null;

  // Leave draft mode if the draft vanished. Only once workspace info is in —
  // a deep-linked draft must survive loading.
  useEffect(() => {
    if (infoLoaded && draftPath && !activeDraft) setDraftPath(null);
  }, [infoLoaded, draftPath, activeDraft]);

  // The graph being edited right now — the draft's while a draft is open.
  const effectiveGraph = activeDraft ? activeDraft.draft.graph : rendered;
  const commitGraph = useCallback(
    (graph: ArchitectureGraph) => {
      if (activeDraft) {
        updateArchDraft(activeDraft.path, {
          ...activeDraft.draft,
          graph,
          updatedAt: new Date().toISOString(),
        });
      } else {
        commitCanonical(graph);
      }
    },
    [activeDraft, updateArchDraft, commitCanonical],
  );

  /* ---- facets: named lenses over the selected diagram ---- */
  const activeFacetId = useNav((l) => l.architect?.facet) ?? null;
  const setActiveFacetId = useCallback(
    (id: string | null) => nav({ architect: { facet: id } }),
    [nav],
  );
  // Clear a dangling facet only against a loaded graph — deep links arrive
  // first, and switching diagrams invalidates the previous diagram's facets.
  useEffect(() => {
    if (effectiveGraph && activeFacetId && !effectiveGraph.facets.some((f) => f.id === activeFacetId)) {
      setActiveFacetId(null);
    }
  }, [effectiveGraph, activeFacetId, setActiveFacetId]);

  // A facet handed over by the systems view ("Open in code"): highlight just
  // the files the user was looking at. Matching nodes are found through their
  // code links; a same-named facet is refreshed rather than duplicated. The
  // facet persists on the diagram and activates via nav, so the resulting
  // screen (?diagram=…&facet=…) is a shareable deep link.
  const consumedFacetNonce = useRef(0);
  useEffect(() => {
    if (!facetRequest || facetRequest.nonce === consumedFacetNonce.current) return;
    if (!infoLoaded || !effectiveGraph) return;
    consumedFacetNonce.current = facetRequest.nonce;
    const modules = new Set(facetRequest.modules);
    const inPaths = (file: string) =>
      facetRequest.paths.some((p) => file === p || file.startsWith(`${p}/`));
    const nodeIds = effectiveGraph.nodes
      .filter(
        (n) =>
          (n.codeModule && modules.has(n.codeModule)) || (n.codeFile && inPaths(n.codeFile)),
      )
      .map((n) => n.id);
    // Nothing mapped on this diagram — the expand request still reveals the module.
    if (nodeIds.length === 0) return;
    const existing = effectiveGraph.facets.find(
      (f) => f.name.trim().toLowerCase() === facetRequest.name.trim().toLowerCase(),
    );
    const description = `Files of “${facetRequest.name}” — from the systems overview`;
    if (existing) {
      commitGraph({
        ...effectiveGraph,
        facets: effectiveGraph.facets.map((f) =>
          f.id === existing.id ? { ...f, nodeIds, description: f.description || description } : f,
        ),
      });
      setActiveFacetId(existing.id);
    } else {
      const facet = { ...createArchFacet(facetRequest.name, nodeIds), description };
      commitGraph({ ...effectiveGraph, facets: [...effectiveGraph.facets, facet] });
      setActiveFacetId(facet.id);
    }
  }, [facetRequest, infoLoaded, effectiveGraph, commitGraph, setActiveFacetId]);

  /* ---- journeys / dataflow lens ---- */
  const activeJourneyId = useNav((l) => l.architect?.journey) ?? null;
  const setActiveJourneyId = useCallback(
    (id: string | null) => nav({ architect: { journey: id } }),
    [nav],
  );
  const [journeyTrace, setJourneyTrace] = useState<CodeTrace | null>(null);
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [traceGeneration, setTraceGeneration] = useState(0);

  const activeJourney = effectiveGraph?.journeys.find((j) => j.id === activeJourneyId) ?? null;
  // Clear a dangling journey only against a loaded graph — deep links arrive first.
  useEffect(() => {
    if (effectiveGraph && activeJourneyId && !activeJourney) setActiveJourneyId(null);
  }, [effectiveGraph, activeJourneyId, activeJourney, setActiveJourneyId]);

  // The trace follows the code: re-trace whenever the map re-analyzes.
  useEffect(
    () =>
      client.events.on("codemap.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) setTraceGeneration((g) => g + 1);
      }),
    [client, activeWs],
  );

  const entryFile = activeJourney?.entry.file ?? null;
  const entrySymbol = activeJourney?.entry.symbol ?? null;
  useEffect(() => {
    if (!entryFile || !entrySymbol) {
      setJourneyTrace(null);
      setJourneyError(null);
      return;
    }
    let cancelled = false;
    setJourneyError(null);
    client
      .request("codemap.trace", { file: entryFile, symbol: entrySymbol })
      .then((trace) => !cancelled && setJourneyTrace(trace))
      .catch((err: Error) => {
        if (!cancelled) {
          setJourneyTrace(null);
          setJourneyError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, entryFile, entrySymbol, traceGeneration]);

  const flow = useMemo(
    () =>
      activeJourney && journeyTrace && codeSummary && effectiveGraph
        ? projectTrace(journeyTrace, effectiveGraph, codeSummary)
        : null,
    [activeJourney, journeyTrace, codeSummary, effectiveGraph],
  );

  // Clicking a flamegraph frame / trace step points at the component it
  // belongs to on the canvas (selects it, pans to it, pulses it).
  const highlightNonce = useRef(0);
  const [highlightRequest, setHighlightRequest] = useState<{
    nodeId: string;
    nonce: number;
  } | null>(null);
  const highlightStep = useCallback(
    (step: CodeTraceStep) => {
      const nodeId = flow?.stepNodeIds.get(stepKeyOf(step));
      if (nodeId) setHighlightRequest({ nodeId, nonce: ++highlightNonce.current });
    },
    [flow],
  );

  const draftRefactors = activeDraft?.draft.refactors ?? EMPTY_REFACTORS;
  const refactorProblems = useIntentProblems(draftRefactors);
  const moves = useMemo(
    () =>
      draftRefactors.filter(
        (r): r is MoveLikeIntent => r.kind === "move" || r.kind === "moveFile",
      ),
    [draftRefactors],
  );

  // Drag-a-symbol/file refactor intents from the unified canvas (plan mode).
  const { dropNotice, setDropNotice, recordMove, recordFileMove, recordHoist } =
    useRefactorIntents({ activeDraftPath: draftPath, onOpenDraft: setDraftPath });
  useEffect(() => {
    if (!dropNotice) return;
    setNotice(dropNotice);
    setDropNotice(null);
  }, [dropNotice, setDropNotice]);

  const showDuplicates = useNav((l) => l.architect?.duplicates) ?? false;
  const setShowDuplicates = useCallback(
    (on: boolean) => nav({ architect: { duplicates: on } }),
    [nav],
  );
  const showFindings = useNav((l) => l.architect?.findings) ?? false;
  const setShowFindings = useCallback(
    (on: boolean) => nav({ architect: { findings: on } }),
    [nav],
  );
  const showChanges = useNav((l) => l.architect?.changes) ?? false;
  const setShowChanges = useCallback(
    (on: boolean) => nav({ architect: { changes: on } }),
    [nav],
  );
  // Insights + contracts — ported from the systems overview; same deep-link
  // params, so old systems URLs land with the right panels open.
  const showInsights = useNav((l) => l.architect?.insights) ?? false;
  const setShowInsights = useCallback(
    (on: boolean) => nav({ architect: { insights: on } }),
    [nav],
  );
  const showContracts = useNav((l) => l.architect?.contracts) ?? false;
  const setShowContracts = useCallback(
    (on: boolean) => nav({ architect: { contracts: on } }),
    [nav],
  );
  /** Selected boundary — raw "source->target" overview key (the `edge` param). */
  const activeEdgeKey = useNav((l) => l.architect?.edge) ?? null;
  const setActiveEdgeKey = useCallback(
    (key: string | null) => nav({ architect: { edge: key, ...(key ? { contracts: true } : {}) } }),
    [nav],
  );
  /** Focus a system on the canvas by its RAW overview id (panels speak raw ids). */
  const focusSystem = useCallback(
    (rawId: string) => {
      if (!overviewData) return;
      const canonical = canonicalSystemIds(overviewData.systems).get(rawId) ?? rawId;
      setHighlightRequest({ nodeId: canonical, nonce: ++highlightNonce.current });
    },
    [overviewData],
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  const selectedDrafts = archDrafts;
  // A draft's base predating the current canonical graph (code moved on, or
  // the draft was made against a pre-migration diagram) — open to rebase.
  const draftStale = (d: ArchDraft) => rendered != null && !graphsEqual(d.base, rendered);

  const saving = Object.keys(pendingSaves).length > 0;

  async function startDraft() {
    if (!rendered) return;
    const n = selectedDrafts.length + 1;
    const draft = newArchDraft(
      `Plan ${n > 1 ? n : ""}`.trim(),
      ARCH_OVERLAY_FILE,
      rendered,
      new Date().toISOString(),
    );
    const created = await createDraftFile(draft);
    setDraftPath(created.path);
  }

  function applyDraft() {
    if (!activeDraft || !rendered) return;
    if (activeDraft.draft.refactors.length > 0) {
      setApplyDialogOpen(true);
      return;
    }
    void finalizeApply();
  }

  async function finalizeApply() {
    if (!activeDraft || !rendered) return;
    setApplyBusy(true);
    try {
      let graph = activeDraft.draft.graph;
      let notes: string[] = [];
      if (!graphsEqual(activeDraft.draft.base, rendered)) {
        const merged = mergeGraphs(activeDraft.draft.base, activeDraft.draft.graph, rendered);
        graph = merged.graph;
        notes = merged.conflicts;
      }
      commitCanonical(graph);

      const moves = activeDraft.draft.refactors.filter(
        (r) => r.kind === "move" || r.kind === "moveFile",
      );
      const hoists = activeDraft.draft.refactors.filter((r) => r.kind === "hoist");
      if (moves.length > 0) {
        try {
          const result = await client.request("refactor.apply", { intents: moves });
          if (result.applied.length > 0) {
            notes.push(`${result.applied.length} move${result.applied.length > 1 ? "s" : ""} applied`);
          }
          for (const failure of result.failed) {
            const intent = moves.find((m) => m.id === failure.intentId);
            const what =
              intent?.kind === "move" ? intent.symbol
              : intent?.kind === "moveFile" ? intent.fromFile
              : failure.intentId;
            notes.push(`move ${what} failed: ${failure.error}`);
          }
        } catch (err) {
          notes.push(`refactor engine error: ${(err as Error).message}`);
        }
      }
      // Hoists become board tasks, not immediate agent runs: the plan lands as
      // an epic on the project board, each task owned by the tag-matched
      // specialist (or default generic agent) + the default human, carrying
      // its prepared prompt for dispatch from the board.
      if (hoists.length > 0) {
        const target = projects[0];
        if (!target) {
          notes.push("no project board — hoists skipped");
        } else {
          const epic = createEpic(activeDraft.draft.name);
          const baseOrder =
            Math.max(0, ...target.project.tasks.map((t) => t.order)) + 1;
          const tasks: TaskItem[] = [];
          for (const [i, hoist] of hoists.entries()) {
            const sources = await Promise.all(
              hoist.symbols.map(async (s) => {
                try {
                  const src = await client.request("codemap.symbolSource", { file: s.file, symbol: s.symbol });
                  return { ...s, startLine: src.startLine, endLine: src.endLine, text: src.text };
                } catch {
                  return { ...s };
                }
              }),
            );
            const name = hoist.newName ?? hoist.symbols[0]?.symbol ?? "symbol";
            const labels = ["kind:refactor", "source:draft"];
            const task = createTask(`Hoist ${name} → ${hoist.targetModule}`);
            task.description = `Consolidate ${hoist.symbols.length} duplicate implementation${
              hoist.symbols.length > 1 ? "s" : ""
            } into ${hoist.targetModule}. Planned in draft "${activeDraft.draft.name}".`;
            task.labels = labels;
            task.epicId = epic.id;
            task.size = "s";
            task.agentPrompt = buildHoistPrompt(hoist, sources);
            task.links = {
              nodeIds: [],
              repoIds: [],
              files: [...new Set(hoist.symbols.map((s) => s.file))],
            };
            if (roster) {
              task.owners = {
                agentId: matchAgent(labels, roster)?.id ?? null,
                human: roster.defaultHuman || null,
              };
            }
            task.order = baseOrder + i;
            tasks.push(task);
          }
          updateProject(target.path, {
            ...target.project,
            epics: [...target.project.epics, epic],
            tasks: [...target.project.tasks, ...tasks],
          });
          notes.push(
            `${tasks.length} hoist${tasks.length > 1 ? "s" : ""} queued on the board (epic "${epic.name}")`,
          );
        }
      }

      void deleteArchDraft(activeDraft.path);
      setDraftPath(null);
      setApplyDialogOpen(false);
      setNotice(notes.length ? `Draft applied — ${notes.join(" · ")}` : "Draft applied.");
    } finally {
      setApplyBusy(false);
    }
  }

  function removeRefactor(id: string) {
    if (!activeDraft) return;
    updateArchDraft(activeDraft.path, {
      ...activeDraft.draft,
      refactors: activeDraft.draft.refactors.filter((r) => r.id !== id),
      updatedAt: new Date().toISOString(),
    });
  }

  function rebaseActiveDraft() {
    if (!activeDraft || !rendered) return;
    const merged = mergeGraphs(activeDraft.draft.base, activeDraft.draft.graph, rendered);
    updateArchDraft(activeDraft.path, {
      ...activeDraft.draft,
      base: rendered,
      graph: merged.graph,
      updatedAt: new Date().toISOString(),
    });
    setNotice(
      merged.conflicts.length
        ? `Rebased with ${merged.conflicts.length} note${merged.conflicts.length > 1 ? "s" : ""}: ${merged.conflicts.join(" · ")}`
        : "Draft rebased onto the latest diagram.",
    );
  }

  function discardDraft() {
    if (!activeDraft) return;
    void deleteArchDraft(activeDraft.path);
    setDraftPath(null);
  }

  return (
    <div className="h-full min-h-0">
      <Split storageKey="architect:diagrams" direction="horizontal">
        <Pane defaultSize={224} minSize={176} maxSize={440}>
          <aside className="flex h-full w-full flex-col bg-surface-1">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Architecture
          </span>
          <Tooltip
            content={
              saving
                ? "Saving…"
                : "Derived from the code — your edits save to .crystal/architecture/overlay.json"
            }
          >
            <span className="text-ink-faint">
              {saving ? (
                <CloudUpload className="h-3.5 w-3.5 animate-pulse text-info" />
              ) : (
                <Check className="h-3.5 w-3.5 text-ok/70" />
              )}
            </span>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {variant === "architecture" && rendered ? (
            <>
              <div className="flex items-center justify-between px-1.5 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Draft plans
                </span>
                <Tooltip content="New draft plan — rearrange safely, apply when ready">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void startDraft()}
                    aria-label="New draft plan"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              </div>
              {selectedDrafts.map((d) => (
                <div
                  key={d.path}
                  className={cn(
                    "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer",
                    draftPath === d.path
                      ? "bg-warn/15 text-ink"
                      : "text-ink-muted hover:bg-surface-2 hover:text-ink",
                  )}
                  onClick={() => setDraftPath(d.path)}
                >
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-warn/80" />
                  <span className="min-w-0 flex-1 truncate">{d.draft.name}</span>
                  {draftStale(d.draft) ? (
                    <Tooltip content="The diagram changed since this draft was created — open to rebase">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                    </Tooltip>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Draft actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        className="text-danger"
                        onSelect={() => {
                          if (draftPath === d.path) setDraftPath(null);
                          void deleteArchDraft(d.path);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Delete draft
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
              {selectedDrafts.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-ink-faint">
                  Rearrange safely — drafts only touch the diagram when applied.
                </div>
              ) : null}
              {effectiveGraph ? (
                <FacetsSection
                  graph={effectiveGraph}
                  activeFacetId={activeFacetId}
                  onActivate={setActiveFacetId}
                  onGraphChange={commitGraph}
                  onNotice={setNotice}
                />
              ) : null}
              {effectiveGraph ? (
                <JourneysSection
                  graph={effectiveGraph}
                  activeJourneyId={activeJourneyId}
                  onActivate={setActiveJourneyId}
                  onGraphChange={commitGraph}
                  seed={journeySeed}
                  onSeedConsumed={onJourneySeedConsumed}
                />
              ) : null}
            </>
          ) : null}

          <SurveySection
            onImportGraph={(path, graph) => {
              if (overviewData && reconciled)
                updateArchOverlay(
                  mergeDiagramIntoOverlay(reconciled, { path, graph }, overviewData),
                );
            }}
            onNotice={setNotice}
          />
        </div>
      </aside>
        </Pane>

        <Pane minSize="30%">
          <Split storageKey="architect:journey" direction="vertical">
            <Pane minSize="35%">
              <main className="relative h-full w-full min-w-0">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : rendered ? (
          <>
          {variant === "infra" ? (
            <InfraView
              key="canonical"
              graph={displayGraph ?? rendered}
              onChange={commitCanonical}
              summary={codeSummary}
              diffMarks={archDiff?.marks ?? null}
            />
          ) : (
            <>
              {activeDraft && reviewOn ? (
                <ReviewView key={activeDraft.path} draft={activeDraft.draft} />
              ) : (
                <ArchitectCanvas
                  key={activeDraft ? activeDraft.path : "canonical"}
                  graph={activeDraft ? activeDraft.draft.graph : (displayGraph ?? rendered)}
                  diffMarks={activeDraft ? null : (archDiff?.marks ?? null)}
                  onChange={commitGraph}
                  codeSummary={codeSummary}
                  overlayOn={overlayOn}
                  onToggleOverlay={setOverlayOn}
                  draftMode={!!activeDraft}
                  flow={flow}
                  moves={moves}
                  onStartJourney={onStartJourney}
                  onRecordMove={(payload, target) => void recordMove(payload, target)}
                  onRecordFileMove={(fromFile, toModule) => void recordFileMove(fromFile, toModule)}
                  onOpenWorkspacesMap={onOpenWorkspacesMap}
                  expandRequest={expandRequest}
                  highlightRequest={highlightRequest}
                  showDuplicates={showDuplicates}
                  onToggleDuplicates={setShowDuplicates}
                  showFindings={showFindings}
                  onToggleFindings={setShowFindings}
                  showChanges={showChanges}
                  onToggleChanges={setShowChanges}
                  showInsights={showInsights}
                  onToggleInsights={setShowInsights}
                  showContracts={showContracts}
                  onToggleContracts={setShowContracts}
                  showScreens={screensOn}
                  onToggleScreens={setScreensOn}
                />
              )}
              {activeDraft ? (
                <DraftBar
                  draft={activeDraft.draft}
                  stale={draftStale(activeDraft.draft)}
                  reviewOn={reviewOn}
                  onToggleReview={() => setReviewOn(!reviewOn)}
                  onRename={(name) =>
                    updateArchDraft(activeDraft.path, {
                      ...activeDraft.draft,
                      name,
                      updatedAt: new Date().toISOString(),
                    })
                  }
                  onApply={applyDraft}
                  onRebase={rebaseActiveDraft}
                  onClose={() => setDraftPath(null)}
                  onDiscard={discardDraft}
                  refactorChip={
                    <RefactorChip
                      intents={draftRefactors}
                      problems={refactorProblems}
                      onRemove={removeRefactor}
                    />
                  }
                />
              ) : null}
              <ApplyRefactorsDialog
                open={applyDialogOpen}
                onOpenChange={(open) => !applyBusy && setApplyDialogOpen(open)}
                intents={draftRefactors}
                onConfirm={() => void finalizeApply()}
                busy={applyBusy}
              />
            </>
          )}
            {!activeDraft ? (
              <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
                <RefReviewBar
                  active={
                    refReview.active
                      ? {
                          ...refReview.active,
                          commit: refReview.active.commit?.slice(0, 7),
                          badge: archDiff ? (
                            <span className="rounded bg-surface-3 px-1 text-[9px] text-ink-muted">
                              {formatDiffCounts(countMarks(archDiff.marks)) || "no drift"}
                            </span>
                          ) : refReview.loading ? (
                            <Spinner className="h-3 w-3" />
                          ) : undefined,
                        }
                      : null
                  }
                  onReview={refReview.start}
                  onExit={refReview.exit}
                  loading={refReview.loading}
                />
                {refReview.error ? (
                  <span
                    className="max-w-64 truncate rounded-lg border border-danger/40 bg-surface-1/95 px-2 py-1 text-[10px] text-danger"
                    title={refReview.error}
                  >
                    {refReview.error}
                  </span>
                ) : null}
                {refReview.active && archDiff ? <DiagramLegend entries={DIFF_LEGEND} /> : null}
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState icon={Boxes} title="Deriving the architecture…">
            The diagram derives itself from your code the moment the code map has
            analyzable TypeScript/JavaScript. Your edits — positions, groups, added
            queues and stores — persist in{" "}
            <code className="text-ink">.crystal/architecture/overlay.json</code>.
          </EmptyState>
        )}
        {notice ? (
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-xl -translate-x-1/2 items-start gap-2 rounded-xl border border-edge bg-surface-2/95 px-3 py-2 text-[11px] text-ink-muted shadow-xl shadow-black/30 backdrop-blur">
            <GitMerge className="mt-0.5 h-3.5 w-3.5 shrink-0 text-crystal-300" />
            <span className="min-w-0">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 text-ink-faint hover:text-ink"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </main>
            </Pane>
            {variant === "architecture" && activeJourney && journeyTrace && effectiveGraph ? (
              <Pane defaultSize={240} minSize={130} maxSize="60%">
                <JourneyProfilePanel
                  trace={journeyTrace}
                  graph={effectiveGraph}
                  summary={codeSummary}
                  onOpenStep={(step) => onExpandCode(step.module, step.ref.file)}
                  onSelectStep={highlightStep}
                />
              </Pane>
            ) : null}
          </Split>
        </Pane>

        {variant === "architecture" && activeJourney ? (
          <Pane defaultSize={320} minSize={224} maxSize={520}>
            <FlowStepsPanel
              journey={activeJourney}
              trace={journeyTrace}
              flow={flow}
              error={journeyError}
              onClose={() => setActiveJourneyId(null)}
              onOpenStep={(step) => onExpandCode(step.module, step.ref.file)}
              onSelectStep={highlightStep}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && showDuplicates ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <DuplicatesPanel
              ws={activeWs ?? undefined}
              modules={codeSummary?.modules ?? []}
              hasActiveDraft={activeDraft != null}
              onHoist={(intent) => void recordHoist(intent)}
              onClose={() => setShowDuplicates(false)}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && showFindings ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <ReviewPanel
              ws={activeWs ?? undefined}
              onHoist={(intent) => void recordHoist(intent)}
              onOpenFile={(file, line) => requestOpenFile(file, line)}
              onClose={() => setShowFindings(false)}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && showChanges ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <ChangesPanel
              ws={activeWs ?? undefined}
              onOpenFile={(file, line) => requestOpenFile(file, line)}
              onClose={() => setShowChanges(false)}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && showInsights && overviewData ? (
          <Pane defaultSize={320} minSize={240} maxSize={560}>
            <InsightsPanel
              overview={overviewData}
              onFocusSystem={focusSystem}
              onSelectEdge={(key) => setActiveEdgeKey(key)}
              onClose={() => setShowInsights(false)}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && refReview.active && archDiff ? (
          <Pane defaultSize={320} minSize={240} maxSize={560}>
            <DiffPanel
              vsRef={refReview.active.ref}
              diff={archDiff.diff}
              onFocusSystem={focusSystem}
              onSelectEdge={(key) => setActiveEdgeKey(key)}
              onClose={refReview.exit}
            />
          </Pane>
        ) : null}

        {variant === "architecture" && showContracts && overviewData ? (
          <Pane defaultSize={384} minSize={280} maxSize={640}>
            <ContractsPanel
              overview={overviewData}
              activeEdgeKey={activeEdgeKey}
              onSelectEdge={setActiveEdgeKey}
              onFocusSystem={focusSystem}
              onClose={() => {
                setActiveEdgeKey(null);
                setShowContracts(false);
              }}
            />
          </Pane>
        ) : null}
      </Split>

    </div>
  );
}

/**
 * Sidebar list of the selected diagram's facets — named lenses ("Authentication",
 * "Shared libraries"…) that filter the canvas to one concern. Clicking a facet
 * activates it (click again to show everything); membership is edited on the
 * canvas by right-clicking nodes.
 *
 * Below the saved facets it surfaces *suggested* facets derived from the code
 * index (intent tags rolled up through node code links, plus the shared
 * dependencies those members lean on) — click to materialize one. A footer
 * shows index freshness and dispatches a small, cheap indexing agent over the
 * unindexed files.
 */
function FacetsSection({
  graph,
  activeFacetId,
  onActivate,
  onGraphChange,
  onNotice,
}: {
  graph: ArchitectureGraph;
  activeFacetId: string | null;
  onActivate: (id: string | null) => void;
  onGraphChange: (graph: ArchitectureGraph) => void;
  onNotice: (message: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const { client } = useCrystal();
  const connection = useConnectionState();
  const activeWs = useWorkspaces((s) => s.activeId);
  const updateNav = useNavUpdate();
  const [index, setIndex] = useState<CodeIndex | null>(null);
  const [staleCount, setStaleCount] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const fetchIndex = useCallback(async () => {
    try {
      const { index, staleFiles } = await client.request("codeindex.get", {});
      setIndex(index);
      setStaleCount(staleFiles.length);
    } catch {
      setIndex(null); // No bridge / analyzer unavailable — suggestions just hide.
    }
  }, [client]);

  useEffect(() => {
    if (connection === "open") void fetchIndex();
  }, [connection, fetchIndex]);
  useEffect(
    () =>
      client.events.on("codeindex.changed", ({ ws }) => {
        if (!activeWs || ws === activeWs) void fetchIndex();
      }),
    [client, activeWs, fetchIndex],
  );

  const suggestions = useMemo(() => {
    if (!index) return [];
    return suggestFacets(graph, index).filter((s) => !dismissed.includes(s.name));
  }, [graph, index, dismissed]);

  /** Materialize a suggestion — filling a same-named empty facet if one exists. */
  const accept = (s: FacetSuggestion) => {
    const existing = graph.facets.find(
      (f) => f.nodeIds.length === 0 && f.name.trim().toLowerCase() === s.name.trim().toLowerCase(),
    );
    if (existing) {
      onGraphChange({
        ...graph,
        facets: graph.facets.map((f) =>
          f.id === existing.id
            ? { ...f, description: f.description || s.description, nodeIds: [...s.nodeIds] }
            : f,
        ),
      });
      onActivate(existing.id);
      return;
    }
    const facet = { ...createArchFacet(s.name, s.nodeIds), description: s.description };
    onGraphChange({ ...graph, facets: [...graph.facets, facet] });
    onActivate(facet.id);
  };

  const create = () => {
    const facet = createArchFacet(`Facet ${graph.facets.length + 1}`);
    onGraphChange({ ...graph, facets: [...graph.facets, facet] });
    onActivate(facet.id);
    setRenaming({ id: facet.id, value: facet.name });
  };

  const rename = (id: string, name: string) => {
    if (name.trim()) {
      onGraphChange({
        ...graph,
        facets: graph.facets.map((f) => (f.id === id ? { ...f, name: name.trim() } : f)),
      });
    }
    setRenaming(null);
  };

  const remove = (id: string) => {
    if (activeFacetId === id) onActivate(null);
    onGraphChange({ ...graph, facets: graph.facets.filter((f) => f.id !== id) });
  };

  return (
    <>
      <div className="mt-3 flex items-center justify-between px-1.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          Facets
        </span>
        <Tooltip content="New facet — a named lens showing one concern of this diagram (auth, shared libraries, one endpoint…)">
          <Button variant="ghost" size="icon-sm" onClick={create} aria-label="New facet">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      </div>
      {graph.facets.map((f) => (
        <div
          key={f.id}
          className={cn(
            "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer",
            activeFacetId === f.id
              ? "bg-crystal-500/15 text-ink"
              : "text-ink-muted hover:bg-surface-2 hover:text-ink",
          )}
          onClick={() => onActivate(activeFacetId === f.id ? null : f.id)}
        >
          <Layers className="h-3.5 w-3.5 shrink-0 opacity-70" />
          {renaming?.id === f.id ? (
            <Input
              autoFocus
              value={renaming.value}
              onChange={(e) => setRenaming({ id: f.id, value: e.target.value })}
              onBlur={() => rename(f.id, renaming.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename(f.id, renaming.value);
                if (e.key === "Escape") setRenaming(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-6 min-w-0 flex-1 px-1.5 text-[13px]"
              aria-label="Facet name"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
          )}
          <span className="text-[10px] text-ink-faint">
            {f.nodeIds.length > 0 ? f.nodeIds.length : "all"}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
                aria-label="Facet actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setRenaming({ id: f.id, value: f.name })}>
                <PencilRuler className="h-3.5 w-3.5" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger" onSelect={() => remove(f.id)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete facet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ))}
      {graph.facets.length === 0 && suggestions.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-ink-faint">
          Lenses on this diagram — select nodes and right-click to start one.
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="px-1.5 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint/80">
          Suggested
        </div>
      ) : null}
      {suggestions.map((s) => (
        <Tooltip
          key={s.name}
          content={`${s.description} — e.g. ${s.sampleFiles.slice(0, 3).join(", ")}`}
        >
          <div
            className="group flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-edge px-2 py-1.5 text-[13px] text-ink-muted hover:border-crystal-500/60 hover:bg-surface-2 hover:text-ink"
            onClick={() => accept(s)}
            role="button"
            aria-label={`Create facet ${s.name}`}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-crystal-500 opacity-80" />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="text-[10px] text-ink-faint">{s.nodeIds.length}</span>
            <button
              type="button"
              className="shrink-0 text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                setDismissed((d) => [...d, s.name]);
              }}
              aria-label={`Dismiss suggestion ${s.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </Tooltip>
      ))}

      {index ? (
        <div className="flex items-center justify-between px-2 py-1 text-[11px] text-ink-faint">
          <span>
            {staleCount > 0
              ? `${staleCount} file${staleCount === 1 ? "" : "s"} without intent tags`
              : "intent index fresh"}
          </span>
          {staleCount > 0 ? (
            <Tooltip content="Run intent indexing in the Jobs view — a small agent tags what each symbol is for, scoped to your diff by default">
              <button
                type="button"
                className="flex items-center gap-1 text-ink-faint hover:text-ink"
                onClick={() => updateNav({ mode: "jobs" })}
              >
                <Bot className="h-3 w-3" /> Index intents
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Floating bar shown while a draft plan is open: rename, rebase, apply, discard. */
function DraftBar({
  draft,
  stale,
  reviewOn,
  onToggleReview,
  onRename,
  onApply,
  onRebase,
  onClose,
  onDiscard,
  refactorChip,
}: {
  draft: ArchDraft;
  stale: boolean;
  reviewOn: boolean;
  onToggleReview: () => void;
  onRename: (name: string) => void;
  onApply: () => void;
  onRebase: () => void;
  onClose: () => void;
  onDiscard: () => void;
  refactorChip?: React.ReactNode;
}) {
  const [name, setName] = useState(draft.name);
  useEffect(() => setName(draft.name), [draft.id, draft.name]);

  return (
    <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-warn/40 bg-surface-2/95 py-1 pl-2.5 pr-1 shadow-xl shadow-black/30 backdrop-blur">
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-warn" />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== draft.name && onRename(name.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="w-32 bg-transparent text-xs font-semibold text-ink outline-none placeholder:text-ink-faint"
        placeholder="Draft name"
        aria-label="Draft name"
      />
      {refactorChip}
      <Tooltip
        content={
          reviewOn
            ? "Back to editing the draft on the canvas"
            : "Review — draft and base side by side, every change listed"
        }
      >
        <Button
          variant={reviewOn ? "secondary" : "ghost"}
          size="xs"
          onClick={onToggleReview}
          aria-pressed={reviewOn}
        >
          <GitCompareArrows className="h-3 w-3" /> Review
        </Button>
      </Tooltip>
      {stale ? (
        <Tooltip content="The diagram changed underneath this draft — replay your changes onto the latest version">
          <Button variant="secondary" size="xs" onClick={onRebase}>
            <GitMerge className="h-3 w-3" /> Rebase
          </Button>
        </Tooltip>
      ) : (
        <span className="text-[10px] text-ink-faint">draft — diagram untouched</span>
      )}
      <div className="h-4 w-px bg-edge" />
      <Tooltip content={stale ? "Rebases onto the latest diagram, then applies" : "Write this draft to the diagram"}>
        <Button variant="primary" size="xs" onClick={onApply}>
          <Check className="h-3 w-3" /> Apply
        </Button>
      </Tooltip>
      <Tooltip content="Keep the draft saved and return to the diagram">
        <Button variant="ghost" size="xs" onClick={onClose}>
          Close
        </Button>
      </Tooltip>
      <Tooltip content="Delete this draft">
        <Button variant="ghost" size="icon-sm" className="text-danger" onClick={onDiscard} aria-label="Discard draft">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

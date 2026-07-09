import "@xyflow/react/dist/style.css";
import "./architect.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Boxes,
  Check,
  CloudUpload,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Globe2,
  History,
  Layers,
  MoreHorizontal,
  PencilRuler,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  createArchDraft as newArchDraft,
  createArchFacet,
  createEpic,
  createTask,
  graphsEqual,
  matchAgent,
  mergeGraphs,
  suggestFacets,
  type ArchDraft,
  type ArchitectureGraph,
  type CodeIndex,
  type CodeMapSummary,
  type CodeTrace,
  type CodeTraceStep,
  type FacetSuggestion,
  type TaskItem,
} from "@crystal/core";
import {
  useAgents,
  useConnectionState,
  useCrystal,
  useNav,
  useNavUpdate,
  useWorkspace,
  useWorkspaces,
} from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
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
import { DuplicatesPanel } from "./codemap/DuplicatesPanel.js";
import { ReviewPanel } from "./codemap/ReviewPanel.js";
import type { MoveLikeIntent } from "./codemap/map-model.js";
import { projectTrace, stepKeyOf } from "./dataflow.js";
import { InfraView } from "./InfraView.js";
import { FlowStepsPanel, JourneysSection, type JourneySeed } from "./JourneyPanel.js";
import { JourneyProfilePanel } from "./ProfilePanel.js";
import { useRefactorIntents } from "./refactor-intents.js";
import { buildHoistPrompt } from "./refactor-prompts.js";
import { ApplyRefactorsDialog, RefactorChip, useIntentProblems } from "./RefactorPanel.js";
import { ReviewDialog } from "./ReviewDialog.js";
import { ReviewView } from "./ReviewView.js";
import { canSeedFromCodeMap, seedFromCodeMap } from "./seed.js";
import { SurveySection } from "./SurveyPanel.js";

const EMPTY_ARCHITECTURES: never[] = [];
const EMPTY_DRAFTS: never[] = [];
const EMPTY_REFACTORS: never[] = [];
const EMPTY_PROJECTS: never[] = [];
const EMPTY_RUNS: never[] = [];

type ArchitectView = "diagrams" | "infra" | "codemap";

export function ArchitectMode() {
  // View + draft selection live in the deep-linkable nav store.
  const nav = useNavUpdate();
  const view = useNav((l) => l.architect?.view) ?? "diagrams";
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
  const expandCode = useCallback((module: string, file?: string) => {
    setView("diagrams");
    setExpandRequest({ module, file, nonce: ++expandNonce.current });
  }, [setView]);

  /** The standalone map remains only for the cross-workspace level. */
  const openWorkspacesMap = useCallback(
    () => nav({ architect: { view: "codemap", codemap: { kind: "all" } } }),
    [nav],
  );

  // The workspace-level map is unified into the canvas — old code-map links
  // (workspace/module/file levels) land on the diagram instead.
  const codemapLevel = useNav((l) => l.architect?.codemap ?? null);
  useEffect(() => {
    if (view !== "codemap" || !codemapLevel || codemapLevel.kind === "all") return;
    if (codemapLevel.kind === "module") expandCode(codemapLevel.path);
    else if (codemapLevel.kind === "file") expandCode("", codemapLevel.path);
    else setView("diagrams");
  }, [view, codemapLevel, expandCode, setView]);

  const startJourneyFromCode = useCallback(
    (seed: JourneySeed) => {
      setJourneySeed(seed);
      setView("diagrams");
    },
    [setView],
  );

  const tab = (v: ArchitectView, icon: React.ReactNode, label: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setView(v)}
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
        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {tab(
            "diagrams",
            <PencilRuler className="h-3.5 w-3.5" />,
            <>
              Architecture
              <span className="rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">live</span>
            </>,
          )}
          {tab("infra", <Globe2 className="h-3.5 w-3.5" />, "Infrastructure")}
          {/* Cross-workspace map, reached from the canvas — shown only while open. */}
          {view === "codemap"
            ? tab("codemap", <Layers className="h-3.5 w-3.5" />, "Workspaces")
            : null}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {view === "codemap" ? (
          <CodeMapView
            origin={{ label: "Architecture", onExit: () => setView("diagrams") }}
            onEnterWorkspace={(ws) => {
              if (ws !== activeWs) setActiveWs(ws);
              setView("diagrams");
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
  onExpandCode,
  onOpenWorkspacesMap,
  journeySeed,
  onStartJourney,
  onJourneySeedConsumed,
  draftPath,
  onDraftPathChange: setDraftPath,
}: {
  variant: "diagrams" | "infra";
  expandRequest: { module: string; file?: string; nonce: number } | null;
  onExpandCode: (module: string, file?: string) => void;
  onOpenWorkspacesMap: () => void;
  journeySeed: JourneySeed | null;
  onStartJourney: (seed: JourneySeed) => void;
  onJourneySeedConsumed: () => void;
  draftPath: string | null;
  onDraftPathChange: (path: string | null) => void;
}) {
  const architectures = useWorkspace((s) => s.info?.architectures ?? EMPTY_ARCHITECTURES);
  const archDrafts = useWorkspace((s) => s.info?.archDrafts ?? EMPTY_DRAFTS);
  const loading = useWorkspace((s) => s.loading && !s.info);
  const pendingSaves = useWorkspace((s) => s.pendingSaves);
  const updateArchitecture = useWorkspace((s) => s.updateArchitecture);
  const createArchitecture = useWorkspace((s) => s.createArchitecture);
  const deleteArchitecture = useWorkspace((s) => s.deleteArchitecture);
  const updateArchDraft = useWorkspace((s) => s.updateArchDraft);
  const createDraftFile = useWorkspace((s) => s.createArchDraft);
  const deleteArchDraft = useWorkspace((s) => s.deleteArchDraft);
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const updateProject = useWorkspace((s) => s.updateProject);
  const roster = useWorkspace((s) => s.roster);

  const nav = useNavUpdate();
  const infoLoaded = useWorkspace((s) => s.info != null);
  const selectedPath = useNav((l) => l.architect?.diagram) ?? null;
  const setSelectedPath = useCallback(
    (path: string | null) => nav({ architect: { diagram: path } }),
    [nav],
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [seedMode, setSeedMode] = useState<"code" | "blank">("code");
  const [notice, setNotice] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);

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

  const selected =
    architectures.find((a) => a.path === selectedPath) ?? architectures[0] ?? null;

  useEffect(() => {
    if (selected && selected.path !== selectedPath) setSelectedPath(selected.path);
  }, [selected?.path]);

  const activeDraft = archDrafts.find((d) => d.path === draftPath) ?? null;

  // Leave draft mode if the draft vanished or the user switched architectures.
  // Only once workspace info is in — a deep-linked draft must survive loading.
  useEffect(() => {
    if (infoLoaded && draftPath && (!activeDraft || activeDraft.draft.archPath !== selected?.path)) {
      setDraftPath(null);
    }
  }, [infoLoaded, draftPath, activeDraft, selected?.path]);

  // The graph being edited right now — the draft's while a draft is open.
  const effectiveGraph = activeDraft ? activeDraft.draft.graph : (selected?.graph ?? null);
  const commitGraph = useCallback(
    (graph: ArchitectureGraph) => {
      if (activeDraft) {
        updateArchDraft(activeDraft.path, {
          ...activeDraft.draft,
          graph,
          updatedAt: new Date().toISOString(),
        });
      } else if (selected) {
        updateArchitecture(selected.path, graph);
      }
    },
    [activeDraft, selected, updateArchDraft, updateArchitecture],
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

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  const selectedDrafts = selected
    ? archDrafts.filter((d) => d.draft.archPath === selected.path)
    : [];
  const draftStale = (d: ArchDraft) =>
    selected != null && d.archPath === selected.path && !graphsEqual(d.base, selected.graph);

  const saving = Object.keys(pendingSaves).length > 0;

  const canSeed = canSeedFromCodeMap(codeSummary);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const created = await createArchitecture(name);
    if (seedMode === "code" && canSeedFromCodeMap(codeSummary)) {
      updateArchitecture(created.path, seedFromCodeMap(created.graph, codeSummary));
      setOverlayOn(true);
    }
    setSelectedPath(created.path);
    setNewName("");
    setCreateOpen(false);
  }

  async function startDraft() {
    if (!selected) return;
    const n = selectedDrafts.length + 1;
    const draft = newArchDraft(
      `Plan ${n > 1 ? n : ""}`.trim(),
      selected.path,
      selected.graph,
      new Date().toISOString(),
    );
    const created = await createDraftFile(draft);
    setDraftPath(created.path);
  }

  function applyDraft() {
    if (!activeDraft || !selected) return;
    if (activeDraft.draft.refactors.length > 0) {
      setApplyDialogOpen(true);
      return;
    }
    void finalizeApply();
  }

  async function finalizeApply() {
    if (!activeDraft || !selected) return;
    setApplyBusy(true);
    try {
      let graph = activeDraft.draft.graph;
      let notes: string[] = [];
      if (!graphsEqual(activeDraft.draft.base, selected.graph)) {
        const merged = mergeGraphs(activeDraft.draft.base, activeDraft.draft.graph, selected.graph);
        graph = merged.graph;
        notes = merged.conflicts;
      }
      updateArchitecture(selected.path, graph);

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
    if (!activeDraft || !selected) return;
    const merged = mergeGraphs(activeDraft.draft.base, activeDraft.draft.graph, selected.graph);
    updateArchDraft(activeDraft.path, {
      ...activeDraft.draft,
      base: selected.graph,
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
            Architectures
          </span>
          <div className="flex items-center gap-1">
            <Tooltip content={saving ? "Saving…" : "All changes saved to .crystal/"}>
              <span className="text-ink-faint">
                {saving ? (
                  <CloudUpload className="h-3.5 w-3.5 animate-pulse text-info" />
                ) : (
                  <Check className="h-3.5 w-3.5 text-ok/70" />
                )}
              </span>
            </Tooltip>
            <Tooltip content="New architecture">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCreateOpen(true)}
                aria-label="New architecture"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {architectures.map((a) => (
            <div
              key={a.path}
              className={cn(
                "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] cursor-pointer",
                selected?.path === a.path
                  ? "bg-crystal-500/15 text-ink"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )}
              onClick={() => setSelectedPath(a.path)}
            >
              <Boxes className="h-3.5 w-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{a.graph.name}</span>
              <span className="text-[10px] text-ink-faint">{a.graph.nodes.length}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Architecture actions"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    className="text-danger"
                    onSelect={() => void deleteArchitecture(a.path)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}

          {variant === "diagrams" && selected ? (
            <>
              <div className="mt-3 flex items-center justify-between px-1.5 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Draft plans
                </span>
                <div className="flex items-center">
                  <Tooltip content="Review a commit or branch — its code architecture becomes a draft, diffed against this diagram">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setReviewDialogOpen(true)}
                      aria-label="Review a commit or branch"
                    >
                      <History className="h-3.5 w-3.5" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={`New draft plan of “${selected.graph.name}”`}>
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

          <SurveySection onImported={setSelectedPath} onNotice={setNotice} />
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
        ) : selected ? (
          variant === "infra" ? (
            <InfraView
              key={selected.path}
              graph={selected.graph}
              onChange={(graph) => updateArchitecture(selected.path, graph)}
              summary={codeSummary}
            />
          ) : (
            <>
              {activeDraft && reviewOn ? (
                <ReviewView key={activeDraft.path} draft={activeDraft.draft} />
              ) : (
                <ArchitectCanvas
                  key={activeDraft ? activeDraft.path : selected.path}
                  graph={activeDraft ? activeDraft.draft.graph : selected.graph}
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
          )
        ) : (
          <EmptyState
            icon={Boxes}
            title="No architectures yet"
            action={
              <div className="flex items-center gap-2">
                {canSeed ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setSeedMode("code");
                      setCreateOpen(true);
                    }}
                  >
                    <FolderGit2 className="h-3.5 w-3.5" /> Map my codebase
                  </Button>
                ) : null}
                <Button
                  variant={canSeed ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => {
                    setSeedMode("blank");
                    setCreateOpen(true);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" /> Blank canvas
                </Button>
              </div>
            }
          >
            {canSeed
              ? "Start from a diagram of your modules and imports — linked to the live code map — or from a blank canvas."
              : "Model your system as nested groups of services, stores and flows."}{" "}
            Diagrams are saved to <code className="text-ink">.crystal/architecture/</code> in
            your repo.
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
            {variant === "diagrams" && activeJourney && journeyTrace && effectiveGraph ? (
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

        {variant === "diagrams" && activeJourney ? (
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

        {variant === "diagrams" && showDuplicates ? (
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

        {variant === "diagrams" && showFindings ? (
          <Pane defaultSize={384} minSize={260} maxSize={640}>
            <ReviewPanel
              ws={activeWs ?? undefined}
              onHoist={(intent) => void recordHoist(intent)}
              onOpenFile={(file, line) => requestOpenFile(file, line)}
              onClose={() => setShowFindings(false)}
            />
          </Pane>
        ) : null}
      </Split>

      {selected ? (
        <ReviewDialog
          open={reviewDialogOpen}
          onOpenChange={setReviewDialogOpen}
          archPath={selected.path}
          onCreated={(path) => {
            setDraftPath(path);
            setReviewOn(true);
          }}
        />
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          title="New architecture"
          description="Saved as a versionable file in .crystal/architecture/"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Payments platform"
            />
            {canSeed ? (
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Starting point">
                <SeedChoice
                  active={seedMode === "code"}
                  onSelect={() => setSeedMode("code")}
                  icon={<FolderGit2 className="h-3.5 w-3.5" />}
                  title="Map my codebase"
                >
                  {codeSummary!.modules.filter((m) => m.fileCount > 0).length} modules and their
                  imports, linked to the live code map
                </SeedChoice>
                <SeedChoice
                  active={seedMode === "blank"}
                  onSelect={() => setSeedMode("blank")}
                  icon={<PencilRuler className="h-3.5 w-3.5" />}
                  title="Blank canvas"
                >
                  Start empty and build from the palette
                </SeedChoice>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" variant="primary" size="sm" disabled={!newName.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
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

/** One selectable starting-point card in the "New architecture" dialog. */
function SeedChoice({
  active,
  onSelect,
  icon,
  title,
  children,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "rounded-lg border px-2.5 py-2 text-left transition-colors",
        active
          ? "border-crystal-500/60 bg-crystal-500/10"
          : "border-edge bg-surface-1 hover:bg-surface-2",
      )}
    >
      <span className={cn("flex items-center gap-1.5 text-xs font-semibold", active ? "text-ink" : "text-ink-muted")}>
        {icon} {title}
      </span>
      <span className="mt-1 block text-[10.5px] leading-snug text-ink-faint">{children}</span>
    </button>
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

import "@xyflow/react/dist/style.css";
import "./architect.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Check,
  CloudUpload,
  FolderGit2,
  GitBranch,
  GitMerge,
  Globe2,
  MoreHorizontal,
  PencilRuler,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  createArchDraft as newArchDraft,
  graphsEqual,
  mergeGraphs,
  type ArchDraft,
  type ArchitectureGraph,
  type CodeMapSummary,
  type CodeTrace,
} from "@crystal/core";
import { useConnectionState, useCrystal, useWorkspace, useWorkspaces } from "@crystal/client";
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
import { CodeMapView } from "./codemap/CodeMapView.js";
import { projectTrace } from "./dataflow.js";
import { InfraView } from "./InfraView.js";
import { FlowStepsPanel, JourneysSection, type JourneySeed } from "./JourneyPanel.js";
import { JourneyProfilePanel } from "./ProfilePanel.js";
import { buildHoistPrompt } from "./refactor-prompts.js";
import { ApplyRefactorsDialog, RefactorChip, useIntentProblems } from "./RefactorPanel.js";
import { canSeedFromCodeMap, seedFromCodeMap } from "./seed.js";
import { SurveySection } from "./SurveyPanel.js";

const EMPTY_ARCHITECTURES: never[] = [];
const EMPTY_DRAFTS: never[] = [];
const EMPTY_REFACTORS: never[] = [];

type ArchitectView = "diagrams" | "infra" | "codemap";

export function ArchitectMode() {
  const [view, setView] = useState<ArchitectView>("diagrams");
  // Set when the user zooms from a diagram node into its code module (or a file within it).
  const [drill, setDrill] = useState<{ module: string; file?: string; from: string } | null>(null);
  // "Start journey here…" from the code map prefills the journey dialog.
  const [journeySeed, setJourneySeed] = useState<JourneySeed | null>(null);
  // Lifted here so the code map sees the open draft (drag-refactor targets it).
  const [draftPath, setDraftPath] = useState<string | null>(null);

  const drillIntoModule = useCallback((module: string, from: string, file?: string) => {
    setDrill({ module, file, from });
    setView("codemap");
  }, []);

  const startJourneyFromCode = useCallback((seed: JourneySeed) => {
    setJourneySeed(seed);
    setDrill(null);
    setView("diagrams");
  }, []);

  const tab = (v: ArchitectView, icon: React.ReactNode, label: React.ReactNode) => (
    <button
      type="button"
      onClick={() => {
        if (v === "codemap") setDrill(null);
        setView(v);
      }}
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
          {tab("diagrams", <PencilRuler className="h-3.5 w-3.5" />, "Diagrams")}
          {tab("infra", <Globe2 className="h-3.5 w-3.5" />, "Infrastructure")}
          {tab(
            "codemap",
            <FolderGit2 className="h-3.5 w-3.5" />,
            <>
              Code map
              <span className="rounded-full bg-ok/15 px-1.5 text-[9px] text-ok">live</span>
            </>,
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {view === "codemap" ? (
          <CodeMapView
            key={drill ? `drill:${drill.module}:${drill.file ?? ""}` : "root"}
            initialModule={drill?.module}
            initialFile={drill?.file}
            origin={
              drill
                ? {
                    label: drill.from,
                    onExit: () => {
                      setDrill(null);
                      setView("diagrams");
                    },
                  }
                : undefined
            }
            onStartJourney={startJourneyFromCode}
            activeDraftPath={draftPath}
            onOpenDraft={setDraftPath}
          />
        ) : (
          <DiagramsView
            variant={view}
            onDrillIntoModule={drillIntoModule}
            journeySeed={journeySeed}
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
  onDrillIntoModule,
  journeySeed,
  onJourneySeedConsumed,
  draftPath,
  onDraftPathChange: setDraftPath,
}: {
  variant: "diagrams" | "infra";
  onDrillIntoModule: (module: string, from: string, file?: string) => void;
  journeySeed: JourneySeed | null;
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

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [seedMode, setSeedMode] = useState<"code" | "blank">("code");
  const [notice, setNotice] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);

  // Live code map for the diagram overlay — kept fresh by codemap.changed.
  const { client } = useCrystal();
  const connection = useConnectionState();
  const activeWs = useWorkspaces((s) => s.activeId);
  const [overlayOn, setOverlayOn] = useState(false);
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
  useEffect(() => {
    if (draftPath && (!activeDraft || activeDraft.draft.archPath !== selected?.path)) {
      setDraftPath(null);
    }
  }, [draftPath, activeDraft, selected?.path]);

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

  /* ---- journeys / dataflow lens ---- */
  const [activeJourneyId, setActiveJourneyId] = useState<string | null>(null);
  const [journeyTrace, setJourneyTrace] = useState<CodeTrace | null>(null);
  const [journeyError, setJourneyError] = useState<string | null>(null);
  const [traceGeneration, setTraceGeneration] = useState(0);

  const activeJourney = effectiveGraph?.journeys.find((j) => j.id === activeJourneyId) ?? null;
  useEffect(() => {
    if (activeJourneyId && !activeJourney) setActiveJourneyId(null);
  }, [activeJourneyId, activeJourney]);

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

  const draftRefactors = activeDraft?.draft.refactors ?? EMPTY_REFACTORS;
  const refactorProblems = useIntentProblems(draftRefactors);

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
    void finalizeApply({ worktree: true });
  }

  async function finalizeApply(opts: { worktree: boolean }) {
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

      const moves = activeDraft.draft.refactors.filter((r) => r.kind === "move");
      const hoists = activeDraft.draft.refactors.filter((r) => r.kind === "hoist");
      if (moves.length > 0) {
        try {
          const result = await client.request("refactor.apply", { intents: moves });
          if (result.applied.length > 0) {
            notes.push(`${result.applied.length} move${result.applied.length > 1 ? "s" : ""} applied`);
          }
          for (const failure of result.failed) {
            const intent = moves.find((m) => m.id === failure.intentId);
            notes.push(`move ${intent?.kind === "move" ? intent.symbol : failure.intentId} failed: ${failure.error}`);
          }
        } catch (err) {
          notes.push(`refactor engine error: ${(err as Error).message}`);
        }
      }
      for (const hoist of hoists) {
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
        try {
          await client.request("agent.start", {
            prompt: buildHoistPrompt(hoist, sources),
            isolation: opts.worktree ? "worktree" : "none",
          });
          notes.push(`hoist → ${hoist.targetModule}: agent run started`);
        } catch (err) {
          notes.push(`hoist → ${hoist.targetModule} failed to start: ${(err as Error).message}`);
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
            />
          ) : (
            <>
              <ArchitectCanvas
                key={activeDraft ? activeDraft.path : selected.path}
                graph={activeDraft ? activeDraft.draft.graph : selected.graph}
                onChange={commitGraph}
                codeSummary={codeSummary}
                overlayOn={overlayOn}
                onToggleOverlay={setOverlayOn}
                onDrillIntoModule={(module, file) =>
                  onDrillIntoModule(module, selected.graph.name, file)
                }
                draftMode={!!activeDraft}
                flow={flow}
              />
              {activeDraft ? (
                <DraftBar
                  draft={activeDraft.draft}
                  stale={draftStale(activeDraft.draft)}
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
                onConfirm={(opts) => void finalizeApply(opts)}
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
                  onOpenStep={(step) =>
                    onDrillIntoModule(step.module, selected?.graph.name ?? "Diagram", step.ref.file)
                  }
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
              onOpenStep={(step) =>
                onDrillIntoModule(step.module, selected?.graph.name ?? "Diagram", step.ref.file)
              }
            />
          </Pane>
        ) : null}
      </Split>

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
  onRename,
  onApply,
  onRebase,
  onClose,
  onDiscard,
  refactorChip,
}: {
  draft: ArchDraft;
  stale: boolean;
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

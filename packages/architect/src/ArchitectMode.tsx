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
  Spinner,
  Tooltip,
  cn,
} from "@crystal/ui";
import { ArchitectCanvas } from "./ArchitectCanvas.js";
import { CodeMapView } from "./codemap/CodeMapView.js";
import { projectTrace } from "./dataflow.js";
import { InfraView } from "./InfraView.js";
import { FlowStepsPanel, JourneysSection, type JourneySeed } from "./JourneyPanel.js";

const EMPTY_ARCHITECTURES: never[] = [];
const EMPTY_DRAFTS: never[] = [];

type ArchitectView = "diagrams" | "infra" | "codemap";

export function ArchitectMode() {
  const [view, setView] = useState<ArchitectView>("diagrams");
  // Set when the user zooms from a diagram node into its code module.
  const [drill, setDrill] = useState<{ module: string; from: string } | null>(null);
  // "Start journey here…" from the code map prefills the journey dialog.
  const [journeySeed, setJourneySeed] = useState<JourneySeed | null>(null);

  const drillIntoModule = useCallback((module: string, from: string) => {
    setDrill({ module, from });
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
            key={drill ? `drill:${drill.module}` : "root"}
            initialModule={drill?.module}
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
          />
        ) : (
          <DiagramsView
            variant={view}
            onDrillIntoModule={drillIntoModule}
            journeySeed={journeySeed}
            onJourneySeedConsumed={() => setJourneySeed(null)}
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
}: {
  variant: "diagrams" | "infra";
  onDrillIntoModule: (module: string, from: string) => void;
  journeySeed: JourneySeed | null;
  onJourneySeedConsumed: () => void;
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
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const created = await createArchitecture(name);
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
    let graph = activeDraft.draft.graph;
    let conflicts: string[] = [];
    if (!graphsEqual(activeDraft.draft.base, selected.graph)) {
      const merged = mergeGraphs(activeDraft.draft.base, activeDraft.draft.graph, selected.graph);
      graph = merged.graph;
      conflicts = merged.conflicts;
    }
    updateArchitecture(selected.path, graph);
    void deleteArchDraft(activeDraft.path);
    setDraftPath(null);
    setNotice(
      conflicts.length
        ? `Draft applied with ${conflicts.length} note${conflicts.length > 1 ? "s" : ""}: ${conflicts.join(" · ")}`
        : "Draft applied.",
    );
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
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface-1">
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
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
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
                onDrillIntoModule={(module) => onDrillIntoModule(module, selected.graph.name)}
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
                />
              ) : null}
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
            </>
          )
        ) : (
          <EmptyState
            icon={Boxes}
            title="No architectures yet"
            action={
              <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> New architecture
              </Button>
            }
          >
            Model your system as nested groups of services, stores and flows. Diagrams are
            saved to <code className="text-ink">.crystal/architecture/</code> in your repo.
          </EmptyState>
        )}
      </main>

      {variant === "diagrams" && activeJourney ? (
        <FlowStepsPanel
          journey={activeJourney}
          trace={journeyTrace}
          flow={flow}
          error={journeyError}
          onClose={() => setActiveJourneyId(null)}
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

/** Floating bar shown while a draft plan is open: rename, rebase, apply, discard. */
function DraftBar({
  draft,
  stale,
  onRename,
  onApply,
  onRebase,
  onClose,
  onDiscard,
}: {
  draft: ArchDraft;
  stale: boolean;
  onRename: (name: string) => void;
  onApply: () => void;
  onRebase: () => void;
  onClose: () => void;
  onDiscard: () => void;
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

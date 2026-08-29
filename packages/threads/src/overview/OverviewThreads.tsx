import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, ExternalLink, Pause, Play, Square, Terminal, Trash2 } from "lucide-react";
import { formatDeepLink, formatWsRef, isProgramTerminal } from "@crystal/core";
import {
  EMPTY_EVENTS,
  EMPTY_QUESTIONS,
  EMPTY_RUNS,
  runKey,
  wsKey,
  useCrystal,
  useFleet,
  useFleetConnections,
  useFleetNeedsYou,
  useHub,
  useNav,
  useNavUpdate,
} from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  useContextMenu,
  type MenuEntry,
} from "@crystal/ui";
import { useThreadReadState } from "../thread-unread.js";
import { OverviewThreadPane } from "./OverviewThreadPane.js";
import { OverviewThreadRail } from "./OverviewThreadRail.js";
import {
  buildOverviewSections,
  filterOverviewSections,
  formatOverviewThreadId,
  parseOverviewThreadId,
  resolveOverviewThread,
  type OverviewSection,
  type OverviewThread,
} from "./overview-thread-model.js";

const FILTER_KEY = "crystal.overview.threads.filter";

/** Mission control joins every project manager and coordinator into one surface. */
export default function OverviewThreads() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const connections = useFleetConnections();
  const runsByWs = useFleet((s) => s.runsByWs);
  const runsLoadedByWs = useFleet((s) => s.runsLoadedByWs);
  const workflowsByWs = useFleet((s) => s.workflowsByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  const permissionsByWs = useFleet((s) => s.permissionsByWs);
  const eventsByRunKey = useFleet((s) => s.eventsByRunKey);
  const loadRunEvents = useFleet((s) => s.loadRunEvents);
  const programs = useHub((s) => s.programs);
  const hubRuns = useHub((s) => s.runs);
  const programQuestions = useHub((s) => s.questions);
  const spend = useHub((s) => s.spend);
  const startManager = useHub((s) => s.startManager);
  const closeManager = useHub((s) => s.closeManager);
  const setProgramPaused = useHub((s) => s.setPaused);
  const cancelProgram = useHub((s) => s.cancel);
  const removeProgram = useHub((s) => s.remove);
  const retryDelivery = useHub((s) => s.retryDelivery);
  const hubLoaded = useHub((s) => s.loaded);
  const hubError = useHub((s) => s.error);
  const refreshHub = useHub((s) => s.refresh);
  const fleetNeedsYou = useFleetNeedsYou();
  const nav = useNav((link) => link.projects ?? null);
  const update = useNavUpdate();
  const { fleet, selectWorkspace, activeSid } = useCrystal();
  const read = useThreadReadState();
  const menu = useContextMenu();
  const creating = nav?.compose === true;
  const [notice, setNotice] = useState<{
    text: string;
    tone: "danger" | "neutral";
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    consequence: string;
    run: () => void;
  } | null>(null);
  const [filter, setFilterState] = useState<"managers" | "all">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(FILTER_KEY) === "all"
      ? "all"
      : "managers",
  );
  const setFilter = (value: "managers" | "all") => {
    setFilterState(value);
    try {
      localStorage.setItem(FILTER_KEY, value);
    } catch {
      // Persistence is optional; the in-memory filter still works.
    }
  };
  useEffect(() => {
    if (notice?.tone !== "neutral") return;
    const timer = window.setTimeout(() => setNotice(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const attentionByWs = useMemo(() => {
    const result: Record<string, Set<string>> = {};
    for (const row of fleetNeedsYou.rows) {
        const ids = new Set<string>();
        for (const question of row.actionableQuestions) {
          if (question.question.runId) ids.add(question.question.runId);
        }
        for (const run of row.failures) ids.add(run.id);
        for (const permission of permissionsByWs[row.key] ?? []) ids.add(permission.runId);
        result[row.key] = ids;
    }
    return result;
  }, [fleetNeedsYou.rows, permissionsByWs]);

  const modelInput = useMemo(() => ({
    connections,
    runsByWs,
    workflowsByWs,
    attentionByWs,
    programs,
    hubRuns,
    hubSid: activeSid,
    programQuestions,
    spend,
    lastSeen: read.seen,
    pins: read.pins as Set<string>,
  }), [
    connections, runsByWs, workflowsByWs, attentionByWs, programs, hubRuns,
    activeSid, programQuestions, spend, read.seen, read.pins,
  ]);
  const allSections = useMemo(
    () => buildOverviewSections(modelInput),
    [modelInput],
  );
  const sections = useMemo(
    () => filterOverviewSections(allSections, { filter, find: nav?.find }),
    [allSections, filter, nav?.find],
  );
  const visibleCount = sections.reduce((count, section) => count + section.threads.length, 0);
  const hiddenCount = useMemo(() => {
    if (filter !== "managers" || visibleCount !== 0) return 0;
    return filterOverviewSections(allSections, { filter: "all", find: nav?.find })
      .reduce((count, section) => count + section.threads.length, 0);
  }, [filter, visibleCount, allSections, nav?.find]);
  const managerCount = filterOverviewSections(allSections, { filter: "managers" })
    .reduce((count, section) => count + section.threads.length, 0);
  const allCount = allSections.reduce((count, section) => count + section.threads.length, 0);
  const requested = nav?.thread ?? (nav?.program
    ? formatOverviewThreadId({ kind: "program", programId: nav.program })
    : null);
  const selected = resolveOverviewThread(allSections, requested);
  const requestedRef = requested ? parseOverviewThreadId(requested) : null;
  const selectedSid = selected?.ref.kind === "workspace" ? selected.ref.sid : undefined;
  const selectedWs = selected?.ref.kind === "workspace" ? selected.ref.ws : undefined;
  const loadSelectedEvents = useCallback(async (id: string) => {
    if (selectedSid && selectedWs) {
      await loadRunEvents(selectedSid, selectedWs, id);
    }
  }, [selectedSid, selectedWs, loadRunEvents]);

  useEffect(() => {
    if (!selected?.lastActivity) return;
    if (!selected.live) {
      read.markSeen(selected.readKey, selected.lastActivity);
      return;
    }
    // A streaming face updates activity frequently. Trail those updates so
    // seen-state changes do not rebuild the fleet model for every event.
    const timer = setTimeout(
      () => read.markSeen(selected.readKey, selected.lastActivity!),
      500,
    );
    return () => clearTimeout(timer);
  }, [selected?.readKey, selected?.lastActivity, selected?.live, read.markSeen]);
  const act = useCallback((fn: () => unknown | Promise<unknown>) => {
    void Promise.resolve().then(fn).catch((error) =>
      setNotice({
        text: error instanceof Error ? error.message : String(error),
        tone: "danger",
      }),
    );
  }, []);
  const clearSelection = useCallback(() => update({
    projects: {
      view: "threads",
      thread: null,
      program: null,
      turn: null,
      compose: null,
    },
  }), [update]);
  const handleFocusedTurn = useCallback(() => {
    update({ projects: { view: "threads", turn: null } });
  }, [update]);
  const requestedProjectClosed = requestedRef?.kind === "workspace"
    && !connections.some((connection) =>
      connection.sid === requestedRef.sid
      && connection.workspaces.some((workspace) => workspace.id === requestedRef.ws));
  const requestedLoaded = requestedRef?.kind === "program"
    ? hubLoaded
    : requestedRef?.kind === "workspace"
      ? requestedProjectClosed
        || runsLoadedByWs[wsKey(requestedRef.sid, requestedRef.ws)] === true
      : true;
  const copyLink = (thread: OverviewThread) => act(async () => {
    const hash = formatDeepLink({
      mode: "projects",
      projects: { view: "threads", thread: thread.id },
    });
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`);
    setNotice({ text: "Link copied", tone: "neutral" });
  });
  const copyTurnLink = (thread: OverviewThread, turn: string) => act(async () => {
    const hash = formatDeepLink({
      mode: "projects",
      projects: { view: "threads", thread: thread.id, turn },
    });
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`);
    setNotice({ text: "Link copied", tone: "neutral" });
  });
  const openProject = (thread: OverviewThread) => {
    if (thread.ref.kind !== "workspace") return;
    selectWorkspace(thread.ref.sid, thread.ref.ws);
    update({
      ws: formatWsRef(thread.ref.sid, thread.ref.ws),
      mode: "threads",
      threads: { thread: thread.ref.threadId, compose: null },
    });
  };

  const entriesFor = (thread: OverviewThread): MenuEntry[] => {
    const common: MenuEntry[] = [
      {
        type: "item",
        label: thread.pinned ? "Unpin" : "Pin",
        onSelect: () => read.togglePin(thread.readKey),
      },
      {
        type: "item",
        label: thread.indicator === "unread" ? "Mark as read" : "Mark as unread",
        disabled: thread.indicator !== "unread" && !read.seen[thread.readKey],
        onSelect: () => {
          if (thread.indicator === "unread" && thread.lastActivity) {
            read.markSeen(thread.readKey, thread.lastActivity);
          } else {
            read.clearSeen(thread.readKey);
          }
        },
      },
      { type: "item", label: "Copy link", icon: Copy, onSelect: () => copyLink(thread) },
    ];
    if (thread.ref.kind === "workspace") {
      const ref = thread.ref;
      const client = fleet.clientOf(ref.sid);
      const disconnected = client == null;
      const face = thread.summary!.node.run;
      return [
        {
          type: "item",
          label: "Open in project",
          icon: ExternalLink,
          onSelect: () => openProject(thread),
        },
        {
          type: "item",
          label: "Open terminal",
          icon: Terminal,
          disabled: disconnected,
          hint: disconnected ? "server disconnected" : undefined,
          onSelect: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", {
            detail: { ws: ref.ws, sid: ref.sid, kind: "agent" },
          })),
        },
        ...common,
        {
          type: "item",
          label: "Copy run id",
          icon: Copy,
          onSelect: () => act(() => navigator.clipboard.writeText(ref.threadId)),
        },
        { type: "separator" },
        ...(thread.workflow ? [
          {
            type: "item" as const,
            label: thread.workflow.status === "paused" ? "Resume workflow" : "Pause workflow",
            icon: thread.workflow.status === "paused" ? Play : Pause,
            disabled: disconnected,
            hint: disconnected ? "server disconnected" : undefined,
            onSelect: () => act(() => client!.request("workflow.setPaused", {
              ws: ref.ws,
              workflowId: thread.workflow!.id,
              paused: thread.workflow!.status !== "paused",
            })),
          },
          {
            type: "item" as const,
            label: "Compact manager transcript",
            disabled: disconnected || thread.live,
            hint: disconnected ? "server disconnected"
              : thread.live ? "refused while runs are live" : undefined,
            onSelect: () => act(() => client!.request("workflow.compact", {
              ws: ref.ws,
              workflowId: thread.workflow!.id,
            })),
          },
          {
            type: "item" as const,
            label: "Cancel workflow",
            danger: true,
            disabled: disconnected,
            hint: disconnected ? "server disconnected" : undefined,
            onSelect: () => {
              setConfirmation({
                title: "Cancel this workflow?",
                consequence: "Live runs are stopped; the transcript stays.",
                run: () => act(() => client!.request("workflow.cancel", {
                  ws: ref.ws,
                  workflowId: thread.workflow!.id,
                })),
              });
            },
          },
        ] : []),
        {
          type: "item",
          label: "Cancel live turn",
          icon: Square,
          disabled: disconnected || !["running", "queued"].includes(face.status),
          hint: disconnected ? "server disconnected" : undefined,
          onSelect: () => act(() => client!.request("agent.cancel", {
            ws: ref.ws,
            runId: face.id,
          })),
        },
      ];
    }
    const program = thread.program!;
    const terminalDeliveries = program.deliveries.filter(
      (delivery) => delivery.status === "failed" || delivery.status === "cancelled",
    );
    return [
      ...common,
      { type: "separator" },
      {
        type: "item",
        label: program.managerRunId ? "Close manager" : "Start manager",
        onSelect: () => act(() => program.managerRunId
          ? closeManager(program.id)
          : startManager(program.id)),
      },
      {
        type: "item",
        label: program.status === "paused" ? "Resume program" : "Pause program",
        onSelect: () => act(() => setProgramPaused(program.id, program.status !== "paused")),
      },
      {
        type: "submenu",
        label: "Retry delivery",
        disabled: !terminalDeliveries.length,
        entries: terminalDeliveries.map((delivery) => ({
          type: "item",
          label: delivery.projectName,
          onSelect: () => act(() => retryDelivery(program.id, delivery.id)),
        })),
      },
      { type: "separator" },
      {
        type: "item",
        label: "Cancel program",
        icon: Square,
        danger: true,
        disabled: isProgramTerminal(program.status),
        onSelect: () => {
          setConfirmation({
            title: "Cancel this program?",
            consequence: "Live manager and delivery runs are stopped; history stays.",
            run: () => act(() => cancelProgram(program.id)),
          });
        },
      },
      {
        type: "item",
        label: "Remove program",
        icon: Trash2,
        danger: true,
        disabled: !isProgramTerminal(program.status),
        onSelect: () => {
          setConfirmation({
            title: "Remove this program?",
            consequence: "The program and its saved transcript are permanently removed.",
            run: () => act(() => removeProgram(program.id)),
          });
        },
      },
    ];
  };

  const headingEntriesFor = (section: OverviewSection): MenuEntry[] => {
    if (section.kind === "coordinator") {
      return [{
        type: "item",
        label: "New program",
        onSelect: () => update({ projects: { view: "threads", compose: true } }),
      }];
    }
    return [
      {
        type: "item",
        label: "Open project",
        onSelect: () => {
          selectWorkspace(section.sid, section.ws);
          update({ ws: formatWsRef(section.sid, section.ws), mode: "threads" });
        },
      },
      {
        type: "item",
        label: "New thread in project",
        onSelect: () => {
          selectWorkspace(section.sid, section.ws);
          update({
            ws: formatWsRef(section.sid, section.ws),
            mode: "threads",
            threads: { thread: null, compose: true },
          });
        },
      },
      {
        type: "item",
        label: "Open terminal",
        onSelect: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", {
          detail: { ws: section.ws, sid: section.sid, kind: "agent" },
        })),
      },
    ];
  };

  const selectedEvents = useMemo(() => {
    if (!selected?.summary || selected.ref.kind !== "workspace") return {};
    const ref = selected.ref;
    const result: Record<string, typeof EMPTY_EVENTS> = {};
    const walk = (node: typeof selected.summary.node) => {
      for (const turn of node.turns) {
        result[turn.id] = eventsByRunKey[runKey(ref.sid, ref.ws, turn.id)] ?? EMPTY_EVENTS;
      }
      node.workers.forEach(walk);
    };
    walk(selected.summary.node);
    return result;
  }, [selected, eventsByRunKey]);

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0">
      <OverviewThreadRail
      sections={sections}
      selectedId={selected?.id ?? null}
      filter={filter}
      managerCount={managerCount}
      allCount={allCount}
      hubLoaded={hubLoaded}
      hubError={hubError}
      onRetryHub={() => act(refreshHub)}
      onClearSelection={clearSelection}
      hiddenCount={hiddenCount}
      hasUnfilteredThreads={allSections.some((section) => section.threads.length > 0)}
      onFilter={setFilter}
      find={nav?.find ?? ""}
      onFind={(find) => update({ projects: { view: "threads", find: find || null } })}
      onSelect={(id) => {
        update({
          projects: {
            view: "threads",
            thread: id,
            program: null,
            turn: null,
            compose: null,
          },
        });
      }}
      onPin={read.togglePin}
      onNewProgram={() => update({ projects: { view: "threads", compose: true } })}
      onFocusComposer={() => {
        surfaceRef.current?.querySelector<HTMLTextAreaElement>(
          'main textarea[aria-label^="Message"]',
        )?.focus();
      }}
      entriesFor={entriesFor}
      headingEntriesFor={headingEntriesFor}
      openMenu={menu.open}
      />
      <OverviewThreadPane
      thread={selected}
      creating={creating}
      notice={notice?.text ?? null}
      noticeTone={notice?.tone ?? "danger"}
      dismissNotice={() => setNotice(null)}
      onError={(text) => setNotice({ text, tone: "danger" })}
      onCreated={(programId) => {
        update({
          projects: {
            view: "threads",
            thread: formatOverviewThreadId({ kind: "program", programId }),
            program: null,
            compose: null,
          },
        });
      }}
      questions={
        selected?.ref.kind === "workspace"
          ? questionsByWs[wsKey(selected.ref.sid, selected.ref.ws)] ?? EMPTY_QUESTIONS
          : EMPTY_QUESTIONS
      }
      eventsByRun={selectedEvents}
      runs={
        selected?.ref.kind === "workspace"
          ? runsByWs[wsKey(selected.ref.sid, selected.ref.ws)] ?? EMPTY_RUNS
          : EMPTY_RUNS
      }
      loadEvents={loadSelectedEvents}
      focusTurnId={nav?.turn}
      onFocusedTurn={handleFocusedTurn}
      onCopyTurnLink={selected ? (turn) => copyTurnLink(selected, turn) : undefined}
      entries={selected ? entriesFor(selected) : []}
      openMenu={menu.open}
      openProject={() => selected && openProject(selected)}
      missingRef={requested && !selected && requestedLoaded ? requestedRef : null}
      missingProjectClosed={requestedProjectClosed}
      clearSelection={clearSelection}
      resumeWorkflow={() => {
        if (selected?.ref.kind !== "workspace" || !selected.workflow) return;
        const ref = selected.ref;
        const workflow = selected.workflow;
        const client = fleet.clientOf(ref.sid);
        act(() => client?.request("workflow.setPaused", {
          ws: ref.ws,
          workflowId: workflow.id,
          paused: false,
        }));
      }}
      />
      {menu.element}
      <Dialog open={confirmation != null} onOpenChange={(open) => !open && setConfirmation(null)}>
        <DialogContent title={confirmation?.title ?? "Confirm action"}>
          <p className="text-xs text-ink-muted">{confirmation?.consequence}</p>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm" autoFocus>Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                confirmation?.run();
                setConfirmation(null);
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

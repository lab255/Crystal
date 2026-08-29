import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Pause, Play, Square, Terminal, Trash2 } from "lucide-react";
import { formatDeepLink, formatWsRef, isProgramTerminal, unrecoveredFailures } from "@crystal/core";
import {
  EMPTY_EVENTS, EMPTY_QUESTIONS, EMPTY_RUNS, runKey, wsKey,
  useCrystal, useFleet, useFleetConnections, useHub, useNav, useNavUpdate,
} from "@crystal/client";
import { useContextMenu, type MenuEntry } from "@crystal/ui";
import { useThreadReadState } from "../thread-unread.js";
import { OverviewThreadPane } from "./OverviewThreadPane.js";
import { OverviewThreadRail } from "./OverviewThreadRail.js";
import { buildOverviewSections, formatOverviewThreadId, type OverviewSection, type OverviewThread } from "./overview-thread-model.js";

const FILTER_KEY = "crystal.overview.threads.filter";
export default function OverviewThreads() {
  const connections = useFleetConnections();
  const runsByWs = useFleet((s) => s.runsByWs);
  const workflowsByWs = useFleet((s) => s.workflowsByWs);
  const questionsByWs = useFleet((s) => s.questionsByWs);
  const permissionsByWs = useFleet((s) => s.permissionsByWs);
  const eventsByRunKey = useFleet((s) => s.eventsByRunKey);
  const loadRunEvents = useFleet((s) => s.loadRunEvents);
  const programs = useHub((s) => s.programs);
  const hubRuns = useHub((s) => s.runs);
  const programQuestions = useHub((s) => s.questions);
  const startManager = useHub((s) => s.startManager);
  const closeManager = useHub((s) => s.closeManager);
  const setProgramPaused = useHub((s) => s.setPaused);
  const cancelProgram = useHub((s) => s.cancel);
  const removeProgram = useHub((s) => s.remove);
  const retryDelivery = useHub((s) => s.retryDelivery);
  const nav = useNav((link) => link.projects ?? null);
  const update = useNavUpdate();
  const { fleet, selectWorkspace, activeSid } = useCrystal();
  const read = useThreadReadState();
  const menu = useContextMenu();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilterState] = useState<"managers" | "all">(() => typeof localStorage !== "undefined" && localStorage.getItem(FILTER_KEY) === "all" ? "all" : "managers");
  const setFilter = (value: "managers" | "all") => { setFilterState(value); try { localStorage.setItem(FILTER_KEY, value); } catch {} };

  const attentionByWs = useMemo(() => {
    const result: Record<string, Set<string>> = {};
    for (const connection of connections) for (const workspace of connection.workspaces) {
      const key = wsKey(connection.sid, workspace.id);
      const ids = new Set<string>();
      for (const row of questionsByWs[key] ?? EMPTY_QUESTIONS) if (row.question.runId) ids.add(row.question.runId);
      for (const run of unrecoveredFailures(runsByWs[key] ?? EMPTY_RUNS)) ids.add(run.id);
      for (const permission of permissionsByWs[key] ?? []) ids.add(permission.runId);
      result[key] = ids;
    }
    return result;
  }, [connections, questionsByWs, runsByWs, permissionsByWs]);

  const sections = useMemo(() => buildOverviewSections({ connections, runsByWs, workflowsByWs, attentionByWs, programs, hubRuns, hubSid: activeSid, programQuestions, lastSeen: read.seen, pins: new Set(read.pins), filter, find: nav?.find }), [connections, runsByWs, workflowsByWs, attentionByWs, programs, hubRuns, activeSid, programQuestions, read.seen, read.pins, filter, nav?.find]);
  const requested = nav?.thread ?? (nav?.program ? formatOverviewThreadId({ kind: "program", programId: nav.program }) : null);
  const selected = sections.flatMap((section) => section.threads).find((thread) => thread.id === requested) ?? null;

  useEffect(() => { if (selected?.lastActivity) read.markSeen(selected.readKey, selected.lastActivity); }, [selected?.readKey, selected?.lastActivity, read.markSeen]);
  const act = useCallback((fn: () => unknown | Promise<unknown>) => { void Promise.resolve().then(fn).catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, []);
  const copyLink = (thread: OverviewThread) => act(async () => { const hash = formatDeepLink({ mode: "projects", projects: { view: "threads", thread: thread.id } }); await navigator.clipboard.writeText(`${location.origin}${location.pathname}${hash}`); });
  const openProject = (thread: OverviewThread) => { if (thread.ref.kind !== "workspace") return; selectWorkspace(thread.ref.sid, thread.ref.ws); update({ ws: formatWsRef(thread.ref.sid, thread.ref.ws), mode: "threads", threads: { thread: thread.ref.threadId, compose: null } }); };

  const entriesFor = useCallback((thread: OverviewThread): MenuEntry[] => {
    const common: MenuEntry[] = [
      { type: "item", label: thread.pinned ? "Unpin" : "Pin", onSelect: () => read.togglePin(thread.readKey) },
      { type: "item", label: read.seen[thread.readKey] ? "Mark as unread" : "Mark as read", onSelect: () => read.seen[thread.readKey] ? read.clearSeen(thread.readKey) : thread.lastActivity && read.markSeen(thread.readKey, thread.lastActivity) },
      { type: "item", label: "Copy link", icon: Copy, onSelect: () => copyLink(thread) },
    ];
    if (thread.ref.kind === "workspace") {
      const ref = thread.ref;
      const client = fleet.clientOf(ref.sid);
      const face = thread.summary!.node.run;
      return [
        { type: "item", label: "Open in project", icon: ExternalLink, onSelect: () => openProject(thread) },
        { type: "item", label: "Open terminal", icon: Terminal, onSelect: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", { detail: { ws: ref.ws, sid: ref.sid, kind: "agent" } })) },
        ...common, { type: "item", label: "Copy run id", icon: Copy, onSelect: () => act(() => navigator.clipboard.writeText(ref.threadId)) }, { type: "separator" },
        ...(thread.workflow ? [
          { type: "item" as const, label: thread.workflow.status === "paused" ? "Resume workflow" : "Pause workflow", icon: thread.workflow.status === "paused" ? Play : Pause, onSelect: () => act(() => client!.request("workflow.setPaused", { ws: ref.ws, workflowId: thread.workflow!.id, paused: thread.workflow!.status !== "paused" })) },
          { type: "item" as const, label: "Compact manager transcript", disabled: thread.live, hint: thread.live ? "refused while runs are live" : undefined, onSelect: () => act(() => client!.request("workflow.compact", { ws: ref.ws, workflowId: thread.workflow!.id })) },
          { type: "item" as const, label: "Cancel workflow", danger: true, onSelect: () => { if (window.confirm("Cancel this workflow?")) act(() => client!.request("workflow.cancel", { ws: ref.ws, workflowId: thread.workflow!.id })); } },
        ] : []),
        { type: "item", label: "Cancel live turn", icon: Square, disabled: !["running", "queued"].includes(face.status), onSelect: () => act(() => client!.request("agent.cancel", { ws: ref.ws, runId: face.id })) },
      ];
    }
    const program = thread.program!;
    const terminalDeliveries = program.deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "cancelled");
    return [...common, { type: "separator" },
      { type: "item", label: program.managerRunId ? "Close manager" : "Start manager", onSelect: () => act(() => program.managerRunId ? closeManager(program.id) : startManager(program.id)) },
      { type: "item", label: program.status === "paused" ? "Resume program" : "Pause program", onSelect: () => act(() => setProgramPaused(program.id, program.status !== "paused")) },
      { type: "submenu", label: "Retry delivery", disabled: !terminalDeliveries.length, entries: terminalDeliveries.map((delivery) => ({ type: "item", label: delivery.projectName, onSelect: () => act(() => retryDelivery(program.id, delivery.id)) })) },
      { type: "separator" },
      { type: "item", label: "Cancel program", icon: Square, danger: true, disabled: isProgramTerminal(program.status), onSelect: () => { if (window.confirm("Cancel this program?")) act(() => cancelProgram(program.id)); } },
      { type: "item", label: "Remove program", icon: Trash2, danger: true, disabled: !isProgramTerminal(program.status), onSelect: () => { if (window.confirm("Remove this program?")) act(() => removeProgram(program.id)); } },
    ];
  }, [read, fleet, startManager, closeManager, setProgramPaused, retryDelivery, cancelProgram, removeProgram, act]);

  const headingEntriesFor = (section: OverviewSection): MenuEntry[] => section.kind === "coordinator" ? [{ type: "item", label: "New program", onSelect: () => setCreating(true) }] : [
    { type: "item", label: "Open project", onSelect: () => { selectWorkspace(section.sid, section.ws); update({ ws: formatWsRef(section.sid, section.ws), mode: "threads" }); } },
    { type: "item", label: "New thread in project", onSelect: () => { selectWorkspace(section.sid, section.ws); update({ ws: formatWsRef(section.sid, section.ws), mode: "threads", threads: { thread: null, compose: true } }); } },
    { type: "item", label: "Open terminal", onSelect: () => window.dispatchEvent(new CustomEvent("crystal:open-terminal", { detail: { ws: section.ws, sid: section.sid, kind: "agent" } })) },
  ];

  const selectedEvents = useMemo(() => {
    if (!selected?.summary || selected.ref.kind !== "workspace") return {};
    const ref = selected.ref;
    const result: Record<string, typeof EMPTY_EVENTS> = {};
    const walk = (node: typeof selected.summary.node) => { for (const turn of node.turns) result[turn.id] = eventsByRunKey[runKey(ref.sid, ref.ws, turn.id)] ?? EMPTY_EVENTS; node.workers.forEach(walk); };
    walk(selected.summary.node); return result;
  }, [selected, eventsByRunKey]);

  return <div className="flex h-full min-h-0">
    <OverviewThreadRail sections={sections} selectedId={selected?.id ?? null} filter={filter} onFilter={setFilter} find={nav?.find ?? ""} onFind={(find) => update({ projects: { view: "threads", find: find || null } })} onSelect={(id) => { setCreating(false); update({ projects: { view: "threads", thread: id, program: null } }); }} onPin={read.togglePin} onNewProgram={() => setCreating(true)} entriesFor={entriesFor} headingEntriesFor={headingEntriesFor} openMenu={menu.open} />
    <OverviewThreadPane thread={selected} creating={creating} notice={notice} dismissNotice={() => setNotice(null)} onCreated={(programId) => { setCreating(false); update({ projects: { view: "threads", thread: formatOverviewThreadId({ kind: "program", programId }), program: null } }); }} questions={selected?.ref.kind === "workspace" ? questionsByWs[wsKey(selected.ref.sid, selected.ref.ws)] ?? EMPTY_QUESTIONS : EMPTY_QUESTIONS} eventsByRun={selectedEvents} loadEvents={async (id) => { if (selected?.ref.kind === "workspace") await loadRunEvents(selected.ref.sid, selected.ref.ws, id); }} entries={selected ? entriesFor(selected) : []} openMenu={menu.open} openProject={() => selected && openProject(selected)} />
    {menu.element}
  </div>;
}

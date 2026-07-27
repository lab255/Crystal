import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, CircleHelp, Plug, Plus, Search, Target } from "lucide-react";
import { isDeliveryTerminal, isProgramLive, programSpend, type Program } from "@crystal/core";
import {
  EMPTY_HUB_QUESTIONS,
  EMPTY_PROGRAMS,
  useHub,
  useNav,
  useNavUpdate,
} from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  Input,
  Pane as SplitPane,
  Split,
  Spinner,
  Tooltip,
  cn,
  useContextMenu,
} from "@crystal/ui";
import {
  SectionLabel,
  SegmentedTab,
  copyText,
  SpendLine,
  StatusBadge,
  TabStrip,
  useHubMenuContext,
} from "./common.js";
import { NewProgramPanel } from "./NewProgramPanel.js";
import { ProgramDetail } from "./ProgramDetail.js";
import { ProjectsView } from "./ProjectsView.js";
import { QuestionsView } from "./QuestionsView.js";
import { programMenuEntries } from "./menus.js";

/**
 * The Hub — Crystal's cross-project mode. Everything else in the IDE is a view
 * into one workspace; this one sits above them, holding **programs**: a
 * high-level goal split into per-project deliveries, each handed to that
 * project's own orchestrator.
 *
 * Deliberately not a workspace facet: it neither reads nor writes the active
 * workspace, and switching workspaces must not remount it (see the shell's
 * mode key).
 */
export function HubMode() {
  const nav = useNavUpdate();
  const view = useNav((l) => l.hub?.view) ?? "programs";
  const find = useNav((l) => l.hub?.find) ?? "";
  const activeMode = useNav((l) => l.mode) ?? "hub";
  const refresh = useHub((s) => s.refresh);
  const loaded = useHub((s) => s.loaded);
  const programs = useHub((s) => s.programs) ?? EMPTY_PROGRAMS;
  const questionsByProgram = useHub((s) => s.questions);
  const [endpointOpen, setEndpointOpen] = useState(false);

  useEffect(() => {
    if (!loaded) void refresh().catch(() => {});
  }, [loaded, refresh]);

  // Hidden-but-mounted modes must not swallow the find shortcut.
  useEffect(() => {
    if (activeMode !== "hub") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        document.getElementById("hub-find")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode]);

  const live = programs.filter((p) => isProgramLive(p.status)).length;
  const waiting = Object.values(questionsByProgram).reduce((n, qs) => n + qs.length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Target className="h-4 w-4 shrink-0 text-crystal-300" />
        <span className="text-sm font-semibold text-ink">Hub</span>
        <span className="text-[11px] text-ink-faint">
          {programs.length} program{programs.length === 1 ? "" : "s"}
          {live ? ` · ${live} live` : ""}
        </span>
        {waiting ? (
          <button
            type="button"
            onClick={() => nav({ hub: { view: "questions" } })}
            title="Open the questions inbox"
            className="flex items-center gap-1 rounded-full border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-warn transition-colors hover:bg-warn/20"
          >
            <CircleHelp className="h-3 w-3" />
            {waiting} waiting on you
          </button>
        ) : null}

        <div className="relative ml-3 w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint" />
          <Input
            id="hub-find"
            value={find}
            onChange={(e) => nav({ hub: { find: e.target.value || null } })}
            placeholder="Filter programs and projects"
            aria-label="Filter"
            className="h-7 pl-7 text-[11px]"
          />
        </div>

        <Tooltip content="The MCP endpoint an external agent points at to drive the hub">
          <Button variant="ghost" size="xs" onClick={() => setEndpointOpen(true)}>
            <Plug className="h-3 w-3" /> Agent endpoint
          </Button>
        </Tooltip>

        <TabStrip className="ml-auto">
          <SegmentedTab
            active={view === "programs"}
            onClick={() => nav({ hub: { view: "programs" } })}
          >
            <Target className="h-3.5 w-3.5" /> Programs
          </SegmentedTab>
          <SegmentedTab
            active={view === "projects"}
            onClick={() => nav({ hub: { view: "projects" } })}
          >
            <Boxes className="h-3.5 w-3.5" /> Projects
          </SegmentedTab>
          <SegmentedTab
            active={view === "questions"}
            onClick={() => nav({ hub: { view: "questions" } })}
          >
            <CircleHelp className="h-3.5 w-3.5" /> Questions
            {waiting ? (
              <span className="ml-0.5 rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn">
                {waiting}
              </span>
            ) : null}
          </SegmentedTab>
        </TabStrip>
      </header>

      <HubError />

      {view === "programs" ? (
        <ProgramsView find={find} />
      ) : view === "questions" ? (
        <QuestionsView find={find} />
      ) : (
        <ProjectsView find={find} />
      )}

      <EndpointDialog open={endpointOpen} onOpenChange={setEndpointOpen} />
    </div>
  );
}

/**
 * Why the hub has no data. Most often: this server was started with the hub
 * disabled, or the bridge dropped. Either way the mode says so and offers a
 * retry rather than sitting on a skeleton.
 */
function HubError() {
  const error = useHub((s) => s.error);
  const refresh = useHub((s) => s.refresh);
  if (!error) return null;
  return (
    <div className="flex items-center gap-2 border-b border-danger/25 bg-danger/8 px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{error}</span>
      <Button variant="ghost" size="xs" onClick={() => void refresh()}>
        Retry
      </Button>
    </div>
  );
}


/** Program list on the left, the selected program (or the start panel) on the right. */
function ProgramsView({ find }: { find: string }) {
  const nav = useNavUpdate();
  const programs = useHub((s) => s.programs) ?? EMPTY_PROGRAMS;
  const loaded = useHub((s) => s.loaded);
  const selectedId = useNav((l) => l.hub?.program) ?? null;
  const select = useCallback(
    (id: string | null) => nav({ hub: { program: id, delivery: null, run: null } }),
    [nav],
  );

  const needle = find.trim().toLowerCase();
  const shown = needle
    ? programs.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.goal.toLowerCase().includes(needle) ||
          p.deliveries.some((d) => d.projectName.toLowerCase().includes(needle)),
      )
    : programs;
  const selected = programs.find((p) => p.id === selectedId) ?? null;

  return (
    <Split storageKey="hub:programs" direction="horizontal" className="min-h-0 flex-1">
      <SplitPane defaultSize={300} minSize={220} maxSize={480}>
        <aside className="flex h-full flex-col border-r border-edge bg-surface-1">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
            <SectionLabel>Programs</SectionLabel>
            <span className="text-[10px] text-ink-faint">{shown.length}</span>
            <Tooltip content="Start something new">
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="New program"
                onClick={() => select(null)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!loaded ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-ink-faint">
                <Spinner className="h-3 w-3" /> Loading programs…
              </div>
            ) : shown.length === 0 ? (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-ink-faint">
                {needle
                  ? "Nothing matches the current filter."
                  : "No programs yet. Dispatch an epic to a project on the right — or point an agent at the hub's MCP endpoint and let it dispatch."}
              </p>
            ) : (
              shown.map((program) => (
                <ProgramListItem
                  key={program.id}
                  program={program}
                  selected={program.id === selectedId}
                  onSelect={() => select(program.id)}
                />
              ))
            )}
          </div>
        </aside>
      </SplitPane>
      <SplitPane minSize="40%">
        {selected ? (
          <ProgramDetail key={selected.id} program={selected} />
        ) : (
          <NewProgramPanel onStarted={select} />
        )}
      </SplitPane>
    </Split>
  );
}

function ProgramListItem({
  program,
  selected,
  onSelect,
}: {
  program: Program;
  selected: boolean;
  onSelect: () => void;
}) {
  const spend = useHub((s) => s.spend[program.id]) ?? programSpend({});
  const questions = useHub((s) => s.questions[program.id]) ?? EMPTY_HUB_QUESTIONS;
  const setPaused = useHub((s) => s.setPaused);
  const cancel = useHub((s) => s.cancel);
  const dispatch = useHub((s) => s.dispatch);
  const remove = useHub((s) => s.remove);
  const allPrograms = useHub((s) => s.programs);
  const menu = useContextMenu();
  const menuCtx = useHubMenuContext();
  const others = useMemo(
    () => allPrograms.filter((p) => p.id !== program.id),
    [allPrograms, program.id],
  );
  const done = program.deliveries.filter((d) => d.status === "completed").length;
  const liveDeliveries = program.deliveries.filter((d) => !isDeliveryTerminal(d.status)).length;

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={(e) =>
          menu.open(
            e,
            programMenuEntries(program, menuCtx, {
              others,
              dispatch: () => void dispatch(program.id).catch(() => {}),
              setPaused: (paused) => void setPaused(program.id, paused).catch(() => {}),
              cancel: () => void cancel(program.id).catch(() => {}),
              remove: () => void remove(program.id).catch(() => {}),
            }),
          )
        }
        className={cn(
          "mb-1 block w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
          selected
            ? "border-crystal-500/40 bg-crystal-500/10"
            : "border-transparent hover:border-edge hover:bg-surface-2",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {program.name}
          </span>
          {questions.length ? (
            <span
              title={`${questions.length} unanswered question${questions.length === 1 ? "" : "s"}`}
              className="flex shrink-0 items-center gap-0.5 rounded-full border border-warn/40 bg-warn/10 px-1.5 text-[9px] font-medium text-warn"
            >
              <CircleHelp className="h-2.5 w-2.5" />
              {questions.length}
            </span>
          ) : null}
          <StatusBadge status={program.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint">
          <span>
            {done}/{program.deliveries.length} delivered
          </span>
          <SpendLine costUsd={spend.costUsd} budgetUsd={program.budgetUsd} />
          {spend.liveRunCount > 0 ? <Spinner className="h-2.5 w-2.5" /> : null}
        </div>
        {program.deliveries.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {program.deliveries.slice(0, 4).map((d) => (
              <span
                key={d.id}
                className={cn(
                  "truncate rounded-full border px-1.5 py-0.5 text-[9px]",
                  d.status === "completed"
                    ? "border-ok/30 text-ok"
                    : d.status === "failed"
                      ? "border-danger/30 text-danger"
                      : d.status === "running"
                        ? "border-crystal-500/40 bg-crystal-500/10 text-crystal-200"
                        : "border-edge text-ink-faint",
                )}
              >
                {d.projectName}
              </span>
            ))}
            {program.deliveries.length > 4 ? (
              <span className="text-[9px] text-ink-faint">
                +{program.deliveries.length - 4}
              </span>
            ) : null}
          </div>
        ) : null}
        {liveDeliveries === 0 && program.status === "running" && program.deliveries.length > 0 ? (
          <div className="mt-1 text-[9px] text-warn">nothing running</div>
        ) : null}
      </button>
      {menu.element}
    </>
  );
}

/**
 * How an external agent drives all of this: the hub's MCP endpoint. Shown
 * rather than hidden in docs, because the whole point of the Hub is that a
 * central agent — Claude Code in any terminal — can dispatch epics into any
 * project from one place.
 */
function EndpointDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const endpoint = useHub((s) => s.endpoint);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Drive the hub from an agent"
        description="These tools dispatch epics into any project on this server, then report back as their orchestrators work."
      >
        {endpoint ? (
          <div className="space-y-3">
            <div>
              <SectionLabel>Add it to Claude Code</SectionLabel>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-edge bg-surface-0 px-3 py-2 font-mono text-[11px] text-ink-muted">
                claude mcp add --transport http crystal-hub {endpoint.url}
              </pre>
            </div>
            <div>
              <SectionLabel>Or as MCP config</SectionLabel>
              <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-edge bg-surface-0 px-3 py-2 font-mono text-[11px] text-ink-muted">
                {endpoint.mcpConfig}
              </pre>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Loopback only. The port is ephemeral unless the server was started with{" "}
              <code className="font-mono">--mcp-port</code>, so pin it if you want the config to
              survive restarts.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => copyText(endpoint.mcpConfig)}>
                Copy config
              </Button>
              <DialogClose asChild>
                <Button variant="secondary" size="sm">
                  Done
                </Button>
              </DialogClose>
            </div>
          </div>
        ) : (
          <EmptyState icon={Plug} title="Endpoint unavailable">
            This server has the cross-project hub disabled.
          </EmptyState>
        )}
      </DialogContent>
    </Dialog>
  );
}

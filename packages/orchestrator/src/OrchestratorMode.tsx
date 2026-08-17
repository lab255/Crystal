import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChartColumn,
  ChevronDown,
  CircleHelp,
  Coins,
  KanbanSquare,
  KeyRound,
  ListTodo,
  MessagesSquare,
  Network,
  Plus,
  Rows3,
  Sparkles,
} from "lucide-react";
import {
  RUN_PURPOSES,
  attentionRunIds,
  countActionableQuestions,
  deriveNeedsYou,
  firstAttentionTask,
  livenessIndex,
  type OrchestratorTabId,
  type Project,
  type RunPurpose,
} from "@crystal/core";
import { useAgents, useNav, useNavUpdate, usePermissions, useWorkspace } from "@crystal/client";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Pane,
  Split,
  cn,
} from "@crystal/ui";
import { AgentsTab } from "./AgentsTab.js";
import { Board } from "./Board.js";
import { CostsTab } from "./CostsTab.js";
import { InsightsTab, INSIGHT_PERIODS, type InsightPeriod } from "./InsightsTab.js";
import { QuestionsStrip } from "./QuestionsStrip.js";
import { RunsPane } from "./RunsPane.js";
import { SessionsTab } from "./SessionsTab.js";
import { TaskDetail } from "./TaskDetail.js";
import { TaskSession } from "./TaskSession.js";
import { TasksColumn } from "./TasksColumn.js";
import { WorkflowsTab } from "./WorkflowsTab.js";

type OrchestratorTab = OrchestratorTabId;

const EMPTY_PROJECTS: never[] = [];

export function OrchestratorMode() {
  const projects = useWorkspace((s) => s.info?.projects ?? EMPTY_PROJECTS);
  const updateProject = useWorkspace((s) => s.updateProject);
  const createProject = useWorkspace((s) => s.createProject);
  const runs = useAgents((s) => s.runs);

  // Tab and selections are deep-linkable — they live in the nav store.
  const nav = useNavUpdate();
  const tab = useNav((l) => l.orchestrate?.tab) ?? "board";
  const setTab = useCallback(
    (t: OrchestratorTab) => nav({ orchestrate: { tab: t } }),
    [nav],
  );
  const projectPath = useNav((l) => l.orchestrate?.project) ?? null;
  const setProjectPath = useCallback(
    (path: string | null) => nav({ orchestrate: { project: path } }),
    [nav],
  );
  const taskId = useNav((l) => l.orchestrate?.task) ?? null;
  const setTaskId = useCallback(
    (id: string | null) => nav({ orchestrate: { task: id } }),
    [nav],
  );
  // Board-tab layout: list+session (default) or the kanban. Deep-linkable so
  // "send me the board" and "send me my working view" are both real URLs.
  const boardView = useNav((l) => l.orchestrate?.view) ?? "list";
  const setBoardView = useCallback(
    (v: "list" | "board") => nav({ orchestrate: { view: v === "list" ? null : v } }),
    [nav],
  );
  // Selecting a task in the list clears any pinned run — a run of the
  // previous task must not leak into the next task's session pane.
  const selectListTask = useCallback(
    (id: string | null) => nav({ orchestrate: { task: id, run: null } }),
    [nav],
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const runId = useNav((l) => l.orchestrate?.run) ?? null;
  const setRunId = useCallback(
    (id: string | null) => nav({ orchestrate: { run: id } }),
    [nav],
  );
  const sessionProject = useNav((l) => l.orchestrate?.sessionProject) ?? null;
  const sessionEpic = useNav((l) => l.orchestrate?.sessionEpic) ?? null;
  const setSessionScope = useCallback(
    (projectId: string | null, epicId: string | null) =>
      nav({ orchestrate: { sessionProject: projectId, sessionEpic: epicId } }),
    [nav],
  );
  const workflowId = useNav((l) => l.orchestrate?.workflow) ?? null;
  const setWorkflowId = useCallback(
    (id: string | null) => nav({ orchestrate: { workflow: id } }),
    [nav],
  );
  const builderOpen = useNav((l) => l.orchestrate?.builder) ?? false;
  const setBuilderOpen = useCallback(
    (open: boolean) => nav({ orchestrate: { builder: open } }),
    [nav],
  );
  const templateId = useNav((l) => l.orchestrate?.template) ?? null;
  const setTemplateId = useCallback(
    (id: string | null) => nav({ orchestrate: { template: id } }),
    [nav],
  );
  const rawPeriod = useNav((l) => l.orchestrate?.period);
  const period: InsightPeriod = (INSIGHT_PERIODS as readonly number[]).includes(rawPeriod ?? 0)
    ? (rawPeriod as InsightPeriod)
    : 30;
  const setPeriod = useCallback(
    (p: InsightPeriod) => nav({ orchestrate: { period: p } }),
    [nav],
  );
  const pendingPermissions = usePermissions((s) => s.pending);
  const needsYou = useMemo(
    () => deriveNeedsYou(projects, runs, pendingPermissions),
    [projects, runs, pendingPermissions],
  );
  const runsById = useMemo(() => livenessIndex(runs), [runs]);
  const attention = useMemo(() => attentionRunIds(needsYou), [needsYou]);
  const auth = useAgents((s) => s.auth);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  // The Runs tab's purpose filter (Jobs' run list folded in) rides the URL.
  const purposeFilter = useNav((l) => l.orchestrate?.purpose) ?? null;
  const setPurposeFilter = useCallback(
    (p: RunPurpose | null) => nav({ orchestrate: { purpose: p } }),
    [nav],
  );
  const costBy = useNav((l) => l.orchestrate?.costBy) ?? null;
  const setCostBy = useCallback(
    (axis: string) => nav({ orchestrate: { costBy: axis } }),
    [nav],
  );

  const current = projects.find((p) => p.path === projectPath) ?? projects[0] ?? null;
  useEffect(() => {
    if (current && current.path !== projectPath) setProjectPath(current.path);
  }, [current?.path]);

  const selectedTask = current?.project.tasks.find((t) => t.id === taskId) ?? null;

  // The list view never opens empty: land on the most urgent thing —
  // longest-waiting attention task, else the first task in grouped order.
  useEffect(() => {
    if (tab !== "board" || boardView !== "list" || !current || selectedTask) return;
    const first = firstAttentionTask(current.project, runs);
    if (first) selectListTask(first.id);
  }, [tab, boardView, current, selectedTask, runs, selectListTask]);

  const runningCount = runs.filter((r) => r.status === "running").length;
  const waitingCount = current ? countActionableQuestions([current], runsById) : 0;

  // Only purposes actually present become chips, in RUN_PURPOSES order.
  const presentPurposes = useMemo(() => {
    const present = new Set(runs.map((r) => r.purpose).filter(Boolean));
    return RUN_PURPOSES.filter((p) => present.has(p));
  }, [runs]);
  const filteredRuns = useMemo(
    () => (purposeFilter ? runs.filter((r) => r.purpose === purposeFilter) : runs),
    [runs, purposeFilter],
  );

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const created = await createProject(name);
    setProjectPath(created.path);
    setNewName("");
    setCreateOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 gap-y-1 border-b border-edge bg-surface-1 px-3 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="font-semibold text-ink">
              <KanbanSquare className="h-3.5 w-3.5 text-crystal-300" />
              {current?.project.name ?? "No project"}
              <ChevronDown className="h-3 w-3 text-ink-faint" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Projects</DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem key={p.path} onSelect={() => setProjectPath(p.path)}>
                <KanbanSquare className="h-3.5 w-3.5 opacity-60" />
                {p.project.name}
                <span className="ml-auto text-[10px] text-ink-faint">
                  {p.project.tasks.length}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> New project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {needsYou.count > 0 ? (
          <button
            type="button"
            title={
              needsYou.questions
                .map((q) => `? ${q.question.text}`)
                .concat(needsYou.permissions.map((p) => `Allow/Deny ${p.tool}: ${p.summary}`))
                .concat(needsYou.failures.map((f) => `! ${f.failure!.kind.replace("_", " ")}`))
                .slice(0, 6)
                .join("\n") || undefined
            }
            onClick={() => {
              // A question belongs to its board task; run-shaped attention
              // belongs to the hierarchical session that resolves any run id.
              const q = needsYou.questions[0];
              const p = needsYou.permissions[0];
              const f = needsYou.failures[0];
              if (q) {
                setProjectPath(q.projectPath);
                selectListTask(q.taskId);
                setTab("board");
              } else if (p || f) {
                // One nav write, rail scope cleared — a stale project filter
                // must not hide the jumped run's row.
                nav({
                  orchestrate: {
                    tab: "sessions",
                    run: p ? p.runId : f!.id,
                    sessionProject: null,
                    sessionEpic: null,
                  },
                });
              }
            }}
            className="flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-0.5 text-[11px] font-medium text-warn transition-colors hover:bg-warn/20"
          >
            <CircleHelp className="h-3 w-3" />
            {needsYou.count} need{needsYou.count === 1 ? "s" : ""} you
          </button>
        ) : null}

        {tab === "board" ? (
          <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            <TabButton active={boardView === "list"} onClick={() => setBoardView("list")}>
              <Rows3 className="h-3.5 w-3.5" /> List
            </TabButton>
            <TabButton active={boardView === "board"} onClick={() => setBoardView("board")}>
              <KanbanSquare className="h-3.5 w-3.5" /> Kanban
            </TabButton>
          </div>
        ) : null}

        <div
          className={cn(
            "flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5",
            tab === "board" ? "" : "ml-auto",
          )}
        >
          <TabButton active={tab === "board"} onClick={() => setTab("board")}>
            <ListTodo className="h-3.5 w-3.5" /> Tasks
            {waitingCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn">
                {waitingCount}
              </span>
            ) : null}
          </TabButton>
          <TabButton active={tab === "sessions"} onClick={() => setTab("sessions")}>
            <MessagesSquare className="h-3.5 w-3.5" /> Sessions
            {runningCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-info/20 px-1.5 text-[10px] text-info">
                {runningCount}
              </span>
            ) : null}
          </TabButton>
          <TabButton active={tab === "workflows"} onClick={() => setTab("workflows")}>
            <Network className="h-3.5 w-3.5" /> Workflows
          </TabButton>
          <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
            <Bot className="h-3.5 w-3.5" /> Runs
            {runningCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-info/20 px-1.5 text-[10px] text-info">
                {runningCount}
              </span>
            ) : null}
          </TabButton>
          <TabButton active={tab === "agents"} onClick={() => setTab("agents")}>
            <Sparkles className="h-3.5 w-3.5" /> Agents
          </TabButton>
          <TabButton active={tab === "costs"} onClick={() => setTab("costs")}>
            <Coins className="h-3.5 w-3.5" /> Costs
          </TabButton>
          <TabButton active={tab === "insights"} onClick={() => setTab("insights")}>
            <ChartColumn className="h-3.5 w-3.5" /> Insights
          </TabButton>
        </div>
      </header>

      {auth.broken ? (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-ink">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1">
            The Claude CLI login is broken — re-authenticate in a terminal (
            <code className="text-ink-muted">claude /login</code>). Messages and wake-ups are
            parked and deliver automatically once a run succeeds.
          </span>
          {auth.detail ? (
            <span className="truncate font-mono text-[10px] text-ink-faint" title={auth.detail}>
              {auth.detail}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {tab === "board" ? (
          current ? (
            boardView === "list" ? (
              // The working view (operator's list + session): grouped tasks
              // beside the selected task's live session, details on demand.
              <div className="flex h-full min-h-0">
                <div className="min-w-0 flex-1">
                  <Split storageKey="orchestrate-tasks" direction="horizontal">
                    <Pane defaultSize={300} minSize={220} maxSize="45%">
                      <TasksColumn
                        project={current.project}
                        selectedTaskId={taskId}
                        onSelectTask={selectListTask}
                        onProjectChange={(project: Project) => updateProject(current.path, project)}
                      />
                    </Pane>
                    <Pane minSize="35%">
                      {selectedTask ? (
                        <TaskSession
                          project={current.project}
                          projectPath={current.path}
                          task={selectedTask}
                          onProjectChange={(project: Project) => updateProject(current.path, project)}
                          selectedRunId={runId}
                          onSelectRun={setRunId}
                          detailsOpen={detailsOpen}
                          onToggleDetails={() => setDetailsOpen((v) => !v)}
                        />
                      ) : (
                        <EmptyState icon={ListTodo} title="Select a task">
                          Its live session, questions and diff open here — the list keeps
                          streaming while you look.
                        </EmptyState>
                      )}
                    </Pane>
                  </Split>
                </div>
                {detailsOpen && selectedTask ? (
                  <TaskDetail
                    project={current.project}
                    projectPath={current.path}
                    task={selectedTask}
                    onProjectChange={(project: Project) => updateProject(current.path, project)}
                    onClose={() => setDetailsOpen(false)}
                    onOpenRun={setRunId}
                  />
                ) : null}
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <QuestionsStrip
                  project={current.project}
                  projectPath={current.path}
                  onProjectChange={(project: Project) => updateProject(current.path, project)}
                  onOpenTask={setTaskId}
                  onOpenRun={(id) => {
                    nav({ orchestrate: { tab: "sessions", run: id, sessionProject: null, sessionEpic: null } });
                  }}
                />
                <div className="flex min-h-0 flex-1">
                  <div className="min-w-0 flex-1">
                    <Board
                      project={current.project}
                      selectedTaskId={taskId}
                      onProjectChange={(project: Project) => updateProject(current.path, project)}
                      onSelectTask={setTaskId}
                    />
                  </div>
                  {selectedTask ? (
                    <TaskDetail
                      project={current.project}
                      projectPath={current.path}
                      task={selectedTask}
                      onProjectChange={(project: Project) => updateProject(current.path, project)}
                      onClose={() => setTaskId(null)}
                      onOpenRun={(id) => {
                        nav({ orchestrate: { tab: "sessions", run: id, sessionProject: null, sessionEpic: null } });
                      }}
                    />
                  ) : null}
                </div>
              </div>
            )
          ) : (
            <EmptyState
              icon={KanbanSquare}
              title="No projects yet"
              action={
                <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> New project
                </Button>
              }
            >
              Boards live in <code className="text-ink">.crystal/projects/</code> and version
              with your code.
            </EmptyState>
          )
        ) : tab === "sessions" ? (
          <SessionsTab
            selectedRunId={runId}
            onSelectRun={setRunId}
            projectFilter={sessionProject}
            epicFilter={sessionEpic}
            onScopeChange={setSessionScope}
          />
        ) : tab === "workflows" ? (
          <WorkflowsTab
            selectedWorkflowId={workflowId}
            onSelectWorkflow={setWorkflowId}
            builderOpen={builderOpen}
            onToggleBuilder={setBuilderOpen}
            selectedTemplateId={templateId}
            onSelectTemplate={setTemplateId}
            onOpenRun={(id) => {
              nav({ orchestrate: { tab: "sessions", run: id, sessionProject: null, sessionEpic: null } });
            }}
            onOpenTask={(id) => {
              setTaskId(id);
              setTab("board");
            }}
          />
        ) : tab === "agents" ? (
          <AgentsTab selectedRunId={runId} onSelectRun={setRunId} />
        ) : tab === "costs" ? (
          <CostsTab project={current?.project ?? null} axis={costBy} onAxisChange={setCostBy} />
        ) : tab === "insights" ? (
          <InsightsTab period={period} onPeriodChange={setPeriod} />
        ) : (
          <RunsPane
            runs={filteredRuns}
            selectedRunId={runId}
            onSelect={setRunId}
            attention={attention}
            emptyHint={
              purposeFilter
                ? `No ${purposeFilter} runs.`
                : "No runs yet. Start one from a task on the board."
            }
            listHeader={
              presentPurposes.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2">
                  <PurposeChip
                    label="All"
                    active={purposeFilter === null}
                    onClick={() => setPurposeFilter(null)}
                  />
                  {presentPurposes.map((p) => (
                    <PurposeChip
                      key={p}
                      label={p}
                      active={purposeFilter === p}
                      onClick={() => setPurposeFilter(purposeFilter === p ? null : p)}
                    />
                  ))}
                </div>
              ) : null
            }
          />
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent title="New project" description="A kanban board saved to .crystal/projects/">
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
              placeholder="e.g. Q3 platform work"
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

/** One purpose filter chip on the Runs tab (All · manage · develop · …). */
function PurposeChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
        active
          ? "border-crystal-500/40 bg-crystal-500/15 text-crystal-200"
          : "border-edge text-ink-muted hover:border-edge-strong hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-surface-3 text-ink" : "text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

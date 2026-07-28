import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  Coins,
  KanbanSquare,
  ListTodo,
  Network,
  Plus,
  Sparkles,
} from "lucide-react";
import {
  RUN_PURPOSES,
  openQuestions,
  type OrchestratorTabId,
  type Project,
  type RunPurpose,
} from "@crystal/core";
import { useAgents, useNav, useNavUpdate, useWorkspace } from "@crystal/client";
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
  cn,
} from "@crystal/ui";
import { AgentsTab } from "./AgentsTab.js";
import { Board } from "./Board.js";
import { CostsTab } from "./CostsTab.js";
import { QuestionsStrip } from "./QuestionsStrip.js";
import { RunsPane } from "./RunsPane.js";
import { TaskDetail } from "./TaskDetail.js";
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
  const runId = useNav((l) => l.orchestrate?.run) ?? null;
  const setRunId = useCallback(
    (id: string | null) => nav({ orchestrate: { run: id } }),
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
  const runningCount = runs.filter((r) => r.status === "running").length;
  const waitingCount = current
    ? current.project.tasks.reduce((n, t) => n + openQuestions(t).length, 0)
    : 0;

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
      <header className="flex items-center gap-2 border-b border-edge bg-surface-1 px-3 py-1.5">
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

        <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          <TabButton active={tab === "board"} onClick={() => setTab("board")}>
            <ListTodo className="h-3.5 w-3.5" /> Board
            {waitingCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn">
                {waitingCount}
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
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {tab === "board" ? (
          current ? (
            <div className="flex h-full min-h-0 flex-col">
              <QuestionsStrip
                project={current.project}
                projectPath={current.path}
                onProjectChange={(project: Project) => updateProject(current.path, project)}
                onOpenTask={setTaskId}
                onOpenRun={(id) => {
                  setRunId(id);
                  setTab("runs");
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
                      setRunId(id);
                      setTab("runs");
                    }}
                  />
                ) : null}
              </div>
            </div>
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
        ) : tab === "workflows" ? (
          <WorkflowsTab
            selectedWorkflowId={workflowId}
            onSelectWorkflow={setWorkflowId}
            builderOpen={builderOpen}
            onToggleBuilder={setBuilderOpen}
            selectedTemplateId={templateId}
            onSelectTemplate={setTemplateId}
            onOpenRun={(id) => {
              setRunId(id);
              setTab("runs");
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
        ) : (
          <RunsPane
            runs={filteredRuns}
            selectedRunId={runId}
            onSelect={setRunId}
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

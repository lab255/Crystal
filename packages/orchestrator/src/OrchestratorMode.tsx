import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, KanbanSquare, ListTodo, Network, Plus, Sparkles } from "lucide-react";
import type { OrchestratorTabId, Project } from "@crystal/core";
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
import { RunList } from "./RunList.js";
import { RunView } from "./RunView.js";
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
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const current = projects.find((p) => p.path === projectPath) ?? projects[0] ?? null;
  useEffect(() => {
    if (current && current.path !== projectPath) setProjectPath(current.path);
  }, [current?.path]);

  const selectedTask = current?.project.tasks.find((t) => t.id === taskId) ?? null;
  const selectedRun = runs.find((r) => r.id === runId) ?? null;
  const runningCount = runs.filter((r) => r.status === "running").length;

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
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {tab === "board" ? (
          current ? (
            <div className="flex h-full min-h-0">
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
        ) : (
          <div className="flex h-full min-h-0">
            <RunList
              runs={runs}
              selectedRunId={runId}
              onSelect={setRunId}
              emptyHint="No runs yet. Start one from a task on the board."
            />
            <main className="min-w-0 flex-1">
              {selectedRun ? (
                <RunView run={selectedRun} />
              ) : (
                <EmptyState icon={Bot} title="Select a run">
                  Live output streams here while Claude Code works — tool calls, edits,
                  costs, results.
                </EmptyState>
              )}
            </main>
          </div>
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

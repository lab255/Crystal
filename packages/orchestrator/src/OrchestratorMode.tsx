import { useCallback, useEffect, useState } from "react";
import { Bot, ChevronDown, KanbanSquare, ListTodo, Plus } from "lucide-react";
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
  StatusDot,
  cn,
} from "@crystal/ui";
import { Board } from "./Board.js";
import { RunView } from "./RunView.js";
import { TaskDetail } from "./TaskDetail.js";
import { formatCost } from "./prompt.js";

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
          <TabButton active={tab === "runs"} onClick={() => setTab("runs")}>
            <Bot className="h-3.5 w-3.5" /> Runs
            {runningCount > 0 ? (
              <span className="ml-0.5 rounded-full bg-info/20 px-1.5 text-[10px] text-info">
                {runningCount}
              </span>
            ) : null}
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
        ) : (
          <div className="flex h-full min-h-0">
            <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface-1">
              <div className="px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Agent runs
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1.5 pb-2">
                {runs.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-ink-faint">
                    No runs yet. Start one from a task on the board.
                  </div>
                ) : (
                  runs.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setRunId(run.id)}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                        selectedRun?.id === run.id
                          ? "bg-crystal-500/15"
                          : "hover:bg-surface-2",
                      )}
                    >
                      <StatusDot status={run.status} className="mt-1" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-ink">
                          {run.prompt.split("\n")[0]}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-ink-faint">
                          {new Date(run.createdAt).toLocaleString()} · {formatCost(run.costUsd)}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>
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

import { useState } from "react";
import { KanbanSquare, Plus, X } from "lucide-react";
import {
  createTask,
  createTodoItem,
  matchAgent,
  nextLight,
  nowIso,
  sortTodos,
  type Project,
  type TodoItem,
} from "@crystal/core";
import { useCrystal, useFleet, wsKey } from "@crystal/client";
import { TrafficLightDot, cn } from "@crystal/ui";

/**
 * A workspace card's todo list: each item carries a traffic light (click the
 * dot to cycle gray → green → yellow → red), a title, and an optional context
 * note — enough to re-orient when hopping back into this codebase. Fleet-
 * aware: `sid` names the card's bridge connection, todos live under the
 * compound key, and requests go over that server's own client.
 */
export function TodoSection({ sid, ws, todos }: { sid: string; ws: string; todos: TodoItem[] }) {
  const setTodos = useFleet((s) => s.setTodos);
  const { fleet, activeSid, workspaceStore, workspacesStore } = useCrystal();
  const [draft, setDraft] = useState("");

  const key = wsKey(sid, ws);
  const update = (id: string, patch: Partial<TodoItem>) => {
    setTodos(
      key,
      todos.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t)),
    );
  };
  const remove = (id: string) =>
    setTodos(
      key,
      todos.filter((t) => t.id !== id),
    );
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setTodos(key, [...todos, createTodoItem(text)]);
    setDraft("");
  };

  /**
   * Promote a todo to a board task instead of acting on it directly: the task
   * lands in the workspace's first project, owned by the tag-matched agent
   * (or the default generic one) and the roster's default human, and the todo
   * is marked done. Dispatch happens later, from the board.
   */
  const promote = async (t: TodoItem) => {
    const client = fleet.clientOf(sid);
    if (!client) return; // connection removed under us
    const { roster } = await client.request("agents.get", { ws });
    const labels = ["source:todo"];
    const makeTask = (project: Project) => {
      const task = createTask(t.text);
      task.description = t.note;
      task.labels = labels;
      task.owners = {
        agentId: matchAgent(labels, roster)?.id ?? null,
        human: roster.defaultHuman || null,
      };
      task.order =
        Math.max(0, ...project.tasks.filter((x) => x.status === "backlog").map((x) => x.order)) + 1;
      return task;
    };
    // The active workspace's board lives in the workspace store — go through
    // it so a pending debounced save can't clobber the new task. Any other
    // workspace (or server) saves directly over its bridge with an explicit `ws`.
    const isActive = sid === activeSid && workspacesStore.getState().activeId === ws;
    const activeInfo = isActive ? workspaceStore.getState().info : null;
    if (activeInfo) {
      const entry = activeInfo.projects[0];
      if (!entry) return;
      workspaceStore.getState().updateProject(entry.path, {
        ...entry.project,
        tasks: [...entry.project.tasks, makeTask(entry.project)],
      });
    } else {
      const info = await client.request("workspace.get", { ws });
      const entry = info.projects[0];
      if (!entry) return;
      await client.request("project.save", {
        ws,
        path: entry.path,
        project: { ...entry.project, tasks: [...entry.project.tasks, makeTask(entry.project)] },
      });
    }
    update(t.id, { done: true });
  };

  return (
    <div className="space-y-0.5">
      {sortTodos(todos).map((t) => (
        <div
          key={t.id}
          className={cn(
            "group/todo rounded px-1.5 py-1 hover:bg-surface-2 focus-within:bg-surface-2",
            t.done && "opacity-50",
          )}
        >
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={t.done}
              onChange={(e) => update(t.id, { done: e.target.checked })}
              aria-label={t.done ? "Reopen todo" : "Mark todo done"}
              className="h-3 w-3 shrink-0 accent-crystal-500"
            />
            <button
              type="button"
              onClick={() => update(t.id, { light: nextLight(t.light) })}
              aria-label={`Status: ${t.light} — click to change`}
              className="flex shrink-0 items-center rounded p-0.5 hover:bg-surface-3"
            >
              <TrafficLightDot light={t.light} />
            </button>
            <input
              value={t.text}
              onChange={(e) => update(t.id, { text: e.target.value })}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-xs text-ink outline-none",
                t.done && "line-through",
              )}
            />
            {!t.done ? (
              <button
                type="button"
                onClick={() => void promote(t)}
                aria-label="Promote to a board task"
                title="Promote to a board task (assigned to an agent + human)"
                className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-crystal-300 group-hover/todo:opacity-100"
              >
                <KanbanSquare className="h-3 w-3" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => remove(t.id)}
              aria-label="Delete todo"
              className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 hover:text-danger group-hover/todo:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <input
            value={t.note}
            onChange={(e) => update(t.id, { note: e.target.value })}
            placeholder="context note…"
            className={cn(
              "ml-9 mt-0.5 w-[calc(100%-2.5rem)] bg-transparent text-[10px] text-ink-muted outline-none placeholder:text-ink-faint",
              // The note is where "where was I?" lives — show it when set,
              // reveal the empty input while the row is being edited.
              !t.note && "hidden group-focus-within/todo:block group-hover/todo:block",
            )}
          />
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="flex items-center gap-2 px-1.5 pt-1"
      >
        <Plus className="h-3 w-3 shrink-0 text-ink-faint" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a todo…"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
      </form>
    </div>
  );
}

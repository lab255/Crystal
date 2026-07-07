import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  createTodoItem,
  nextLight,
  nowIso,
  sortTodos,
  type TodoItem,
} from "@crystal/core";
import { useFleet } from "@crystal/client";
import { TrafficLightDot, cn } from "@crystal/ui";

/**
 * A workspace card's todo list: each item carries a traffic light (click the
 * dot to cycle gray → green → yellow → red), a title, and an optional context
 * note — enough to re-orient when hopping back into this codebase.
 */
export function TodoSection({ ws, todos }: { ws: string; todos: TodoItem[] }) {
  const setTodos = useFleet((s) => s.setTodos);
  const [draft, setDraft] = useState("");

  const update = (id: string, patch: Partial<TodoItem>) => {
    setTodos(
      ws,
      todos.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: nowIso() } : t)),
    );
  };
  const remove = (id: string) =>
    setTodos(
      ws,
      todos.filter((t) => t.id !== id),
    );
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setTodos(ws, [...todos, createTodoItem(text)]);
    setDraft("");
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

import { z } from "zod";
import { nowIso, uid } from "./ids.js";
import type { AgentRunStatus } from "./agent.js";

/**
 * Per-workspace todo list — `.crystal/todos.json`.
 *
 * Todos are the "context notes" of a workspace: short reminders of where work
 * stands so an engineer hopping between codebases (each with agents running)
 * can re-orient at a glance. Every item carries a traffic light, and the
 * workspace itself rolls up to one light combining open todos with agent-run
 * attention (see `workspaceLight`).
 *
 * Traffic lights: green = all good, yellow = needs attention, red = needs
 * urgent attention, gray = idle.
 */

/** Ascending urgency — index order doubles as severity rank. */
export const TRAFFIC_LIGHTS = ["gray", "green", "yellow", "red"] as const;
export const TrafficLightSchema = z.enum(TRAFFIC_LIGHTS);
export type TrafficLight = z.infer<typeof TrafficLightSchema>;

export const TRAFFIC_LIGHT_LABELS: Record<TrafficLight, string> = {
  gray: "Idle",
  green: "On track",
  yellow: "Needs attention",
  red: "Urgent",
};

const SEVERITY: Record<TrafficLight, number> = { gray: 0, green: 1, yellow: 2, red: 3 };

/** The most urgent of a set of lights (gray when empty). */
export function worstLight(lights: Iterable<TrafficLight>): TrafficLight {
  let worst: TrafficLight = "gray";
  for (const light of lights) if (SEVERITY[light] > SEVERITY[worst]) worst = light;
  return worst;
}

/** Next light when cycling through in the UI (gray → green → yellow → red → gray). */
export function nextLight(light: TrafficLight): TrafficLight {
  return TRAFFIC_LIGHTS[(TRAFFIC_LIGHTS.indexOf(light) + 1) % TRAFFIC_LIGHTS.length]!;
}

export const TodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** Free-form context — where you left off, a link, the next step. */
  note: z.string().default(""),
  light: TrafficLightSchema.default("gray"),
  done: z.boolean().default(false),
  /** Manual sort order among open items. */
  order: z.number().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoListSchema = z.object({
  items: z.array(TodoItemSchema).default([]),
});
export type TodoList = z.infer<typeof TodoListSchema>;

export function createTodoList(): TodoList {
  return { items: [] };
}

export function createTodoItem(text: string, light: TrafficLight = "gray"): TodoItem {
  const ts = nowIso();
  return TodoItemSchema.parse({ id: uid("todo"), text, light, createdAt: ts, updatedAt: ts });
}

/** Open items first (most urgent light, then manual order, then recency); done items last. */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return (
      SEVERITY[b.light] - SEVERITY[a.light] ||
      a.order - b.order ||
      b.updatedAt.localeCompare(a.updatedAt)
    );
  });
}

/** Rollup of a todo list: the most urgent light among open items (gray when none). */
export function todosLight(items: TodoItem[]): TrafficLight {
  return worstLight(items.filter((t) => !t.done).map((t) => t.light));
}

/**
 * Attention derived from agent runs: anything still executing keeps the
 * workspace green (work in flight, all good); a run that finished after the
 * user last looked (`seenAt`) demands attention — yellow for a result to
 * review, red for a failure. Cancellations were user-initiated, so they never
 * raise the light.
 */
export function runsLight(
  runs: { status: AgentRunStatus; endedAt?: string | null }[],
  seenAt: string | null,
): TrafficLight {
  const lights: TrafficLight[] = [];
  for (const run of runs) {
    if (run.status === "running" || run.status === "queued") lights.push("green");
    else if (run.status === "cancelled") continue;
    else if (run.endedAt && (!seenAt || run.endedAt > seenAt)) {
      lights.push(run.status === "failed" ? "red" : "yellow");
    }
  }
  return worstLight(lights);
}

/**
 * Attention from agents waiting on the human: any open board question is
 * yellow — the agent filed a decision it can't make and someone has to
 * answer, which is exactly "needs attention". Never red on its own (nothing
 * is broken) and never acknowledgeable-away like run results — it clears
 * only by answering.
 */
export function questionsLight(openQuestions: number): TrafficLight {
  return openQuestions > 0 ? "yellow" : "gray";
}

/** Overall workspace light: todos + run attention + open questions, worst wins. */
export function workspaceLight(
  todos: TodoItem[],
  runs: { status: AgentRunStatus; endedAt?: string | null }[],
  seenAt: string | null,
  openQuestions = 0,
): TrafficLight {
  return worstLight([todosLight(todos), runsLight(runs, seenAt), questionsLight(openQuestions)]);
}

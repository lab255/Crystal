import { z } from "zod";
import { uid } from "./ids.js";

/**
 * Standing tasks — scheduled agent work ("nightly: bump deps and run the
 * suite", "hourly: triage new TODOs onto the board"). Borrowed from qm's cron
 * layer, sized for a local bridge server: definitions are repo-durable
 * (`.crystal/standing-tasks.json`), the sweeper lives in the server, and
 * every fire is a FRESH session — the fire history is simply the run list
 * filtered by the `standing:<id>` tag, so there is no separate log to keep.
 */

export const StandingScheduleSchema = z.union([
  /** Every N minutes (≥ 5 — anything tighter belongs in a watch). */
  z.object({ kind: z.literal("every"), minutes: z.number().int().min(5) }),
  /** Once a day at a local time. */
  z.object({
    kind: z.literal("daily"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);
export type StandingSchedule = z.infer<typeof StandingScheduleSchema>;

export const StandingTaskSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** What each fire should do (becomes the agent prompt's core). */
  instructions: z.string().min(1),
  schedule: StandingScheduleSchema,
  /** Working directory relative to the workspace root. */
  cwd: z.string().default("."),
  /** Run fires in a disposable worktree (safe default for writing tasks). */
  isolation: z.enum(["none", "worktree"]).default("none"),
  enabled: z.boolean().default(true),
});
export type StandingTask = z.infer<typeof StandingTaskSchema>;

export const StandingTasksFileSchema = z.object({
  tasks: z.array(StandingTaskSchema).default([]),
});
export type StandingTasksFile = z.infer<typeof StandingTasksFileSchema>;

export function createStandingTasksFile(): StandingTasksFile {
  return { tasks: [] };
}

export function createStandingTask(init: {
  name: string;
  instructions: string;
  schedule: StandingSchedule;
  cwd?: string;
  isolation?: "none" | "worktree";
}): StandingTask {
  return StandingTaskSchema.parse({
    id: uid("standing"),
    name: init.name,
    instructions: init.instructions,
    schedule: init.schedule,
    cwd: init.cwd ?? ".",
    isolation: init.isolation ?? "none",
  });
}

/** A definition plus its live scheduling state, as served over the bridge. */
export interface StandingTaskInfo {
  def: StandingTask;
  lastFiredAt: string | null;
  /** When the next fire is due (null while disabled). */
  nextFireAt: string | null;
  /** The currently-live fired run, if one is still working. */
  liveRunId: string | null;
}

/** Run tag carrying a fire's attribution (fire history = runs with this tag). */
export function standingTag(taskId: string): string {
  return `standing:${taskId}`;
}

/**
 * When the task should next fire. Interval tasks: `lastFiredAt + N minutes`
 * (never fired → due now). Daily tasks: the scheduled time today if it is
 * still ahead OR hasn't fired since it passed (missed fires — a server that
 * was off at 03:00 catches up on boot); otherwise tomorrow's slot.
 */
export function nextFireAt(
  schedule: StandingSchedule,
  lastFiredAt: string | null,
  now = new Date(),
): Date {
  if (schedule.kind === "every") {
    if (!lastFiredAt) return now;
    return new Date(Date.parse(lastFiredAt) + schedule.minutes * 60_000);
  }
  const todaySlot = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    schedule.hour,
    schedule.minute,
  );
  const last = lastFiredAt ? Date.parse(lastFiredAt) : null;
  if (todaySlot.getTime() <= now.getTime()) {
    // Today's slot has passed — due immediately unless it already fired
    // at-or-after the slot.
    if (last == null || last < todaySlot.getTime()) return todaySlot;
    const tomorrowSlot = new Date(todaySlot);
    tomorrowSlot.setDate(tomorrowSlot.getDate() + 1);
    return tomorrowSlot;
  }
  return todaySlot;
}

/** "every 30m" / "daily at 03:00" — the schedule's display form. */
export function formatSchedule(schedule: StandingSchedule): string {
  if (schedule.kind === "every") {
    return schedule.minutes % 60 === 0
      ? `every ${schedule.minutes / 60}h`
      : `every ${schedule.minutes}m`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `daily at ${pad(schedule.hour)}:${pad(schedule.minute)}`;
}

/**
 * The prompt for one fire — qm's fresh-thread preamble: every fire is a new
 * session with no memory of earlier ones, and must say so to the agent.
 */
export function buildStandingFirePrompt(task: StandingTask): string {
  return [
    `[Standing task: ${task.name}] This is a scheduled, automated fire (${formatSchedule(task.schedule)}).`,
    "",
    task.instructions,
    "",
    "Runtime context: each fire is a FRESH session — you have no memory of " +
      "previous fires; only the repository (and the board, if you have board " +
      "tools) persists between them. Check the current state before acting, " +
      "do the work, and end with a short summary of what changed. If there is " +
      "genuinely nothing to do this time, say so briefly and stop.",
  ].join("\n");
}

import { describe, expect, it } from "vitest";
import {
  buildStandingFirePrompt,
  createStandingTask,
  formatSchedule,
  nextFireAt,
  standingTag,
} from "./standing-task.js";

const NOW = new Date(2026, 7, 2, 12, 0, 0); // Aug 2, 12:00 local

describe("nextFireAt", () => {
  it("interval: due immediately when never fired, then lastFired + N", () => {
    const schedule = { kind: "every", minutes: 30 } as const;
    expect(nextFireAt(schedule, null, NOW).getTime()).toBe(NOW.getTime());
    const last = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(nextFireAt(schedule, last, NOW).getTime()).toBe(
      Date.parse(last) + 30 * 60_000,
    );
  });

  it("daily: today's slot when still ahead", () => {
    const schedule = { kind: "daily", hour: 15, minute: 30 } as const;
    const next = nextFireAt(schedule, null, NOW);
    expect(next.getHours()).toBe(15);
    expect(next.getDate()).toBe(NOW.getDate());
  });

  it("daily: a passed slot is due immediately (missed-fire catch-up)", () => {
    const schedule = { kind: "daily", hour: 3, minute: 0 } as const;
    // Last fired yesterday; the 03:00 slot passed while the server was off.
    const yesterday = new Date(2026, 7, 1, 3, 0).toISOString();
    const next = nextFireAt(schedule, yesterday, NOW);
    expect(next.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });

  it("daily: already fired today → tomorrow's slot", () => {
    const schedule = { kind: "daily", hour: 3, minute: 0 } as const;
    const thisMorning = new Date(2026, 7, 2, 3, 0, 5).toISOString();
    const next = nextFireAt(schedule, thisMorning, NOW);
    expect(next.getDate()).toBe(3); // Aug 3
    expect(next.getHours()).toBe(3);
  });
});

describe("standing task model", () => {
  it("creates with defaults and formats schedules", () => {
    const task = createStandingTask({
      name: "nightly deps",
      instructions: "Update deps, run the suite.",
      schedule: { kind: "daily", hour: 3, minute: 0 },
    });
    expect(task.enabled).toBe(true);
    expect(formatSchedule(task.schedule)).toBe("daily at 03:00");
    expect(formatSchedule({ kind: "every", minutes: 120 })).toBe("every 2h");
    expect(formatSchedule({ kind: "every", minutes: 45 })).toBe("every 45m");
    expect(standingTag(task.id)).toBe(`standing:${task.id}`);
  });

  it("fire prompt carries the fresh-session preamble and instructions", () => {
    const task = createStandingTask({
      name: "triage",
      instructions: "Sweep TODOs onto the board.",
      schedule: { kind: "every", minutes: 60 },
    });
    const prompt = buildStandingFirePrompt(task);
    expect(prompt).toContain("Sweep TODOs onto the board.");
    expect(prompt).toContain("FRESH session");
    expect(prompt).toContain("every 1h");
  });
});

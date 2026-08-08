import { describe, expect, it } from "vitest";
import { createAgentRun, type AgentRun } from "@crystal/core";
import { managerSessionEnded } from "./workflow-manager.js";

function turn(
  id: string,
  status: AgentRun["status"],
  createdAt: string,
  sessionId: string | null = null,
): AgentRun {
  const run = createAgentRun({ prompt: id });
  return { ...run, id, status, createdAt, sessionId };
}

describe("managerSessionEnded", () => {
  it("flags a running workflow whose latest manager chain failed before getting a session", () => {
    const older = turn("older", "completed", "2026-08-08T00:00:00.000Z", "session-1");
    const dead = turn("dead", "failed", "2026-08-09T00:00:00.000Z");
    expect(managerSessionEnded("running", [older, dead])).toBe(true);
  });

  it("does not flag a resumable, live, or non-running manager chain", () => {
    const resumable = turn("resumable", "failed", "2026-08-09T00:00:00.000Z", "session-1");
    const oldDead = turn("dead", "cancelled", "2026-08-08T00:00:00.000Z");
    const live = turn("live", "running", "2026-08-09T00:00:00.000Z");
    expect(managerSessionEnded("running", [resumable])).toBe(false);
    expect(managerSessionEnded("running", [oldDead, live])).toBe(false);
    expect(managerSessionEnded("paused", [oldDead])).toBe(false);
  });
});

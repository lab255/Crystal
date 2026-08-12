import { describe, expect, it } from "vitest";
import { canResumeSession, sameSessionScope } from "./sessions-tab-state.js";

describe("canResumeSession", () => {
  const resumable = {
    status: "completed" as const,
    sessionId: "session-1",
    terminalId: "terminal-1",
  };

  it("allows a settled session whose terminal is gone", () => {
    expect(canResumeSession(true, resumable, true)).toBe(true);
  });

  it("rejects a cancelled session even when it otherwise looks resumable", () => {
    expect(canResumeSession(true, { ...resumable, status: "cancelled" }, true)).toBe(false);
  });
});

describe("sameSessionScope", () => {
  it("distinguishes project and epic scope changes", () => {
    const scope = { projectId: "project-1", epicId: "epic-1" };

    expect(sameSessionScope(scope, { ...scope })).toBe(true);
    expect(sameSessionScope(scope, { ...scope, projectId: "project-2" })).toBe(false);
    expect(sameSessionScope(scope, { ...scope, epicId: "epic-2" })).toBe(false);
  });
});

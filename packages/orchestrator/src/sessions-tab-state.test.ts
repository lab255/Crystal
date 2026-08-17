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

  it("offers a settled HEADLESS session a path into a TUI", () => {
    expect(canResumeSession(true, { ...resumable, terminalId: null }, false)).toBe(true);
  });

  it("hides the affordance while the interactive terminal is still listed", () => {
    expect(canResumeSession(true, resumable, false)).toBe(false);
  });

  it("never offers resume while the subtree is working or without a session", () => {
    expect(canResumeSession(false, { ...resumable, terminalId: null }, false)).toBe(false);
    expect(canResumeSession(true, { ...resumable, sessionId: null }, true)).toBe(false);
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

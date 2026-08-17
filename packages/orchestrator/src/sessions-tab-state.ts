import type { AgentRun } from "@crystal/core";
import type { NewSessionScope } from "./SessionGroupList.js";

type ResumeRun = Pick<AgentRun, "status" | "sessionId" | "terminalId">;

/**
 * "Resume interactively" is offered for any settled, resumable chain:
 * an ex-interactive session whose terminal is confirmed gone (the embedded
 * console would otherwise show a dead end), or a HEADLESS session — its
 * pinned sessionId lets `agent.interactive {resumeRunId}` lift the same
 * conversation into a TUI. A still-listed terminal keeps the affordance
 * hidden: the live/scrollback console is already embedded.
 */
export function canResumeSession(
  settledSession: boolean,
  run: ResumeRun | null,
  terminalGone: boolean,
): boolean {
  return Boolean(
    settledSession &&
      run?.status !== "cancelled" &&
      run?.sessionId &&
      (run.terminalId == null || terminalGone),
  );
}

export function sameSessionScope(a: NewSessionScope, b: NewSessionScope): boolean {
  return a.projectId === b.projectId && a.epicId === b.epicId;
}

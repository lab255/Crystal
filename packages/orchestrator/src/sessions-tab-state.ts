import type { AgentRun } from "@crystal/core";
import type { NewSessionScope } from "./SessionGroupList.js";

type ResumeRun = Pick<AgentRun, "status" | "sessionId" | "terminalId">;

export function canResumeSession(
  settledSession: boolean,
  run: ResumeRun | null,
  terminalGone: boolean,
): boolean {
  return Boolean(
    settledSession &&
      run?.status !== "cancelled" &&
      run?.sessionId &&
      run.terminalId &&
      terminalGone,
  );
}

export function sameSessionScope(a: NewSessionScope, b: NewSessionScope): boolean {
  return a.projectId === b.projectId && a.epicId === b.epicId;
}

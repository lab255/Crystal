import { describe, expect, it } from "vitest";
import { createAgentRun, formatWsRef, type DeepLink, type HubQuestion } from "@crystal/core";
import { attentionJump, attentionOnScreen, type AttentionTarget } from "./attention-policy.js";
import type { FleetQuestion } from "./fleet-store.js";

const run = createAgentRun({ prompt: "fix the build", cwd: "/repo" });
const fleetQuestion = {
  question: { id: "q1", text: "Which branch?", runId: run.id },
} as unknown as FleetQuestion;
const hubQuestion = { questionId: "hq1", text: "Ship it?", ws: "other" } as HubQuestion;

const runTarget: AttentionTarget = { kind: "run", sid: "local", ws: "w1", run };
const questionTarget: AttentionTarget = { kind: "question", sid: "local", ws: "w1", question: fleetQuestion };
const programTarget: AttentionTarget = {
  kind: "program-question", sid: "local", programId: "p1", question: hubQuestion,
};
const focused = { focused: true, activeSid: "local", activeWs: "w1" };

describe("attentionOnScreen", () => {
  it("is never true in an unfocused window", () => {
    const link: DeepLink = { mode: "threads", threads: { thread: run.id } };
    expect(attentionOnScreen(link, { ...focused, focused: false }, runTarget)).toBe(false);
  });

  it("matches the in-project thread by exact run id in the active workspace only", () => {
    const link: DeepLink = { mode: "threads", threads: { thread: run.id } };
    expect(attentionOnScreen(link, focused, runTarget)).toBe(true);
    expect(attentionOnScreen(link, focused, questionTarget)).toBe(true);
    expect(attentionOnScreen(link, { ...focused, activeWs: "w2" }, runTarget)).toBe(false);
    expect(attentionOnScreen({ mode: "threads", threads: { thread: "other" } }, focused, runTarget)).toBe(false);
    expect(attentionOnScreen(link, focused, programTarget)).toBe(false);
  });

  it("matches the Overview threads selection by its ws:/program: id", () => {
    const wsLink: DeepLink = {
      mode: "projects",
      projects: { view: "threads", thread: `ws:local/w1/${run.id}` },
    };
    expect(attentionOnScreen(wsLink, focused, runTarget)).toBe(true);
    expect(attentionOnScreen(wsLink, { ...focused, activeWs: "w2" }, runTarget)).toBe(true);
    expect(attentionOnScreen(wsLink, focused, { ...runTarget, ws: "w2" })).toBe(false);
    expect(attentionOnScreen(wsLink, focused, programTarget)).toBe(false);
    const programLink: DeepLink = { mode: "projects", projects: { view: "threads", thread: "program:p1" } };
    expect(attentionOnScreen(programLink, focused, programTarget)).toBe(true);
    expect(attentionOnScreen(programLink, { ...focused, activeSid: "remote" }, programTarget)).toBe(false);
    expect(attentionOnScreen(programLink, focused, runTarget)).toBe(false);
  });

  it("never suppresses on the dashboard, inbox, or other modes, nor workflow pauses", () => {
    expect(attentionOnScreen({ mode: "projects", projects: { thread: `ws:local/w1/${run.id}` } }, focused, runTarget)).toBe(false);
    expect(attentionOnScreen({ mode: "projects", projects: { view: "inbox" } }, focused, programTarget)).toBe(false);
    expect(attentionOnScreen({ mode: "code" }, focused, runTarget)).toBe(false);
    const pause: AttentionTarget = { kind: "workflow", sid: "local", ws: "w1", workflowId: "wf" };
    expect(attentionOnScreen({ mode: "threads" }, focused, pause)).toBe(false);
  });
});

describe("attentionJump", () => {
  it("activates the workspace and opens the in-project thread from any project mode", () => {
    expect(attentionJump("code", runTarget)).toEqual({
      select: { sid: "local", ws: "w1" },
      patch: { ws: formatWsRef("local", "w1"), mode: "threads", threads: { thread: run.id, compose: null } },
    });
    const pause: AttentionTarget = { kind: "workflow", sid: "local", ws: "w1", workflowId: "wf" };
    expect(attentionJump("threads", pause).patch.threads).toEqual({ compose: null });
  });

  it("stays in the Overview when the user is already there", () => {
    expect(attentionJump("projects", runTarget)).toEqual({
      select: null,
      patch: {
        mode: "projects",
        projects: { view: "threads", thread: `ws:local/w1/${run.id}`, program: null, compose: null },
      },
    });
  });

  it("always lands coordinator items on their program thread in the Overview", () => {
    expect(attentionJump("code", programTarget).patch.projects?.thread).toBe("program:p1");
    expect(attentionJump("code", programTarget).select).toBeNull();
  });
});

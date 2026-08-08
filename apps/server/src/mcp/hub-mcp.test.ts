import { describe, expect, it, vi } from "vitest";
import {
  addDelivery,
  createProgram,
  dispatchReportText,
  projectListText,
  type Program,
} from "@crystal/core";
import type { DispatchReport, HubProjectRef } from "../hub-engine.js";
import { McpHubServer, type HubToolHost } from "./hub-mcp.js";

const PROJECTS: HubProjectRef[] = [
  { ws: "ws-auth", root: "/repos/auth-service", name: "auth-service" },
  { ws: "ws-web", root: "/repos/web-console", name: "web-console" },
];

function program(): Program {
  const base = createProgram({ name: "SSO", goal: "Single sign-on." });
  return addDelivery(base, { projectRoot: "/repos/auth-service", brief: "Issue tokens." }).program;
}

/** A recording HubToolHost; every method is a spy with a sane default. */
function fakeHost(over: Partial<HubToolHost> = {}) {
  const prog = program();
  const host: HubToolHost = {
    listProjects: vi.fn(async () => ({
      open: PROJECTS,
      recent: [{ root: "/repos/old", name: "old", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
    })),
    resolveProject: vi.fn(async (ref: string) => {
      const hit = PROJECTS.find((p) => p.ws === ref || p.root === ref);
      if (!hit) throw new Error(`Not a directory: ${ref}`);
      return hit;
    }),
    projectBoard: vi.fn(async (ws: string) => `board of ${ws}`),
    createProgram: vi.fn(async () => prog),
    addDelivery: vi.fn(async () => prog.deliveries[0]!),
    removeDelivery: vi.fn(async () => {}),
    retryDelivery: vi.fn(async () => prog),
    dispatch: vi.fn(
      async (): Promise<DispatchReport> => ({
        dispatched: [
          {
            deliveryId: prog.deliveries[0]!.id,
            projectName: "auth-service",
            ws: "ws-auth",
            workflowId: "wf_1",
          },
        ],
        skipped: [],
      }),
    ),
    dispatchEpic: vi.fn(async () => ({
      program: prog,
      report: { dispatched: [], skipped: [] } as DispatchReport,
    })),
    status: vi.fn(async (id: string | null) => (id ? `status of ${id}` : "the portfolio")),
    answerQuestion: vi.fn(async (_p: string, questionId: string) =>
      questionId === "q_gone"
        ? { ok: false as const, reason: "Unknown (or already answered) question: q_gone" }
        : { ok: true as const, resumedRunId: "run_9" },
    ),
    messageDelivery: vi.fn(async () => ({
      queued: true,
      mode: "queued" as const,
      wakeExpected: true,
    })),
    closeDelivery: vi.fn(async () => prog),
    compactDelivery: vi.fn(async () => {}),
    setProgramBudget: vi.fn(async () => prog),
    setDeliveryBudget: vi.fn(async () => prog),
    setPaused: vi.fn(async () => ({ ...prog, status: "paused" as const })),
    cancel: vi.fn(async () => ({ ...prog, status: "cancelled" as const })),
    complete: vi.fn(async () => ({ ...prog, status: "completed" as const })),
    programIdForDelivery: vi.fn(async () => prog.id),
    ...over,
  };
  return { host, prog };
}

/** Call one tool and return its text (throws on a protocol-level error). */
async function call(
  server: McpHubServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const reply = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (reply?.error) throw new Error(reply.error.message);
  const result = reply!.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]!.text, isError: result.isError === true };
}

describe("McpHubServer protocol", () => {
  it("answers initialize, ping and notifications", async () => {
    const { host } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const init = await server.handle({ jsonrpc: "2.0", id: 0, method: "initialize" });
    expect((init!.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
  });

  it("lists the cross-project toolset, minus create_program for a bound manager", async () => {
    const { host, prog } = fakeHost();
    const open = await new McpHubServer({ hub: host }).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const openNames = (open!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(openNames).toContain("dispatch_epic");
    expect(openNames).toContain("create_program");
    expect(openNames).toContain("list_projects");

    const bound = await new McpHubServer({ hub: host, boundProgramId: prog.id }).handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const boundNames = (bound!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(boundNames).not.toContain("create_program");
    expect(boundNames).not.toContain("dispatch_epic");
    expect(boundNames).toContain("dispatch_program");
  });

  it("rejects an unknown tool and invalid arguments", async () => {
    const { host } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const unknown = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(unknown!.error?.code).toBe(-32601);

    const bad = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "dispatch_epic", arguments: { project: "ws-auth" } },
    });
    expect(bad!.error?.code).toBe(-32602);
    expect(bad!.error?.message).toMatch(/goal/);
  });
});

describe("dispatching work into projects", () => {
  it("dispatch_epic resolves the project and reports where the work went", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const { text, isError } = await call(server, "dispatch_epic", {
      project: "ws-auth",
      goal: "Ship OIDC.\nSecond line.",
      budgetUsd: 25,
    });
    expect(isError).toBe(false);
    expect(host.dispatchEpic).toHaveBeenCalledWith({
      projectRoot: "/repos/auth-service",
      name: "Ship OIDC.", // defaults to the goal's first line
      goal: "Ship OIDC.\nSecond line.",
      templateId: undefined,
      budgetUsd: 25,
    });
    expect(text).toContain(prog.id);
    expect(text).toContain("auth-service");
  });

  it("surfaces an unopenable project as a tool error, not a crash", async () => {
    const { host } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const { text, isError } = await call(server, "dispatch_epic", {
      project: "/repos/gone",
      goal: "g",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/Not a directory/);
  });

  it("dispatch_program reports what started and why the rest did not", async () => {
    const { host, prog } = fakeHost({
      dispatch: vi.fn(async () => ({
        dispatched: [
          { deliveryId: "dlv_1", projectName: "auth-service", ws: "ws-auth", workflowId: "wf_1" },
        ],
        skipped: [{ deliveryId: "dlv_2", projectName: "web-console", reason: "Blocked by dlv_1." }],
      })),
    });
    const server = new McpHubServer({ hub: host });
    const { text } = await call(server, "dispatch_program", { programId: prog.id });
    expect(text).toContain("dlv_1 → auth-service (workflow wf_1)");
    expect(text).toContain("Blocked by dlv_1.");
  });

  it("add_delivery resolves the project and passes the dependency chain through", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    await call(server, "add_delivery", {
      programId: prog.id,
      project: "/repos/web-console",
      brief: "Log in with it.",
      dependsOn: ["dlv_1"],
    });
    expect(host.addDelivery).toHaveBeenCalledWith(prog.id, {
      projectRoot: "/repos/web-console",
      projectName: "web-console",
      brief: "Log in with it.",
      dependsOn: ["dlv_1"],
      templateId: undefined,
      budgetUsd: undefined,
    });
  });

  it("infers the program from a delivery id for delivery-scoped tools", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const { text } = await call(server, "message_delivery", {
      deliveryId: "dlv_7",
      text: "the schema changed",
    });
    expect(host.programIdForDelivery).toHaveBeenCalledWith("dlv_7");
    // Steers queue by default — waking is the explicit, paid opt-in.
    expect(host.messageDelivery).toHaveBeenCalledWith(prog.id, "dlv_7", "the schema changed", {
      wake: false,
    });
    expect(text).toMatch(/Queued/); // the fake reports it parked for the next wake
  });

  it("never answers a notification, but still performs it", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    // No `id` — the client has nothing to match a reply against, so a reply is
    // an unsolicited frame. The call itself must still happen.
    const reply = await server.handle({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "message_delivery", arguments: { deliveryId: "dlv_7", text: "hi" } },
    });
    expect(reply).toBeNull();
    expect(host.messageDelivery).toHaveBeenCalledWith(prog.id, "dlv_7", "hi", { wake: false });
    // …and an unknown method notification is silence, not an error frame.
    expect(await server.handle({ jsonrpc: "2.0", method: "nonsense" })).toBeNull();
  });

  it("wake: true forces the paid resume and the receipt says so", async () => {
    const { host, prog } = fakeHost({
      messageDelivery: vi.fn(async () => ({
        queued: false,
        mode: "resumed" as const,
        wakeExpected: true,
      })),
    });
    const server = new McpHubServer({ hub: host });
    const { text } = await call(server, "message_delivery", {
      deliveryId: "dlv_7",
      text: "act before the next settle",
      wake: true,
    });
    expect(host.messageDelivery).toHaveBeenCalledWith(
      prog.id,
      "dlv_7",
      "act before the next settle",
      { wake: true },
    );
    expect(text).toMatch(/paid full-context resume/);
  });

  it("a queued steer with nothing live warns that no natural wake is coming", async () => {
    const { host } = fakeHost({
      messageDelivery: vi.fn(async () => ({
        queued: true,
        mode: "queued" as const,
        wakeExpected: false,
      })),
    });
    const server = new McpHubServer({ hub: host });
    const { text } = await call(server, "message_delivery", { deliveryId: "dlv_7", text: "hi" });
    expect(text).toMatch(/NOTHING IS LIVE/);
    expect(text).toMatch(/wake: true/);
  });

  it("closes a delivery externally and compacts an orchestrator", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const closed = await call(server, "close_delivery", {
      deliveryId: "dlv_7",
      outcome: "completed",
      note: "Done by hand on main.",
    });
    expect(host.closeDelivery).toHaveBeenCalledWith(
      prog.id,
      "dlv_7",
      "completed",
      "Done by hand on main.",
    );
    expect(closed.text).toMatch(/closed as completed/);

    const compacted = await call(server, "compact_delivery", { deliveryId: "dlv_7" });
    expect(host.compactDelivery).toHaveBeenCalledWith(prog.id, "dlv_7");
    expect(compacted.text).toMatch(/fresh session/);

    // A refused compact (live runs) is a tool error, not a protocol failure.
    const busy = fakeHost({
      compactDelivery: vi.fn(async () => {
        throw new Error("Workflow has 2 live run(s) — compact between waves, after everything settles.");
      }),
    });
    const busyServer = new McpHubServer({ hub: busy.host });
    const refused = await call(busyServer, "compact_delivery", { deliveryId: "dlv_7" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/live run/);
  });

  it("retries a delivery, inferring its program too", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const { text, isError } = await call(server, "retry_delivery", { deliveryId: "dlv_7" });
    expect(isError).toBe(false);
    expect(host.retryDelivery).toHaveBeenCalledWith(prog.id, "dlv_7");
    expect(text).toMatch(/pending again/);
  });
});

describe("program scoping", () => {
  it("an unbound endpoint needs a programId and defaults status to the portfolio", async () => {
    const { host } = fakeHost();
    const server = new McpHubServer({ hub: host });
    expect((await call(server, "dispatch_program")).text).toMatch(/programId is required/);
    expect((await call(server, "program_status")).text).toBe("the portfolio");
  });

  it("a bound manager acts only on its own program", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host, boundProgramId: prog.id });

    // programId is implicit…
    expect((await call(server, "program_status")).text).toBe(`status of ${prog.id}`);
    await call(server, "dispatch_program");
    expect(host.dispatch).toHaveBeenCalledWith(prog.id, undefined);

    // …and another program's id is refused rather than silently redirected.
    const other = await call(server, "program_status", { programId: "prog_other" });
    expect(other.text).toBe(`status of ${prog.id}`); // status is always its own
    const cancel = await call(server, "cancel_program", { programId: "prog_other" });
    expect(cancel.isError).toBe(true);
    expect(cancel.text).toMatch(/cannot act on prog_other/);
    expect(host.cancel).not.toHaveBeenCalled();

    const create = await call(server, "create_program", { name: "n", goal: "g" });
    expect(create.isError).toBe(true);
    expect(host.createProgram).not.toHaveBeenCalled();

    const epic = await call(server, "dispatch_epic", { project: "ws-auth", goal: "g" });
    expect(epic.isError).toBe(true);
    expect(host.dispatchEpic).not.toHaveBeenCalled();
  });

  it("answers a project's question and says the asker resumed", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host, boundProgramId: prog.id });
    const { text } = await call(server, "answer_question", {
      questionId: "q_1",
      answer: "Version the payload.",
    });
    expect(host.answerQuestion).toHaveBeenCalledWith(prog.id, "q_1", "Version the payload.");
    expect(text).toMatch(/resumed as run_9/);

    const gone = await call(server, "answer_question", { questionId: "q_gone", answer: "x" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/already answered/);
  });

  it("complete_program records the manager's verdict", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host, boundProgramId: prog.id });
    const { text } = await call(server, "complete_program", {
      outcome: "completed",
      summary: "Both projects shipped.",
    });
    expect(host.complete).toHaveBeenCalledWith(prog.id, "completed", "Both projects shipped.");
    expect(text).toMatch(/marked completed/);
  });

  it("clears a budget with an explicit null", async () => {
    const { host, prog } = fakeHost();
    const server = new McpHubServer({ hub: host });
    const { text } = await call(server, "set_program_budget", {
      programId: prog.id,
      budgetUsd: null,
    });
    expect(host.setProgramBudget).toHaveBeenCalledWith(prog.id, null);
    expect(text).toMatch(/Cleared the budget/);
  });
});

describe("project surface", () => {
  it("lists open and recent projects with the ids a dispatch needs", async () => {
    const { host } = fakeHost();
    const { text } = await call(new McpHubServer({ hub: host }), "list_projects");
    expect(text).toContain("auth-service · ws ws-auth · /repos/auth-service");
    expect(text).toContain("Recently opened");
  });

  it("reads a project's board through its workspace", async () => {
    const { host } = fakeHost();
    const { text } = await call(new McpHubServer({ hub: host }), "project_board", {
      project: "/repos/web-console",
    });
    expect(host.projectBoard).toHaveBeenCalledWith("ws-web");
    expect(text).toContain("board of ws-web");
  });
});

describe("rendering", () => {
  it("says so plainly when there is nothing to dispatch or nothing open", () => {
    expect(dispatchReportText({ dispatched: [], skipped: [] })).toBe("Nothing to dispatch.");
    expect(projectListText([], [])).toBe("No projects are open.");
    expect(projectListText([], [{ root: "/r", name: "r", lastOpenedAt: "x", missing: true }])).toContain(
      "(directory is gone)",
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { createAgentRun, programTag, workflowTag } from "@crystal/core";
import type { BridgeClient } from "./bridge-client.js";
import { messageRun, messageRunAt } from "./message-run.js";

function clientReturning(result: unknown): { client: BridgeClient; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn().mockResolvedValue(result);
  return { client: { request } as unknown as BridgeClient, request };
}

describe("messageRun", () => {
  it("passes the workflow steer receipt through to the composer", async () => {
    const run = createAgentRun({ prompt: "manage", tags: [workflowTag("wf-1")] });
    const { client, request } = clientReturning({
      run: null,
      queued: true,
      mode: "queued",
      wakeExpected: false,
    });

    await expect(messageRun(client, run, "check this")).resolves.toEqual({
      queued: true,
      mode: "queued",
      wakeExpected: false,
    });
    expect(request).toHaveBeenCalledWith("workflow.message", {
      workflowId: "wf-1",
      text: "check this",
    });
  });

  it("passes the hub steer receipt through to the composer", async () => {
    const run = createAgentRun({ prompt: "coordinate", tags: [programTag("program-1")] });
    const { client } = clientReturning({
      run: null,
      queued: true,
      mode: "queued",
      wakeExpected: true,
    });

    await expect(messageRun(client, run, "ship it")).resolves.toEqual({
      queued: true,
      mode: "queued",
      wakeExpected: true,
    });
    expect(client.request).toHaveBeenCalledWith("hub.message", {
      programId: "program-1",
      text: "ship it",
    });
  });

  it("maps the generic agent delivery status and resumed run id", async () => {
    const run = createAgentRun({ prompt: "standalone" });
    run.id = "run-old";
    const { client } = clientReturning({ status: "resumed", runId: "run-new" });

    await expect(messageRun(client, run, "continue")).resolves.toEqual({
      queued: false,
      status: "resumed",
      runId: "run-new",
    });
  });

  it("passes an explicit workspace to scoped routes only", async () => {
    const workflow = createAgentRun({ prompt: "manage", tags: [workflowTag("wf-1")] });
    const { client, request } = clientReturning({ queued: false, mode: "interactive", wakeExpected: false });
    await messageRunAt({ client, ws: "w2" }, workflow, "hello");
    expect(request).toHaveBeenCalledWith("workflow.message", {
      workflowId: "wf-1", text: "hello", ws: "w2",
    });

    const generic = createAgentRun({ prompt: "plain" });
    await messageRunAt({ client, ws: "w2" }, generic, "hello");
    expect(request).toHaveBeenLastCalledWith("agent.message", {
      runId: generic.id, text: "hello", ws: "w2",
    });
  });

  it("never scopes hub messaging", async () => {
    const run = createAgentRun({ prompt: "coordinate", tags: [programTag("p1")] });
    const { client, request } = clientReturning({ queued: true, mode: "queued", wakeExpected: true });
    await messageRunAt({ client, ws: "w2" }, run, "hello");
    expect(request).toHaveBeenCalledWith("hub.message", { programId: "p1", text: "hello" });
  });
});

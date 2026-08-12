import type { BridgeClient } from "@crystal/client";
import { describe, expect, it, vi } from "vitest";
import { spawnSession } from "./spawn-session.js";

describe("spawnSession", () => {
  it("passes the session scope and tags to agent.interactive", async () => {
    const request = vi.fn().mockResolvedValue({});
    const client = { request } as unknown as BridgeClient;

    await spawnSession({
      client,
      ws: "workspace-1",
      cwd: "packages/app",
      repoId: "repo-1",
      prompt: "Continue the epic",
      agentId: "agent-1",
      taskId: "task-1",
      projectId: "project-1",
      tags: ["epic:epic-1", "purpose:implement"],
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("agent.interactive", {
      ws: "workspace-1",
      cwd: "packages/app",
      repoId: "repo-1",
      prompt: "Continue the epic",
      agentId: "agent-1",
      taskId: "task-1",
      projectId: "project-1",
      tags: ["epic:epic-1", "purpose:implement"],
    });
  });
});

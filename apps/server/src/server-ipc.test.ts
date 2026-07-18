import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LineBuffer } from "@crystal/core";
import { startCrystalServer } from "./server.js";

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("ipc pipe transport", () => {
  it("serves bridge RPC over the pipe with no TCP listener", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-ipc-root-"));
    const instDir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-ipc-inst-"));
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\crystal-test-${process.pid}`
        : path.join(root, "test.sock");

    const server = await startCrystalServer({
      root,
      pipe,
      consoleDir: null,
      restorePersisted: false,
      persistFile: null,
      instancesDir: instDir,
    });
    const socket = net.connect(pipe);
    // Register before any await — the connect event must not fire into a gap.
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    try {
      // IPC-only: no TCP bridge port, but the MCP loopback listener is live.
      expect(server.port).toBeNull();
      expect(server.pipe).toBe(pipe);
      expect(server.mcpPort).toBeGreaterThan(0);

      // The instance file advertises the endpoints.
      const instFile = path.join(instDir, `${process.pid}.json`);
      const info = JSON.parse(await fs.readFile(instFile, "utf8"));
      expect(info.pipe).toBe(pipe);
      expect(info.mcpPort).toBe(server.mcpPort);
      expect(info.port).toBeNull();

      await connected;
      socket.setEncoding("utf8");
      const lines = new LineBuffer();
      const frames: Array<{ id?: string; type: string; ok?: boolean; result?: unknown }> = [];
      socket.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) frames.push(JSON.parse(line));
      });

      socket.write(
        JSON.stringify({ id: "r1", type: "req", method: "workspaces.list", params: {} }) + "\n",
      );
      await waitFor(() => frames.some((f) => f.id === "r1"));
      const res = frames.find((f) => f.id === "r1")!;
      expect(res.ok).toBe(true);
      const result = res.result as { workspaces: Array<{ root: string }> };
      expect(result.workspaces).toHaveLength(1);

      // Unknown methods come back as errors, not dropped frames.
      socket.write(JSON.stringify({ id: "r2", type: "req", method: "nope", params: {} }) + "\n");
      await waitFor(() => frames.some((f) => f.id === "r2"));
      expect(frames.find((f) => f.id === "r2")!.ok).toBe(false);
    } finally {
      socket.destroy();
      await server.close();
    }
    // close() withdraws the instance advertisement.
    expect(await fs.readdir(instDir)).toEqual([]);
  }, 20_000);
});

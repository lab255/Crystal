import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceIdFor } from "./paths.js";
import { startCrystalServer } from "./server.js";

async function availablePort(): Promise<number> {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });

describe("TCP MCP bearer auth", () => {
  it("protects project and hub MCP routes while leaving the agent loopback endpoint tokenless", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-mcp-auth-root-"));
    const hubDir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-mcp-auth-hub-"));
    let server: Awaited<ReturnType<typeof startCrystalServer>> | null = null;
    try {
      const port = await availablePort();
      const token = "test-bridge-token";
      server = await startCrystalServer({
        root,
        listen: { host: "127.0.0.1", port },
        token,
        pipe: null,
        consoleDir: null,
        restorePersisted: false,
        persistFile: null,
        instancesDir: null,
        hubDir,
        publishFile: null,
      });
      const projectPath = `/mcp/${workspaceIdFor(root)}/run_test`;
      const post = (base: string, route: string, bearer?: string) =>
        fetch(base + route, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
          body: initialize,
        });
      const tcp = `http://127.0.0.1:${port}`;
      expect((await post(tcp, projectPath)).status).toBe(401);
      expect((await post(tcp, "/mcp/hub")).status).toBe(401);
      // The gate must be auth-only: with the bearer, the TCP route answers
      // exactly like the tokenless agent loopback does for the same path
      // (the MCP router's own not-found/handshake semantics, never a 401).
      const loopback = `http://127.0.0.1:${server.mcpPort}`;
      const viaTcp = await post(tcp, projectPath, token);
      const viaLoopback = await post(loopback, projectPath);
      expect(viaTcp.status).not.toBe(401);
      expect(viaTcp.status).toBe(viaLoopback.status);
      const hubViaTcp = await post(tcp, "/mcp/hub", token);
      expect(hubViaTcp.status).not.toBe(401);
      expect(hubViaTcp.status).toBe(200);
    } finally {
      await server?.close();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(hubDir, { recursive: true, force: true });
    }
  }, 20_000);
});

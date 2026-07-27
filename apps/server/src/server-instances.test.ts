import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LineBuffer } from "@crystal/core";
import { startCrystalServer } from "./server.js";
import type { InstanceInfo } from "./instances.js";

/** Poll an async probe until it returns a value (the instance rewrite is debounced). */
async function waitFor<T>(probe: () => Promise<T | null>, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("server identity + live instance file", () => {
  it("stamps identity, rewrites the file on open/close, and cleans up on shutdown", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-inst-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-inst-b-"));
    const instDir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-inst-dir-"));
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\crystal-test-inst-${process.pid}`
        : path.join(rootA, "test.sock");

    const server = await startCrystalServer({
      root: rootA,
      pipe,
      consoleDir: null,
      restorePersisted: false,
      persistFile: null,
      instancesDir: instDir,
      hubDir: null,
    });
    const instFile = path.join(instDir, `${process.pid}.json`);
    const readInfo = async (): Promise<InstanceInfo> =>
      JSON.parse(await fs.readFile(instFile, "utf8")) as InstanceInfo;

    const socket = net.connect(pipe);
    const connected = new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const frames: Array<{ id?: string; type: string; ok?: boolean; result?: unknown }> = [];
    let seq = 0;
    const rpc = async (method: string, params: unknown): Promise<unknown> => {
      const id = `r${++seq}`;
      socket.write(JSON.stringify({ id, type: "req", method, params }) + "\n");
      const frame = await waitFor(async () => frames.find((f) => f.id === id) ?? null);
      expect(frame.ok).toBe(true);
      return frame.result;
    };

    try {
      // Identity is minted per boot and stamped into the instance file.
      expect(server.serverId).toMatch(/^[0-9a-f-]{36}$/);
      const boot = await readInfo();
      expect(boot.serverId).toBe(server.serverId);
      expect(boot.name).toBe(`${os.hostname()}:${path.basename(rootA)}`);
      expect(boot.workspaces).toHaveLength(1);
      expect(boot.workspaces![0]).toMatchObject({ root: (boot.roots as string[])[0] });

      await connected;
      socket.setEncoding("utf8");
      const lines = new LineBuffer();
      socket.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) frames.push(JSON.parse(line));
      });

      // The same identity is served to clients on workspaces.list.
      const list = (await rpc("workspaces.list", {})) as {
        server?: { serverId: string; name: string };
      };
      expect(list.server).toEqual({
        serverId: server.serverId,
        name: `${os.hostname()}:${path.basename(rootA)}`,
      });

      // Opening a workspace rewrites the file (debounced) — no stale snapshot.
      const opened = (await rpc("workspaces.open", { root: rootB })) as {
        workspace: { id: string; root: string };
      };
      const afterOpen = await waitFor(async () => {
        const info = await readInfo();
        return info.workspaces?.length === 2 ? info : null;
      });
      expect(afterOpen.roots).toHaveLength(2);
      expect(afterOpen.workspaces!.map((w) => w.id)).toContain(opened.workspace.id);
      expect(afterOpen.serverId).toBe(server.serverId);
      expect(afterOpen.startedAt).toBe(boot.startedAt);

      // Closing shrinks it again.
      await rpc("workspaces.close", { ws: opened.workspace.id });
      const afterClose = await waitFor(async () => {
        const info = await readInfo();
        return info.workspaces?.length === 1 ? info : null;
      });
      expect(afterClose.roots).toHaveLength(1);
    } finally {
      socket.destroy();
      await server.close();
      await fs.rm(rootA, { recursive: true, force: true }).catch(() => {});
      await fs.rm(rootB, { recursive: true, force: true }).catch(() => {});
    }
    // Shutdown withdraws the advertisement; no late rewrite recreates it.
    await new Promise((r) => setTimeout(r, 250));
    expect(await fs.readdir(instDir)).toEqual([]);
    await fs.rm(instDir, { recursive: true, force: true }).catch(() => {});
  }, 20_000);
});

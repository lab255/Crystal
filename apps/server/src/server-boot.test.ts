import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LineBuffer } from "@crystal/core";
import { workspaceIdFor } from "./paths.js";
import { startCrystalServer, type CrystalServer } from "./server.js";
import { canonicalRoot } from "./workspace-registry.js";

/**
 * Boot with zero CLI roots — what the desktop shell asks for when no
 * CRYSTAL_ROOT is set (`--no-default-root`). A first launch must land on no
 * workspace at all (the client's picker), while a returning user's persisted
 * set still comes back.
 */
describe("startCrystalServer with no CLI root", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-boot-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  function pipeFor(dir: string): string {
    return process.platform === "win32"
      ? `\\\\.\\pipe\\crystal-boot-${process.pid}-${path.basename(dir)}`
      : path.join(dir, "boot.sock");
  }

  /**
   * The per-flavor open-set file a rootless server persists to. Its key comes
   * from the identity root — the historical `~/CrystalWorkspace` default —
   * which is exactly why that fallback must not move: it is where every
   * existing desktop install's open set already lives.
   */
  function flavorFile(persistFile: string): string {
    const key = workspaceIdFor(canonicalRoot(path.join(os.homedir(), "CrystalWorkspace")));
    return path.join(path.dirname(persistFile), `open-workspaces.${key}.json`);
  }

  async function boot(opts: { pipe: string; persistFile: string }): Promise<CrystalServer> {
    const server = await startCrystalServer({
      root: [],
      pipe: opts.pipe,
      consoleDir: null,
      persistFile: opts.persistFile,
      instancesDir: null,
      hubDir: null,
      publishFile: null,
    });
    cleanups.push(() => server.close());
    return server;
  }

  /** One request/response round trip over the IPC pipe. */
  async function rpc(pipe: string, method: string, params: unknown = {}): Promise<any> {
    const socket = net.connect(pipe);
    const settled = new Promise<any>((resolve, reject) => {
      const lines = new LineBuffer();
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        for (const line of lines.push(chunk)) {
          const frame = JSON.parse(line);
          if (frame.id === "r1") {
            if (frame.ok) resolve(frame.result);
            else reject(new Error(String(frame.error?.message ?? "request failed")));
          }
        }
      });
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(JSON.stringify({ id: "r1", type: "req", method, params }) + "\n");
      });
    });
    try {
      return await settled;
    } finally {
      socket.destroy();
    }
  }

  it("opens nothing on a first launch, and still answers workspaces.list", async () => {
    const tmp = await tmpDir();
    const persistFile = path.join(tmp, "open-workspaces.json");
    // A recents-only persist file: nothing was left open, but history exists.
    await fs.writeFile(
      persistFile,
      JSON.stringify({
        recents: [{ root: path.join(tmp, "gone"), name: "gone", lastOpenedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      "utf8",
    );
    const pipe = pipeFor(tmp);
    await boot({ pipe, persistFile });

    const list = await rpc(pipe, "workspaces.list");
    // No workspace is force-opened, and "none open" is a state the call
    // reports rather than an error the client has to recover from.
    expect(list.workspaces).toEqual([]);
    expect(list.defaultWs).toBeNull();
    // The reopen list still comes through — that is what the picker shows.
    expect(list.recents.map((r: { name: string; missing?: boolean }) => [r.name, r.missing])).toEqual([
      ["gone", true],
    ]);
  }, 20_000);

  it("still restores the previous session's workspaces", async () => {
    const tmp = await tmpDir();
    const wsA = path.join(tmp, "alpha");
    await fs.mkdir(wsA);
    const persistFile = path.join(tmp, "open-workspaces.json");
    await fs.writeFile(
      flavorFile(persistFile),
      JSON.stringify({ roots: [await fs.realpath(wsA)] }),
      "utf8",
    );
    const pipe = pipeFor(tmp);
    await boot({ pipe, persistFile });

    const list = await rpc(pipe, "workspaces.list");
    expect(list.workspaces.map((w: { name: string }) => w.name)).toEqual(["alpha"]);
    // The restored workspace becomes the default for `ws`-less calls.
    expect(list.defaultWs).toBe(list.workspaces[0].id);
  }, 20_000);

  it("expands a leading ~ in a typed workspace path", async () => {
    const tmp = await tmpDir();
    const persistFile = path.join(tmp, "open-workspaces.json");
    const pipe = pipeFor(tmp);
    await boot({ pipe, persistFile });

    // `~` never meets a shell on its way here; the server owns the expansion.
    const listing = await rpc(pipe, "workspaces.browse", { path: "~" });
    expect(listing.path).toBe(path.resolve(os.homedir()));
    await expect(rpc(pipe, "workspaces.open", { root: "~/definitely-not-a-real-dir" })).rejects.toThrow(
      new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }, 20_000);
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepInstances, writeInstanceFile, type InstanceInfo } from "./instances.js";

function info(partial: Partial<InstanceInfo>): InstanceInfo {
  return {
    pid: process.pid,
    pipe: null,
    port: null,
    mcpPort: 1,
    roots: [],
    startedAt: new Date().toISOString(),
    ...partial,
  };
}

/** A pid that is genuinely dead: spawn a no-op node child and wait it out. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

describe("writeInstanceFile", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function tmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-instances-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it("sweeps dead and unreadable entries on every write, not only on read", async () => {
    const dir = await tmpDir();
    const dead = await deadPid();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${dead}.json`), JSON.stringify(info({ pid: dead })), "utf8");
    await fs.writeFile(path.join(dir, "999999999.json"), "not json", "utf8");

    const file = await writeInstanceFile(dir, info({ pid: process.pid }));

    expect(await fs.readdir(dir)).toEqual([`${process.pid}.json`]);
    expect(file).toBe(path.join(dir, `${process.pid}.json`));
    if (process.platform !== "win32") {
      // The token may ride in this file — it must stay private to the user.
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips the identity and live-workspace fields through a sweep read", async () => {
    const dir = await tmpDir();
    const workspaces = [{ id: "abc123", root: "/tmp/alpha", name: "alpha" }];
    await writeInstanceFile(
      dir,
      info({ serverId: "boot-uid-1", name: "host:alpha", roots: ["/tmp/alpha"], workspaces }),
    );

    const live = await sweepInstances(dir);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      pid: process.pid,
      serverId: "boot-uid-1",
      name: "host:alpha",
      workspaces,
    });

    // A rewrite (same pid) replaces the file in place rather than adding one.
    await writeInstanceFile(dir, info({ serverId: "boot-uid-1", workspaces: [] }));
    expect(await fs.readdir(dir)).toEqual([`${process.pid}.json`]);
    const rewritten = await sweepInstances(dir);
    expect(rewritten[0]!.workspaces).toEqual([]);
  });
});

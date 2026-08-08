import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceDef, createWatchDef, type ServiceInfo } from "@crystal/core";
import { ServiceManager, portFree, reapOrphan, type WatchFirePayload } from "./service-manager.js";
import { WorkspaceStore } from "./workspace-store.js";

let tmp: string;
let root: string;
let store: WorkspaceStore;
let mgr: ServiceManager;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-svc-"));
  root = path.join(tmp, "root");
  await fs.mkdir(root, { recursive: true });
  store = new WorkspaceStore(root);
  mgr = new ServiceManager(root, path.join(tmp, "data"), store);
});

afterEach(async () => {
  mgr.dispose();
  await new Promise((r) => setTimeout(r, 100)); // let kills land
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Wait until the service reaches one of `statuses` (or time out). */
async function waitFor(
  id: string,
  statuses: ServiceInfo["status"][],
  timeoutMs = 5000,
): Promise<ServiceInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = (await mgr.list()).find((s) => s.def.id === id)!;
    if (statuses.includes(info.status)) return info;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${statuses}; at ${info.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("ServiceManager", () => {
  it("persists definitions to .crystal/services.json and lists them", async () => {
    const def = createServiceDef({ name: "dev", command: "node -e ''", port: null });
    await mgr.saveDefs({ services: [def] });
    const listed = await mgr.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("stopped");
    // Durable: a fresh manager over the same store sees them.
    const fresh = new ServiceManager(root, path.join(tmp, "data2"), new WorkspaceStore(root));
    expect((await fresh.list()).map((s) => s.def.name)).toEqual(["dev"]);
  });

  it("starts a service, streams its logs, and marks a crash as failed", async () => {
    const def = createServiceDef({
      name: "chatty",
      command: `node -e "console.log('hello from svc'); setTimeout(() => process.exit(3), 300)"`,
    });
    await mgr.saveDefs({ services: [def] });
    const logs: string[] = [];
    mgr.events.on("log", ({ chunk }) => logs.push(chunk.text));

    const started = await mgr.start(def.id);
    expect(started.status).toBe("running");
    expect(started.pid).toBeGreaterThan(0);

    // It exits while desired=running → crash → "failed", exit code kept.
    const settled = await waitFor(def.id, ["failed"]);
    expect(settled.exitCode).toBe(3);
    expect(settled.lastError).toMatch(/code 3/);
    expect(logs.join("\n")).toContain("hello from svc");
    expect((await mgr.logs(def.id)).some((c) => c.text.includes("hello from svc"))).toBe(true);
  });

  it("stops a long-running service (tree kill) as 'exited', not 'failed'", async () => {
    const def = createServiceDef({
      name: "steady",
      command: `node -e "setInterval(() => {}, 1000)"`,
    });
    await mgr.saveDefs({ services: [def] });
    await mgr.start(def.id);
    await mgr.stop(def.id);
    const settled = await waitFor(def.id, ["exited", "stopped"]);
    expect(settled.pid).toBeNull();
    expect(settled.desired).toBe("stopped");
  });

  it("keeps a running service's runtime when its definition is saved away", async () => {
    // Removing a live service from the config must not orphan its process —
    // the runtime survives (so stop() can still kill it) until it stops.
    const def = createServiceDef({ name: "keep", command: `node -e "setInterval(() => {}, 1000)"` });
    await mgr.saveDefs({ services: [def] });
    await mgr.start(def.id);
    await waitFor(def.id, ["running"]);

    // Save an empty config (removes the running service).
    await mgr.saveDefs({ services: [] });
    // list() no longer shows it, but stop() still reaches the live process.
    const stopped = await mgr.stop(def.id);
    expect(stopped.desired).toBe("stopped");
    await waitFor(def.id, ["exited", "stopped"]);
  });

  it("pre-probes the port and fails readably when it is taken", async () => {
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port));
    });
    try {
      const def = createServiceDef({ name: "clash", command: "node -e ''", port });
      await mgr.saveDefs({ services: [def] });
      const result = await mgr.start(def.id);
      expect(result.status).toBe("failed");
      expect(result.lastError).toContain(`Port ${port}`);
    } finally {
      blocker.close();
    }
  });

  it("restores desired-running services on boot (fresh manager, same app-data)", async () => {
    const def = createServiceDef({
      name: "durable",
      command: `node -e "setInterval(() => {}, 1000)"`,
    });
    await mgr.saveDefs({ services: [def] });
    await mgr.start(def.id);
    mgr.dispose(); // server "crash"/shutdown
    await new Promise((r) => setTimeout(r, 200));

    const reborn = new ServiceManager(root, path.join(tmp, "data"), new WorkspaceStore(root));
    await reborn.restoreDesired();
    const info = (await reborn.list()).find((s) => s.def.id === def.id)!;
    expect(info.status).toBe("running");
    reborn.dispose();
  });

  it("keeps a stopped service stopped across restore", async () => {
    const def = createServiceDef({ name: "idle", command: "node -e ''" });
    await mgr.saveDefs({ services: [def] });
    await mgr.start(def.id);
    await waitFor(def.id, ["failed", "exited"]); // instant exit
    await mgr.stop(def.id);

    const reborn = new ServiceManager(root, path.join(tmp, "data"), new WorkspaceStore(root));
    await reborn.restoreDesired();
    const info = (await reborn.list()).find((s) => s.def.id === def.id)!;
    expect(info.status).toBe("stopped");
    reborn.dispose();
  });
});

describe("watches", () => {
  it("fires on a matching log line with the tail as context, throttled", async () => {
    const def = createServiceDef({
      name: "flappy",
      // Two matching lines in quick succession — the throttle must collapse
      // them into one fire.
      command: `node -e "console.log('warmup'); console.log('ERROR one'); console.log('ERROR two'); setTimeout(() => {}, 2000)"`,
    });
    const watch = createWatchDef({ serviceId: def.id, pattern: "error", instructions: "fix" });
    await mgr.saveDefs({ services: [def], watches: [watch] });
    const fires: WatchFirePayload[] = [];
    mgr.onWatchFire = async (payload) => {
      fires.push(payload);
    };
    await mgr.start(def.id);
    await new Promise((r) => setTimeout(r, 900));
    expect(fires).toHaveLength(1);
    expect(fires[0]!.reason).toEqual({ kind: "log", line: "ERROR one" });
    expect(fires[0]!.logTail).toContain("warmup");
    const watches = await mgr.listWatches();
    expect(watches[0]!.fireCount).toBe(1);
    await mgr.stop(def.id);
  });

  it("fires on a crash when onCrash is set", async () => {
    const def = createServiceDef({ name: "crashy", command: `node -e "process.exit(9)"` });
    const watch = createWatchDef({ serviceId: def.id, instructions: "revive" });
    await mgr.saveDefs({ services: [def], watches: [watch] });
    const fires: WatchFirePayload[] = [];
    mgr.onWatchFire = async (payload) => {
      fires.push(payload);
    };
    await mgr.start(def.id);
    await waitFor(def.id, ["failed"]);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.reason.kind).toBe("crash");
  });

  it("disabled watches and dangling watches never fire", async () => {
    const def = createServiceDef({ name: "quiet", command: `node -e "console.log('ERROR')"` });
    const off = createWatchDef({ serviceId: def.id, pattern: "error", instructions: "x" });
    const dangling = createWatchDef({ serviceId: "svc_gone", pattern: "error", instructions: "x" });
    await mgr.saveDefs({ services: [def], watches: [{ ...off, enabled: false }, dangling] });
    // The dangling watch was dropped at save (its service does not exist).
    expect(await mgr.listWatches()).toHaveLength(1);
    const fires: WatchFirePayload[] = [];
    mgr.onWatchFire = async (payload) => {
      fires.push(payload);
    };
    await mgr.start(def.id);
    await waitFor(def.id, ["failed", "exited"]);
    expect(fires).toHaveLength(0);
  });
});

describe("demoTargets overlay", () => {
  it("running port-carrying services beat the report's guesses; storybook splits off", async () => {
    const dev = createServiceDef({
      name: "web",
      command: `node -e "setInterval(() => {}, 1000)"`,
      port: 5173,
    });
    const sb = createServiceDef({
      name: "storybook",
      command: `node -e "setInterval(() => {}, 1000)"`,
      port: 6006,
    });
    const portless = createServiceDef({ name: "worker", command: `node -e "setInterval(() => {}, 1000)"` });
    await mgr.saveDefs({ services: [dev, sb, portless] });

    // Nothing running: the base guesses pass through untouched.
    const idle = await mgr.demoTargets({ appUrl: "http://localhost:9999", storybookUrl: null });
    expect(idle).toEqual({ appUrl: "http://localhost:9999", storybookUrl: null });

    await mgr.start(dev.id);
    await mgr.start(sb.id);
    await mgr.start(portless.id);
    const live = await mgr.demoTargets({ appUrl: "http://localhost:9999", storybookUrl: null });
    expect(live.appUrl).toBe("http://localhost:5173");
    expect(live.storybookUrl).toBe("http://localhost:6006");
    await mgr.stop(dev.id);
    await mgr.stop(sb.id);
    await mgr.stop(portless.id);
  });
});

describe("portFree", () => {
  it("reports a bound port as taken and a fresh one as free", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    expect(await portFree(port)).toBe(false);
    await new Promise((r) => server.close(r));
    expect(await portFree(port)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("reapOrphan", () => {
  it("never kills a recycled pid whose command does not match", async () => {
    // Our own test process is alive but is NOT running the service command —
    // the ps guard must refuse to signal it.
    await reapOrphan(process.pid, "definitely-not-this-process-cmd-xyz");
    expect(process.pid).toBeGreaterThan(0); // still alive to assert
  });

  it("does not kill an unrelated process that shares only the command's first token", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const psExec = vi.fn(async () => ({ stdout: "node something-else.js\n", stderr: "" }));
    try {
      await reapOrphan(4242, "node service.js", psExec as never);
      expect(kill).toHaveBeenCalledWith(4242, 0);
      expect(kill).not.toHaveBeenCalledWith(-4242, "SIGKILL");
    } finally {
      kill.mockRestore();
    }
  });
});

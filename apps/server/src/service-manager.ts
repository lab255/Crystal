import { spawn, execFile, type ChildProcess } from "node:child_process";
import type { z } from "zod";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { KILL_GRACE_MS, killProcessTree } from "./process-tree.js";
import {
  Emitter,
  LineBuffer,
  SERVICE_LOG_RING,
  ServicesFileSchema,
  compileWatchPattern,
  nowIso,
  type DemoTargets,
  type ServiceDef,
  type ServiceInfo,
  type ServiceLogChunk,
  type ServicesFile,
  type ServiceStatus,
  type WatchDef,
  type WatchFireReason,
  type WatchInfo,
} from "@crystal/core";
import { resolveInRoot } from "./paths.js";
import type { WorkspaceStore } from "./workspace-store.js";

const execFileAsync = promisify(execFile);

interface ServiceRuntime {
  status: ServiceStatus;
  child: ChildProcess | null;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  logs: ServiceLogChunk[];
  seq: number;
  /** The user's intent — restarted on boot when "running". */
  desired: "running" | "stopped";
}

/** What survives a server restart, per service (app-data JSON). */
interface PersistedServiceState {
  desired: "running" | "stopped";
  pid: number | null;
  command: string;
}

/** Why a watch fired, handed to the dispatcher for the agent's context. */
export interface WatchFirePayload {
  watch: WatchDef;
  service: ServiceDef;
  reason: WatchFireReason;
  /** Recent log lines for context (oldest first). */
  logTail: string[];
}

/** How many log lines ride along with a watch fire. */
const WATCH_LOG_TAIL = 30;

/**
 * Supervises managed services (see core service.ts): definitions live in the
 * repo, processes are detached process-group children owned by this server.
 *
 * Restart-safety (the operator-oss recipe): desired state + the group-leader
 * pid write through to app-data. On boot, services the user left `running`
 * are restarted — but first the orphaned group from a crashed previous server
 * is reaped, guarded by a `ps` command check so a recycled pid belonging to
 * some unrelated process is never killed.
 */
export class ServiceManager {
  readonly events = new Emitter<{
    changed: { service: ServiceInfo };
    log: { chunk: ServiceLogChunk };
    watchFired: { watch: WatchInfo };
  }>();

  private runtimes = new Map<string, ServiceRuntime>();
  private defs = new Map<string, ServiceDef>();
  private watchDefs = new Map<string, WatchDef>();
  /** Compiled matchers by watch id (rebuilt on save). */
  private watchMatchers = new Map<string, (line: string) => boolean>();
  private watchState = new Map<string, { lastFiredAt: string | null; fireCount: number }>();
  private loaded = false;
  /**
   * Set by the workspace runtime: dispatch an agent for a fired watch. The
   * dispatcher owns dedup against still-live earlier fires; the manager owns
   * the min-interval throttle. Absent → watches observe but never fire.
   */
  onWatchFire: ((payload: WatchFirePayload) => Promise<void>) | null = null;
  /** Serializes start/stop per service — a double-click must not double-spawn. */
  private locks = new Map<string, Promise<unknown>>();
  /**
   * Server teardown in progress: exits are deliberate (not crashes) and the
   * persisted desired-state must NOT be overwritten — `desired: "running"`
   * is exactly what the next boot's restore needs to see.
   */
  private disposing = false;

  constructor(
    private readonly root: string,
    private readonly dataDir: string,
    private readonly store: WorkspaceStore,
  ) {}

  private stateFile(): string {
    return path.join(this.dataDir, "services-state.json");
  }

  private runtime(id: string): ServiceRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        status: "stopped",
        child: null,
        pid: null,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        lastError: null,
        logs: [],
        seq: 0,
        desired: "stopped",
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private info(def: ServiceDef): ServiceInfo {
    const rt = this.runtime(def.id);
    return {
      def,
      status: rt.status,
      pid: rt.pid,
      exitCode: rt.exitCode,
      startedAt: rt.startedAt,
      endedAt: rt.endedAt,
      lastError: rt.lastError,
      desired: rt.desired,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = await this.store.loadServices();
    for (const def of file.services) this.defs.set(def.id, def);
    this.setWatches(file.watches);
  }

  private setWatches(watches: WatchDef[]): void {
    this.watchDefs = new Map(watches.map((w) => [w.id, w]));
    this.watchMatchers.clear();
    for (const w of watches) {
      const matcher = compileWatchPattern(w.pattern);
      if (matcher) this.watchMatchers.set(w.id, matcher);
    }
    for (const id of [...this.watchState.keys()]) {
      if (!this.watchDefs.has(id)) this.watchState.delete(id);
    }
  }

  async listWatches(): Promise<WatchInfo[]> {
    await this.ensureLoaded();
    return [...this.watchDefs.values()].map((def) => ({
      def,
      lastFiredAt: this.watchState.get(def.id)?.lastFiredAt ?? null,
      fireCount: this.watchState.get(def.id)?.fireCount ?? 0,
    }));
  }

  async list(): Promise<ServiceInfo[]> {
    await this.ensureLoaded();
    return [...this.defs.values()].map((def) => this.info(def));
  }

  /** Replace the definitions (the UI's save path) and persist to the repo. */
  async saveDefs(services: z.input<typeof ServicesFileSchema>): Promise<ServiceInfo[]> {
    await this.ensureLoaded();
    // Watches must reference a defined service — drop dangling ones instead
    // of persisting config that can never fire. Validation (defaults included)
    // happens once, in the store's saveServices.
    const defs = services.services ?? [];
    const serviceIds = new Set(defs.map((s) => s.id));
    const watches = (services.watches ?? []).filter((w) => serviceIds.has(w.serviceId));
    const file = await this.store.saveServices({ services: defs, watches });
    const next = new Map(file.services.map((d) => [d.id, d]));
    // Definitions removed while a process is live keep their runtime until it
    // stops — dropping it would orphan the child (no map entry → stop() can't
    // kill it). "starting" counts as live: a service sits there across the
    // port pre-probe in start(), and removing it mid-probe would spawn into a
    // detached runtime this map no longer tracks.
    for (const id of [...this.defs.keys()]) {
      const status = this.runtime(id).status;
      if (!next.has(id) && status !== "running" && status !== "starting") {
        this.defs.delete(id);
        this.runtimes.delete(id);
      }
    }
    for (const [id, def] of next) this.defs.set(id, def);
    this.setWatches(file.watches);
    return this.list();
  }

  /** Serialize one service's lifecycle ops (double-click must not double-spawn). */
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const step = prev.then(fn, fn);
    this.locks.set(id, step.catch(() => {}));
    return step;
  }

  async start(id: string): Promise<ServiceInfo> {
    await this.ensureLoaded();
    return this.locked(id, async () => {
      const def = this.defs.get(id);
      if (!def) throw new Error(`Unknown service: ${id}`);
      const rt = this.runtime(id);
      if (rt.status === "running" || rt.status === "starting") return this.info(def);

      rt.desired = "running";
      rt.lastError = null;
      rt.exitCode = null;
      rt.status = "starting";
      this.emitChanged(def);

      if (def.port != null && !(await portFree(def.port))) {
        rt.status = "failed";
        rt.lastError = `Port ${def.port} is already in use — stop whatever holds it (or clear the port on the service).`;
        this.emitChanged(def);
        await this.persistState();
        return this.info(def);
      }

      const cwd = resolveInRoot(this.root, def.cwd || ".");
      let child: ChildProcess;
      try {
        child = spawn(def.command, {
          cwd,
          shell: true,
          windowsHide: true,
          // Its own process group (POSIX): stop() can signal the whole
          // shell→npm→node tree, and the group survives nothing — it dies
          // with intent, not with the browser tab.
          detached: process.platform !== "win32",
          env: { ...process.env, ...def.env, FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        rt.status = "failed";
        rt.lastError = `Failed to spawn: ${(err as Error).message}`;
        this.emitChanged(def);
        return this.info(def);
      }

      rt.child = child;
      rt.pid = child.pid ?? null;
      rt.startedAt = nowIso();
      rt.endedAt = null;

      // Synchronously, before any await — a failed spawn 'error's next tick.
      child.on("error", (err) => {
        rt.status = "failed";
        rt.lastError = `Failed to spawn: ${err.message}`;
        rt.child = null;
        rt.pid = null;
        rt.endedAt = nowIso();
        this.emitChanged(def);
      });
      const out = new LineBuffer(64 * 1024);
      const errBuf = new LineBuffer(64 * 1024);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        for (const line of out.push(chunk)) this.pushLog(def, line);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        for (const line of errBuf.push(chunk)) this.pushLog(def, line);
      });
      child.on("close", (code, signal) => {
        for (const line of [...out.flush(), ...errBuf.flush()]) this.pushLog(def, line);
        rt.child = null;
        rt.pid = null;
        rt.endedAt = nowIso();
        rt.exitCode = code;
        // Wanted-running + died = failed (crash); stopped-on-purpose (or the
        // server tearing everything down) = exited.
        const crashed = rt.desired === "running" && !this.disposing;
        rt.status = crashed ? "failed" : "exited";
        if (crashed) {
          rt.lastError = `Exited with ${signal ? `signal ${signal}` : `code ${code}`} while supposed to be running.`;
          for (const watch of this.watchDefs.values()) {
            if (watch.enabled && watch.onCrash && watch.serviceId === def.id) {
              this.maybeFireWatch(watch, def, { kind: "crash", detail: rt.lastError });
            }
          }
        }
        this.emitChanged(def);
        if (!this.disposing) void this.persistState();
      });

      rt.status = "running";
      this.emitChanged(def);
      await this.persistState();
      return this.info(def);
    });
  }

  async stop(id: string): Promise<ServiceInfo> {
    await this.ensureLoaded();
    return this.locked(id, async () => {
      const def = this.defs.get(id);
      if (!def) throw new Error(`Unknown service: ${id}`);
      const rt = this.runtime(id);
      rt.desired = "stopped";
      if (rt.child?.pid) {
        await killProcessTree(rt.child.pid, { child: rt.child, group: true, escalateMs: KILL_GRACE_MS });
        // 'close' settles status/pid; reflect intent immediately for the UI.
      } else {
        rt.status = "stopped";
      }
      this.emitChanged(def);
      await this.persistState();
      return this.info(def);
    });
  }

  async restart(id: string): Promise<ServiceInfo> {
    await this.stop(id);
    return this.start(id);
  }

  /** Ring-buffer replay for one service (catch up before listening to `log`). */
  async logs(id: string): Promise<ServiceLogChunk[]> {
    await this.ensureLoaded();
    return [...this.runtime(id).logs];
  }

  /**
   * Overlay demo targets with RUNNING services: a live service with a port is
   * ground truth, so it beats the surfaces report's package.json guesswork.
   * Storybook-looking services fill `storybookUrl`; the rest fill `appUrl`.
   */
  async demoTargets(base: DemoTargets): Promise<DemoTargets> {
    await this.ensureLoaded();
    let { appUrl, storybookUrl } = base;
    for (const def of this.defs.values()) {
      if (def.port == null || this.runtime(def.id).status !== "running") continue;
      const url = `http://localhost:${def.port}`;
      if (/storybook/i.test(`${def.name} ${def.command}`)) storybookUrl = url;
      else appUrl = url;
    }
    return { appUrl, storybookUrl };
  }

  /**
   * Boot path: reap orphaned process groups from a crashed previous server
   * (pid-reuse-guarded), then restart everything the user left `running`.
   */
  async restoreDesired(): Promise<void> {
    await this.ensureLoaded();
    let persisted: Record<string, PersistedServiceState> = {};
    try {
      persisted = JSON.parse(await fs.readFile(this.stateFile(), "utf8"));
    } catch {
      return; // first run — nothing to restore
    }
    for (const [id, state] of Object.entries(persisted)) {
      const def = this.defs.get(id);
      if (!def) continue;
      if (state.pid != null) {
        await reapOrphan(state.pid, state.command);
      }
      if (state.desired === "running") {
        await this.start(id).catch((err) => {
          console.warn(`[crystal] could not restore service ${def.name}:`, (err as Error).message);
        });
      } else {
        this.runtime(id).desired = state.desired;
      }
    }
  }

  /**
   * Kill every managed group (workspace close / server shutdown). `desired`
   * is untouched — a `running` service comes back on the next boot's restore.
   */
  dispose(): void {
    this.disposing = true;
    for (const rt of this.runtimes.values()) {
      if (rt.child?.pid)
        void killProcessTree(rt.child.pid, { child: rt.child, group: true, escalateMs: KILL_GRACE_MS });
    }
  }

  private emitChanged(def: ServiceDef): void {
    this.events.emit("changed", { service: this.info(def) });
  }

  private pushLog(def: ServiceDef, text: string): void {
    const rt = this.runtime(def.id);
    const chunk: ServiceLogChunk = {
      serviceId: def.id,
      seq: rt.seq++,
      ts: nowIso(),
      text,
    };
    rt.logs.push(chunk);
    if (rt.logs.length > SERVICE_LOG_RING) rt.logs.splice(0, Math.ceil(SERVICE_LOG_RING / 5));
    this.events.emit("log", { chunk });
    for (const watch of this.watchDefs.values()) {
      if (!watch.enabled || watch.serviceId !== def.id) continue;
      const matcher = this.watchMatchers.get(watch.id);
      if (matcher?.(text)) this.maybeFireWatch(watch, def, { kind: "log", line: text });
    }
  }

  /**
   * Fire a watch unless it fired within its own min interval. The dispatcher
   * (set by the workspace runtime) additionally suppresses fires whose
   * previous agent run is still live.
   */
  private maybeFireWatch(watch: WatchDef, def: ServiceDef, reason: WatchFirePayload["reason"]): void {
    if (!this.onWatchFire) return;
    const state = this.watchState.get(watch.id) ?? { lastFiredAt: null, fireCount: 0 };
    if (state.lastFiredAt && Date.now() - Date.parse(state.lastFiredAt) < watch.minIntervalSec * 1000) {
      return;
    }
    state.lastFiredAt = nowIso();
    state.fireCount += 1;
    this.watchState.set(watch.id, state);
    const logTail = this.runtime(def.id)
      .logs.slice(-WATCH_LOG_TAIL)
      .map((c) => c.text);
    this.events.emit("watchFired", {
      watch: { def: watch, lastFiredAt: state.lastFiredAt, fireCount: state.fireCount },
    });
    // Fire-and-forget: a dispatcher failure must not take down the log loop.
    void this.onWatchFire({ watch, service: def, reason, logTail }).catch((err) => {
      console.warn(`[crystal] watch ${watch.id} dispatch failed:`, (err as Error).message);
    });
  }

  private async persistState(): Promise<void> {
    const state: Record<string, PersistedServiceState> = {};
    for (const [id, rt] of this.runtimes) {
      const def = this.defs.get(id);
      if (!def) continue;
      state[id] = { desired: rt.desired, pid: rt.pid, command: def.command };
    }
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(this.stateFile(), JSON.stringify(state, null, 2), "utf8");
    } catch (err) {
      console.warn("[crystal] could not persist service state:", (err as Error).message);
    }
  }
}

/** True when nothing is listening on `port` (loopback probe, exclusive bind). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}



/**
 * Reap a process group orphaned by a crashed server — but only when the pid
 * still looks like our service. Pids recycle; killing whatever now owns this
 * one would be a disaster, so require the `ps` command line to contain the
 * service's command (or its obvious runner) before signalling.
 */
export async function reapOrphan(
  pid: number,
  command: string,
  psExec: typeof execFileAsync = execFileAsync,
): Promise<void> {
  if (process.platform === "win32") return; // no pgid semantics — skip reaping
  try {
    process.kill(pid, 0); // alive?
  } catch {
    return; // already gone
  }
  try {
    const { stdout } = await psExec("ps", ["-o", "command=", "-p", String(pid)], {
      windowsHide: true,
    });
    const line = stdout.trim();
    // The leader is the shell we spawned: its command line carries the
    // service command (or at minimum a shell). An unrelated recycled pid
    // (some GUI app, another user's process) will not match — leave it alone.
    const head = command.split(/\s+/)[0] ?? command;
    if (!line.includes(command) && !line.includes(head)) return;
    process.kill(-pid, "SIGKILL");
  } catch {
    /* ps unavailable or kill refused — do nothing rather than guess */
  }
}

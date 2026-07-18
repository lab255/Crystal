import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Instance discovery: every running bridge server advertises itself in
 * `~/.crystal/instances/<pid>.json` so local tools (the desktop shell, CLIs,
 * a future `crystal attach`) can find the right endpoint instead of guessing
 * a fixed TCP port — which used to silently connect the desktop to whatever
 * other Crystal server happened to own 4517.
 */

/** Default directory where running servers advertise themselves. */
export function defaultInstancesDir(): string {
  return path.join(os.homedir(), ".crystal", "instances");
}

/**
 * Default IPC endpoint for a server identified by `id` (usually the primary
 * workspace id). Windows named pipes live in the kernel pipe namespace and
 * vanish with their server; elsewhere a socket file under `~/.crystal/run`.
 */
export function defaultPipePath(id: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crystal-${id}`;
  return path.join(os.homedir(), ".crystal", "run", `crystal-${id}.sock`);
}

export interface InstanceInfo {
  pid: number;
  /** IPC endpoint (named pipe / unix socket), null when disabled. */
  pipe: string | null;
  /** Opt-in TCP bridge port, null when the network listener is off. */
  port: number | null;
  /** Loopback port of the in-process MCP endpoint. */
  mcpPort: number;
  roots: string[];
  /** Bearer token for the TCP listener, present only when auth is enabled. */
  token?: string;
  startedAt: string;
}

/** Write this server's discovery file; returns its path for cleanup. */
export async function writeInstanceFile(dir: string, info: InstanceInfo): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${info.pid}.json`);
  // 0600: the file may carry the bearer token (no-op on Windows, where the
  // profile directory ACL covers it).
  await fs.writeFile(file, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
  return file;
}

export async function removeInstanceFile(file: string): Promise<void> {
  await fs.unlink(file).catch(() => {});
}

/** Probe a pid without signaling it; EPERM means alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read all discovery files, dropping the ones whose server is gone (a crash
 * leaves them behind). Returns the surviving live instances.
 */
export async function sweepInstances(dir: string): Promise<InstanceInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const live: InstanceInfo[] = [];
  await Promise.all(
    entries
      .filter((e) => e.endsWith(".json"))
      .map(async (e) => {
        const file = path.join(dir, e);
        try {
          const info = JSON.parse(await fs.readFile(file, "utf8")) as InstanceInfo;
          if (typeof info.pid === "number" && pidAlive(info.pid)) {
            live.push(info);
            return;
          }
        } catch {
          /* unreadable — treat as stale */
        }
        await fs.unlink(file).catch(() => {});
      }),
  );
  return live;
}

/** Remove a unix socket file at shutdown (no-op for Windows named pipes). */
export async function unlinkPipe(pipePath: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.unlink(pipePath).catch(() => {});
}

/**
 * Pick a usable IPC path: prefer `preferred`, but step aside to `fallback`
 * when a live instance already claims it (two servers on the same root). A
 * stale unix socket file left by a crash is cleared so listen() can bind;
 * Windows pipes vanish with their server and need no cleanup.
 */
export async function claimPipePath(
  preferred: string,
  fallback: string,
  instancesDir: string | null,
): Promise<string> {
  const live = instancesDir ? await sweepInstances(instancesDir) : [];
  const claimed = new Set(live.map((i) => i.pipe).filter(Boolean));
  const pick = claimed.has(preferred) ? fallback : preferred;
  if (process.platform !== "win32") {
    try {
      fsSync.mkdirSync(path.dirname(pick), { recursive: true });
      fsSync.unlinkSync(pick);
    } catch {
      /* no stale socket */
    }
  }
  return pick;
}

import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default SIGTERM → SIGKILL escalation window. */
export const KILL_GRACE_MS = 4000;

/**
 * Kill a spawned process and everything under it — the one tree-kill for
 * every server-owned child (agent runs, quality runs, managed services).
 *
 * - Windows: `taskkill /T /F` takes the whole tree (a `.cmd` shim or shell
 *   spawn puts the real process underneath); if taskkill itself is
 *   unavailable, fall back to a plain kill on the handle.
 * - POSIX: signal the process *group* when the child was spawned `detached`
 *   (group leader — takes the shell→npm→node tree), else the pid; with
 *   `escalateMs` set, SIGKILL follows if the process hasn't closed by then.
 *
 * Terminal PTYs keep their own kill path (`terminal-manager.ts`) — node-pty
 * owns that handle, not child_process.
 */
export async function killProcessTree(
  pid: number,
  opts: {
    /** The spawn handle, for the Windows fallback and close-tracking. */
    child?: ChildProcess | null;
    /** POSIX: the child is a detached group leader — signal the whole group. */
    group?: boolean;
    /** SIGKILL after this many ms without a close (omit/null = no escalation). */
    escalateMs?: number | null;
  } = {},
): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(
      () => opts.child?.kill(),
    );
    return;
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(opts.group ? -pid : pid, sig);
    } catch {
      try {
        process.kill(pid, sig); // group already gone — try the leader alone
      } catch {
        /* already dead */
      }
    }
  };
  signal("SIGTERM");
  const escalateMs = opts.escalateMs ?? null;
  if (escalateMs == null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      signal("SIGKILL");
      done();
    }, escalateMs);
    if (opts.child) opts.child.once("close", done);
    else done(); // no handle to watch — escalate on the timer alone
  });
}

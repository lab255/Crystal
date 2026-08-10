import { DEFAULT_BRIDGE_PORT } from "@crystal/core";
import { resolveStartupRoots } from "./boot-args.js";
import { canonicalRoot } from "./workspace-registry.js";
import { startCrystalServer, type CrystalServer } from "./server.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// Last-resort guards: the bridge hosts every workspace, terminal and live
// agent run in one process — a stray async error (e.g. an unhandled stream
// 'error' from a child process) must be logged, not allowed to take it all
// down. Specific call sites still handle their own errors; this only catches
// what slipped through.
process.on("uncaughtException", (err) => {
  console.error("[crystal] uncaught exception (server kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[crystal] unhandled rejection (server kept alive):", reason);
});

// `--root` (repeatable) else the cwd — unless `--no-default-root` /
// CRYSTAL_NO_DEFAULT_ROOT drops that fallback, which is how the desktop shell
// boots a sidecar that opens nothing but the persisted set (see boot-args.ts).
const roots = resolveStartupRoots(process.argv, process.env, process.cwd()).map(canonicalRoot);

/**
 * The TCP listener is opt-in: `--listen [host:]port` (or CRYSTAL_LISTEN), with
 * the legacy `--port`/`--host` flags and env vars implying it for
 * back-compat. With none of these the bridge is IPC-only — a named pipe /
 * unix socket that no firewall inspects.
 */
function parseListen(): { host?: string; port: number } | null {
  const listenArg = argValue("--listen") ?? process.env.CRYSTAL_LISTEN;
  if (listenArg) {
    const m = /^(?:(.+):)?(\d+)$/.exec(listenArg);
    if (!m) {
      console.error(`[crystal] invalid --listen (expected [host:]port): ${listenArg}`);
      process.exit(1);
    }
    const host = m[1] ? m[1].replace(/^\[|\]$/g, "") : "127.0.0.1";
    return { host, port: Number(m[2]) };
  }
  const portArg = argValue("--port") ?? process.env.CRYSTAL_PORT;
  const hostArg = argValue("--host") ?? process.env.CRYSTAL_HOST;
  if (portArg !== undefined || hostArg !== undefined) {
    return { host: hostArg ?? "127.0.0.1", port: Number(portArg ?? DEFAULT_BRIDGE_PORT) };
  }
  return null;
}

const listen = parseListen();
// `--pipe <path>` overrides the derived endpoint; `--no-pipe` disables IPC.
const pipe = process.argv.includes("--no-pipe")
  ? null
  : (argValue("--pipe") ?? process.env.CRYSTAL_PIPE ?? undefined);
const token = process.env.CRYSTAL_TOKEN ?? null;
/**
 * `--mcp-port <port>` pins the loopback MCP listener. The hub endpoint
 * (`/mcp/hub`) is configured once in an external agent's MCP config, so a
 * fresh ephemeral port on every restart would break it.
 */
const mcpPortArg = argValue("--mcp-port") ?? process.env.CRYSTAL_MCP_PORT;
const mcpPort = mcpPortArg !== undefined ? Number(mcpPortArg) : null;
if (mcpPort !== null && !Number.isInteger(mcpPort)) {
  console.error(`[crystal] invalid --mcp-port: ${mcpPortArg}`);
  process.exit(1);
}

let server: CrystalServer | null = null;
let shuttingDown = false;

/** Graceful stop: dispose terminals/watchers, persist state, then exit. */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[crystal] shutting down (${reason})`);
  // If teardown wedges (a PTY that won't die, a stuck socket), exit anyway;
  // the desktop supervisor hard-kills the job after its own grace window.
  const failsafe = setTimeout(() => process.exit(0), 2500);
  failsafe.unref();
  try {
    await server?.close();
  } catch (err) {
    console.error("[crystal] error during shutdown:", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Windows has no graceful kill signal for GUI-spawned children; a supervising
// parent (the desktop app) pipes our stdin and closes it to request shutdown.
// Opt-in via env so a dev server run with detached stdin isn't killed at boot.
if (process.env.CRYSTAL_SHUTDOWN_ON_STDIN_END === "1") {
  process.stdin.resume();
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("error", () => void shutdown("stdin error"));
}

startCrystalServer({ root: roots, listen, pipe, token, mcpPort })
  .then((s) => {
    server = s;
  })
  .catch((err) => {
    console.error("[crystal] failed to start:", err);
    process.exit(1);
  });

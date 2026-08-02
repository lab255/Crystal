#!/usr/bin/env node
import { runStdioProxy } from "./mcp/stdio-proxy.js";

/**
 * `crystal-mcp` — the cross-project hub as a stdio MCP server.
 *
 *     claude mcp add crystal-hub -- crystal-mcp
 *     claude mcp add crystal-hub -- crystal-mcp --root /path/to/repo
 *
 * It holds no state of its own: every call is relayed to whichever Crystal
 * server is running (see `mcp/stdio-proxy.ts`), so the config survives
 * restarts and ephemeral ports.
 */

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

// stdout is the protocol channel — anything else must go to stderr, or the
// client sees garbage frames.
process.on("uncaughtException", (err) => {
  console.error("[crystal-mcp] uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[crystal-mcp] unhandled rejection:", reason);
});

// Not top-level await: this bundles to CJS alongside the server (see
// `tsup.config.ts`), and CJS has no top-level await. The proxy ends when stdin
// closes, which is also when the process should exit.
runStdioProxy(process.stdin, process.stdout, {
  root: argValue("--root") ?? process.env.CRYSTAL_ROOT,
  instancesDir: argValue("--instances"),
  endpoint: argValue("--endpoint") ?? process.env.CRYSTAL_HUB_URL,
}).catch((err) => {
  console.error("[crystal-mcp] fatal:", err);
  process.exitCode = 1;
});

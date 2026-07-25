import { LineBuffer } from "@crystal/core";
import { defaultInstancesDir, sweepInstances, type InstanceInfo } from "../instances.js";

/**
 * `crystal-mcp` — a stdio↔HTTP shim for the cross-project hub.
 *
 * The hub's MCP endpoint lives on the bridge server's loopback listener, whose
 * port is ephemeral unless `--mcp-port` pins it. That is fine for Crystal's own
 * agent runs (their mcp-config is written per run) but hostile to an *external*
 * agent, whose config is written once: under the desktop app the sidecar takes
 * a fresh port on every launch, so a pasted URL dies at the next restart.
 *
 * This proxy closes that gap. It speaks MCP over stdio — the transport every
 * MCP client supports without configuration — and resolves the live endpoint at
 * call time from the instance discovery files each running server writes
 * (`~/.crystal/instances/<pid>.json`). One stable config line, whatever port
 * today's server happens to hold:
 *
 *     claude mcp add crystal-hub -- crystal-mcp
 *
 * Stateless, like the endpoint it fronts: each JSON-RPC line in becomes one
 * POST, and its reply goes out on stdout. Notifications (no `id`) expect no
 * reply and produce none.
 */

/** How the proxy picks a server when several are running. */
export interface ProxyOptions {
  /** Where servers advertise themselves (default `~/.crystal/instances`). */
  instancesDir?: string;
  /**
   * Prefer the server hosting this workspace root. Without it the
   * most-recently-started server wins — the one the user just opened.
   */
  root?: string;
  /** Override discovery entirely (mostly for tests). */
  endpoint?: string;
}

/** Errors the proxy reports as JSON-RPC rather than crashing on. */
const NO_SERVER = -32001;

/**
 * The hub endpoint of the best matching live instance, or null when no server
 * is running (or none advertises a hub).
 */
export async function resolveHubEndpoint(opts: ProxyOptions = {}): Promise<string | null> {
  if (opts.endpoint) return opts.endpoint;
  const live = (await sweepInstances(opts.instancesDir ?? defaultInstancesDir())).filter(
    (i) => !!hubUrlOf(i),
  );
  if (!live.length) return null;
  const wanted = opts.root ? normalizeRoot(opts.root) : null;
  const hosting = wanted
    ? live.filter((i) => i.roots.some((r) => normalizeRoot(r) === wanted))
    : [];
  // A server hosting the requested root wins; otherwise the newest one, which
  // is the window the user most recently opened.
  const pool = hosting.length ? hosting : live;
  const best = [...pool].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
  return hubUrlOf(best);
}

/**
 * The hub URL an instance advertises. Older servers wrote only `mcpPort`, so
 * fall back to deriving it — the path has been stable since the endpoint
 * existed.
 */
function hubUrlOf(info: InstanceInfo): string | null {
  if (info.hubMcpUrl) return info.hubMcpUrl;
  return info.mcpPort ? `http://127.0.0.1:${info.mcpPort}/mcp/hub` : null;
}

/** Compare roots the way the server does: case-insensitively, separator-agnostic. */
function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Forward one decoded JSON-RPC message to the hub endpoint. Returns the reply
 * to write back, or null when the message needs none (a notification).
 * Transport failures come back as JSON-RPC errors so the client sees a usable
 * message instead of a dead pipe.
 */
export async function forward(
  message: { id?: string | number | null; method?: string } | unknown[],
  opts: ProxyOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  // A batch is an array and always expects a reply; only a lone object with no
  // `id` is a notification. Getting this wrong swallows a failed batch, and
  // the client waits forever on ids it will never hear about again.
  const id = Array.isArray(message) ? null : (message.id ?? null);
  const wantsReply = Array.isArray(message) || id !== null;
  const fail = (code: number, text: string) =>
    wantsReply ? { jsonrpc: "2.0", id, error: { code, message: text } } : null;

  const endpoint = await resolveHubEndpoint(opts);
  if (!endpoint) {
    return fail(
      NO_SERVER,
      "No running Crystal server found. Start one (open the desktop app, or run `crystal-server --root <repo>`) and try again.",
    );
  }
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    // 202 = accepted notification, no body.
    if (res.status === 202) return null;
    if (!res.ok) return fail(NO_SERVER, `Crystal hub returned HTTP ${res.status}.`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    return fail(NO_SERVER, `Could not reach the Crystal hub at ${endpoint}: ${(err as Error).message}`);
  }
}

/** One framed JSON-RPC error, ready to write. */
function rpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }) + "\n";
}

/**
 * Run the proxy over the given streams until stdin closes. Frames are
 * newline-delimited JSON, the same convention the bridge's pipe transport uses.
 */
export async function runStdioProxy(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  opts: ProxyOptions = {},
): Promise<void> {
  const lines = new LineBuffer();
  stdin.setEncoding("utf8");
  /** Every in-flight call, so stdin closing does not cut a reply short. */
  const inFlight = new Set<Promise<void>>();

  /** One frame in, at most one reply out. */
  const handle = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      stdout.write(rpcError(-32700, "Parse error"));
      return;
    }
    // `null` and `7` are valid JSON but not JSON-RPC. Reading `.id` off them
    // used to throw out of the read loop, leaving a live-looking process that
    // had stopped consuming stdin — every later request then hung forever.
    if (typeof message !== "object" || message === null) {
      stdout.write(rpcError(-32600, "Invalid Request"));
      return;
    }
    const reply = await forward(
      message as { id?: string | number | null; method?: string } | unknown[],
      opts,
    );
    if (reply) stdout.write(JSON.stringify(reply) + "\n");
  };

  /**
   * Start a frame without blocking the reader. JSON-RPC allows concurrent
   * requests, and `dispatch_epic` can take tens of seconds (it opens a
   * workspace and starts a workflow) — awaiting it here would leave the
   * client's keepalives unread until it finished, and conformant clients time
   * the connection out.
   */
  const begin = (line: string): void => {
    const call = handle(line).catch((err) => {
      // `handle` writes JSON-RPC errors itself; anything escaping it is a bug
      // in the proxy, and must not take the process down.
      console.error("[crystal-mcp] frame failed:", err);
    });
    inFlight.add(call);
    void call.finally(() => inFlight.delete(call));
  };

  for await (const chunk of stdin as AsyncIterable<string>) {
    for (const line of lines.push(chunk)) begin(line);
  }
  // A client that closes without a trailing newline still meant its last line.
  for (const line of lines.flush()) begin(line);
  // Let everything already in flight write its reply before we return.
  while (inFlight.size) await Promise.all([...inFlight]);
}

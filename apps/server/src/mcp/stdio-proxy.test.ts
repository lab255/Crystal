import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { forward, resolveHubEndpoint, runStdioProxy } from "./stdio-proxy.js";

/** Write an instance discovery file for a (live) server — this test's own pid. */
async function advertise(
  dir: string,
  info: { pid?: number; mcpPort: number; hubMcpUrl?: string; roots?: string[]; startedAt: string },
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${info.pid ?? process.pid}.json`),
    JSON.stringify({
      pid: info.pid ?? process.pid,
      pipe: null,
      port: null,
      mcpPort: info.mcpPort,
      hubMcpUrl: info.hubMcpUrl,
      roots: info.roots ?? [],
      startedAt: info.startedAt,
    }),
    "utf8",
  );
}

describe("resolveHubEndpoint", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-mcp-"));
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no server is running", async () => {
    expect(await resolveHubEndpoint({ instancesDir: path.join(dir, "empty") })).toBeNull();
  });

  it("prefers the server hosting the requested root, whatever its port", async () => {
    const d = path.join(dir, "roots");
    await advertise(d, {
      pid: process.pid,
      mcpPort: 1111,
      hubMcpUrl: "http://127.0.0.1:1111/mcp/hub",
      roots: ["C:/repos/other"],
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    // A second *live* instance — the discovery sweep drops files whose pid is
    // gone, so this has to be a real process: the test runner's parent.
    await advertise(d, {
      pid: process.ppid,
      mcpPort: 2222,
      hubMcpUrl: "http://127.0.0.1:2222/mcp/hub",
      roots: ["C:/repos/wanted"],
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    // Newest wins with no preference…
    expect(await resolveHubEndpoint({ instancesDir: d })).toBe("http://127.0.0.1:1111/mcp/hub");
    // …but hosting the root beats being newer, and paths compare loosely.
    expect(await resolveHubEndpoint({ instancesDir: d, root: "C:\\repos\\wanted\\" })).toBe(
      "http://127.0.0.1:2222/mcp/hub",
    );
  });

  it("derives the URL for a server that advertises only a port", async () => {
    const d = path.join(dir, "legacy");
    await advertise(d, { mcpPort: 3333, startedAt: "2026-01-01T00:00:00.000Z" });
    expect(await resolveHubEndpoint({ instancesDir: d })).toBe("http://127.0.0.1:3333/mcp/hub");
  });

  it("an explicit endpoint skips discovery entirely", async () => {
    expect(await resolveHubEndpoint({ endpoint: "http://elsewhere/mcp/hub" })).toBe(
      "http://elsewhere/mcp/hub",
    );
  });
});

describe("forward", () => {
  const endpoint = "http://127.0.0.1:9/mcp/hub";

  it("relays a request and returns the server's reply", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { status: 200 }),
    );
    const reply = await forward({ id: 1, method: "tools/list" }, { endpoint }, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: "POST" }));
    expect(reply).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("returns nothing for a notification, and for the server's 202", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await forward({ method: "notifications/initialized" }, { endpoint }, fetchImpl as never)).toBeNull();
    expect(await forward({ id: 2, method: "ping" }, { endpoint }, fetchImpl as never)).toBeNull();
  });

  it("reports an unreachable server as a JSON-RPC error, not a crash", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const reply = (await forward({ id: 3, method: "ping" }, { endpoint }, fetchImpl as never)) as {
      error: { message: string };
    };
    expect(reply.error.message).toMatch(/Could not reach the Crystal hub/);
  });

  it("treats a batch as expecting a reply, even when the server is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    // Every id in the batch is waiting; answering with nothing would hang them.
    const reply = (await forward(
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ],
      { endpoint },
      fetchImpl as never,
    )) as { error: { message: string } };
    expect(reply.error.message).toMatch(/Could not reach the Crystal hub/);
  });

  it("relays a batch untouched and returns the server's array", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }]), { status: 200 }),
    );
    const reply = await forward(
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      { endpoint },
      fetchImpl as never,
    );
    expect(reply).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("says how to start a server when none is running", async () => {
    const reply = (await forward(
      { id: 4, method: "ping" },
      { instancesDir: path.join(os.tmpdir(), "crystal-mcp-nothing-here") },
    )) as { error: { message: string } };
    expect(reply.error.message).toMatch(/No running Crystal server/);
  });
});

describe("runStdioProxy", () => {
  it("frames replies as newline-delimited JSON and skips notifications", async () => {
    const stdin = Readable.from([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
      "not json\n",
      // Valid JSON, invalid JSON-RPC: reading `.id` off it used to throw out
      // of the read loop and leave the proxy alive but deaf.
      "null\n",
      // No trailing newline: a client that closes mid-frame still meant it.
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
    ]);
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on("data", (c: Buffer) => written.push(c.toString()));

    await runStdioProxy(stdin, stdout, {
      instancesDir: path.join(os.tmpdir(), "crystal-mcp-nothing-here"),
    });

    const lines = written.join("").trim().split("\n").map((l) => JSON.parse(l));
    // One reply per request, none for the notification, one parse error and
    // one invalid-request. Frames are handled concurrently, so replies may
    // arrive in any order — JSON-RPC pairs them by id, not by position.
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.error?.code === -32700)).toHaveLength(1);
    expect(lines.filter((l) => l.error?.code === -32600)).toHaveLength(1);
    const answered = lines.filter((l) => l.id != null);
    expect(answered.map((l) => l.id).sort()).toEqual([1, 9]);
    // …and the request replies say why they could not be served.
    for (const l of answered) expect(l.error.message).toMatch(/No running Crystal server/);
  });
});

describe("runStdioProxy concurrency", () => {
  it("keeps reading while a slow call is in flight, and finishes it before returning", async () => {
    const started: number[] = [];
    let releaseSlow = (): void => {};
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const id = JSON.parse(String(init?.body)).id as number;
      started.push(id);
      // The first call hangs until released — a reader that awaited it would
      // never see the second frame.
      if (id === 1) await new Promise<void>((r) => { releaseSlow = r; });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), { status: 200 });
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdout.on("data", (c: Buffer) => written.push(c.toString()));

    const proxyOpts = { endpoint: "http://127.0.0.1:9/mcp/hub" };
    // Drive `forward` through the same injected fetch by patching globalThis.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as never;
    try {
      const running = runStdioProxy(stdin, stdout, proxyOpts);
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n");
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      // The fast call answers while the slow one is still open.
      await vi.waitFor(() => expect(written.join("")).toContain('"id":2'));
      expect(started).toEqual([1, 2]);
      expect(written.join("")).not.toContain('"id":1');

      stdin.end();
      releaseSlow();
      await running;
      // …and closing stdin did not cut the slow reply short.
      expect(written.join("")).toContain('"id":1');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

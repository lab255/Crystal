import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { PublishStatus, RelayToHost } from "@crystal/core";
import { PublishManager, type PublishRpcClient } from "./publish-manager.js";

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A local stand-in for the relay DO: accepts host sockets, records config POSTs. */
async function startFakeRelay() {
  const hosts: { ws: WebSocket; url: string; headers: http.IncomingHttpHeaders }[] = [];
  const configPosts: { url: string; auth: string | undefined; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url?.endsWith("/config")) {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        configPosts.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      hosts.push({ ws, url: req.url ?? "", headers: req.headers });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hosts,
    configPosts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const h of hosts) h.ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

describe("PublishManager", () => {
  let relay: Awaited<ReturnType<typeof startFakeRelay>>;
  let dir: string;
  let file: string;
  let mgr: PublishManager | null;
  let registered: PublishRpcClient[];
  let dispatched: string[];
  let statuses: PublishStatus[];

  const makeManager = () =>
    new PublishManager({
      file,
      register: (client) => {
        registered.push(client);
        return () => {
          const i = registered.indexOf(client);
          if (i >= 0) registered.splice(i, 1);
        };
      },
      dispatchRaw: async (raw) => {
        dispatched.push(raw);
        return `res:${raw}`;
      },
      onChanged: (status) => {
        statuses.push(status);
      },
    });

  beforeEach(async () => {
    relay = await startFakeRelay();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crystal-publish-"));
    file = path.join(dir, "publish.json");
    mgr = null;
    registered = [];
    dispatched = [];
    statuses = [];
  });

  afterEach(async () => {
    mgr?.stop();
    await relay.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("relays open/msg/close between the relay and dispatchRaw", async () => {
    mgr = makeManager();
    const status = await mgr.configure({ enabled: true, relayUrl: relay.url, password: "secret-pw" });
    expect(status.enabled).toBe(true);
    expect(status.instanceId).toMatch(/^[0-9a-f]{12}$/);
    expect(status.publicUrl).toBe(`${relay.url}/i/${status.instanceId}`);
    expect(status.hasPassword).toBe(true);
    // The credential stays server-side: on disk, never on the status shape.
    expect("hostToken" in status).toBe(false);
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as { hostToken: string };
    expect(saved.hostToken).toMatch(/^[0-9a-f]{48}$/);

    // The password was applied immediately over HTTP, with the host bearer.
    expect(relay.configPosts).toHaveLength(1);
    expect(relay.configPosts[0]!.url).toBe(`/i/${status.instanceId}/config`);
    expect(relay.configPosts[0]!.auth).toBe(`Bearer ${saved.hostToken}`);
    expect(relay.configPosts[0]!.body).toEqual({ password: "secret-pw" });

    // Outbound host socket: right path, bearer header, connected status.
    await waitFor(() => relay.hosts.length === 1);
    const host = relay.hosts[0]!;
    expect(host.url).toBe(`/i/${status.instanceId}/host`);
    expect(host.headers.authorization).toBe(`Bearer ${saved.hostToken}`);
    await waitFor(() => statuses.some((s) => s.connected));

    const frames: (RelayToHost & { d?: string })[] = [];
    host.ws.on("message", (data) => frames.push(JSON.parse(String(data))));
    host.ws.send(JSON.stringify({ t: "ready", clients: 0 }));

    // open → one registered bridge client per channel
    host.ws.send(JSON.stringify({ t: "open", ch: "c1" }));
    await waitFor(() => registered.length === 1);
    expect((await mgr.status()).clients).toBe(1);

    // msg → dispatched, response relayed back on the same channel
    host.ws.send(JSON.stringify({ t: "msg", ch: "c1", d: "hello" }));
    await waitFor(() => frames.some((f) => f.t === "msg"));
    expect(dispatched).toEqual(["hello"]);
    expect(frames.find((f) => f.t === "msg")).toEqual({ t: "msg", ch: "c1", d: "res:hello" });

    // broadcasts ride the registered client as msg frames
    registered[0]!.send("evt-frame");
    await waitFor(() => frames.some((f) => f.t === "msg" && f.d === "evt-frame"));

    // close → unregistered and dropped
    host.ws.send(JSON.stringify({ t: "close", ch: "c1" }));
    await waitFor(() => registered.length === 0);
    expect((await mgr.status()).clients).toBe(0);
  }, 20_000);

  it("disabling disconnects and unregisters every channel", async () => {
    mgr = makeManager();
    await mgr.configure({ enabled: true, relayUrl: relay.url });
    await waitFor(() => relay.hosts.length === 1);
    const host = relay.hosts[0]!;
    host.ws.send(JSON.stringify({ t: "open", ch: "c1" }));
    await waitFor(() => registered.length === 1);

    const closed = new Promise<void>((resolve) => host.ws.once("close", () => resolve()));
    const status = await mgr.configure({ enabled: false });
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.clients).toBe(0);
    expect(registered).toHaveLength(0);
    await closed;
    // Identity survives a disable — re-enabling reclaims the same instance.
    const saved = JSON.parse(await fs.readFile(file, "utf8")) as { instanceId: string };
    expect(saved.instanceId).toBe(status.instanceId);
  }, 20_000);

  it("reconnects after the relay drops the host socket", async () => {
    mgr = makeManager();
    await mgr.configure({ enabled: true, relayUrl: relay.url });
    await waitFor(() => relay.hosts.length === 1);
    relay.hosts[0]!.ws.close();
    // Backoff starts at 1s; a second host connect proves the retry loop.
    await waitFor(() => relay.hosts.length === 2, 10_000);
    expect(relay.hosts[1]!.url).toBe(relay.hosts[0]!.url);
  }, 20_000);

  it("start() restores a persisted enabled config and dials out", async () => {
    mgr = makeManager();
    const status = await mgr.configure({ enabled: true, relayUrl: relay.url });
    await waitFor(() => relay.hosts.length === 1);
    mgr.stop();

    // A fresh manager on the same file (server restart) reconnects unprompted.
    registered = [];
    statuses = [];
    mgr = makeManager();
    await mgr.start();
    await waitFor(() => relay.hosts.length === 2);
    expect(relay.hosts[1]!.url).toBe(`/i/${status.instanceId}/host`);
  }, 20_000);

  it("rejects short passwords and enabling without a relay URL", async () => {
    mgr = makeManager();
    await expect(mgr.configure({ enabled: true })).rejects.toThrow(/relay URL/);
    await expect(
      mgr.configure({ enabled: true, relayUrl: relay.url, password: "short" }),
    ).rejects.toThrow(/at least 8/);
  });

  it("degrades a corrupt settings file to the disabled default", async () => {
    await fs.writeFile(file, "{nope", "utf8");
    mgr = makeManager();
    await mgr.start();
    const status = await mgr.status();
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
  });
});

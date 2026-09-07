import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ABLE_REDIRECT_URI, AccountManager, type AccountRecord } from "./able-auth.js";

const fakeEnv = { ABLE_OAUTH_CLIENT_ID: "fake-crystal" };
let home: string;
let servers: http.Server[];
let managers: AccountManager[];
let requests: { path: string; body: URLSearchParams; authorization?: string }[];
let failToken: boolean;
let failUserinfo: boolean;
let failDiscovery: boolean;
let discoveries: number;
let base: string;
let manager: AccountManager;

function listen(server: http.Server, port = 0): Promise<void> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}
function make(options: ConstructorParameters<typeof AccountManager>[0] = {}) {
  const instance = new AccountManager({ home, env: fakeEnv, discoveryUrl: `${base}/discovery`, ...options });
  managers.push(instance);
  return instance;
}
function stored(): AccountRecord {
  return JSON.parse(fs.readFileSync(path.join(home, ".crystal/able-auth.json"), "utf8"));
}
function expire() {
  const record = stored();
  record.tokens.expires_at = Date.now() - 1000;
  fs.writeFileSync(path.join(home, ".crystal/able-auth.json"), JSON.stringify(record));
}
async function login(instance = manager) {
  const { authorizeUrl } = await instance.beginSignIn();
  const response = await fetch(authorizeUrl);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Signed in — you can close this tab");
  return new URL(authorizeUrl);
}
async function portIsFree() {
  const server = http.createServer();
  await listen(server, 4522);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crystal-able-test-"));
  servers = [];
  managers = [];
  requests = [];
  discoveries = 0;
  failToken = failUserinfo = failDiscovery = false;
  base = "http://127.0.0.1:1";
  manager = make();
});

async function startIdp() {
  const idp = http.createServer((req, res) => {
    const url = new URL(req.url!, base);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(302, { Location: "/discovery" }).end();
    } else if (url.pathname === "/discovery") {
      discoveries++;
      if (failDiscovery) { res.writeHead(500).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo`, revocation_endpoint: `${base}/revoke` }));
    } else if (url.pathname === "/authorize") {
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "fake-code");
      res.writeHead(302, { Location: callback.toString() }).end();
    } else {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push({ path: url.pathname, body: new URLSearchParams(body), authorization: req.headers.authorization });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/token") {
          if (failToken) res.writeHead(401).end('{"error":"fake-provider-error"}');
          else res.end(JSON.stringify({ access_token: body.includes("refresh_token") ? "fake-refreshed-access" : "fake-access", refresh_token: "fake-refresh", expires_in: 3600 }));
        } else if (url.pathname === "/userinfo") {
          if (failUserinfo) res.writeHead(500).end();
          else res.end(JSON.stringify({ sub: "test-user", name: "Test User", email: "test@example.invalid" }));
        } else res.end("{}");
      });
    }
  });
  await listen(idp);
  base = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
  manager = make();
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const instance of managers) instance.dispose();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("AccountManager", () => {
  it("is available without configuration or discovery", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await make({ env: {} }).status()).toEqual({ available: true, signedIn: false });
    expect(fetch).not.toHaveBeenCalled();
  });

});

describe("AccountManager local IdP integration", () => {
  beforeEach(startIdp);

  it.each([{}, { ABLE_OAUTH_CLIENT_ID: "custom-crystal" }])("uses the default or environment client ID: %j", async (env) => {
    const clientId = env.ABLE_OAUTH_CLIENT_ID || "crystal";
    const instance = make({ env });
    expect((await login(instance)).searchParams.get("client_id")).toBe(clientId);
    expire();
    await instance.status();
    await instance.signOut();
    const posts = requests.filter((r) => r.path === "/token" || r.path === "/revoke");
    expect(posts).toHaveLength(4);
    for (const request of posts) {
      expect(request.authorization).toBeUndefined();
      expect(request.body.get("client_id")).toBe(clientId);
      expect(request.body.has("client_secret")).toBe(false);
    }
  });

  it("follows discovery redirects", async () => {
    await login(make({ discoveryUrl: `${base}/.well-known/openid-configuration` }));
    expect(discoveries).toBe(1);
  });

  it("completes PKCE sign-in, persists a private record, broadcasts only profile and tears down", async () => {
    const changes: unknown[] = [];
    manager.events.on("changed", (s) => changes.push(s));
    const url = await login();
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(ABLE_REDIRECT_URI);
    const token = requests.find((r) => r.path === "/token")!;
    expect(token.authorization).toBeUndefined();
    expect(token.body.get("client_id")).toBe("fake-crystal");
    expect(token.body.get("client_secret")).toBeNull();
    expect(token.body.get("grant_type")).toBe("authorization_code");
    expect(token.body.get("code")).toBe("fake-code");
    expect(createHash("sha256").update(token.body.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(requests.find((r) => r.path === "/userinfo")!.authorization).toBe("Bearer fake-access");
    expect(stored()).toMatchObject({ provider: "able", tokens: { access_token: "fake-access", refresh_token: "fake-refresh", expires_at: expect.any(Number) }, profile: { sub: "test-user" }, updatedAt: expect.any(String) });
    expect(fs.statSync(path.join(home, ".crystal/able-auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, ".crystal"))).toEqual(["able-auth.json"]);
    expect(await make().status()).toEqual(changes[0]);
    expect(changes).toEqual([{ available: true, signedIn: true, profile: { sub: "test-user", name: "Test User", email: "test@example.invalid" } }]);
    await portIsFree();
  });

  it.each(["wrong-state", "provider-error", "missing-code", "wrong-path"])("rejects %s with HTML and releases the listener", async (kind) => {
    const { authorizeUrl } = await manager.beginSignIn();
    const callback = new URL(ABLE_REDIRECT_URI);
    callback.searchParams.set("state", kind === "wrong-state" ? "bad" : new URL(authorizeUrl).searchParams.get("state")!);
    if (kind !== "missing-code") callback.searchParams.set("code", "fake-code");
    if (kind === "provider-error") callback.searchParams.set("error", "access_denied");
    if (kind === "wrong-path") callback.pathname = "/wrong";
    const response = await fetch(callback);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Sign-in failed");
    expect(requests).toHaveLength(0);
    expect(await manager.status()).toEqual({ available: true, signedIn: false });
    await portIsFree();
  });

  it.each(["token", "userinfo"])("cleans up after a failed %s request and permits retry", async (step) => {
    failToken = step === "token";
    failUserinfo = step === "userinfo";
    const { authorizeUrl } = await manager.beginSignIn();
    const response = await fetch(authorizeUrl);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("fake-provider-error");
    expect(await manager.status()).toMatchObject({ signedIn: false });
    await portIsFree();
    failToken = failUserinfo = false;
    await login();
    expect(discoveries).toBe(2);
  });

  it("caches discovery and retries discovery failures", async () => {
    failDiscovery = true;
    await expect(manager.beginSignIn()).rejects.toThrow("discover");
    failDiscovery = false;
    await login();
    await login();
    expect(discoveries).toBe(2);
  });

  it("fails loudly on port conflicts and concurrent sign-in", async () => {
    const occupied = http.createServer();
    await listen(occupied, 4522);
    await expect(manager.beginSignIn()).rejects.toThrow("4522");
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await manager.beginSignIn();
    await expect(manager.beginSignIn()).rejects.toThrow("already running");
    manager.dispose();
    await portIsFree();
  });

  it("expires abandoned flows and cancels them on sign-out", async () => {
    const short = make({ flowTimeoutMs: 15 });
    await short.beginSignIn();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await portIsFree();
    await short.beginSignIn();
    await short.signOut();
    await portIsFree();
    expect(await short.status()).toMatchObject({ signedIn: false });
  });

  it("refreshes and persists once for concurrent status calls", async () => {
    await login();
    expire();
    const statuses = await Promise.all([manager.status(), manager.status()]);
    expect(statuses.every((s) => s.signedIn)).toBe(true);
    expect(stored().tokens.access_token).toBe("fake-refreshed-access");
    expect(stored().tokens.expires_at).toBeGreaterThan(Date.now() + 60_000);
    expect(requests.filter((r) => r.body.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(discoveries).toBe(1);
  });

  it("clears expired tokens and emits signed-out status on refresh failure", async () => {
    await login();
    expire();
    failToken = true;
    const changes: unknown[] = [];
    manager.events.on("changed", (s) => changes.push(s));
    expect(await manager.status()).toEqual({ available: true, signedIn: false });
    expect(changes).toEqual([{ available: true, signedIn: false }]);
    expect(fs.existsSync(path.join(home, ".crystal/able-auth.json"))).toBe(false);
  });

  it("signs out locally and revokes both tokens using discovery", async () => {
    await login();
    expect(await manager.signOut()).toEqual({ ok: true });
    expect(await manager.status()).toEqual({ available: true, signedIn: false });
    expect(requests.filter((r) => r.path === "/revoke").map((r) => r.body.get("token"))).toEqual(["fake-refresh", "fake-access"]);
    expect(fs.existsSync(path.join(home, ".crystal/able-auth.json"))).toBe(false);
  });
});

describe("AccountManager refresh without a listener", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(home, ".crystal"));
    fs.writeFileSync(path.join(home, ".crystal/able-auth.json"), JSON.stringify({
      provider: "able", tokens: { access_token: "fake-old", refresh_token: "fake-refresh", expires_at: Date.now() + 30_000 },
      profile: { sub: "test-user" }, updatedAt: "2026-01-01T00:00:00Z",
    }), { mode: 0o600 });
  });

  function mockProvider(fail = false) {
    return vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/discovery")) return Response.json({
        authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo`, revocation_endpoint: `${base}/revoke`,
      });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      const body = init!.body as URLSearchParams;
      expect(body.get("client_id")).toBe("fake-crystal");
      expect(body.has("client_secret")).toBe(false);
      if (fail) return new Response("fake-error", { status: 401 });
      return Response.json({ access_token: "fake-new", expires_in: 3600 });
    }));
  }

  it("refreshes near expiry, preserves an unrotated refresh token and writes atomically with 0600", async () => {
    mockProvider();
    const status = await manager.status();
    expect(status).toEqual({ available: true, signedIn: true, profile: { sub: "test-user" } });
    expect(stored().tokens).toMatchObject({ access_token: "fake-new", refresh_token: "fake-refresh" });
    expect(stored().tokens.expires_at).toBeGreaterThan(Date.now() + 60_000);
    expect(fs.statSync(path.join(home, ".crystal/able-auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(home, ".crystal"))).toEqual(["able-auth.json"]);
    expect(await make().status()).toEqual(status);
  });

  it("revokes both tokens without client authentication", async () => {
    mockProvider();
    await manager.signOut();
    const revocations = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/revoke"));
    expect(revocations.map(([, init]) => (init!.body as URLSearchParams).get("token"))).toEqual(["fake-refresh", "fake-old"]);
    for (const [, init] of revocations) {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      const body = init!.body as URLSearchParams;
      expect(body.get("client_id")).toBe("fake-crystal");
      expect(body.has("client_secret")).toBe(false);
    }
  });

  it("clears and broadcasts on refresh failure", async () => {
    mockProvider(true);
    const changed = vi.fn();
    manager.events.on("changed", changed);
    expect(await manager.status()).toEqual({ available: true, signedIn: false });
    expect(changed).toHaveBeenCalledWith({ available: true, signedIn: false });
    expect(fs.existsSync(path.join(home, ".crystal/able-auth.json"))).toBe(false);
  });

  it("cannot persist an in-flight refresh after sign-out", async () => {
    let finish!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/discovery")) return Response.json({
        authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo`,
      });
      markStarted();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const refreshing = manager.status();
    await started;
    const signingOut = manager.signOut();
    finish(Response.json({ access_token: "fake-late", expires_in: 3600 }));
    await Promise.all([refreshing, signingOut]);
    expect(await manager.status()).toMatchObject({ signedIn: false });
    expect(fs.existsSync(path.join(home, ".crystal/able-auth.json"))).toBe(false);
  });
});

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Emitter, type AccountStatus } from "@crystal/core";

const DISCOVERY_URL = "https://account.able.online/api/auth/.well-known/openid-configuration";
export const ABLE_REDIRECT_URI = "http://127.0.0.1:4522/oauth/able/callback";

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  revocation_endpoint?: string;
};
export interface AccountRecord {
  provider: "able";
  tokens: { access_token: string; refresh_token?: string; expires_at: number };
  profile: NonNullable<AccountStatus["profile"]>;
  updatedAt: string;
}
interface Flow {
  server: http.Server;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  response?: http.ServerResponse;
  claimed: boolean;
}
interface AccountOptions {
  /** Injection seams for local tests; production uses the fixed able defaults. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  discoveryUrl?: string;
  flowTimeoutMs?: number;
}

/** Tokens never leave this server-owned manager. */
export class AccountManager {
  readonly events = new Emitter<{ changed: AccountStatus }>();
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly file: string;
  private discovery?: Promise<Discovery>;
  private flow?: Flow;
  private starting = false;
  private disposed = false;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AccountOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.env = options.env ?? process.env;
    this.file = path.join(this.home, ".crystal", "able-auth.json");
  }

  private clientId(): string {
    return this.env.ABLE_OAUTH_CLIENT_ID || "crystal";
  }

  private snapshot(): AccountStatus {
    const record = this.read();
    return {
      available: true,
      signedIn: !!record,
      ...(record ? { profile: record.profile } : {}),
    };
  }

  private read(): AccountRecord | null {
    try {
      const record = JSON.parse(fs.readFileSync(this.file, "utf8")) as AccountRecord;
      if (record.provider !== "able" || !record.tokens ||
        typeof record.tokens.access_token !== "string" || !record.tokens.access_token ||
        !Number.isFinite(record.tokens.expires_at) ||
        (record.tokens.refresh_token !== undefined && typeof record.tokens.refresh_token !== "string") ||
        !record.profile || typeof record.profile.sub !== "string" || !record.profile.sub ||
        (record.profile.email !== undefined && typeof record.profile.email !== "string") ||
        (record.profile.name !== undefined && typeof record.profile.name !== "string")) return null;
      return record;
    } catch { return null; }
  }

  private persist(record: AccountRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(url, { ...init, redirect: init.redirect ?? "error", signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error();
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      return body as Record<string, unknown>;
    } catch {
      this.discovery = undefined;
      // Do not propagate provider bodies or fetch errors: they can contain secrets.
      throw new Error("The able identity provider request failed. Please try again.");
    }
  }

  private discover(): Promise<Discovery> {
    return this.discovery ??= this.json(this.options.discoveryUrl ?? DISCOVERY_URL, { redirect: "follow" }).then((doc) => {
      for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "revocation_endpoint"]) {
        if (key === "revocation_endpoint" && doc[key] === undefined) continue;
        if (typeof doc[key] !== "string") throw new Error("Invalid able discovery document.");
        const url = new URL(doc[key]);
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
          throw new Error("Invalid able discovery endpoint.");
        }
      }
      return doc as unknown as Discovery;
    }).catch(() => {
      this.discovery = undefined;
      throw new Error("Unable to discover the able identity provider.");
    });
  }

  private async tokens(doc: Discovery, clientId: string, body: URLSearchParams, signal?: AbortSignal): Promise<AccountRecord["tokens"]> {
    body.set("client_id", clientId);
    const raw = await this.json(doc.token_endpoint, { method: "POST", body, signal });
    const expiresAt = Date.now() + Number(raw.expires_in) * 1000;
    if (!Number.isFinite(expiresAt) || typeof raw.access_token !== "string" || !raw.access_token ||
      typeof raw.expires_in !== "number" || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 ||
      (raw.refresh_token !== undefined && typeof raw.refresh_token !== "string")) {
      this.discovery = undefined;
      throw new Error("The able identity provider returned invalid tokens.");
    }
    return { access_token: raw.access_token, ...(raw.refresh_token ? { refresh_token: raw.refresh_token as string } : {}), expires_at: expiresAt };
  }

  status(): Promise<AccountStatus> {
    return this.serial(async () => {
      const record = this.read();
      if (record && record.tokens.expires_at <= Date.now() + 60_000) {
        const generation = this.generation;
        try {
          if (!record.tokens.refresh_token) throw new Error();
          const tokens = await this.tokens(await this.discover(), this.clientId(), new URLSearchParams({ grant_type: "refresh_token", refresh_token: record.tokens.refresh_token }));
          if (generation !== this.generation || this.disposed) return this.snapshot();
          this.persist({ ...record, tokens: { ...record.tokens, ...tokens }, updatedAt: new Date().toISOString() });
        } catch {
          if (generation !== this.generation || this.disposed) return this.snapshot();
          fs.rmSync(this.file, { force: true });
        }
        this.events.emit("changed", this.snapshot());
      }
      return this.snapshot();
    });
  }

  async beginSignIn(): Promise<{ authorizeUrl: string }> {
    if (this.disposed) throw new Error("Account manager is closed.");
    if (this.starting || this.flow) throw new Error("An able sign-in is already running.");
    const clientId = this.clientId();
    this.starting = true;
    const generation = this.generation;
    try {
      const doc = await this.discover();
      if (this.disposed || generation !== this.generation) throw new Error("Sign-in cancelled.");
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(doc.authorization_endpoint);
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: ABLE_REDIRECT_URI,
        response_type: "code", scope: "openid profile email offline_access", state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) authorize.searchParams.set(key, value);
      const server = http.createServer();
      const flow: Flow = { server, abort: new AbortController(), claimed: false };
      this.flow = flow;
      server.on("clientError", (_error, socket) => {
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><title>Sign-in failed</title><p>Return to Crystal and try signing in again.</p>");
        this.stopFlow(flow);
      });
      server.on("request", (req, res) => {
        if (flow.claimed) {
          this.page(res, false);
          this.stopFlow(flow);
          return;
        }
        flow.claimed = true;
        flow.response = res;
        void this.serial(async () => {
          try {
            const url = new URL(req.url ?? "/", ABLE_REDIRECT_URI);
            const received = Buffer.from(url.searchParams.get("state") ?? "");
            const expected = Buffer.from(state);
            if (flow.abort.signal.aborted || req.method !== "GET" || url.pathname !== "/oauth/able/callback" ||
              received.length !== expected.length || !timingSafeEqual(received, expected) ||
              url.searchParams.has("error") || !url.searchParams.get("code")) throw new Error();
            const tokens = await this.tokens(doc, clientId, new URLSearchParams({ grant_type: "authorization_code",
              code: url.searchParams.get("code")!, redirect_uri: ABLE_REDIRECT_URI, code_verifier: verifier }), flow.abort.signal);
            const raw = await this.json(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: flow.abort.signal });
            if (typeof raw.sub !== "string" || !raw.sub) throw new Error();
            if (flow.abort.signal.aborted || generation !== this.generation || this.disposed) throw new Error();
            const profile = { sub: raw.sub, ...(typeof raw.email === "string" ? { email: raw.email } : {}), ...(typeof raw.name === "string" ? { name: raw.name } : {}) };
            this.persist({ provider: "able", tokens, profile, updatedAt: new Date().toISOString() });
            this.page(res, true);
            this.stopFlow(flow);
            this.events.emit("changed", this.snapshot());
          } catch {
            this.discovery = undefined;
            this.page(res, false);
            this.stopFlow(flow);
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        // Install before listen: bind failures arrive on the next tick.
        server.on("error", () => {
          this.stopFlow(flow);
          reject(new Error("Unable to listen on 127.0.0.1:4522. Another sign-in or application may be using the port."));
        });
        server.once("close", () => reject(new Error("Sign-in cancelled.")));
        server.listen(4522, "127.0.0.1", resolve);
      });
      if (flow.abort.signal.aborted) throw new Error("Sign-in cancelled.");
      flow.timer = setTimeout(() => this.stopFlow(flow), this.options.flowTimeoutMs ?? 10 * 60_000);
      flow.timer.unref();
      return { authorizeUrl: authorize.toString() };
    } finally {
      this.starting = false;
    }
  }

  private page(res: http.ServerResponse, success: boolean): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(success ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "Referrer-Policy": "no-referrer", Connection: "close" });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Crystal account</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:2rem"><h1>${success ? "Signed in — you can close this tab" : "Sign-in failed"}</h1><p>${success ? "Return to Crystal to continue." : "Return to Crystal and try signing in again."}</p></body></html>`);
  }

  private stopFlow(flow: Flow): void {
    clearTimeout(flow.timer);
    flow.abort.abort();
    if (flow.response) this.page(flow.response, false);
    flow.server.close();
    // Let completed HTML responses flush, then close any stalled connections.
    const cleanup = setTimeout(() => flow.server.closeAllConnections(), 1000);
    cleanup.unref();
    if (this.flow === flow) this.flow = undefined;
  }

  signOut(): Promise<{ ok: true }> {
    ++this.generation;
    if (this.flow) this.stopFlow(this.flow);
    return this.serial(async () => {
      const record = this.read();
      fs.rmSync(this.file, { force: true });
      this.events.emit("changed", this.snapshot());
      if (record) {
        try {
          const doc = await this.discover();
          if (doc.revocation_endpoint) {
            for (const token of [record.tokens.refresh_token, record.tokens.access_token]) {
              if (!token) continue;
              const response = await fetch(doc.revocation_endpoint, { method: "POST",
                body: new URLSearchParams({ token, client_id: this.clientId() }), redirect: "error", signal: AbortSignal.timeout(5000) });
              await response.body?.cancel();
              if (!response.ok) this.discovery = undefined;
            }
          }
        } catch { this.discovery = undefined; /* Revocation is best-effort; local logout has already landed. */ }
      }
      return { ok: true };
    });
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    if (this.flow) this.stopFlow(this.flow);
  }
}

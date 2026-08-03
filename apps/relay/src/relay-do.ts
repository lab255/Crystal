import { HOST_TOKEN_MIN_LEN, type HostToRelay, type RelayToHost } from "./protocol.js";

// One BridgeRelayDO per published instance (idFromName(instanceId)).
//
// Lifecycle: the local bridge server ("host") claims the instance on first
// connect with a bearer token it generated; the token's SHA-256 is pinned in
// SQLite and every later host connect must present the same token. The host
// sets the client access password (PBKDF2 verifier, never the password) on
// connect or via POST /config. Remote clients POST /auth with the password —
// rate-limited per-IP and globally — receive a short-lived session token, and
// open a WebSocket at /ws?token=…. Client frames ride the channel envelope in
// protocol.ts over the single host socket.
//
// All sockets use the hibernation API so an idle relay costs nothing.

const ATTEMPT_WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_GLOBAL = 100;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const PBKDF2_ITERATIONS = 210_000;

const HOST_TAG = "host";
const CH_PREFIX = "ch:";

type ClientAttachment = { ch: string };

export interface Env {
  RELAY: DurableObjectNamespace;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function pbkdf2Hex(password: string, saltHex: string): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return hex(bits);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const enc = new TextEncoder();
  // crypto.subtle.timingSafeEqual is Workers-specific and not in older type libs.
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (subtle.timingSafeEqual) {
    // .buffer is ArrayBufferLike in lib terms; TextEncoder never hands back a SharedArrayBuffer.
    return subtle.timingSafeEqual(enc.encode(a).buffer as ArrayBuffer, enc.encode(b).buffer as ArrayBuffer);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hex(buf.buffer);
}

export class BridgeRelayDO {
  private readonly state: DurableObjectState;
  private readonly sql: SqlStorage;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS auth_attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL);
       CREATE INDEX IF NOT EXISTS auth_attempts_ts ON auth_attempts (ts);
       CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, ip TEXT NOT NULL);`,
    );
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("crystal:ping", "crystal:pong"));
  }

  // --- config helpers -----------------------------------------------------

  private getConfig(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows[0]?.value ?? null;
  }

  private setConfig(key: string, value: string): void {
    this.sql.exec("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // --- rate limiting ------------------------------------------------------

  private rateLimited(ip: string): boolean {
    const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
    this.sql.exec("DELETE FROM auth_attempts WHERE ts < ?", cutoff);
    const perIp = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ?", ip)
      .one().n;
    if (perIp >= MAX_ATTEMPTS_PER_IP) return true;
    const global = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM auth_attempts").one().n;
    return global >= MAX_ATTEMPTS_GLOBAL;
  }

  private recordFailure(ip: string): void {
    this.sql.exec("INSERT INTO auth_attempts (ip, ts) VALUES (?, ?)", ip, Date.now());
  }

  // --- password / sessions ------------------------------------------------

  private async setPassword(password: string): Promise<void> {
    const salt = randomToken(16);
    this.setConfig("pw.salt", salt);
    this.setConfig("pw.hash", await pbkdf2Hex(password, salt));
    // A password change invalidates every outstanding session.
    this.sql.exec("DELETE FROM sessions");
  }

  private async verifyPassword(password: string): Promise<boolean> {
    const salt = this.getConfig("pw.salt");
    const stored = this.getConfig("pw.hash");
    if (!salt || !stored) return false;
    return timingSafeEqualHex(await pbkdf2Hex(password, salt), stored);
  }

  private async issueSession(ip: string): Promise<string> {
    const token = randomToken(24);
    this.sql.exec("DELETE FROM sessions WHERE expires < ?", Date.now());
    this.sql.exec(
      "INSERT INTO sessions (token_hash, expires, ip) VALUES (?, ?, ?)",
      await sha256Hex(token),
      Date.now() + SESSION_TTL_MS,
      ip,
    );
    return token;
  }

  private async validSession(token: string): Promise<boolean> {
    if (!token) return false;
    const rows = this.sql
      .exec<{ expires: number }>("SELECT expires FROM sessions WHERE token_hash = ?", await sha256Hex(token))
      .toArray();
    return rows.length > 0 && rows[0]!.expires > Date.now();
  }

  // --- host auth ----------------------------------------------------------

  private async verifyOrClaimHost(bearer: string): Promise<boolean> {
    if (bearer.length < HOST_TOKEN_MIN_LEN) return false;
    const presented = await sha256Hex(bearer);
    const pinned = this.getConfig("host.tokenHash");
    if (!pinned) {
      this.setConfig("host.tokenHash", presented);
      return true;
    }
    return timingSafeEqualHex(presented, pinned);
  }

  // --- sockets ------------------------------------------------------------

  private hostSocket(): WebSocket | null {
    return this.state.getWebSockets(HOST_TAG)[0] ?? null;
  }

  private clientSockets(): WebSocket[] {
    return this.state.getWebSockets().filter((ws) => ws !== this.hostSocket());
  }

  private clientByChannel(ch: string): WebSocket | null {
    return this.state.getWebSockets(CH_PREFIX + ch)[0] ?? null;
  }

  private sendToHost(msg: RelayToHost): void {
    try {
      this.hostSocket()?.send(JSON.stringify(msg));
    } catch {
      // Host went away mid-send; its close handler tears clients down.
    }
  }

  // --- HTTP entry ---------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Worker routes /i/<instance>/<action> here; take the tail segment.
    const action = url.pathname.split("/").filter(Boolean).slice(2).join("/");
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

    if (action === "status") {
      return json(200, {
        online: this.hostSocket() !== null,
        clients: this.clientSockets().length,
        hasPassword: this.getConfig("pw.hash") !== null,
      });
    }

    if (action === "auth" && request.method === "POST") {
      if (this.rateLimited(ip)) return json(429, { error: "too many attempts, try again later" });
      if (!this.getConfig("pw.hash")) return json(403, { error: "no access password set" });
      let password = "";
      try {
        password = String(((await request.json()) as { password?: unknown }).password ?? "");
      } catch {
        return json(400, { error: "expected JSON body { password }" });
      }
      if (!password || !(await this.verifyPassword(password))) {
        this.recordFailure(ip);
        return json(401, { error: "invalid password" });
      }
      return json(200, { token: await this.issueSession(ip) });
    }

    if (action === "config" && request.method === "POST") {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (this.rateLimited(ip)) return json(429, { error: "too many attempts" });
      if (!(await this.verifyOrClaimHost(bearer))) {
        this.recordFailure(ip);
        return json(401, { error: "bad host token" });
      }
      let body: { password?: unknown };
      try {
        body = (await request.json()) as { password?: unknown };
      } catch {
        return json(400, { error: "expected JSON body" });
      }
      if (typeof body.password === "string" && body.password.length >= 8) {
        await this.setPassword(body.password);
        return json(200, { ok: true });
      }
      return json(400, { error: "password must be at least 8 characters" });
    }

    if (action === "host") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json(426, { error: "websocket upgrade required" });
      }
      const bearer =
        (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") ||
        url.searchParams.get("token") ||
        "";
      if (this.rateLimited(ip)) return json(429, { error: "too many attempts" });
      if (!(await this.verifyOrClaimHost(bearer))) {
        this.recordFailure(ip);
        return json(401, { error: "bad host token" });
      }
      const pw = request.headers.get("x-crystal-access-password");
      if (pw && pw.length >= 8) await this.setPassword(pw);

      // One host at a time — a reconnect displaces the previous socket.
      const prev = this.hostSocket();
      if (prev) {
        try {
          prev.close(1012, "replaced by new host connection");
        } catch {}
      }
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], [HOST_TAG]);
      pair[1].send(JSON.stringify({ t: "ready", clients: this.clientSockets().length } satisfies RelayToHost));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (action === "ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json(426, { error: "websocket upgrade required" });
      }
      if (!(await this.validSession(url.searchParams.get("token") ?? ""))) {
        return json(401, { error: "invalid or expired session" });
      }
      if (!this.hostSocket()) return json(503, { error: "host offline" });
      const ch = randomToken(8);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({ ch } satisfies ClientAttachment);
      this.state.acceptWebSocket(pair[1], [CH_PREFIX + ch]);
      this.sendToHost({ t: "open", ch });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return json(404, { error: "not found" });
  }

  // --- WebSocket (hibernation) handlers ----------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return; // bridge frames are JSON text
    if (this.state.getTags(ws).includes(HOST_TAG)) {
      let msg: HostToRelay;
      try {
        msg = JSON.parse(message) as HostToRelay;
      } catch {
        return;
      }
      const client = this.clientByChannel(msg.ch);
      if (!client) {
        if (msg.t === "msg") this.sendToHost({ t: "close", ch: msg.ch });
        return;
      }
      if (msg.t === "msg") {
        try {
          client.send(msg.d);
        } catch {}
      } else if (msg.t === "close") {
        try {
          client.close(1000, "closed by host");
        } catch {}
      }
      return;
    }
    const att = ws.deserializeAttachment() as ClientAttachment | null;
    if (!att) return;
    this.sendToHost({ t: "msg", ch: att.ch, d: message });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.state.getTags(ws).includes(HOST_TAG)) {
      // No host — remote clients cannot do anything useful; drop them.
      for (const client of this.clientSockets()) {
        try {
          client.close(1012, "host offline");
        } catch {}
      }
      return;
    }
    const att = ws.deserializeAttachment() as ClientAttachment | null;
    if (att) this.sendToHost({ t: "close", ch: att.ch });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

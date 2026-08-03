/**
 * Publish protocol — the relay envelope between a local bridge server ("host")
 * and its relay (a Cloudflare Worker + Durable Object, `apps/relay`). The host
 * dials OUT to `wss://<relay>/i/<instanceId>/host` with a bearer token it
 * generated (first connect claims the instance); every remote client gets a
 * channel id and its bridge frames ride this envelope over the single host
 * socket. Frames themselves are opaque to the relay — they are the bridge
 * protocol's own JSON messages.
 *
 * The relay worker holds a dependency-free twin of these types
 * (`apps/relay/src/protocol.ts`); the two copies must not drift.
 */

/** Relay → host. */
export type RelayToHost =
  | { t: "open"; ch: string }
  | { t: "msg"; ch: string; d: string }
  | { t: "close"; ch: string }
  /** Sent once after the host socket is accepted. */
  | { t: "ready"; clients: number };

/** Host → relay. */
export type HostToRelay =
  | { t: "msg"; ch: string; d: string }
  | { t: "close"; ch: string };

/** The relay refuses host tokens shorter than this. */
export const HOST_TOKEN_MIN_LEN = 32;

/** The relay refuses access passwords shorter than this. */
export const PUBLISH_PASSWORD_MIN_LEN = 8;

export const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;

/**
 * Client-facing publish state, as returned by `publish.status` and carried on
 * the `publish.changed` event. Deliberately NOT the persisted server-side
 * shape: the host token is the credential that owns the relay instance, so it
 * stays in the server's settings file and never crosses the bridge.
 */
export interface PublishStatus {
  enabled: boolean;
  /** Relay origin as configured (http(s) or ws(s) flavored). */
  relayUrl: string | null;
  /** Instance id minted on first enable (the `/i/<id>` path segment). */
  instanceId: string | null;
  /** The outbound host socket is currently up. */
  connected: boolean;
  /** Remote clients with a live channel through the relay. */
  clients: number;
  /** Shareable browser URL (`https://<relay>/i/<id>`), null until publishable. */
  publicUrl: string | null;
  /** An access password has been set at the relay (best-effort local mirror). */
  hasPassword: boolean;
}

/**
 * The URL a remote browser opens: the relay serves the client console at
 * `/i/<id>`. Normalizes ws(s)-flavored relay origins to http(s) and tolerates
 * a trailing slash; throws on an unparseable URL (callers validate at
 * configure time).
 */
export function publicClientUrl(relayUrl: string, instanceId: string): string {
  const u = new URL(relayUrl);
  if (u.protocol === "ws:") u.protocol = "http:";
  else if (u.protocol === "wss:") u.protocol = "https:";
  const base = u.toString().replace(/\/+$/, "");
  return `${base}/i/${instanceId}`;
}

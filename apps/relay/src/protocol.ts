// Relay wire protocol. The host (local bridge server) keeps ONE outbound
// WebSocket to its Durable Object; every remote client gets a channel id and
// its frames ride this envelope. Frames themselves are opaque to the relay —
// they are the bridge protocol's own JSON messages.
//
// The server-side twin of these types lives in @crystal/core (publish.ts);
// this worker package stays dependency-free so the two copies must not drift.

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

export const HOST_TOKEN_MIN_LEN = 32;
/** Keep in lockstep with PUBLISH_PASSWORD_MIN_LEN in packages/core/src/publish.ts. */
export const PUBLISH_PASSWORD_MIN_LEN = 8;
export const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;

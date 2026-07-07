import { createHmac, timingSafeEqual } from "node:crypto";

/** Sign an API token: `<payload>.<hmac>` over the org + key id. */
export function signToken(orgId: string, keyId: string, secret: string): string {
  const payload = Buffer.from(`${orgId}:${keyId}`).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/** Verify an API token and return the org it belongs to, or null. */
export function verifyToken(token: string, secret: string): { orgId: string; keyId: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [orgId, keyId] = Buffer.from(payload, "base64url").toString().split(":");
  if (!orgId || !keyId) return null;
  return { orgId, keyId };
}

export function maskToken(token: string): string {
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}

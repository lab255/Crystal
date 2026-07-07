import { addDays, nowIso, uid } from "@ledgerline/shared";

export interface Session {
  id: string;
  userId: string;
  orgId: string;
  createdAt: string;
  expiresAt: string;
}

const sessions = new Map<string, Session>();

export function createSession(userId: string, orgId: string): Session {
  const session: Session = {
    id: uid("sess"),
    userId,
    orgId,
    createdAt: nowIso(),
    expiresAt: addDays(nowIso(), 14),
  };
  sessions.set(session.id, session);
  return session;
}

export function verifySession(sessionId: string): Session | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function revokeSession(sessionId: string): void {
  sessions.delete(sessionId);
}

import { nowIso, uid } from "@ledgerline/shared";

/**
 * Audit trail for sensitive actions. Wired up in an earlier iteration of the
 * server; nothing imports it since the handler rewrite.
 */

export interface AuditEvent {
  id: string;
  orgId: string;
  actor: string;
  action: string;
  subject: string;
  at: string;
}

const trail: AuditEvent[] = [];

export function logAudit(orgId: string, actor: string, action: string, subject: string): AuditEvent {
  const event: AuditEvent = { id: uid("audit"), orgId, actor, action, subject, at: nowIso() };
  trail.push(event);
  return event;
}

export function auditTrailFor(orgId: string): AuditEvent[] {
  return trail.filter((e) => e.orgId === orgId);
}

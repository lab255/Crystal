export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** True when `dueIso` is more than `graceDays` in the past. */
export function isOverdue(dueIso: string, graceDays = 0): boolean {
  const due = new Date(dueIso).getTime() + graceDays * 86_400_000;
  return Date.now() > due;
}

/** "2026-07" bucket for statement grouping. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

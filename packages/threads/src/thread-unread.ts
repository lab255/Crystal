import { useCallback, useState } from "react";

/**
 * Per-thread read/pin state. Machine-local UI concern — localStorage, same
 * policy as the client's collapse-store: unread is *my* attention state, not
 * project data, so it never rides the bridge. Keys are thread ids (chain-root
 * run ids); values are the last-seen ISO stamp compared against
 * `sessionLatestActivity`.
 */

const SEEN_KEY = "crystal.threads.seen";
const PINS_KEY = "crystal.threads.pins";
/** Bound the seen map — old threads age out of the run list anyway. */
const MAX_SEEN = 500;

export function threadReadKey(
  threadId: string,
  scope?: { sid: string; ws: string },
): string {
  return scope ? `${scope.sid}/${scope.ws}/${threadId}` : threadId;
}

function loadSeen(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persistSeen(seen: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    let entries = Object.entries(seen);
    if (entries.length > MAX_SEEN) {
      entries = entries.sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_SEEN);
    }
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage blocked — the session keeps its state anyway */
  }
}

function loadPins(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? "null");
    return Array.isArray(parsed)
      ? new Set(parsed.filter((k): k is string => typeof k === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistPins(pins: ReadonlySet<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
  } catch {
    /* ignore */
  }
}

export interface ThreadReadState {
  seen: Record<string, string>;
  pins: ReadonlySet<string>;
  /**
   * Mark seen with the thread's own latest-activity stamp — server clock
   * domain, matching what unread compares against. Never the client clock:
   * a client behind the bridge would stamp values permanently older than
   * fresh endedAt stamps.
   */
  markSeen: (threadId: string, stamp: string) => void;
  togglePin: (threadId: string) => void;
}

export function useThreadReadState(): ThreadReadState {
  const [seen, setSeen] = useState<Record<string, string>>(loadSeen);
  const [pins, setPins] = useState<ReadonlySet<string>>(loadPins);

  const markSeen = useCallback((threadId: string, stamp: string) => {
    setSeen((current) => {
      const prev = current[threadId];
      // Monotonic: never move a seen stamp backwards.
      const value = prev && prev > stamp ? prev : stamp;
      if (prev === value) return current;
      const next = { ...current, [threadId]: value };
      persistSeen(next);
      return next;
    });
  }, []);

  const togglePin = useCallback((threadId: string) => {
    setPins((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      persistPins(next);
      return next;
    });
  }, []);

  return { seen, pins, markSeen, togglePin };
}

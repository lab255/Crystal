import { useCallback, useState } from "react";

/**
 * A persisted set of collapsed keys for one tree/rail surface. Collapse
 * state was `useState` per component, so every tab switch reopened
 * everything; this survives remounts and reloads. Machine-local UI concern —
 * localStorage, same policy as settings.ts, one key per surface scope.
 */
export interface CollapsedSet {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
}

const PREFIX = "crystal.collapsed.";

function load(scope: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? new Set(parsed.filter((key): key is string => typeof key === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persist(scope: string, keys: ReadonlySet<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify([...keys]));
  } catch {
    /* storage blocked — the session keeps its state anyway */
  }
}

/** Persisted collapse state for the tree surface identified by `scope`. */
export function useCollapsedSet(scope: string): CollapsedSet {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => load(scope));
  const isCollapsed = useCallback((key: string) => keys.has(key), [keys]);
  const toggle = useCallback(
    (key: string) => {
      setKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        persist(scope, next);
        return next;
      });
    },
    [scope],
  );
  return { isCollapsed, toggle };
}

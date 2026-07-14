import { useMemo, useSyncExternalStore } from "react";

/** Reactive `window.matchMedia` — re-renders when the query result flips. */
export function useMediaQuery(query: string): boolean {
  const store = useMemo(() => {
    const mql = window.matchMedia(query);
    return {
      subscribe: (onChange: () => void) => {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      },
      getSnapshot: () => mql.matches,
    };
  }, [query]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

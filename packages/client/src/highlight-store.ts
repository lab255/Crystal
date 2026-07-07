import { createStore, type StoreApi } from "zustand/vanilla";
import type { HighlightRef } from "@crystal/core";

/**
 * Ephemeral cross-view hover highlight. Mousing over an element in any
 * analysis surface (diagram, code map, flamegraph, journey steps, inspector)
 * publishes a `HighlightRef` here; every other surface subscribes and lights
 * up its matching elements (see `matchHighlight` in `@crystal/core`).
 *
 * Only the hover lives here — a *clicked* highlight is pinned in the deep
 * link (`architect.sel` in the nav store) so it survives reloads and travels
 * in shared URLs. Hover is deliberately not persisted or serialized.
 */
export interface HighlightState {
  hover: HighlightRef | null;
  /** View id that published the hover (views skip echo-highlighting themselves). */
  source: string | null;
  /**
   * Publish (`ref`) or clear (`null`) the hover. A clear only lands when it
   * comes from the view that owns the current hover — B's mouseenter followed
   * by A's late mouseleave must not wipe B's highlight.
   */
  setHover(ref: HighlightRef | null, source: string): void;
}

export type HighlightStore = StoreApi<HighlightState>;

export function createHighlightStore(): HighlightStore {
  return createStore<HighlightState>((set, get) => ({
    hover: null,
    source: null,
    setHover(ref, source) {
      if (ref === null) {
        const cur = get();
        if (cur.hover !== null && cur.source === source) set({ hover: null, source: null });
        return;
      }
      set({ hover: ref, source });
    },
  }));
}

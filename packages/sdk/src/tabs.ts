import { createStore } from "zustand/vanilla";
import type { DeepLink } from "@crystal/core";

/**
 * Shell tabs — lightweight alternate nav states over the ONE mounted shell.
 * A tab is just a saved `DeepLink`; activating it re-applies that link (and
 * focuses its workspace). Mode panes stay keep-alive-mounted exactly as they
 * are for mode switches, so tabs cost nothing extra. Session-scoped on
 * purpose: real isolation across projects is what windows are for
 * (`openNewWindow`).
 */
export interface ShellTab {
  id: string;
  link: DeepLink;
}

let seq = 1;

export interface TabsState {
  tabs: ShellTab[];
  activeId: string;
  /** Append a tab (not activated — callers activate + apply the link). */
  open(link: DeepLink): ShellTab;
  activate(id: string): void;
  /**
   * Close a tab. Returns the tab to re-apply when the ACTIVE tab was closed
   * (its neighbor), else null. The last tab never closes.
   */
  close(id: string): ShellTab | null;
  /** Nav changed → snapshot the current link into the active tab. */
  syncActive(link: DeepLink): void;
}

export const tabsStore = createStore<TabsState>((set, get) => ({
  tabs: [{ id: `tab-${seq++}`, link: {} }],
  activeId: "tab-1",
  open(link) {
    const tab: ShellTab = { id: `tab-${seq++}`, link };
    set((s) => ({ tabs: [...s.tabs, tab] }));
    return tab;
  },
  activate(id) {
    if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
  },
  close(id) {
    const { tabs, activeId } = get();
    if (tabs.length <= 1) return null;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const next = tabs.filter((t) => t.id !== id);
    if (id !== activeId) {
      set({ tabs: next });
      return null;
    }
    const neighbor = next[Math.min(idx, next.length - 1)]!;
    set({ tabs: next, activeId: neighbor.id });
    return neighbor;
  },
  syncActive(link) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, link } : t)),
    }));
  },
}));

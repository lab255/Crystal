import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { CodeLodLevel } from "@crystal/core";

/**
 * Level-of-detail is governed by one legibility knob: the minimum on-screen
 * text height (css px) at which words are still worth rendering.
 *
 *  - A collapsed block's file chips render only while their words measure at
 *    least `minTextPx` on screen; below that the same-size area shows the
 *    high-level overview instead (see `LeafNode`).
 *  - Auto-expansion thresholds derive from the same knob: detail expands in
 *    once its words would render comfortably above the reading threshold
 *    (`COMFORT` headroom), so every stage of the ladder answers to the same
 *    definition of "too small".
 *
 * The knob is a user preference (toolbar “Dynamic detail” popover), persisted
 * per browser — not part of the diagram or the deep link.
 */

export const LOD_MIN_TEXT_DEFAULT = 6.5;
export const LOD_MIN_TEXT_RANGE = { min: 4, max: 12 } as const;

/**
 * Above this many analyzable files nothing bulk-loads eagerly — module/file
 * details are fetched on demand only. A FormSG-scale repo materialized whole
 * OOMs the desktop webview (its heap ceiling is far below a desktop
 * browser's), so both canvases consult the same line.
 */
export const HUGE_TREE_FILE_LIMIT = 2000;

/**
 * The explicit detail-ladder stops offered on the unified canvas. "repos"
 * doesn't apply — an architecture diagram is already scoped to one workspace.
 */
export const CANVAS_LOD_LEVELS: readonly CodeLodLevel[] = ["packages", "modules", "members"];

/** Detail expands once its words would render this far above the threshold. */
const COMFORT = 1.6;

/** Flow-coordinate font sizes of each stage's smallest essential words. */
export const STAGE_TEXT_PX = {
  /** Collapsed-block preview chips / file names in an expanded module. */
  chip: 10.5,
  /** Source lines inside an expanded file's symbols. */
  source: 6,
} as const;

/** Zoom above which a module's live-code expansion is worth showing. */
export function moduleExpandZoom(minTextPx: number): number {
  return (minTextPx * COMFORT) / STAGE_TEXT_PX.chip;
}

/** Zoom above which a file's symbol/source expansion is worth showing. */
export function fileExpandZoom(minTextPx: number): number {
  return (minTextPx * COMFORT) / STAGE_TEXT_PX.source;
}

interface LodConfigState {
  minTextPx: number;
  setMinTextPx(px: number): void;
}

const STORAGE_KEY = "crystal.lodMinTextPx";

function readStored(): number {
  if (typeof localStorage === "undefined") return LOD_MIN_TEXT_DEFAULT;
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  if (!Number.isFinite(raw) || raw < LOD_MIN_TEXT_RANGE.min || raw > LOD_MIN_TEXT_RANGE.max)
    return LOD_MIN_TEXT_DEFAULT;
  return raw;
}

export const lodConfigStore = createStore<LodConfigState>((set) => ({
  minTextPx: readStored(),
  setMinTextPx(px) {
    const clamped = Math.min(LOD_MIN_TEXT_RANGE.max, Math.max(LOD_MIN_TEXT_RANGE.min, px));
    set({ minTextPx: clamped });
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* storage unavailable (private mode) — session-only is fine */
    }
  },
}));

export function useLodConfig<T>(selector: (s: LodConfigState) => T): T {
  return useStore(lodConfigStore, selector);
}

import type { CodeLodLevel } from "@crystal/core";

/**
 * Level-of-detail is explicit, not zoom-driven: the C4 altitude and the
 * discrete detail ladder decide what a card shows, and per-node
 * expand/collapse (double-click, context menu) opens live code on demand.
 * The retired continuous system — legibility knob, staggered zoom
 * thresholds, auto-expansion budgets — grew unpredictable in practice;
 * detail that appears and disappears under the cursor reads as noise.
 */

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

/** File cards retained per module before the scene adds an overflow affordance. */
export const MAX_FILE_CARDS_PER_MODULE = 60;

/** Selection neighborhoods stay readable and bounded for high-fan-in barrels. */
export const MAX_SELECTION_EDGES = 60;

/** The MiniMap paints every node per frame, independent of viewport culling. */
export const MINIMAP_MAX_NODES = 1_500;

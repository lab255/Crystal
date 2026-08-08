export { DiffView } from "./DiffView.js";
export { EditorMode } from "./EditorMode.js";
export {
  OPEN_DIFF_EVENT,
  PENDING_OPEN_DIFF_KEY,
  consumePendingDiffRequest,
  openDiff,
  shapeDiffRequest,
  type DiffPairState,
  type DiffSideState,
  type OpenDiffRequest,
} from "./diff-view.js";
export { KEYMAP_LABELS, type KeymapProfile } from "./keymaps.js";
export { fuzzyScore } from "./QuickOpen.js";

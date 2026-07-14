// Canvas styling rides the package entry so every consumer of the shared
// views (the surfaces mode embeds SystemsView) gets it — not just ArchitectMode.
import "@xyflow/react/dist/style.css";
import "./architect.css";

export { ArchitectMode } from "./ArchitectMode.js";
export { ArchitectCanvas } from "./ArchitectCanvas.js";
// Shared with the surfaces mode (API explorer trace, role chips, side pane).
export { JourneyProfilePanel } from "./ProfilePanel.js";
export { ROLE_META } from "./systems/role-meta.js";
export { SystemsView } from "./systems/SystemsView.js";
export * from "./graph-ops.js";
export { autoLayout } from "./layout.js";
export { KIND_META, ACCENT_CSS } from "./model.js";
export {
  adoptAutoLinks,
  computeOverlay,
  suggestModuleFor,
  type OverlayBadge,
  type OverlayGhostEdge,
  type OverlayResult,
} from "./overlay.js";
export { buildSurveyPrompt, type SurveyKind } from "./survey-prompts.js";
export { highlightAttrs, hlClass, useViewHighlight } from "./use-highlight.js";
export {
  LOD_MIN_TEXT_DEFAULT,
  LOD_MIN_TEXT_RANGE,
  fileExpandZoom,
  moduleExpandZoom,
  useLodConfig,
} from "./lod-config.js";

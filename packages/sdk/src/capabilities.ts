import { formatLensParam } from "@crystal/core";
import type { NavPatch } from "@crystal/client";

export type PaletteCapabilityAction =
  | "review-ref"
  | "set-base-lens"
  | "clear-lens"
  | "save-lens"
  | "publish-settings"
  | "open-workspace"
  | "new-workflow"
  | "keyboard-shortcuts";

export type PaletteCapabilityIcon =
  | "review"
  | "lens"
  | "clear"
  | "save"
  | "publish"
  | "workspace"
  | "workflow"
  | "keyboard";

export interface PaletteCapability {
  id: string;
  title: string;
  icon: PaletteCapabilityIcon;
  action: PaletteCapabilityAction;
}

export const CAPABILITY_EVENTS = {
  reviewRef: "crystal:review-ref",
  setBaseLens: "crystal:set-base-lens",
  clearLens: "crystal:clear-lens",
  saveLens: "crystal:save-lens",
} as const;

export const BASE_BRANCH_LENS_PARAM = formatLensParam({ kind: "diff", scope: "base" });

export const REVIEW_REF_NAV = {
  architect: { view: "architecture", vs: null },
} satisfies NavPatch;

export const NEW_WORKFLOW_NAV = {
  orchestrate: { tab: "workflows", workflow: null, builder: null },
} satisfies NavPatch;

const ALWAYS_AVAILABLE: readonly PaletteCapability[] = [
  {
    id: "review.ref",
    title: "Review vs ref…",
    icon: "review",
    action: "review-ref",
  },
  {
    id: "lens.diff-base",
    title: "Set lens: diff vs base branch",
    icon: "lens",
    action: "set-base-lens",
  },
  {
    id: "lens.clear",
    title: "Clear lens",
    icon: "clear",
    action: "clear-lens",
  },
  {
    id: "settings.publish",
    title: "Publish / sharing settings…",
    icon: "publish",
    action: "publish-settings",
  },
  {
    id: "ws.open",
    title: "Open workspace…",
    icon: "workspace",
    action: "open-workspace",
  },
  {
    id: "workflow.new",
    title: "New workflow…",
    icon: "workflow",
    action: "new-workflow",
  },
  {
    id: "shortcuts.open",
    title: "Keyboard shortcuts",
    icon: "keyboard",
    action: "keyboard-shortcuts",
  },
] as const;

const SAVE_LENS: PaletteCapability = {
  id: "lens.save-facet",
  title: "Save current lens as facet…",
  icon: "save",
  action: "save-lens",
};

/** Capability actions mixed into the palette's workspace and navigation entries. */
export function paletteCapabilities(canSaveLens: boolean): PaletteCapability[] {
  const capabilities = [...ALWAYS_AVAILABLE];
  if (canSaveLens) capabilities.splice(3, 0, SAVE_LENS);
  return capabilities;
}

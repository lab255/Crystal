import { formatLensParam } from "@crystal/core";
import type { NavPatch } from "@crystal/client";

export type PaletteCapabilityAction =
  | "review-ref"
  | "set-base-lens"
  | "clear-lens"
  | "save-lens"
  | "new-facet"
  | "publish-settings"
  | "open-workspace"
  | "new-thread"
  | "overview-dashboard"
  | "overview-threads"
  | "overview-new-thread"
  | "overview-inbox"
  | "keyboard-shortcuts";

export type PaletteCapabilityIcon =
  | "review"
  | "lens"
  | "clear"
  | "save"
  | "publish"
  | "workspace"
  | "thread"
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
  newFacet: "crystal:new-facet",
} as const;

export const BASE_BRANCH_LENS_PARAM = formatLensParam({ kind: "diff", scope: "base" });

export const REVIEW_REF_NAV = {
  architect: { view: "architecture", vs: null },
} satisfies NavPatch;

export const NEW_THREAD_NAV = {
  mode: "threads",
  threads: { thread: null, compose: true },
} satisfies NavPatch;

export const OVERVIEW_NAV = {
  dashboard: { mode: "projects", projects: { view: "dashboard" } },
  threads: { mode: "projects", projects: { view: "threads" } },
  inbox: { mode: "projects", projects: { view: "inbox" } },
  newThread: { mode: "projects", projects: { view: "threads", compose: "thread" } },
} as const satisfies Record<string, NavPatch>;

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
    id: "thread.new",
    title: "New thread…",
    icon: "thread",
    action: "new-thread",
  },
  {
    id: "overview.dashboard",
    title: "Overview: Dashboard",
    icon: "workspace",
    action: "overview-dashboard",
  },
  {
    id: "overview.threads",
    title: "Overview: Threads",
    icon: "thread",
    action: "overview-threads",
  },
  {
    id: "overview.new-thread",
    title: "Overview: New thread",
    icon: "thread",
    action: "overview-new-thread",
  },
  {
    id: "overview.inbox",
    title: "Overview: Inbox",
    icon: "workspace",
    action: "overview-inbox",
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

const NEW_FACET: PaletteCapability = {
  id: "lens.new-facet",
  title: "New facet…",
  icon: "save",
  action: "new-facet",
};

/** Capability actions mixed into the palette's workspace and navigation entries. */
export function paletteCapabilities(canSaveLens: boolean): PaletteCapability[] {
  const capabilities = [...ALWAYS_AVAILABLE];
  if (canSaveLens) {
    const clearLensIndex = capabilities.findIndex((capability) => capability.id === "lens.clear");
    capabilities.splice(clearLensIndex, 0, NEW_FACET, SAVE_LENS);
  }
  return capabilities;
}

import type { CrystalModeId } from "@crystal/core";

// The mode ids double as deep-link route segments — core owns the union.
export type CrystalMode = CrystalModeId;

export const CRYSTAL_MODES: CrystalMode[] = [
  "projects",
  "architect",
  "surfaces",
  "orchestrate",
  "code",
  "quality",
  "jobs",
];

export const MODE_LABELS: Record<CrystalMode, string> = {
  projects: "Overview",
  architect: "Architecture",
  surfaces: "Surfaces",
  orchestrate: "Orchestrate",
  code: "Code",
  quality: "Quality",
  jobs: "Jobs",
};

/**
 * Navigation is two-level: workspaces are the top level, and these facets are
 * the second — views *into* the active workspace. `projects` sits above the
 * hierarchy as the cross-workspace overview (the "home" tab), so it is not a
 * facet.
 */
export const WORKSPACE_FACETS: CrystalMode[] = [
  "architect",
  "surfaces",
  "orchestrate",
  "code",
  "quality",
  "jobs",
];

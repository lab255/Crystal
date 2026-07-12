import type { CrystalModeId } from "@crystal/core";

// The mode ids double as deep-link route segments — core owns the union.
export type CrystalMode = CrystalModeId;

export const CRYSTAL_MODES: CrystalMode[] = [
  "projects",
  "architect",
  "orchestrate",
  "code",
  "jobs",
];

export const MODE_LABELS: Record<CrystalMode, string> = {
  projects: "Overview",
  architect: "Code graph",
  orchestrate: "Orchestrate",
  code: "Code",
  jobs: "Jobs",
};

/**
 * Navigation is two-level: workspaces are the top level, and these facets are
 * the second — views *into* the active workspace. `projects` sits above the
 * hierarchy as the cross-workspace overview (the "home" tab), so it is not a
 * facet.
 */
export const WORKSPACE_FACETS: CrystalMode[] = ["architect", "orchestrate", "code", "jobs"];

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
  projects: "Projects",
  architect: "Architecture",
  orchestrate: "Orchestrate",
  code: "Code",
  jobs: "Jobs",
};

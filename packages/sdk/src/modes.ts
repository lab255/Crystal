export type CrystalMode = "architect" | "orchestrate" | "code";

export const CRYSTAL_MODES: CrystalMode[] = ["architect", "orchestrate", "code"];

export const MODE_LABELS: Record<CrystalMode, string> = {
  architect: "Architecture",
  orchestrate: "Orchestrate",
  code: "Code",
};

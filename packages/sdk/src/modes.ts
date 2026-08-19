import {
  Activity,
  Boxes,
  Code2,
  LayoutGrid,
  MessagesSquare,
  PanelsTopLeft,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { CrystalModeId } from "@crystal/core";

// The mode ids double as deep-link route segments — core owns the union.
export type CrystalMode = CrystalModeId;

export const CRYSTAL_MODES: CrystalMode[] = [
  "projects",
  "architect",
  "surfaces",
  "threads",
  "code",
  "quality",
  "jobs",
];

/**
 * The digit the shell's window-level Ctrl/Cmd+1..N handler binds to a mode
 * (`CRYSTAL_MODES[digit - 1]`). Every advertised hint MUST derive from this —
 * a hand-computed offset already shipped hints that were off by two.
 */
export function modeShortcutDigit(m: CrystalMode): number {
  return CRYSTAL_MODES.indexOf(m) + 1;
}

export const MODE_LABELS: Record<CrystalMode, string> = {
  projects: "Overview",
  architect: "Architecture",
  surfaces: "Surfaces",
  threads: "Threads",
  code: "Code",
  quality: "Quality",
  jobs: "Jobs",
};

/** The rail icon for each mode — beside the labels, so a new mode fills both in. */
export const MODE_ICONS: Record<CrystalMode, LucideIcon> = {
  projects: LayoutGrid,
  architect: Boxes,
  surfaces: PanelsTopLeft,
  threads: MessagesSquare,
  code: Code2,
  quality: ShieldCheck,
  jobs: Activity,
};

/**
 * Modes that sit *above* the workspace hierarchy rather than inside it —
 * `projects` (the cross-workspace overview, hosting the absorbed hub
 * surfaces). They neither read nor write the active workspace, so they are
 * not facets and must not be remounted when it changes.
 */
export const CROSS_PROJECT_MODES: CrystalMode[] = ["projects"];

export function isCrossProjectMode(mode: CrystalMode): boolean {
  return CROSS_PROJECT_MODES.includes(mode);
}

/**
 * Navigation is two-level: workspaces are the top level, and these facets are
 * the second — views *into* the active workspace. The cross-project modes sit
 * above the hierarchy (see {@link CROSS_PROJECT_MODES}), so they are not
 * facets.
 */
export const WORKSPACE_FACETS: CrystalMode[] = CRYSTAL_MODES.filter(
  (m) => !isCrossProjectMode(m),
);

/**
 * The project menu's second level — one entry per deep-link subview of a
 * facet. `section` names the DeepLink field the subview lives under and `key`
 * the field inside it, so ProjectNav can both read the active subview and
 * write a nav patch generically. Modes absent here (code, jobs) are leaf
 * sections. Must track the subview unions in core/deeplink.ts.
 */
export interface ModeSubsection {
  id: string;
  label: string;
}

export const MODE_SUBSECTIONS: Partial<
  Record<
    CrystalMode,
    {
      section: "architect" | "surfaces" | "quality";
      key: "view" | "tab";
      default: string;
      items: ModeSubsection[];
    }
  >
> = {
  architect: {
    section: "architect",
    key: "view",
    default: "architecture:containers",
    // The C4 ladder, top to bottom: Context → Containers → Components →
    // Code (the codebase view) → Deployment (the infra view). The
    // `architecture:<level>` ids are resolved by ProjectNav's architect
    // case — the deep-link view id stays "architecture" with a `level`.
    items: [
      { id: "architecture:context", label: "System Context" },
      { id: "architecture:containers", label: "Containers" },
      { id: "architecture:components", label: "Components" },
      { id: "codebase", label: "Codebase" },
      { id: "infra", label: "Deployment" },
    ],
  },
  surfaces: {
    section: "surfaces",
    key: "view",
    default: "screens",
    items: [
      { id: "screens", label: "Screens" },
      { id: "components", label: "Components" },
      { id: "stories", label: "Stories" },
      { id: "apis", label: "API surface" },
      { id: "schemas", label: "Schemas" },
    ],
  },
  // threads is a leaf section: the rail inside the mode is its second level.
  quality: {
    section: "quality",
    key: "view",
    default: "tests",
    items: [
      { id: "tests", label: "Tests" },
      { id: "coverage", label: "Coverage" },
    ],
  },
};

/** Facet order with the user's saved rearrangement applied (unknown ids drop, missing append). */
export function orderedFacets(saved: string[]): CrystalMode[] {
  const valid = saved.filter((m): m is CrystalMode =>
    WORKSPACE_FACETS.includes(m as CrystalMode),
  );
  return [...valid, ...WORKSPACE_FACETS.filter((m) => !valid.includes(m))];
}

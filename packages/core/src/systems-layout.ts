import { z } from "zod";
import {
  SYSTEM_LAYERS,
  SYSTEM_LAYER_LABELS,
  type SystemOverview,
} from "./system-overview.js";

/**
 * Systems-overview layout — the user's hand arrangement of the systems
 * canvas, persisted per workspace (`.crystal/systems-layout.json`).
 *
 * The overview itself is derived (never persisted); this file carries only
 * what the derivation can't know: where the user dragged each card and how
 * they grouped the systems. Group membership references system ids, which
 * are stable slugs of the cluster key — a system that disappears from the
 * overview simply stops matching and its entry becomes inert (kept, so a
 * rename that flips back doesn't lose the arrangement).
 *
 * No file yet means "never touched": views seed groups automatically from
 * the overview (see `autoGroupSystems`) and only start persisting once the
 * user edits the arrangement.
 */

export const PointSchema = z.object({ x: z.number(), y: z.number() });

export const SystemsGroupSchema = z.object({
  /** Stable group id ("grp:frontend", "grp:custom-2"…). */
  id: z.string(),
  name: z.string(),
  /** Member system ids (unknown ids are ignored at render time). */
  members: z.array(z.string()),
});

export const SystemsLayoutSchema = z.object({
  /**
   * Manual node positions by node id — absolute canvas coordinates for
   * top-level nodes (groups, ungrouped systems), group-relative for systems
   * inside a group. Nodes without an entry keep their computed position.
   */
  positions: z.record(z.string(), PointSchema),
  groups: z.array(SystemsGroupSchema),
});

export type SystemsGroup = z.infer<typeof SystemsGroupSchema>;
export type SystemsLayout = z.infer<typeof SystemsLayoutSchema>;

export function createSystemsLayout(): SystemsLayout {
  return { positions: {}, groups: [] };
}

/**
 * Default grouping of a fresh overview: one group per architectural layer
 * (frontend / backend / database / integrations), in ladder order. Layers
 * are derived from role + file-extension evidence and refined by the code
 * index, so the grouping sharpens as files get indexed. Returns [] when the
 * systems all share one layer — a single group is noise, not structure.
 */
export function autoGroupSystems(overview: Pick<SystemOverview, "systems">): SystemsGroup[] {
  const groups: SystemsGroup[] = [];
  for (const layer of SYSTEM_LAYERS) {
    const members = overview.systems.filter((s) => s.layer === layer).map((s) => s.id);
    if (members.length > 0)
      groups.push({ id: `grp:${layer}`, name: SYSTEM_LAYER_LABELS[layer], members });
  }
  return groups.length > 1 ? groups : [];
}
